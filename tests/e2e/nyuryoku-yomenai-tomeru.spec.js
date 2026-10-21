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
        // 断らない 時は 偽の 倉庫に しまう（読み直すと しまった 額が 返る＝本物の 倉庫と 同じ）
        //   しまうのは 返事を 返す 時（本物も 着くまで 倉庫に 無い＝その 前に 始めた 読みは 前の 額を 返す）
        const dame = window.__hozonDame;
        const shimau = () => {
          if (dame || !b) return;
          if (String(p).indexOf('dk_shift_edits') === 0) {
            const i = ED.findIndex((x) => x.shift_id === b.shift_id);
            if (i < 0) ED.push(b);
            else ED[i] = Object.assign({}, ED[i], b);
          }
          if (String(p).indexOf('dk_manual_days') === 0) {
            const i = MD.findIndex(
              (x) => x.work_date === b.work_date && x.device_id === b.device_id
            );
            if (i < 0) MD.push(b);
            else MD[i] = Object.assign({}, MD[i], b);
          }
        };
        const k = dame ? kotae(false, window.__hozonDameNo || 503, []) : kotae(true, 200, [b]);
        return window.__osoiHozon
          ? new Promise((ok) =>
              setTimeout(() => {
                shimau();
                ok(k);
              }, window.__osoiHozon)
            )
          : (shimau(), Promise.resolve(k));
      }
      if (String(p).indexOf('dk_shifts') === 0 && window.__shiftsDame)
        return osoku(kotae(false, 503, []), p);
      return osoku(kotae(true, 200, JSON.parse(JSON.stringify(rows(p)))), p); // 頼んだ 時の 写し
    };
    S.softList = (s, p, st) => {
      if (st) st.tried++;
      if (window.__yomenai.some((n) => String(p).indexOf(n) === 0)) {
        if (st) st.failed++;
        return Promise.resolve([]);
      }
      return osoku(JSON.parse(JSON.stringify(rows(p))), p); // 頼んだ 時の 写し
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

// ★★同じ 行の 保存は 1本ずつ 順に（対立役 3回目 直す-1・直す-2・直す-3・直す-4）★★ 2026-10-21

// 直す-2：続けて 2つの 欄を 打つと 2つ目が 1つ目の 返事 前の 記録で 作られ、1つ目の 額を 前に 戻した
test('★続けて 2つの 欄を 打っても、2つ目は 1つ目の 額を 前に 戻さない★', async ({ page }) => {
  await hiraku(page, [], '2026-09-02');
  await page.evaluate(() => {
    window.__osoiHozon = 1000;
  });
  await utsuMuri(page, '#shaList [data-sid][data-f="toll"]', '2000');
  await utsuMuri(page, '#shaList [data-sid][data-f="denshi_yen"]', '300');
  await page.waitForTimeout(2500);
  const c = await page.evaluate(() => window.__calls);
  expect(c.length, '★2回 送っていない★').toBe(2);
  expect([c[1].b.toll_yen, c[1].b.denshi_yen], '★2つ目が 高速代を 前の 1000 に 戻した★').toEqual([
    2000, 300,
  ]);
});

// 直す-1：保存の 返事待ちの 間に 同じ 日を 読み直すと、保存 前の 写しで 読んだ 返事が 打った 額を 消した
test('★保存の 返事待ちの 間に 読み直しても、打った 額が 消えない★', async ({ page }) => {
  await hiraku(page, [], '2026-09-02');
  await page.evaluate(() => {
    window.__osoiHozon = 1500; // 保存の 返事は 読み直しを 始めた 後に 返る（utsuMuri が 0.5秒 待つ）
    window.__osoi = 2500; // 読みは 保存より 遅く 返る＝保存 前の 写しが 後から 返る
  });
  await utsuMuri(page, '#shaList [data-sid][data-f="toll"]', '2000');
  await page.fill('#hiSel', '2026-09-02');
  await page.dispatchEvent('#hiSel', 'change');
  await page.waitForTimeout(5500);
  await page.evaluate(() => {
    window.__osoi = 0;
    window.__osoiHozon = 0;
  });
  await expect(
    page.locator('#shaList [data-sid][data-f="toll"]'),
    '★画面の 高速代が 前の 1000 に 戻った★'
  ).toHaveValue('2000');
  await utsuMuri(page, '#shaList [data-sid][data-f="denshi_yen"]', '500');
  const c = await page.evaluate(() => window.__calls);
  expect(c[c.length - 1].b.toll_yen, '★打った 高速代 2000 が 前の 1000 に 戻った★').toBe(2000);
});

// 直す-3：保存の 失敗の 字が 別の 欄の 保存の 成功で 消えた（欄には 打った 額・倉庫は 前の 額＝客に 黙る）
test('★保存の 失敗の 字は 別の 欄の 成功で 消えない★', async ({ page }) => {
  await hiraku(page, [], '2026-09-02');
  await page.evaluate(() => {
    window.__hozonDame = true;
  });
  await utsuMuri(page, '#shaList [data-sid][data-f="toll"]', '2000');
  await expect(page.locator('#err')).toContainText('保存できませんでした');
  await page.evaluate(() => {
    window.__hozonDame = false;
  });
  // 別の 業務（車）の 欄は 無い＝同じ 業務の 別の 鍵（売上の 直し は 同じ 業務）でなく、同じ 業務の 別の 欄で 見る
  await utsuMuri(page, '#shaList [data-uri-sid]', '30000');
  await expect(page.locator('#err'), '★別の 欄の 成功で 保存の 失敗が 消えた★').toContainText(
    '保存できませんでした'
  );
});

// 直す-4：前の 月の「走った 日へ」を 探す 返事が 遅れて 返り、別の 月の 画面に 出た
test('★前の 月の「走った 日へ」の 返事が 遅れて 返っても 別の 月に 出さない★', async ({ page }) => {
  await hiraku(page, [], '2026-09-02');
  await page.evaluate(() => {
    window.__osoiHi = { '2026-09-01': 2500 }; // 9月の 月の 探しだけ 遅らせる
  });
  await page.fill('#hiSel', '2026-09-03');
  await page.dispatchEvent('#hiSel', 'change');
  await page.waitForTimeout(300);
  await hiErabu(page, '2026-10-05');
  await page.waitForTimeout(2500);
  await expect(
    page.locator('#hashittaHi'),
    '★10月の 画面に 9月の「走った 日へ」が 出た★'
  ).toBeHidden();
});

// ★★返事が 来ない 保存・2つの 失敗・打ち方の 間違い・読み込み待ちの 売上の 欄・手で 入れた 日の 順番★★ 2026-10-21（対立役 4回目）
const errJi = (page) =>
  page.evaluate(() => {
    const e = document.getElementById('err');
    return e.style.display === 'none' ? '' : e.textContent;
  });
const tomeJi = (page) =>
  page.evaluate(() => {
    const e = document.getElementById('tomeJi');
    return e ? e.textContent : '';
  });

// 直す-B（4回目）：返事の 来ない 保存 1本で 何も 言わずに「読み込み中」の まま 固まった
// 止め-1・止め-2（5回目）：時間切れで 順番と 読み直しを 開けると、遅れて 返事が 来た 時に 打った 額が 戻る・消えた
//   ⇒ 時間切れは 字を 出すだけ。順番と 読み直しは 本物の 返事まで 待つ。字は その 送りが 返った 時に 消える
test('★返事が 来ない 保存は 時間切れで 字を 出し、返事が 来るまで 読み直さない・来たら 戻る★', async ({
  page,
}) => {
  await hiraku(page, [], '2026-09-02');
  await page.evaluate(() => {
    window.__DK_HOZON_MATSU_MS = 1000; // 本物は 20秒
    window.__osoiHozon = 4000;
  });
  await utsuMuri(page, '#shaList [data-sid][data-f="toll"]', '2000');
  await page.evaluate(() => {
    window.__osoiHozon = 0;
  });
  await hiErabu(page, '2026-09-03');
  await page.waitForTimeout(1000); // 時間切れ 済み・返事は まだ
  expect(await errJi(page), '★倉庫に 入ったか 分からない 事を 客に 黙った★').toContain(
    '返事が 来ません'
  );
  expect(await oseruKazu(page), '★返事の 前に 読み直して 打たせた★').toBe(0);
  await page.waitForTimeout(3500); // 返事が 来て 読み直す
  expect(await oseruKazu(page), '★返事が 来ても 打てない まま★').toBeGreaterThan(0);
  expect(await errJi(page), '★返事が 来たのに 時間切れの 字が 残る★').toBe('');
});

// 直す-A：失敗した 欄を 1つしか 覚えず、2つ 失敗して 後の 1つが 直ると 前の 失敗の 字が 消えた
test('★2つの 欄が 失敗し 後の 1つだけ 直っても 前の 失敗の 字は 消えない★', async ({ page }) => {
  await hiraku(page, [], '2026-09-02');
  await page.evaluate(() => {
    window.__hozonDame = true;
  });
  await utsuMuri(page, '#shaList [data-sid][data-f="toll"]', '2000');
  await utsuMuri(page, '#shaList [data-sid][data-f="denshi_yen"]', '300');
  await page.evaluate(() => {
    window.__hozonDame = false;
  });
  await utsuMuri(page, '#shaList [data-sid][data-f="denshi_yen"]', '300');
  expect(await errJi(page), '★高速代 2000 は 倉庫に 無い のに 字が 消えた★').toContain(
    '保存できませんでした'
  );
  // 高速代も 直れば 消える（いつまでも 残さない）
  await utsuMuri(page, '#shaList [data-sid][data-f="toll"]', '2000');
  expect(await errJi(page), '★全部 直ったのに 字が 残る★').toBe('');
});

// 直す-C：売上の 打ち方の 間違いの 字が、正しく 打ち直して 保存できても 残った
test('★売上の 打ち方の 間違いの 字は 正しく 打ち直して 保存できたら 消える★', async ({ page }) => {
  await hiraku(page, [], '2026-09-02');
  await utsuMuri(page, '#shaList [data-uri-sid]', '-5');
  expect(await errJi(page)).toContain('0以上の 整数');
  await utsuMuri(page, '#shaList [data-uri-sid]', '30000');
  expect(await errJi(page), '★保存できたのに 間違いの 字が 残る★').toBe('');
});

// 直す-C：2台の 日に 読み込み待ちの 間、売上の 返事で 売上の 欄だけ 押せる に 戻り「読めません」と 違う 字が 出た
test('★読み込み待ちの 間は 売上の 返事が 来ても 売上の 欄を 押せない・字は「読み込み中」★', async ({
  page,
}) => {
  SH.push({
    shift_id: 's2',
    device_id: 'd2',
    started_at: '2026-09-02T11:00:00+09:00',
    ended_at: '2026-09-02T18:00:00Z',
    fare_total_yen: 10000,
    trip_count: 3,
  });
  LABELS.push({ company_id: 'c1', device_id: 'd2', label: '2000', sort_order: 2 });
  try {
    await hiraku(page, [], '2026-09-02');
    await page.evaluate(() => {
      window.__osoiHozon = 4000;
    });
    await utsuMuri(page, '#shaList [data-sid="s2"][data-f="toll"]', '700');
    await page.evaluate(() => {
      window.__osoiHozon = 600;
    });
    await utsuMuri(page, '#shaList [data-uri-sid="s1"]', '30000');
    await page.fill('#hiSel', '2026-09-02');
    await page.dispatchEvent('#hiSel', 'change');
    await page.waitForTimeout(600);
    expect(await oseruKazu(page), '★読み込み中なのに 押せる 欄が 在る★').toBe(0);
    expect(await tomeJi(page)).toContain('読み込み中です');
    expect(await tomeJi(page), '★読み込み中に「読めません」と 違う 字★').not.toContain(
      '読めません'
    );
  } finally {
    SH.pop();
    LABELS.pop();
  }
});

// 見立て（4回目）：手で 入れた 日の「順に 送る」に 効く 試験が 0本だった（22ff487 では 2つ目が 高速代を 2500→1000 に 戻した）
test('★手で 入れた 日：続けて 2つ 打っても 2つ目は 1つ目の 額を 戻さない・日を 送っても 混ざらない★', async ({
  page,
}) => {
  await hiraku(page, [], '2026-09-03');
  await page.evaluate(() => {
    window.__osoiHozon = 1000;
  });
  await utsuMuri(page, '#shaList [data-dev][data-f="toll"]', '2500');
  await utsuMuri(page, '#shaList [data-dev][data-f="denshi_yen"]', '300');
  await page.fill('#hiSel', '2026-09-04');
  await page.dispatchEvent('#hiSel', 'change');
  await page.waitForTimeout(2500);
  expect(await page.inputValue('#shaList [data-dev][data-f="toll"]'), '★9/04 に 9/03 の 額★').toBe(
    '7000'
  );
  const c = await page.evaluate(() =>
    window.__calls.map((x) => [x.b.work_date, x.b.sales_yen, x.b.toll_yen, x.b.denshi_yen])
  );
  expect(c[1], '★2つ目が 高速代を 前の 額に 戻した★').toEqual(['2026-09-03', 5000, 2500, 300]);
});

// ★★時間切れの 後に 遅れて 返事が 来ても 打った 額を 戻さない・消さない★★ 2026-10-21（対立役 5回目 止め-1・止め-2）
const tollVal = (page) => page.inputValue('#shaList [data-sid][data-f="toll"]');
const denVal = (page) => page.inputValue('#shaList [data-sid][data-f="denshi_yen"]');

test('★時間切れの 後に 同じ 業務の 次を 打っても 1つ目の 額を 戻さない（返事を 待って 作る）★', async ({
  page,
}) => {
  await hiraku(page, [], '2026-09-02');
  await page.evaluate(() => {
    window.__DK_HOZON_MATSU_MS = 1000;
    window.__osoiHozon = 4000;
  });
  await utsuMuri(page, '#shaList [data-sid][data-f="toll"]', '2000');
  await page.waitForTimeout(1000);
  expect(await errJi(page)).toContain('返事が 来ません');
  await page.evaluate(() => {
    window.__osoiHozon = 0;
  });
  await utsuMuri(page, '#shaList [data-sid][data-f="denshi_yen"]', '300');
  await page.waitForTimeout(4000);
  const c = await page.evaluate(() => window.__calls.map((x) => [x.b.toll_yen, x.b.denshi_yen]));
  expect(c[1], '★2つ目が 高速代を 1000 に 戻して 送った★').toEqual([2000, 300]);
  await hiErabu(page, '2026-09-03');
  await hiErabu(page, '2026-09-02');
  expect(
    { toll: await tollVal(page), den: await denVal(page) },
    '★倉庫の 額が 打った 額と 違う★'
  ).toEqual({
    toll: '2000',
    den: '300',
  });
});

test('★時間切れの 後も 返事の 前に 読み直さない（保存 前の 写しで 打った 額を 消さない）★', async ({
  page,
}) => {
  await hiraku(page, [], '2026-09-02');
  await page.evaluate(() => {
    window.__DK_HOZON_MATSU_MS = 1000;
    window.__osoiHozon = 2500;
    window.__osoi = 3000;
  });
  await utsuMuri(page, '#shaList [data-sid][data-f="toll"]', '2000');
  await page.fill('#hiSel', '2026-09-02');
  await page.dispatchEvent('#hiSel', 'change');
  await page.waitForTimeout(6500);
  await page.evaluate(() => {
    window.__osoi = 0;
    window.__osoiHozon = 0;
  });
  expect(await tollVal(page), '★画面の 高速代が 前の 1000 に 戻った★').toBe('2000');
  await utsuMuri(page, '#shaList [data-sid][data-f="denshi_yen"]', '500');
  const c = await page.evaluate(() => window.__calls.map((x) => [x.b.toll_yen, x.b.denshi_yen]));
  expect(c[c.length - 1][0], '★次の 1打で 高速代 2000 を 1000 に 戻した★').toBe(2000);
});

test('★手で 入れた 日：時間切れの 後 次の 保存も 1つ目の 額を 戻さない・日を 変えて 書けたら 字が 消える★', async ({
  page,
}) => {
  await hiraku(page, [], '2026-09-03');
  await page.evaluate(() => {
    window.__DK_HOZON_MATSU_MS = 1000;
    window.__osoiHozon = 4000;
  });
  await utsuMuri(page, '#shaList [data-dev][data-f="toll"]', '2500');
  await page.waitForTimeout(1000);
  await page.evaluate(() => {
    window.__osoiHozon = 0;
  });
  await utsuMuri(page, '#shaList [data-dev][data-f="denshi_yen"]', '300');
  await page.waitForTimeout(4000);
  await hiErabu(page, '2026-09-04');
  await hiErabu(page, '2026-09-03');
  expect(
    (await page.inputValue('#shaList [data-dev][data-f="toll"]')) +
      '/' +
      (await page.inputValue('#shaList [data-dev][data-f="denshi_yen"]')),
    '★倉庫が 打った 額と 違う★'
  ).toBe('2500/300');
  expect(await errJi(page), '★書けたのに 字が 残る★').toBe('');
});

// 4回目 直す-C の 字の 直し（読み込み中の 一打は「読み込み中です」）を 守る 試験が 0本だった（対立役 5回目 直す-4）
test('★読み込み中に 欄へ 字が 入っても 送らず 字は「読み込み中です」★', async ({ page }) => {
  await hiraku(page, [], '2026-09-02');
  await page.evaluate(() => {
    window.__osoi = 3000;
  });
  await page.fill('#hiSel', '2026-09-03');
  await page.dispatchEvent('#hiSel', 'change');
  await page.waitForTimeout(300);
  await page.evaluate(() => {
    const i = document.querySelector('#shaList [data-sid][data-f="toll"]');
    if (i) {
      i.value = '777';
      i.dispatchEvent(new Event('change'));
    }
  });
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => window.__calls.length), '★読み込み中に 送った★').toBe(0);
  expect(await tomeJi(page)).toContain('読み込み中です');
  expect(await tomeJi(page)).not.toContain('読めません');
});

