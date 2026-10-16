'use strict';
// ============================================================
// ★秘密の 一覧（KINSHI_JI）を 持つ workflow の 段は 全部 包み（scripts/kinshi-tsutsumu.sh）を 通る★ 2026-10-16
//   本体（他の 席の 写し）は 赤の 時に 一覧の 番号と 場所を 出す＝包まない 段が 1つでも 在れば 公開の ログに 出る
//   （対立役：test.yml の node24 の 段を 包み 忘れていた）。
//   ★外す 物★ commit 文の 門（scripts/kinshi-commit-msg.mjs）＝出すのは sha の 頭・語の 数・本数だけ（番号を 出さない・中身を 読んで 確かめた）。
//   ★わざと壊して 赤に なった 記録（2026-10-16）★：test.yml の node24 の 段を 元の `node … | tee` に 戻すと 1本 赤。
// ============================================================
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const WF = path.join(ROOT, '.github', 'workflows');

describe('★KINSHI_JI を 持つ 段は 包みを 通る★', () => {
  const dan = [];
  for (const f of fs.readdirSync(WF).filter((x) => /\.ya?ml$/.test(x))) {
    const s = fs.readFileSync(path.join(WF, f), 'utf8');
    s.split(/\n\s*- name:/).forEach((chunk, i) => {
      if (/secrets\.KINSHI_JI\b/.test(chunk)) dan.push({ f, i, chunk });
    });
  }
  it('数えた 段（0本を 見て 緑に しない）', () => {
    expect(dan.length).toBeGreaterThanOrEqual(5);
  });
  it('全部 kinshi-tsutsumu.sh を 通る（commit 文の 門は 外す）', () => {
    const warui = dan
      .filter(
        (d) => !/kinshi-tsutsumu\.sh/.test(d.chunk) && !/kinshi-commit-msg\.mjs/.test(d.chunk)
      )
      .map((d) => d.f + ' の ' + d.i + ' 番目の 段');
    expect(warui, '★包まずに 一覧を 持つ 段が 在る＝赤の 日に 番号が 公開の ログに 出る★').toEqual(
      []
    );
  });
});
