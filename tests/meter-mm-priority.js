#!/usr/bin/env node
'use strict';

// tests/meter-mm-priority.js
// 2026-05-09: meter.js の MM 優先 + GPS fallback 設計の振る舞いを検証する
//
// 検証ケース:
//   ケース 1: MM Worker から mmIncrementM>0 が来続ける → distance_m は MM 由来
//   ケース 2: MM 沈黙 5 秒で GPS fallback に切替・distance_m に GPS 直線を加算
//   ケース 3: Worker null (= MM 完全 OFF) → 常に GPS fallback
//   ケース 4: MM 復帰 → distance_m は再び MM 由来
//
// 実装方針:
//   meter.js は globalThis に GPS / dlog 等を要求するため、最小スタブを構築して
//   vm.runInThisContext で読み込み。Meter API を直接叩き、state を inspect する。

const fs = require('fs');
const path = require('path');
const vm = require('vm');

// ─── スタブ環境構築 ─────────────────────────────────────────
const ctx = {
  console: console,
  Date: Date,
  Math: Math,
  Float32Array: Float32Array,
  setInterval: () => null, // タイマー副作用は無視
  clearInterval: () => {},
  performance: { now: () => Date.now() },
  // GPS グローバル: meter.js が calcDistance3D / calcDistance を期待する
  GPS: {
    calcDistance3D: function (lat1, lng1, _alt1, lat2, lng2, _alt2) {
      return haversineM(lat1, lng1, lat2, lng2);
    },
    calcDistance: function (lat1, lng1, lat2, lng2) {
      return haversineM(lat1, lng1, lat2, lng2);
    },
  },
  // RegionLoader は未定義のままにして inline fallback に流れないようにする
  // dlog はデバッグログ抑制
  dlog: function () {},
};
// 自己参照でグローバル化
ctx.window = ctx;
ctx.globalThis = ctx;
ctx.self = ctx;
vm.createContext(ctx);

// ハバーサイン (テスト内で計算検証用)
function haversineM(lat1, lng1, lat2, lng2) {
  if (lat1 === lat2 && lng1 === lng2) return 0;
  const R = 6371000,
    tr = Math.PI / 180;
  const dLat = (lat2 - lat1) * tr;
  const dLng = (lng2 - lng1) * tr;
  const a =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * tr) * Math.cos(lat2 * tr) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
ctx.haversineM = haversineM;
// vm の context 内でも GPS が同じハバーサインを使えるよう注入し直し
ctx.GPS.calcDistance3D = function (lat1, lng1, _alt1, lat2, lng2, _alt2) {
  return haversineM(lat1, lng1, lat2, lng2);
};
ctx.GPS.calcDistance = function (lat1, lng1, lat2, lng2) {
  return haversineM(lat1, lng1, lat2, lng2);
};

// meter.js は `const Meter = (() => {...})();` で宣言するため、
// vm context の globalThis にプロパティとして現れない。末尾に明示的な代入を追加してロード。
const meterSrc =
  fs.readFileSync(path.join(__dirname, '..', 'js', 'meter.js'), 'utf8') +
  '\n;globalThis.Meter = Meter;\n';
vm.runInContext(meterSrc, ctx, { filename: 'js/meter.js' });
const Meter = ctx.Meter;
if (!Meter) {
  console.error('[meter-test] failed to load Meter');
  process.exit(2);
}

// ─── ヘルパー: 最低限の Worker モック ─────────────────────────
// addEventListener('message', handler) で受けた handler を保持
// dispatchMm({mmIncrementM}) で fake な mmResult を Meter に流し込む
function makeFakeWorker() {
  const handlers = [];
  return {
    addEventListener(type, h) {
      if (type === 'message') handlers.push(h);
    },
    removeEventListener(type, h) {
      const i = handlers.indexOf(h);
      if (i >= 0) handlers.splice(i, 1);
    },
    postMessage() {}, // Meter は postMessage を呼ぶが本テストでは無視
    _dispatch(data) {
      for (const h of handlers) h({ data: data });
    },
    _handlerCount() {
      return handlers.length;
    },
  };
}

// ─── アサーション ───────────────────────────────────────────
let _failures = 0;
function assert(cond, msg) {
  if (!cond) {
    _failures++;
    console.error('  ✗ ' + msg);
  } else {
    console.log('  ✓ ' + msg);
  }
}
function assertNear(actual, expected, tol, msg) {
  const ok = Math.abs(actual - expected) <= tol;
  if (!ok) {
    _failures++;
    console.error(`  ✗ ${msg} (actual=${actual} expected=${expected}±${tol})`);
  } else {
    console.log(`  ✓ ${msg} (${actual.toFixed(2)} ≈ ${expected})`);
  }
}

