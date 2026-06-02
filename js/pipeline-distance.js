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
  // ★交差点接続率★ 道路頂点を node 化する際の量子化。
  //   precision=1e5 だと 1 単位 = lat≈1.11m / lng≈0.92m → round(lat*1e5) は no-op で
  //   完全一致頂点しか交差点接続できず別道路 route 失効 (= 直線 fb 増・距離欠損)。
  //   33333 だと bucket = lat≈3.3m / lng≈2.8m。OSM 交差点の頂点は通常同一座標だが、
  //   分割道路 (車線分離・端点ズレ) を ~3m 許容でクラスタ化し接続率を上げる。
  nodeQuantize: 33333,
  perSegmentMaxM: 2000, // 1 区間でこの距離超は異常として直線 fallback
  routingMaxStraightM: 600, // 直線距離がこれ超の別道路区間は routing せず直線 (遠距離=gap)

  // ★spd 不明 (-1) 時の変位ベース静止 fallback (creep 防止)★
  // 停車中の phone は accuracy 規模のジッタを出す。連続 2 点の独立誤差合成
  //   (= √(accPrev²+accCur²)) の 2σ までを「移動ではなくジッタ」とみなし加算 0。
  stationaryDispMinM: 3.0, // 変位がこれ未満なら spd 不明でも無条件で静止扱い (床値)
  stationaryDispMaxM: 40.0, // accuracy 由来閾値の上限 (acc 巨大時でも過剰緩和しない天井)
  stationaryAccSigma: 2.0, // 変位閾値 = 連続2点 acc を合成した σ × この係数
  stationaryAccM: 30.0, // acc 無し/無効点の既定 accuracy (m)

  // ★Fix④ gap-garbage guard (2026-05-31・★設計変更宣言★・iPhone13 creep+jump 根治・never-over)★
  //   実機 iPhone13: 79 秒の GPS 穴の後、accuracy 1082m のゴミ位置 (実は停止中) へ 470m 飛び、
  //   さらにそのゴミ点から実道路へ戻る 798m の弦が出る。穴中は spd 不明 (-1) で coast/straight が
  //   この弦を加算 → ★停止/ゴミ位置由来の 470m creep + 798m jump (過大課金)★。
  //   対策: 区間の ★どちらかの端点★ の accuracy がゴミ (> gapGuardAccM) なら、その位置は信用
  //   できず ★距離を作らない★ (return 0)。入口/出口 両方向のゴミ弦を遮断する。
  //   never-over 専用 (距離を増やさない方向のみ)。良精度の穴脱出 (トンネル等) は従来通り加算。
  //   実機調査: Android(maxAcc 10m)/SE(maxAcc 30m) は acc>gapGuardAccM 点が ★ゼロ★ → 両端末
  //   完全不変。発火は iPhone13 のゴミ点に接する 2 区間のみ。
  gapGuardAccM: 100, // 端点 accuracy がこれ超 = ゴミ位置 → 弦を加算しない (移動上限 acc 35m の十分上)
  // ★Fix④ parked-gap guard (2026-05-31・iPhone13 creep 根治・never-over)★:
  //   長い GPS 穴 (dt > gapStationarySec) を ★停止状態で入った★ (穴入口点 prev.spd が
  //   停止 < stationarySpdMps) 場合、穴中の位置ドリフトは「駐車中の GPS drift」であり実走行では
  //   ないので ★距離を加算しない★。実機 iPhone13: 停止中 (spd≈0.04) に入った 112s/144s の穴で
  //   58m/42m の drift が stationaryDispMaxM(40m) 天井を超え creep 計上されていた事象を遮断。
  //   Android/SE は「停止で入る 30s 超の穴」が ★ゼロ★ → 完全不変。
  //   never-over 専用。穴を ★走行中★ (prev.spd >= stationarySpdMps) に入った場合は対象外
  //   (= トンネル等の実走行穴は従来の coast/routing で正常加算・不変)。
  gapStationarySec: 30, // この秒超の穴を「長い穴」とする (通常 1Hz・短欠落は対象外)
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

// ★L2 連結性ハード拘束ヘルパ (decoder 直叩き版)★:
//   (lat,lng) を ★指定 roadIndex の道路ポリライン★ にだけ投影し snap 結果を返す (or null)。
//   別道路への偽遷移 (flip) を棄却するため「現点を前点の道路に投影し直すと maxDistM 内に乗るか」
//   を判定する。乗れば「実際は同一道路の連続走行・snap が隣道へ flip しただけ」= 道なり弧長で算出。
//   投影式は decoder._searchSnap / SnapCache.snap と byte 等価。snapper 有無に依らず使える。
function snapPointToRoad(decoder, lat, lng, roadIndex, maxDistM) {
  const road = decoder.decodeRoadAt(roadIndex);
  if (!road || !road.points || road.points.length < 2) return null;
  const prec = decoder.precision || 1e5;
  const mpd = metersPerDegree(lat);
  const mpdLat = mpd.lat;
  const mpdLng = mpd.lng;
  const maxSq = maxDistM * maxDistM;
  const pts = road.points;
  let bestSq = Infinity;
  let bSeg = -1,
    bT = 0,
    bLat = 0,
    bLng = 0;
  for (let j = 0; j < pts.length - 1; j++) {
    const aLat = pts[j][0] / prec;
    const aLng = pts[j][1] / prec;
    const bLatp = pts[j + 1][0] / prec;
    const bLngp = pts[j + 1][1] / prec;
    const ax = (aLng - lng) * mpdLng;
    const ay = (aLat - lat) * mpdLat;
    const bx = (bLngp - lng) * mpdLng;
    const by = (bLatp - lat) * mpdLat;
    const abx = bx - ax;
    const aby = by - ay;
    const ab2 = abx * abx + aby * aby;
    let t;
    if (ab2 < 1e-9) t = 0;
    else {
      t = (-ax * abx + -ay * aby) / ab2;
      if (t < 0) t = 0;
      else if (t > 1) t = 1;
    }
    const sx = ax + t * abx;
    const sy = ay + t * aby;
    const dsq = sx * sx + sy * sy;
    if (dsq < bestSq) {
      bestSq = dsq;
      bSeg = j;
      bT = t;
      bLat = aLat + t * (bLatp - aLat);
      bLng = aLng + t * (bLngp - aLng);
    }
  }
  if (bSeg < 0 || bestSq > maxSq) return null;
  return {
    roadIndex: roadIndex,
    segmentIndex: bSeg,
    t: bT,
    snapLat: bLat,
    snapLng: bLng,
    distanceM: Math.sqrt(bestSq),
    typeCode: road.typeCode,
  };
}

