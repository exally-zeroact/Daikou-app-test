// tests/integration/business-distance-carryover.test.js
// ZEROact 共通テスト基盤 (2026-05-18 新規・Step P0-⑤ / 全32件)
//
// 検証対象: meter.js business_distance_m の trip 跨ぎ carry-over + 業務終了 reset
//   L1180 setBusinessDistance(m): 復元値セット (= localStorage 復帰時の業務単位累積復元)
//   L545/L578 reset(): trip 単位 reset では business_distance_m を引き継ぐ (prevBusinessDist)
//   L657-659 businessEnd(): business_distance_m=0 に reset
//   L392/L461 _onMmWorkerMessage / Off-Road retroactive: state.running=true 時に累積
//
// 背景: タスクキル → reload で localStorage の daikou_business_state を復元するとき、
//   business.js が Meter.setBusinessDistance(prev_business_distance_m) を呼んで復元する。
//   per-trip reset (= Meter.reset()) と業務単位 reset (= Meter.businessEnd()) を
//   厳密に区別する設計。
//
// 絶対ルール準拠:
//   js/meter.js は触らない absolute。fake worker で trip / business 跨ぎ sequence を駆動。

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

describe('business-distance-carryover (meter.js L1180 + L545/L578 + L657)', () => {
  let Meter, fakeWorker;
  beforeEach(() => {
    mockGPS();
    Meter = loadMeter();
    Meter.setFareConfig(DEFAULT_FARE_CONFIG);
    Meter.reset();
    fakeWorker = makeFakeWorker();
    Meter.setMapMatcher(fakeWorker);
  });
  afterEach(() => {
    if (Meter) Meter.reset();
    delete globalThis.GPS;
  });

  it('setBusinessDistance(1500) で state.business_distance_m=1500 に復元される', () => {
    Meter.setBusinessDistance(1500);
    expect(Meter.getState().business_distance_m).toBe(1500);
  });

  it('setBusinessDistance(0) で state.business_distance_m=0 に', () => {
    Meter.setBusinessDistance(0);
    expect(Meter.getState().business_distance_m).toBe(0);
  });

  it('setBusinessDistance(負値) で state.business_distance_m=0 (fallback)', () => {
    Meter.setBusinessDistance(-100);
    expect(Meter.getState().business_distance_m).toBe(0);
  });

  it('setBusinessDistance(NaN) で state.business_distance_m=0 (fallback)', () => {
    Meter.setBusinessDistance(NaN);
    expect(Meter.getState().business_distance_m).toBe(0);
  });

  it('setBusinessDistance(string) で state.business_distance_m=0 (fallback)', () => {
    Meter.setBusinessDistance('1500');
    expect(Meter.getState().business_distance_m).toBe(0);
  });

  it('setBusinessDistance(undefined) で state.business_distance_m=0 (fallback)', () => {
    Meter.setBusinessDistance(undefined);
    expect(Meter.getState().business_distance_m).toBe(0);
  });

  it('Meter.reset() (= per-trip reset) で business_distance_m は維持される', () => {
    Meter.setBusinessDistance(2000);
    expect(Meter.getState().business_distance_m).toBe(2000);
    Meter.reset();
    // trip 単位 reset では business は引き継ぐ (prevBusinessDist)
    expect(Meter.getState().business_distance_m).toBe(2000);
    // ただし distance_m / fare_yen は 0 化
    expect(Meter.getState().distance_m).toBe(0);
    expect(Meter.getState().fare_yen).toBe(0);
  });

  it('Meter.businessEnd() で business_distance_m=0 に reset', () => {
    Meter.setBusinessDistance(3000);
    Meter.start();
    expect(Meter.getState().business_distance_m).toBe(3000);
    Meter.businessEnd();
    expect(Meter.getState().business_distance_m).toBe(0);
  });

  it('復帰後の trip 継続で mmIncrementM 累積が business_distance_m に加算される', () => {
    // 復元 (= localStorage 復帰時に相当)
    Meter.setBusinessDistance(1000);
    Meter.start(); // state.running=true
    Meter._setDrainMmUntil(0);

    // 復帰後の trip で mmResult 受信 → 累積
    fakeWorker._dispatch({ type: 'mmResult', mmIncrementM: 200, snapped: true, committed: true });
    expect(Meter.getState().business_distance_m).toBe(1200);

    fakeWorker._dispatch({ type: 'mmResult', mmIncrementM: 300, snapped: true, committed: true });
    expect(Meter.getState().business_distance_m).toBe(1500);
  });

  it('state.running=false で mmIncrement 受信時 business_distance_m は加算しない (L391 ガード)', () => {
    Meter.setBusinessDistance(1000);
    // running=false (= 業務開始してない / stop 状態)
    Meter._setDrainMmUntil(0);
    fakeWorker._dispatch({ type: 'mmResult', mmIncrementM: 200, snapped: true, committed: true });
    expect(Meter.getState().business_distance_m).toBe(1000); // 不変
    expect(Meter.getState().distance_m).toBe(0);
  });

  it('複数 trip 跨ぎで business_distance_m が累積する (= trip A 終了 → trip B 開始)', () => {
    // trip A 開始
    Meter.start();
    Meter._setDrainMmUntil(0);
    fakeWorker._dispatch({ type: 'mmResult', mmIncrementM: 500, snapped: true, committed: true });
    expect(Meter.getState().business_distance_m).toBe(500);

    // trip A 終了 (= Meter.reset で trip 内 distance_m リセット・business は引き継ぐ)
    Meter.reset();
    expect(Meter.getState().distance_m).toBe(0);
    expect(Meter.getState().business_distance_m).toBe(500);

    // trip B 開始
    Meter.start();
    Meter._setDrainMmUntil(0);
    fakeWorker._dispatch({ type: 'mmResult', mmIncrementM: 700, snapped: true, committed: true });
    expect(Meter.getState().business_distance_m).toBe(1200); // 500 + 700
    expect(Meter.getState().distance_m).toBe(700); // trip B 内のみ
  });

  it('businessEnd() で business_distance_m が 0・次業務開始時も 0 (= 業務跨ぎは引き継がない)', () => {
    Meter.start();
    Meter._setDrainMmUntil(0);
    fakeWorker._dispatch({ type: 'mmResult', mmIncrementM: 800, snapped: true, committed: true });
    expect(Meter.getState().business_distance_m).toBe(800);

    // 業務終了
    Meter.businessEnd();
    expect(Meter.getState().business_distance_m).toBe(0);

    // 次業務開始
    Meter.start();
    Meter._setDrainMmUntil(0);
    fakeWorker._dispatch({ type: 'mmResult', mmIncrementM: 100, snapped: true, committed: true });
    // 新業務は 0 から累積
    expect(Meter.getState().business_distance_m).toBe(100);
  });

  it('setBusinessDistance(0) 後 Meter.start() → 復元値 0 でも mm 累積で増加する', () => {
    Meter.setBusinessDistance(0);
    Meter.start();
    Meter._setDrainMmUntil(0);
    fakeWorker._dispatch({ type: 'mmResult', mmIncrementM: 250, snapped: true, committed: true });
    expect(Meter.getState().business_distance_m).toBe(250);
  });
});
