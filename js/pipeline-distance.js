// ============================================================
// pipeline-distance.js  (ダイコメ 距離計算コア・白紙書き直し 第一弾)
//
// 確定方式: MM主 + Doppler従 + topology補間ハイブリッド
//   = 国交省認定ソフトメーター方式。
//   distance_m の意味論 = 「道路 snap 道なり累積」(GPS 直線課金は禁止)。
//
// このモジュールは「距離を算出するだけ」。calcFare 等の課金式は一切呼ばない。
//
// 入力 GPS sample 列 [{lat,lng,t,acc,spd}]
//   spd = coords.speed (m/s)。無ければ -1。
//   t   = epoch ミリ秒。
//
// 各点を RoadDecoder.snapToNearestRoad で道路 snap し、道なり距離を累積する。
//   - 連続 snap が同一道路   → RoadDecoder.calcRoadDistance の弧長 (onSameRoad)。
//   - 別道路間               → ★道路網 routing (簡易 Dijkstra) で「道なり距離」★。
//                              RoadDecoder には routing が無いため本モジュールで実装。
//                              過大ガード: routing距離 / 直線距離 > ROUTING_MAX_RATIO なら
//                              直線 (haversine) に fallback。
//   - snap 失敗 (null)       → Doppler 速度積分 ∫ spd dt で補間 (spd>=0 時)。
//                              spd 無ければ直線 (haversine)。
//
// 静止判定 (ZUPT 相当): spd < STATIONARY_SPD_MPS (≈0) なら加算 0 (creep 防止)。
//   ★spd 不明 (-1) 時の fallback★: 連続 2 点の haversine 変位が accuracy 由来の
//     閾値 (2σ ≈ acc 合成・最低 STATIONARY_DISP_MIN_M〜最大 STATIONARY_DISP_MAX_M) 未満なら
//     停車中 GPS ジッタとみなし加算 0 (creep 再発防止)。
//     MEMORY 方針「静止=GPS速度を主信号から外す・accuracy移動時緩和」に準拠。
//
// 速度源 pluggable: opts.speedProvider で速度源を差し替え可能。
//   既定 = GPS Doppler (sample.spd)。将来 OBD 車輪速度を差せる interface。
//   speedProvider(sample, prevSample) -> number (m/s)  ※負値 = 速度不明。
//
// module.exports = { computeDistance, RoadGraphRouter, gpsSpeedProvider, ... }
//   Node で実行可能 (tests/replay-pipeline-distance.js が実例)。
// ============================================================

'use strict';

// ─── 定数 ────────────────────────────────────────────────────
const EARTH_R = 6371000; // m
const DEG2RAD = Math.PI / 180;

// 既定パラメータ (opts で上書き可)
const DEFAULTS = {
  snapMaxDistM: 50, // snapToNearestRoad の maxDistM
  stationarySpdMps: 0.5, // これ未満の速度は静止 (ZUPT)・加算 0
  routingMaxRatio: 4.0, // routing距離/直線距離 がこれ超なら直線 fallback (過大ガード)
  routingMaxNodes: 4000, // Dijkstra 展開ノード上限 (暴走ガード)
  routingSearchGrids: 3, // routing 用に getRoadsNear する周辺グリッド半径
  nodeQuantize: 1e5, // 道路頂点を node 化する際の量子化 (= precision 既定値)
  perSegmentMaxM: 2000, // 1 区間でこの距離超は異常として直線 fallback
  routingMaxStraightM: 600, // 直線距離がこれ超の別道路区間は routing せず直線 (遠距離=gap)

  // ★spd 不明 (-1) 時の変位ベース静止 fallback (creep 防止)★
  // 停車中の phone は accuracy 規模のジッタを出す。連続 2 点の独立誤差合成
  //   (= √(accPrev²+accCur²)) の 2σ までを「移動ではなくジッタ」とみなし加算 0。
  stationaryDispMinM: 3.0, // 変位がこれ未満なら spd 不明でも無条件で静止扱い (床値)
  stationaryDispMaxM: 40.0, // accuracy 由来閾値の上限 (acc 巨大時でも過剰緩和しない天井)
  stationaryAccSigma: 2.0, // 変位閾値 = 連続2点 acc を合成した σ × この係数
  stationaryAccM: 30.0, // acc 無し/無効点の既定 accuracy (m)
};

// ─── 幾何ヘルパ ───────────────────────────────────────────────
function haversineM(lat1, lng1, lat2, lng2) {
  const dLat = (lat2 - lat1) * DEG2RAD;
  const dLng = (lng2 - lng1) * DEG2RAD;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * DEG2RAD) * Math.cos(lat2 * DEG2RAD) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
  return 2 * EARTH_R * Math.asin(Math.sqrt(a));
}