// ─── テストケース実装 ────────────────────────────────────────
// 各 GPS は (lat, lng) 直線距離 100m 北・1 秒間隔で前進する単純設定
function gpsAt(stepIdx, baseLat = 34.0658, baseLng = 132.997) {
  // 1 step = 0.0009 度 ≈ 100m
  return {
    lat: baseLat + 0.0009 * stepIdx,
    lng: baseLng,
    altitude: 0,
    timestamp: 1714000000000 + stepIdx * 1000,
    speedKmh: 36,
    accuracy: 5,
    isStationary: false,
    compassHeading: 0,
  };
}

console.log('\n[case1] MM healthy → distance_m は MM 由来で増える');
{
  Meter.reset();
  const w = makeFakeWorker();
  Meter.setMapMatcher(w);
  Meter.start();
  if (typeof Meter._setDrainMmUntil === 'function') Meter._setDrainMmUntil(0);
  // 仕様: 起動直後は MM がまだ何も返していない (lastMmUsefulAt=0) ため
  //       最初の GPS 入力は GPS-fallback で課金される。これは正しい挙動。
  //       「MM 健全状態からスタート」を再現するには事前に mmResult を 1 回 dispatch する。
  w._dispatch({ type: 'mmResult', mmIncrementM: 0.0001, snapped: 1 }); // 健全プライム
  // ステップ 0 で last_gps 確定 (距離は加算されない・直前の GPS 比較対象がないため)
  // ステップ 1,2 で GPS 投入 + MM が 90m を返す → distance_m は ~180m + プライム分
  for (let i = 0; i < 3; i++) {
    Meter.update(gpsAt(i));
    if (i > 0) w._dispatch({ type: 'mmResult', mmIncrementM: 90, snapped: 1 });
  }
  const s = Meter.getState();
  assertNear(s.distance_m, 180.0001, 0.01, 'distance_m に MM mmIncrementM が累積');
  assert(s.distanceSource === 'mm', `distanceSource = 'mm' (got '${s.distanceSource}')`);
  Meter.stop();
}

console.log('\n[case1b] 絶対ルール: MM プライムなしでも GPS 直線距離は使われない');
{
  Meter.reset();
  const w = makeFakeWorker();
  Meter.setMapMatcher(w);
  Meter.start();
  if (typeof Meter._setDrainMmUntil === 'function') Meter._setDrainMmUntil(0);
  // プライムなし → step 1 では mmHealthy=false だが、roads が無ければ
  // inline road-snap も snap miss → distance_m は加算されない (絶対ルール)
  // step 1 の mmResult 受信で MM 健全に切替・以後は MM 由来で加算
  for (let i = 0; i < 3; i++) {
    Meter.update(gpsAt(i));
    if (i > 0) w._dispatch({ type: 'mmResult', mmIncrementM: 90, snapped: 1 });
  }
  const s = Meter.getState();
  // step 1: MM silent + RegionLoader 未定義 → 加算なし。mmResult で +90m
  // step 2: mmResult で +90m → 計 180m
  assertNear(s.distance_m, 180, 0.01, 'MM 経由のみで ~180m (GPS 直線は使わない)');
  assert(s.distanceSource === 'mm', '最終 source = mm');
  Meter.stop();
}

console.log('\n[case2] 絶対ルール: MM 沈黙でも GPS 直線距離での課金は発生しない');
{
  Meter.reset();
  const w = makeFakeWorker();
  Meter.setMapMatcher(w);
  Meter.start();
  if (typeof Meter._setDrainMmUntil === 'function') Meter._setDrainMmUntil(0);
  Meter.update(gpsAt(0));
  Meter.update(gpsAt(1));
  w._dispatch({ type: 'mmResult', mmIncrementM: 90 });
  const after1 = Meter.getState();
  assert(after1.distanceSource === 'mm', 'step 1: source = mm');
  // 6 秒待って MM 沈黙状態にし、normal-dt な GPS step を投入
  // RegionLoader が未定義なので inline snap も不可 → distance_m 据え置き
  const realNow = Date.now;
  const fakeBase = realNow();
  Date.now = () => fakeBase + 6000;
  Meter.update(gpsAt(2));
  Date.now = realNow;
  const after2 = Meter.getState();
  assertNear(
    after2.distance_m,
    after1.distance_m,
    0.01,
    'MM 沈黙中は distance_m が動かない (絶対ルール: GPS 直線課金禁止)'
  );
  Meter.stop();
}

