/* eslint-env node */
// dependency-cruiser config (2026-05-17 新規・Stage 1)
// 目的: 循環依存禁止 + module 境界ルール検査
// 対象: js/ + scripts/zeroact-test-commons/
// 既存ファイル無変更原則: 違反検出時は別 commit で修正・このルール自体は触らない

export default {
  forbidden: [
    {
      name: 'no-circular',
      severity: 'error',
      comment: '循環依存禁止 (= require/import の輪を作らない)',
      from: {},
      to: { circular: true },
    },
    {
      name: 'no-orphans',
      severity: 'warn',
      comment: '孤立モジュール (entry から到達不能) は warn',
      from: {
        orphan: true,
        pathNot: [
          '\\.d\\.ts$',
          '\\.test\\.js$',
          '\\.spec\\.js$',
          '\\.config\\.(js|mjs)$',
          'tests/lib/',
        ],
      },
      to: {},
    },
    {
      name: 'no-unresolvable',
      severity: 'error',
      comment: '解決できない require/import (= 存在しない module) は error',
      from: {},
      to: { couldNotResolve: true },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    includeOnly: '^(js|scripts/zeroact-test-commons)/',
    exclude: 'node_modules|data|coverage|test-results',
    reporterOptions: {
      text: { highlightFocused: true },
    },
  },
};