// 緯度経度差をメートル換算する係数 (decoder._searchSnap と同一式・平面近似)
function metersPerDegree(refLat) {
  const toRad = Math.PI / 180;
  return {
    lat: 111132.954 - 559.822 * Math.cos(2 * refLat * toRad) + 1.175 * Math.cos(4 * refLat * toRad),
    lng: 111319.488 * Math.cos(refLat * toRad),
  };
}

// ─── SnapCache (★性能★ snap候補キャッシュ + grid展開snap) ─────────────────
// 監査官 major #1「routing ~5ms/点」の真因は計測の結果 snapToNearestRoad だった
//   (snap-only で seg1 の ~96% 時間)。decoder.snapToNearestRoad は radiusGrids=5→9 の
//   フォールバックで毎回 121〜361 グリッドの全道路を decode + 全 segment 投影する。
//   seg1 1582 点は実測 7 グリッドセルにしか入らず、cell 単位 decode は完全に冗長。
//
// 本クラスは decoder を一切改変せず、以下で同一 snap 結果を再現しつつ高速化する:
//   (1) cell 単位 decode キャッシュ … grid セル "gy_gx" → decode 済み road 配列を 1 回だけ。
//   (2) 展開リング探索 … 中心セルから外側へ 1 リングずつ走査し、maxDistM 以内の snap を
//       見つけたら「+1 リング(境界の取りこぼし防止)」で停止。decoder の固定 r=5→9 全走査と
//       異なり、近傍で当たれば数セルで確定。roads は通過全グリッドに登録されているため
//       (実データで radiusGrids=1 が default と完全一致を確認済) リング展開で同一結果。
//   投影式・t クランプ・距離判定は decoder._searchSnap と byte 等価 (実 trace で
//   1582/1582 一致を確認済)。distance_m 意味論は不変。
//
// fallbackMaxRing: maxDistM 以内が見つからない真の miss 時の探索上限。
//   decoder は r=9 まで広げるので既定 9。
function SnapCache(decoder, opts) {
  this.decoder = decoder;
  this.precision = decoder.precision || 1e5;
  this.gridSize = decoder.gridSize || 1000;
  this.maxDistM = opts && opts.snapMaxDistM != null ? opts.snapMaxDistM : DEFAULTS.snapMaxDistM;
  this.fallbackMaxRing = opts && opts.snapFallbackMaxRing != null ? opts.snapFallbackMaxRing : 9; // decoder の 2 段目フォールバック (radiusGrids=9) 相当
  this._cellCache = new Map(); // "gy_gx" -> [road(+_idx), ...] | null (空セル)
}

// grid セルの road 配列を decode (キャッシュ)。空セルは null をキャッシュし再 decode しない。
SnapCache.prototype._roadsInCell = function (gy, gx) {
  const k = gy + '_' + gx;
  const c = this._cellCache.get(k);
  if (c !== undefined) return c;
  const ids = this.decoder.grid[k];
  let arr = null;
  if (ids && ids.length) {
    arr = [];
    for (let i = 0; i < ids.length; i++) {
      const r = this.decoder.decodeRoadAt(ids[i]);
      if (r) {
        r._idx = ids[i];
        arr.push(r);
      }
    }
  }
  this._cellCache.set(k, arr);
  return arr;
};

// (lat,lng) を最寄り道路に snap。戻り値は decoder.snapToNearestRoad と同一形 or null。
SnapCache.prototype.snap = function (lat, lng) {
  const prec = this.precision;
  const gs = this.gridSize;
  const maxDistM = this.maxDistM;
  const mpd = metersPerDegree(lat);
  const mpdLat = mpd.lat;
  const mpdLng = mpd.lng;
  const li = Math.round(lat * prec);
  const gi = Math.round(lng * prec);
  const gy = Math.floor(li / gs);
  const gx = Math.floor(gi / gs);
  const maxSq = maxDistM * maxDistM;

  let bestSq = Infinity;
  let bRI = -1,
    bSeg = -1,
    bT = 0,
    bLat = 0,
    bLng = 0,
    bType = -1;
  const seen = {};
  let hitRing = -1;

  for (let ring = 0; ring <= this.fallbackMaxRing; ring++) {
    for (let dy = -ring; dy <= ring; dy++) {
      const onYEdge = dy === -ring || dy === ring;
      for (let dx = -ring; dx <= ring; dx++) {
        if (!onYEdge && dx !== -ring && dx !== ring) continue; // 周縁リングのみ
        const roads = this._roadsInCell(gy + dy, gx + dx);
        if (!roads) continue;
        for (let ri = 0; ri < roads.length; ri++) {
          const road = roads[ri];
          if (seen[road._idx]) continue;
          seen[road._idx] = 1;
          const pts = road.points;
          for (let j = 0; j < pts.length - 1; j++) {
            const aLat = pts[j][0] / prec;
            const aLng = pts[j][1] / prec;
            const bLatp = pts[j + 1][0] / prec;
            const bLngp = pts[j + 1][1] / prec;
            const ax = (aLng - lng) * mpdLng;
            const ay = (aLat - lat) * mpdLat;
            const bx = (bLngp - lng) * mpdLng;
            const by = (bLatp - lat) * mpdLat;
            const abx = bx - ax;
            const aby = by - ay;
            const ab2 = abx * abx + aby * aby;
            let t;
            if (ab2 < 1e-9) t = 0;
            else {
              t = (-ax * abx + -ay * aby) / ab2;
              if (t < 0) t = 0;
              else if (t > 1) t = 1;
            }
            const sx = ax + t * abx;
            const sy = ay + t * aby;
            const dsq = sx * sx + sy * sy;
            if (dsq < bestSq) {
              bestSq = dsq;
              bRI = road._idx;
              bSeg = j;
              bT = t;
              bLat = aLat + t * (bLatp - aLat);
              bLng = aLng + t * (bLngp - aLng);
              bType = road.typeCode;
            }
          }
        }
      }
    }
    // maxDist 以内に当たったら +1 リングで境界取りこぼし防止して停止
    if (bRI >= 0 && bestSq <= maxSq && hitRing < 0) hitRing = ring;
    if (hitRing >= 0 && ring >= hitRing + 1) break;
  }

  if (bRI < 0 || bestSq > maxSq) return null;
  return {
    roadIndex: bRI,
    segmentIndex: bSeg,
    t: bT,
    snapLat: bLat,
    snapLng: bLng,
    distanceM: Math.sqrt(bestSq),
    typeCode: bType,
  };
};

