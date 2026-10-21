// ============================================================
// ★★見張り：売上表＝実費の 記録が 読めなかった 時は 実費の 欄を 打たせない（前の 額を 0 で 上書きしない）★★ 2026-10-21
//   ★前★ 実費（dk_shift_edits）の 読みが 失敗すると 手元の 記録が 空に なり、欄は 押せた。
//         橋代に 500 と 打つと {"toll_yen":0,"bridge_yen":500,"other_yen":0,"denshi_yen":0,...} を 送り、
//         倉庫の 高速代・電子決済 などを 0 で 上書きした（入力の 画面と 同じ 形・対立役が 測った）
//   ★今★ 実費の 読みが 失敗した 月は 表の 数字・紙・実費の 欄を 出さず、訳を 出す。保存の 口（saveEdit）も 断る
//         （対立役 U-1：欄だけ 止めた 版は 紙と 合計が 引く 前の ¥40,000＝13,220円 多く 出た）
//   ★★わざと壊して 赤に なるのを 見た（2026-10-21 実測）★★
//     直す 前の uriage.html（5c90474 系）… 読めない 形 1本 赤（欄が 押せた・紙が 出た）
//     欄だけ 止めた 版（7d6c420）……………… 読めない 形 1本 赤（紙と 合計が 出た）
// ============================================================
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

const CO = '11111111-2222-3333-4444-555555555555';
test.use({ timezoneId: 'Asia/Tokyo' });

const SHIFTS = [
  {
    shift_id: 's1',
    device_id: 'd1',
    started_at: '2026-01-05T20:00:00+09:00',
    ended_at: '2026-01-06T04:00:00+09:00',
    elapsed_sec: 28800,
    fare_total_yen: 40000,
    trip_count: 12,
  },
];
// 倉庫の 高速代 1000・橋代 2220・電子決済 300
const EDITS = [
  { shift_id: 's1', toll_yen: 1000, bridge_yen: 2220, other_yen: 0, denshi_yen: 300, hours: 8 },
];
const LABELS = [{ device_id: 'd1', label: '4987', sort_order: 1 }];

function tsukuru(yomenai) {
  const moto = fs.readFileSync(path.join(__dirname, '..', '..', 'js', 'dk-session.js'), 'utf8');
  const co = { company_id: CO, name: '見張り用' };
  const nakami = function (co, T, yomenai) {
    window.__okutta = [];
    const S = window.DKSession;
    const rows = (p) => T[String(p).split('?')[0]] || [];
    const kotae = (v) => ({ ok: true, status: 200, json: () => Promise.resolve(v) });
    S.ensure = () => Promise.resolve({ token: 'd' });
    S.goLogin = () => {};
    S.logout = () => {};
    S.rememberedCompanyId = () => co.company_id;
    S.pickCompany = () => ({ mode: 'one', company: co });
    S.myCompanies = () => Promise.resolve(kotae([co]));
    S.rest = (s, p, o) => {
      const m = (o && o.method) || 'GET';
      if (m !== 'GET') {
        let b = null;
        try {
          b = JSON.parse(o.body);
        } catch (_) {
          b = null;
        }
        window.__okutta.push({ p: String(p), m: m, b: b });
        return Promise.resolve(kotae([b]));
      }
      return Promise.resolve(kotae(rows(p)));
    };
    S.softList = (s, p, st) => {
      if (st) st.tried++;
      if (yomenai.some((n) => String(p).indexOf(n) === 0)) {
        if (st) st.failed++;
        return Promise.resolve([]);
      }
      return Promise.resolve(rows(p));
    };
  };
  const T = {
    dk_shifts: SHIFTS,
    dk_shift_edits: EDITS,
    dk_device_labels: LABELS,
    dk_sales_settings: [],
    dk_expense_kinds: [],
    dk_uriage_rireki: [],
  };
  return (
    moto +
    ';(' +
    nakami.toString() +
    ')(' +
    [co, T, yomenai].map((x) => JSON.stringify(x)).join(',') +
    ');'
  );
}

