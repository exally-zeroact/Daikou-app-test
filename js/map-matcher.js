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
importScripts('osrm-client.js');   // MM-6: OSRM /match クライアント

// 既存定数（MM-1 と同一・挙動互換のため不変）
const MM_MAX_SNAP_DIST_M    = 50;     // snap 単独の上限（fallback）
const MM_MAX_SEGMENT_DIST_M = 1000;
const MM_GAP_RESET_SEC      = 5;

// MM-3 / MM-7: Viterbi パラメタ
// MM-7: 窓幅 N を 15 に拡張（MCM Lazy Viterbi）
//        p99 latency が 5ms 超過時に N=10 へ自動縮小（性能予算遵守）
const VITERBI_N_MAX        = 15;      // 通常運用の窓幅
const VITERBI_N_MIN        = 10;      // 性能逼迫時の縮小値
let   _viterbiN            = VITERBI_N_MAX;
const TRANSITION_BETA_M    = 30;      // exp(-|routeDist-chordDist|/β) の β
const ONEWAY_PENALTY       = 0.05;    // 一方通行違反時の transition 乗数

// MM-7: Worker 内 latency 自己監視（p99 5ms 超過検知用）
const _WORKER_LAT_BUFFER_SIZE = 200;
const _workerLatBuf = new Float32Array(_WORKER_LAT_BUFFER_SIZE);
let _workerLatIdx = 0, _workerLatCount = 0;
let _viterbiShrinkLogged = false;
const _MCM_LAT_THRESHOLD_MS = 5.0;
const _MCM_CHECK_INTERVAL = 100;       // GPS 更新 100 件ごとにチェック
let _mcmCheckCounter = 0;

function _recordWorkerLat(ms){
  if(typeof ms !== 'number' || !isFinite(ms) || ms < 0) return;
  _workerLatBuf[_workerLatIdx] = ms;
  _workerLatIdx = (_workerLatIdx + 1) % _WORKER_LAT_BUFFER_SIZE;
  if(_workerLatCount < _WORKER_LAT_BUFFER_SIZE) _workerLatCount++;
}

function _calcWorkerP99(){
  if(_workerLatCount === 0) return 0;
  const arr = new Array(_workerLatCount);
  for(let i = 0; i < _workerLatCount; i++) arr[i] = _workerLatBuf[i];
  arr.sort(function(a, b){ return a - b; });
  return arr[Math.min(Math.floor(_workerLatCount * 0.99), _workerLatCount - 1)];
}

// MM-7: Viterbi 窓サイズの自動調整
function _maybeAdjustViterbiN(){
  _mcmCheckCounter++;
  if(_mcmCheckCounter < _MCM_CHECK_INTERVAL) return;
  _mcmCheckCounter = 0;
  if(_workerLatCount < 100) return;   // 統計サンプル不足
  const p99 = _calcWorkerP99();
  if(p99 > _MCM_LAT_THRESHOLD_MS && _viterbiN > VITERBI_N_MIN){
    const oldN = _viterbiN;
    _viterbiN = VITERBI_N_MIN;
    if(viterbi){ viterbi.N = _viterbiN; }
    if(!_viterbiShrinkLogged){
      _viterbiShrinkLogged = true;
      // dlog 相当（main 側に通知）
      self.postMessage({
        type: 'mcmShrink', from: oldN, to: _viterbiN, p99: p99,
      });
    }
  }
}

// 県別 RoadDecoder
const decoders   = new Map();
const loadedPrefs = new Set();

// MM-4b: 県別 road-graph（CSR + CH ショートカット）
const graphs = new Map();   // pref → decoded graph object

// ─── Phase B (2026-05-08): バックボーン graph + タイルキャッシュ ──────
// 全国 motorway/trunk バックボーンは常時 RAM 常駐（県跨ぎ routing 用）
let _backboneGraph = null;

// TileCache: LRU 25 タイル + pin/unpin（in-flight tile 保護）
const TILE_CACHE_MAX = 25;
function TileCache(){
  this.map = new Map();              // tileKey "pref/tx_ty" → tile data
  this.pinned = new Set();           // 解放禁止キー
  this.recencyOrder = [];            // LRU
}
TileCache.prototype.get = function(key){
  const t = this.map.get(key);
  if(!t) return null;
  // recency 更新
  const idx = this.recencyOrder.indexOf(key);
  if(idx >= 0) this.recencyOrder.splice(idx, 1);
  this.recencyOrder.push(key);
  return t;
};
TileCache.prototype.set = function(key, tile){
  if(this.map.has(key)){
    this.map.set(key, tile);
    return;
  }
  this.map.set(key, tile);
  this.recencyOrder.push(key);
  this._evict();
};
TileCache.prototype._evict = function(){
  while(this.map.size > TILE_CACHE_MAX){
    let removed = false;
    for(let i = 0; i < this.recencyOrder.length; i++){
      const k = this.recencyOrder[i];
      if(!this.pinned.has(k)){
        this.recencyOrder.splice(i, 1);
        this.map.delete(k);
        removed = true;
        break;
      }
    }
    if(!removed) break;   // 全 pin されてる場合は eviction 諦め（次回試行）
  }
};
TileCache.prototype.pin = function(key){ this.pinned.add(key); };
TileCache.prototype.unpin = function(key){ this.pinned.delete(key); };
TileCache.prototype.has = function(key){ return this.map.has(key); };
TileCache.prototype.size = function(){ return this.map.size; };

