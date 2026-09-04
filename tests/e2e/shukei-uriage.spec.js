// ============================================================
// ★★月次集計の「売上」（年間／月ごと／日ごと × 全体／車ごと）★★ 2026-09-05（司さん）
//
//   ★司さんの言葉★
//     「★売上は 車ごととか 全体とか 日別や 月別や 年別で 分けれとんか？★」
//     「★ないといかんやろ★」
//
//   ★実測（直す前）★
//     売上表 …… 車ごと／日ごと は 在る／★月別・年別は 無い★／全体だけの 切り替えも 無い
//     月次集計 … 売上は ★月ごと（12ヶ月）だけ★／★車ごとは 無い★
//   ⇒ ★距離と 同じ 形★を 売上にも 付けた（同じ 場所・同じ 押し方）
//
//   ★数え方は 元と 同じ★
//     ctx.byDate[日付][車] の sales − expense（★実費を 引いた後★）
//     ＝ js/getsuji-agg.js:105 と 同じ 式 ⇒ ★元の 表と 食い違わない★
//
//   ★★わざと壊して 赤に なる事を 見た（2026-09-05 実測）★★
//     ①実費を 引かない（sales だけ 足す）… ★赤★（元の 表と 合わない）
//     ②車ごとの 合計を 出さない ………… ★赤★
//     ③切り替えの 印（色）を 付けない … ★赤★
//     戻した後 … ★緑★
// ============================================================
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const FIX = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'kyuryo-real.json'), 'utf8')
);

function tsukuru() {
  const moto = fs.readFileSync(path.join(__dirname, '..', '..', 'js', 'dk-session.js'), 'utf8');
  const co = { company_id: FIX.settings[0].company_id, name: '見張り用' };
  return (
    moto +
    ';(function(){var F=' +
    JSON.stringify(FIX) +
    ';var co=' +
    JSON.stringify(co) +
    ';' +
    'function rows(p){ if(p.indexOf("dk_employees")===0)return F.emps||[]; if(p.indexOf("dk_device_labels")===0)return F.labels||[];' +
    ' if(p.indexOf("dk_payroll_settings")===0)return F.settings||[]; if(p.indexOf("dk_shifts")===0)return F.shifts||[];' +
    ' if(p.indexOf("dk_shift_edits")===0)return F.edits||[]; if(p.indexOf("dk_work_hours")===0)return F.workHours||[];' +
    ' if(p.indexOf("dk_manual_days")===0)return F.manualDays||[]; return [];}' +
    'var S=window.DKSession;S.ensure=function(){return Promise.resolve({token:"d"});};S.goLogin=function(){};S.logout=function(){};' +
    'S.rememberedCompanyId=function(){return co.company_id;};S.pickCompany=function(){return {mode:"one",company:co};};' +
    'S.myCompanies=function(){return Promise.resolve({ok:true,json:function(){return Promise.resolve([co]);}});};' +
    'S.rest=function(s,p){return Promise.resolve({ok:true,status:200,json:function(){return Promise.resolve(rows(p));}});};' +
    'S.softList=function(s,p,st){if(st)st.tried++;return Promise.resolve(rows(p));};})();'
  );
}

async function hiraku(page) {
  await page.route('**/js/dk-session.js*', (r) =>
    r.fulfill({
      status: 200,
      contentType: 'application/javascript; charset=utf-8',
      body: tsukuru(),
    })
  );
  await page.setViewportSize({ width: 390, height: 900 });
  await page.goto('/shukei.html', { waitUntil: 'domcontentloaded' });
  await page.locator('#uriTbl').waitFor({ state: 'visible', timeout: 15000 });
  await page.waitForTimeout(1500);
}

function yomu(page) {
  return page.evaluate(() => ({
    head: [...document.querySelectorAll('#uriHead th')].map((x) => x.textContent.trim()),
    rows: [...document.querySelectorAll('#uriBody tr')].map((tr) =>
      [...tr.children].map((td) => td.textContent.trim())
    ),
  }));
}
const gou = (r) => r.rows[r.rows.length - 1];

