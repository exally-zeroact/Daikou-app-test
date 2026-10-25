// ============================================================
// ★★「何日から」で 選んだ 日は 画面を 行き来しても その 日の うちは 残る★★ 2026-10-25
//
//   司さん「今日従業員を足して何日からってのを2026/10/1に設定したのに画面変えて入力からやるとまた2026/10/25に
//          もどってる 他の所もこうゆうのがないか確認して直せ」
//   ⇒ 人（従業員の 表）・締め（給料の 設定）・役割の 決まり の 3か所（kyuryo.html の hiOboe*）
//   ★日が 変われば 今日に 戻る★（何週間も 前の 日付が 残って 気付かずに 過去の 月を 書き換えない）
//
//   わざと壊す：hiOboeHiku が いつも null を 返す ⇒ ★赤★（開き直すと 今日に 戻る＝司さんの 形）
// ============================================================
const { test, expect } = require('@playwright/test');
const { openKyuryo } = require('./kyuryo-harness');

test.use({ timezoneId: 'Asia/Tokyo' });
const KYOU = new Date('2026-10-25T12:00:00+09:00');
const ASU = new Date('2026-10-26T12:00:00+09:00');

async function hiraku(page, ura, ji) {
  await page.clock.setFixedTime(ji || KYOU);
  await page.setViewportSize({ width: 1280, height: 900 });
  await openKyuryo(page, null, { ura });
}
async function erabu(page, sel, v) {
  await page.locator(sel).fill(v);
  await page.locator(sel).dispatchEvent('change');
  await page.waitForTimeout(300);
}
async function hitoNoHi(page) {
  await page.click('.tab[data-tab="emp"]');
  const el = page.locator('#empBody [data-hi]').first();
  await el.waitFor({ state: 'visible' });
  return el;
}

test('① 人の「何日から」：10/1 を 選んで 画面を 開き直しても 10/1 の まま', async ({ page }) => {
  await hiraku(page, '?henshu=1');
  const el = await hitoNoHi(page);
  expect(await el.inputValue()).toBe('2026-10-25');
  const id = await el.getAttribute('data-hi');
  await erabu(page, '#empBody [data-hi="' + id + '"]', '2026-10-01');
  // 別の 画面へ 行って 戻る（同じ 端末・同じ 日）
  await page.goto('about:blank');
  await hiraku(page, '?henshu=1');
  await hitoNoHi(page);
  await expect(page.locator('#empBody [data-hi="' + id + '"]')).toHaveValue('2026-10-01');
});

test('② 給料の 締めの「何日から」：空（最初から）を 選んで 開き直しても 空の まま', async ({
  page,
}) => {
  await hiraku(page, '?henshu=1#set');
  await page.waitForSelector('#pHi', { state: 'visible' });
  expect(await page.inputValue('#pHi')).toBe('2026-10-25');
  await erabu(page, '#pHi', '');
  await page.goto('about:blank');
  await hiraku(page, '?henshu=1#set');
  await page.waitForSelector('#pHi', { state: 'visible' });
  await expect(page.locator('#pHi')).toHaveValue('');
});

test('③ 役割の 決まりの「何日から」：10/1 を 選んで 開き直しても 10/1 の まま', async ({
  page,
}) => {
  await hiraku(page, '?henshu=1#set');
  const el = page.locator('#roleBody [data-yh]').first();
  await el.waitFor({ state: 'visible' });
  const r = await el.getAttribute('data-yh');
  await erabu(page, '#roleBody [data-yh="' + r + '"]', '2026-10-01');
  await page.goto('about:blank');
  await hiraku(page, '?henshu=1#set');
  const el2 = page.locator('#roleBody [data-yh="' + r + '"]');
  await el2.waitFor({ state: 'visible' });
  await expect(el2).toHaveValue('2026-10-01');
});

// ★次の 日は 今日に 戻す★（古い 日付を 残して 過去の 月を 黙って 書き換えない）
//   わざと壊す：hiOboeYomu の「o.kyou === kyouJst()」の 比べを 外す ⇒ ★赤★（次の 日も 10/1）
test('④ 次の 日に 開くと 今日（10/26）に 戻る', async ({ page }) => {
  await hiraku(page, '?henshu=1');
  const el = await hitoNoHi(page);
  const id = await el.getAttribute('data-hi');
  await erabu(page, '#empBody [data-hi="' + id + '"]', '2026-10-01');
  await page.goto('about:blank');
  await hiraku(page, '?henshu=1', ASU);
  await hitoNoHi(page);
  await expect(page.locator('#empBody [data-hi="' + id + '"]')).toHaveValue('2026-10-26');
});

// ★会社ごとに 分ける★（別の 会社を 開くと その 会社の 覚え＝無ければ 今日）
//   わざと壊す：hiOboeKagi から 会社を 外す ⇒ ★赤★（別の 会社でも 10/1）
test('⑤ 別の 会社を 開くと 前の 会社で 選んだ 日は 出ない', async ({ page }) => {
  await hiraku(page, '?henshu=1');
  const el = await hitoNoHi(page);
  const id = await el.getAttribute('data-hi');
  await erabu(page, '#empBody [data-hi="' + id + '"]', '2026-10-01');
  await page.goto('about:blank');
  await page.clock.setFixedTime(KYOU);
  await openKyuryo(
    page,
    (f) => {
      const betsu = '00000000-0000-4000-8000-0000000000bb';
      (f.settings || []).forEach((s) => (s.company_id = betsu));
      (f.emps || []).forEach((e) => (e.company_id = betsu));
      return f;
    },
    { ura: '?henshu=1' }
  );
  await hitoNoHi(page);
  await expect(page.locator('#empBody [data-hi="' + id + '"]')).toHaveValue('2026-10-25');
});
