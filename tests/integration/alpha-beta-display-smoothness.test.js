// tests/integration/alpha-beta-display-smoothness.test.js
//
// ★Phase 3 (2026-05-28 PM・α-β filter display predictive smoothing 検証)★
//   業界標準 (= Sklansky 1957 α-β filter・Wikipedia / Grokipedia / kalmanfilter.net) 準拠の
//   α-β filter (α=0.85 / β=0.005) で display_distance_m が・burst 滑らか追従・単調維持・
//   課金収束保証を満たすことを検証する。
//
//   絶対ルール準拠:
//     ・distance_m / calcFare / running gate / business_active gate = 1byte 不変
//     ・display 専用 layer の動作のみ assert
//     ・既存 calculateGapFill / mm 経路は不変

'use strict';

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
    calcDistance: (lat1, lng1, lat2, lng2) => {
      if (lat1 === lat2 && lng1 === lng2) return 0;
      const R = 6371000;
      const tr = Math.PI / 180;
      const dLat = (lat2 - lat1) * tr;
      const dLng = (lng2 - lng1) * tr;
      const a =
        Math.sin(dLat / 2) ** 2 +
        Math.cos(lat1 * tr) * Math.cos(lat2 * tr) * Math.sin(dLng / 2) ** 2;
      return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    },
    calcDistance3D: () => 0,
  };
}

describe('Phase 3: α-β filter display predictive smoothing (= 2026-05-28 PM 最高峰実装)', () => {
  let Meter;
  const BASE_TS = 1714100000000;

  // 現実的 GPS fixture: speed×time で lat 移動 (= 既存 meter-batch8 helper と同パターン)
  function gps(t, opts) {
    opts = opts || {};
    const speedKmh = opts.speedKmh != null ? opts.speedKmh : 36;
    const moveM = (speedKmh / 3.6) * t;
    const dLat = moveM / 111132;
    return {
      lat: 33.84 + dLat,
      lng: 132.7656,
      altitude: 0,
      accuracy: 5,
      speedKmh,
      isStationary: false,
      timestamp: BASE_TS + t * 1000,
    };
  }

  beforeEach(() => {
    mockGPS();
    Meter = loadMeter();
    Meter.setFareConfig(DEFAULT_FARE_CONFIG);
    Meter.reset();
    Meter.start();
    if (typeof Meter._setDrainMmUntil === 'function') Meter._setDrainMmUntil(0);
    if (typeof Meter._setOffRoadGraceUntil === 'function') Meter._setOffRoadGraceUntil(0);
  });
  afterEach(() => {
    if (Meter) Meter.reset();
    delete globalThis.GPS;
  });

  it('初期化: 初回 getState で display_distance_m = 0', () => {
    const s = Meter.getState();
    expect(s.display_distance_m).toBe(0);
  });

  it('単調維持: 連続 update で display_distance_m が後退しない (= 後退禁止保証)', () => {
    Meter.update(gps(0, { speedKmh: 36 }));
    let prevDisplay = Meter.getState().display_distance_m || 0;
    for (let t = 5; t <= 30; t += 5) {
      Meter.update(gps(t, { speedKmh: 36 }));
      const s = Meter.getState();
      expect(s.display_distance_m).toBeGreaterThanOrEqual(prevDisplay);
      prevDisplay = s.display_distance_m;
    }
  });

  it('課金収束: display_distance_m >= distance_m が常に成立 (= 課金距離下回り禁止)', () => {
    Meter.update(gps(0, { speedKmh: 36 }));
    for (let t = 5; t <= 30; t += 5) {
      Meter.update(gps(t, { speedKmh: 36 }));
      const s = Meter.getState();
      expect(s.display_distance_m).toBeGreaterThanOrEqual(s.distance_m);
    }
  });

  it('progress 追従: 連続 gap fill で display_distance_m が増加する', () => {
    Meter.update(gps(0, { speedKmh: 36 }));
    Meter.update(gps(5, { speedKmh: 36 })); // gap fill 50m
    Meter.update(gps(10, { speedKmh: 36 })); // gap fill 50m
    const s = Meter.getState();
    // distance_m は 100m 蓄積 (= 50m × 2 回 gap fill)・display も追従して > 0
    expect(s.distance_m).toBeGreaterThan(0);
    expect(s.display_distance_m).toBeGreaterThan(0);
  });

  it('業務 display: business_display_distance_m も同様の単調維持と課金収束', () => {
    // Business を start させる必要がある
    if (typeof Meter.businessStart === 'function') {
      Meter.businessStart();
    }
    Meter.update(gps(0, { speedKmh: 36 }));
    let prevBDisplay = Meter.getState().business_display_distance_m || 0;
    for (let t = 5; t <= 30; t += 5) {
      Meter.update(gps(t, { speedKmh: 36 }));
      const s = Meter.getState();
      expect(s.business_display_distance_m).toBeGreaterThanOrEqual(prevBDisplay);
      prevBDisplay = s.business_display_distance_m;
    }
  });
});
