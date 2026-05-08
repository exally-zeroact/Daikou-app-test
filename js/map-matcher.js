// ============================================================
// map-matcher.js (Worker B)
// MM-1: 既存 _updateMapMatching 処理を Worker に移植・挙動同一
// MM-1.5: Cellular Network API による tunnel hint 受信・デッドレコニング
// MM-2: 多候補化 + emission スコア + Mahalanobis 楕円 +
//       Catmull-Rom 補間 + 遅延計測 + 道路種別遷移確率
// MM-3 (2026-05-08): 窓 Viterbi (N=5)
//                    時系列の連続性で最尤候補チェーンを推定
//                    遷移確率 = exp(-|routeDist - chordDist| / β)・β=30m
//                    一方通行違反は transition × 0.05（事実上除外）
//
// 設計方針:
//   - メーター本体（state.distance_m）には絶対影響しない（main 側で独立）
//   - 確定 snap（lastCommittedSnap）は Worker 内で完結保持
//   - 例外時は skip 扱いで返却・main の既存 fallback 経路に支障なし
//
// メッセージ仕様:
//   in:  loadRoads {pref, roadsData}
//        reset    （flush + 窓クリア）
//        gps {lat, lng, timestamp, accuracy?, speedKmh?, headingDeg?,
//             cellularLayerHint?, cellularConfidence?}
//   out: roadsLoaded {pref, ok, numRoads?, error?}
//        mmResult {mmIncrementM, snap, confidence, snapped, skipped,
//                  latencyMs, candidatesCount, pickedEmission,
//                  windowSize, committed?, _reason?}
// ============================================================

importScripts('roads-decoder.js');

// 既存定数（MM-1 と同一・挙動互換のため不変）
const MM_MAX_SNAP_DIST_M    = 50;     // snap 単独の上限（fallback）
const MM_MAX_SEGMENT_DIST_M = 1000;
const MM_GAP_RESET_SEC      = 5;

// MM-3: Viterbi パラメタ
const VITERBI_N            = 5;       // 窓幅（仕様）
const TRANSITION_BETA_M    = 30;      // exp(-|routeDist-chordDist|/β) の β
const ONEWAY_PENALTY       = 0.05;    // 一方通行違反時の transition 乗数

// 県別 RoadDecoder
const decoders   = new Map();
const loadedPrefs = new Set();

// MM-4b: 県別 road-graph（CSR + CH ショートカット）
const graphs = new Map();   // pref → decoded graph object

// MM-5 (2026-05-08): DEM データ（高度データ）
// 形式: { bbox:[minLat,minLng,maxLat,maxLng], gridSize, numLat, numLng, alt:Int16Array }
// alt[y * numLng + x] = 該当グリッドの標高 (m, sea level 基準, Int16 範囲 -32768〜32767m)
let _demData = null;
const _LAYER_BOOST_FACTOR = 1.3;       // accel/cellular hint と layer 一致時のブースト
const _LAYER_WRONG_PENALTY = 0.3;      // 高架/地下 で alt 矛盾時のペナルティ

// MM-4b: Dijkstra タイムアウト・LRU キャッシュ
const DIJKSTRA_TIMEOUT_MS = 3;
const ROUTE_CACHE_SIZE    = 100;

// MM-3: 確定済み（commit 済み）snap・main 側の prev に相当
let lastCommittedSnap = null;
// MM-1/2 互換用 prevSnap（Viterbi 不在時の fallback 経路で使用）
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
// MM-5: DEM lookup（O(1) 2D グリッド）
// 高さ精度が DEM grid 解像度に依存。グリッド外は null。
function _demLookup(lat, lng){
  if(!_demData) return null;
  const bbox = _demData.bbox;
  if(lat < bbox[0] || lat > bbox[2] || lng < bbox[1] || lng > bbox[3]) return null;
  const x = Math.floor((lng - bbox[1]) / _demData.gridSize);
  const y = Math.floor((lat - bbox[0]) / _demData.gridSize);
  if(x < 0 || x >= _demData.numLng || y < 0 || y >= _demData.numLat) return null;
  return _demData.alt[y * _demData.numLng + x];
}

