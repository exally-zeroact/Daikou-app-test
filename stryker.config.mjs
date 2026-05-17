/* eslint-env node */
// Stryker.js config (2026-05-17 新規・Stage 1・解釈A)
// 目的: property test の網羅性 KPI 測定
// 方針:
//   ・testRunner = vitest (tests/property/ のみ走らせる)
//   ・mutate 対象 = tests/lib/distance.js + tests/lib/snap.js (test util のみ)
//   ・絶対ルール準拠: meter.js / gps.js 等の本体コードは mutate しない
//                    (= 課金根拠 distance_m コードには絶対に触れない)
// 司さん判断: property test が test util の mutation を catch するかで網羅性を測る。

export default {
  testRunner: 'vitest',
  vitest: {
    configFile: 'vitest.config.js',
  },
  mutate: ['tests/lib/distance.js', 'tests/lib/snap.js'],
  reporters: ['progress', 'clear-text', 'html'],
  thresholds: { high: 80, low: 60, break: null },
  coverageAnalysis: 'perTest',
  tempDirName: '.stryker-tmp',
  cleanTempDir: true,
  htmlReporter: { fileName: 'reports/mutation/mutation.html' },
};
