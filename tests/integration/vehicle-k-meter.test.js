// tests/integration/vehicle-k-meter.test.js
// ★OBD per-vehicle k は pipeline ラチェットへ一本化 (2026-06-13・司さん裁定A)★
//   旧設計(2026-06-12): meter が OBD∫v駆動delta に手動 _activeVehicleK を乗算(source-aware k)。
//   新設計: pipeline-distance が Doppler自動ラチェット(kNow)で per-vehicle スケールを既に適用 →
//     meter で再度乗算すると ★二重適用=過大課金(過大ゼロ違反)★。∴ meter は ★全 delta ×1.0(恒等)★。
//   本テストは「meter は手動k/source に依らず ×1.0(二重適用ゼロ)」を契約として固定する。
//   calibrateVehicleK/_activeVehicleK は dormant(距離に非作用・UI表示/将来用に学習関数は温存)。
//   過大ゼロは pipeline の Doppler下側分位天井が構造保証(別テスト: obd-doppler-ceiling/obd-overcount-zero)。

const path = require('path');
const METER_JS_PATH = path.join(__dirname, '..', '..', 'js', 'meter.js');

function loadMeter() {
  delete require.cache[require.resolve(METER_JS_PATH)];
  return require(METER_JS_PATH);
}

const DEFAULT_FARE_CONFIG = {
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

function mockGPS() {
  globalThis.GPS = {
    calcDistance: () => 0,
    calcDistance3D: () => 0,
    setRoadType: () => {},
  };
}

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
    postMessage() {},
    _dispatch(data) {
      for (const h of handlers) h({ data });
    },
  };
}

// ★source-aware k (2026-06-12)★: 随伴車k は ★OBD∫v駆動delta だけ★に適用(GPS駆動は×1.0)。
//   k機構(clamp/EWMA/業務ロック)の検証は OBD-tag delta で行う。GPS×1.0 は別途 (b2) で検証。
function deltaResult(deltaM, src) {
  return {
    type: 'mmResult',
    pipelineDeltaM: deltaM,
    pipelineDeltaSrc: src || 'obd',
    snapped: true,
    committed: true,
  };
}

// 業務を開始して running+business_active+drain解除にする
function startBusiness(Meter) {
  Meter.setBusinessActive(true); // false→true で k ロック
  Meter.start(); // running=true (+ k 再解決の保険)
  Meter._setDrainMmUntil(0); // drain window 解除 (= delta を捨てない)
}

function setProfile(k) {
  globalThis.window = globalThis;
  globalThis.DK_VEHICLE_PROFILE =
    k == null ? { maker: 'X', model: 'Y' } : { maker: 'X', model: 'Y', k };
  // _resolveVK は window.DK_VEHICLE_PROFILE を読む (window===globalThis)
}