// MM-5: 候補の layer score を算出（v6 layer 属性 + DEM 高度差 + accel/cellular hint）
//   c.layer: 0=平面 1=高架 2=地下 3=その他
//   gpsAlt: GPS 高度 (m)・null なら DEM 比較スキップ
//   accelLayerHint: 'bridge' | 'normal'
//   cellularLayerHint: 'tunnel' | 'open'
function _computeLayerScore(c, gpsLat, gpsLng, gpsAlt, accelLayerHint, cellularLayerHint){
  let score = 1.0;

  // DEM 高度差ベースのスコア（DEM ロード済かつ GPS alt あり）
  if(gpsAlt != null && _demData){
    const demAlt = _demLookup(gpsLat, gpsLng);
    if(demAlt != null){
      const altDiff = gpsAlt - demAlt;
      if(c.layer === 1){
        // 高架: alt 差 > 4m なら確信、小さいほどペナルティ、負方向は強ペナルティ
        if(altDiff > 4) score *= 1.0;
        else if(altDiff > 0) score *= Math.exp(-(4 - altDiff) / 3);
        else score *= _LAYER_WRONG_PENALTY;
      } else if(c.layer === 2){
        // 地下: alt 差 < -2m なら確信、小さいほどペナルティ、正方向は強ペナルティ
        if(altDiff < -2) score *= 1.0;
        else if(altDiff < 0) score *= Math.exp(-(-altDiff - 2) / 3);
        else score *= _LAYER_WRONG_PENALTY;
      } else {
        // 平面 / その他: |altDiff| が小さいほど確信
        const ad = Math.abs(altDiff);
        if(ad < 5) score *= 1.0;
        else score *= Math.exp(-ad / 5);
      }
    }
  }

  // accel hint と layer 一致でブースト
  if(accelLayerHint === 'bridge' && c.layer === 1) score *= _LAYER_BOOST_FACTOR;
  // cellular hint と layer 一致でブースト
  if(cellularLayerHint === 'tunnel' && c.layer === 2) score *= _LAYER_BOOST_FACTOR;

  return score;
}