SnapCache.prototype.reset = function () {
  this._cellCache = new Map();
};

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
  this.gridSize = decoder.gridSize || 1000;

  // ★性能★ localグラフのキャッシュ。
  //   別道路 routing は連続区間 (同じ街区) で何度も同じ周辺道路を decode + graph 構築する。
  //   build 範囲を「覆うグリッドセル集合の署名」で正規化しキャッシュ → 連続区間で再利用。
  //   署名 = sorted("gy_gx" 文字列) を結合したキー。
  this._graphCache = new Map(); // sig -> { adj, nodeLatLng, index }
  this._graphCacheCap = this.opts.graphCacheCap || 64; // LRU 風上限 (メモリガード)
}

// ★古スマホ対応 ③ (snap/routing decode 重複排除) は撤回 (2026-05-30):
//   実測ベンチ (tests/bench-oldphone-decode-dedup.js) で ③ON は ★0.91x (10% 遅い)★ と判明。
//   理由: routing は既に _graphCache (署名キーのグラフキャッシュ) を持つため getRoadsNear は
//   キャッシュミス時のみ呼ばれ (= 全点の約 5%)、dedup の decode 節約 < cell 収集オーバーヘッド。
//   距離は bit 一致だが速度が逆効果のため不採用。routing は従来 getRoadsNear 経路のみ。

// 道路頂点 (整数 lat*precision, lng*precision) → node キー
RoadGraphRouter.prototype._nodeKey = function (rawLatInt, rawLngInt) {
  // decoder の precision で実座標化してから quantize で再量子化
  const lat = rawLatInt / this.precision;
  const lng = rawLngInt / this.precision;
  const ql = Math.round(lat * this.quantize);
  const qg = Math.round(lng * this.quantize);
  return ql + '_' + qg;
};

// (lat,lng) が属する decoder グリッドセルキー "gy_gx"
RoadGraphRouter.prototype._cellKey = function (lat, lng) {
  const latInt = Math.round(lat * this.precision);
  const lngInt = Math.round(lng * this.precision);
  const gy = Math.floor(latInt / this.gridSize);
  const gx = Math.floor(lngInt / this.gridSize);
  return gy + '_' + gx;
};

// snapA/snapB を覆う「searchGrids 半径の周辺グリッドセル集合」の正規化署名。
//   両端 + 中点の 3 アンカーそれぞれの ±searchGrids セルを union。
//   連続する別道路区間は同じ街区 = 同じセル集合 → 同一署名でキャッシュ命中。
RoadGraphRouter.prototype._coverSignature = function (snapA, snapB) {
  const r = this.searchGrids;
  const anchors = [
    [snapA.snapLat, snapA.snapLng],
    [snapB.snapLat, snapB.snapLng],
    [(snapA.snapLat + snapB.snapLat) / 2, (snapA.snapLng + snapB.snapLng) / 2],
  ];
  const cells = {};
  for (let a = 0; a < anchors.length; a++) {
    const latInt = Math.round(anchors[a][0] * this.precision);
    const lngInt = Math.round(anchors[a][1] * this.precision);
    const gy = Math.floor(latInt / this.gridSize);
    const gx = Math.floor(lngInt / this.gridSize);
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        cells[gy + dy + '_' + (gx + dx)] = 1;
      }
    }
  }
  const keys = Object.keys(cells);
  keys.sort();
  return keys.join('|');
};

// 署名で指定された周辺道路から隣接グラフを構築 (+ 最寄り node 用 grid 空間索引)。
// 戻り値: { adj, nodeLatLng, index } ※ index は _nearestNode 用 grid bucket
RoadGraphRouter.prototype._buildLocalGraph = function (snapA, snapB) {
  const sig = this._coverSignature(snapA, snapB);
  const cached = this._graphCache.get(sig);
  if (cached) {
    // LRU 風: 参照されたら末尾へ (Map は挿入順保持)
    this._graphCache.delete(sig);
    this._graphCache.set(sig, cached);
    return cached;
  }

  const dec = this.decoder;
  const precision = this.precision;
  const midLat = (snapA.snapLat + snapB.snapLat) / 2;
  const midLng = (snapA.snapLng + snapB.snapLng) / 2;

  // 中点周辺 + 両端周辺の道路を集める (重複は始点座標 + 点数キーで排除)
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
  // ★along-edge 端tail 用★: 量子化 nodeKey → その node を畳んだ ★丸め前★ polyline 頂点の
  //   生整数座標 [latInt, lngInt]。端tail は snap 点 (roadIndex/segmentIndex/t 保持) から
  //   Dijkstra 端 node に対応する ★実 polyline 頂点★ まで沿弧長を辿る際、量子化 nodeLatLng
  //   ではなく この生頂点座標を終点に使うことで +3.2m/区間 の斜め水増しを除去する。
  //   (nodeKey 経由でなく生整数座標 == で頂点照合する設計・量子化 seam を残さない)
  const nodeRaw = new Map();
  const self = this;

  function regRaw(k, latInt, lngInt) {
    if (!nodeRaw.has(k)) nodeRaw.set(k, [latInt, lngInt]);
  }

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
      // 丸め前の生整数頂点座標を nodeKey に逆引き登録 (端tail の沿弧終点照合用)
      regRaw(ka, pts[j][0], pts[j][1]);
      regRaw(kb, pts[j + 1][0], pts[j + 1][1]);
      if (ka === kb) continue;
      const w = haversineM(aLat, aLng, bLat, bLng);
      addEdge(ka, aLat, aLng, kb, bLat, bLng, w);
    }
  }

  // ★性能★ _nearestNode 用 grid 空間索引を構築 (線形走査の排除)。
  //   node を nodeQuantize と同じ粗さの bucket でハッシュ → 近傍 bucket のみ走査。
  const index = this._buildNodeIndex(nodeLatLng);

  const graph = { adj: adj, nodeLatLng: nodeLatLng, index: index, nodeRaw: nodeRaw };
  // キャッシュ格納 (LRU 風 eviction)
  this._graphCache.set(sig, graph);
  if (this._graphCache.size > this._graphCacheCap) {
    const oldest = this._graphCache.keys().next().value;
    this._graphCache.delete(oldest);
  }
  return graph;
};