// ─── 速度源 (pluggable) ──────────────────────────────────────
// 既定 speedProvider: GPS Doppler。sample.spd (m/s) をそのまま返す。
// 無効値 (undefined/null/NaN/負) は -1 (= 速度不明) を返す。
function gpsSpeedProvider(sample /*, prevSample */) {
  if (!sample) return -1;
  const s = sample.spd;
  if (typeof s !== 'number' || isNaN(s) || s < 0) return -1;
  return s;
}

// 将来 OBD 車輪速度などを差す例 (interface の参考):
//   function obdSpeedProvider(sample) { return sample.obdSpeedMps != null ? sample.obdSpeedMps : -1; }

// ─── 静止判定ヘルパ (変位 / accuracy ベース・spd 不明時の creep 防止) ──────
// sample.acc (= GPS 水平精度 m) を読む。無効値は既定 acc を返す。
function readAcc(sample, fallbackM) {
  if (!sample) return fallbackM;
  const a = sample.acc;
  if (typeof a !== 'number' || isNaN(a) || a < 0) return fallbackM;
  return a;
}

// spd 不明 (-1) 時の静止 fallback 判定。
//   連続 2 点の haversine 変位 disp が、両点の accuracy を合成した
//   2σ 閾値 (床=stationaryDispMinM・上限=stationaryDispMaxM) 未満なら true (= 静止/ジッタ)。
//   返り値 true → 当該区間は加算 0 (creep 防止)。
function isStationaryByDisplacement(prev, cur, disp, cfg) {
  // 両点の accuracy を合成 (独立誤差の二乗和平方根)
  const accPrev = readAcc(prev, cfg.stationaryAccM);
  const accCur = readAcc(cur, cfg.stationaryAccM);
  const sigma = Math.sqrt(accPrev * accPrev + accCur * accCur);
  let thr = cfg.stationaryAccSigma * sigma;
  if (thr < cfg.stationaryDispMinM) thr = cfg.stationaryDispMinM;
  if (thr > cfg.stationaryDispMaxM) thr = cfg.stationaryDispMaxM;
  return disp < thr;
}

// ─── RoadGraphRouter ─────────────────────────────────────────
// RoadDecoder が持つ道路ポリライン群から「道路網グラフ」をオンデマンド構築し、
// 2 snap 点間の道なり距離を簡易 Dijkstra で求める。
//
// グラフ構造:
//   node  = 道路頂点を量子化した座標キー "qlat_qlng"。
//   edge  = ある道路の連続頂点 i→i+1 の弧 (双方向・oneway は距離計算では無視。
//           距離 (= 道なり長) のみが目的で、進入禁止判定は MM 側の責務)。
//   さらに road 内全頂点が同 road でつながる (= 道路は連続ポリライン)。
//   異なる road は「同一量子化 node を共有する頂点」で接続される (= 交差点)。
//
// 構築範囲は 2 snap 点周辺の getRoadsNear に限定 (完全グローバル graph は作らない)。
function RoadGraphRouter(decoder, opts) {
  this.decoder = decoder;
  this.opts = opts || {};
  this.quantize = this.opts.nodeQuantize || DEFAULTS.nodeQuantize;
  this.precision = decoder.precision || 1e5;
  this.searchGrids = this.opts.routingSearchGrids || DEFAULTS.routingSearchGrids;
  this.maxNodes = this.opts.routingMaxNodes || DEFAULTS.routingMaxNodes;
}

// 道路頂点 (整数 lat*precision, lng*precision) → node キー
RoadGraphRouter.prototype._nodeKey = function (rawLatInt, rawLngInt) {
  // decoder の precision で実座標化してから quantize で再量子化
  const lat = rawLatInt / this.precision;
  const lng = rawLngInt / this.precision;
  const ql = Math.round(lat * this.quantize);
  const qg = Math.round(lng * this.quantize);
  return ql + '_' + qg;
};