const _tileCache = new TileCache();
const TILE_DEG = 0.05;   // build-road-graph-tiled.js と一致

// Phase B runtime: タイル prefetch 状態（in-flight 重複 request 防止）
const _tilePrefetchInflight = new Set();
let _tileMissCount = 0;
let _tileHitCount = 0;
let _tileRequestCount = 0;

// 緯度経度 → タイルキー
function _tileKeyOf(pref, lat, lng){
  const tx = Math.floor(lat / TILE_DEG);
  const ty = Math.floor(lng / TILE_DEG);
  return pref + '/' + tx + '_' + ty;
}

// Worker → main: タイル取得依頼
function _requestTileFromMain(pref, tx, ty){
  const key = pref + '/' + tx + '_' + ty;
  if(_tileCache.has(key)) return;
  if(_tilePrefetchInflight.has(key)) return;
  _tilePrefetchInflight.add(key);
  _tileRequestCount++;
  try {
    self.postMessage({ type: 'requestTile', pref: pref, tx: tx, ty: ty });
  } catch(e){
    _tilePrefetchInflight.delete(key);
  }
}

// GPS 進行方向の前方タイルを prefetch
function _prefetchTilesAround(lat, lng, headingDeg, speedKmh, pref){
  if(!pref) return;
  const tx = Math.floor(lat / TILE_DEG);
  const ty = Math.floor(lng / TILE_DEG);
  // 現在地 + 8 近傍
  for(let dx = -1; dx <= 1; dx++){
    for(let dy = -1; dy <= 1; dy++){
      _requestTileFromMain(pref, tx + dx, ty + dy);
    }
  }
  // 進行方向 30 秒先（最大 2km）の予測点
  if(headingDeg != null && speedKmh > 5){
    const aheadM = Math.min(2000, (speedKmh / 3.6) * 30);
    const tr = Math.PI / 180;
    const dLat = (aheadM * Math.cos(headingDeg * tr)) / 111000;
    const cosLat = Math.cos(lat * tr);
    const dLng = cosLat > 0.01 ? (aheadM * Math.sin(headingDeg * tr)) / (111000 * cosLat) : 0;
    const ftx = Math.floor((lat + dLat) / TILE_DEG);
    const fty = Math.floor((lng + dLng) / TILE_DEG);
    if(ftx !== tx || fty !== ty) _requestTileFromMain(pref, ftx, fty);
  }
}

// タイル内 (roadIdx, segIdx) → local node index
// 初回参照時に index 構築（lazy）
function _buildTileRoadSegIndex(tile){
  if(tile._roadSegIndex) return;
  // tile.edgeRoad / edgeSeg は decode 必要
  if(!tile._decoded){
    tile._decoded = true;
    tile.nodeLat       = new Int32Array(_b64ToArrayBuffer(tile.nodeLatB64));
    tile.nodeLng       = new Int32Array(_b64ToArrayBuffer(tile.nodeLngB64));
    tile.globalId      = new Uint32Array(_b64ToArrayBuffer(tile.globalIdB64));
    tile.nodeOffset    = new Uint32Array(_b64ToArrayBuffer(tile.nodeOffsetB64));
    tile.edgeTo        = new Uint32Array(_b64ToArrayBuffer(tile.edgeToB64));
    tile.edgeLenM      = new Uint16Array(_b64ToArrayBuffer(tile.edgeLenMB64));
    tile.edgeFlags     = new Uint8Array(_b64ToArrayBuffer(tile.edgeFlagsB64));
    tile.edgeRoad      = new Uint32Array(_b64ToArrayBuffer(tile.edgeRoadB64));
    tile.edgeSeg       = new Uint16Array(_b64ToArrayBuffer(tile.edgeSegB64));
  }
  const m = new Map();
  for(let e = 0; e < tile.numEdges; e++){
    const key = tile.edgeRoad[e] * 65536 + tile.edgeSeg[e];
    if(!m.has(key)) m.set(key, e);
  }
  tile._roadSegIndex = m;
}

