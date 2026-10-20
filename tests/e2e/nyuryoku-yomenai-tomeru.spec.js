// ============================================================
// ★★見張り：入力の 画面＝実費などの 記録が 読めなかった 時は 打たせない（前の 額を 0 で 上書きしない）★★ 2026-10-21
//   ★前★ 実費（dk_shift_edits）の 読みが 失敗しても 欄は 全部 押せた。電子決済に 500 と 打つと
//         {"toll_yen":0,"bridge_yen":0,"other_yen":0,"denshi_yen":500,...} が 送られ、倉庫の 高速代 1000 が 0 で 上書き＝売上が 1000 増える
//         （分からない 時に 通す 側に 倒れた・対立役が 測った）
//         日を 変えた 先で 業務の 読みが 失敗した 時・読みが 返る 前も、前の 日の 欄が 押せ、前の 日の 額を 今の 日へ 送った（対立役 止1・止2）
//   ★今★ 保存が 頼る 読み（実費・手で 入れた 日）の どちらかが 失敗したら 欄を 全部 押せなく し、訳を 車の 上に 出す。保存の 口も 断る
//         読んでいる 間と、業務の 読みが 失敗した 時も 押せない。古い 返事は 捨てる
//         実費の 名前・電子決済の 日は 送る 中身に 効かない＝読めなくても 打てる（前の 額は そのまま 送る）
//   ★★わざと壊して 赤に なるのを 見た（2026-10-21 実測）★★ 13本
//     直す 前の nyuryoku.html 6本 赤／前の 直し（21547ea）7本 赤
//     保存の 口の 門を 1つずつ 外す … saveJippi 1本・saveTebiki 3本・saveUriage 1本 赤
//     古い 読みの 返事を 捨てる 所を 外す 1本・手で 入れた 日の 保存の 返事を 別の 日に 入れない 所を 外す 1本 赤
//     読み込みが #err（保存の 失敗）を 消す 形に 戻す 1本（止A）・保存の 返事を 捨てる 形に 戻す 1本（止B）赤
// ============================================================
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

const LABELS = [{ company_id: 'c1', device_id: 'd1', label: '1466', sort_order: 1 }];
// 9/02＝走った 日（実費 高速 1000）／9/03・9/04＝走っていない 日（手で 入れた 1日ぶん）
const SH = [
  {
    shift_id: 's1',
    device_id: 'd1',
    started_at: '2026-09-02T10:00:00+09:00',
    ended_at: '2026-09-02T18:00:00Z',
    fare_total_yen: 28700,
    trip_count: 9,
  },
];
const ED = [{ shift_id: 's1', company_id: 'c1', toll_yen: 1000, bridge_yen: 0, other_yen: 0 }];
const MD = [
  { company_id: 'c1', work_date: '2026-09-03', device_id: 'd1', sales_yen: 5000, toll_yen: 1000 },
  { company_id: 'c1', work_date: '2026-09-04', device_id: 'd1', sales_yen: 9000, toll_yen: 7000 },
];

