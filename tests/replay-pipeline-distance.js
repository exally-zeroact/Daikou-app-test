#!/usr/bin/env node
'use strict';

// tests/replay-pipeline-distance.js
// 新距離コア js/pipeline-distance.js を、実走 trace (C:/Users/zeroa/gpstrace.json) の
// seg1 (gap>120s で分割した最大区間) に流して distance_m を出力する検証ハーネス。
//
// 完全オフライン: roads-decoder.js + data/roads-ehime.js を global shim で eval 読込
//   (tests/real-trace-roadsnap.js の loader を流用)。
//
// 使い方: node tests/replay-pipeline-distance.js
//   env: GPS_TRACE=...（trace path 上書き）/ ROADS_PREF=ehime

const fs = require('fs');
const path = require('path');

const PREF = (process.env.ROADS_PREF || 'ehime').toLowerCase();
const TRACE_PATH = process.env.GPS_TRACE || 'C:/Users/zeroa/gpstrace.json';
const TRIP_GAP_SEC = 120;
const R = 6371000;

function rad(x) {
  return (x * Math.PI) / 180;
}
function haversine(a, b) {
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// gap>120s で分割した最大距離 seg を返す (real-trace-roadsnap.js と同手法)
function pickMainTrip(samples) {
  const s = samples
    .filter((x) => x && typeof x.lat === 'number' && typeof x.lng === 'number')
    .sort((a, b) => a.t - b.t);
  const segs = [[]];
  for (let i = 0; i < s.length; i++) {
    if (i > 0 && s[i].t - s[i - 1].t > TRIP_GAP_SEC * 1000) segs.push([]);
    segs[segs.length - 1].push(s[i]);
  }
  let best = [];
  let bd = -1;
  for (const g of segs) {
    if (g.length < 2) continue;
    let d = 0;
    for (let i = 1; i < g.length; i++) d += haversine(g[i - 1], g[i]);
    if (d > bd) {
      bd = d;
      best = g;
    }
  }
  return best;
}

// roads-decoder.js + roads-{pref}.js を Node で読み込む (browser IIFE を global shim で)
function loadDecoder(pref) {
  global.window = global;
  global.self = global;
  const decSrc = fs.readFileSync(path.join(__dirname, '..', 'js', 'roads-decoder.js'), 'utf8');
  // eslint-disable-next-line no-eval
  eval(decSrc); // → global.RoadDecoder
  const dataFile = path.join(__dirname, '..', 'data', 'roads-' + pref + '.js');
  if (!fs.existsSync(dataFile)) throw new Error('roads データ無し: ' + dataFile);
  const dataSrc = fs.readFileSync(dataFile, 'utf8');
  // eslint-disable-next-line no-eval
  eval(dataSrc); // → global.ROADS_<PREF>
  const key = 'ROADS_' + pref.toUpperCase();
  const roadsData = global[key];
  if (!roadsData) throw new Error('global.' + key + ' 未定義');
  const dec = new global.RoadDecoder(roadsData);
  dec.buildOffsetTable();
  return dec;
}

// ── 合成回帰テスト: spd 無し + 停車中 GPS ジッタ → distance_m ≈ 0 (creep 防止) ──
//    監査官 critical「spd 欠落フレーム/spd 非対応端末で ZUPT 失効・phantom 距離加算」の回帰。
//    道路上の 1 点に ±8e-5 度 (≈ 数 m) のジッタを 60 秒分置き、spd を一切付けない。
//    変位ベース静止 fallback が効いていれば distance_m は ≈ 0 でなければならない。
function runStationaryJitterRegression(computeDistance, dec, seg1) {
  // seg1 から道路 snap される実在点を 1 つ基準に取る (snap 必ず当たる座標)
  const base = seg1[Math.floor(seg1.length / 2)];
  const t0 = base.t || Date.now();
  const samples = [];
  // 60 秒・1Hz・±8e-5 度のジッタ (停車中 GPS ノイズ相当)・spd フィールド無し・acc 8m
  const jit = [8e-5, -8e-5, 5e-5, -6e-5, 7e-5, -4e-5, 8e-5, -8e-5, 3e-5, -7e-5];
  for (let i = 0; i < 60; i++) {
    samples.push({
      lat: base.lat + jit[i % jit.length],
      lng: base.lng + jit[(i + 3) % jit.length],
      t: t0 + i * 1000,
      acc: 8,
      // spd 無し (= 監査官の critical 条件・spd-optional 運用)
    });
  }
  const r = computeDistance(samples, dec, { enableRouting: true });

  // 比較: spd=0 を全点に与えた同一データ (= 速度ベース ZUPT が効くケース)
  const samplesSpd0 = samples.map((s) => Object.assign({}, s, { spd: 0 }));
  const rSpd0 = computeDistance(samplesSpd0, dec, { enableRouting: true });

  return {
    noSpd_distance_m: +r.distance_m.toFixed(2),
    noSpd_stationarySkipped: r.breakdown.stationarySkipped,
    spd0_distance_m: +rSpd0.distance_m.toFixed(2),
    pts: samples.length,
  };
}

// ── 配線テスト: opts.speedProvider pluggable 経路の実差し替え検証 ──
//    配線役指摘 [A]「speedProvider 差し替えが replay で未検証」の解消。
//    全点静止を返す provider を差し込み → distance_m が 0 になることで経路導通を実証。
function runSpeedProviderInjection(computeDistance, dec, seg1) {
  let called = 0;
  const alwaysStationary = function (sample, prevSample) {
    called++;
    // prevSample を実際に参照 (orphan 引数の導通も確認)
    void prevSample;
    return 0; // 常に静止 (< stationarySpdMps)
  };
  const r = computeDistance(seg1, dec, {
    enableRouting: true,
    speedProvider: alwaysStationary,
  });
  return {
    provider_called: called,
    distance_m: +r.distance_m.toFixed(2),
    stationarySkipped: r.breakdown.stationarySkipped,
  };
}

function main() {
  const { computeDistance, RoadGraphRouter, gpsSpeedProvider, haversineM, DEFAULTS } = require(
    path.join(__dirname, '..', 'js', 'pipeline-distance.js')
  );
  // export 導通確認 (配線役 orphan 指摘の最小カバー)
  if (
    typeof computeDistance !== 'function' ||
    typeof RoadGraphRouter !== 'function' ||
    typeof gpsSpeedProvider !== 'function' ||
    typeof haversineM !== 'function' ||
    !DEFAULTS
  ) {
    throw new Error(
      'pipeline-distance.js export 不整合 (computeDistance/RoadGraphRouter/gpsSpeedProvider/haversineM/DEFAULTS)'
    );
  }

  if (!fs.existsSync(TRACE_PATH)) throw new Error('trace 無し: ' + TRACE_PATH);
  const samples = JSON.parse(fs.readFileSync(TRACE_PATH, 'utf8'));
  const seg1 = pickMainTrip(samples);
  if (seg1.length < 2) throw new Error('seg1 走行区間なし');

  let raw = 0;
  for (let i = 1; i < seg1.length; i++) raw += haversine(seg1[i - 1], seg1[i]);

  const hasSpd = seg1.some((s) => typeof s.spd === 'number' && s.spd >= 0);

  console.log('[replay] trace=' + TRACE_PATH);
  console.log('[replay] seg1 pts=' + seg1.length + '  raw_haversine=' + raw.toFixed(0) + ' m');
  console.log(
    '[replay] seg1 に spd フィールドあり: ' +
      hasSpd +
      ' (無ければ Doppler 補間は不発・直線 fallback)'
  );
  console.log('[replay] roads-' + PREF + ' 読込中...');
  const dec = loadDecoder(PREF);

  // --- routing ON (本命) ---
  const onT0 = Date.now();
  const on = computeDistance(seg1, dec, { enableRouting: true });
  const onMs = Date.now() - onT0;

  // --- routing OFF (比較: 別道路は常に直線 = 旧 calcRoadDistance 相当) ---
  const off = computeDistance(seg1, dec, { enableRouting: false });

  console.log('\n=== 新距離コア pipeline-distance.js (seg1) ===');
  console.log('  生GPS haversine        : ' + raw.toFixed(0) + ' m');
  console.log('  ★distance_m (routing ON): ' + on.distance_m.toFixed(0) + ' m   (' + onMs + ' ms)');
  console.log('   distance_m (routing OFF): ' + off.distance_m.toFixed(0) + ' m');
  console.log('  --- routing ON 内訳 ---');
  console.log(
    '    同一道路弧長  : ' +
      on.breakdown.sameRoadM.toFixed(0) +
      ' m  (' +
      on.stats.sameRoadSegs +
      ' 区間)'
  );
  console.log(
    '    routing道なり : ' +
      on.breakdown.routedM.toFixed(0) +
      ' m  (' +
      on.stats.routedSegs +
      ' 区間)'
  );
  console.log(
    '    直線fallback  : ' +
      on.breakdown.straightFallbackM.toFixed(0) +
      ' m  (' +
      on.stats.straightSegs +
      ' 区間)'
  );
  console.log(
    '    Doppler補間   : ' +
      on.breakdown.dopplerM.toFixed(0) +
      ' m  (' +
      on.stats.dopplerSegs +
      ' 区間)'
  );
  console.log('    静止skip(ZUPT): ' + on.breakdown.stationarySkipped + ' 区間');
  console.log('    routing過大fallback: ' + on.stats.routingFallbacks + ' 回');
  console.log('    snap hit/miss : ' + on.stats.snapHit + ' / ' + on.stats.snapMiss);

  // ── 回帰/配線テスト ──
  const jitReg = runStationaryJitterRegression(computeDistance, dec, seg1);
  const provInj = runSpeedProviderInjection(computeDistance, dec, seg1);

  console.log('\n=== 回帰テスト: spd 無し + 停車ジッタ → creep 防止 ===');
  console.log(
    '  spd無し distance_m       : ' +
      jitReg.noSpd_distance_m +
      ' m  (静止skip ' +
      jitReg.noSpd_stationarySkipped +
      '/' +
      jitReg.pts +
      ')'
  );
  console.log('  spd=0   distance_m (参考): ' + jitReg.spd0_distance_m + ' m');
  console.log('=== 配線テスト: speedProvider 差し替え ===');
  console.log('  provider 呼出回数        : ' + provInj.provider_called);
  console.log(
    '  全点静止 provider distance_m: ' +
      provInj.distance_m +
      ' m  (静止skip ' +
      provInj.stationarySkipped +
      ')'
  );

  // PASS/FAIL 判定 (creep 防止 critical の合否)
  const CREEP_MAX_M = 5.0; // 60 秒静止で 5m 超の phantom 距離は creep とみなし FAIL
  const failures = [];
  if (jitReg.noSpd_distance_m > CREEP_MAX_M) {
    failures.push(
      'spd 無し停車ジッタで distance_m=' +
        jitReg.noSpd_distance_m +
        'm (>' +
        CREEP_MAX_M +
        'm) = creep 再発'
    );
  }
  if (provInj.provider_called === 0) {
    failures.push('speedProvider が一度も呼ばれない (差し替え経路未導通)');
  }
  if (provInj.distance_m > CREEP_MAX_M) {
    failures.push(
      '全点静止 provider で distance_m=' +
        provInj.distance_m +
        'm (>' +
        CREEP_MAX_M +
        'm) = ZUPT 失効'
    );
  }
  const testPass = failures.length === 0;
  console.log('\n=== 判定: ' + (testPass ? 'PASS' : 'FAIL') + ' ===');
  for (const f of failures) console.log('  [FAIL] ' + f);

  const OUT_DIR = path.join(__dirname, '..', 'data', 'test-results');
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const out = {
    trace: TRACE_PATH,
    seg1_points: seg1.length,
    raw_haversine_m: +raw.toFixed(0),
    distance_m_routing_on: +on.distance_m.toFixed(0),
    distance_m_routing_off: +off.distance_m.toFixed(0),
    routing_on_breakdown: on.breakdown,
    routing_on_stats: on.stats,
    routing_ms: onMs,
    regression_stationary_jitter: jitReg,
    wiring_speedprovider_injection: provInj,
    test_pass: testPass,
    test_failures: failures,
  };
  fs.writeFileSync(
    path.join(OUT_DIR, 'replay-pipeline-distance.json'),
    JSON.stringify(out, null, 2)
  );
  console.log('\n[replay] wrote data/test-results/replay-pipeline-distance.json');

  if (!testPass) process.exit(1);
}

main();