// 2 snap 点周辺の道路を集めて隣接グラフを構築。
// 戻り値: { adj: Map(nodeKey -> [{to, w, lat, lng}]), nodeLatLng: Map(nodeKey->[lat,lng]) }
RoadGraphRouter.prototype._buildLocalGraph = function (snapA, snapB) {
  const dec = this.decoder;
  const precision = this.precision;
  const midLat = (snapA.snapLat + snapB.snapLat) / 2;
  const midLng = (snapA.snapLng + snapB.snapLng) / 2;

  // 中点周辺 + 両端周辺の道路を集める (重複は roadIndex で排除)
  const roadSet = {};
  const collect = function () {
    return function (lat, lng) {
      const roads = dec.getRoadsNear(lat, lng, this.searchGrids);
      // getRoadsNear は decode 済み road を返すが roadIndex は持たない。
      // 同一性判定は始点座標 + 点数で簡易キー化。
      for (let i = 0; i < roads.length; i++) {
        const r = roads[i];
        if (!r || !r.points || r.points.length < 2) continue;
        const k = r.points[0][0] + ':' + r.points[0][1] + ':' + r.points.length;
        if (roadSet[k]) continue;
        roadSet[k] = r;
      }
    }.bind(this);
  }.call(this);

  collect(snapA.snapLat, snapA.snapLng);
  collect(snapB.snapLat, snapB.snapLng);
  collect(midLat, midLng);

  const adj = new Map();
  const nodeLatLng = new Map();
  const self = this;

  function addEdge(k1, lat1, lng1, k2, lat2, lng2, w) {
    if (!adj.has(k1)) adj.set(k1, []);
    if (!adj.has(k2)) adj.set(k2, []);
    adj.get(k1).push({ to: k2, w: w });
    adj.get(k2).push({ to: k1, w: w });
    if (!nodeLatLng.has(k1)) nodeLatLng.set(k1, [lat1, lng1]);
    if (!nodeLatLng.has(k2)) nodeLatLng.set(k2, [lat2, lng2]);
  }

  for (const key in roadSet) {
    if (!Object.prototype.hasOwnProperty.call(roadSet, key)) continue;
    const pts = roadSet[key].points;
    for (let j = 0; j < pts.length - 1; j++) {
      const aLat = pts[j][0] / precision;
      const aLng = pts[j][1] / precision;
      const bLat = pts[j + 1][0] / precision;
      const bLng = pts[j + 1][1] / precision;
      const ka = self._nodeKey(pts[j][0], pts[j][1]);
      const kb = self._nodeKey(pts[j + 1][0], pts[j + 1][1]);
      if (ka === kb) continue;
      const w = haversineM(aLat, aLng, bLat, bLng);
      addEdge(ka, aLat, aLng, kb, bLat, bLng, w);
    }
  }

  return { adj: adj, nodeLatLng: nodeLatLng };
};

// グラフ上で start node → goal node の最短 (道なり) 距離を Dijkstra で算出。
// node が graph に無い / 到達不能 → null。
RoadGraphRouter.prototype._dijkstra = function (graph, startKey, goalKey) {
  const adj = graph.adj;
  if (!adj.has(startKey) || !adj.has(goalKey)) return null;
  if (startKey === goalKey) return 0;

  const dist = new Map();
  dist.set(startKey, 0);
  // 単純配列 priority queue (近距離 routing なのでノード数は限定的)
  const heap = new MinHeap();
  heap.push(0, startKey);
  let expanded = 0;

  while (heap.size() > 0) {
    const top = heap.pop();
    const d = top.key;
    const u = top.val;
    if (d > (dist.get(u) != null ? dist.get(u) : Infinity)) continue;
    if (u === goalKey) return d;
    if (++expanded > this.maxNodes) return null; // 暴走ガード
    const edges = adj.get(u);
    if (!edges) continue;
    for (let i = 0; i < edges.length; i++) {
      const e = edges[i];
      const nd = d + e.w;
      const cur = dist.get(e.to);
      if (cur == null || nd < cur) {
        dist.set(e.to, nd);
        heap.push(nd, e.to);
      }
    }
  }
  return dist.has(goalKey) ? dist.get(goalKey) : null;
};

// 2 snap 点間の「道なり routing 距離」。失敗時 null (呼び出し側で fallback)。
// snapA/snapB の snap 座標を最寄り node に丸めて Dijkstra。
// 端点 (snap 点) から node までの僅かな距離も足す。
RoadGraphRouter.prototype.routeDistance = function (snapA, snapB) {
  const graph = this._buildLocalGraph(snapA, snapB);
  if (graph.adj.size === 0) return null;

  const startKey = this._nearestNode(graph, snapA.snapLat, snapA.snapLng);
  const goalKey = this._nearestNode(graph, snapB.snapLat, snapB.snapLng);
  if (!startKey || !goalKey) return null;

  const core = this._dijkstra(graph, startKey, goalKey);
  if (core == null) return null;

  // snap 点 → 採用 node までの端数 (両端)
  const sNode = graph.nodeLatLng.get(startKey);
  const gNode = graph.nodeLatLng.get(goalKey);
  const tailA = haversineM(snapA.snapLat, snapA.snapLng, sNode[0], sNode[1]);
  const tailB = haversineM(snapB.snapLat, snapB.snapLng, gNode[0], gNode[1]);
  return core + tailA + tailB;
};