// 偽の 倉庫（窓の 中で 動く 字）。日付は 頼みの 字から 拾う
function stub(yomenai) {
  const moto = fs.readFileSync(path.join(__dirname, '..', '..', 'js', 'dk-session.js'), 'utf8');
  const co = { company_id: 'c1', name: 'ZERO代行' };
  const nakami = function (co, L, SH, ED, MD, yomenai) {
    window.__calls = [];
    window.__yomenai = yomenai;
    window.__shiftsDame = false;
    window.__osoi = 0;
    window.__osoiHi = {}; // 日ごとの 読みの 遅れ（古い 読みが 後から 返る 形）
    window.__osoiHozon = 0; // 保存の 返事の 遅れ
    window.__hozonDame = false; // 保存を 断る
    const S = window.DKSession;
    // 頼みの 字から「k.値」の 値を 拾う（& まで・URL の 字を 戻す）
    const atai = (p, k) => {
      const s = String(p);
      const i = s.indexOf(k + '.');
      if (i < 0) return '';
      const j = s.indexOf('&', i);
      return decodeURIComponent(s.slice(i + k.length + 1, j < 0 ? s.length : j));
    };
    const hiOf = (p, k) => atai(p, k).slice(0, 10);
    const rows = (p) => {
      if (p.indexOf('dk_shifts') === 0) {
        const kara = Date.parse(atai(p, 'started_at=gte'));
        const made = Date.parse(atai(p, 'started_at=lt'));
        return SH.filter((x) => {
          const t = Date.parse(x.started_at);
          return (isNaN(kara) || t >= kara) && (isNaN(made) || t < made);
        });
      }
      if (p.indexOf('dk_device_labels') === 0) return L;
      if (p.indexOf('dk_shift_edits') === 0) return ED;
      if (p.indexOf('dk_manual_days') === 0) {
        const w = hiOf(p, 'work_date=eq');
        return MD.filter((x) => x.work_date === w);
      }
      return [];
    };
    const hiNo = (p) => {
      const w = hiOf(p, 'work_date=eq');
      if (w) return w;
      const g = atai(p, 'started_at=gte');
      if (!g) return '';
      // 日本の 日（始めの 時刻 ＋9時間 の 日付）
      return new Date(Date.parse(g) + 9 * 3600000).toISOString().slice(0, 10);
    };
    const osoku = (v, p) => {
      const ms = (window.__osoiHi && window.__osoiHi[hiNo(p || '')]) || window.__osoi;
      return ms ? new Promise((ok) => setTimeout(() => ok(v), ms)) : Promise.resolve(v);
    };
    const kotae = (ok, st, v) => ({
      ok: ok,
      status: st,
      text: () => Promise.resolve(''),
      json: () => Promise.resolve(v),
    });
    S.ensure = () => Promise.resolve({ access_token: 't' });
    S.goLogin = () => {};
    S.logout = () => {};
    S.rememberedCompanyId = () => co.company_id;
    S.pickCompany = () => ({ mode: 'one', company: co });
    S.myCompanies = () => Promise.resolve(kotae(true, 200, [co]));
    S.rest = (s, p, o) => {
      const m = (o && o.method) || 'GET';
      if (m !== 'GET') {
        const b = o && o.body ? JSON.parse(o.body) : null;
        window.__calls.push({ p: p, m: m, b: b });
        const k = window.__hozonDame ? kotae(false, 503, []) : kotae(true, 200, [b]);
        return window.__osoiHozon
          ? new Promise((ok) => setTimeout(() => ok(k), window.__osoiHozon))
          : Promise.resolve(k);
      }
      if (String(p).indexOf('dk_shifts') === 0 && window.__shiftsDame)
        return osoku(kotae(false, 503, []), p);
      return osoku(kotae(true, 200, rows(p)), p);
    };
    S.softList = (s, p, st) => {
      if (st) st.tried++;
      if (window.__yomenai.some((n) => String(p).indexOf(n) === 0)) {
        if (st) st.failed++;
        return Promise.resolve([]);
      }
      return osoku(rows(p), p);
    };
  };
  return (
    moto +
    ';(' +
    nakami.toString() +
    ')(' +
    [co, LABELS, SH, ED, MD, yomenai].map((x) => JSON.stringify(x)).join(',') +
    ');'
  );
}

async function hiraku(page, yomenai, hi) {
  await page.route('**/js/dk-session.js*', (r) =>
    r.fulfill({
      status: 200,
      contentType: 'application/javascript; charset=utf-8',
      body: stub(yomenai),
    })
  );
  await page.route('**/auth/v1/**', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: '{"id":"u1"}' })
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/nyuryoku.html', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1800);
  await hiErabu(page, hi);
}
async function hiErabu(page, hi) {
  await page.fill('#hiSel', hi);
  await page.dispatchEvent('#hiSel', 'change');
  await page.waitForTimeout(1200);
}
const oseruKazu = (page) =>
  page.evaluate(
    () => Array.from(document.querySelectorAll('#shaList input')).filter((i) => !i.disabled).length
  );
// 欄を 押せなくても 字を 入れて change を 起こす（押せない 欄の 保存の 口が 断るかも 見る）
async function utsuMuri(page, sel, v) {
  await page.evaluate(
    (a) => {
      const i = document.querySelector(a.sel);
      i.value = a.v;
      i.dispatchEvent(new Event('change'));
    },
    { sel, v }
  );
  await page.waitForTimeout(500);
}
const okuttaKazu = (page) => page.evaluate(() => window.__calls.length);

// ★保存が 頼る 読みが 読めない★＝押せない・送らない・訳が 見える
for (const [na, yomenai, hi, sel] of [
  ['実費（走った 日の 実費の 欄）', ['dk_shift_edits'], '2026-09-02', '#shaList [data-sid]'],
  ['実費（走った 日の 売上の 直し）', ['dk_shift_edits'], '2026-09-02', '#shaList [data-uri-sid]'],
  [
    '手で 入れた 日（走っていない 日の 欄）',
    ['dk_manual_days'],
    '2026-09-03',
    '#shaList [data-dev]',
  ],
]) {
  test(`★${na}が 読めない 時は 欄を 押せない・送らない・訳を 出す★`, async ({ page }) => {
    await hiraku(page, yomenai, hi);
    expect(await page.locator(sel).count(), '★欄が 無い＝この 形を 測っていない★').toBeGreaterThan(
      0
    );
    expect(await oseruKazu(page), '★読めないのに 押せる 欄が 在る★').toBe(0);
    await expect(page.locator('#tomeJi'), '★打てない 訳が 車の 上に 見えない★').toBeVisible();
    await expect(page.locator('#tomeJi')).toContainText('読めません');
    await utsuMuri(page, sel, '500');
    expect(await okuttaKazu(page), '★読めないのに 倉庫へ 送った（前の 額を 上書きする）★').toBe(0);
  });
}

