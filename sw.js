// ===========================================
// sw.js（ServiceWorker・ダイコメPWA対応）
// 2026/04/30 更新：SWR（Stale-While-Revalidate）戦略に変更
//
// 戦略：
//   外部API（Firebase等）：ネットワークのみ
//   静的アセット（icon・manifest）：キャッシュ優先
//   道路データ・HTML・JS・CSS：SWR（キャッシュ即返し＋裏で更新）
//
// SWR の挙動：
//   1. キャッシュから即時返す（速い・オフラインOK）
//   2. 同時にネット取得（バックグラウンド）
//   3. 取得成功したらキャッシュ更新
//   4. 次回起動時に新版が反映される
//
// 効果：
//   ✅ 起動が瞬時（1ms・キャッシュから）
//   ✅ オフラインで完全動作
//   ✅ ネットつながったら自動更新（翌起動反映）
//   ✅ 業務中に急にバージョン変わらない（安全）
// ===========================================

const CACHE_NAME = 'daikome-d7a47fd';

// アイコン・manifest・start_url（"/"）をキャッシュ
// "/"のキャッシュは Chrome の installability 要件で必須
// （オフラインでも start_url が 200 を返せる必要がある）
const PRECACHE_FILES = [
  '/',
  '/history.html',
  '/settings.html',
  '/icon-192.png',
  '/icon-512.png',
  '/manifest.json',
  // ★ オフラインファースト必須バンドル（13種・全国共通データ）
  '/data/coarse-jp.js',
  '/data/pref-borders-jp.js',
  '/data/shelters-jp.js',
  '/data/emergency-medical-jp.js',
  '/data/highways-jp.js',
  '/data/stations-jp.js',
  '/data/misc-jp.js',
  '/data/faults-jp.js',
  '/data/night-clinics-jp.js',
  '/data/airports-jp.js',
  '/data/michinoeki-jp.js',
  '/data/coastline-jp.js',
  '/data/ports-jp.js',
  '/data/peaks-jp.js',
  '/data/hiking-trails-jp.js',
  '/data/railways-jp.js',
  '/data/waterways-jp.js',
  '/data/hazard-cliff-jp.js',
];

self.addEventListener('install', function(e){
  e.waitUntil(
    caches.open(CACHE_NAME).then(function(cache){
      // "/"は明示的に reload で取得（古いキャッシュを使わない）
      return Promise.all([
        cache.add(new Request('/', { cache: 'reload' })),
        cache.addAll(PRECACHE_FILES.filter(function(p){ return p !== '/'; }))
      ]);
    }).then(function(){
      return self.skipWaiting();
    })
  );
});

self.addEventListener('activate', function(e){
  e.waitUntil(
    caches.keys().then(function(keys){
      // 古いキャッシュ（旧 CACHE_NAME のもの）を全削除
      return Promise.all(
        keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
      );
    }).then(function(){
      return self.clients.claim();
    })
  );
});

// SWR（Stale-While-Revalidate）共通関数
// キャッシュから即時返しつつ、裏でネット取得＆キャッシュ更新
// ★必ず Response を返す（undefined を返すと "null FetchEvent" エラーになる）
function staleWhileRevalidate(request){
  return caches.open(CACHE_NAME).then(function(cache){
    return cache.match(request).then(function(cached){
      const fetchPromise = fetch(request).then(function(response){
        if(response && response.ok && request.method === 'GET'){
          // 同一オリジンの正常レスポンスのみキャッシュ（opaque は除外）
          if(response.type === 'basic' || response.type === 'default'){
            cache.put(request, response.clone()).catch(function(){});
          }
        }
        return response;
      }).catch(function(){
        // ネット失敗時：cached → "/" → 最終手段で network error Response
        return cached || caches.match('/').then(function(r){
          return r || Response.error();
        });
      });
      return cached || fetchPromise;
    });
  });
}

// ナビゲーション専用ハンドラ：querystring 無視で precache を確実にヒット
// /history.html?_v=xxx のようなパラメータ付きでも /history.html のキャッシュとマッチ
function navigationHandler(request){
  return caches.open(CACHE_NAME).then(function(cache){
    return cache.match(request, { ignoreSearch: true }).then(function(cached){
      const fetchPromise = fetch(request).then(function(response){
        if(response && response.ok){
          cache.put(request, response.clone()).catch(function(){});
        }
        return response;
      }).catch(function(){
        return cached || caches.match('/').then(function(r){
          return r || Response.error();
        });
      });
      return cached || fetchPromise;
    });
  });
}

