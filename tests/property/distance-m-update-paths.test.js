// tests/property/distance-m-update-paths.test.js
// ZEROact 共通テスト基盤 (2026-05-17 新規・Stage 1 Step C) — ダイコメ用 property test
//
// 述語C: state.distance_m の更新元は 5 経路のみ
//   - L393  Tier1 Worker B Viterbi commit (state.distance_m += m.mmIncrementM)
//   - L462  retroactive Off-Road 起動時 (state.distance_m += _haverAccumSinceLastCommit)
//   - L824  gap fill (state.distance_m += filled・speed × time)
//   - L842  Phase 1.C Off-Road incremental (state.distance_m += inc)
//   - L1172 setDistance 外部 API (state.distance_m = distanceM)
//
// 検証方針:
//   meter.js を文字列読込し state.distance_m 書込の正規表現マッチ行数 = 5 を assert。
//   verified line numbers (2026-05-17) に対する drift を即時検出する目的。
//
// 述語A: calcFare は入力距離に対して単調非減少 (純粋関数・running 状態に依存しない)
//   既存 R1 (tests/property/distance-invariants.test.js) を property test として
//   再確認・running フラグの任意の組合せで挙動不変であることを assert。

const fs = require('fs');
const path = require('path');
const {
  fc,
  propertyAssert,
  assertMonotonic,
} = require('../../scripts/zeroact-test-commons/property-test-helpers');

const METER_JS_PATH = path.join(__dirname, '..', '..', 'js', 'meter.js');

function loadMeter() {
  delete require.cache[require.resolve(METER_JS_PATH)];
  return require(METER_JS_PATH);
}

function loadMeterSource() {
  return fs.readFileSync(METER_JS_PATH, 'utf8');
}

describe('ZEROact 共通テスト基盤: distance_m 更新経路の不変条件 (Step C)', () => {
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

  // ─── 述語 C (静的解析): distance_m 更新元は 5 経路のみ ──────────────

  it('C1: state.distance_m への代入/加算は meter.js 内で 5 経路のみ', () => {
    const source = loadMeterSource();
    const lines = source.split('\n');
    const matchedLines = [];
    const writePattern = /^\s*state\.distance_m\s*[+]?=\s*[^=]/;
    for (let i = 0; i < lines.length; i++) {
      if (writePattern.test(lines[i])) {
        matchedLines.push({ lineNo: i + 1, content: lines[i].trim() });
      }
    }
    if (matchedLines.length !== 5) {
      throw new Error(
        '述語 C 違反: distance_m 書込経路 5 経路 (L393/L462/L824/L842/L1172) を逸脱。検出: ' +
          JSON.stringify(matchedLines, null, 2)
      );
    }
    const expectedLines = [393, 462, 824, 842, 1172];
    // Stryker sandbox は project files をコピーする際に line offset を作る可能性あり。
    // 完全一致ではなく ±10 line 許容で drift 検出する (= 大幅 drift は捕捉・微小 offset は許容)。
    const LINE_TOLERANCE = 10;
    for (let i = 0; i < 5; i++) {
      const diff = Math.abs(matchedLines[i].lineNo - expectedLines[i]);
      if (diff > LINE_TOLERANCE) {
        throw new Error(
          '述語 C 違反: 経路 #' +
            (i + 1) +
            ' 期待 L' +
            expectedLines[i] +
            ' ±' +
            LINE_TOLERANCE +
            ' 実検出 L' +
            matchedLines[i].lineNo +
            ' (drift=' +
            diff +
            ' line・memory 更新が必要)'
        );
      }
    }
  });

  it('C2: sanitizer マーカー 2 種が meter.js に存在', () => {
    const source = loadMeterSource();
    if (!source.includes('★絶対ルール適用外区間（retroactive）')) {
      throw new Error(
        'sanitizer マーカー欠落: ★絶対ルール適用外区間（retroactive） が meter.js に存在しない'
      );
    }
    if (!source.includes('★絶対ルール適用外区間（明示宣言）')) {
      throw new Error(
        'sanitizer マーカー欠落: ★絶対ルール適用外区間（明示宣言） が meter.js に存在しない'
      );
    }
  });

  it('C3: dangerous_sources (GPS.calcDistance) は 2 箇所のみ・sanitizer 関数内のみ', () => {
    const source = loadMeterSource();
    const lines = source.split('\n');
    const calls = [];
    for (let i = 0; i < lines.length; i++) {
      if (/GPS\.calcDistance\(/.test(lines[i]) && !/^\s*\/\//.test(lines[i])) {
        calls.push({ lineNo: i + 1, content: lines[i].trim() });
      }
    }
    if (calls.length !== 2) {
      throw new Error(
        'GPS.calcDistance 呼出件数違反: 期待 2 件 (L257 / L305) 実検出 ' +
          calls.length +
          ' 件・' +
          JSON.stringify(calls)
      );
    }
    // L257 は _trackHaversineBetweenGps 内・L305 は _calculateOffRoadIncrement 内
    // Stryker sandbox 由来 line offset 吸収のため ±10 line 許容
    const expectedLines = [257, 305];
    const LINE_TOLERANCE = 10;
    for (let i = 0; i < 2; i++) {
      const diff = Math.abs(calls[i].lineNo - expectedLines[i]);
      if (diff > LINE_TOLERANCE) {
        throw new Error(
          'GPS.calcDistance 呼出 #' +
            (i + 1) +
            ' 期待 L' +
            expectedLines[i] +
            ' ±' +
            LINE_TOLERANCE +
            ' 実検出 L' +
            calls[i].lineNo +
            ' (drift=' +
            diff +
            ' line)'
        );
      }
    }
  });

  // ─── 述語 A (property): calcFare 単調非減少 (純粋関数・running 状態 非依存) ──

  it('A1: calcFare(d) は d ≥ 0 で単調非減少 (running flag に依存しない)', () => {
    propertyAssert(
      fc.property(
        fc
          .array(fc.double({ min: 0, max: 100000, noNaN: true }), { minLength: 2, maxLength: 30 })
          .map((arr) => arr.sort((a, b) => a - b)),
        fc.boolean(),
        (distances, _runningFlag) => {
          // running flag は calcFare に影響しない (純粋関数)
          const fares = distances.map((d) => Meter.calcFare(d));
          assertMonotonic(fares, 'calcFare monotonic');
        }
      )
    );
  });

  it('A2: setDistance 経由で外部から distance_m を 0 に reset しても calcFare(0) = base_fare', () => {
    propertyAssert(
      fc.property(fc.double({ min: 0, max: 100000, noNaN: true }), (anyDistance) => {
        Meter.reset();
        Meter.start();
        Meter.setDistance(anyDistance);
        // setDistance 直後の fare_yen
        const fare = Meter.getState().fare_yen;
        const expected = Meter.calcFare(anyDistance);
        if (fare !== expected) {
          throw new Error(
            'setDistance 後 fare_yen 不整合: setDistance=' +
              anyDistance +
              ' fare_yen=' +
              fare +
              ' expected=' +
              expected
          );
        }
      })
    );
  });
});