// ★送る 中身に 効かない 読み（実費の 名前・電子決済の 日）は 読めなくても 打てる・前の 額は そのまま 送る★（対立役 直2）
for (const [na, yomenai] of [
  ['実費の 名前', ['dk_expense_kinds']],
  ['電子決済の 日', ['dk_day_extras']],
]) {
  test(`★${na}が 読めなくても 打てて、高速代は 前の 額の まま 送る★`, async ({ page }) => {
    await hiraku(page, yomenai, '2026-09-02');
    const den = '#shaList [data-sid][data-f="denshi_yen"]';
    expect(await page.locator(den).count(), '★電子決済の 欄が 無い＝この 形を 測っていない★').toBe(
      1
    );
    await utsuMuri(page, den, '500');
    const c = await page.evaluate(() => window.__calls);
    expect(c.length, '★打てるのに 送らない★').toBeGreaterThan(0);
    expect(c[c.length - 1].b.toll_yen, '★前の 高速代 1000 を 0 で 上書きした★').toBe(1000);
  });
}

// ★日を 変えた 先で 業務の 読みが 失敗＝前の 日の 欄を 押せる まま 残さない★（対立役 止1）
test('★日を 変えて 業務が 読めない 時は 前の 日の 欄を 押せない・送らない★', async ({ page }) => {
  await hiraku(page, [], '2026-09-03');
  expect(
    await oseruKazu(page),
    '★前の 日（9/03）に 押せる 欄が 無い＝この 形を 測っていない★'
  ).toBeGreaterThan(0);
  await page.evaluate(() => {
    window.__shiftsDame = true;
  });
  await hiErabu(page, '2026-09-04');
  expect(await oseruKazu(page), '★業務が 読めないのに 前の 日の 欄が 押せる★').toBe(0);
  await utsuMuri(page, '#shaList [data-dev]', '500');
  expect(await okuttaKazu(page), '★前の 日の 額を 9/04 に 送った★').toBe(0);
});

// ★日を 変えた 直後（読みが 返る 前）も 押せない★（対立役 止2）
test('★日を 変えた 直後の 読み込み中は 前の 日の 欄を 押せない・送らない★', async ({ page }) => {
  await hiraku(page, [], '2026-09-03');
  expect(await oseruKazu(page)).toBeGreaterThan(0);
  await page.evaluate(() => {
    window.__osoi = 3000;
  });
  await page.fill('#hiSel', '2026-09-04');
  await page.dispatchEvent('#hiSel', 'change');
  await page.waitForTimeout(300);
  expect(await oseruKazu(page), '★読み込み中に 前の 日の 欄が 押せる★').toBe(0);
  await utsuMuri(page, '#shaList [data-dev]', '500');
  expect(await okuttaKazu(page), '★読み込み中に 前の 日の 額を 9/04 に 送った★').toBe(0);
  // 読み終わったら 9/04 の 欄で 打てる
  await page.waitForTimeout(4000);
  expect(await oseruKazu(page), '★読み終わったのに 押せない★').toBeGreaterThan(0);
});

test('★読めない 時の 後で もう一度 読んで 読めたら 打てる（いつまでも 止めない）★', async ({
  page,
}) => {
  await hiraku(page, ['dk_shift_edits'], '2026-09-02');
  expect(await oseruKazu(page)).toBe(0);
  await page.evaluate(() => {
    window.__yomenai = [];
  });
  await hiErabu(page, '2026-09-02');
  expect(await oseruKazu(page), '★読めたのに 欄が 押せない まま★').toBeGreaterThan(0);
  await expect(page.locator('#tomeJi')).toHaveCount(0);
});

test('★読めた 時は 今まで 通り 打てて、高速代は 前の 額の まま 送る★', async ({ page }) => {
  await hiraku(page, [], '2026-09-02');
  const den = '#shaList [data-sid][data-f="denshi_yen"]';
  expect(await page.locator(den).count()).toBe(1);
  await utsuMuri(page, den, '500');
  const c = await page.evaluate(() => window.__calls);
  expect(c.length, '★読めたのに 送らない★').toBeGreaterThan(0);
  expect(c[c.length - 1].b.toll_yen, '★前の 高速代 1000 を 0 で 上書きした★').toBe(1000);
});