// graph 内で (lat,lng) に最も近い node キー
RoadGraphRouter.prototype._nearestNode = function (graph, lat, lng) {
  let best = null;
  let bestD = Infinity;
  graph.nodeLatLng.forEach(function (ll, key) {
    const dx = ll[0] - lat;
    const dy = ll[1] - lng;
    const d = dx * dx + dy * dy; // 近似 (近距離比較のみ)
    if (d < bestD) {
      bestD = d;
      best = key;
    }
  });
  return best;
};

// ─── 軽量 MinHeap ────────────────────────────────────────────
function MinHeap() {
  this._a = [];
}
MinHeap.prototype.size = function () {
  return this._a.length;
};
MinHeap.prototype.push = function (key, val) {
  const a = this._a;
  a.push({ key: key, val: val });
  let i = a.length - 1;
  while (i > 0) {
    const p = (i - 1) >> 1;
    if (a[p].key <= a[i].key) break;
    const tmp = a[p];
    a[p] = a[i];
    a[i] = tmp;
    i = p;
  }
};
MinHeap.prototype.pop = function () {
  const a = this._a;
  const top = a[0];
  const last = a.pop();
  if (a.length > 0) {
    a[0] = last;
    let i = 0;
    const n = a.length;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const l = 2 * i + 1;
      const r = 2 * i + 2;
      let s = i;
      if (l < n && a[l].key < a[s].key) s = l;
      if (r < n && a[r].key < a[s].key) s = r;
      if (s === i) break;
      const tmp = a[s];
      a[s] = a[i];
      a[i] = tmp;
      i = s;
    }
  }
  return top;
};

// ─── computeDistance (メイン) ────────────────────────────────
// samples: [{lat,lng,t,acc,spd}]  (t = epoch ms, spd = m/s or 無し)
// decoder: RoadDecoder インスタンス (buildOffsetTable 済)
// opts:
//   speedProvider, snapMaxDistM, stationarySpdMps, routingMaxRatio,
//   routingMaxStraightM, perSegmentMaxM, ... (DEFAULTS 参照)
//   enableRouting: false で routing 無効 (= 別道路は常に直線)。既定 true。
// 戻り値: {
//   distance_m,            // ★道路 snap 道なり累積 (= 課金/業務距離の意味論)
//   breakdown: { sameRoadM, routedM, straightFallbackM, dopplerM, stationarySkipped },
//   stats: { points, snapHit, snapMiss, sameRoadSegs, routedSegs, straightSegs,
//            dopplerSegs, routingFallbacks }
// }
function computeDistance(samples, decoder, opts) {
  opts = opts || {};
  const cfg = {};
  for (const k in DEFAULTS) cfg[k] = opts[k] != null ? opts[k] : DEFAULTS[k];
  const speedProvider =
    typeof opts.speedProvider === 'function' ? opts.speedProvider : gpsSpeedProvider;
  const enableRouting = opts.enableRouting !== false;

  const router = enableRouting ? new RoadGraphRouter(decoder, cfg) : null;

  // 入力整形: lat/lng 数値のみ・t 昇順
  const pts = [];
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i];
    if (!s || typeof s.lat !== 'number' || typeof s.lng !== 'number') continue;
    pts.push(s);
  }
  pts.sort(function (a, b) {
    return (a.t || 0) - (b.t || 0);
  });

  let distance_m = 0;
  const bd = { sameRoadM: 0, routedM: 0, straightFallbackM: 0, dopplerM: 0, stationarySkipped: 0 };
  const stats = {
    points: pts.length,
    snapHit: 0,
    snapMiss: 0,
    sameRoadSegs: 0,
    routedSegs: 0,
    straightSegs: 0,
    dopplerSegs: 0,
    routingFallbacks: 0,
  };

  let prev = null; // 直前 sample
  let prevSnap = null; // 直前 snap 結果 (null = snap 失敗)

  for (let p = 0; p < pts.length; p++) {
    const cur = pts[p];
    const snap = decoder.snapToNearestRoad(cur.lat, cur.lng, { maxDistM: cfg.snapMaxDistM });
    if (snap) stats.snapHit++;
    else stats.snapMiss++;

    if (prev) {
      // ── 静止判定 (ZUPT) ──
      const spd = speedProvider(cur, prev);
      const disp = haversineM(prev.lat, prev.lng, cur.lat, cur.lng);
      let stationary = false;
      if (spd >= 0) {
        // (1) 速度源が静止を示す → 加算 0
        if (spd < cfg.stationarySpdMps) stationary = true;
      } else {
        // (2) ★spd 不明 (-1)★: 変位 / accuracy ベース fallback で停車ジッタを弾く。
        //     spd-optional 運用や spd 欠落フレーム・spd 非対応端末での creep 再発防止。
        if (isStationaryByDisplacement(prev, cur, disp, cfg)) stationary = true;
      }
      if (stationary) {
        bd.stationarySkipped++;
        // 加算せず prev/prevSnap だけ更新
        prev = cur;
        prevSnap = snap;
        continue;
      }

      const added = stepDistance(decoder, router, prev, cur, prevSnap, snap, spd, cfg, bd, stats);
      if (added > 0) distance_m += added;
    }

    prev = cur;
    prevSnap = snap;
  }

  return {
    distance_m: distance_m,
    breakdown: {
      sameRoadM: +bd.sameRoadM.toFixed(2),
      routedM: +bd.routedM.toFixed(2),
      straightFallbackM: +bd.straightFallbackM.toFixed(2),
      dopplerM: +bd.dopplerM.toFixed(2),
      stationarySkipped: bd.stationarySkipped,
    },
    stats: stats,
  };
}

