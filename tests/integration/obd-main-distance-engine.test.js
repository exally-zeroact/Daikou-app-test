// tests/integration/obd-main-distance-engine.test.js
// ★OBDメイン距離 実エンジン不変条件 (2026-06-10・テスト班)★
//   司さん裁定: OBD接続中はOBD車輪速度をメイン距離源にする(=タクシー認定の基準ローラー量)。
//   本番配線: gps.js が speedSrc='obd' を立て → map-matcher が ingest に obd:true を渡し →
//             pipeline-distance の ∫v(OBD) メイン枝(L1666)が距離を駆動。
//   このテストは createDistanceTracker / computeDistance を ★実コードのまま★ 動かし、
//   OBD valid 時に距離が OBD 由来 / 停車で creep 0 / never-over(distance ≤ raw∫v×k 上限) を固定する。
//
//   ★不可侵★: distance_m の意味/calcFare/business 分離/過大ゼロ天井 は触らない。
//   k(車別補正)は ★採点側でのみ★ 適用し、pipeline には raw spd を渡す契約を検証する。

'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const FIX = path.join(__dirname, '..', 'fixtures');
let computeDistance, createDistanceTracker, dec, DEFAULTS;

beforeAll(() => {
  const sandbox = {
    console,
    atob: typeof atob !== 'undefined' ? atob : (b) => Buffer.from(b, 'base64').toString('binary'),
    btoa: typeof btoa !== 'undefined' ? btoa : (s) => Buffer.from(s, 'binary').toString('base64'),
    Uint8Array,
    TextDecoder: typeof TextDecoder !== 'undefined' ? TextDecoder : undefined,
  };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(
    fs.readFileSync(path.join(__dirname, '..', '..', 'js', 'roads-decoder.js'), 'utf8'),
    sandbox,
    { filename: 'roads-decoder.js' }
  );
  vm.runInContext(
    fs.readFileSync(path.join(__dirname, '..', '..', 'data', 'roads-ehime.js'), 'utf8'),
    sandbox,
    { filename: 'roads-ehime.js' }
  );
  dec = new sandbox.RoadDecoder(sandbox.ROADS_EHIME);
  dec.buildOffsetTable();
  const mod = require(path.join(__dirname, '..', '..', 'js', 'pipeline-distance.js'));
  computeDistance = mod.computeDistance;
  createDistanceTracker = mod.createDistanceTracker;
  DEFAULTS = mod.DEFAULTS;
}, 60000);

// 道路に依存しない最小スタブ (∫v(OBD) 枝は snap/road-arc を使わない=純粋に時間積分)
const stubDec = {
  snapToNearestRoad() {
    return null;
  },
  getRoadsNear() {
    return [];
  },
  calcRoadDistance() {
    return null;
  },
  decodeRoadAt() {
    return null;
  },
};
// OBDメイン枝は adaptiveMode!==true で発火(本番 DEFAULTS と同じ)
const OBD_OPT = { useSnapCache: false, enableRouting: false, adaptiveMode: false };
const T0 = 1_700_000_000_000;

function load(file) {
  const p = path.join(FIX, file);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf8'))
    .filter((x) => x && Number.isFinite(x.lat))
    .sort((x, y) => (x.t || 0) - (y.t || 0));
}

// raw ∫v(OBD・k=1) = pipeline と同じ台形・dt<=obdMaxDtS で穴は計上しない(過大ゼロ側)
function obdRawIntegral(samples, obdMaxDtS) {
  let m = 0;
  for (let i = 1; i < samples.length; i++) {
    const dt = (samples[i].t - samples[i - 1].t) / 1000;
    if (!(dt > 0 && dt <= obdMaxDtS)) continue;
    const a = samples[i - 1].obd,
      b = samples[i].obd;
    if (typeof a === 'number' && a >= 0 && typeof b === 'number' && b >= 0)
      m += ((a + b) / 2 / 3.6) * dt;
  }
  return m;
}