// nodeLatLng から grid 空間索引を構築。bucket = floor(coord * quantize)。
// 戻り値: { buckets: Map("by_bx" -> [key,...]), q: quantize }
RoadGraphRouter.prototype._buildNodeIndex = function (nodeLatLng) {
  const q = this.quantize;
  const buckets = new Map();
  nodeLatLng.forEach(function (ll, key) {
    const by = Math.floor(ll[0] * q);
    const bx = Math.floor(ll[1] * q);
    const bk = by + '_' + bx;
    let arr = buckets.get(bk);
    if (!arr) {
      arr = [];
      buckets.set(bk, arr);
    }
    arr.push(key);
  });
  return { buckets: buckets, q: q };
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

  // ★★ start node == goal node (core==0): 両 snap が ★同一 network node★ に落ちる ★★
  //   この時 network 上に 2 snap 間の interior は無い (両 snap は 1 つの node に co-located)。
  //   従来は core(0) + tailA + tailB を返していたが、tailA/tailB は ★どちらも同じ node へ★
  //   向かう along-edge 残弧であり、これを ★足す★ と「snap→node→snap」と node まで往復して
  //   戻る経路を測ってしまう (実測: chord11.5m の区間で tailA64+tailB75.4=139.5m の phantom)。
  //   = +647m/110区間 の過大課金源 (C 診断の端tail net-zero とは別の・真の支配源)。
  //   正しい純幾何 = 2 snap 間の ★直接★ 距離:
  //     ・同一 roadIndex → その polyline を snapA→snapB へ沿った along-edge 弧長 (往復しない)。
  //     ・別 roadIndex (OSM way 分割で同一 node 共有) → polyline を共有しないため snap 間
  //       haversine (= calcRoadDistance のクロス道路 distanceM と同義・<50m で弧≒弦)。
  //   ★クランプ/補正係数/min(projected,direct) 一切なし・往復誤算を除いた直接幾何のみ★。
  if (startKey === goalKey) {
    const direct = this._alongEdgeDirect(snapA, snapB);
    return direct != null
      ? direct
      : haversineM(snapA.snapLat, snapA.snapLng, snapB.snapLat, snapB.snapLng);
  }

  // start != goal: network interior (core) が存在。snap 点 → 各端 node までの端数 (両端) を加算。
  // ★along-edge★: 従来は snap 点 → 量子化頂点(nodeLatLng) への斜め haversine 直線で
  //   +3.2m/区間 を水増ししていた。これを「snap が乗る ★その road の polyline★ を
  //   snap 点 (segmentIndex,t) から Dijkstra 端 node に対応する実頂点まで沿った残弧長」へ置換。
  //   端 node の実頂点座標は graph.nodeRaw[key] (丸め前生整数) を使い量子化 seam を残さない。
  //   snap road 上に該当頂点が無い (OSM way 分割等) 場合のみ従来 haversine fallback。
  //   ★純幾何のみ・クランプ/補正係数/min(projected,direct) 一切なし★。
  const sNode = graph.nodeLatLng.get(startKey);
  const gNode = graph.nodeLatLng.get(goalKey);
  const tailA = this._alongEdgeTail(snapA, graph.nodeRaw.get(startKey), sNode);
  const tailB = this._alongEdgeTail(snapB, graph.nodeRaw.get(goalKey), gNode);
  return core + tailA + tailB;
};

// 2 snap が同一 network node に落ちる時 (core==0) の・2 snap 間 ★直接★ 距離 (純幾何)。
//   ・同一 roadIndex: その polyline を snapA(seg,t)→snapB(seg,t) へ沿った along-edge 弧長。
//     (snapA→snapB の前方/後方を seg/t で判定し往復せず一方向に累積)
//   ・別 roadIndex: polyline を共有しないため null を返し呼び出し側で snap 間 haversine に退避。
//   クランプ・補正係数・死にコード無し。
RoadGraphRouter.prototype._alongEdgeDirect = function (snapA, snapB) {
  if (snapA.roadIndex !== snapB.roadIndex) return null;
  const road = this.decoder.decodeRoadAt(snapA.roadIndex);
  if (!road || !road.points || road.points.length < 2) return null;
  const pts = road.points;
  const prec = this.precision;
  // 同一 polyline 上の 2 点 (segA,tA) (segB,tB) 間の沿弧長。前後関係を正規化して一方向累積。
  let segA = snapA.segmentIndex,
    tA = snapA.t,
    segB = snapB.segmentIndex,
    tB = snapB.t;
  if (segB < segA || (segB === segA && tB < tA)) {
    const swSeg = segA;
    segA = segB;
    segB = swSeg;
    const swT = tA;
    tA = tB;
    tB = swT;
  }
  if (segA === segB) {
    // 同一 segment 内: 弧長 × |tB − tA|
    return this._segArc(pts, segA, prec) * (tB - tA);
  }
  // segA 内の残り (1−tA) + 中間 segment 群 + segB 内の先頭 tB。
  let arc = this._segArc(pts, segA, prec) * (1 - tA);
  for (let k = segA + 1; k < segB; k++) {
    arc += this._segArc(pts, k, prec);
  }
  arc += this._segArc(pts, segB, prec) * tB;
  return arc;
};

// snap 点 (roadIndex/segmentIndex/t 保持) から、量子化端 node に対応する
// ★実 polyline 頂点 (rawTarget = [latInt, lngInt] 丸め前)★ まで、snap road の
// polyline 沿いに辿った残弧長 (along-edge) を返す。
//   rawTarget が snap road の polyline 頂点に整数座標一致しない場合は
//   従来通り snap 点 → 量子化頂点 (fallbackNode) の haversine 直線を返す (安全 fallback)。
// 純幾何のみ。クランプ・補正係数・死にコード無し。
RoadGraphRouter.prototype._alongEdgeTail = function (snap, rawTarget, fallbackNode) {
  if (!rawTarget) {
    return haversineM(snap.snapLat, snap.snapLng, fallbackNode[0], fallbackNode[1]);
  }
  const road = this.decoder.decodeRoadAt(snap.roadIndex);
  if (!road || !road.points || road.points.length < 2) {
    return haversineM(snap.snapLat, snap.snapLng, fallbackNode[0], fallbackNode[1]);
  }
  const pts = road.points;
  const prec = this.precision;
  // rawTarget (丸め前生整数座標) と一致する polyline 頂点 index を探す (整数 == 照合)。
  let vIdx = -1;
  for (let k = 0; k < pts.length; k++) {
    if (pts[k][0] === rawTarget[0] && pts[k][1] === rawTarget[1]) {
      vIdx = k;
      break;
    }
  }
  if (vIdx < 0) {
    // この road の頂点ではない (別 road が同一量子化 node を共有 = way 分割等) → fallback
    return haversineM(snap.snapLat, snap.snapLng, fallbackNode[0], fallbackNode[1]);
  }
  const seg = snap.segmentIndex;
  // snap 点は segment seg (頂点 seg → seg+1) 上の t 比率位置。
  // 終点頂点 vIdx までの polyline 沿い残弧長を累積する。
  if (vIdx <= seg) {
    // 終点は snap 点の「手前側」(seg 始点 vIdx 方向)。
    //   snap 点 → 頂点 seg まで (= seg 始点まで戻る残弧) を t で按分し、
    //   その先 seg → seg-1 → ... → vIdx を頂点間弧長で累積。
    let arc = 0;
    // snap 点 → seg 始点 (頂点 seg)
    arc += this._segArc(pts, seg, prec) * snap.t;
    for (let k = seg; k > vIdx; k--) {
      arc += this._segArc(pts, k - 1, prec);
    }
    return arc;
  }
  // vIdx >= seg+1: 終点は snap 点の「先側」(seg+1 以降)。
  //   snap 点 → 頂点 seg+1 まで (= (1-t) 残弧)、その先 seg+1 → ... → vIdx を累積。
  let arc = this._segArc(pts, seg, prec) * (1 - snap.t);
  for (let k = seg + 1; k < vIdx; k++) {
    arc += this._segArc(pts, k, prec);
  }
  return arc;
};

