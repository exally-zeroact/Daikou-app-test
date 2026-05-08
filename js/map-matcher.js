// ============================================================
// map-matcher.js (Worker B)
// MM-1: 既存 _updateMapMatching 処理を Worker に移植・挙動同一
// MM-1.5: Cellular Network API による tunnel hint 受信・デッドレコニング
// MM-2 (2026-05-08): 多候補化 + emission スコア + Mahalanobis 楕円 +
//                    Catmull-Rom 補間 + 遅延計測 + 道路種別遷移確率
//
// 設計方針:
//   - メーター本体（state.distance_m）には絶対影響しない（main 側で独立）
//   - prevSnap は Worker 内で完結保持（main と二重管理しない）
//   - 例外時は skip 扱いで返却・main の既存 fallback 経路に支障なし
//
// メッセージ仕様:
//   in:  loadRoads {pref, roadsData}
//        reset
//        gps {lat, lng, timestamp, accuracy?, speedKmh?, headingDeg?,
//             cellularLayerHint?, cellularConfidence?}
//   out: roadsLoaded {pref, ok, numRoads?, error?}
//        mmResult {mmIncrementM, snap, confidence, snapped, skipped,
//                  latencyMs, candidatesCount, pickedEmission, _reason?}
// ============================================================

importScripts('roads-decoder.js');

// 既存定数（MM-1 と同一・挙動互換のため不変）
const MM_MAX_SNAP_DIST_M    = 50;     // snap 単独の上限（fallback）
const MM_MAX_SEGMENT_DIST_M = 1000;
const MM_GAP_RESET_SEC      = 5;

// 県別 RoadDecoder
const decoders   = new Map();
const loadedPrefs = new Set();
let prevSnap = null;

// ─── MM-2: GPS バッファ（Catmull-Rom 用 4 点） ─────────────────
const _gpsBuffer = [];                 // [{lat,lng,timestamp}]
const _GPS_BUFFER_SIZE = 4;

function _pushGpsBuffer(p){
  _gpsBuffer.push(p);
  if(_gpsBuffer.length > _GPS_BUFFER_SIZE) _gpsBuffer.shift();
}

// Catmull-Rom 評価（p1〜p2 の間を t∈[0,1] で滑らかに補間）
// p0,p3 は接線制御点
function _catmullRom(p0, p1, p2, p3, t){
  const t2 = t * t;
  const t3 = t2 * t;
  const lat = 0.5 * (
    (2 * p1.lat) +
    (-p0.lat + p2.lat) * t +
    (2*p0.lat - 5*p1.lat + 4*p2.lat - p3.lat) * t2 +
    (-p0.lat + 3*p1.lat - 3*p2.lat + p3.lat) * t3
  );
  const lng = 0.5 * (
    (2 * p1.lng) +
    (-p0.lng + p2.lng) * t +
    (2*p0.lng - 5*p1.lng + 4*p2.lng - p3.lng) * t2 +
    (-p0.lng + 3*p1.lng - 3*p2.lng + p3.lng) * t3
  );
  return { lat: lat, lng: lng };
}

// p1〜p2 間の Catmull-Rom 曲線長を 10 分割で積分
// 4 点未満の場合は線形補間（haversine 弦距離）にフォールバック
function _curveLength4(p0, p1, p2, p3){
  const samples = 10;
  let total = 0;
  let prev = p1;
  for(let i = 1; i <= samples; i++){
    const t = i / samples;
    const pt = _catmullRom(p0, p1, p2, p3, t);
    total += _haversine(prev.lat, prev.lng, pt.lat, pt.lng);
    prev = pt;
  }
  return total;
}

