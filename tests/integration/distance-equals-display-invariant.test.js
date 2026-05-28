// tests/integration/distance-equals-display-invariant.test.js
//
// ★2026-05-28 PM 再構築方針 STEP 1 テストツール先行 (= 司さん指示):
//   最高精度の本質 = 距離 = 表示 = 道路 polyline 累積 1 本 (= Google MM 式統一)。
//   既存の α-β filter / 多層 catch-up / display 別計算 = 齟齬の元凶 → ★削除予定★。
//   新方針: display_distance_m == distance_m + tier2_pending_m の 1 行同期。
//
// 本 fixture は ★新方針 (= 距離 = 表示 完全一致) を invariant として強制★ する。
// ★現状の α-β filter 実装では FAIL する★ → Step 2 実装で緑化する想定。
//
// 絶対ルール準拠:
//   ・distance_m / calcFare / running gate / business_active gate = 1byte 不変
//   ・本 fixture は display 専用 layer の動作のみ assert
//   ・[A] 距離 = 表示 invariant 強制

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

describe('★新方針 STEP 1: 距離 = 表示 invariant (= Google MM 式統一・齟齬構造的にゼロ)', () => {
  let Meter;
  const BASE_TS = 1714100000000;

  function gps(t, opts) {
    opts = opts || {};
    const speedKmh = opts.speedKmh != null ? opts.speedKmh : 36;
    const moveM = (speedKmh / 3.6) * t;
    const dLat = moveM / 111132;
    return {
      lat: 33.84 + dLat,
      lng: 132.7656,
      altitude: 0,
      accuracy: opts.accuracy != null ? opts.accuracy : 5,
      speedKmh,
      isStationary: opts.isStationary || false,
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

  // ─── [A-1] trip 側 距離 = 表示 invariant ────────────────────────
  it('A-1: trip display_distance_m == distance_m + tier2_pending_m が任意 step で成立', () => {
    Meter.update(gps(0, { speedKmh: 36 }));
    for (let t = 5; t <= 60; t += 5) {
      Meter.update(gps(t, { speedKmh: 36 }));
      const s = Meter.getState();
      const expected = (s.distance_m || 0) + (s.tier2_pending_m || 0);
      // ★新方針: display は distance_m + tier2 と完全一致 (= 1 行同期・齟齬ゼロ)
      // ★現状の α-β filter では・filter 出力で乖離する★ → FAIL 想定
      const diff = Math.abs(s.display_distance_m - expected);
      if (diff > 0.01) {
        throw new Error(
          `A-1 FAIL: step=${t} display=${s.display_distance_m.toFixed(2)} ≠ ` +
            `distance_m+tier2=${expected.toFixed(2)} (diff=${diff.toFixed(2)})`
        );
      }
    }
  });

  // ─── [A-2] business 側 距離 = 表示 invariant ────────────────────
  it('A-2: business display == business_distance_m + business_tier2_pending_m が任意 step で成立', () => {
    if (typeof Meter.businessStart === 'function') {
      Meter.businessStart();
    }
    Meter.update(gps(0, { speedKmh: 36 }));
    for (let t = 5; t <= 60; t += 5) {
      Meter.update(gps(t, { speedKmh: 36 }));
      const s = Meter.getState();
      const expected = (s.business_distance_m || 0) + (s.business_tier2_pending_m || 0);
      const diff = Math.abs((s.business_display_distance_m || 0) - expected);
      if (diff > 0.01) {
        throw new Error(
          `A-2 FAIL: step=${t} business_display=${(s.business_display_distance_m || 0).toFixed(2)} ≠ ` +
            `business+tier2=${expected.toFixed(2)} (diff=${diff.toFixed(2)})`
        );
      }
    }
  });

  // ─── [A-3] 単調維持 (= 後退禁止) ─────────────────────────────
  it('A-3: display_distance_m が任意 step で単調非減少 (= 後退禁止)', () => {
    Meter.update(gps(0, { speedKmh: 36 }));
    let prev = Meter.getState().display_distance_m || 0;
    for (let t = 5; t <= 60; t += 5) {
      Meter.update(gps(t, { speedKmh: 36 }));
      const s = Meter.getState();
      if (s.display_distance_m < prev) {
        throw new Error(
          `A-3 FAIL: step=${t} display=${s.display_distance_m.toFixed(2)} < prev=${prev.toFixed(2)}`
        );
      }
      prev = s.display_distance_m;
    }
  });

  // ─── [A-4] 課金収束 (= 停車時・display == distance_m に一致) ──────
  it('A-4: 停車中 (= tier2_pending_m=0) で display_distance_m == distance_m', () => {
    Meter.update(gps(0, { speedKmh: 36 }));
    Meter.update(gps(10, { speedKmh: 36 }));
    const s0 = Meter.getState();
    // 停車 (= isStationary=true) で・tier2 が 0 に収束する想定
    // ただし・現状実装では tier2 は別経路・停車中も snapshot 据え置きの可能性あり
    // 本 invariant は「停車かつ tier2=0 のとき display == distance_m」
    if ((s0.tier2_pending_m || 0) === 0) {
      const diff = Math.abs(s0.display_distance_m - s0.distance_m);
      if (diff > 0.01) {
        throw new Error(
          `A-4 FAIL: tier2=0 のとき display=${s0.display_distance_m.toFixed(2)} ≠ distance_m=${s0.distance_m.toFixed(2)}`
        );
      }
    }
  });

  // ─── [A-5] running=false (= 空車中) でも business 側 invariant 成立 ─
  it('A-5: running=false でも business_display == business_distance_m + business_tier2_pending_m', () => {
    if (typeof Meter.businessStart === 'function') {
      Meter.businessStart();
    }
    Meter.stop(); // running=false
    Meter.update(gps(0, { speedKmh: 36 }));
    Meter.update(gps(10, { speedKmh: 36 }));
    const s = Meter.getState();
    const expected = (s.business_distance_m || 0) + (s.business_tier2_pending_m || 0);
    const diff = Math.abs((s.business_display_distance_m || 0) - expected);
    if (diff > 0.01) {
      throw new Error(
        `A-5 FAIL: running=false business_display=${(s.business_display_distance_m || 0).toFixed(2)} ≠ ` +
          `business+tier2=${expected.toFixed(2)}`
      );
    }
  });
});
