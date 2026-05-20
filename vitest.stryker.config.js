// vitest.stryker.config.js (Phase 1 基盤・2026-05-21・新規)
// ★設計変更宣言 Phase 1 (2026-05-21): Stryker 専用 vitest 設定
//   理由: Stryker sandbox は ignorePatterns で data/ を除外する (= heap OOM 対策・stryker.config.mjs L78)。
//         そのため・新規 tests/replay-mm-worker/* は・ehime data を load しようとして
//         sandbox 内で ENOENT で fail する。
//   対応: stryker run 時のみ・tests/replay-mm-worker/ を vitest exclude に追加して skip する。
//         通常 test 実行 (= vitest.config.js 経由) では既存通り含めて実行する (= 既存挙動不変)。
//
//   絶対ルール準拠:
//     ・既存 vitest.config.js は無変更 (= 通常 test 実行は影響なし)
//     ・stryker.config.mjs の vitest.configFile を本 file 指定に切替で配線

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    include: ['tests/**/*.test.js'],
    exclude: [
      'tests/e2e/**',
      'node_modules/**',
      // Phase 1 (2026-05-21): Stryker sandbox は data/ を除外するため ehime data load 不可
      // 通常 vitest 実行では include する (= vitest.config.js は無変更)
      'tests/replay-mm-worker/**',
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['js/**/*.js'],
      exclude: ['js/firebase.js', 'data/**'],
    },
  },
});
