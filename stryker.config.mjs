/* eslint-env node */
// Stryker.js config (2026-05-17 新規・Stage 1・解釈A)
// 目的: property test の網羅性 KPI 測定
// 方針:
//   ・testRunner = vitest (tests/property/ のみ走らせる)
//   ・mutate 対象 = tests/lib/distance.js + tests/lib/snap.js (test util のみ)
//   ・絶対ルール準拠: meter.js / gps.js 等の本体コードは mutate しない
//                    (= 課金根拠 distance_m コードには絶対に触れない)
// 司さん判断: property test が test util の mutation を catch するかで網羅性を測る。
//
// ★設計変更宣言 (2026-05-18・heap OOM 対策):
//   旧: ignorePatterns 未指定 → ProjectReader が data/ 配下 16,682 ファイル
//       + 全 47 県 roads 等を scan して JS heap 4GB を超過 (OOM)
//   新: ignorePatterns で data/ + 大量データ dir を除外
//       + testRunnerNodeArgs で test runner sub-process の heap を 8GB に拡張
//   絶対ルール準拠: mutate 範囲 (tests/lib/) は無変更・課金ロジック影響なし

export default {
  testRunner: 'vitest',
  vitest: {
    configFile: 'vitest.config.js',
    // CommonJS require() 経由で property-test-helpers.js を import しているため
    // Vitest related 探索が機能せず No tests were found エラー。全 test 走らせる設定で対応。
    related: false,
  },
  // ─── ダイコメ知識注入 (2026-05-18) ───────────────────────────────
  //
  // 【絶対ルール】distance_m は課金根拠・絶対不可侵
  //   GPS 直線距離での課金禁止・道路ジオメトリ沿いのみ
  //
  // 【distance_m 更新 5 経路 (verified meter.js)】
  //   L393:  Tier1 Worker B Viterbi commit (state.distance_m += m.mmIncrementM)
  //   L462:  retroactive Off-Road 起動時 (= ★絶対ルール適用外区間)
  //   L824:  gap fill GPS 消失時 (= speed × time・GPS 直線非依存)
  //   L842:  Phase 1.C Off-Road incremental (= ★絶対ルール適用外区間)
  //   L1172: setDistance 外部復元用
  //
  // 【重要変数】
  //   distance_m: 課金根拠 (絶対不可侵)
  //   business_distance_m: 業務単位累積距離 (running=true のみ加算)
  //   fare_yen: 確定料金 (= calcFare(distance_m) 純粋関数)
  //
  // 【mutate 対象方針】
  //   meter.js / gps.js / map-matcher.js / gps-worker.js / mm-data-pipeline.js は
  //   絶対 mutate 不可 (= 課金根拠 distance_m コードに変更を加える行為に該当)。
  //   司さん解釈 A 採択 (Stage 1): mutate target は test util のみで
  //   property test の網羅性 KPI を測定する。
  //
  // 本体コード (= meter.js 等) の mutation testing は将来 課金根拠の
  // 別レイヤー (= Semgrep taint rule / property test 増強) で代替する。
  //
  // ★設計変更宣言 (2026-05-18・全32件テスト追加に伴う mutate target 拡張):
  //   旧: mutate 対象 = scripts/zeroact-test-commons/property-test-helpers.js のみ
  //   新: + tests/integration/helpers/**/*.js + tests/property/helpers/**/*.js を追加
  //   理由: 新規追加 integration/property test 内で共通利用される helpers 層の
  //         論理弱点 (= テストロジック自体の bug) を mutation で検出可能にする。
  //   注意:
  //     ・テストファイル本体 (*.test.js) は mutate 対象外 (= 無限ループ防止)
  //     ・helpers/ ディレクトリは未配置時も glob 上は空マッチで害なし
  //     ・既存 property-test-helpers.js の mutate 範囲は無変更
  //     ・本体コード (meter.js / gps.js 等) は引き続き mutate 不可 (絶対ルール)
  mutate: [
    'scripts/zeroact-test-commons/property-test-helpers.js',
    'tests/integration/helpers/**/*.js',
    'tests/property/helpers/**/*.js',
  ],
  // Stryker の project file scan から除外 (= heap OOM 対策)
  ignorePatterns: [
    'data/**',
    'node_modules/**',
    'coverage/**',
    '.tmp/**',
    'tmp/**',
    'outputs/**',
    'download/**',
    'input/**',
    'test-results/**',
    '.stryker-tmp/**',
    'reports/**',
    '.git/**',
  ],
  // test runner sub-process の Node heap を 8GB に拡張
  testRunnerNodeArgs: ['--max-old-space-size=8192'],
  reporters: ['progress', 'clear-text', 'html'],
  thresholds: { high: 80, low: 60, break: null },
  coverageAnalysis: 'perTest',
  tempDirName: '.stryker-tmp',
  cleanTempDir: true,
  htmlReporter: { fileName: 'reports/mutation/mutation.html' },
};
