'use strict';
// READ-ONLY (obdブランチ・2026-06-05): OBD車速入りtraceを業務別に分割し、∫v(OBD) を
//   生GPS haversine / 現engine(bypass) / タイヤ値 と比較する。OBD速度の距離精度を実機検証する用。
// 使い方: node tests/_analyze-obd.js <fixtureFile> <tireKm> [pref]
//   trace の各 sample に obd(km/h・-1=無し) が入っている前提 (debug-trace.js が記録)。
const fs = require('fs');
const path = require('path');
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

function hav(a, b) {
  const R = 6371000,
    t = Math.PI / 180;
  const dLat = (b.lat - a.lat) * t,
    dLng = (b.lng - a.lng) * t;
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * t) * Math.cos(b.lat * t) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}
function bizWindows(a) {
  const w = [];
  let cur = null;
  for (let i = 0; i < a.length; i++) {
    const b = a[i].biz || {};
    const it = b.it != null ? b.it : b.run;
    if (it === 1) {
      if (!cur) cur = { s: i };
      cur.e = i;
    } else {
      if (cur) {
        w.push(cur);
        cur = null;
      }
    }
  }
  if (cur) w.push(cur);
  return w.filter((t) => t.e - t.s > 30);
}

// ∫v(OBD): obd(km/h) を時間積分。-1(欠測)は前回値保持(短時間)・gapは加算しない。
function obdIntegral(seg) {
  let d = 0,
    have = 0,
    miss = 0;
  for (let i = 1; i < seg.length; i++) {
    const dt = (seg[i].t - seg[i - 1].t) / 1000;
    if (!(dt > 0 && dt < 10)) continue;
    const va = seg[i - 1].obd,
      vb = seg[i].obd;
    let v = null;
    if (va >= 0 && vb >= 0) v = (va + vb) / 2;
    else if (vb >= 0) v = vb;
    else if (va >= 0) v = va;
    if (v == null) {
      miss++;
      continue;
    }
    have++;
    d += (v / 3.6) * dt;
  }
  return { km: d / 1000, have, miss };
}
function rawHav(seg) {
  let d = 0;
  for (let i = 1; i < seg.length; i++) d += hav(seg[i - 1], seg[i]);
  return d / 1000;
}
function runEngine(pref, samples) {
  const worker = createMapMatcherWorker({ debug: false });
  let roadsLoaded = false;
  worker.on((e) => {
    const m = e.data;
    if (m && m.type === 'roadsLoaded') roadsLoaded = m.ok;
  });
  const roadsData = loadPrefRoadsData(pref);
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
  adapter.postMessage({ type: 'configPlatform', isIOS: true });
  adapter.postMessage({ type: 'loadRoads', pref: roadsData.prefecture, roadsData });
  if (!roadsLoaded) throw new Error('loadRoads failed');
  if (typeof Meter.setBusinessActive === 'function') Meter.setBusinessActive(true);
  Meter.start();
  if (typeof Meter._setDrainMmUntil === 'function') Meter._setDrainMmUntil(0);
  if (typeof Meter._setOffRoadGraceUntil === 'function') Meter._setOffRoadGraceUntil(0);
  for (const g of samples)
    Meter.update({
      lat: g.lat,
      lng: g.lng,
      accuracy: g.acc,
      speedKmh: g.spd >= 0 ? g.spd * 3.6 : null,
      headingDeg: g.hdg,
      altitude: g.alt,
      timestamp: g.t,
      isStationary: false,
    });
  Meter.businessEnd();
  return Meter.getState().distance_m / 1000;
}

const file = process.argv[2];
const tire = parseFloat(process.argv[3]);
const pref = process.argv[4] || 'ehime';
if (!file) {
  console.log('usage: node tests/_analyze-obd.js <file> <tireKm> [pref]');
  process.exit(1);
}
const a = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', file), 'utf8'))
  .filter((x) => x && Number.isFinite(x.lat))
  .sort((x, y) => x.t - y.t);
// obd 欠如チェック
const obdPts = a.filter((x) => x.obd != null && x.obd >= 0).length;
console.log(
  '=== ' +
    file +
    ' n=' +
    a.length +
    ' / OBD有効点=' +
    obdPts +
    ' (' +
    ((obdPts / a.length) * 100).toFixed(0) +
    '%) ==='
);
if (obdPts === 0) console.log('⚠ OBD車速がtraceに無い(obd-client未接続で記録された?)');
const p = (v) => (tire ? ' (' + ((v / tire - 1) * 100).toFixed(1) + '%)' : '');
bizWindows(a).forEach((t, i) => {
  const seg = a.slice(t.s, t.e + 1);
  const oi = obdIntegral(seg);
  const raw = rawHav(seg);
  let eng;
  try {
    eng = runEngine(pref, seg);
  } catch (e) {
    eng = 'ERR ' + e.message;
  }
  console.log(
    '\n業務' +
      (i + 1) +
      ' [n=' +
      seg.length +
      ' ' +
      ((seg[seg.length - 1].t - seg[0].t) / 60000).toFixed(1) +
      'min] tire=' +
      tire
  );
  console.log(
    '  ∫v(OBD)       = ' +
      oi.km.toFixed(3) +
      p(oi.km) +
      '  [OBD点 ' +
      oi.have +
      '有/' +
      oi.miss +
      '欠]'
  );
  console.log('  raw haversine = ' + raw.toFixed(3) + p(raw));
  console.log('  engine(bypass)= ' + (typeof eng === 'number' ? eng.toFixed(3) + p(eng) : eng));
});
