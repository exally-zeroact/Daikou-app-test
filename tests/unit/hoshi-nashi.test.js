'use strict';
// ============================================================
// ★★お客さんの 画面に 出る 字に ★ を 出さない★★ 2026-10-10（司さん「対立でやれ」）
//   何を・どこを 見るかは tests/tools/hoshi-kazoeru.js の 頭に 書いた。
//   ★上限を 付けず 0本★（上限は「下げれば 通る」と「減らす 途中の 数が 天井に なる」で 死ぬ）。
//   ★白名簿 なし★＝注記の 外は console も throw も 全部 0本。
//
//   ★直す 前の 数（2026-10-10 origin/main 4907e46fc）★
//     JS の 字の 塊 39個（9ファイル）＋ HTML の 本文 5行 ＋ manifest 2本 ＝ 46 → 0
//   ★0本で 緑に しない★＝下の 下限（ファイル数・inline script・字の塊）を 割ったら 赤
// ============================================================
const { HOSHI, jsWoMiru, htmlWoMiru, zenbuKazoeru } = require('../tools/hoshi-kazoeru.js');
const fs = require('fs');
const path = require('path');

const k = zenbuKazoeru();
console.log(
  `[hoshi-nashi] 範囲=${k.hani.length}（js ${k.js}・html ${k.html}・manifest ${k.json}）inline script=${k.inlineScript} 字の塊=${k.katamari} ★=${k.hoshi.length}`
);

describe('客の 字に ★ が 無い', () => {
  it('★ は 0本（場所を 全部 出す）', () => {
    expect(k.hoshi).toEqual([]);
  });
  it('読めない js・script が 無い（読めないと 中の ★ を 見落とす）', () => {
    expect(k.yomenai).toEqual([]);
  });
  it('html の src が repo に 無い ファイルを 指していない', () => {
    expect(k.nakuSrc).toEqual([]);
  });
  it('JS の 字で 名指しされた repo の js は 全部 範囲の 中（読み込まれるのに 見ていない js を 作らない）', () => {
    expect(k.minaiSrc).toEqual([]);
  });
  it('見る 範囲が 痩せていない（0本で 緑に しない）', () => {
    expect(k.js).toBeGreaterThanOrEqual(55);
    expect(k.html).toBeGreaterThanOrEqual(20);
    expect(k.json).toBeGreaterThanOrEqual(2);
    expect(k.inlineScript).toBeGreaterThanOrEqual(25);
    expect(k.katamari).toBeGreaterThanOrEqual(10000);
  });
  it('一番 守りたい 物が 範囲に 入っている（名指し）', () => {
    for (const f of [
      'index.html',
      'kyuryo.html',
      'ryokinhyou.html',
      'nyuryoku.html',
      'dashboard.html',
      'js/obd-client.js',
      'js/fare-config-store.js',
      'manifest.json',
      'office-manifest.json',
      'sw.js',
      // html から 読まれて 客に 配られる＝scripts/ に 在っても 見る
      'scripts/zeroact-test-commons/observability/sentry-config.js',
    ]) {
      expect(k.hani).toContain(f);
    }
  });
  it('data/ を 外す 訳が 生きている（本物の 店の 名前に ★ が 在る＝消すと 名前が 変わる）', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '..', '..', 'data', 'michinoeki-jp.js'),
      'utf8'
    );
    expect(src).toMatch(/★/);
    expect(k.hani.some((f) => f.startsWith('data/'))).toBe(false);
  });
});

// ★門の 歯★＝緑で 通り抜ける 形を 作って、全部 赤に なる 事を 見る（対立役 2026-10-10 の W 型）
describe('門の 歯（作った 入力で 赤に なるか）', () => {
  const jsAka = (s) => jsWoMiru(s).hoshi.length;
  const htmlAka = (s) => htmlWoMiru(s).hoshi.length;

  it('JS：字の ★・逃がし・template・数から 作る 形 は 赤', () => {
    expect(jsAka("el.textContent = '★注意★';")).toBe(1);
    expect(jsAka('throw new Error("\\u2605 だめ");')).toBe(1);
    expect(jsAka('x = "\\u{2605}";')).toBe(1);
    expect(jsAka('x = `合計 ${n} ★`;')).toBe(1);
    expect(jsAka('el.innerHTML = "&#9733;";')).toBe(1);
    expect(jsAka('el.innerHTML = "&#09733";')).toBe(1);
    expect(jsAka('el.innerHTML = "&#x02605;";')).toBe(1);
    expect(jsAka('el.innerHTML = "&starf;";')).toBe(1);
    expect(jsAka('s.textContent = String.fromCharCode(9733);')).toBe(1);
    expect(jsAka('s.textContent = String.fromCodePoint(0X2605);')).toBe(1);
    expect(jsAka("x = decodeURIComponent('%E2%98%85');")).toBe(1);
    expect(jsAka('st.textContent = ".a::before{content:\\"\\\\2605\\"}";')).toBe(1);
  });
  it('JS：注記の 中だけなら 緑・正規表現の バッククォートで 飲み込まない', () => {
    expect(jsAka('// ★経緯★\n/* ★ */ var a = 1;')).toBe(0);
    expect(jsAka("var r = /`/; var b = 'ふつう'; // ★\nvar c = '★';")).toBe(1);
    expect(jsAka('var a = b++ / 2; var s = "★";')).toBe(1);
  });
  it('JS：読めない 字は 黙らない', () => {
    expect(jsWoMiru("var s = 'とじない;").yomenai).toBeTruthy();
  });
  it('HTML：本文・隠れた 所・属性・実体参照 は 赤', () => {
    expect(htmlAka('<p>★注意★</p>')).toBe(1);
    expect(htmlAka('<div hidden style="display:none">★</div>')).toBe(1);
    expect(htmlAka('<input placeholder="★名前">')).toBe(1);
    expect(htmlAka('<p>&#9733;</p>')).toBe(1);
    expect(htmlAka('<p>&#9733 あ</p>')).toBe(1);
    expect(htmlAka('<p>&bigstar;</p>')).toBe(1);
    expect(htmlAka('<style>.x::before{content:"\\2605"}</style>')).toBe(1);
    expect(htmlAka('<template><b>★</b></template>')).toBe(1);
    expect(htmlAka('<script>el.textContent="★";</script>')).toBe(1);
    expect(htmlAka('<script type="application/ld+json">{"name":"★"}</script>')).toBe(1);
  });
  it('HTML：注記・CSS の 注記 だけなら 緑', () => {
    expect(htmlAka('<!-- ★経緯★ --><p>ふつう</p>')).toBe(0);
    expect(htmlAka('<div style="color:red; /* ★経緯★ */">あ</div>')).toBe(0);
    expect(htmlAka('<style>/* ★ */ .a{color:red}</style>')).toBe(0);
    expect(htmlAka('<script>// ★経緯\nvar a=1;</script>')).toBe(0);
  });
  it('HTML：注記の 中の「<script>」で 本物の script src を 飲み込まない（index.html の 形）', () => {
    const r = htmlWoMiru(
      '<!-- 古い <script> ロードは削除 --><script src="data/x.js"></script><p>★</p><script>var a=1;</script>'
    );
    expect(r.src).toEqual(['data/x.js']);
    expect(r.hoshi.length).toBe(1);
    expect(r.inlineScript).toBe(1);
    expect(r.yomenai).toEqual([]);
  });
  it('探す 形が 普通の 字を 拾わない', () => {
    expect(HOSHI.test('&#97330; \\u26050 料金 ☆ 2605円')).toBe(false);
  });
});