function _snapToTileNode(tile, snap){
  _buildTileRoadSegIndex(tile);
  const key = snap.roadIndex * 65536 + (snap.segmentIndex || 0);
  const e = tile._roadSegIndex.get(key);
  if(e === undefined) return -1;
  // edge index → from-node を二分探索（tile.nodeOffset 上）
  let lo = 0, hi = tile.numNodes;
  while(lo < hi){
    const mid = (lo + hi) >>> 1;
    if(tile.nodeOffset[mid + 1] <= e) lo = mid + 1;
    else hi = mid;
  }
  const fromN = lo;
  const toN = tile.edgeTo[e];
  return (snap.t != null && snap.t >= 0.5) ? toN : fromN;
}

// Tile-local Dijkstra（タイル内のみ・cross-tile は呼出側で fallback）
function _runTileDijkstra(tile, srcN, dstN, maxDistM, deadline){
  if(srcN < 0 || dstN < 0 || srcN >= tile.numNodes || dstN >= tile.numNodes) return null;
  if(srcN === dstN) return 0;
  if(!tile._dist || tile._dist.length !== tile.numNodes){
    tile._dist = new Float32Array(tile.numNodes);
    tile._visited = new Uint8Array(tile.numNodes);
    tile._touched = [];
  }
  const dist = tile._dist;
  const visited = tile._visited;
  const touched = tile._touched;
  for(let i = 0; i < touched.length; i++){
    dist[touched[i]] = Infinity;
    visited[touched[i]] = 0;
  }
  touched.length = 0;
  const precision = tile.precision || 1e5;
  const dstLat = tile.nodeLat[dstN] / precision;
  const dstLng = tile.nodeLng[dstN] / precision;
  dist[srcN] = 0;
  touched.push(srcN);
  const heap = new BinaryHeap();
  heap.push(srcN, 0);
  let iters = 0;
  const lenScale = tile.edgeLenScale || 0.1;
  while(heap.size() > 0){
    if((++iters & 0x3F) === 0 && deadline > 0 && performance.now() > deadline) return null;
    const top = heap.pop();
    const u = top.n;
    if(visited[u]) continue;
    visited[u] = 1;
    const du = dist[u];
    if(du > maxDistM) continue;
    if(u === dstN) return du;
    const eStart = tile.nodeOffset[u];
    const eEnd = tile.nodeOffset[u + 1];
    for(let k = eStart; k < eEnd; k++){
      const v = tile.edgeTo[k];
      if(visited[v]) continue;
      const newD = du + tile.edgeLenM[k] * lenScale;
      if(newD < dist[v] && newD <= maxDistM){
        dist[v] = newD;
        if(touched.length < 16384) touched.push(v);
        const h = _haversine(tile.nodeLat[v] / precision, tile.nodeLng[v] / precision, dstLat, dstLng) * 0.9;
        heap.push(v, newD + h);
      }
    }
  }
  return null;
}

// Phase B runtime: タイル経路で route 距離を計算
//   src/dst が同一タイルかつタイル loaded → tile Dijkstra
//   それ以外 → null（呼出側で backbone / haversine fallback）
function _routeDistanceTileFirst(a, b){
  if(!a || !b) return null;
  if(a.prefecture !== b.prefecture) return null;
  const tileA = _tileKeyOf(a.prefecture, a.snapLat, a.snapLng);
  const tileB = _tileKeyOf(b.prefecture, b.snapLat, b.snapLng);
  if(tileA !== tileB){
    // cross-tile: 両方 prefetch して fallback
    const partsA = tileA.split('/');
    const partsB = tileB.split('/');
    const txyA = partsA[1].split('_'); const txyB = partsB[1].split('_');
    _requestTileFromMain(a.prefecture, parseInt(txyA[0],10), parseInt(txyA[1],10));
    _requestTileFromMain(b.prefecture, parseInt(txyB[0],10), parseInt(txyB[1],10));
    return null;
  }
  const tile = _tileCache.get(tileA);
  if(!tile){
    _tileMissCount++;
    const parts = tileA.split('/');
    const txy = parts[1].split('_');
    _requestTileFromMain(a.prefecture, parseInt(txy[0],10), parseInt(txy[1],10));
    return null;
  }
  _tileHitCount++;
  _tileCache.pin(tileA);
  try {
    const srcN = _snapToTileNode(tile, a);
    const dstN = _snapToTileNode(tile, b);
    if(srcN < 0 || dstN < 0) return null;
    const chordM = _haversine(a.snapLat, a.snapLng, b.snapLat, b.snapLng);
    const maxDistM = chordM * 1.5 + 200;
    const t0 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : 0;
    const distM = _runTileDijkstra(tile, srcN, dstN, maxDistM, t0 + DIJKSTRA_TIMEOUT_MS);
    if(distM == null) return null;
    return { distanceM: distM, onSameRoad: false, _via: 'tile' };
  } finally {
    _tileCache.unpin(tileA);
  }
}

// MM-5 (2026-05-08): DEM データ（高度データ）
// 形式: { bbox:[minLat,minLng,maxLat,maxLng], gridSize, numLat, numLng, alt:Int16Array }
// alt[y * numLng + x] = 該当グリッドの標高 (m, sea level 基準, Int16 範囲 -32768〜32767m)
let _demData = null;
const _LAYER_BOOST_FACTOR = 1.3;       // accel/cellular hint と layer 一致時のブースト
const _LAYER_WRONG_PENALTY = 0.3;      // 高架/地下 で alt 矛盾時のペナルティ