test('★売上を 年／月／日 × 全体／車ごと で 分けられる★', async ({ page }) => {
  const err = [];
  page.on('pageerror', (e) => err.push(e.message));
  await hiraku(page);

  // ★★元の 表（月ごと）の 数字★★＝これと 食い違ったら 数え方が 壊れている
  const moto = await page.evaluate(() =>
    [...document.querySelectorAll('#tbody tr')]
      .map((tr) => [tr.children[0].textContent.trim(), tr.children[1].textContent.trim()])
      .filter((x) => x[1] && x[1] !== '—')
  );
  console.log('★元の 表（月ごと）★ ' + JSON.stringify(moto));
  expect(moto.length, '★見本に 売上が ありません★').toBeGreaterThan(1);
  const motoGou = moto[moto.length - 1][1];

  // ①月ごと × 全体（出だし）
  let r = await yomu(page);
  console.log('★月×全体★ ' + JSON.stringify(r.head) + ' 合計 ' + JSON.stringify(gou(r)));
  expect(r.head, '★見出しが 違います★').toEqual(['月', '売上']);
  expect(r.rows.length, '★12ヶ月ぶん 出ていません★').toBe(13);
  expect(gou(r)[1], '★合計が 元の 表と 違います★').toBe(motoGou);

  // ②月ごと × 車ごと
  await page.locator('[data-uriwake="kuruma"]').click();
  await page.waitForTimeout(500);
  r = await yomu(page);
  console.log('★月×車ごと★ ' + JSON.stringify(r.head) + ' 合計 ' + JSON.stringify(gou(r)));
  expect(r.head.length, '★車の 列が ありません★').toBeGreaterThan(2);
  expect(r.head[r.head.length - 1], '★車ごとに 合計の 列が ありません★').toBe('合計');
  expect(r.head.slice(1, -1).join(','), '★端末IDが そのまま 出ています★').not.toMatch(
    /[0-9a-f]{8}-[0-9a-f]{4}/
  );
  // ★車ごとを 足すと 全体と 同じ★
  expect(gou(r)[gou(r).length - 1], '★車ごとの 合計が 全体と 違います★').toBe(motoGou);

  // ③年間 × 車ごと
  await page.locator('[data-uri="year"]').click();
  await page.waitForTimeout(500);
  r = await yomu(page);
  console.log('★年×車ごと★ ' + JSON.stringify(r.rows));
  expect(r.head[0], '★見出しが 年に なっていません★').toBe('年');
  expect(gou(r)[gou(r).length - 1], '★年の 合計が 違います★').toBe(motoGou);

  // ④日ごと × 全体（★1ヶ月ぶんだけ★＝距離と 同じ 決まり）
  await page.locator('[data-uriwake="zentai"]').click();
  await page.waitForTimeout(400);
  await page.locator('#tbody tr[data-m="8"]').click();
  await page.waitForTimeout(400);
  await page.locator('[data-uri="day"]').click();
  await page.waitForTimeout(500);
  r = await yomu(page);
  console.log('★日×全体（8月）★ ' + JSON.stringify(r.head) + ' … ' + JSON.stringify(r.rows));
  expect(r.head[0], '★見出しに 月が 出ていません★').toBe('8月の 日');
  expect(gou(r)[1], '★日ごとの 合計が 月ごとと 違います★').toBe(motoGou);

  expect(err, '★画面が 落ちました★').toEqual([]);
  await page.locator('#uriTbl').scrollIntoViewIfNeeded();
  await page.screenshot({
    path: 'C:/Users/zeroa/dk-tokei-2026-09-02/tokei/shot-uriage-hako.png',
  });
});

test('★押した ボタンが 色で 分かる★', async ({ page }) => {
  await hiraku(page);
  const iro = async (na) =>
    page.evaluate((a) => {
      const b = [...document.querySelectorAll('[' + a + ']')];
      const on = b.filter((x) => x.hasAttribute('aria-current'));
      return {
        on: on.length,
        onIro: on.map((x) => getComputedStyle(x).backgroundColor),
        hoka: b
          .filter((x) => !x.hasAttribute('aria-current'))
          .map((x) => getComputedStyle(x).backgroundColor),
      };
    }, na);
  for (const na of ['data-uri', 'data-uriwake']) {
    const r = await iro(na);
    console.log('★' + na + '★ ' + JSON.stringify(r));
    expect(r.on, '★選ばれている 物が 1つでは ありません（' + na + '）★').toBe(1);
    expect(
      r.hoka.filter((x) => x === r.onIro[0]),
      '★選ばれている 物と 同じ 色が あります（見分けが つきません）★'
    ).toEqual([]);
  }
});

