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
  mutate: ['scripts/zeroact-test-commons/property-test-helpers.js'],
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