// ─── MM-6 (2026-05-08): OSRM /match 教師信号 ───────────────────
// 30 秒分の GPS トレースをバッファし定期的に OSRM /match に送信。
// 返却される leg distance を「教師信号」として transition score に重み付き反映。
// オフライン時 / OSRM 失敗時は即スキップして既存処理に fallback。
const _osrmTraceBuffer = [];                // [{lat,lng,timestamp,accuracy}]
const OSRM_BATCH_INTERVAL_MS = 30000;       // 30 秒ごとに 1 回バッチ送信
const OSRM_MAX_BUFFER_SIZE   = 60;          // バッファ最大点数（1Hz×60s で安全側）
const OSRM_MIN_BATCH_POINTS  = 5;           // バッチ最小点数（短すぎ trace は無効）
const OSRM_TEACHER_TTL_MS    = 60000;       // 教師信号の有効期限 60 秒
const OSRM_BLEND_WEIGHT      = 0.7;         // 教師信号 0.7 + 自前 routing 0.3 で重み付き融合
let _lastOsrmBatchAt = 0;
let _osrmInflight = false;                  // 並列実行防止
let _osrmEnabled = true;                    // false で機能無効化（main から configOsrm で制御）

// 直近の教師信号: trace[i] と trace[i+1] 間の OSRM 計算距離 = legs[i]
let _osrmTeacher = {
  trace: [],
  legs: [],
  expiresAt: 0,
  // 統計（diagnostic 用）
  hits: 0, misses: 0, batches: 0, batchFails: 0,
};

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

