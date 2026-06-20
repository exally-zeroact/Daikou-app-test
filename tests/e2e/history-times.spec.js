// tests/e2e/history-times.spec.js
// ★履歴に時刻表示 回帰テスト (2026-06-20)★
//   司さん「履歴の距離が見にくい・時間が表示されてない(開始/経由地点/清算終了の時刻)」。
//   daikou_history_<date> に 新フォーマット(start_time/end_time/waypoints[].timestamp) entry を
//   注入し、履歴画面で 開始/経由/終了 の時刻ラベルと距離が描画されることを確認。
//   旧フォーマット(time のみ) は「終了」1個に fallback することも確認(後方互換)。
const { test, expect } = require('@playwright/test');

test('履歴: 開始/経由/終了 の時刻 + 距離が表示される / 旧entryは終了のみ', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('tutorial_done', '1');
    localStorage.setItem('daikome_training_consent', 'declined');
    const base = Date.parse('2026-06-20T21:00:00');
    const key = 'daikou_history_' + new Date().toDateString();
    const rides = [
      {
        start_time: base,
        end_time: base + 30 * 60000,
        time: '21:30',
        distance_m: 12340,
        fare: 4820,
        surcharge: false,
        extras: [],
        start_address: '今治市常盤町',
        end_address: '松山市道後',
        waypoints: [{ address: '今治市別宮町', timestamp: base + 8 * 60000 }],
      },
      { time: '20:15', distance_m: 8970, fare: 3600, surcharge: false, extras: [] }, // 旧
    ];
    localStorage.setItem(key, JSON.stringify(rides));
  });
  await page.goto('/index.html', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(400);
  await page.evaluate(() => {
    if (typeof window.showOverlay === 'function') window.showOverlay('history');
    if (typeof window._hist_render === 'function') window._hist_render();
  });
  const ov = page.locator('#overlayHistory');
  const items = ov.locator('.ride-item');
  await expect(items).toHaveCount(2);

  // 1件目(新): 開始/経由/終了 の時刻ラベル + 時刻 + 距離
  const first = items.nth(0);
  await expect(first.locator('.ride-times')).toContainText('開始');
  await expect(first.locator('.ride-times')).toContainText('21:00');
  await expect(first.locator('.ride-times')).toContainText('経由');
  await expect(first.locator('.ride-times')).toContainText('21:08');
  await expect(first.locator('.ride-times')).toContainText('終了');
  await expect(first.locator('.ride-times')).toContainText('21:30');
  await expect(first.locator('.ride-dist')).toContainText('12.34');

  // 2件目(旧フォーマット): 「終了」1個に fallback (開始/経由は出ない)
  const second = items.nth(1);
  await expect(second.locator('.ride-times')).toContainText('終了');
  await expect(second.locator('.ride-times')).toContainText('20:15');
  await expect(second.locator('.ride-times')).not.toContainText('開始');
});