async function akeru(page, yomenai) {
  await page.clock.setFixedTime(new Date('2026-01-20T12:00:00+09:00'));
  await page.route('**/js/dk-session.js*', (r) =>
    r.fulfill({
      status: 200,
      contentType: 'application/javascript; charset=utf-8',
      body: tsukuru(yomenai),
    })
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/uriage.html', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#monthLabel')).toContainText('1月', { timeout: 15000 });
  // 読み終えた 印＝紙が 出た か「紙は 出せません」の 訳が 出た（描く 前に 数えて 偽の 緑に しない）
  await page.waitForFunction(
    () =>
      document.querySelector('#kamiMado .kami-mise-waku') ||
      /出せません/.test((document.getElementById('kamiMsg') || {}).textContent || ''),
    null,
    { timeout: 15000 }
  );
}
async function hiraku(page, yomenai) {
  await page.clock.setFixedTime(new Date('2026-01-20T12:00:00+09:00'));
  await page.route('**/js/dk-session.js*', (r) =>
    r.fulfill({
      status: 200,
      contentType: 'application/javascript; charset=utf-8',
      body: tsukuru(yomenai),
    })
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/uriage.html', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#kamiMado .kami-mise-waku').first()).toBeVisible({ timeout: 15000 });
  await page.locator('summary', { hasText: '一覧で 見る' }).click();
  await page.locator('button.rmore', { hasText: '実費を 入れる' }).first().click();
  await expect(page.locator('.dedit input.yen').first()).toBeVisible();
}
const oseru = (page) =>
  page.evaluate(
    () => [...document.querySelectorAll('input.yen')].filter((i) => !i.disabled).length
  );
// 押せない 欄にも 字を 入れて change を 起こす（保存の 口が 断るかも 見る）
async function utsuMuri(page, f, v) {
  await page.evaluate(
    (a) => {
      const i = document.querySelector('.dedit input.yen[data-f="' + a.f + '"]');
      i.value = a.v;
      i.dispatchEvent(new Event('change'));
    },
    { f, v }
  );
  await page.waitForTimeout(600);
}
const okutta = (page) =>
  page.evaluate(() => window.__okutta.filter((x) => x.p.indexOf('dk_shift_edits') === 0));

test('★実費の 記録が 読めない 時は 表の 数字・紙・実費の 欄を 出さない・送らない・訳を 出す★', async ({
  page,
}) => {
  await akeru(page, ['dk_shift_edits']);
  expect(
    await page.locator('#kamiMado .kami-mise-waku').count(),
    '★読めないのに 紙（引く 前の 額）が 出た★'
  ).toBe(0);
  expect(await oseru(page), '★読めないのに 押せる 実費の 欄が 在る★').toBe(0);
  expect(
    await page.locator('#list .row').count(),
    '★読めないのに 表の 数字（引く 前の 額）が 出た★'
  ).toBe(0);
  await expect(page.locator('#err'), '★止めた 訳が 出ていない★').toContainText('読めません');
  await expect(page.locator('#kamiMsg'), '★紙を 出さない 訳が 出ていない★').toContainText(
    '実費の 記録が 読めない'
  );
  expect(
    await okutta(page),
    '★読めないのに 倉庫へ 送った（高速代 などを 0 で 上書きする）★'
  ).toEqual([]);
});
test('★読めた 時は 今まで 通り 打てて、高速代・電子決済は 前の 額の まま 送る★', async ({
  page,
}) => {
  await hiraku(page, []);
  expect(await oseru(page), '★読めたのに 押せない★').toBeGreaterThan(0);
  await utsuMuri(page, 'bridge', '500');
  const o = await okutta(page);
  expect(o.length, '★読めたのに 送らない★').toBe(1);
  expect(o[0].b, '★前の 額を 0 で 上書きした★').toMatchObject({
    toll_yen: 1000,
    bridge_yen: 500,
    denshi_yen: 300,
  });
});
