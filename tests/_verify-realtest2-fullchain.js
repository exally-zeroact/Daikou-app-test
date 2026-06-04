'use strict';
// ★検証 harness (READ-ONLY engine)★ realtest2 を ★実機相当 full-chain★ で業務別に流す:
//   raw fixture → 実 gps-worker(Worker A) → 実 meter → 実 Worker B(map-matcher) → 業務別 distance_m。
//   bypass harness(_analyze-realtest2-perbiz.js)と同じ業務分割(it==1窓)・同じ Meter 配線で、
//   gps-worker を「通す」ことだけが違う。3台がタイヤ(6.43/3.12)に収束するか・spread・過大ゼロを判定。
//   engine(js/*) は 1byte 不変。tests 配下のみ。
const fs = require('fs');
const path = require('path');
const { createGpsWorker } = require('./worker/gps-worker-sim');
const { createMapMatcherWorker, loadPrefRoadsData } = require('./replay-mm-worker/worker-sim');
const { loadMeter } = require('./replay-mm-worker/runner');
const FARE = {
  version: 2,
  base_fare: 1300,
  base_distance_m: 1000,
  add_fare: 100,
  add_distance_m: 420,
  tiers: [],
  surcharges: [],
  minFare: null,
  maxFare: null,
  rounding: 10,
  autoSurcharges: {},
  vehicles: [],
  vehiclesEnabled: false,
  wait: { enabled: false, freeMins: 5, ratePerMin: 100 },
};

function splitBiz(arr) {
  const trips = [];
  let cur = null;
  for (let i = 0; i < arr.length; i++) {
    const b = arr[i].biz || {};
    if (b.it === 1) {
      if (!cur) cur = { s: i };
      cur.e = i;
    } else {
      if (cur) {
        trips.push(cur);
        cur = null;
      }
    }
  }
  if (cur) trips.push(cur);
  return trips.filter((t) => t.e - t.s > 30);
}

function runFullChain(pref, samples, isIOS) {
  // ── Worker A (実 gps-worker) ──
  const gw = createGpsWorker({ debug: false });
  const rejReason = {};
  gw.on((e) => {
    const m = e.data;
    if (m && m.type === 'gpsDbg' && m.data && m.data.rej)
      rejReason[m.data.rej] = (rejReason[m.data.rej] || 0) + 1;
  });
  gw.sendMessage({ type: 'init', data: { config: {}, debug: false } });

  // ── Worker B ──
  const worker = createMapMatcherWorker({ debug: false });
  let roadsLoaded = false;
  worker.on((e) => {
    const m = e.data;
    if (m && m.type === 'roadsLoaded') roadsLoaded = m.ok;
  });
  const roadsData = loadPrefRoadsData(pref);

  // ── Meter ──
  const Meter = loadMeter({ debug: false });
  Meter.setFareConfig(FARE);
  Meter.reset();
  const handlers = [];
  worker.on((e) => {
    for (const h of handlers) h(e);
  });
  const adapter = {
    addEventListener(t, h) {
      if (t === 'message') handlers.push(h);
    },
    removeEventListener(t, h) {
      const i = handlers.indexOf(h);
      if (i >= 0) handlers.splice(i, 1);
    },
    postMessage(m) {
      worker.sendMessage(m);
    },
  };
  Meter.setMapMatcher(adapter);
  adapter.postMessage({ type: 'configPlatform', isIOS: !!isIOS });
  adapter.postMessage({ type: 'loadRoads', pref: roadsData.prefecture, roadsData });
  if (!roadsLoaded) throw new Error('loadRoads failed');
  if (typeof Meter.setBusinessActive === 'function') Meter.setBusinessActive(true);
  Meter.start();
  if (typeof Meter._setDrainMmUntil === 'function') Meter._setDrainMmUntil(0);
  if (typeof Meter._setOffRoadGraceUntil === 'function') Meter._setOffRoadGraceUntil(0);

  let rejected = 0;
  for (const g of samples) {
    const before = gw.getResults().length;
    gw.sendMessage({
      type: 'position',
      data: {
        lat: g.lat,
        lng: g.lng,
        accuracy: g.acc,
        speedKmh: g.spd >= 0 ? g.spd * 3.6 : 0,
        heading: g.hdg != null && g.hdg >= 0 ? g.hdg : null,
        altitude: g.alt || 0,
        now: g.t,
        compassHeading: typeof g.compass === 'number' && g.compass >= 0 ? g.compass : null,
        accelData: Array.isArray(g.accel) && g.accel.length ? g.accel[g.accel.length - 1] : null,
        accelSamples: Array.isArray(g.accel) ? g.accel : [],
        gyroData: g.gyro ? { alpha: g.gyro.a, beta: g.gyro.b, gamma: g.gyro.g } : null,
        gyroSamples: g.gyro ? [{ alpha: g.gyro.a, beta: g.gyro.b, gamma: g.gyro.g, t: g.t }] : [],
        speedSrc: g.spd >= 0 ? 'dop' : 'hav',
      },
    });
    const res = gw.getResults();
    const out = res.length > before ? res[res.length - 1] : null;
    if (!out) {
      rejected++;
      continue;
    }
    Meter.update({
      lat: out.lat,
      lng: out.lng,
      accuracy: out.accuracy != null ? out.accuracy : g.acc,
      speedKmh: out.speedKmh,
      compassHeading: out.compassHeading,
      altitude: out.altitude || 0,
      timestamp: g.t,
      isStationary: out.isStationary,
    });
  }
  Meter.businessEnd();
  return { km: Meter.getState().distance_m / 1000, rejected, n: samples.length, rejReason };
}

const dev = {
  iPhone13: { f: 'realtest2-iPhone13.json', ios: true },
  iPhoneSE: { f: 'realtest2-iPhoneSE.json', ios: true },
  Android: { f: 'realtest2-Android.json', ios: false },
};
const tire = [6.43, 3.12];
const out = {};
for (const [lbl, cfg] of Object.entries(dev)) {
  const a = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', cfg.f), 'utf8'))
    .filter((x) => x && Number.isFinite(x.lat))
    .sort((x, y) => x.t - y.t);
  const trips = splitBiz(a);
  out[lbl] = trips.map((t) => runFullChain('ehime', a.slice(t.s, t.e + 1), cfg.ios));
}
console.log('=== full-chain(gps-worker込み) を realtest2 に業務別に流した distance_m ===');
for (let b = 0; b < 2; b++) {
  console.log('\n--- 業務' + (b + 1) + ' (タイヤ' + tire[b] + 'km) ---');
  const vals = [];
  for (const lbl of Object.keys(out)) {
    const r = out[lbl][b];
    if (!r) continue;
    vals.push(r.km);
    console.log(
      '  ' +
        lbl.padEnd(10) +
        ' dist=' +
        r.km.toFixed(2) +
        'km (' +
        ((r.km / tire[b] - 1) * 100).toFixed(1) +
        '%) rej=' +
        r.rejected +
        '/' +
        r.n +
        ' ' +
        JSON.stringify(r.rejReason)
    );
  }
  if (vals.length === 3) {
    const spread = (Math.max(...vals) - Math.min(...vals)) * 1000;
    const over = vals.some((v) => v > tire[b]);
    console.log(
      '  -> 3台 spread = ' + spread.toFixed(0) + 'm (target<420 ideal<100) over-tire=' + over
    );
  }
}