// ─── MM-2: 共通幾何ヘルパー ─────────────────────────────────────
function _haversine(lat1, lng1, lat2, lng2){
  const R = 6371000, tr = Math.PI / 180;
  const dLat = (lat2 - lat1) * tr;
  const dLng = (lng2 - lng1) * tr;
  const a = Math.sin(dLat/2)**2
          + Math.cos(lat1*tr) * Math.cos(lat2*tr) * Math.sin(dLng/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

function _segmentBearing(latA, lngA, latB, lngB){
  const tr = Math.PI / 180;
  const φ1 = latA * tr, φ2 = latB * tr;
  const Δλ = (lngB - lngA) * tr;
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return ((Math.atan2(y, x) * 180 / Math.PI) + 360) % 360;
}

function _angleDiff(a, b){
  let d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

function _metersPerDegree(refLat){
  const tr = Math.PI / 180;
  return {
    lat: 111132.954 - 559.822 * Math.cos(2 * refLat * tr) + 1.175 * Math.cos(4 * refLat * tr),
    lng: 111319.488 * Math.cos(refLat * tr),
  };
}

// ─── MM-2: emission scoring ────────────────────────────────────

// 道路種別バケット（v6 typeCode → 共通カテゴリ）
function _roadTypeBucket(tc){
  if(tc === 0 || tc === 7) return 'motorway';     // motorway, motorway_link
  if(tc === 1 || tc === 8) return 'trunk';
  if(tc === 2 || tc === 9) return 'primary';
  if(tc === 3 || tc === 10) return 'secondary';
  if(tc === 4 || tc === 11) return 'tertiary';
  if(tc === 5) return 'unclassified';
  if(tc === 6) return 'residential';
  if(tc === 12) return 'track';
  return 'unknown';
}

// 道路種別遷移ペナルティ（隣接バケットのみ自然・離れたら 0.05 倍）
const _ADJACENT_TYPES = {
  'motorway':     ['motorway', 'trunk', 'primary'],
  'trunk':        ['motorway', 'trunk', 'primary', 'secondary'],
  'primary':      ['motorway', 'trunk', 'primary', 'secondary', 'tertiary'],
  'secondary':    ['trunk', 'primary', 'secondary', 'tertiary', 'unclassified', 'residential'],
  'tertiary':     ['primary', 'secondary', 'tertiary', 'unclassified', 'residential'],
  'unclassified': ['secondary', 'tertiary', 'unclassified', 'residential', 'track'],
  'residential':  ['secondary', 'tertiary', 'unclassified', 'residential', 'track'],
  'track':        ['unclassified', 'residential', 'track'],
};

function _typeTransitionScore(prevBucket, currBucket){
  if(!prevBucket || !currBucket || prevBucket === 'unknown') return 1.0;
  if(prevBucket === currBucket) return 1.0;
  const adj = _ADJACENT_TYPES[prevBucket];
  if(adj && adj.indexOf(currBucket) >= 0) return 1.0;
  return 0.05;  // 不自然な遷移（motorway → residential 等）に強ペナルティ
}

// Mahalanobis 楕円 emission（進行方向に短く・直交方向に長い）
// 走行方向 σ_along = 0.5σ / 直交方向 σ_perp = 1.5σ・σ = 4 + 0.5 × accuracy
// heading 不明時は等方化（σ_along = σ_perp = σ）
function _mahalanobisEmission(snap, gpsLat, gpsLng, accuracy, headingDeg){
  const mpd = _metersPerDegree(gpsLat);
  const dx = (snap.snapLng - gpsLng) * mpd.lng;   // east m
  const dy = (snap.snapLat - gpsLat) * mpd.lat;   // north m
  const sigma = 4 + 0.5 * accuracy;
  let along, perp;
  if(headingDeg != null){
    const tr = Math.PI / 180;
    const sinH = Math.sin(headingDeg * tr);
    const cosH = Math.cos(headingDeg * tr);
    along =  dx * sinH + dy * cosH;        // 進行方向成分
    perp  = -dx * cosH + dy * sinH;        // 直交方向成分
    const sigmaA = 0.5 * sigma;
    const sigmaP = 1.5 * sigma;
    const arg = -0.5 * ((along/sigmaA)**2 + (perp/sigmaP)**2);
    return Math.exp(arg);
  } else {
    // heading なし → 等方ガウス
    const r2 = dx*dx + dy*dy;
    return Math.exp(-0.5 * r2 / (sigma*sigma));
  }
}

// 候補配列に emission スコアを付与
// 総合 emission = 距離 × heading × Mahalanobis × 道路種別
function _scoreCandidates(cands, gpsLat, gpsLng, accuracy, headingDeg, prevTypeBucket){
  const sigma = 4 + 0.5 * accuracy;
  for(let i = 0; i < cands.length; i++){
    const c = cands[i];
    // ① 距離スコア exp(-d²/(2σ²))
    const distScore = Math.exp(-0.5 * (c.distanceM / sigma) ** 2);
    // ② heading スコア exp(-headingDiff/30)
    let headScore = 1.0;
    if(headingDeg != null){
      const segB = _segmentBearing(c.segLatA, c.segLngA, c.segLatB, c.segLngB);
      const diffFwd = _angleDiff(headingDeg, segB);
      const diffRev = _angleDiff(headingDeg, (segB + 180) % 360);
      // oneway は逆方向を強ペナルティ（MM-2 では映情報のみ・厳格は MM-3+）
      const diff = c.oneway ? diffFwd : Math.min(diffFwd, diffRev);
      headScore = Math.exp(-diff / 30);
    }
    // ③ Mahalanobis 楕円
    const mahalScore = _mahalanobisEmission(c, gpsLat, gpsLng, accuracy, headingDeg);
    // ④ 道路種別遷移
    const currBucket = _roadTypeBucket(c.typeCode);
    const typeScore = _typeTransitionScore(prevTypeBucket, currBucket);
    // 総合
    c._distScore = distScore;
    c._headScore = headScore;
    c._mahalScore = mahalScore;
    c._typeScore = typeScore;
    c._typeBucket = currBucket;
    c.emission = distScore * headScore * mahalScore * typeScore;
  }
  return cands;
}

// ─── 多候補 snap（loadedPrefs 横断） ────────────────────────────
function _snapAllAcrossPrefs(lat, lng, accuracy){
  if(loadedPrefs.size === 0) return [];
  // maxM は GPS accuracy × 1.5（最小30m・最大100m）で動的化
  const acc = (typeof accuracy === 'number' && accuracy > 0) ? accuracy : 20;
  const maxM = Math.max(30, Math.min(100, acc * 1.5));
  const all = [];
  for(const pref of loadedPrefs){
    const dec = decoders.get(pref);
    if(!dec || !dec.snapAllWithin) continue;
    const cands = dec.snapAllWithin(lat, lng, { maxDistM: maxM, K: 8 });
    for(let i = 0; i < cands.length; i++){
      cands[i].prefecture = pref;
      all.push(cands[i]);
    }
  }
  all.sort(function(a, b){ return a.distanceM - b.distanceM; });
  return all.slice(0, 8);
}

// ─── 単一 snap（fallback / MM-1 互換） ──────────────────────────
function _snapAcrossPrefs(lat, lng){
  if(loadedPrefs.size === 0) return null;
  let best = null, bestPref = null;
  for(const pref of loadedPrefs){
    const dec = decoders.get(pref);
    if(!dec) continue;
    const s = dec.snapToNearestRoad(lat, lng, { maxDistM: MM_MAX_SNAP_DIST_M });
    if(s && (!best || s.distanceM < best.distanceM)){
      best = s; bestPref = pref;
    }
  }
  if(best) best.prefecture = bestPref;
  return best;
}

// ─── 距離計算（同 road なら polyline 沿い・別 road なら Catmull-Rom or haversine） ──
function _calcSnapDistance(a, b){
  if(!a || !b) return null;
  // 別 pref → Catmull-Rom 曲線長 (4点バッファ揃ってる時) or haversine
  if(a.prefecture !== b.prefecture){
    const cr = _tryCatmullRomLength();
    if(cr != null){
      return { distanceM: cr, onSameRoad: false, _via: 'catmull-rom' };
    }
    return {
      distanceM: _haversine(a.snapLat, a.snapLng, b.snapLat, b.snapLng),
      onSameRoad: false, _via: 'haversine'
    };
  }
  // 同 pref・別 road → Catmull-Rom 優先
  const dec = decoders.get(a.prefecture);
  if(!dec) return null;
  if(a.roadIndex !== b.roadIndex){
    const cr = _tryCatmullRomLength();
    if(cr != null){
      return { distanceM: cr, onSameRoad: false, _via: 'catmull-rom' };
    }
    return {
      distanceM: _haversine(a.snapLat, a.snapLng, b.snapLat, b.snapLng),
      onSameRoad: false, _via: 'haversine'
    };
  }
  // 同 road → polyline 沿い（既存）
  const r = dec.calcRoadDistance(a, b);
  if(r){ r._via = 'polyline'; }
  return r;
}

// バッファに 4 点あれば Catmull-Rom 曲線長を返す
function _tryCatmullRomLength(){
  if(_gpsBuffer.length < _GPS_BUFFER_SIZE) return null;
  return _curveLength4(_gpsBuffer[0], _gpsBuffer[1], _gpsBuffer[2], _gpsBuffer[3]);
}

// ─── メッセージハンドラ ─────────────────────────────────────────
self.onmessage = function(e){
  const msg = e.data;
  if(!msg || !msg.type) return;

  // 県データ受け取り
  if(msg.type === 'loadRoads'){
    try {
      if(loadedPrefs.has(msg.pref)){
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
    } catch(err){
      self.postMessage({
        type: 'roadsLoaded', pref: msg.pref, ok: false, error: err.message,
      });
    }
    return;
  }

  // 連続性リセット（Meter.start / reset 時）
  if(msg.type === 'reset'){
    prevSnap = null;
    _gpsBuffer.length = 0;
    return;
  }

  // GPS 更新
  if(msg.type === 'gps'){
    const t0 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();

    // MM-1.5: cellular tunnel hint = デッドレコニングモード
    if(msg.cellularLayerHint === 'tunnel'){
      // snap せず・距離加算なし・prevSnap 維持・GPS バッファだけは更新
      _pushGpsBuffer({ lat: msg.lat, lng: msg.lng, timestamp: msg.timestamp });
      const t1 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
      self.postMessage({
        type: 'mmResult', mmIncrementM: 0, snap: null, confidence: 1.0,
        snapped: 0, skipped: 0, latencyMs: t1 - t0, candidatesCount: 0,
        _reason: 'cellular tunnel hint',
      });
      return;
    }

    // GPS バッファ更新（Catmull-Rom 用）
    _pushGpsBuffer({ lat: msg.lat, lng: msg.lng, timestamp: msg.timestamp });

    let mmIncrementM = 0;
    let snapped = 0, skipped = 0;
    let outSnap = null;
    let reason = null;
    let candCount = 0;
    let pickedEmission = 0;

    try {
      // ① 多候補 snap
      const cands = _snapAllAcrossPrefs(msg.lat, msg.lng, msg.accuracy);
      candCount = cands.length;
      if(candCount === 0){
        // 候補ゼロ = snap miss（既存挙動: prevSnap 維持・skip カウントなし）
        reason = 'no candidates';
      } else {
        // ② emission scoring
        const prevBucket = (prevSnap && prevSnap._typeBucket) ? prevSnap._typeBucket : null;
        _scoreCandidates(cands, msg.lat, msg.lng, msg.accuracy || 20, msg.headingDeg, prevBucket);
        // ③ 最良 emission の 1 件を採用（MM-3 以降は Viterbi 窓が選ぶ）
        let best = cands[0];
        for(let i = 1; i < cands.length; i++){
          if(cands[i].emission > best.emission) best = cands[i];
        }
        pickedEmission = best.emission;
        snapped = 1;
        outSnap = best;

        // ④ prevSnap との距離計算
        if(prevSnap){
          const dtSec = prevSnap.timestamp != null
            ? (msg.timestamp - prevSnap.timestamp) / 1000
            : 0;
          if(dtSec > MM_GAP_RESET_SEC){
            reason = 'gap reset';
          } else {
            const r = _calcSnapDistance(prevSnap, best);
            if(r && typeof r.distanceM === 'number'){
              if(r.distanceM >= 0 && r.distanceM <= MM_MAX_SEGMENT_DIST_M){
                mmIncrementM = r.distanceM;
              } else {
                skipped = 1;
                reason = 'over segment limit ' + r.distanceM.toFixed(0) + 'm via ' + r._via;
              }
            }
          }
        }
        // prevSnap に timestamp + typeBucket を持たせる
        prevSnap = Object.assign({}, best, { timestamp: msg.timestamp });
      }
    } catch(err){
      skipped = 1;
      reason = 'error: ' + err.message;
    }

    const t1 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    self.postMessage({
      type: 'mmResult',
      mmIncrementM: mmIncrementM,
      snap: outSnap,
      confidence: pickedEmission > 0 ? Math.min(1.0, pickedEmission) : 1.0,
      snapped: snapped,
      skipped: skipped,
      latencyMs: t1 - t0,
      candidatesCount: candCount,
      pickedEmission: pickedEmission,
      _reason: reason,
    });
  }
};