describe('随伴車別 k 校正 (meter 層器差定数)', () => {
  let Meter, w;
  beforeEach(() => {
    mockGPS();
    delete globalThis.DK_VEHICLE_PROFILE;
    globalThis.window = globalThis;
    Meter = loadMeter();
    Meter.setFareConfig(DEFAULT_FARE_CONFIG);
    Meter.reset();
    w = makeFakeWorker();
    Meter.setMapMatcher(w);
  });
  afterEach(() => {
    if (Meter) Meter.reset();
    delete globalThis.GPS;
    delete globalThis.DK_VEHICLE_PROFILE;
  });

  it('(a) profile無し(既定k=1.0)→ distance_m/business_distance_m/mm_distance_m が全て生delta合計と一致(1byte不変)', () => {
    setProfile(null); // k フィールド無し → 1.0
    startBusiness(Meter);
    [100, 200, 150].forEach((d) => w._dispatch(deltaResult(d)));
    const s = Meter.getState();
    expect(s.distance_m).toBeCloseTo(450, 6);
    expect(s.business_distance_m).toBeCloseTo(450, 6);
    expect(s.mm_distance_m).toBeCloseTo(450, 6);
  });

  it('(b) ★二重適用ゼロ★: 手動k=1.005でも distance_m/business は ×1.0(pipelineラチェットが per-vehicle k)', () => {
    setProfile(1.005);
    startBusiness(Meter);
    [100, 200, 150].forEach((d) => w._dispatch(deltaResult(d)));
    const s = Meter.getState();
    expect(s.distance_m).toBeCloseTo(450, 4); // ×1.0 (×1.005でない=二重適用なし)
    expect(s.business_distance_m).toBeCloseTo(450, 4);
    expect(s.mm_distance_m).toBeCloseTo(450, 4); // RAW
  });

  it('(b2) source 不問で ×1.0: OBD駆動も GPS駆動も meter は手動k非適用(二重適用ゼロ)', () => {
    setProfile(1.005);
    startBusiness(Meter);
    w._dispatch(deltaResult(100, 'gps')); // GPS駆動 → ×1.0
    w._dispatch(deltaResult(200, 'obd')); // OBD駆動 → ×1.0 (旧: ×1.005 で二重→廃止)
    const s = Meter.getState();
    expect(s.distance_m).toBeCloseTo(300, 4); // 100 + 200 (両方×1.0)
    expect(s.mm_distance_m).toBeCloseTo(300, 4);
  });

  it('(c) 壊れた手動k=1.65 を注入しても distance に影響なし(×1.0・二重過大の経路自体が無い)', () => {
    setProfile(1.65);
    startBusiness(Meter);
    w._dispatch(deltaResult(1000));
    const s = Meter.getState();
    expect(s.distance_m).toBeCloseTo(1000, 4); // ×1.0 (1650/1020でない=手動k非作用)
    expect(s.mm_distance_m).toBeCloseTo(1000, 4);
  });

  it('(c2) 手動k=0.5 注入も distance に影響なし(×1.0)', () => {
    setProfile(0.5);
    startBusiness(Meter);
    w._dispatch(deltaResult(1000));
    expect(Meter.getState().distance_m).toBeCloseTo(1000, 4); // ×1.0 (900でない)
  });

  it('(d) 業務途中で profile.k を変えても distance は ×1.0 のまま(手動k は距離に非作用)', () => {
    setProfile(1.005);
    startBusiness(Meter);
    w._dispatch(deltaResult(100)); // ×1.0 = 100
    globalThis.DK_VEHICLE_PROFILE.k = 0.9; // 業務途中で改ざんしても距離に効かない
    w._dispatch(deltaResult(100)); // ×1.0 = 100
    const s = Meter.getState();
    expect(s.distance_m).toBeCloseTo(200.0, 4); // 100 + 100 (×1.0)
    expect(s.mm_distance_m).toBeCloseTo(200, 4);
  });

  describe('calibrateVehicleK (k学習)', () => {
    it('(e) ★calibrateVehicleK は dormant★: 学習しても distance_m は ×1.0 のまま(学習kが距離に漏れない=二重適用ゼロ)', () => {
      setProfile(1.0);
      startBusiness(Meter);
      // business は RAW = 10000 (×1.0)
      for (let i = 0; i < 100; i++) w._dispatch(deltaResult(100));
      expect(Meter.getState().business_distance_m).toBeCloseTo(10000, 2);
      // 学習を発火(k を 1.0 超へ動かそうとする)
      Meter.calibrateVehicleK(10300);
      // ★学習後も distance は ×1.0★: 次の delta=100 はそのまま +100 (×学習k でない=距離非作用)
      const before = Meter.getState().distance_m;
      w._dispatch(deltaResult(100, 'obd'));
      expect(Meter.getState().distance_m).toBeCloseTo(before + 100, 4);
    });

    it('(f1) 短業務 D<1000m は拒否(GPS脱落/誤校正防止)・k 不変', () => {
      setProfile(1.0);
      startBusiness(Meter);
      w._dispatch(deltaResult(500)); // business=500 < 1000
      const r = Meter.calibrateVehicleK(495);
      expect(r.ok).toBe(false);
      expect(
        globalThis.DK_VEHICLE_PROFILE.k == null || globalThis.DK_VEHICLE_PROFILE.k === 1.0
      ).toBe(true);
    });

    it('(f2) 1業務で5%超の急変は拒否(異常走行/メーター誤入力)', () => {
      setProfile(1.0);
      startBusiness(Meter);
      for (let i = 0; i < 100; i++) w._dispatch(deltaResult(100)); // raw=10000
      // cert=11000 → sample=1.10 (|1.10/1.0-1|=0.10>0.05) 拒否
      const r = Meter.calibrateVehicleK(11000);
      expect(r.ok).toBe(false);
    });

    it('(g) 保守EWMA: 1業務が k を支配しない(新値3割)', () => {
      setProfile(1.0);
      startBusiness(Meter);
      for (let i = 0; i < 100; i++) w._dispatch(deltaResult(100)); // raw=10000
      // cert=10400 → sample=1.04 (許容内) → k=0.3*1.04+0.7*1.0=1.012 (VK_MAX=1.02 未クランプ)
      const r = Meter.calibrateVehicleK(10400);
      expect(r.ok).toBe(true);
      expect(globalThis.DK_VEHICLE_PROFILE.k).toBeCloseTo(1.012, 4); // EWMA 1.012 < VK_MAX 1.02
    });

    it('(h) never-over: cert(真値以下) を学習基準 → 次業務の k 適用後距離 ≤ cert', () => {
      setProfile(1.0);
      startBusiness(Meter);
      for (let i = 0; i < 100; i++) w._dispatch(deltaResult(100)); // raw=10000
      const cert = 10300; // 真値以下の認定メーター読み (raw比+3%)
      Meter.calibrateVehicleK(cert); // k=0.3*1.03+0.7*1.0=1.009
      const k = globalThis.DK_VEHICLE_PROFILE.k;
      // 次業務 (同じ raw=10000) の校正後距離
      const nextCalibrated = 10000 * k;
      expect(nextCalibrated).toBeLessThanOrEqual(cert + 1e-6); // ≤ cert (過大ゼロ側)
    });
  });
});