// polyline 頂点 i → i+1 の弧長 (m)。生整数座標 / precision → haversine。
RoadGraphRouter.prototype._segArc = function (pts, i, prec) {
  const aLat = pts[i][0] / prec;
  const aLng = pts[i][1] / prec;
  const bLat = pts[i + 1][0] / prec;
  const bLng = pts[i + 1][1] / prec;
  return haversineM(aLat, aLng, bLat, bLng);
};

// graph 内で (lat,lng) に最も近い node キー。
// ★性能★ grid 空間索引で中心 bucket から外側へリング展開し、最初にヒットした
//   リング + 安全のため 1 リング外側まで走査して最近接を確定 (線形全走査を排除)。
RoadGraphRouter.prototype._nearestNode = function (graph, lat, lng) {
  const index = graph.index;
  if (!index || index.buckets.size === 0) {
    // 索引が無い場合の保険 (線形 fallback)
    return this._nearestNodeLinear(graph, lat, lng);
  }
  const q = index.q;
  const buckets = index.buckets;
  const cy = Math.floor(lat * q);
  const cx = Math.floor(lng * q);
  const nodeLatLng = graph.nodeLatLng;

  let best = null;
  let bestD = Infinity;
  let foundRing = -1;
  // bucket 1 個 ≈ 1/q 度。グラフ規模は小さいので妥当な上限まで展開。
  const MAX_RING = 64;

  for (let ring = 0; ring <= MAX_RING; ring++) {
    // この ring の周縁 bucket だけ走査 (内側は既走査)
    let scannedAny = false;
    for (let dy = -ring; dy <= ring; dy++) {
      const onYEdge = dy === -ring || dy === ring;
      for (let dx = -ring; dx <= ring; dx++) {
        if (!onYEdge && dx !== -ring && dx !== ring) continue; // 周縁のみ
        const arr = buckets.get(cy + dy + '_' + (cx + dx));
        if (!arr) continue;
        scannedAny = true;
        for (let i = 0; i < arr.length; i++) {
          const ll = nodeLatLng.get(arr[i]);
          const ex = ll[0] - lat;
          const ey = ll[1] - lng;
          const d = ex * ex + ey * ey;
          if (d < bestD) {
            bestD = d;
            best = arr[i];
          }
        }
      }
    }
    // ヒットした最初のリングを記録し、1 リング外まで見て確定 (bucket 境界の取りこぼし防止)
    if (best && foundRing < 0) foundRing = ring;
    if (foundRing >= 0 && ring >= foundRing + 1) break;
    void scannedAny;
  }
  return best;
};

