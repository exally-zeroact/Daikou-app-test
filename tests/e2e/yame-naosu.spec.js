// ============================================================
// ★★辞めた 人の 歩合・役割・最低保証を 退職者ページで 直す★★ 2026-10-20
//   司さん 10-17「辞めた人の歩合等を復職させずに直せる様に」「何日から」は 今いる人と 同じ（既定は 今日）
//
//   ★物差し★
//     ① 退職者ページ：「歩合・役割を直す」⇒ 日付を 選んで 最低保証 ⇒ その 日から の 記録に 足す
//        （人の 列も 復職も 書かない）・書いた 後も 欄と 配る 箱は 開いた まま
//     ② 辞めた 人の 明細：記録の 日から 後だけ 新しい 最低保証（前の 日は 前の 額）
//     ③ パソコンの 幅でも 欄に 名前が 付く・役割の 候補が 在る
//   わざと壊す：renderYame の empOshiguchi() を 外す ⇒ ① 赤（書かない）／
//              YAME_NAOSU の 控えを 見ない ⇒ ① 赤（書いた 後に 閉じる）
// ============================================================
const { test, expect } = require('@playwright/test');
const { openKyuryo } = require('./kyuryo-harness');

function yameNi(f) {
  f.emps = f.emps.map((e, i) =>
    i === 0 ? Object.assign({}, e, { active: false, retired_on: '2026-09-30' }) : e
  );
  return f;
}

async function yameWoHiraku(page, f0) {
  await openKyuryo(page, (f) => (f0 ? f0(yameNi(f)) : yameNi(f)));
  await page.evaluate(() => {
    window.__okutta = [];
    const S = window.DKSession;
    const moto = S.rest;
    S.rest = function (s, p, o) {
      if (o && o.method && o.method !== 'GET') {
        window.__okutta.push({ p: String(p), m: o.method, b: o.body ? JSON.parse(o.body) : null });
        if (String(p).indexOf('dk_hito_rireki') === 0) {
          const b = o.body ? JSON.parse(o.body) : {};
          return Promise.resolve({
            ok: true,
            status: 201,
            json: () => Promise.resolve([Object.assign({ rireki_id: 'neo' }, b)]),
          });
        }
      }
      return moto.apply(this, arguments);
    };
  });
  await page.click('.tab[data-tab="emp"]');
  await page.locator('[data-kiri="yame"]').click();
  await page.waitForSelector('#empBody [data-yame-naosu]', { state: 'visible' });
}

test('① 退職者ページで 日付を 選んで 最低保証を 直す ⇒ その 日から の 記録（復職しない）・欄は 開いた まま', async ({
  page,
}) => {
  const err = [];
  page.on('pageerror', (x) => err.push(x.message));
  await page.setViewportSize({ width: 1280, height: 900 });
  await yameWoHiraku(page);
  const id = await page.$eval('#empBody [data-yame-naosu]', (b) =>
    b.getAttribute('data-yame-naosu')
  );
  await page.click('#empBody [data-yame-haifu]');
  await page.click('#empBody [data-yame-naosu]');
  const hiIn = '#empBody .yame-naosu [data-hi]';
  await page.waitForSelector(hiIn, { state: 'visible' });
  expect(await page.$eval(hiIn, (i) => i.value), '★既定の 日（今日）が 入っていない★').toMatch(
    /^\d{4}-\d{2}-\d{2}$/
  );
  await page.fill(hiIn, '2026-08-01');
  await page.dispatchEvent(hiIn, 'change');
  const yuka = '#empBody .yame-naosu [data-f="pay_floor"]';
  await page.fill(yuka, '1300');
  await page.press(yuka, 'Tab');
  await page.waitForTimeout(800);
  const o = await page.evaluate(() => window.__okutta);
  // eslint-disable-next-line no-console
  console.log('★①★ ' + JSON.stringify(o));
  const rk = o.filter((x) => x.p.indexOf('dk_hito_rireki') === 0);
  expect(rk.length, '★記録に 書いていない★').toBe(1);
  expect(rk[0].m).toBe('POST');
  expect(rk[0].b).toMatchObject({
    employee_id: id,
    key: 'pay_floor',
    from_date: '2026-08-01',
    value: 1300,
  });
  expect(
    o.filter((x) => x.p.indexOf('dk_employees') === 0).length,
    '★人の 列（復職 等）まで 書いた★'
  ).toBe(0);
  const ato = await page.evaluate(() => ({
    ran: !!document.querySelector('#empBody .yame-naosu [data-f="pay_floor"]'),
    hi: (document.querySelector('#empBody .yame-naosu [data-hi]') || {}).value || '',
    box: [...document.querySelectorAll('#empBody [data-yame-box]')].some(
      (b) => b.style.display !== 'none'
    ),
    yame: document.querySelectorAll('#empBody [data-fukushoku]').length,
  }));
  // eslint-disable-next-line no-console
  console.log('★①後★ ' + JSON.stringify(ato));
  expect(ato.ran, '★書いた 後に 直す 欄が 閉じた★').toBe(true);
  expect(ato.hi, '★選んだ 日が 今日に 戻った★').toBe('2026-08-01');
  expect(ato.box, '★書いた 後に 配る 箱が 閉じた★').toBe(true);
  expect(ato.yame, '★退職者ページで なくなった★').toBeGreaterThan(0);
  expect(err).toEqual([]);
});

