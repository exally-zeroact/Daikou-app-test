// tests/unit/nai-toki-midori.test.js
//
// ★★「無い時に緑」を 機械が 数える★★ 2026-08-28（指示役）
//
//   ★なぜ 作ったか★
//     私は 前に「残り7件」と 言っていました。実物から 数え直したら ★24本★でした。
//     ★手で数えると 数え方が 変わり、「進んでいるのか」が 分からなくなります★。
//     ⇒★数え方を ここに 固定し、機械に 数えさせます★。
//     ⇒★定義を 変えた時は「定義を変えた」と 報告に 書きます★（数だけ動かさない）。
//
//   ★★数え方の定義（1行）★★
//     ★材料・生成物・設定が「無い / null」事を 見た直後に、赤にせず そのまま 緑で終わる形★
//
//   ★細かい決まり（読む人が 同じ数を 出せるように）★
//     ・見る所 … tests/ の下の .js / .mjs（node_modules は 除く）
//     ・コメントは ★外してから★ 探す（自分の説明文を 拾わない為・2回 踏んだ）
//     ・「無い」を 見る印 … existsSync / loadFixture / readFileSync / process.env /
//                          !fx / !fixture / == null / === null
//     ・「緑で終わる」印 … process.exit(0) / return; / continue; / it.skip / describe.skip
//     ・★赤にしている物は 数えない★ … 窓の中に
//        未測定 / MISOKUTEI / anyFail / exitCode / process.exit(1) / expect( の どれかが在る
//     ・窓 … その行から 6行
//     ・1ファイルにつき 1つ数える（同じ形が何か所在っても 1本）
//
//   ★この数え方の 穴（分かっていて 残している物）★
//     ・★expect( が「緑で終わる所より 後ろ」に在ると 見逃します★
//       （窓の中に在るだけで「赤にしている」と みなす為）。
//       実際 scripts-no-shebang.test.js を 1本 見逃しました（2026-08-28・手で見つけて 直した）。
//       ⇒★数が減った時は「本当に直したか」を 1本ずつ 目で見る★
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');

const NAI = /existsSync|loadFixture|readFileSync|process\.env|!fx|!fixture|==\s*null|===\s*null/;
const MIDORI = /process\.exit\(0\)|return;|continue;|it\.skip|describe\.skip/;
const AKA = /未測定|MISOKUTEI|anyFail|exitCode|process\.exit\(1\)|expect\(/;
const MADO = 6;

// ★コメントを外す★（[[feedback_guard_searching_by_name_dies_on_rename]] と 同じ型）
const komentoWoKesu = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');

function kazoeru(dir, deta) {
  fs.readdirSync(dir, { withFileTypes: true }).forEach((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name !== 'node_modules') kazoeru(p, deta);
      return;
    }
    if (!/\.(js|mjs)$/.test(e.name)) return;
    const rel = path.relative(ROOT, p).split(path.sep).join('/');
    if (rel === 'tests/unit/nai-toki-midori.test.js') return; // ★自分は 数えない★
    const gyou = komentoWoKesu(fs.readFileSync(p, 'utf8')).split('\n');
    for (let i = 0; i < gyou.length; i++) {
      if (!NAI.test(gyou[i])) continue;
      const mado = gyou.slice(i, i + MADO).join('\n');
      if (MIDORI.test(mado) && !AKA.test(mado)) {
        deta.push(rel);
        break; // ★1ファイル 1本★
      }
    }
  });
  return deta;
}

// ★2026-08-28 実測 … 残り15本★（1本 直すたびに ここから消す）
//   ★手で数えた時は 16本でした★。この定義（窓に expect( が在れば「赤にしている」＝数えない）で
//   scripts-no-shebang が 外れて ★15本★。★機械の数が 正★です。
//   この日 ★11本 直しました★（24本 → 16本 …【A】必ず在る物6・【B】距離の見張り2・【C】言い換え3）
//   ※【C】3本は 数えなくなった側（未測定と 言うようになった）
const NOKORI = [
  'tests/integration/adaptive-mode-distance.test.js',
  'tests/integration/address-chiban-build.test.js',
  'tests/integration/address-street-build.test.js',
  'tests/integration/meisai-autopush-row.test.js',
  'tests/integration/note-group-wiring.test.js',
  'tests/integration/overcount-zero-routing.test.js',
  'tests/integration/smoothed-distance-parity-creep.test.js',
  'tests/kp-segment-score.js',
  'tests/lib/snap.drift-guard.test.js',
  'tests/replay-mm-worker/scoring.js',
  'tests/tier1-osrm.js',
  'tests/tier4-google.js',
  'tests/truedist-kp-gate.js',
  'tests/unit/dk-config-single-source.test.js',
  'tests/unit/office-allow-list.test.js',
];

describe('★「無い時に緑」を 機械が 数える★', () => {
  const ima = kazoeru(path.join(ROOT, 'tests'), []).sort();

  it('★本数が 増えていない★（黙って足せない）', () => {
    expect(
      ima.length,
      '★「無い時に緑」の本数が 変わりました★\n' +
        '  ・増えた … ★新しく「無い時に そのまま緑」を 書きました★。赤にするか 未測定と言うか どちらかに。\n' +
        '  ・減った … ★直したなら NOKORI から その1本を 消してください★\n' +
        '  ★数え方は このファイルの頭に 1行で 書いてあります。変えたら「定義を変えた」と 報告に書く★'
    ).toBe(NOKORI.length);
  });

  it('★中身も 同じ★（別の物と 入れ替わっていない）', () => {
    const fueta = ima.filter((f) => NOKORI.indexOf(f) < 0);
    const hetta = NOKORI.filter((f) => ima.indexOf(f) < 0);
    expect({ fueta, hetta }, '★数は同じでも 中身が 入れ替わっています★').toEqual({
      fueta: [],
      hetta: [],
    });
  });

  it('★名簿の物は 実物が 在る★（消えた物の名前を 残さない）', () => {
    const nai = NOKORI.filter((f) => !fs.existsSync(path.join(ROOT, f)));
    expect(nai, '★tests/ に無い物が 名簿に 在ります★').toEqual([]);
  });
});
