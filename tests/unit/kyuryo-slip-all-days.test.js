// ============================================================
// ★給料明細は 期の日を全部 見せる（スマホでも）★ 2026-08-25
//
//   ★司さん★「なんで2日分しか載せてないんど」
//     私が 2日分の作り物で見せたのが元。実物は 月3回払いで
//     ★1期＝10日 または 11日ぶん★（8/1〜8/10 / 8/11〜8/20 / 8/21〜8/31）。
//
//   ★倉庫の本物の行で実測（2026-08-25・375px）★
//     横に並べた表 … 715px ／ 入る箱 324px ＝ ★393px はみ出し★
//     ＝ スマホでは ★2日ぶんしか見えない★（横に振らないと読めない・振れる印も出ない）
//     売上の行も 車6台ぶん出るので さらに長い。
//
//   ★直した形★
//     ・★紙（PDF）は 今まで通り 横★＝実物の給料明細と同じ並び（1バイトも変えない）
//     ・★スマホの画面だけ 1日1行の縦★＝10日/11日 ぜんぶ見える・横にずれない
//     ・出し分けは CSS の @media だけ。★字の作り方は JS の1本（F）★＝二度書かない。
//     ・縦では ★その日 売上が在った車だけ★ 出す（空の車を6行 並べても読めない）
//     ・休んだ日は「—」（決まり「休んだ日は空欄です」を 縦でも守る）
//
//   ★直した後の実測★
//     375px … 日 10個 全部・横ずれ なし ／ 21〜末日（11日）でも 11個 全部
//     412px … 同じ ／ 1000px … 今まで通り 横・日 10個
//     PDFの窓 … 中に 横の表が在り 日 10個（紙は変わっていない）
// ============================================================
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
// ★行末を そろえてから見る★
//   このrepoの手元は CRLF。'\n' で探すと ★在るのに無いと言う（嘘の赤）★（2026-08-25 実測）。
const HTML = fs.readFileSync(path.join(ROOT, 'kyuryo.html'), 'utf8').replace(/\r\n/g, '\n');

// そのCSSの決まり1つ分だけを取り出す（行の頭から探す＝中の同じ名前を掴まない）
function ruleOf(html, selector) {
  const i = html.indexOf('\n' + selector + ' {');
  if (i < 0) return null;
  const j = html.indexOf('}', i);
  return html.slice(i, j);
}
function mediaBlock(html, head) {
  const i = html.indexOf(head);
  if (i < 0) return null;
  // @media の中身（次の「      }」＝閉じるまで）
  const end = html.indexOf('\n      }\n', i);
  return end < 0 ? html.slice(i) : html.slice(i, end);
}

describe('★期の日を全部 見せる★', () => {
  it('横（紙）と 縦（スマホ画面）の 両方を出している', () => {
    expect(HTML, '★紙用の横が無い★').toContain('<div class="yoko scroller">');
    expect(HTML, '★スマホ用の縦が無い★').toContain("html += '<div class=\"tate\">'");
  });

  it('★どちらも 期の日を全部 まわしている★（一部だけ出していない）', () => {
    const i = HTML.indexOf('<div class="yoko scroller">');
    const j = HTML.indexOf("html += '</div>';", HTML.indexOf('<div class="tate">'));
    const block = HTML.slice(i, j);
    // 横の日付の見出し・縦の1日ずつ ＝ どちらも e.cells を全部まわす
    const n = (block.match(/e\.cells\.forEach/g) || []).length;
    expect(n, `★e.cells を全部まわしている所が ${n} か所しかない★`).toBeGreaterThanOrEqual(3);
    expect(block, '★日を切り落としている（slice）★').not.toMatch(/e\.cells\.slice\(/);
  });

  it('★字の作り方は 1本（F）★＝横と縦で 違う数が出ない', () => {
    expect(HTML, '★共通の作り方が無い★').toContain('var F = {');
    // 中身の取り出しを 2度 書いていない（書くと 横と縦で ずれる）
    for (const key of ['c.pay === null', 'c.hours === null', 'c.poolHours === null']) {
      const n = (HTML.match(new RegExp(key.replace(/\./g, '\\.'), 'g')) || []).length;
      expect(n, `★"${key}" を ${n} か所で書いている（1か所にする）★`).toBe(1);
    }
  });

  it('★紙は いつも 横★（実物の給料明細と同じ並び・縦は紙に出さない）', () => {
    const pr = mediaBlock(HTML, '@media print {');
    expect(pr, '★紙の決まりが無い★').toBeTruthy();
    expect(pr, '★紙で 横が出るようにしていない★').toMatch(/\.slip \.yoko \{\s*display: block !important;/);
    expect(pr, '★紙に 縦まで出る★').toMatch(/\.slip \.tate \{\s*display: none !important;/);
  });

  it('★狭い画面だけ 縦にする★（パソコンは今まで通り 横）', () => {
    const tate = ruleOf(HTML, '      .slip .tate');
    expect(tate, '★.slip .tate が無い★').toBeTruthy();
    expect(tate, '★既定で 縦が出てしまう（パソコンで2つ出る）★').toContain('display: none');
    const nb = mediaBlock(HTML, '@media (max-width: 480px) {\n        .slip .yoko');
    expect(nb, '★狭い画面の決まりが無い★').toBeTruthy();
    expect(nb, '★狭い画面で 横を隠していない★').toMatch(/\.slip \.yoko \{\s*display: none;/);
    expect(nb, '★狭い画面で 縦を出していない★').toMatch(/\.slip \.tate \{\s*display: block;/);
  });

  it('★縦は その日 売上が在った車だけ★（空の車を6行 並べない）', () => {
    const i = HTML.indexOf("html += '<div class=\"tate\">'");
    const block = HTML.slice(i, i + 1600);
    expect(block, '★売上の出し分けをしていない★').toContain("if (v !== '') uri.push(");
    expect(block, '★載せる/載せないの決まりを 縦で見ていない★').toContain('if (SHOW_CAR_SALES)');
  });

  it('★休んだ日も 日付は出す（中身は「—」）★', () => {
    const i = HTML.indexOf("html += '<div class=\"tate\">'");
    const block = HTML.slice(i, i + 1600);
    expect(block, '★休んだ日の見分けが無い★').toContain('var yasumi =');
    expect(block, '★休んだ日に 何も出ない（日付ごと消える）★').toContain('class="dn">—');
  });
});
