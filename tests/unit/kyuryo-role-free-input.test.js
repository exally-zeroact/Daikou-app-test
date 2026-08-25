// ============================================================
// ★役割は 自由に打てる／打った役割に決まりが無ければ 赤く知らせる★ 2026-08-25
//
//   ★司さん★「乙の所が 自由に入力してカスタムできるようにしたらええやないか」
//   （それまでは select だけ＝「給料の設定」で足すまで 新しい役割を書けなかった）
//
//   ★自由に打てるようにすると 開く穴★
//     engine（daiko-payroll.js:146）は
//       const role = st.roles[p.role] || { rate: 0, floor: 0 };
//     ＝★決まりの無い役割は 歩合0・最低保証0★。エラーは出ない。
//     ＝打ち間違い1文字で ★誰にも気づかれずに 金額が小さくなる★（一番こわい形）。
//
//   ★実測（本物の行で押した・2026-08-25）★
//     決まりに無い「2種」を打った時
//       太郎（歩合も保証も 打っていない） 18,500円 → ★0円★
//       次郎（歩合 0.3500 だけ 打ってある） 7,000円 → ★2,502円★（保証が0になった）
//       三郎（保証 1200 だけ 打ってある）  11,400円 → 11,400円（1200 x 9.50・変わらず）
//       四郎（決まりの在る「乙」のまま）    注意なし
//     ⇒ ★起きる事は3通り★なので 言葉も3通りに書き分ける。
//
//   ★見張りが 一度 嘘をついた★
//     はじめ「0円になります」と1つだけ出したが、三郎は 0円ではなく 11,400円だった。
//     ★押して 実際の金額を見た★ ので気づけた（文だけ読んでいたら 通していた）。
// ============================================================
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const HTML = fs.readFileSync(path.join(ROOT, 'kyuryo.html'), 'utf8').replace(/\r\n/g, '\n');
const ENGINE = fs.readFileSync(path.join(ROOT, 'js', 'daiko-payroll.js'), 'utf8');

describe('★役割は 自由に打てる★', () => {
  it('選ぶ事も 打つ事も できる（select だけにしない）', () => {
    expect(HTML, '★役割が 打てない（選ぶだけ）★').toContain(
      '<input class="txt rolein" list="roleList"'
    );
    expect(HTML, '★今ある役割が 候補に出ない★').toContain('<datalist id="roleList">');
  });

  it('打ち替えたら その場で 画面を出し直す（注意がすぐ出る）', () => {
    expect(HTML, '★打ち替えても 注意が出ない★').toContain("if (field === 'role') renderEmp();");
  });
});

describe('★決まりの無い役割は 赤く知らせる★', () => {
  it('engine が 決まりの無い役割を 0 として扱う事（穴の元）', () => {
    // ★この形が変わったら 注意の言葉も見直す★
    expect(ENGINE, '★engine の当てはめ方が変わった＝注意の言葉を見直す事★').toContain(
      "st.roles[(p && p.role) || ''] || { rate: 0, floor: 0 }"
    );
  });

  it('★起きる事は3通り★ 言葉も3通り書き分けている', () => {
    const i = HTML.indexOf('function _roleWarn(');
    expect(i, '★知らせる所が無い★').toBeGreaterThan(-1);
    const block = HTML.slice(i, i + 2600);
    expect(block, '★両方 打っていない時の言葉が無い★').toContain('給料は <b>0円</b> になります');
    expect(block, '★歩合だけ打ってある時の言葉が無い★').toContain('<b>最低保証が 0円</b>として');
    expect(block, '★保証だけ打ってある時の言葉が無い★').toContain('<b>歩合が 0</b>として');
    // ★「0円」だけを言う形に戻らない事★（一度 それで嘘をついた）
    expect(block, '★また 0円だけを言う形に戻っている★').toContain('var f = has(e.pay_floor)');
    // ★字が在るだけでは 通さない★＝その3通りに ★実際に入れる道★が在るか
    //   （2026-08-25：分かれ道を潰しても 字は残るので 緑のままだった）
    expect(block, '★両方 打っていない時に 入る道が無い★').toContain('if (!r && !f) {');
    expect(block, '★歩合だけの時に 入る道が無い（字だけ残っている）★').toMatch(
      /\n {10}if \(r\) \{/
    );
  });

  it('★出さない場合★ 決まりが在る／その人だけで足りている／まだ空', () => {
    const i = HTML.indexOf('function _roleWarn(');
    const block = HTML.slice(i, i + 2600);
    expect(block, '★まだ打っていない人にも 赤を出す★').toContain("if (!role) return null;");
    expect(block, '★決まりが在っても 赤を出す★').toContain('if (st.roles && st.roles[role]) return null;');
    expect(block, '★その人だけで足りていても 赤を出す★').toContain('if (r && f) return null;');
  });

  it('赤い注意が 読める形で出る（色は危険の色・折り返す）', () => {
    const i = HTML.indexOf('\n      .rolewarn {');
    expect(i, '★注意の見た目が無い★').toBeGreaterThan(-1);
    const css = HTML.slice(i, HTML.indexOf('}', i));
    expect(css, '★危険の色を使っていない★').toContain('var(--danger)');
    expect(css, '★1文字ずつ縦に割れる形になっている★').toContain('white-space: normal');
  });

  it('画面が その言葉を実際に使っている', () => {
    expect(HTML, '★作っただけで 画面に出していない★').toContain('var w = _roleWarn(e);');
    expect(HTML, '★注意の箱に入れていない★').toContain(
      "w ? '<div class=\"rolewarn\">' + w + '</div>' : ''"
    );
  });
});

describe('★合計は 名前と右端の 真ん中★', () => {
  it('右端に寄せきらない（司さん「右に移動なんか言うてなかろが」）', () => {
    const i = HTML.indexOf('\n      .slip .sums {');
    const css = HTML.slice(i, HTML.indexOf('}', i));
    expect(css, '★左に寄っている★').toContain('margin-left: auto');
    expect(css, '★右端に寄せきっている（真ん中に来ない）★').toContain('margin-right: auto');
  });
});