// ★★実費（高速代など）を 引いているか★★ 2026-09-05
//   ★上の 見本は 実費 0★なので「引かない」に 壊しても 気づけません
//   ⇒ ★実費が 入った 見本★で 別に 押します
//   ★★わざと壊して 赤に なる事を 見た★★ … 実費を 引かない ⇒ ★赤★
test('★実費を 引いた 後の 売上か★', async ({ page }) => {
  const JIPPI = 3000;
  const F2 = JSON.parse(JSON.stringify(FIX));
  // ★1本目の 勤務に 高速代を 付ける★
  F2.edits = [{ shift_id: F2.shifts[0].shift_id, toll_yen: JIPPI }];
  F2.salesSettings = { deduct_toll: true, deduct_bridge: true, deduct_other: false };
  const moto2 = fs.readFileSync(path.join(__dirname, '..', '..', 'js', 'dk-session.js'), 'utf8');
  const co = { company_id: F2.settings[0].company_id, name: '見張り用' };
  const body =
    moto2 +
    ';(function(){var F=' +
    JSON.stringify(F2) +
    ';var co=' +
    JSON.stringify(co) +
    ';' +
    'function rows(p){ if(p.indexOf("dk_employees")===0)return F.emps||[]; if(p.indexOf("dk_device_labels")===0)return F.labels||[];' +
    ' if(p.indexOf("dk_payroll_settings")===0)return F.settings||[]; if(p.indexOf("dk_sales_settings")===0)return F.salesSettings?[F.salesSettings]:[];' +
    ' if(p.indexOf("dk_shifts")===0)return F.shifts||[];' +
    ' if(p.indexOf("dk_shift_edits")===0)return F.edits||[]; if(p.indexOf("dk_work_hours")===0)return F.workHours||[];' +
    ' if(p.indexOf("dk_manual_days")===0)return F.manualDays||[]; return [];}' +
    'var S=window.DKSession;S.ensure=function(){return Promise.resolve({token:"d"});};S.goLogin=function(){};S.logout=function(){};' +
    'S.rememberedCompanyId=function(){return co.company_id;};S.pickCompany=function(){return {mode:"one",company:co};};' +
    'S.myCompanies=function(){return Promise.resolve({ok:true,json:function(){return Promise.resolve([co]);}});};' +
    'S.rest=function(s,p){return Promise.resolve({ok:true,status:200,json:function(){return Promise.resolve(rows(p));}});};' +
    'S.softList=function(s,p,st){if(st)st.tried++;return Promise.resolve(rows(p));};})();';
  await page.route('**/js/dk-session.js*', (r) =>
    r.fulfill({ status: 200, contentType: 'application/javascript; charset=utf-8', body: body })
  );
  await page.setViewportSize({ width: 390, height: 900 });
  await page.goto('/shukei.html', { waitUntil: 'domcontentloaded' });
  await page.locator('#uriTbl').waitFor({ state: 'visible', timeout: 15000 });
  await page.waitForTimeout(1500);
  const r = await yomu(page);
  const moto = await page.evaluate(() =>
    [...document.querySelectorAll('#tbody tr')]
      .map((tr) => [tr.children[0].textContent.trim(), tr.children[1].textContent.trim()])
      .filter((x) => x[1] && x[1] !== '—')
  );
  console.log(
    '★実費 ' +
      JIPPI +
      '円 入りの 見本★ 元 ' +
      JSON.stringify(moto) +
      ' ／ 売上の箱 ' +
      JSON.stringify(gou(r))
  );
  // ★元の 表も 実費を 引いている★ので 両方 同じに なる
  expect(gou(r)[1], '★実費を 引いていません（元の 表と 違います）★').toBe(moto[moto.length - 1][1]);
  // ★実費が 本当に 効いている 見本か★（0円なら 壊しても 気づけない）
  const hiku = await page.evaluate(() => {
    let g = 0;
    const by = (window.CTX && window.CTX.byDate) || {};
    Object.keys(by).forEach((d) => Object.keys(by[d]).forEach((v) => (g += by[d][v].expense || 0)));
    return g;
  });
  console.log('★見本の 実費 合計★ ' + hiku + '円');
});
