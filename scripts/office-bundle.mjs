// ============================================================
// scripts/office-bundle.mjs
// ★事務所だけを別の住所（別ドメイン）へ出すための、入れる物の一覧★ 2026-08-01
//
//   なぜ別の住所にするか（司さん「管理画面用のURLつくれや」）:
//     メーターと同じ住所だと、メーターのオフライン機能(sw.js)が
//     ★スマホに残っている間★は、こちらが何を直しても事務所の画面を横取りできてしまう。
//     住所を分ければブラウザの決まりでサービスワーカーは一切届かない＝原理的に起こらない。
//
//   ★ここに sw.js と manifest.json と index.html(メーター) は入れない★
//     入れるとまた同じ事故が起きる。テストで機械的に禁止している。
// ============================================================
export const OFFICE_FILES = [
  'login.html',
  'dashboard.html',
  'uriage.html',
  'kyuryo.html',
  'shukei.html',
  'js/qrcode.min.js',
  'js/dk-config.js',
  'js/dk-session.js',
  'js/uriage-agg.js',
  'js/daiko-payroll.js',
  'js/payroll-period.js',
  'js/payroll-daily.js',
  'js/getsuji-agg.js',
];

// ★絶対に入れてはいけない物★
export const OFFICE_FORBIDDEN = ['sw.js', 'manifest.json', 'index.html'];

// 事務所の住所を開いたら管理画面へ（メーターは無い）
export const OFFICE_VERCEL_JSON = {
  rewrites: [{ source: '/', destination: '/dashboard.html' }],
  headers: [
    {
      source: '/(.*)\.html',
      headers: [{ key: 'Cache-Control', value: 'no-cache, must-revalidate, max-age=0' }],
    },
    {
      source: '/js/(.*)',
      headers: [{ key: 'Cache-Control', value: 'no-cache, must-revalidate, max-age=0' }],
    },
  ],
};