// ★★断りの 字・上の 字・字の 消え方★★ 2026-10-21（対立役 6回目 直す-1・直す-2・直す-3）
// 直す-1：403 の「◯◯ には書き込めません」が、日を 変えると 会社名の 無い 字に 置き換わった（95d3f3e で 入った 後退）
test('★403 で 断られた 会社名つきの 字は 日を 変えても 残る★', async ({ page }) => {
  await hiraku(page, [], '2026-09-02');
  await page.evaluate(() => {
    window.__hozonDame = true;
    window.__hozonDameNo = 403;
  });
  await utsuMuri(page, '#shaList [data-sid][data-f="toll"]', '2000');
  expect(await errJi(page)).toContain('には書き込めません');
  await page.evaluate(() => {
    window.__hozonDame = false;
  });
  await hiErabu(page, '2026-09-03');
  expect(await errJi(page), '★日を 変えたら 会社名の 手がかりが 消えた★').toContain(
    'には書き込めません'
  );
});

// 直す-2：返事待ちで 読み直しが 止まって いる 間、上の 字は「読み込み中です」だけで 訳も 出口も 無かった（#err は 一覧の 下＝画面の 外）
test('★返事待ちで 止まって いる 間は 車の 上の 字に 時間切れの 訳と 出口が 出る★', async ({
  page,
}) => {
  await hiraku(page, [], '2026-09-02');
  await page.evaluate(() => {
    window.__DK_HOZON_MATSU_MS = 1000;
    window.__osoiHozon = 5000;
  });
  await utsuMuri(page, '#shaList [data-sid][data-f="toll"]', '2000');
  await page.evaluate(() => {
    window.__osoiHozon = 0;
  });
  await hiErabu(page, '2026-09-03');
  await page.waitForTimeout(1200);
  expect(await tomeJi(page), '★上の 字に 時間切れの 訳が 無い★').toContain('返事が 来ません');
  expect(await tomeJi(page)).toContain('読み込み直して');
  const r = await page.evaluate(() => {
    const e = document.getElementById('tomeJi');
    const b = e.getBoundingClientRect();
    return { top: b.top, bottom: b.bottom, vh: innerHeight };
  });
  expect(r.top, '★上の 字が 画面の 外★').toBeGreaterThanOrEqual(0);
  expect(r.bottom, '★上の 字が 画面の 外★').toBeLessThanOrEqual(r.vh);
});

