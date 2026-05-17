/* eslint-env node */
// Lighthouse CI config (2026-05-17 新規・Stage 1)
// 目的: PWA / Performance / Accessibility / SEO のスコア閾値ガード
// 起動: ローカル http-server で localhost:3000 にアプリを起動 → Lighthouse 実行
// 既存 playwright webServer と同じ起動方式 (= http-server -p 3000)

module.exports = {
  ci: {
    collect: {
      url: ['http://localhost:3000/'],
      startServerCommand: 'npx http-server -p 3000 -c-1 -s',
      startServerReadyPattern: 'Available on',
      startServerReadyTimeout: 30000,
      numberOfRuns: 1,
      settings: {
        preset: 'desktop',
        chromeFlags: '--no-sandbox --disable-dev-shm-usage',
      },
    },
    assert: {
      assertions: {
        'categories:performance': ['warn', { minScore: 0.7 }],
        'categories:accessibility': ['warn', { minScore: 0.9 }],
        'categories:best-practices': ['warn', { minScore: 0.8 }],
        'categories:seo': ['warn', { minScore: 0.9 }],
      },
    },
    upload: {
      target: 'temporary-public-storage',
    },
  },
};
