import { defineConfig } from 'vitest/config';

// ★重いテストだけ 直列の別まとまりで回す (2026-08-08)★
//
//   ★なぜ★ 全体実行で赤くなるフラキーを測ったところ、
//     テスト193本のうち ★上位4本で全体の 8割★ を占めていた（手元・実測）:
//        62.7秒 replay-mm-worker/pipeline-gate.test.js
//        39.5秒 replay-mm-worker/index.test.js
//        38.7秒 integration/address-chiban-build.test.js
//        33.9秒 integration/real-trace-creep-stationary.test.js
//     この4本は ★実Workerを起こして走行を再生する★ 物で、同時に走ると互いに待たされる。
//     real-trace-creep-stationary は 単独13.7秒 / 全体実行107秒 ＝ ★8倍★ 遅くなっていた。
//
//   ★直し方★ この4本だけ fileParallelism:false（＝1本ずつ順番に）で回す。
//     残り189本は今までどおり並列。★テストの中身は1行も減らしていない★
//     （replay の量を減らして検査を薄めることはしない）。
const HEAVY = [
  'tests/replay-mm-worker/pipeline-gate.test.js',
  'tests/replay-mm-worker/index.test.js',
  'tests/integration/address-chiban-build.test.js',
  'tests/integration/real-trace-creep-stationary.test.js',
];

const common = {
  environment: 'node',
  globals: true,
};

export default defineConfig({
  test: {
    ...common,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['js/**/*.js'],
      exclude: ['js/firebase.js', 'data/**'],
    },
    projects: [
      {
        test: {
          ...common,
          name: 'heavy',
          include: HEAVY,
          // ★1本ずつ順番に（互いに待たせない）★
          fileParallelism: false,
        },
      },
      {
        test: {
          ...common,
          name: 'rest',
          include: ['tests/**/*.test.js'],
          exclude: ['tests/e2e/**', 'node_modules/**', ...HEAVY],
        },
      },
    ],
  },
});