// MM-2/MM-5/MM-7: emission scoring
//   候補絞り込み後に layer score を最後段で乗算
//   MM-7: 地域別 GPS 誤差学習 (grid bias) で σ を補正
//   MM-7: フェロモン boost を最終乗算（常用ルートを優先）
function _scoreCandidates(cands, gpsLat, gpsLng, accuracy, headingDeg, prevTypeBucket,
                         gpsAlt, accelLayerHint, cellularLayerHint){
  // MM-7: grid bias 補正で σ を地域固有に調整
  const sigmaMult = _getGridSigmaMultiplier(gpsLat, gpsLng);
  const sigma = (4 + 0.5 * accuracy) * sigmaMult;
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
    // ⑤ MM-5: layer score（候補絞り込み後）
    const layerScore = _computeLayerScore(c, gpsLat, gpsLng, gpsAlt,
                                          accelLayerHint, cellularLayerHint);
    // ⑥ MM-7: フェロモン boost（常用ルート優先）
    const phBoost = _getPheromoneBoost(c.prefecture, c.roadIndex);
    // 総合
    c._distScore = distScore;
    c._headScore = headScore;
    c._mahalScore = mahalScore;
    c._typeScore = typeScore;
    c._layerScore = layerScore;
    c._phBoost = phBoost;
    c._typeBucket = currBucket;
    c.emission = distScore * headScore * mahalScore * typeScore * layerScore * phBoost;
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

// ─── Phase B runtime: route 距離計算
// 優先順序: 同road=polyline → tile Dijkstra → 既存 graph → backbone → haversine
// すべて失敗時は haversine 弦距離を返す（業務継続性担保）
function _routeDistance(a, b){
  if(!a || !b) return null;
  // 同 road → polyline 沿い距離（既存・最も正確）
  if(a.prefecture === b.prefecture && a.roadIndex === b.roadIndex){
    const dec = decoders.get(a.prefecture);
    if(dec){
      const r = dec.calcRoadDistance(a, b);
      if(r){ r._via = 'polyline'; return r; }
    }
  }
  // Phase B: タイル経路を最優先で試行（メモリ効率最重視）
  const tileResult = _routeDistanceTileFirst(a, b);
  if(tileResult) return tileResult;

  const chordM = _haversine(a.snapLat, a.snapLng, b.snapLat, b.snapLng);

  // graph が同一県でロード済みなら Dijkstra 試行（後方互換 / per-pref auto-load 廃止後は実質未使用）
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

  // Phase B: backbone graph で県跨ぎ補完
  if(_backboneGraph){
    // backbone は global node space ではないので簡易的に nearest node 探索
    // 実装簡略化のため: backbone Dijkstra も試行（同 graph 構造）
    // ただし src/dst を backbone node に map する手段がないため
    // 現状は backbone はあくまで cross-pref fallback の placeholder（次回拡張）
    // → haversine fallback に流れる
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

// ─── MM-7: 蟻コロニー Pheromone（路網習熟）────────────────────
// 各 pref の roadIndex ごとに float32 のフェロモン値を持つ。
// snap 成功時に +1・1 乗務終了（reset）時に ×0.95 で蒸発。
// 候補生成時の emission に (1 + log(1 + pheromone)) で乗算 → 常用ルートを優先。
const _pheromoneByPref = new Map();   // pref → Float32Array(numRoads)
const PHEROMONE_EVAPORATION = 0.95;
const PHEROMONE_INC = 1.0;
const PHEROMONE_BOOST_CAP = 3.0;      // log boost が暴走しないように上限 ×3

function _ensurePheromone(pref, numRoads){
  if(_pheromoneByPref.has(pref)) return _pheromoneByPref.get(pref);
  const arr = new Float32Array(numRoads);
  _pheromoneByPref.set(pref, arr);
  return arr;
}

function _markPheromone(pref, roadIndex){
  if(!pref) return;
  const arr = _pheromoneByPref.get(pref);
  if(!arr || roadIndex < 0 || roadIndex >= arr.length) return;
  arr[roadIndex] += PHEROMONE_INC;
}

function _getPheromoneBoost(pref, roadIndex){
  if(!pref) return 1.0;
  const arr = _pheromoneByPref.get(pref);
  if(!arr || roadIndex < 0 || roadIndex >= arr.length) return 1.0;
  const ph = arr[roadIndex];
  if(ph <= 0) return 1.0;
  const boost = 1.0 + Math.log(1.0 + ph);
  return boost > PHEROMONE_BOOST_CAP ? PHEROMONE_BOOST_CAP : boost;
}

function _evaporatePheromones(){
  for(const arr of _pheromoneByPref.values()){
    for(let i = 0; i < arr.length; i++) arr[i] *= PHEROMONE_EVAPORATION;
  }
}

function _countActivePheromoneRoads(){
  let total = 0;
  for(const arr of _pheromoneByPref.values()){
    for(let i = 0; i < arr.length; i++){
      if(arr[i] > 0.01) total++;
    }
  }
  return total;
}

// ─── MM-7: 地域別 GPS 誤差学習（500m × 500m grid bias） ────────
// snap 成功時の (gpsLat - snapLat, gpsLng - snapLng) を grid 単位で蓄積。
// 1000 サンプル超のセルは emission の σ を補正（地域固有 GPS bias を吸収）。
// IndexedDB 永続保存。サイズ上限 5MB（200k entry 相当）でそれ以上は古いセル順に discard。
const GRID_DEG = 0.005;                // 約 500m × 500m
const GRID_MIN_SAMPLES = 1000;         // この件数超で σ 補正発動
const GRID_MAX_CELLS = 200000;         // 5MB 以内（24 bytes/cell × 200k = 4.8MB）
// stats 配列レイアウト (Float32 × 5): [count, sumDxM, sumDyM, sumDx2M2, sumDy2M2]
const GRID_FIELDS = 5;
const _gridBias = new Map();           // gridKey:string → Float32Array(GRID_FIELDS)

function _gridKey(lat, lng){
  const gy = Math.floor(lat / GRID_DEG);
  const gx = Math.floor(lng / GRID_DEG);
  return gy + '_' + gx;
}

function _recordGridBiasSample(gpsLat, gpsLng, snapLat, snapLng){
  const key = _gridKey(gpsLat, gpsLng);
  let cell = _gridBias.get(key);
  if(!cell){
    if(_gridBias.size >= GRID_MAX_CELLS){
      // 上限到達: discard policy（最初の 1 件を削除＝挿入順 LRU 近似）
      const first = _gridBias.keys().next();
      if(!first.done) _gridBias.delete(first.value);
    }
    cell = new Float32Array(GRID_FIELDS);
    _gridBias.set(key, cell);
  }
  // dx/dy はメートル換算（経度は緯度依存・精度十分）
  const mpd = _metersPerDegree(gpsLat);
  const dxM = (gpsLng - snapLng) * mpd.lng;
  const dyM = (gpsLat - snapLat) * mpd.lat;
  cell[0] += 1;
  cell[1] += dxM;
  cell[2] += dyM;
  cell[3] += dxM * dxM;
  cell[4] += dyM * dyM;
}

// セルが学習済（≥1000 samples）なら σ 補正係数を返す（>=1.0）
// 補正後 σ_corrected = σ × multiplier
function _getGridSigmaMultiplier(gpsLat, gpsLng){
  const cell = _gridBias.get(_gridKey(gpsLat, gpsLng));
  if(!cell || cell[0] < GRID_MIN_SAMPLES) return 1.0;
  const n = cell[0];
  const meanX = cell[1] / n;
  const meanY = cell[2] / n;
  const varX = cell[3] / n - meanX * meanX;
  const varY = cell[4] / n - meanY * meanY;
  const stddev = Math.sqrt(Math.max(0, varX) + Math.max(0, varY));
  // σ は 4 + 0.5 × accuracy で典型 14m 程度。
  // この grid の実測 stddev が 20m なら σ を ×1.4 倍する
  if(stddev <= 0) return 1.0;
  const baseSigma = 14.0;
  const mult = stddev / baseSigma;
  return mult < 1.0 ? 1.0 : (mult > 3.0 ? 3.0 : mult);  // [1.0, 3.0] でクランプ
}

// ─── MM-7: IndexedDB 永続化（pheromone + grid_bias） ────────────
const _DB_NAME = 'daikome_mm7';
const _DB_VERSION = 1;
let _dbPromise = null;

function _openDb(){
  if(_dbPromise) return _dbPromise;
  if(typeof indexedDB === 'undefined') return Promise.resolve(null);
  _dbPromise = new Promise(function(resolve){
    try {
      const req = indexedDB.open(_DB_NAME, _DB_VERSION);
      req.onupgradeneeded = function(e){
        const db = e.target.result;
        if(!db.objectStoreNames.contains('pheromone')){
          db.createObjectStore('pheromone', { keyPath: 'pref' });
        }
        if(!db.objectStoreNames.contains('gridBias')){
          db.createObjectStore('gridBias', { keyPath: 'k' });
        }
      };
      req.onsuccess = function(e){ resolve(e.target.result); };
      req.onerror = function(){ resolve(null); };
    } catch(e){ resolve(null); }
  });
  return _dbPromise;
}

function _savePheromoneAll(){
  return _openDb().then(function(db){
    if(!db) return;
    try {
      const tx = db.transaction('pheromone', 'readwrite');
      const store = tx.objectStore('pheromone');
      for(const [pref, arr] of _pheromoneByPref){
        store.put({ pref: pref, data: arr.buffer });
      }
    } catch(e){}
  }).catch(function(){});
}

function _loadPheromoneFor(pref, numRoads){
  return _openDb().then(function(db){
    if(!db) return null;
    return new Promise(function(resolve){
      try {
        const tx = db.transaction('pheromone', 'readonly');
        const req = tx.objectStore('pheromone').get(pref);
        req.onsuccess = function(){
          if(req.result && req.result.data){
            const restored = new Float32Array(req.result.data);
            // numRoads 不一致時は同サイズ確保で truncate or pad（roads データ更新時の保険）
            if(restored.length === numRoads){
              _pheromoneByPref.set(pref, restored);
            } else {
              const arr = new Float32Array(numRoads);
              const lim = Math.min(numRoads, restored.length);
              for(let i = 0; i < lim; i++) arr[i] = restored[i];
              _pheromoneByPref.set(pref, arr);
            }
            resolve(_pheromoneByPref.get(pref));
          } else {
            resolve(null);
          }
        };
        req.onerror = function(){ resolve(null); };
      } catch(e){ resolve(null); }
    });
  }).catch(function(){ return null; });
}

function _saveGridBiasIncremental(){
  return _openDb().then(function(db){
    if(!db) return;
    try {
      const tx = db.transaction('gridBias', 'readwrite');
      const store = tx.objectStore('gridBias');
      // 全 entry 書き直し（write 量制御は後続最適化）
      for(const [key, arr] of _gridBias){
        store.put({ k: key, d: arr.buffer });
      }
    } catch(e){}
  }).catch(function(){});
}

function _loadGridBias(){
  return _openDb().then(function(db){
    if(!db) return;
    return new Promise(function(resolve){
      try {
        const tx = db.transaction('gridBias', 'readonly');
        const req = tx.objectStore('gridBias').getAll();
        req.onsuccess = function(){
          const items = req.result || [];
          for(let i = 0; i < items.length; i++){
            const it = items[i];
            if(it && it.k && it.d){
              const arr = new Float32Array(it.d);
              if(arr.length === GRID_FIELDS) _gridBias.set(it.k, arr);
            }
          }
          resolve(_gridBias.size);
        };
        req.onerror = function(){ resolve(0); };
      } catch(e){ resolve(0); }
    });
  }).catch(function(){ return 0; });
}

// 起動時に grid bias を復元（pheromone は graph load 時に各 pref ごとに復元）
_loadGridBias();

// ─── MM-6: OSRM 教師信号 helpers ────────────────────────────────
function _addToOsrmBuffer(gps){
  if(!_osrmEnabled) return;
  _osrmTraceBuffer.push({
    lat: gps.lat, lng: gps.lng,
    timestamp: gps.timestamp,
    accuracy: gps.accuracy || 20,
  });
  if(_osrmTraceBuffer.length > OSRM_MAX_BUFFER_SIZE){
    _osrmTraceBuffer.shift();
  }
  const now = Date.now();
  if(now - _lastOsrmBatchAt >= OSRM_BATCH_INTERVAL_MS
     && _osrmTraceBuffer.length >= OSRM_MIN_BATCH_POINTS
     && !_osrmInflight){
    _lastOsrmBatchAt = now;
    _triggerOsrmBatch();
  }
}

function _triggerOsrmBatch(){
  if(_osrmInflight) return;
  if(typeof navigator !== 'undefined' && navigator.onLine === false){
    // オフライン → 即スキップ
    return;
  }
  if(typeof self.OsrmClient === 'undefined' || !self.OsrmClient.matchBatch) return;
  const trace = _osrmTraceBuffer.slice();
  _osrmInflight = true;
  self.OsrmClient.matchBatch(trace).then(result => {
    _osrmInflight = false;
    _osrmTeacher.batches++;
    if(result && result.ok && result.legs && result.legs.length > 0){
      _osrmTeacher.trace = trace;
      _osrmTeacher.legs = result.legs;
      _osrmTeacher.expiresAt = Date.now() + OSRM_TEACHER_TTL_MS;
    } else {
      _osrmTeacher.batchFails++;
      // 失敗時は教師信号を更新しない（既存の有効期限内の信号は維持）
    }
  }).catch(() => {
    _osrmInflight = false;
    _osrmTeacher.batchFails++;
  });
}

// 隣接 GPS 観測ペア間の OSRM 教師距離を返す（無ければ null）
// timestamps を厳密一致でマッチング・連続インデックスのみ返す
function _osrmTeacherDist(prevGps, currGps){
  if(!_osrmTeacher.legs.length) return null;
  if(Date.now() > _osrmTeacher.expiresAt) return null;
  const trace = _osrmTeacher.trace;
  let prevIdx = -1, currIdx = -1;
  for(let i = 0; i < trace.length; i++){
    if(trace[i].timestamp === prevGps.timestamp) prevIdx = i;
    if(trace[i].timestamp === currGps.timestamp) currIdx = i;
    if(prevIdx >= 0 && currIdx >= 0) break;
  }
  if(prevIdx < 0 || currIdx < 0){
    _osrmTeacher.misses++;
    return null;
  }
  // 連続インデックスのみ（leg は隣接ペア間で定義される）
  if(currIdx - prevIdx !== 1){
    _osrmTeacher.misses++;
    return null;
  }
  const legM = _osrmTeacher.legs[prevIdx];
  if(typeof legM !== 'number' || legM < 0){
    _osrmTeacher.misses++;
    return null;
  }
  _osrmTeacher.hits++;
  return legM;
}

// ─── MM-3: 遷移確率（HMM transition score） ───────────────────
// score = exp(-|routeDist - chordDist| / β)・β = 30m
// oneway 違反は ×0.05 で事実上除外
function _transitionScore(prevSnapC, currSnapC, prevGps, currGps){
  const chordM = _haversine(prevGps.lat, prevGps.lng, currGps.lat, currGps.lng);
  const r = _routeDistance(prevSnapC, currSnapC);
  let routeM = r ? r.distanceM : chordM;

  // MM-6: OSRM 教師信号があれば weighted blend で routing 距離を補正
  // 教師信号 0.7 + 自前 routing 0.3（OSRM をより信頼）
  // mm_distance_m への直接代入は禁止・transition score の補正にのみ使用
  const teacherM = _osrmTeacherDist(prevGps, currGps);
  if(teacherM != null){
    routeM = OSRM_BLEND_WEIGHT * teacherM + (1 - OSRM_BLEND_WEIGHT) * routeM;
  }

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

// MM-3 / MM-7: Viterbi インスタンス（reset で使い回し・N=15 で開始）
let viterbi = new ViterbiMatcher(_viterbiN);

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

  // MM-7: 統計取得（debug 用）
  if(msg.type === 'getMm7Stats'){
    self.postMessage({
      type: 'mm7Stats',
      mcm_window_size: _viterbiN,
      mcm_window_max: VITERBI_N_MAX,
      mcm_shrunk: _viterbiN < VITERBI_N_MAX,
      pheromone_roads_count: _countActivePheromoneRoads(),
      pheromone_prefs: _pheromoneByPref.size,
      grid_cells_count: _gridBias.size,
      grid_cells_max: GRID_MAX_CELLS,
      worker_p99_ms: _calcWorkerP99(),
      worker_lat_samples: _workerLatCount,
    });
    return;
  }

  // MM-6: OSRM 統計取得（debug 用）
  if(msg.type === 'getOsrmStats'){
    self.postMessage({
      type: 'osrmStats',
      enabled: _osrmEnabled,
      endpoint: (typeof self.OsrmClient !== 'undefined') ? self.OsrmClient.getEndpoint() : null,
      bufferSize: _osrmTraceBuffer.length,
      teacherActive: Date.now() <= _osrmTeacher.expiresAt,
      teacherLegs: _osrmTeacher.legs.length,
      hits: _osrmTeacher.hits,
      misses: _osrmTeacher.misses,
      batches: _osrmTeacher.batches,
      batchFails: _osrmTeacher.batchFails,
      onLine: typeof navigator !== 'undefined' ? navigator.onLine : null,
    });
    return;
  }

  // MM-6: OSRM エンドポイント設定
  // payload: { endpoint?: string, enabled?: boolean }
  if(msg.type === 'configOsrm'){
    try {
      if(typeof msg.endpoint === 'string' && msg.endpoint.length > 0
         && typeof self.OsrmClient !== 'undefined'){
        self.OsrmClient.setEndpoint(msg.endpoint);
      }
      if(typeof msg.enabled === 'boolean'){
        _osrmEnabled = msg.enabled;
      }
      self.postMessage({
        type: 'osrmConfigured', ok: true,
        endpoint: (typeof self.OsrmClient !== 'undefined') ? self.OsrmClient.getEndpoint() : null,
        enabled: _osrmEnabled,
      });
    } catch(err){
      self.postMessage({ type: 'osrmConfigured', ok: false, error: err.message });
    }
    return;
  }

  // Phase B: バックボーン graph 受け取り（全国 motorway/trunk・常駐）
  if(msg.type === 'loadBackbone'){
    try {
      const t0 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : 0;
      _backboneGraph = _decodeGraphData(msg.graphData);
      // Pheromone 不要・shortcut 不要・縮小バックボーンとしてのみ使用
      const t1 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : 0;
      self.postMessage({
        type: 'backboneLoaded', ok: true,
        numNodes: _backboneGraph.numNodes,
        numEdges: _backboneGraph.numEdges,
        decodeMs: t1 - t0,
      });
    } catch(err){
      self.postMessage({ type: 'backboneLoaded', ok: false, error: err.message });
    }
    return;
  }

  // Phase B: タイル受け取り（main 側 RoadGraphTileLoader 経由）
  if(msg.type === 'loadTile'){
    try {
      const key = msg.pref + '/' + msg.tx + '_' + msg.ty;
      _tilePrefetchInflight.delete(key);
      if(msg.tileData){
        _tileCache.set(key, msg.tileData);
      }
      // tileLoaded post は頻発するためサイレント（必要時のみ）
    } catch(err){
      const key = msg.pref + '/' + msg.tx + '_' + msg.ty;
      _tilePrefetchInflight.delete(key);
    }
    return;
  }

  // Phase B: タイル取得失敗通知（404 等）
  if(msg.type === 'tileNotFound'){
    const key = msg.pref + '/' + msg.tx + '_' + msg.ty;
    _tilePrefetchInflight.delete(key);
    return;
  }

  // Phase B: タイルキャッシュ統計取得
  if(msg.type === 'getTileStats'){
    const total = _tileHitCount + _tileMissCount;
    self.postMessage({
      type: 'tileStats',
      cacheSize: _tileCache.size(),
      cacheMax: TILE_CACHE_MAX,
      pinnedCount: _tileCache.pinned.size,
      inflight: _tilePrefetchInflight.size,
      hitCount: _tileHitCount,
      missCount: _tileMissCount,
      hitRate: total > 0 ? _tileHitCount / total : 0,
      requestCount: _tileRequestCount,
      backboneLoaded: !!_backboneGraph,
      backboneNodes: _backboneGraph ? _backboneGraph.numNodes : 0,
    });
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
      // MM-7: 該当 pref の pheromone を IDB から復元（無ければ新規 Float32Array）
      _ensurePheromone(msg.pref, g.numRoads || g.numEdges);
      _loadPheromoneFor(msg.pref, g.numRoads || g.numEdges);
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
    // MM-7: 業務終了時に pheromone を蒸発・grid bias を含め IDB に永続保存
    _evaporatePheromones();
    _savePheromoneAll();
    _saveGridBiasIncremental();
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

    // MM-6: OSRM 教師信号用バッファ追加（30 秒ごとに自動でバッチ送信トリガ）
    _addToOsrmBuffer({
      lat: msg.lat, lng: msg.lng,
      timestamp: msg.timestamp, accuracy: msg.accuracy,
    });

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

        // MM-7: 蟻コロニー pheromone を採用 road にマーク
        _markPheromone(bestEmit.prefecture, bestEmit.roadIndex);
        // MM-7: 地域別 GPS 誤差学習を蓄積
        _recordGridBiasSample(msg.lat, msg.lng, bestEmit.snapLat, bestEmit.snapLng);
        // Phase B runtime: GPS 進行方向の前方タイルを prefetch
        _prefetchTilesAround(msg.lat, msg.lng, msg.headingDeg, msg.speedKmh || 0, bestEmit.prefecture);

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
    // MM-7: Worker 内 latency 自己監視 → 必要なら N を縮小
    _recordWorkerLat(t1 - t0);
    _maybeAdjustViterbiN();
    self.postMessage({
      type: 'mmResult',
      mmIncrementM: mmIncrementM,
      snap: outSnap,
      confidence: pickedEmission > 0 ? Math.min(1.0, pickedEmission) : 1.0,
      windowSize: viterbi.size(),
      mcmN: _viterbiN,
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
