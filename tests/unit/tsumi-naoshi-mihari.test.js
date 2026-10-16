'use strict';
// ============================================================
// ★poi-update の 積み直し（push 拒否→main の 先端へ cherry-pick）の 後は 見張りを もう一度 回し、赤なら push しない★ 2026-10-16
//   commit の 段は `set +e`（bash {0}）なので、`if !`・`break` を 外して 素の `bash scripts/kinshi-tsutsumu.sh` に すると
//   終わり値が 黙って 捨てられ、赤の 木を push する（対立役 W-a：段の 試験は「包みを 呼ぶか」「|| true」しか 見ない）。
//   ★見る 事★ cherry-pick が 通った 枝の 中で、
//     1. 包みを `if ! bash scripts/kinshi-tsutsumu.sh; then` で 呼ぶ
//     2. その then の 中に break が 在る（push の やり直しを 抜ける）
//     3. その 後に push_ok=1 に する 道が 無い（break で 抜けた まま「5回 試して だめ」の exit 1 に 落ちる）
//   ★わざと壊して 赤に なった 記録（2026-10-16）★
//     `if !`〜`fi` を 素の `bash scripts/kinshi-tsutsumu.sh` 1行に→1本 赤／then の 中の break を 消す→1本 赤
// ============================================================
const fs = require('fs');
const path = require('path');

const YML = path.resolve(__dirname, '..', '..', '.github', 'workflows', 'poi-update.yml');

describe('★積み直した 後の 見張り★', () => {
  it('cherry-pick が 通った 枝で 包みを if ! で 呼び、赤なら break で push を 抜ける', () => {
    const y = fs.readFileSync(YML, 'utf8').replace(/\r\n/g, '\n');
    const a = y.indexOf('if git cherry-pick "$MY_COMMIT"');
    expect(a, 'cherry-pick の 枝が 無い').toBeGreaterThan(0);
    const b = y.indexOf('\n            else\n', a);
    expect(b, 'cherry-pick の 枝の 終わり（else）が 無い').toBeGreaterThan(a);
    const eda = y.slice(a, b + 1); // else の 前の 改行まで 含める（fi の 行の 終わり）
    const m = /\n(\s*)if ! bash scripts\/kinshi-tsutsumu\.sh; then\n([\s\S]*?)\n\1fi\n/.exec(eda);
    expect(m, '★積み直した 後に 包みを if ! で 呼んでいない＝赤でも push する★').toBeTruthy();
    const then = m[2]
      .split('\n')
      .map((l) => l.replace(/(^|\s)#.*$/, '').trim())
      .filter(Boolean);
    expect(then, '★赤の 時に break で 抜けていない★').toContain('break');
    expect(then.join('\n'), '★赤の 時に push_ok を 立てている★').not.toMatch(/push_ok=1/);
  });
});
