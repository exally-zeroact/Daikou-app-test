// ============================================================
// ★★見張り：明細の 紙は 車が 多くても 下が 切れない★★ 2026-10-07
//
//   司さん「前からある2つもやれ」（対立役：車 9台＋内わけ 1行 で 紙の 下が 切れた）
//   ★直し★ 字も 行の 高さも 変えず、車の 行が 入らない 時は 次の 紙へ（売上n の 番号は 続き）
//   ★物差し★ どの 紙も 高さ ≦ 794px（A4横の 板）・売上1〜12 が ちょうど 1回ずつ 出る
//
//   ★★わざと壊して 赤に なるのを 見た（2026-10-07 実測）★★
//     _maisu の 車の 分け方を 外す（carN を 1 に する）⇒ ★赤★（高さが 794 を 越える）
// ============================================================
const { test, expect } = require('@playwright/test');
const { openKyuryo } = require('./kyuryo-harness');

test('★車 12台 ＋ 手当・控除の 内わけ でも 明細の 紙は 切れない・売上1〜12 が 1回ずつ★', async ({
  page,
}) => {
  const err = [];
  page.on('pageerror', (e) => err.push(e.message));
  await page.setViewportSize({ width: 1280, height: 900 });
  await openKyuryo(page, (f) => {
    // ★車を 12台に（名前だけ 足す＝明細には 会社の 車が 全部 並ぶ）★
    const ari = f.labels.length;
    for (let i = ari; i < 12; i++) {
      f.labels.push({
        company_id: f.labels[0].company_id,
        device_id: '00000000-0000-4000-9000-0000000001' + String(i).padStart(2, '0'),
        label: '車' + (i + 1),
        sort_order: i + 1,
      });
    }
    const w = f.workHours[0];
    f.adjustments = [
      {
        adj_id: 'a1',
        employee_id: w.employee_id,
        work_date: w.work_date,
        kind: 'teate',
        label: 'ガソリン代',
        yen: 500,
      },
    ];
    f.settings[0].pay_extra = { kaisu: 100, kasanAto: true };
    return f;
  });
  await page.waitForTimeout(1500);
  const r = await page.evaluate(() => {
    const P = window.__paper;
    const out = [];
    for (let ei = 0; ei < P.ninzu(); ei++) {
      const els = P.sheets(ei);
      const uri = [];
      const takasa = els.map((el) => {
        el.style.position = 'absolute';
        el.style.left = '0';
        el.style.top = '0';
        document.body.appendChild(el);
        const h = el.scrollHeight;
        el.querySelectorAll('th').forEach((th) => {
          // ★1行目（売上n）だけ 読む★（2行目の 車の 名前「1466」を 番号に くっつけない）
          const d = th.querySelector('div');
          const m = /^売上(\d+)$/.exec(((d && d.textContent) || '').trim());
          if (m) uri.push(Number(m[1]));
        });
        el.remove();
        return h;
      });
      out.push({ ei: ei, mai: els.length, takasa: takasa, uri: uri });
    }
    return out;
  });
  // eslint-disable-next-line no-console
  console.log('★紙★ ' + JSON.stringify(r));
  expect(r.length, '★人が 居ない★').toBeGreaterThan(0);
  r.forEach((x) => {
    x.takasa.forEach((h, i) => {
      expect(
        h,
        '★' + x.ei + '人目 ' + (i + 1) + '枚目の 高さ ' + h + 'px が 紙（794px）を 越えて 切れる★'
      ).toBeLessThanOrEqual(794);
    });
    const uniq = Array.from(new Set(x.uri)).sort((a, b) => a - b);
    expect(uniq, '★売上1〜12 が 揃っていない★').toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  });
  expect(err, '★画面が 落ちた★').toEqual([]);
});
