// tests/property/isstationary-no-increase.test.js
// ZEROact 共通テスト基盤 (2026-05-17 新規・Stage 1 Step C) — ダイコメ用 property test
//
// 述語B: gpsResult.isStationary === true のとき state.distance_m は増加しない
//
// 2 経路を独立に検証:
//   経路 1 (meter.js L790):
//     update() 入口で if (gpsResult.isStationary) { _updateMapMatching(gpsResult); return; }
//     → 全 Tier 到達せず distance_m 不変。
//
//   経路 2 (map-matcher.js L3007):
//     msg.isStationary === true 受信時に mmIncrementM=0 / tentativeIncrementM=0 強制。
//     → 経路 1 を bypass しても Worker B 側で 0 化されるため二重防御。
//     Worker context 必須のため Node では実行不可・静的解析で pattern 存在を verify。

const fs = require('fs');
const path = require('path');
const {
  fc,
  propertyAssert,
  stationaryGpsArb,
} = require('../../scripts/zeroact-test-commons/property-test-helpers');

const METER_JS_PATH = path.join(__dirname, '..', '..', 'js', 'meter.js');
const MAP_MATCHER_JS_PATH = path.join(__dirname, '..', '..', 'js', 'map-matcher.js');

function loadMeter() {
  delete require.cache[require.resolve(METER_JS_PATH)];
  return require(METER_JS_PATH);
}

function loadSource(filePath) {
  return fs.readFileSync(filePath, 'utf8');
}

describe('ZEROact 共通テスト基盤: isStationary=true で distance_m 不変 (Step C)', () => {
  // ─── 経路 1 (meter.js L790・property test): update() 入口 早期 return ──

  describe('経路 1 (meter.js L790): update 入口で isStationary=true なら distance_m 不変', () => {
    let Meter;
    beforeEach(() => {
      Meter = loadMeter();
      Meter.setFareConfig({
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
      });
    });

    it('B1: 任意の事前 distance_m + isStationary=true GPS で distance_m 不変', () => {
      propertyAssert(
        fc.property(
          fc.double({ min: 0, max: 100000, noNaN: true }),
          fc.double({ min: 24, max: 46, noNaN: true }),
          fc.double({ min: 122, max: 146, noNaN: true }),
          (preDistance, lat, lng) => {
            Meter.reset();
            Meter.start();
            Meter.setDistance(preDistance);
            const before = Meter.getState().distance_m;
            // isStationary=true GPS を流す
            Meter.update({
              lat,
              lng,
              accuracy: 5,
              speedKmh: 0,
              isStationary: true,
              timestamp: 1714100000000,
            });
            const after = Meter.getState().distance_m;
            if (after !== before) {
              throw new Error(
                'isStationary=true で distance_m 変化: before=' +
                  before +
                  ' after=' +
                  after +
                  ' (input distance=' +
                  preDistance +
                  ')'
              );
            }
          }
        )
      );
    });

    it('B2: stationaryGpsArb (6+ 点同座標シーケンス) を連続流しても distance_m 不変', () => {
      propertyAssert(
        fc.property(
          fc.double({ min: 0, max: 50000, noNaN: true }),
          stationaryGpsArb({ lat: 33.84, lng: 132.7656 }),
          (preDistance, gpsSeq) => {
            Meter.reset();
            Meter.start();
            Meter.setDistance(preDistance);
            const before = Meter.getState().distance_m;
            for (const gps of gpsSeq) {
              Meter.update(gps);
            }
            const after = Meter.getState().distance_m;
            if (after !== before) {
              throw new Error(
                'isStationary sequence で distance_m 変化: before=' +
                  before +
                  ' after=' +
                  after +
                  ' seqLen=' +
                  gpsSeq.length
              );
            }
          }
        )
      );
    });

    it('B3: meter.js L790 に update() 入口 isStationary 早期 return が存在', () => {
      const source = loadSource(METER_JS_PATH);
      const lines = source.split('\n');
      // L790 周辺で `if (gpsResult.isStationary)` パターン + early return を確認
      // Stryker sandbox の line offset 吸収のため window を ±10 line 拡張
      // 2026-05-18 更新 (Phase 3): L839 → L867 (+28) 移動・window 同期。
      // 2026-05-19 R1 更新 (Off-Road grace period): L867 → L884 (+17) 移動・window 同期。
      const window = lines.slice(869, 904).join('\n');
      if (!/if\s*\(\s*gpsResult\.isStationary\s*\)/.test(window)) {
        throw new Error(
          'meter.js L790 周辺 (±10) に if (gpsResult.isStationary) パターン未検出 (drift detected)'
        );
      }
      if (!/_updateMapMatching\s*\(\s*gpsResult\s*\)/.test(window)) {
        throw new Error('meter.js L790 周辺 (±10) に _updateMapMatching(gpsResult) 呼出 未検出');
      }
      if (!/return\s*;/.test(window)) {
        throw new Error('meter.js L790 周辺 (±10) に early return ; 未検出');
      }
    });
  });

  // ─── 経路 2 (map-matcher.js L3007・静的解析): Worker B 出力強制 0 化 ──

  describe('経路 2 (map-matcher.js L3007): Worker B 出力強制 0 化', () => {
    it('B4: map-matcher.js L3007 に msg.isStationary 強制 0 化 pattern が存在', () => {
      const source = loadSource(MAP_MATCHER_JS_PATH);
      const lines = source.split('\n');
      // L3007 周辺で if (msg.isStationary === true) { mmIncrementM = 0; tentativeIncrementM = 0; }
      // Stryker sandbox の line offset 吸収のため window を ±10 line 拡張 (= 2990-3025)
      const window = lines.slice(2990, 3025).join('\n');
      if (!/if\s*\(\s*msg\.isStationary\s*===\s*true\s*\)/.test(window)) {
        throw new Error(
          'map-matcher.js L3007 周辺 (±10) に if (msg.isStationary === true) pattern 未検出 (drift detected)'
        );
      }
      if (!/mmIncrementM\s*=\s*0/.test(window)) {
        throw new Error('map-matcher.js L3007 周辺 (±10) に mmIncrementM = 0 代入 未検出');
      }
      if (!/tentativeIncrementM\s*=\s*0/.test(window)) {
        throw new Error('map-matcher.js L3007 周辺 (±10) に tentativeIncrementM = 0 代入 未検出');
      }
    });
  });
});