test('② 辞めた 人の 明細：記録の 日から 後だけ 新しい 最低保証', async ({ page }) => {
  const err = [];
  page.on('pageerror', (x) => err.push(x.message));
  await openKyuryo(page, yameNi);
  const moto = await page.evaluate(() => {
    const e = window.__paper.emp(0);
    return {
      id: e.employee_id,
      ari: e.cells.filter((c) => c.pay > 0).map((c) => ({ d: c.date, pay: c.pay })),
    };
  });
  const yameId = require('../fixtures/kyuryo-real.json').emps[0].employee_id;
  expect(moto.id, '★辞めた 人が 明細の 1人目に 居ない（材料が 違う）★').toBe(yameId);
  expect(moto.ari.length, '★働いた 日が 2日 要る★').toBeGreaterThanOrEqual(2);
  const hi2 = moto.ari[1].d;
  const page2 = await page.context().newPage();
  page2.on('pageerror', (x) => err.push(x.message));
  await openKyuryo(page2, (f) => {
    yameNi(f);
    f.rireki = [
      { rireki_id: 'r1', employee_id: moto.id, key: 'pay_floor', from_date: hi2, value: 99999 },
    ];
    return f;
  });
  const ato = await page2.evaluate((id) => {
    let e = null;
    for (let i = 0; i < window.__paper.ninzu(); i++)
      if (window.__paper.emp(i).employee_id === id) e = window.__paper.emp(i);
    return e ? e.cells.filter((c) => c.pay > 0).map((c) => ({ d: c.date, pay: c.pay })) : null;
  }, moto.id);
  // eslint-disable-next-line no-console
  console.log(
    '★②★ ' + JSON.stringify({ moto: moto.ari.slice(0, 2), ato: (ato || []).slice(0, 2) })
  );
  expect(ato, '★辞めた 人が 明細から 消えた★').not.toBeNull();
  expect(ato[0].pay, '★記録の 日より 前の 額が 変わった★').toBe(moto.ari[0].pay);
  expect(ato[1].pay, '★記録の 日から 新しい 最低保証が 効いていない★').toBeGreaterThanOrEqual(
    99999
  );
  expect(err).toEqual([]);
});

test('③ パソコンの 幅でも 欄に 名前・役割の 候補が 在る', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await yameWoHiraku(page);
  await page.click('#empBody [data-yame-naosu]');
  await page.waitForSelector('#empBody .yame-naosu', { state: 'visible' });
  const r = await page.evaluate(() => ({
    mi: [...document.querySelectorAll('#empBody .yame-naosu .yn-mi')]
      .filter((x) => x.offsetParent !== null)
      .map((x) => x.textContent),
    kouho: document.querySelectorAll('#roleList option').length,
    list: (document.querySelector('#empBody .yame-naosu [data-f="role"]') || {}).getAttribute(
      'list'
    ),
  }));
  // eslint-disable-next-line no-console
  console.log('★③★ ' + JSON.stringify(r));
  expect(r.mi).toEqual(['役割', '歩合', '最低保証', '何日から']);
  expect(r.list).toBe('roleList');
  expect(r.kouho, '★役割の 候補が 無い★').toBeGreaterThan(0);
});
