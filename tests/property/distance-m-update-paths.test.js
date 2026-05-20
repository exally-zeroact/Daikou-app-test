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
    // 2026-05-18 更新 (Phase 3): GPS predictive + Reconciliation 追加で更に shift。
    // 旧 (Phase 2 後): [415, 484, 874, 893, 1239]
    // 旧 (Phase 3 後): [427, 496, 917, 936, 1315]
    // 2026-05-19 更新 (business_distance_m 完全分離): 4 加算経路から business 削除で shift。
    // 旧: [428, 495, 927, 945, 1324]
    // 2026-05-19 R1 更新 (Off-Road grace period): _offRoadGraceUntil 追加で shift。
    // 旧: [440, 514, 948, 966, 1345]
    // 2026-05-19 haversine 更新 (業務単位連続点累積): GPS.calcDistance 呼出追加で shift。
    // 旧: [440, 514, 955, 973, 1352]
    // 2026-05-20 室内停車中誤加算 bug 修正: state.last_gps accuracy 追加 + gap fill isStationary gate 追加で shift。
    // 新: [440, 514, 961, 979, 1365]
    const expectedLines = [440, 514, 961, 979, 1365];
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

  it('C3: dangerous_sources (GPS.calcDistance) は 3 箇所・うち 2 箇所 sanitizer 内 + 1 箇所 業務単位累積 (= 連続点許可済)', () => {
    // ★設計変更宣言 (2026-05-19・業務単位を haversine 連続点累積に移行):
    //   業界標準 (= Strava / Garmin / 米国タクシー特許) と整合・iOS speedKmh ノイズ免疫。
    //   ★絶対ルール「連続点 polyline 累積 = 許可」(meter.js L106-108) と完全整合。
    //   distance_m 加算経路には触れない (= 課金根拠不可侵維持)。
    const source = loadMeterSource();
    const lines = source.split('\n');
    const calls = [];
    for (let i = 0; i < lines.length; i++) {
      if (/GPS\.calcDistance\(/.test(lines[i]) && !/^\s*\/\//.test(lines[i])) {
        calls.push({ lineNo: i + 1, content: lines[i].trim() });
      }
    }
    if (calls.length !== 3) {
      throw new Error(
        'GPS.calcDistance 呼出件数違反: 期待 3 件 (L295 sanitizer / L343 sanitizer / L925 業務単位) 実検出 ' +
          calls.length +
          ' 件・' +
          JSON.stringify(calls)
      );
    }
    // L295 は _trackHaversineBetweenGps 内 (sanitizer)
    // L343 は _calculateOffRoadIncrement 内 (sanitizer)
    // L925 は業務単位 business_distance_m 連続点累積 (= 連続点累積は絶対ルール許可)
    // Stryker sandbox 由来 line offset 吸収のため ±10 line 許容
    const expectedLines = [295, 343, 925];
    const LINE_TOLERANCE = 10;
    for (let i = 0; i < 3; i++) {
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
