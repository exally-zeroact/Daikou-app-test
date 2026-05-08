// ============================================================
// map-matcher.js (Worker B)
// MM-1: 既存 _updateMapMatching の処理を Worker に移植・挙動同一
//
// 設計方針:
//   - メーター本体（state.distance_m）には絶対影響しない（main 側で独立）
//   - 既存定数（MM_MAX_SNAP_DIST_M=50 / MM_MAX_SEGMENT_DIST_M=1000 / MM_GAP_RESET_SEC=5）と同一
//   - prevSnap は Worker 内で完結保持（main と二重管理しない）
//   - mm_total_count は main 側で管理（post タイミング基準）
//     mm_snap_count / mm_skip_count は Worker から delta を返して main で加算
//   - 例外時は skip 扱いで返却・main の既存 fallback 経路に支障を与えない
//
// メッセージ仕様:
//   in:  { type: 'loadRoads', pref, roadsData }   roads-{pref}.js の data オブジェクト
//        { type: 'reset' }                          Meter.start/reset 時に prevSnap 初期化
//        { type: 'gps', lat, lng, timestamp }       GPS 更新（早期 return 後の有効点のみ）
//   out: { type: 'roadsLoaded', pref, ok, numRoads?, error? }
//        { type: 'mmResult', mmIncrementM, snap, confidence, snapped, skipped, _reason? }
// ============================================================

importScripts('roads-decoder.js');

// 既存 meter.js の定数と完全一致（挙動同一の担保）
const MM_MAX_SNAP_DIST_M    = 50;
const MM_MAX_SEGMENT_DIST_M = 1000;
const MM_GAP_RESET_SEC      = 5;

// 県別 RoadDecoder（main 側 RegionLoader と同等の役割を Worker 内で持つ）
const decoders   = new Map();   // pref → RoadDecoder
const loadedPrefs = new Set();
let prevSnap = null;

// 全ロード済 pref を横断し最近接 snap を返す
function _snapAcrossPrefs(lat, lng) {
  if (loadedPrefs.size === 0) return null;
  let best = null, bestPref = null;
  for (const pref of loadedPrefs) {
    const dec = decoders.get(pref);
    if (!dec) continue;
    const s = dec.snapToNearestRoad(lat, lng, { maxDistM: MM_MAX_SNAP_DIST_M });
    if (s && (!best || s.distanceM < best.distanceM)) {
      best = s;
      bestPref = pref;
    }
  }
  if (best) best.prefecture = bestPref;
  return best;
}

// 2 つの snap 間距離（同 pref なら polyline 沿い・別 pref なら haversine 弦）
// main 側 RegionLoader.calcRoadDistance と完全同一仕様
function _calcAcrossPrefs(a, b) {
  if (!a || !b) return null;
  if (a.prefecture !== b.prefecture) {
    const R = 6371000, tr = Math.PI / 180;
    const dLat = (b.snapLat - a.snapLat) * tr;
    const dLng = (b.snapLng - a.snapLng) * tr;
    const aa = Math.sin(dLat/2) ** 2
             + Math.cos(a.snapLat * tr) * Math.cos(b.snapLat * tr)
             * Math.sin(dLng/2) ** 2;
    return {
      distanceM: R * 2 * Math.atan2(Math.sqrt(aa), Math.sqrt(1 - aa)),
      onSameRoad: false,
    };
  }
  const dec = decoders.get(a.prefecture);
  if (!dec) return null;
  return dec.calcRoadDistance(a, b);
}

self.onmessage = function(e) {
  const msg = e.data;
  if (!msg || !msg.type) return;

  // ─── 県データ受け取り ─────────────────────────────
  if (msg.type === 'loadRoads') {
    try {
      if (loadedPrefs.has(msg.pref)) {
        // 既ロード（重複防止）
        self.postMessage({
          type: 'roadsLoaded', pref: msg.pref, ok: true,
          numRoads: decoders.get(msg.pref).numRoads, _reason: 'already loaded',
        });
        return;
      }
      const dec = new self.RoadDecoder(msg.roadsData);
      dec.buildOffsetTable();
      decoders.set(msg.pref, dec);
      loadedPrefs.add(msg.pref);
      self.postMessage({
        type: 'roadsLoaded', pref: msg.pref, ok: true, numRoads: dec.numRoads,
      });
    } catch (err) {
      self.postMessage({
        type: 'roadsLoaded', pref: msg.pref, ok: false, error: err.message,
      });
    }
    return;
  }

  // ─── 連続性リセット（Meter.start / reset 時） ───────
  if (msg.type === 'reset') {
    prevSnap = null;
    return;
  }

  // ─── GPS 更新 ─────────────────────────────────────
  if (msg.type === 'gps') {
    let mmIncrementM = 0;
    let snapped = 0;
    let skipped = 0;
    let outSnap = null;
    let reason = null;

    try {
      const snap = _snapAcrossPrefs(msg.lat, msg.lng);
      if (!snap) {
        // snap miss（道路から遠い or roads 未ロード）
        // 既存挙動: prevSnap は維持・skip カウントなし
        reason = 'snap miss';
      } else {
        snapped = 1;
        outSnap = snap;

        if (prevSnap) {
          const dtSec = prevSnap.timestamp != null
            ? (msg.timestamp - prevSnap.timestamp) / 1000
            : 0;
          if (dtSec > MM_GAP_RESET_SEC) {
            // 既存挙動: GPS 5 秒以上空白 → 連続性リセット・距離加算なし
            reason = 'gap reset';
          } else {
            const r = _calcAcrossPrefs(prevSnap, snap);
            if (r && typeof r.distanceM === 'number') {
              if (r.distanceM >= 0 && r.distanceM <= MM_MAX_SEGMENT_DIST_M) {
                mmIncrementM = r.distanceM;
              } else {
                // 既存と同様：1更新で 1km 超えは異常値スキップ
                skipped = 1;
                reason = 'over segment limit ' + r.distanceM.toFixed(0) + 'm';
              }
            }
          }
        }
        prevSnap = Object.assign({}, snap, { timestamp: msg.timestamp });
      }
    } catch (err) {
      // 既存と同様：例外時は skip カウント
      skipped = 1;
      reason = 'error: ' + err.message;
    }

    self.postMessage({
      type: 'mmResult',
      mmIncrementM,
      snap: outSnap,
      confidence: 1.0,           // MM-1 は確信度未使用（後続フェーズで導入）
      snapped,
      skipped,
      _reason: reason,
    });
  }
};