console.log('\n[case3] 絶対ルール: Worker null + roads 未 load → distance_m 据え置き');
{
  Meter.reset();
  Meter.setMapMatcher(null);
  Meter.start();
  if (typeof Meter._setDrainMmUntil === 'function') Meter._setDrainMmUntil(0);
  for (let i = 0; i < 3; i++) Meter.update(gpsAt(i));
  const s = Meter.getState();
  assertNear(
    s.distance_m,
    0,
    0.01,
    'roads データ無 + Worker 無 → 加算ゼロ (GPS 直線課金は絶対不可)'
  );
  assert(
    s.distanceSource === 'gps',
    `distanceSource 初期値 'gps' のまま (got '${s.distanceSource}')`
  );
  Meter.stop();
}

console.log('\n[case4] MM 沈黙 → 復帰 → distance_m は MM 復帰分のみ追加');
{
  Meter.reset();
  const w = makeFakeWorker();
  Meter.setMapMatcher(w);
  Meter.start();
  if (typeof Meter._setDrainMmUntil === 'function') Meter._setDrainMmUntil(0);
  Meter.update(gpsAt(0));
  // 6 秒経過 → MM 沈黙中の GPS step (加算なし)
  const realNow = Date.now;
  const fakeBase = realNow();
  Date.now = () => fakeBase + 6000;
  Meter.update(gpsAt(1));
  Date.now = realNow;
  const s1 = Meter.getState();
  assertNear(s1.distance_m, 0, 0.01, 'silent 中は 0 据え置き');
  // MM 復帰 → mmResult で 90m 加算
  w._dispatch({ type: 'mmResult', mmIncrementM: 90 });
  const s2 = Meter.getState();
  assert(s2.distanceSource === 'mm', 'MM 復帰: mm に切替');
  assertNear(s2.distance_m - s1.distance_m, 90, 0.01, 'MM 由来で 90m 追加');
  Meter.stop();
}

console.log('\n[case5] setMapMatcher(null) でリスナー leak しない (M-1 修正の維持確認)');
{
  Meter.reset();
  const w1 = makeFakeWorker();
  const w2 = makeFakeWorker();
  Meter.setMapMatcher(w1);
  Meter.setMapMatcher(w2); // 旧 worker のリスナー除去 + 新規登録
  Meter.setMapMatcher(null); // null で全解除
  assert(w1._handlerCount() === 0, 'w1 のリスナーが除去されている');
  assert(w2._handlerCount() === 0, 'w2 のリスナーが除去されている');
}

console.log('\n[case6] ROAD_FACTOR が削除され Meter 内に未参照');
{
  const src = fs.readFileSync(path.join(__dirname, '..', 'js', 'meter.js'), 'utf8');
  assert(src.indexOf('const ROAD_FACTOR') === -1, 'ROAD_FACTOR 定数が削除されている');
  assert(src.indexOf('* ROAD_FACTOR') === -1, '* ROAD_FACTOR の乗算が消えている');
}