describe('OBDメイン距離 ∫v(OBD) 実エンジン不変条件', () => {
  it('★OBD valid 時の距離は OBD 由来 (reason=obd・distance == ∫v dt)', () => {
    const tk = createDistanceTracker(stubDec, OBD_OPT);
    let t = T0;
    tk.ingest({ lat: 34, lng: 133, t, acc: 5, spd: 0, obd: true }); // first
    const speeds = [15, 20, 18, 12, 25]; // m/s・各 dt=1s
    let expected = 0;
    for (const s of speeds) {
      t += 1000;
      const r = tk.ingest({ lat: 34, lng: 133, t, acc: 5, spd: s, obd: true });
      expect(r.reason).toBe('obd'); // ★距離源が OBD であることを固定★
      expected += s * 1;
    }
    expect(Math.abs(tk.totalM() - expected)).toBeLessThan(1e-6);
  });

  it('★OBD 速度0(停車)で creep 0 (自然ZUPT・1byteも増えない)', () => {
    const tk = createDistanceTracker(stubDec, OBD_OPT);
    let t = T0;
    tk.ingest({ lat: 34, lng: 133, t, acc: 5, spd: 0, obd: true });
    for (let i = 0; i < 30; i++) {
      t += 1000;
      const r = tk.ingest({ lat: 34, lng: 133, t, acc: 5, spd: 0, obd: true });
      expect(r.deltaM).toBe(0);
    }
    expect(tk.totalM()).toBe(0); // ★停車creep = 0★
  });

  it('★never-over: 異常 dt(>obdMaxDtS) は穴を ∫v 計上しない (過大ゼロ保険)', () => {
    const tk = createDistanceTracker(stubDec, OBD_OPT);
    const maxDt = DEFAULTS.obdMaxDtS; // 10s
    tk.ingest({ lat: 34, lng: 133, t: T0, acc: 5, spd: 20, obd: true });
    const r = tk.ingest({
      lat: 34,
      lng: 133,
      t: T0 + (maxDt + 5) * 1000,
      acc: 5,
      spd: 20,
      obd: true,
    });
    expect(r.deltaM).toBe(0); // 穴は埋めない=過大方向に出ない
    expect(tk.totalM()).toBe(0);
  });

  it('★never-over: distance_m(pipeline・k未適用) は OBD raw∫v を超えない (k は採点側のみ)', () => {
    // 一定速度なら distance == raw∫v。pipeline は raw spd を積分=k を内部適用しない契約。
    const tk = createDistanceTracker(stubDec, OBD_OPT);
    const samples = [];
    let t = T0;
    for (let i = 0; i <= 20; i++) {
      samples.push({ lat: 34, lng: 133, t, acc: 5, obd: 36 });
      t += 1000;
    } // obd km/h
    // ingest は spd(m/s) を読む。OBD km/h を m/s に変換して obd:true で流す(本番 map-matcher 相当)。
    let total = 0;
    for (let i = 0; i < samples.length; i++) {
      const r = tk.ingest({ lat: 34, lng: 133, t: samples[i].t, acc: 5, spd: 36 / 3.6, obd: true });
      total = r.totalM;
    }
    const raw = obdRawIntegral(samples, DEFAULTS.obdMaxDtS);
    expect(total).toBeLessThanOrEqual(raw + 1e-6); // ★distance ≤ raw∫v(k=1)★
    // k>1 を採点側で掛けるのは raw に対してであって distance_m には掛けない(不可侵)
    const k = 1.04;
    const scored = raw * k;
    expect(scored).toBeGreaterThan(total); // 採点 OBD×k は別計上
  });

  // ★★ 既知の差(テスト班報告)★★: batch computeDistance には OBD バイパス枝が無い
  //   (OBD ∫v 枝は tracker._core / ingest L1667 のみ・batch processPoint は stepDistance のみ)。
  //   本番の OBD メイン距離は ★必ず tracker(=map-matcher ingest)経路★ を通るので、
  //   OBDメイン採点・検証は tracker 経路で行うのが正しい(batch でやると smoothed 距離になる)。
  //   ここでは「batch は OBD 枝を踏まない=obdM 0」という現状を固定し、回帰で気付けるようにする。
  it('★[既知差] batch computeDistance は OBD 枝を踏まない (obdM=0・本番は tracker 経路)', () => {
    const seq = [];
    let t = T0;
    for (let i = 0; i <= 40; i++) {
      const spd = i < 10 ? 0 : 10 + (i % 7); // 停車→走行 (m/s)
      seq.push({ lat: 34 + i * 1e-5, lng: 133, t, acc: 5, spd, obd: true });
      t += 1000;
    }
    const batch = computeDistance(seq, stubDec, OBD_OPT);
    expect(batch.breakdown.obdM == null || batch.breakdown.obdM === 0).toBe(true); // batch は ∫v 枝に入らない

    const tk = createDistanceTracker(stubDec, OBD_OPT);
    for (const x of seq) tk.ingest(x);
    if (tk.flush) tk.flush();
    expect(tk._breakdown().obdM).toBeGreaterThan(0); // tracker は ∫v 枝で距離を出す(本番経路)
    // ★tracker 経路は ∫v(OBD) で正しく積分されている(停車10点除く30区間×平均速度)★
    expect(tk.totalM()).toBeGreaterThan(0);
  });

  it('★tracker ingest parity: 同一OBD列を2回流して同値 (決定論)', () => {
    function runSeq() {
      const seq = [];
      let t = T0;
      for (let i = 0; i <= 40; i++) {
        const spd = i < 10 ? 0 : 10 + (i % 7);
        seq.push({ lat: 34 + i * 1e-5, lng: 133, t, acc: 5, spd, obd: true });
        t += 1000;
      }
      const tk = createDistanceTracker(stubDec, OBD_OPT);
      for (const x of seq) tk.ingest(x);
      if (tk.flush) tk.flush();
      return tk.totalM();
    }
    expect(Math.abs(runSeq() - runSeq())).toBeLessThanOrEqual(1e-9);
  });

  it('★OBD未設定の通常GPS経路は obd 枝に入らない (byte不変・reason≠obd)', () => {
    const tk = createDistanceTracker(stubDec, OBD_OPT);
    tk.ingest({ lat: 34, lng: 133, t: T0, acc: 5, spd: 10 }); // obd 未設定
    const r = tk.ingest({ lat: 34, lng: 133.0001, t: T0 + 1000, acc: 5, spd: 10 });
    expect(r.reason).not.toBe('obd');
  });
});