// ★保存の 失敗は 日を 送って 読み直しても 消えない★（読み込みが #err を 消して 保存の 失敗を 黙らせた・対立役 止A）
test('★保存に 失敗した 後で 日を 送っても「保存できませんでした」が 残る★', async ({ page }) => {
  await hiraku(page, [], '2026-09-03');
  const toll = '#shaList [data-dev][data-f="toll"]';
  expect(await page.locator(toll).count(), '★高速代の 欄が 無い＝この 形を 測っていない★').toBe(1);
  await page.evaluate(() => {
    window.__hozonDame = true;
  });
  await utsuMuri(page, toll, '2500');
  await expect(page.locator('#err')).toContainText('保存できませんでした');
  await hiErabu(page, '2026-09-04');
  await expect(page.locator('#err'), '★保存の 失敗が 読み込みで 消えた★').toContainText(
    '保存できませんでした'
  );
});

// ★同じ 日の 読み直しと 保存の 返事が 重なっても、打った 額が 前の 額に 戻らない★（対立役 止B）
test('★同じ 日を 読み直した 後に 保存が 返っても、次の 1打で 打った 額を 送る★', async ({
  page,
}) => {
  await hiraku(page, [], '2026-09-02');
  const toll = '#shaList [data-sid][data-f="toll"]';
  expect(await page.locator(toll).count(), '★高速代の 欄が 無い＝この 形を 測っていない★').toBe(1);
  await page.evaluate(() => {
    window.__osoiHozon = 1500;
  });
  await utsuMuri(page, toll, '2000');
  // 保存が 返る 前に 同じ 日を 読み直す（読みは すぐ 返る＝倉庫は まだ 前の 1000）
  await hiErabu(page, '2026-09-02');
  await page.waitForTimeout(1500);
  await page.evaluate(() => {
    window.__osoiHozon = 0;
  });
  await utsuMuri(page, '#shaList [data-sid][data-f="denshi_yen"]', '500');
  const c = await page.evaluate(() => window.__calls);
  expect(c[c.length - 1].b.toll_yen, '★打った 高速代 2000 が 前の 1000 に 戻った★').toBe(2000);
});

// ★古い 日の 読みが 後から 返っても、今の 日の 画面・送る 額に 入れない★（対立役 直す-1）
test('★前の 日の 読みが 遅れて 返っても 今の 日の 額で 送る★', async ({ page }) => {
  await hiraku(page, [], '2026-09-02');
  await page.evaluate(() => {
    window.__osoiHi = { '2026-09-03': 2500 };
  });
  await page.fill('#hiSel', '2026-09-03');
  await page.dispatchEvent('#hiSel', 'change');
  await page.waitForTimeout(200);
  await hiErabu(page, '2026-09-04');
  await page.waitForTimeout(2500); // 9/03 の 読みが 後から 返る
  await utsuMuri(page, '#shaList [data-dev][data-f="denshi_yen"]', '300');
  const c = await page.evaluate(() => window.__calls);
  expect(c.length, '★9/04 で 打てない★').toBeGreaterThan(0);
  const b = c[c.length - 1].b;
  expect([b.work_date, b.sales_yen, b.toll_yen], '★前の 日（9/03）の 額を 9/04 に 送った★').toEqual(
    ['2026-09-04', 9000, 7000]
  );
});

// ★前の 日の 保存の 返事が 日を 送った 後に 返っても、今の 日の 表に 入れない★（対立役 直す-1）
test('★前の 日の 保存が 遅れて 返っても 今の 日の 額で 送る★', async ({ page }) => {
  await hiraku(page, [], '2026-09-03');
  await page.evaluate(() => {
    window.__osoiHozon = 1500;
  });
  await utsuMuri(page, '#shaList [data-dev][data-f="toll"]', '2500');
  await hiErabu(page, '2026-09-04');
  await page.waitForTimeout(1500); // 9/03 の 保存の 返事が 9/04 を 開いた 後に 返る
  await page.evaluate(() => {
    window.__osoiHozon = 0;
  });
  await utsuMuri(page, '#shaList [data-dev][data-f="denshi_yen"]', '300');
  const c = await page.evaluate(() => window.__calls);
  const b = c[c.length - 1].b;
  expect([b.work_date, b.sales_yen, b.toll_yen], '★前の 日（9/03）の 額を 9/04 に 送った★').toEqual(
    ['2026-09-04', 9000, 7000]
  );
});