// /api/* 専用：ネットワーク優先・失敗時に HTML を返さず JSON エラーを返す
// （history.html の /api/distance 呼び出しが HTML 化けして JSON.parse 失敗する事故を防ぐ）
function networkOnlyJson(request){
  return fetch(request).catch(function(){
    return new Response(
      JSON.stringify({ error: 'offline', source: 'sw' }),
      { status: 503, headers: { 'Content-Type': 'application/json' } }
    );
  });
}

self.addEventListener('fetch', function(e){
  const req = e.request;

  // [修正1] 非 GET (POST/PUT/DELETE/OPTIONS) は SW 介入しない
  //   → cache.match できず undefined を respondWith → "null FetchEvent" の主因
  if(req.method !== 'GET') return;

  const url = new URL(req.url);

  // [修正2] http(s) 以外（chrome-extension://, data:, blob:, devtools://）は SW 介入しない
  //   → cache.put が "scheme not supported" 例外で reject → respondWith が undefined になる
  if(url.protocol !== 'http:' && url.protocol !== 'https:') return;

  // [修正3] クロスオリジン（firebase / googleapis / gstatic / fonts.g 含む）は SW 介入しない
  //   → ブラウザが直接処理。SW を経由しないことで opaque キャッシュ汚染も回避
  if(url.origin !== self.location.origin) return;

  // [修正4] /api/* は network-only。失敗時も HTML フォールバックせず JSON エラー返却
  //   → 旧コードでは fetch 失敗時 caches.match('/') が HTML を返し、呼び出し側 JSON.parse が落ちていた
  if(url.pathname.startsWith('/api/')){
    e.respondWith(networkOnlyJson(req));
    return;
  }

  // [修正5] ナビゲーションリクエスト（HTML ページ取得）は querystring 無視で precache マッチ
  //   → /history.html?foo=bar でも /history.html のキャッシュにヒット
  if(req.mode === 'navigate'){
    e.respondWith(navigationHandler(req));
    return;
  }

  // 道路データ・地図関連：SWR（最重要・オフライン必須）
  if(
    req.url.includes('/roads/') ||
    req.url.includes('/road-data/') ||
    req.url.includes('/data/roads-') ||
    req.url.includes('/data/bridges') ||
    req.url.includes('/data/tunnels') ||
    req.url.includes('/data/poi-') ||
    req.url.includes('/data/hazard-') ||
    req.url.includes('/data/road-attrs-') ||
    req.url.includes('/data/meta.json') ||
    // 全国共通バンドル（13種・初回 install で全 precache 済）
    req.url.includes('/data/coarse-jp.js') ||
    req.url.includes('/data/pref-borders-jp.js') ||
    req.url.includes('/data/shelters-jp.js') ||
    req.url.includes('/data/emergency-medical-jp.js') ||
    req.url.includes('/data/highways-jp.js') ||
    req.url.includes('/data/stations-jp.js') ||
    req.url.includes('/data/misc-jp.js') ||
    req.url.includes('/data/faults-jp.js') ||
    req.url.includes('/data/night-clinics-jp.js') ||
    req.url.includes('/data/airports-jp.js') ||
    req.url.includes('/data/michinoeki-jp.js') ||
    req.url.includes('/data/coastline-jp.js') ||
    req.url.includes('/data/ports-jp.js') ||
    req.url.includes('/data/peaks-jp.js') ||
    req.url.includes('/data/hiking-trails-jp.js') ||
    req.url.includes('/data/railways-jp.js') ||
    req.url.includes('/data/waterways-jp.js') ||
    req.url.includes('/data/hazard-cliff-jp.js')
  ){
    e.respondWith(staleWhileRevalidate(req));
    return;
  }

  // 静的アセット（icon・manifest）：cache-first
  if(req.url.includes('/icon-') || req.url.includes('/manifest.json')){
    e.respondWith(
      caches.match(req).then(function(cached){
        return cached || fetch(req).catch(function(){ return Response.error(); });
      })
    );
    return;
  }

  // その他（JS・CSS）：SWR
  e.respondWith(staleWhileRevalidate(req));
});

// Background Sync（Phase 2.B 訓練データ upload trigger）
//   M2 (2026-05-10): 旧 'firebase-sync' tag handler は dead code のため削除
//   現在使用中の tag は 'training-upload' のみ
self.addEventListener('sync', function(e){
  if(e.tag === 'training-upload'){
    e.waitUntil(_notifyClientsTrainingUpload());
  }
});

function _notifyClientsTrainingUpload(){
  return self.clients.matchAll({ type: 'window' }).then(function(clients){
    for(const c of clients){
      try { c.postMessage({ type: 'TRAINING_UPLOAD_TRIGGER' }); } catch(_) {}
    }
  });
}