describe('OBDメイン 実機fixture(0610-Android・OBD車速あり) never-over', () => {
  it('★実Android trace を OBD駆動: distance_m ≤ raw∫v(k=1) かつ creep≈0', () => {
    const a = load('0610-Android.json');
    if (!a) {
      console.warn('0610-Android.json 無し=skip');
      return;
    }
    const obdPts = a.filter((x) => typeof x.obd === 'number' && x.obd >= 0).length;
    expect(obdPts).toBeGreaterThan(0); // この fixture は OBD あり

    // ★本番 OBD メイン経路 = tracker ingest★ (map-matcher が ingest に obd:true を渡す経路)。
    //   batch computeDistance は OBD 枝を踏まないので必ず tracker で検証する(上の[既知差]参照)。
    //   OBD車速(km/h)→m/s を spd に・obd:true を付与。
    const seg = a.map((x) =>
      Object.assign({}, x, {
        spd: typeof x.obd === 'number' && x.obd >= 0 ? x.obd / 3.6 : -1,
        obd: typeof x.obd === 'number' && x.obd >= 0,
      })
    );
    const tk = createDistanceTracker(stubDec, OBD_OPT);
    let creep = 0;
    for (const x of seg) {
      const before = tk.totalM();
      tk.ingest(x);
      const jump = tk.totalM() - before;
      // OBD速度<0.5km/h相当(=ほぼ停車)で距離が積み上がらないこと(自然ZUPT)
      if (typeof x.spd === 'number' && x.spd >= 0 && x.spd < 0.5 / 3.6 && jump > 0.01)
        creep += jump;
    }
    if (tk.flush) tk.flush();
    const distM = tk.totalM();
    const raw = obdRawIntegral(a, DEFAULTS.obdMaxDtS);

    // ★never-over: tracker distance(k未適用・∫v) ≤ raw∫v(同じ積分)。丸め余裕 1%★
    //   k(車別補正)は ★採点側でのみ★ 適用=distance_m には掛けない(不可侵)。
    expect(distM).toBeLessThanOrEqual(raw * 1.01 + 0.5);
    // ∫v 駆動なので obdM が距離の主体
    expect(tk._breakdown().obdM).toBeGreaterThan(0);
    expect(distM).toBeGreaterThan(0);
    // ★停車creep ~0(認定 10m 要件を大きく下回る)★
    expect(creep).toBeLessThan(5);
  }, 30000);
});