// MM-2/MM-5: emission scoring（候補絞り込み後に layer score を最後段で乗算）
function _scoreCandidates(cands, gpsLat, gpsLng, accuracy, headingDeg, prevTypeBucket,
                         gpsAlt, accelLayerHint, cellularLayerHint){
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
    // ⑤ MM-5: layer score（最後段・候補絞り込み後）
    const layerScore = _computeLayerScore(c, gpsLat, gpsLng, gpsAlt,
                                          accelLayerHint, cellularLayerHint);
    // 総合
    c._distScore = distScore;
    c._headScore = headScore;
    c._mahalScore = mahalScore;
    c._typeScore = typeScore;
    c._layerScore = layerScore;
    c._typeBucket = currBucket;
    c.emission = distScore * headScore * mahalScore * typeScore * layerScore;
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

// ─── MM-4b: road-graph デコード ─────────────────────────────────
// main から postMessage で受信した base64 を TypedArray に展開
function _b64ToArrayBuffer(b64){
  const bin = atob(b64);
  const len = bin.length;
  const buf = new ArrayBuffer(len);
  const view = new Uint8Array(buf);
  for(let i = 0; i < len; i++) view[i] = bin.charCodeAt(i);
  return buf;
}

// Phase A (2026-05-08): v=1（旧）/ v=2（圧縮版）両対応のデコーダー
//   v=2 では edgeLenM が Uint16 × 0.1m / edgeRoad+Seg+nodeLevel+shortcutMidNode はドロップ
//   v=2 では roadOffset/roadSegFromNode/roadSegToNode を持つ（runtime Map 不要）
//   regression 検出後に v=1 経路を削除する予定
function _decodeGraphData(g){
  const v = g.v || 1;
  const result = {
    v: v,
    prefecture:   g.prefecture,
    precision:    g.precision,
    numNodes:     g.numNodes,
    numEdges:     g.numEdges,
    numShortcuts: g.numShortcuts,
    nodeLat:      new Int32Array(_b64ToArrayBuffer(g.nodeLatB64)),
    nodeLng:      new Int32Array(_b64ToArrayBuffer(g.nodeLngB64)),
    nodeOffset:   new Uint32Array(_b64ToArrayBuffer(g.nodeOffsetB64)),
    edgeTo:       new Uint32Array(_b64ToArrayBuffer(g.edgeToB64)),
    edgeFlags:    new Uint8Array(_b64ToArrayBuffer(g.edgeFlagsB64)),
    shortcutEdgeFrom:  new Uint32Array(_b64ToArrayBuffer(g.shortcutEdgeFromB64)),
    shortcutEdgeTo:    new Uint32Array(_b64ToArrayBuffer(g.shortcutEdgeToB64)),
    shortcutEdgeLenM:  new Float32Array(_b64ToArrayBuffer(g.shortcutEdgeLenMB64)),
    shortcutEdgeFlags: new Uint8Array(_b64ToArrayBuffer(g.shortcutEdgeFlagsB64)),
  };
  if(v >= 2){
    // Phase A v=2: edgeLenM は Uint16 ×0.1m / roadSeg* index 付き
    result.edgeLenM = new Uint16Array(_b64ToArrayBuffer(g.edgeLenMB64));
    result.edgeLenScale = (typeof g.edgeLenScale === 'number') ? g.edgeLenScale : 0.1;
    result.numRoads = g.numRoads;
    result.roadOffset = new Uint32Array(_b64ToArrayBuffer(g.roadOffsetB64));
    result.roadSegFromNode = new Uint32Array(_b64ToArrayBuffer(g.roadSegFromNodeB64));
    result.roadSegToNode = new Uint32Array(_b64ToArrayBuffer(g.roadSegToNodeB64));
  } else {
    // v=1（旧形式・regression 確認用に温存）
    result.edgeLenM = new Float32Array(_b64ToArrayBuffer(g.edgeLenMB64));
    result.edgeLenScale = 1.0;
    result.edgeRoad = new Uint32Array(_b64ToArrayBuffer(g.edgeRoadB64));
    result.edgeSeg = new Uint16Array(_b64ToArrayBuffer(g.edgeSegB64));
    if(g.nodeLevelB64){
      result.nodeLevel = new Uint16Array(_b64ToArrayBuffer(g.nodeLevelB64));
    }
    if(g.shortcutMidNodeB64){
      result.shortcutMidNode = new Uint32Array(_b64ToArrayBuffer(g.shortcutMidNodeB64));
    }
  }
  return result;
}

// Phase A: graph の RAM サイズを概算（debug 用）
function _calcGraphMemBytes(g){
  let bytes = 0;
  const fields = ['nodeLat','nodeLng','nodeOffset','edgeTo','edgeLenM','edgeFlags',
                  'edgeRoad','edgeSeg','nodeLevel',
                  'roadOffset','roadSegFromNode','roadSegToNode',
                  'shortcutEdgeFrom','shortcutEdgeTo','shortcutEdgeLenM',
                  'shortcutEdgeFlags','shortcutMidNode',
                  'shortcutOffset','shortcutIndexByFrom',
                  '_dist','_visited'];
  for(const k of fields){
    const arr = g[k];
    if(arr && arr.byteLength) bytes += arr.byteLength;
  }
  // Map のおおまかなオーバーヘッド（v=1 で構築される roadSegToEdge）
  if(g.roadSegToEdge && g.roadSegToEdge.size){
    bytes += g.roadSegToEdge.size * 50;  // JS Map entry ~50 bytes
  }
  return bytes;
}

// shortcut を from-node 順に整列して CSR-like インデックスを構築
// shortcutOffset[v..v+1] が v 始点の shortcut の sortedShortcutIdx 区間
function _buildShortcutIndex(g){
  if(g.shortcutOffset) return;
  const N = g.numNodes, S = g.numShortcuts;
  const offsets = new Uint32Array(N + 1);
  for(let i = 0; i < S; i++) offsets[g.shortcutEdgeFrom[i] + 1]++;
  for(let v = 1; v <= N; v++) offsets[v] += offsets[v - 1];
  const cursor = new Uint32Array(N);
  const sorted = new Uint32Array(S);
  for(let i = 0; i < S; i++){
    const v = g.shortcutEdgeFrom[i];
    sorted[offsets[v] + cursor[v]] = i;
    cursor[v]++;
  }
  g.shortcutOffset = offsets;
  g.shortcutIndexByFrom = sorted;
}

// v=1 旧経路: (roadIdx, segIdx) → 最初に登場した edge index の Map
//   regression 確認後に削除予定
function _buildRoadSegIndex(g){
  if(g.roadSegToEdge) return;
  if(!g.edgeRoad || !g.edgeSeg) return;  // v=2 ではフィールド無し
  const m = new Map();
  for(let e = 0; e < g.numEdges; e++){
    const key = g.edgeRoad[e] * 65536 + g.edgeSeg[e];
    if(!m.has(key)) m.set(key, e);
  }
  g.roadSegToEdge = m;
}

// v=1 旧経路: edge index → from-node を二分探索（nodeOffset 上）
function _findFromNode(g, edgeIdx){
  let lo = 0, hi = g.numNodes;
  while(lo < hi){
    const mid = (lo + hi) >>> 1;
    if(g.nodeOffset[mid + 1] <= edgeIdx) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

// snap 結果から graph node id へマッピング
// snap.t < 0.5 なら segment の from 側、それ以上なら to 側
// Phase A v=2: roadOffset + roadSegFromNode/ToNode の compile-time index で O(1)
//   （runtime Map 構築コスト 40MB を 4MB の TypedArray index に置換）
function _snapToGraphNode(g, snap){
  if(snap == null || typeof snap.roadIndex !== 'number') return -1;
  if(g.v >= 2 && g.roadOffset && g.roadSegFromNode && g.roadSegToNode){
    const r = snap.roadIndex;
    if(r < 0 || r >= g.numRoads) return -1;
    const start = g.roadOffset[r];
    const end = g.roadOffset[r + 1];
    const s = snap.segmentIndex || 0;
    if(s < 0 || start + s >= end) return -1;
    const fromNode = g.roadSegFromNode[start + s];
    const toNode = g.roadSegToNode[start + s];
    return (snap.t != null && snap.t >= 0.5) ? toNode : fromNode;
  }
  // v=1 fallback（旧形式 graph）
  _buildRoadSegIndex(g);
  if(!g.roadSegToEdge) return -1;
  const key = snap.roadIndex * 65536 + (snap.segmentIndex || 0);
  const e = g.roadSegToEdge.get(key);
  if(e === undefined) return -1;
  const fromNode = _findFromNode(g, e);
  const toNode = g.edgeTo[e];
  return (snap.t != null && snap.t >= 0.5) ? toNode : fromNode;
}

// ─── MM-4b: Binary Heap（Priority Queue） ─────────────────────
function BinaryHeap(){ this.items = []; }
BinaryHeap.prototype.push = function(node, priority){
  const items = this.items;
  let i = items.length;
  items.push({ n: node, p: priority });
  while(i > 0){
    const parent = (i - 1) >>> 1;
    if(items[parent].p <= items[i].p) break;
    const tmp = items[parent]; items[parent] = items[i]; items[i] = tmp;
    i = parent;
  }
};
BinaryHeap.prototype.pop = function(){
  const items = this.items;
  if(items.length === 0) return null;
  const top = items[0];
  const last = items.pop();
  if(items.length > 0){
    items[0] = last;
    let i = 0;
    const len = items.length;
    while(true){
      const left = 2 * i + 1;
      const right = 2 * i + 2;
      let smallest = i;
      if(left < len && items[left].p < items[smallest].p) smallest = left;
      if(right < len && items[right].p < items[smallest].p) smallest = right;
      if(smallest === i) break;
      const tmp = items[smallest]; items[smallest] = items[i]; items[i] = tmp;
      i = smallest;
    }
  }
  return top;
};
BinaryHeap.prototype.size = function(){ return this.items.length; };

// ─── MM-4b: LRU キャッシュ（Map の挿入順を利用） ──────────────
function LRUCache(maxSize){ this.maxSize = maxSize; this.cache = new Map(); }
LRUCache.prototype.get = function(key){
  if(!this.cache.has(key)) return undefined;
  const v = this.cache.get(key);
  this.cache.delete(key);
  this.cache.set(key, v);
  return v;
};
LRUCache.prototype.set = function(key, value){
  if(this.cache.has(key)) this.cache.delete(key);
  this.cache.set(key, value);
  if(this.cache.size > this.maxSize){
    const firstKey = this.cache.keys().next().value;
    this.cache.delete(firstKey);
  }
};
LRUCache.prototype.clear = function(){ this.cache.clear(); };

const _routeCache = new LRUCache(ROUTE_CACHE_SIZE);

// ─── MM-4b: CH-Dijkstra + A* ヒューリスティック ───────────────
// graph の CSR + shortcut を辿る forward 探索
// CH 制約: nodeLevel が 高い方向のみ relax（仕様）
//   ただし src の level より低いノードへの relax も初期段階では許容しないと
//   到達不能になるため、既に到達済みのノードからは upward のみとする
//   実装簡略化のため: forward は全方向 relax + shortcut 利用で correctness 保証
//   （shortcut が冗長 path を提供するため Dijkstra でも最短到達できる）
// A*: priority = dist + h, h = haversine(node, dst) × 0.9（admissible）
function _chDijkstra(g, srcNode, dstNode, maxDistM, deadline){
  if(srcNode < 0 || dstNode < 0 || srcNode >= g.numNodes || dstNode >= g.numNodes) return null;
  if(srcNode === dstNode) return 0;

  // 動的 dist / visited を pre-allocate（lazy）
  if(!g._dist || g._dist.length !== g.numNodes){
    g._dist = new Float32Array(g.numNodes);
    g._visited = new Uint8Array(g.numNodes);
    g._touched = [];
  }
  const dist = g._dist;
  const visited = g._visited;
  const touched = g._touched;

  // touched-list reset で前回呼び出し分だけクリア（O(touched)）
  for(let i = 0; i < touched.length; i++){
    dist[touched[i]] = Infinity;
    visited[touched[i]] = 0;
  }
  touched.length = 0;

  _buildShortcutIndex(g);

  const precision = g.precision || 1e5;
  const dstLat = g.nodeLat[dstNode] / precision;
  const dstLng = g.nodeLng[dstNode] / precision;

  dist[srcNode] = 0;
  touched.push(srcNode);

  const heap = new BinaryHeap();
  heap.push(srcNode, 0);

  let iters = 0;
  while(heap.size() > 0){
    // タイムアウトチェック（64 反復ごと）
    if((++iters & 0x3F) === 0 && deadline > 0 && performance.now() > deadline) return null;

    const top = heap.pop();
    const u = top.n;
    if(visited[u]) continue;
    visited[u] = 1;
    const du = dist[u];
    if(du > maxDistM) continue;
    if(u === dstNode) return du;

    // 通常 forward edges
    const eStart = g.nodeOffset[u];
    const eEnd = g.nodeOffset[u + 1];
    const lenScale = g.edgeLenScale || 1.0;   // Phase A v=2 で 0.1 / v=1 で 1.0
    for(let k = eStart; k < eEnd; k++){
      const v = g.edgeTo[k];
      if(visited[v]) continue;
      const newD = du + g.edgeLenM[k] * lenScale;
      if(newD < dist[v] && newD <= maxDistM){
        dist[v] = newD;
        if(touched.length < 16384) touched.push(v);
        const h = _haversine(g.nodeLat[v] / precision, g.nodeLng[v] / precision, dstLat, dstLng) * 0.9;
        heap.push(v, newD + h);
      }
    }

    // CH shortcuts
    if(g.shortcutOffset){
      const sStart = g.shortcutOffset[u];
      const sEnd = g.shortcutOffset[u + 1];
      for(let i = sStart; i < sEnd; i++){
        const idx = g.shortcutIndexByFrom[i];
        const v = g.shortcutEdgeTo[idx];
        if(visited[v]) continue;
        const newD = du + g.shortcutEdgeLenM[idx];
        if(newD < dist[v] && newD <= maxDistM){
          dist[v] = newD;
          if(touched.length < 16384) touched.push(v);
          const h = _haversine(g.nodeLat[v] / precision, g.nodeLng[v] / precision, dstLat, dstLng) * 0.9;
          heap.push(v, newD + h);
        }
      }
    }
  }
  return null;  // unreachable within budget / timeout
}

// ─── MM-4b: route 距離計算（同 road=polyline / 別 road=Dijkstra → fallback haversine）
// HMM 遷移確率と窓 commit の両方で使用する route 距離関数
function _routeDistance(a, b){
  if(!a || !b) return null;
  // 同 road → polyline 沿い距離（既存・正確）
  if(a.prefecture === b.prefecture && a.roadIndex === b.roadIndex){
    const dec = decoders.get(a.prefecture);
    if(dec){
      const r = dec.calcRoadDistance(a, b);
      if(r){ r._via = 'polyline'; return r; }
    }
  }
  // 別 road / 別 pref → Dijkstra（graph 利用可能時）or haversine fallback
  const chordM = _haversine(a.snapLat, a.snapLng, b.snapLat, b.snapLng);

  // graph が同一県でロード済みなら Dijkstra 試行
  if(a.prefecture === b.prefecture && graphs.has(a.prefecture)){
    // LRU キャッシュ参照（roadIdx + segIdx ベースで t は無視・近似）
    const cacheKey = a.prefecture + ':' + a.roadIndex + '_' + a.segmentIndex
                   + '|' + b.roadIndex + '_' + b.segmentIndex;
    const cached = _routeCache.get(cacheKey);
    if(cached !== undefined) return cached;

    const g = graphs.get(a.prefecture);
    const srcNode = _snapToGraphNode(g, a);
    const dstNode = _snapToGraphNode(g, b);
    if(srcNode >= 0 && dstNode >= 0){
      const maxDistM = chordM * 1.5 + 200;
      const t0 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : 0;
      const deadline = t0 + DIJKSTRA_TIMEOUT_MS;
      const distM = _chDijkstra(g, srcNode, dstNode, maxDistM, deadline);
      if(distM != null){
        const result = { distanceM: distM, onSameRoad: false, _via: 'dijkstra' };
        _routeCache.set(cacheKey, result);
        return result;
      }
      // Dijkstra 失敗（タイムアウト or 到達不能）→ haversine fallback
    }
  }

  // 最終フォールバック: haversine 弦距離
  return {
    distanceM: chordM,
    onSameRoad: false, _via: 'haversine',
  };
}

// MM-2 互換用 _calcSnapDistance（Viterbi 不在時の fallback 経路で使用）
// Catmull-Rom 4 点バッファが揃っていれば曲線長・なければ haversine 弦距離
function _calcSnapDistance(a, b){
  if(!a || !b) return null;
  if(a.prefecture !== b.prefecture){
    const cr = _tryCatmullRomLength();
    if(cr != null) return { distanceM: cr, onSameRoad: false, _via: 'catmull-rom' };
    return { distanceM: _haversine(a.snapLat, a.snapLng, b.snapLat, b.snapLng),
             onSameRoad: false, _via: 'haversine' };
  }
  const dec = decoders.get(a.prefecture);
  if(!dec) return null;
  if(a.roadIndex !== b.roadIndex){
    const cr = _tryCatmullRomLength();
    if(cr != null) return { distanceM: cr, onSameRoad: false, _via: 'catmull-rom' };
    return { distanceM: _haversine(a.snapLat, a.snapLng, b.snapLat, b.snapLng),
             onSameRoad: false, _via: 'haversine' };
  }
  const r = dec.calcRoadDistance(a, b);
  if(r){ r._via = 'polyline'; }
  return r;
}

// バッファに 4 点あれば Catmull-Rom 曲線長を返す（MM-2 fallback 用）
function _tryCatmullRomLength(){
  if(_gpsBuffer.length < _GPS_BUFFER_SIZE) return null;
  return _curveLength4(_gpsBuffer[0], _gpsBuffer[1], _gpsBuffer[2], _gpsBuffer[3]);
}

// ─── MM-3: 一方通行違反検出 ────────────────────────────────────
// curr が一方通行で、進行が逆方向に向かっていれば true
//   - 同一道路上: segmentIndex 後退 or 同 segment 内 t 後退（>0.05）→ 違反
//   - 別道路: 移動方向 vs curr の segment 順方向 を 90° 超で違反
function _violatesOneway(prev, curr, prevGps, currGps){
  if(!curr || !curr.oneway) return false;
  // 同一 road・同 pref → segment/t の方向で判定
  if(prev && prev.prefecture === curr.prefecture && prev.roadIndex === curr.roadIndex){
    if(curr.segmentIndex < prev.segmentIndex) return true;
    if(curr.segmentIndex === prev.segmentIndex && curr.t < prev.t - 0.05) return true;
    return false;
  }
  // 別 road → GPS 移動方向 vs curr segment 順方向（90° 超ペナルティ）
  if(prevGps && currGps){
    const movementBearing = _segmentBearing(
      prevGps.lat, prevGps.lng, currGps.lat, currGps.lng
    );
    const segBearing = _segmentBearing(
      curr.segLatA, curr.segLngA, curr.segLatB, curr.segLngB
    );
    if(_angleDiff(movementBearing, segBearing) > 90) return true;
  }
  return false;
}

// ─── MM-3: 遷移確率（HMM transition score） ───────────────────
// score = exp(-|routeDist - chordDist| / β)・β = 30m
// oneway 違反は ×0.05 で事実上除外
function _transitionScore(prevSnapC, currSnapC, prevGps, currGps){
  const chordM = _haversine(prevGps.lat, prevGps.lng, currGps.lat, currGps.lng);
  const r = _routeDistance(prevSnapC, currSnapC);
  const routeM = r ? r.distanceM : chordM;
  let score = Math.exp(-Math.abs(routeM - chordM) / TRANSITION_BETA_M);
  if(_violatesOneway(prevSnapC, currSnapC, prevGps, currGps)){
    score *= ONEWAY_PENALTY;
  }
  // 数値安全化（log(0) 防止）
  return score < 1e-10 ? 1e-10 : score;
}

// ─── MM-3: ViterbiMatcher（窓 N=5・最尤候補チェーン推定） ─────
// step = { gps, cands: [{ c, score, back }] }
//   c     : 候補 snap オブジェクト
//   score : 累積対数確率 = sum(log(emission) + log(transition))
//   back  : 1 つ前ステップの cands index（バックトレース用）
function ViterbiMatcher(N){
  this.N = N;
  this.steps = [];
}
ViterbiMatcher.prototype.size = function(){ return this.steps.length; };

ViterbiMatcher.prototype.reset = function(){ this.steps = []; };

// 1 ステップ追加。窓が溢れたら最古を確定 commit して返す。
// 戻り値: 確定された snap | null（commit なし）
ViterbiMatcher.prototype.push = function(gps, candidates, transitionFn){
  if(!candidates || candidates.length === 0) return null;
  if(this.steps.length === 0){
    // 初期ステップ：累積 = log(emission) のみ・back=-1
    const cs = new Array(candidates.length);
    for(let i = 0; i < candidates.length; i++){
      cs[i] = {
        c: candidates[i],
        score: Math.log(candidates[i].emission + 1e-12),
        back: -1,
      };
    }
    this.steps.push({ gps: gps, cands: cs });
    return null;
  }
  // 通常ステップ：前ステップ × 全候補で transition を評価
  const prev = this.steps[this.steps.length - 1];
  const newCands = new Array(candidates.length);
  for(let j = 0; j < candidates.length; j++){
    const cand = candidates[j];
    const eLog = Math.log(cand.emission + 1e-12);
    let bestScore = -Infinity;
    let bestBack = -1;
    for(let i = 0; i < prev.cands.length; i++){
      const trans = transitionFn(prev.cands[i].c, cand, prev.gps, gps);
      const tLog = Math.log(trans);
      const sc = prev.cands[i].score + eLog + tLog;
      if(sc > bestScore){
        bestScore = sc;
        bestBack = i;
      }
    }
    newCands[j] = { c: cand, score: bestScore, back: bestBack };
  }
  this.steps.push({ gps: gps, cands: newCands });
  // 窓溢れ → 最古を確定
  if(this.steps.length > this.N){
    return this._commitOldest();
  }
  return null;
};

// 窓末尾から最高スコアチェーンをバックトレースし path[] を返す
ViterbiMatcher.prototype._backtrace = function(){
  if(this.steps.length === 0) return [];
  const last = this.steps[this.steps.length - 1];
  let bestIdx = 0;
  for(let i = 1; i < last.cands.length; i++){
    if(last.cands[i].score > last.cands[bestIdx].score) bestIdx = i;
  }
  const path = new Array(this.steps.length);
  for(let t = this.steps.length - 1; t >= 0; t--){
    const node = this.steps[t].cands[bestIdx];
    path[t] = node.c;
    bestIdx = node.back;
    if(bestIdx < 0){
      // 残り未確定 → 残ステップは null（呼び出し側で扱う）
      for(let u = t - 1; u >= 0; u--) path[u] = null;
      break;
    }
  }
  return path;
};

// 最古ステップを確定（path[0]）し shift。新先頭の back は -1 に切る。
// 戻り値: snap オブジェクト + observationTimestamp（呼び出し側 dt 判定用）
ViterbiMatcher.prototype._commitOldest = function(){
  if(this.steps.length === 0) return null;
  const oldestGps = this.steps[0].gps;
  const path = this._backtrace();
  const oldest = path[0];
  let result = null;
  if(oldest){
    result = Object.assign({}, oldest, {
      observationTimestamp: oldestGps ? oldestGps.timestamp : null,
    });
  }
  this.steps.shift();
  if(this.steps.length > 0){
    const head = this.steps[0].cands;
    for(let i = 0; i < head.length; i++) head[i].back = -1;
  }
  return result;
};

// 残窓全体を確定して path[] を返す（業務終了時の reset 前に呼ぶ）
// 各要素は snap + observationTimestamp を持つ
ViterbiMatcher.prototype.flush = function(){
  const stepsSnapshot = this.steps.slice();
  const path = this._backtrace();
  this.steps = [];
  const out = [];
  for(let i = 0; i < path.length; i++){
    if(path[i]){
      out.push(Object.assign({}, path[i], {
        observationTimestamp: stepsSnapshot[i].gps
          ? stepsSnapshot[i].gps.timestamp : null,
      }));
    }
  }
  return out;
};

// MM-3: Viterbi インスタンス（reset で使い回し）
let viterbi = new ViterbiMatcher(VITERBI_N);

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

  // MM-5: DEM データ受け取り
  // payload: { bbox:[minLat,minLng,maxLat,maxLng], gridSize, numLat, numLng, altB64 }
  // alt は Int16Array を base64 化したもの（標高 m, sea level 基準）
  if(msg.type === 'loadDem'){
    try {
      const altBuf = _b64ToArrayBuffer(msg.altB64);
      _demData = {
        bbox: msg.bbox,
        gridSize: msg.gridSize,
        numLat: msg.numLat,
        numLng: msg.numLng,
        alt: new Int16Array(altBuf),
      };
      self.postMessage({
        type: 'demLoaded', ok: true,
        cells: _demData.numLat * _demData.numLng,
        sizeMB: (altBuf.byteLength / 1024 / 1024).toFixed(2),
      });
    } catch(err){
      self.postMessage({ type: 'demLoaded', ok: false, error: err.message });
    }
    return;
  }

  // MM-4b: road-graph 受け取り
  if(msg.type === 'loadGraph'){
    try {
      if(graphs.has(msg.pref)){
        self.postMessage({
          type: 'graphLoaded', pref: msg.pref, ok: true,
          numNodes: graphs.get(msg.pref).numNodes,
          _reason: 'already loaded',
        });
        return;
      }
      const t0 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : 0;
      const g = _decodeGraphData(msg.graphData);
      // shortcut インデックス事前構築
      _buildShortcutIndex(g);
      // road-segment → edge index（v=1 のみ・v=2 は compile-time index 使用）
      if(g.v < 2) _buildRoadSegIndex(g);
      graphs.set(msg.pref, g);
      // graph 更新で route キャッシュは無効化（pref 切替時の整合性担保）
      _routeCache.clear();
      const t1 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : 0;
      // Phase A: graph の RAM 実測値を main 側で確認できるように post に含める
      const memBytes = _calcGraphMemBytes(g);
      self.postMessage({
        type: 'graphLoaded', pref: msg.pref, ok: true,
        version: g.v,
        numNodes: g.numNodes, numEdges: g.numEdges, numShortcuts: g.numShortcuts,
        memBytes: memBytes, memMB: (memBytes / 1024 / 1024).toFixed(2),
        decodeMs: t1 - t0,
      });
    } catch(err){
      self.postMessage({
        type: 'graphLoaded', pref: msg.pref, ok: false, error: err.message,
      });
    }
    return;
  }

  // 連続性リセット（Meter.start / reset 時・業務終了時）
  // MM-3: 窓内に残った確定前ステップを全て flush して mm_distance_m に加算してから clear
  if(msg.type === 'reset'){
    let totalIncrement = 0;
    let lastSnapAfterFlush = null;
    if(viterbi.size() > 0){
      const path = viterbi.flush();
      let prev = lastCommittedSnap;
      for(let i = 0; i < path.length; i++){
        const c = path[i];
        if(prev){
          // observationTimestamp ベースで dt 判定（同じ MM_GAP_RESET_SEC 上限）
          const prevObsT = prev.observationTimestamp;
          const currObsT = c.observationTimestamp;
          const dtSec = (prevObsT != null && currObsT != null)
            ? (currObsT - prevObsT) / 1000
            : 0;
          if(dtSec <= MM_GAP_RESET_SEC){
            const r = _routeDistance(prev, c);
            if(r && typeof r.distanceM === 'number'
               && r.distanceM >= 0 && r.distanceM <= MM_MAX_SEGMENT_DIST_M){
              totalIncrement += r.distanceM;
            }
          }
        }
        prev = c;
      }
      lastSnapAfterFlush = prev;
    }
    if(totalIncrement > 0){
      self.postMessage({
        type: 'mmResult',
        mmIncrementM: totalIncrement,
        snap: lastSnapAfterFlush,
        confidence: 1.0,
        snapped: 0,                // flush 中は snap_count 加算しない
        skipped: 0,
        latencyMs: 0,
        candidatesCount: 0,
        windowSize: 0,
        committed: true,
        _reason: 'flush before reset',
      });
    }
    viterbi.reset();
    lastCommittedSnap = null;
    prevSnap = null;
    _gpsBuffer.length = 0;
    return;
  }

  // GPS 更新
  if(msg.type === 'gps'){
    const t0 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();

    // MM-1.5: cellular tunnel hint = デッドレコニングモード
    // Viterbi 窓は触らない（hint 解除後に自然復帰する）
    if(msg.cellularLayerHint === 'tunnel'){
      _pushGpsBuffer({ lat: msg.lat, lng: msg.lng, timestamp: msg.timestamp });
      const t1 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
      self.postMessage({
        type: 'mmResult', mmIncrementM: 0, snap: null, confidence: 1.0,
        snapped: 0, skipped: 0, latencyMs: t1 - t0, candidatesCount: 0,
        windowSize: viterbi.size(),
        _reason: 'cellular tunnel hint',
      });
      return;
    }

    _pushGpsBuffer({ lat: msg.lat, lng: msg.lng, timestamp: msg.timestamp });

    let mmIncrementM = 0;
    let snapped = 0, skipped = 0;
    let outSnap = null;
    let reason = null;
    let candCount = 0;
    let pickedEmission = 0;
    let committed = false;

    try {
      // ① 多候補 snap
      const cands = _snapAllAcrossPrefs(msg.lat, msg.lng, msg.accuracy);
      candCount = cands.length;
      if(candCount === 0){
        // 候補ゼロ = snap miss（窓状態は維持・skip カウントなし）
        reason = 'no candidates';
      } else {
        // ② emission scoring（直前 commit 済 snap の type bucket を prev として渡す）
        const prevBucket = (lastCommittedSnap && lastCommittedSnap._typeBucket)
          ? lastCommittedSnap._typeBucket
          : ((prevSnap && prevSnap._typeBucket) ? prevSnap._typeBucket : null);
        // MM-5: gps altitude / accelLayerHint / cellularLayerHint を layer scorer に渡す
        _scoreCandidates(cands, msg.lat, msg.lng, msg.accuracy || 20, msg.headingDeg, prevBucket,
                         msg.altitude, msg.accelLayerHint, msg.cellularLayerHint);

        // 出力用に「最高 emission の 1 件」を選んでおく（diagnostic / mmResult.snap 用）
        let bestEmit = cands[0];
        for(let i = 1; i < cands.length; i++){
          if(cands[i].emission > bestEmit.emission) bestEmit = cands[i];
        }
        pickedEmission = bestEmit.emission;
        snapped = 1;
        outSnap = bestEmit;

        // ③ Viterbi 窓に push
        const gpsObs = { lat: msg.lat, lng: msg.lng, timestamp: msg.timestamp };
        const newCommitted = viterbi.push(gpsObs, cands, _transitionScore);

        // ④ commit が起きた場合、lastCommittedSnap → newCommitted 間の距離を加算
        // newCommitted.observationTimestamp は確定された GPS 観測時刻（N 秒前）
        if(newCommitted){
          committed = true;
          if(lastCommittedSnap){
            const prevObsT = lastCommittedSnap.observationTimestamp;
            const currObsT = newCommitted.observationTimestamp;
            const dtSec = (prevObsT != null && currObsT != null)
              ? (currObsT - prevObsT) / 1000
              : 0;
            if(dtSec > MM_GAP_RESET_SEC){
              reason = 'gap reset between commits';
            } else {
              const r = _routeDistance(lastCommittedSnap, newCommitted);
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
          lastCommittedSnap = newCommitted;  // observationTimestamp を含む
        }

        // MM-2 互換 prevSnap も更新（Viterbi 不在時 fallback 経路用に維持）
        prevSnap = Object.assign({}, bestEmit, { timestamp: msg.timestamp });
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
      windowSize: viterbi.size(),
      committed: committed,
      snapped: snapped,
      skipped: skipped,
      latencyMs: t1 - t0,
      candidatesCount: candCount,
      pickedEmission: pickedEmission,
      _reason: reason,
    });
  }
};