// 索引なし時の線形 fallback (保険・通常経路では使わない)
RoadGraphRouter.prototype._nearestNodeLinear = function (graph, lat, lng) {
  let best = null;
  let bestD = Infinity;
  graph.nodeLatLng.forEach(function (ll, key) {
    const dx = ll[0] - lat;
    const dy = ll[1] - lng;
    const d = dx * dx + dy * dy;
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
// ★④ batch 内部処理を sync / async で共有する setup ヘルパ。
//   ★sync computeDistance と computeDistanceAsync で ★完全に同一の処理ロジック★ を用いる
//     (= yield 挿入位置以外は 1 byte も差が出ない)。距離は累積和で yield 可換。
function _prepareBatch(samples, decoder, opts) {
  opts = opts || {};
  const cfg = {};
  for (const k in DEFAULTS) cfg[k] = opts[k] != null ? opts[k] : DEFAULTS[k];
  const speedProvider =
    typeof opts.speedProvider === 'function' ? opts.speedProvider : gpsSpeedProvider;
  const enableRouting = opts.enableRouting !== false;

  const router = enableRouting ? new RoadGraphRouter(decoder, cfg) : null;
  // ★性能★ snap候補キャッシュ (opts.useSnapCache=false で decoder 直叩きに戻せる)。
  const snapper = opts.useSnapCache === false ? null : new SnapCache(decoder, cfg);

  // 入力整形: lat/lng 有限数値のみ・t 昇順
  // ★NaN/Infinity 防御★: typeof==='number' は NaN/Infinity を通すため Number.isFinite で弾く。
  //   NaN 座標が straightFallbackM 等を汚染し breakdown を {…:null} 化するのを防止。
  const pts = [];
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i];
    if (!s || !Number.isFinite(s.lat) || !Number.isFinite(s.lng)) continue;
    pts.push(s);
  }
  pts.sort(function (a, b) {
    return (a.t || 0) - (b.t || 0);
  });

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

  // 区間処理の単一実装 (sync/async 共有)。state = {distance_m, prev, prevSnap} を破壊的に更新。
  function processPoint(state, cur) {
    const snap = snapper
      ? snapper.snap(cur.lat, cur.lng)
      : decoder.snapToNearestRoad(cur.lat, cur.lng, { maxDistM: cfg.snapMaxDistM });
    if (snap) stats.snapHit++;
    else stats.snapMiss++;

    if (state.prev) {
      // ── 静止判定 (ZUPT) ──
      const spd = speedProvider(cur, state.prev);
      const disp = haversineM(state.prev.lat, state.prev.lng, cur.lat, cur.lng);
      let stationary = false;
      if (spd >= 0) {
        // (1) 速度源が静止を示す → 加算 0
        if (spd < cfg.stationarySpdMps) stationary = true;
      } else {
        // (2) ★spd 不明 (-1)★: 変位 / accuracy ベース fallback で停車ジッタを弾く。
        //     spd-optional 運用や spd 欠落フレーム・spd 非対応端末での creep 再発防止。
        if (isStationaryByDisplacement(state.prev, cur, disp, cfg)) stationary = true;
      }
      if (stationary) {
        bd.stationarySkipped++;
        // 加算せず prev/prevSnap だけ更新
        state.prev = cur;
        state.prevSnap = snap;
        return;
      }

      const added = stepDistance(
        decoder,
        router,
        state.prev,
        cur,
        state.prevSnap,
        snap,
        spd,
        cfg,
        bd,
        stats,
        -1 // batch (computeDistance) は coast 状態を持たない → 従来 (haversine) 挙動を維持
      );
      if (added > 0) state.distance_m += added;
    }

    state.prev = cur;
    state.prevSnap = snap;
  }

  return { pts: pts, bd: bd, stats: stats, processPoint: processPoint };
}

function _finishBatch(distance_m, bd, stats) {
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

// ★古スマホ対応 ④ (batch replay の Worker yield 版 computeDistanceAsync) は撤回 (2026-05-30):
//   本番は createDistanceTracker.ingest の逐次計算のみで、batch replay 経路が存在しない
//   (セッション復元は meter.setDistance(=v) で値を直接戻すため再計算しない)。
//   = yield する対象が本番に無いため不採用。batch computeDistance は同期のまま (テスト/検証用)。

function computeDistance(samples, decoder, opts) {
  const prep = _prepareBatch(samples, decoder, opts);
  const state = { distance_m: 0, prev: null, prevSnap: null };
  for (let p = 0; p < prep.pts.length; p++) {
    prep.processPoint(state, prep.pts[p]);
  }
  return _finishBatch(state.distance_m, prep.bd, prep.stats);
}

// 1 区間 (prev→cur) の道なり距離を算出して内訳を更新。戻り値 = 加算メートル。
//   coastSpdMps: 直近 snap 成功点で確立した連続保持速度 (m/s・-1=未確立)。GPS 穴 (snap 失敗連続)
//   中に当該点速度が不明な区間を「等速保持 × dt」で補間する (= coasting・never-over)。
//   batch (computeDistance) は coast 状態を持たないため -1 を渡し従来 (haversine) 挙動を維持する。
function stepDistance(
  decoder,
  router,
  prev,
  cur,
  prevSnap,
  snap,
  spd,
  cfg,
  bd,
  stats,
  coastSpdMps
) {
  const straight = haversineM(prev.lat, prev.lng, cur.lat, cur.lng);
  if (typeof coastSpdMps !== 'number') coastSpdMps = -1;

  // ★Fix④ gap-garbage guard (2026-05-31・iPhone13 creep 根治・never-over)★:
  //   長い GPS 穴 (dtSec > gapGuardSec) の後、到達点の accuracy がゴミ (> gapGuardAccM) なら、
  //   その区間は ★距離を加算しない★ (信用できない位置同士を結んで距離を作らない)。
  //   = iPhone13 の 79s 穴→acc 1082m への 470m creep を遮断。Android/SE は該当点ゼロで不変。
  //   never-over 専用: 距離を増やすことは一切なく、ゴミ穴の過大加算を 0 にするだけ。
  if (cfg.gapGuardAccM != null) {
    const _accCur = typeof cur.acc === 'number' && cur.acc >= 0 ? cur.acc : -1;
    const _accPrev = typeof prev.acc === 'number' && prev.acc >= 0 ? prev.acc : -1;
    // 区間の ★どちらかの端点★ が acc ゴミ (> gapGuardAccM) なら、その位置は信用できず
    //   弦距離を作らない (return 0)。iPhone13: acc1082m へ 470m 飛ぶ区間 (cur ゴミ) と、
    //   その点から実道路へ戻る 798m 区間 (prev ゴミ・dt 2.3s) の ★両方★ を遮断
    //   (= creep 470m + jump 798m を同時根治)。
    //   dt 条件は不要: ゴミ acc 点は dt の長短に依らず位置が信用できないため。
    //   Android(maxAcc 10m)/SE(maxAcc 30m) は acc>100m 点ゼロ → 完全不変 (実機調査済)。
    //   never-over 専用 (距離を作らない方向のみ)。良精度の穴脱出 (トンネル等) は従来通り加算。
    if (_accCur > cfg.gapGuardAccM || _accPrev > cfg.gapGuardAccM) {
      stats.gapGuardSkipped = (stats.gapGuardSkipped || 0) + 1;
      bd.gapGuardSkippedM = (bd.gapGuardSkippedM || 0) + straight;
      return 0;
    }
    // ★parked-gap guard★: 長い穴を ★停止状態で入った★ なら穴中 drift は駐車 drift → 加算しない。
    if (cfg.gapStationarySec != null) {
      const _dt = ((cur.t || 0) - (prev.t || 0)) / 1000;
      const _prevSpd = typeof prev.spd === 'number' ? prev.spd : -1;
      if (_dt > cfg.gapStationarySec && _prevSpd >= 0 && _prevSpd < cfg.stationarySpdMps) {
        stats.gapGuardSkipped = (stats.gapGuardSkipped || 0) + 1;
        bd.gapGuardSkippedM = (bd.gapGuardSkippedM || 0) + straight;
        return 0;
      }
    }
  }

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

      // ── 別道路 → ★L2 連結性ハード拘束 + 道路網 routing で道なり距離★ ──
      // 遠距離 (gap 等) は routing せず後段 (真の gap = 直線/Doppler) に回す。
      if (router && straight <= cfg.routingMaxStraightM) {
        const routed = router.routeDistance(prevSnap, snap);
        if (routed != null && routed >= 0) {
          const refStraight = straight > 0.1 ? straight : 0.1;
          // ★連結性 OK (道路網で繋がっている = 正当な交差点/分岐通過)★ → 道なり routing 距離を採用。
          if (routed / refStraight <= cfg.routingMaxRatio && routed <= cfg.perSegmentMaxM) {
            stats.routedSegs++;
            bd.routedM += routed;
            return routed;
          }
          // routing 過大 (遠回り) → 偽遷移扱いで下の連結性拘束へ落とす。
          stats.routingFallbacks++;
        }
        // ★★ ここに到達 = 道路網 routing 不能 or 過大 = ★偽遷移 (繋がってない道へ flip)★ ★★
        //   司さん核心:「greedy の別道路 flip (余計な弦) が距離を水増し」。
        //   対策 = ★連結性ハード拘束★: flip を ★棄却★ し、現点を ★前点の道路 (prevSnap.roadIndex)★ に
        //   投影し直す。snapMaxDistM 内に乗れば「実際は同一道路の連続走行・snap が隣道/対向へ
        //   flip しただけ」= 道なり弧長 (前道路 polyline 沿い) で算出 → 余計な弦が距離に入らない。
        //   ★距離の小細工はしない (弦補正係数なし)・正しい道路を読み直すだけ★。
        const reSnap = snapPointToRoad(
          decoder,
          cur.lat,
          cur.lng,
          prevSnap.roadIndex,
          cfg.snapMaxDistM
        );
        if (reSnap) {
          const rr = decoder.calcRoadDistance(prevSnap, reSnap);
          if (
            rr &&
            rr.onSameRoad &&
            typeof rr.distanceM === 'number' &&
            rr.distanceM >= 0 &&
            rr.distanceM <= cfg.perSegmentMaxM
          ) {
            stats.sameRoadSegs++;
            stats.flipRejected = (stats.flipRejected || 0) + 1; // 偽遷移棄却カウント (監査用)
            bd.flipRejectedM = (bd.flipRejectedM || 0) + rr.distanceM; // 棄却 flip の補正距離 (監査用)
            bd.sameRoadM += rr.distanceM;
            return rr.distanceM;
          }
        }
      }
      // 連結性拘束でも救えない (= 真に別道路 / 遠距離 gap で前道路へ乗らない) → 直線 fallback。
      stats.straightSegs++;
      let sLine = r.distanceM; // 別道路時は haversine(snapA,snapB)
      if (sLine > cfg.perSegmentMaxM) sLine = straight;
      bd.straightFallbackM += sLine;
      return sLine;
    }
  }

  // ── どちらか snap 失敗 → Doppler 速度積分で補間 ──
  const dtSec = ((cur.t || 0) - (prev.t || 0)) / 1000;
  if (spd >= 0) {
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

  // ── ★coasting★: 当該点速度が不明 (spd<0) かつ 直近 snap 成功点で速度を確立済 (coastSpdMps>=0) ──
  //   GPS 穴 (トンネル/ビル街の snap 失敗連続) 中も「直前の Doppler/GPS 点速度を等速保持 × dt」で
  //   distance_m を前進させる。点速度ベースのため過大バイアスが付かない (Ranacher)。
  //   ★加速度二重積分はしない (発散)・等速保持のみ★。穴脱出 (snap 成功) で実速度に即復帰。
  if (coastSpdMps >= 0 && dtSec > 0 && dtSec < 120) {
    let coast = coastSpdMps * dtSec;
    // ★never-over クランプ (2026-05-31 監査官指摘・課金安全の要)★:
    //   spd 欠落点を過去の保持速度で coast すると、穴中に車が減速した場合 (保持速度 > 実速度) に
    //   実際の変位を超えて過大課金しうる (最大 +44% 実測)。観測された GPS 弦 straight (= 両点間の
    //   実直線変位) を never-over 天井とし、coast がこれを超えないようにする。
    //   straight は path 長の下限だが、過大ゼロ (認定 −4%〜0%) を最優先し実測変位で coast を抑える
    //   (発火は spd 欠落かつ減速の稀ケースのみ・通常は Doppler 点速度で正確)。
    if (straight > 0 && coast > straight) coast = straight;
    // 同じ過大ガード: coast が直線距離の routingMaxRatio 倍超なら直線 (= GPS 復活点との弦の妥当倍率内)。
    if (straight > 0.1 && coast / straight > cfg.routingMaxRatio) {
      stats.straightSegs++;
      bd.straightFallbackM += straight;
      return straight;
    }
    stats.coastSegs = (stats.coastSegs || 0) + 1;
    bd.coastM = (bd.coastM || 0) + coast;
    return coast;
  }

  // ── 最終 fallback: 直線 ──
  stats.straightSegs++;
  bd.straightFallbackM += straight;
  return straight;
}

// ─── createDistanceTracker (★インクリメンタル API・live meter 用★) ──────────
// computeDistance は sample 列バッチだが、live meter は GPS を 1 点ずつ受ける。
// stateful な tracker を返し、ingest(sample) ごとに当該区間の道なり加算を確定する。
//
//   const tk = createDistanceTracker(decoder, opts);
//   tk.ingest({lat,lng,t,acc,spd}) -> { deltaM, totalM, reason }
//   tk.totalM()  -> 現在の累積 distance_m
//   tk.reset()   -> 状態クリア (業務開始/再計測)
//
// ★バッチ一致保証★: 同一 trace を「同じ順序」で 1 点ずつ ingest した totalM() は
//   computeDistance(...).distance_m と一致する。理由:
//     - 区間距離は computeDistance と同一の stepDistance / 静止判定を呼ぶ。
//     - router を共有し localグラフキャッシュも効く。
//   注意: computeDistance は内部で t 昇順 sort する。tracker は live streaming のため
//   全体 sort できない (未来点が未到着)。代わりに ★out-of-order ガード★ で
//   cur.t < prev.t の遅延到着/順序逆転フレームを破棄し (reason:'out_of_order')、
//   computeDistance(sort 済) と同一の単調増加列だけを処理する。これにより
//   遅延到着フレームによる距離水増しを防ぐ。回帰テストは sort 済み列で一致を確認する。
//
// reason 値: 'first' | 'stationary' | 'sameRoad' | 'routed' | 'straight' | 'doppler'
//   | 'skip' (無効点) | 'out_of_order' (t 逆転で破棄)
//   (区間の分類。課金境界差込時のデバッグ/監査用。calcFare は一切呼ばない。)
function createDistanceTracker(decoder, opts) {
  opts = opts || {};
  const cfg = {};
  for (const k in DEFAULTS) cfg[k] = opts[k] != null ? opts[k] : DEFAULTS[k];
  const speedProvider =
    typeof opts.speedProvider === 'function' ? opts.speedProvider : gpsSpeedProvider;
  const enableRouting = opts.enableRouting !== false;
  // ★reset で完全初期化するため let (= 状態漏れ根絶のため新インスタンス再生成可能に)
  let router = enableRouting ? new RoadGraphRouter(decoder, cfg) : null;
  let snapper = opts.useSnapCache === false ? null : new SnapCache(decoder, cfg);

  let total = 0;
  let prev = null;
  let prevSnap = null;
  // ★coasting 速度★ (B): 直近の有効点速度 (m/s・-1=未確立)。GPS 穴中の補間に使う。
  let coastSpdMps = -1;
  // breakdown/stats を区間分類のため保持 (stepDistance が要求する構造)
  let bd, stats;
  function freshAccum() {
    bd = {
      sameRoadM: 0,
      routedM: 0,
      straightFallbackM: 0,
      dopplerM: 0,
      coastM: 0,
      stationarySkipped: 0,
    };
    stats = {
      points: 0,
      snapHit: 0,
      snapMiss: 0,
      sameRoadSegs: 0,
      routedSegs: 0,
      straightSegs: 0,
      dopplerSegs: 0,
      coastSegs: 0,
      routingFallbacks: 0,
    };
  }
  freshAccum();

  function classifyReason(beforeStats) {
    if (stats.sameRoadSegs > beforeStats.sameRoadSegs) return 'sameRoad';
    if (stats.routedSegs > beforeStats.routedSegs) return 'routed';
    if (stats.dopplerSegs > beforeStats.dopplerSegs) return 'doppler';
    if ((stats.coastSegs || 0) > (beforeStats.coastSegs || 0)) return 'coast';
    if (stats.straightSegs > beforeStats.straightSegs) return 'straight';
    return 'straight';
  }

  return {
    ingest: function (sample) {
      if (!sample || !Number.isFinite(sample.lat) || !Number.isFinite(sample.lng)) {
        // 無効点 (null/NaN/Infinity) は computeDistance の入力整形と同様に黙殺 (距離影響なし)
        return { deltaM: 0, totalM: total, reason: 'skip' };
      }
      const cur = sample;
      // ★out-of-order ガード★: computeDistance は t 昇順 sort 済みで処理するが live tracker は
      //   全体 sort できない。遅延到着/順序逆転フレーム (cur.t < prev.t) を破棄し、batch と
      //   同一の単調増加列だけを処理する (距離水増し防止)。t 欠落点は順序判定をスキップ。
      if (prev && Number.isFinite(cur.t) && Number.isFinite(prev.t) && cur.t < prev.t) {
        return { deltaM: 0, totalM: total, reason: 'out_of_order' };
      }
      stats.points++;
      // ★L1 配線 (2026-05-31・clean-rebuild-pipeline・距離源を Viterbi 確定経路へ一本化):
      //   sample.snap が渡された場合 (= Worker B が Viterbi emission/transition で選んだ
      //   bestEmit/outSnap)、その ★Viterbi 確定 snap★ を距離計算に使う。greedy per-point
      //   SnapCache.snap (= 最近傍 nearest-neighbor) は ★呼ばない★。
      //   これにより距離源が「greedy 最近傍 snap」ではなく「HMM の確定 snap」になる (= (c) 配線完全)。
      //   externalSnap が roadIndex/snapLat/snapLng を満たす時のみ採用・不足時のみ従来 snap に退避。
      let snap;
      const ext = sample.snap;
      if (
        ext &&
        Number.isFinite(ext.roadIndex) &&
        Number.isFinite(ext.snapLat) &&
        Number.isFinite(ext.snapLng)
      ) {
        // Viterbi 確定 snap を pipeline の snap 形式へ正規化 (stepDistance/calcRoadDistance が要求する key)。
        snap = {
          roadIndex: ext.roadIndex,
          segmentIndex: ext.segmentIndex,
          t: ext.t,
          snapLat: ext.snapLat,
          snapLng: ext.snapLng,
          distanceM: ext.distanceM,
          typeCode: ext.typeCode,
        };
        stats.viterbiSnaps = (stats.viterbiSnaps || 0) + 1;
      } else {
        snap = snapper
          ? snapper.snap(cur.lat, cur.lng)
          : decoder.snapToNearestRoad(cur.lat, cur.lng, { maxDistM: cfg.snapMaxDistM });
      }
      if (snap) stats.snapHit++;
      else stats.snapMiss++;

      if (!prev) {
        prev = cur;
        prevSnap = snap;
        return { deltaM: 0, totalM: total, reason: 'first' };
      }

      // 静止判定 (ZUPT) — computeDistance と同一ロジック
      const spd = speedProvider(cur, prev);
      const disp = haversineM(prev.lat, prev.lng, cur.lat, cur.lng);
      let stationary = false;
      if (spd >= 0) {
        if (spd < cfg.stationarySpdMps) stationary = true;
      } else {
        if (isStationaryByDisplacement(prev, cur, disp, cfg)) stationary = true;
      }
      if (stationary) {
        bd.stationarySkipped++;
        prev = cur;
        prevSnap = snap;
        return { deltaM: 0, totalM: total, reason: 'stationary' };
      }

      const beforeStats = {
        sameRoadSegs: stats.sameRoadSegs,
        routedSegs: stats.routedSegs,
        straightSegs: stats.straightSegs,
        dopplerSegs: stats.dopplerSegs,
        coastSegs: stats.coastSegs || 0,
      };
      // ★coasting (B)★: この区間は「前点までに確立した coastSpdMps」で補間する。
      //   よって stepDistance には更新前の coastSpdMps を渡す (= 因果順序の保持)。
      const added = stepDistance(
        decoder,
        router,
        prev,
        cur,
        prevSnap,
        snap,
        spd,
        cfg,
        bd,
        stats,
        coastSpdMps
      );
      const delta = added > 0 ? added : 0;
      total += delta;
      const reason = classifyReason(beforeStats);

      // ★coastSpdMps 更新 (B-1 + B-2・never-over)★:
      //   ・当該点速度 (spd) が判明 → coasting 速度を実速度で再確立。ただし ★上方は即時・下方も即時★
      //     とすると穴中の単発 spike で過大化しうるため、減速 (spd < 現 coast) は即反映 (下方更新)、
      //     加速側も実速度を採用 (snap 成功点 = 道路上を読めており速度が信頼できる)。
      //   ・spd 不明 (穴中) → coastSpdMps を僅かに減衰 (0.97)。穴が伸びるほど保守側へ寄せ
      //     never-over を担保 (= 恒久過小係数ではなく穴中の不確かさ処理・snap 復帰で実速度に即解除)。
      if (spd >= 0) {
        if (snap) {
          coastSpdMps = spd; // snap 成功 = 信頼できる点速度で再確立 (上方/下方とも)
        } else if (coastSpdMps < 0 || spd < coastSpdMps) {
          coastSpdMps = spd; // snap 失敗でも減速側は即反映 (過大防止)
        }
      } else if (coastSpdMps >= 0) {
        coastSpdMps = coastSpdMps * 0.97; // 穴中 (spd 不明) は単調減衰で保守側へ
      }

      prev = cur;
      prevSnap = snap;
      return { deltaM: delta, totalM: total, reason: reason };
    },
    totalM: function () {
      return total;
    },
    reset: function () {
      total = 0;
      prev = null;
      prevSnap = null;
      coastSpdMps = -1;
      freshAccum();
      // ★router/snapper を新インスタンスで完全再生成 (= キャッシュ等の内部状態漏れを根絶)。
      //   旧実装はキャッシュ Map のみ差し替えていたが reset 後再 ingest で 10m 級の残留が出たため、
      //   インスタンスごと作り直して trip 単位の完全初期化を保証する。
      router = enableRouting ? new RoadGraphRouter(decoder, cfg) : null;
      snapper = opts.useSnapCache === false ? null : new SnapCache(decoder, cfg);
    },
    // 監査/デバッグ用 (課金には使わない)
    _breakdown: function () {
      return bd;
    },
    _stats: function () {
      return stats;
    },
  };
}

// ─── exports (Node tests = module.exports / browser = グローバル公開) ───
(function (root) {
  const api = {
    computeDistance: computeDistance,
    createDistanceTracker: createDistanceTracker,
    RoadGraphRouter: RoadGraphRouter,
    SnapCache: SnapCache,
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
