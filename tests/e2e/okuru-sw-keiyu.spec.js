// tests/e2e/okuru-sw-keiyu.spec.js
// ============================================================
// ★service worker が 画面を 握っている 時も、業務終了の 売上が 事務所へ 出て行く★ 2026-10-17
//
//   ★なぜ 要るか★ WebKit（iPhone の Safari の 中身）で 初めて 回すと、shuryo-tsuzukeru-okuru が
//     「1回目の POST が 出ない」で 赤に なった（service worker あり 8回中 2回・なし 8回中 0回・手元の webkit）。
//     要求を 全部 並べると、POST dk-sync-jobs 自体は 出ていて、page.route に 捕まらずに 外へ 向かっていた。
//     ＝WebKit では service worker が 握る 画面の 要求に page.route が 効かない 事が ある（試験の 道具の 癖）。
//     sw.js は GET 以外を 触らない（sw.js:391）ので、アプリの 送りは ブラウザが そのまま 出す。
//   ⇒ shuryo-tsuzukeru-okuru は service worker を 止めて 中身を 数える 形に した。
//     ★代わりに ここで「service worker が 握っていても POST が 出る」を 縛る★（page.route を 使わず、出て行く 要求を 見る）。
//   ★本物の 倉庫には 届かない★ chromium は host-resolver-rules、webkit は 届かない 代理で 止まる（要求の 中身は 見える）。
//
//   ★わざと壊して 赤に なった 記録（2026-10-17）★
//     js/job-sync.js の 送り（fetch の 呼び出し）を 止める ⇒ この 試験と shuryo-tsuzukeru-okuru が 赤（chromium・webkit とも 4本中 4本）。戻すと 緑。
// ============================================================
const { test, expect } = require('@playwright/test');

test.use({ viewport: { width: 390, height: 844 } });

test('service worker が 握っていても 業務終了の POST が 3件 入って 出て行く', async ({ page }) => {
  await page.addInitScript(() => {
    sessionStorage.setItem('sensor_permission_active', '1');
    sessionStorage.setItem('sensorGranted', '1');
    sessionStorage.setItem('dl_just_completed', '1');
    localStorage.setItem('daikome_training_consent', 'dismissed');
    localStorage.setItem('pwa_banner_dismissed', '1');
    localStorage.setItem('apk_banner_dismissed', '1');
    localStorage.setItem('tutorial_done', '1');
    localStorage.setItem('dk_license_company', 'e2e-kaisha');
    localStorage.setItem('dk_sync_company', 'e2e-kaisha');
    localStorage.setItem('DAIKOME_DEVICE_ID', 'e2e-tanmatsu');
  });
  const deta = [];
  page.on('request', (r) => {
    if (r.method() === 'POST' && r.url().includes('/dk-sync-jobs')) {
      let b = {};
      try {
        b = JSON.parse(r.postData() || '{}');
      } catch (_) {
        b = {};
      }
      deta.push(b);
    }
  });

  await page.goto('/', { waitUntil: 'domcontentloaded' });
  // ★service worker が 画面を 握るまで 待つ★（握っていない 時の 緑は この 試験の 意味が 無い）
  await expect
    .poll(
      () => page.evaluate(() => !!(navigator.serviceWorker && navigator.serviceWorker.controller)),
      {
        timeout: 15000,
        message: '★service worker が 画面を 握っていない＝この 試験の 前提が 無い★',
      }
    )
    .toBe(true);

  await page.evaluate(() => {
    ['dlOverlay', 'trainingConsentBanner', 'pwaBanner', 'apkBanner', 'sensorRestoreBanner'].forEach(
      (id) => {
        const el = document.getElementById(id);
        if (el) el.style.display = 'none';
      }
    );
    window.Business.start();
    if (typeof window.appState !== 'undefined') window.appState = 'idle';
    if (typeof window.showScreen === 'function') window.showScreen('idle');
  });
  await page.waitForTimeout(300);
  await page.evaluate(() => {
    for (let i = 0; i < 3; i++) window.Business.onTripEnd(1000, 2000, Date.now() + i);
  });
  page.once('dialog', (d) => d.accept());
  await page.evaluate(() => window.onBusinessEnd());

  await expect
    .poll(() => deta.length, {
      timeout: 10000,
      message: '★service worker が 握る 画面で 業務終了の POST が 出ない★',
    })
    .toBeGreaterThan(0);
  const s = (deta[0].shifts || [])[0] || {};
  expect((s.trips || []).length, '★出て行った POST に 代行が 3件 入っていない★').toBe(3);
});