// 1 区間 (prev→cur) の道なり距離を算出して内訳を更新。戻り値 = 加算メートル。
function stepDistance(decoder, router, prev, cur, prevSnap, snap, spd, cfg, bd, stats) {
  const straight = haversineM(prev.lat, prev.lng, cur.lat, cur.lng);

  // ── 両端 snap 成功 ──
  if (prevSnap && snap) {
    const r = decoder.calcRoadDistance(prevSnap, snap);
    if (r && typeof r.distanceM === 'number' && r.distanceM >= 0) {
      // 同一道路 → 弧長をそのまま採用
      if (r.onSameRoad) {
        if (r.distanceM > cfg.perSegmentMaxM) {
          // 異常に長い弧 (snap 誤り) → 直線 fallback
          stats.straightSegs++;
          bd.straightFallbackM += straight;
          return straight;
        }
        stats.sameRoadSegs++;
        bd.sameRoadM += r.distanceM;
        return r.distanceM;
      }

      // ── 別道路 → ★道路網 routing で道なり距離★ ──
      // 遠距離 (gap 等) は routing せず直線
      if (router && straight <= cfg.routingMaxStraightM) {
        const routed = router.routeDistance(prevSnap, snap);
        if (routed != null && routed >= 0) {
          const refStraight = straight > 0.1 ? straight : 0.1;
          if (routed / refStraight <= cfg.routingMaxRatio && routed <= cfg.perSegmentMaxM) {
            stats.routedSegs++;
            bd.routedM += routed;
            return routed;
          }
          // 過大 → fallback
          stats.routingFallbacks++;
        }
      }
      // routing 不能/過大 → calcRoadDistance の直線値 (= snap 間直線) を採用
      stats.straightSegs++;
      let sLine = r.distanceM; // 別道路時は haversine(snapA,snapB)
      if (sLine > cfg.perSegmentMaxM) sLine = straight;
      bd.straightFallbackM += sLine;
      return sLine;
    }
  }

  // ── どちらか snap 失敗 → Doppler 速度積分で補間 ──
  if (spd >= 0) {
    const dtSec = ((cur.t || 0) - (prev.t || 0)) / 1000;
    if (dtSec > 0 && dtSec < 120) {
      const dop = spd * dtSec;
      // 過大ガード: Doppler 値が直線距離の routingMaxRatio 倍超なら直線
      if (straight > 0.1 && dop / straight > cfg.routingMaxRatio) {
        stats.straightSegs++;
        bd.straightFallbackM += straight;
        return straight;
      }
      stats.dopplerSegs++;
      bd.dopplerM += dop;
      return dop;
    }
  }

  // ── 最終 fallback: 直線 ──
  stats.straightSegs++;
  bd.straightFallbackM += straight;
  return straight;
}

// ─── exports (Node tests = module.exports / browser = グローバル公開) ───
(function (root) {
  const api = {
    computeDistance: computeDistance,
    RoadGraphRouter: RoadGraphRouter,
    gpsSpeedProvider: gpsSpeedProvider,
    haversineM: haversineM,
    DEFAULTS: DEFAULTS,
  };
  // eslint-disable-next-line no-undef
  if (typeof module !== 'undefined' && module.exports) {
    // eslint-disable-next-line no-undef
    module.exports = api;
  } else if (root) {
    root.PipelineDistance = api;
  }
})(typeof self !== 'undefined' ? self : typeof globalThis !== 'undefined' ? globalThis : this);
