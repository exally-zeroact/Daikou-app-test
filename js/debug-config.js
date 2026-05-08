// ===========================================
// debug-config.js
// 環境変数によるデバッグ機能制御（2026/04/26追加）
// ★本番ドメイン移行時に自動的に無効化される
// ★リリース時の削除作業ゼロ化
// ===========================================
const DEBUG = (() => {
  const hostname = location.hostname;
  const search = location.search;

  // 本番ドメイン allowlist（ここに載った hostname だけが prod 扱い）
  // 本番Vercel URL（daikou-app.vercel.app）も独自ドメイン移行後の独自ドメインも、ここに追記すれば prod になる
  const PRODUCTION_HOSTS = new Set([
    'daikou-app.vercel.app',
  ]);

  // 環境判定
  const isProductionHost = PRODUCTION_HOSTS.has(hostname);
  // vercel.app サブドメインのうち、prod 以外（test 本URL / branch preview など）を preview 扱い
  const isVercelPreview = hostname.endsWith('.vercel.app') && !isProductionHost;
  const isLocalhost = (
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname.startsWith('192.168.')
  );
  const hasDebugParam = search.includes('debug=1');

  // 本番環境判定（PRODUCTION_HOSTS に一致 or 独自ドメイン）
  const isProduction = isProductionHost || (!isVercelPreview && !isLocalhost);

  return {
    // テスト環境（vercel.app or localhost）→ デバッグ機能ON
    // 本番環境でも ?debug=1 付ければデバッグ機能ON
    enabled: isVercelPreview || isLocalhost || hasDebugParam,

    // Eruda 表示判定
    // ?debug=1 / localhost → 自動表示
    // vercel.app プレビュー → 自動表示（テスト中なので）
    showEruda: isVercelPreview || isLocalhost || hasDebugParam,

    // 本番環境判定（ログ出力制御で使用）
    isProduction: isProduction,
    isVercelPreview: isVercelPreview,
    isLocalhost: isLocalhost,
    hasDebugParam: hasDebugParam,
  };
})();

// ===========================================
// Eruda 組み込み（条件付き）
// スマホで F12 Console が見れる神ツール
// ===========================================
(function loadEruda(){
  if(!DEBUG.showEruda) return;

  const s = document.createElement('script');
  s.src = 'https://cdn.jsdelivr.net/npm/eruda';
  s.onload = function(){
    if(typeof eruda !== 'undefined'){
      eruda.init();
      console.log('[DEBUG] Eruda 起動完了');
      console.log('[DEBUG] 環境:', {
        vercelPreview: DEBUG.isVercelPreview,
        localhost: DEBUG.isLocalhost,
        production: DEBUG.isProduction,
        debugParam: DEBUG.hasDebugParam,
      });
    }
  };
  s.onerror = function(){
    console.warn('[DEBUG] Eruda 読み込み失敗（オフライン or CDN問題）');
  };
  document.head.appendChild(s);
})();

// 起動ログ（テスト環境のみ）
if(DEBUG.enabled){
  console.log('[DEBUG] テスト環境で起動中:', location.hostname + location.search);
}

// ===========================================
// dlog: デバッグログヘルパー（2026/04/26追加）
// テスト環境でのみ出力・本番では完全に無効
// ===========================================
window.dlog = function(){
  if(!DEBUG.enabled) return;
  console.log.apply(console, arguments);
};