// 直す-3（n2）：売上の 打ち方の 間違いの 字は 描き直す 時に 消す（日を 往復すると 欄の -5 は 消えるのに 字が 残った）
test('★売上の 打ち方の 間違いの 字は 日を 往復したら 消える★', async ({ page }) => {
  await hiraku(page, [], '2026-09-02');
  await utsuMuri(page, '#shaList [data-uri-sid]', '-5');
  expect(await errJi(page)).toContain('0以上の 整数');
  await hiErabu(page, '2026-09-03');
  await hiErabu(page, '2026-09-02');
  expect(await errJi(page), '★欄の 字は 消えたのに 間違いの 字が 残る★').not.toContain(
    '0以上の 整数'
  );
});

// 直す-3（n3）：手で 入れた 日の 失敗の 字は、日を 変えた 後に 書けても 消える
test('★手で 入れた 日：失敗の 後 打ち直して 日を 変えた 後に 書けたら 失敗の 字が 消える★', async ({
  page,
}) => {
  await hiraku(page, [], '2026-09-03');
  await page.evaluate(() => {
    window.__hozonDame = true;
  });
  await utsuMuri(page, '#shaList [data-dev][data-f="toll"]', '2500');
  expect(await errJi(page)).toContain('保存できませんでした');
  await page.evaluate(() => {
    window.__hozonDame = false;
    window.__osoiHozon = 1500;
  });
  await utsuMuri(page, '#shaList [data-dev][data-f="toll"]', '2500');
  await page.fill('#hiSel', '2026-09-04');
  await page.dispatchEvent('#hiSel', 'change');
  await page.waitForTimeout(2500);
  await page.evaluate(() => {
    window.__osoiHozon = 0;
  });
  expect(await errJi(page), '★書けたのに 失敗の 字が 残る★').not.toContain('保存できませんでした');
});

// 直す-3（n5）：字が 2つ 残る 時は 最後の 欄の 字を 出す
test('★保存の 失敗の 後に 打ち方の 間違いが 来たら 間違いの 字を 出す★', async ({ page }) => {
  await hiraku(page, [], '2026-09-02');
  await page.evaluate(() => {
    window.__hozonDame = true;
  });
  await utsuMuri(page, '#shaList [data-sid][data-f="toll"]', '2000');
  await page.evaluate(() => {
    window.__hozonDame = false;
  });
  expect(await errJi(page)).toContain('保存できませんでした');
  await utsuMuri(page, '#shaList [data-uri-sid]', '-5');
  expect(await errJi(page), '★後から 来た 間違いの 字が 出ない★').toContain('0以上の 整数');
});