// ─── case7 (2026-05-15): Tier 2 リードインジケータ並走 + commit 正規化 ───
//   mmHealthy=true 時に inline 道路 snap が毎 GPS step 並走し state.tier2_pending_m に
//   道路距離を累積。commit 受領で cutoffTs 以前の segments を差し引き表示先行値を維持する。
//   表示式 (distance_m + tier2_pending_m) が即時更新されることを検証。
console.log('\n[case7] Tier2 リードインジケータ: mmHealthy 時に inline 並走 + commit 正規化');
{
  // RegionLoader モック注入 (calcRoadDistance を 90m 固定で返す)
  ctx.RegionLoader = {
    snapToNearestRoad: function (lat, lng) {
      return { lat: lat, lng: lng, _typeBucket: 0, roadIndex: 1, prefecture: 'ehime' };
    },
    calcRoadDistance: function () {
      return { distanceM: 90 };
    },
    findTunnelByPosition: function () {
      return null;
    },
    findBridgeByPosition: function () {
      return null;
    },
    findNearestTunnel: function () {
      return null;
    },
    findNearestBridge: function () {
      return null;
    },
    calcInfraPolylineDistance: function () {
      return null;
    },
  };

  Meter.reset();
  const w = makeFakeWorker();
  Meter.setMapMatcher(w);
  Meter.start();
  if (typeof Meter._setDrainMmUntil === 'function') Meter._setDrainMmUntil(0);
  // start() 直後 lastMmUsefulAt = now なので mmHealthy=true (プライム不要)

  // GPS step 0,1,2,3 投入
  //   step 0: 初回 (state.last_gps=null) → _inlineSnapAndIncrement で prevSnap 初期化のみ
  //   step 1,2,3: mmHealthy=true 経路の Tier2 並走で各 90m → tier2_pending_m に累積
  for (let i = 0; i < 4; i++) {
    Meter.update(gpsAt(i));
  }
  let s = Meter.getState();
  assertNear(s.tier2_pending_m, 270, 0.01, 'tier2_pending_m に 3 step × 90m = 270m が蓄積');
  assertNear(s.distance_m, 0, 0.01, 'state.distance_m は MM commit 待ちで未加算 (= 0)');
  assertNear(
    s.distance_m + s.tier2_pending_m,
    270,
    0.01,
    '表示式 (distance_m + tier2_pending_m) = 270m で即時反映'
  );

  // 通常 commit を dispatch (observationTimestamp = gpsAt(2).timestamp)
  //   → segments のうち endTimestamp <= gpsAt(2).timestamp の 2 件 (step1, step2) が削除
  //   → tier2_pending_m -= 180m → 90m (step3 分のみ残る)
  //   → state.distance_m += 200m (MM authoritative)
  w._dispatch({
    type: 'mmResult',
    mmIncrementM: 200,
    snapped: 1,
    committed: true,
    snap: {
      observationTimestamp: gpsAt(2).timestamp,
      typeCode: 0,
      prefecture: 'ehime',
      roadIndex: 1,
    },
  });
  s = Meter.getState();
  assertNear(s.distance_m, 200, 0.01, 'commit 後 state.distance_m に MM 200m が加算');
  assertNear(
    s.tier2_pending_m,
    90,
    0.01,
    'cutoffTs 以前の 2 segments (180m) が削除され tier2_pending_m=90m 残る'
  );
  assertNear(
    s.distance_m + s.tier2_pending_m,
    290,
    0.01,
    '表示式 (distance_m + tier2_pending_m) = 290m で連続的に進む'
  );

  // 次の GPS step → さらに 90m を tier2 に積む
  Meter.update(gpsAt(4));
  s = Meter.getState();
  assertNear(s.tier2_pending_m, 180, 0.01, '次 step で tier2_pending_m が 90→180m');

  Meter.stop();
  // RegionLoader を解除して他テスト/他 case に影響しないようにする
  delete ctx.RegionLoader;
}

// ─── case8 (2026-05-15): Tier 2 リードインジケータ・absolute rule 準拠 ───
//   snap miss (RegionLoader.snapToNearestRoad が null) のときは tier2_pending_m に
//   加算しない (= GPS 直線距離での課金/表示禁止の絶対ルール準拠)。
console.log('\n[case8] Tier2: snap miss 時は加算ゼロ (GPS 直線禁止)');
{
  // snapToNearestRoad は常に null を返す = 道路から遠い状況
  ctx.RegionLoader = {
    snapToNearestRoad: function () {
      return null;
    },
    calcRoadDistance: function () {
      return { distanceM: 90 };
    },
    findTunnelByPosition: function () {
      return null;
    },
    findBridgeByPosition: function () {
      return null;
    },
    findNearestTunnel: function () {
      return null;
    },
    findNearestBridge: function () {
      return null;
    },
    calcInfraPolylineDistance: function () {
      return null;
    },
  };

  Meter.reset();
  const w = makeFakeWorker();
  Meter.setMapMatcher(w);
  Meter.start();
  if (typeof Meter._setDrainMmUntil === 'function') Meter._setDrainMmUntil(0);

  for (let i = 0; i < 4; i++) {
    Meter.update(gpsAt(i));
  }
  const s = Meter.getState();
  assertNear(s.tier2_pending_m, 0, 0.01, 'snap miss なら tier2_pending_m は 0 据え置き');
  assertNear(s.distance_m, 0, 0.01, 'state.distance_m も 0 据え置き (commit 未来訪)');

  Meter.stop();
  delete ctx.RegionLoader;
}

if (_failures === 0) {
  console.log('\n[meter-test] PASS (all cases)');
  process.exit(0);
} else {
  console.error(`\n[meter-test] FAIL (${_failures} assertions)`);
  process.exit(1);
}
