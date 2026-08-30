'use strict';
// ============================================================
// ★★本番ビルドが 1回の 変更で 2回 走らない★★ 2026-08-30
//
//   ★どちらの物差しか★
//     ★距離でも 料金でも ありません★。★お金（Vercel の 請求）★を 見ます。
//
//   ★何が 起きていたか（ビルドログの 実物・2026-08-30）★
//     ①PR を merge → Vercel が 1回目を 建てる（sw.js は ★まだ 古い版名★）
//     ②auto-version が sw.js を 書き換えて もう1コミット push
//     ③Vercel が 2回目を 建てる（客に 届くのは こちら）
//     ⇒★①は 捨て玉★。clone だけで ★4分27秒★（ビルド本体は 28秒）。
//       今日 daikou-app は 7ビルド、うち ★3本が この 2回目★でした。
//
//   ★直した形★
//     ・PR の 枝に いる うちに 版名を 付ける（stamp-on-pr）
//     ・main 側は ★保険として 残す★。ただし
//       ★その push で sw.js が すでに 変わっているなら 何も しない★
//
//   ★ここで 見る事（★どれか 1つでも 消えたら 元に 戻ります★）★
//     ①PR の 枝で 版名を 付ける job が 在る
//     ②main 側に「もう 変わっているなら 何も しない」門が 在る
//     ③main 側の 3つの 段が その門に ぶら下がっている（付け忘れ 防止）
//     ④保険（main 側）を 消していない
//     ⑤版名の 書き換え方（sed）が 壊れていない … ★実際に 走らせて 確かめる★
// ============================================================
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const YML = path.join(ROOT, '.github', 'workflows', 'auto-version.yml');
const SW = path.join(ROOT, 'sw.js');

describe('★本番ビルドを 1回に する（Vercel の お金）★', () => {
  const src = fs.readFileSync(YML, 'utf8');

  // ★★2026-08-30 直し（わざと壊して 分かった）★★
  //   前は `src.includes('stamp-on-pr')` で 見ていました。
  //   ⇒★job の 名前を `stamp-on-pr-KESHITA` に 変えても 緑のまま★でした
  //     （名前の 一部が 残るので 当たってしまう）。
  //   ⇒★job の 名札そのもの（行の 頭から 2字下げ＋コロン）で 数えます★
  const jobs = (src.match(/^ {2}([a-zA-Z0-9_-]+):$/gm) || []).map((l) => l.trim().slice(0, -1));

  it('★① PR の 枝で 版名を 付ける job が 在る★', () => {
    expect(fs.existsSync(YML), '★auto-version.yml が ありません★').toBe(true);
    expect(src, '★PR で 動く 引き金が ありません★').toContain('pull_request');
    expect(jobs, '★PR の 枝で 付ける job が ありません（名前を 変えても だめ）★').toContain(
      'stamp-on-pr'
    );
    // ★PR の 枝そのものを 見ている事★（main を 見ると 意味が ない）
    expect(src, '★PR の 枝を checkout していません★').toContain(
      'github.event.pull_request.head.ref'
    );
  });

  it('★② main 側に「もう 変わっているなら 何も しない」門が 在る★', () => {
    expect(src, '★門が ありません★').toContain("grep -qx 'sw.js'");
    expect(src, '★門の 答えを 出していません★').toContain('already=yes');
  });

  it('★③ main 側の 段が 全部 その門に ぶら下がっている（付け忘れ 防止）★', () => {
    // ★門より 後に 走る 段は 3つ★（SHA取得／書き換え／commit&push）
    const kado = (src.match(/steps\.sumi\.outputs\.already != 'yes'/g) || []).length;
    expect(kado, '★門に ぶら下がっていない 段が あります（そこが 2回目を 作ります）★').toBe(3);
  });

  it('★④ 保険（main 側）を 消していない★', () => {
    expect(jobs, '★保険(main)の job を 消しています（名前を 変えても だめ）★').toContain(
      'update-cache-name'
    );
    expect(src, '★push の 引き金を 消しています★').toContain('branches: [main]');
  });

  it('★★⑤ 版名の 書き換えが 実際に 効く（走らせて 確かめる）★★', () => {
    // ★字を 読むだけでは 弱い★（前に sed が 壊れて 版名が 止まった事がある）
    const mae = fs.readFileSync(SW, 'utf8');
    const ima = /const CACHE_NAME = '([^']*)'/.exec(mae);
    expect(ima, '★sw.js に 版名が ありません★').toBeTruthy();

    // yml に 書いてある sed を そのまま 取り出して 使う（★別の物を 試さない★）
    const line = src.split('\n').find((l) => l.includes('sed -i -E'));
    expect(line, '★yml に 書き換えの 行が ありません★').toBeTruthy();
    const shiki = /s\/(.+)\/(.+)\/" sw\.js/.exec(line.trim());
    expect(shiki, '★書き換えの 形が 変わりました★').toBeTruthy();

    // ★同じ正規表現を JS で 走らせて、版名だけが 変わる事を 見る★
    const re = new RegExp('(const CACHE_NAME = )[\'"][^\'"]*[\'"]');
    const ato = mae.replace(re, "$1'daikome-TEST123'");
    expect(ato, '★書き換わっていません★').toContain("const CACHE_NAME = 'daikome-TEST123'");
    expect(ato.length, '★版名以外まで 変わっています★').toBe(
      mae.length - ima[1].length + 'daikome-TEST123'.length
    );
    // ★書き換えた後も JS として 読める★
    expect(
      () => new Function(ato.replace(/self\./g, 'globalThis.')),
      '★sw.js が 壊れます★'
    ).not.toThrow();
  });

  it('★⑥ 版名は 空に ならない（空だと 写しが 効かない）★', () => {
    const now = /const CACHE_NAME = '([^']*)'/.exec(fs.readFileSync(SW, 'utf8'))[1];
    expect(now.length, '★版名が 空です★').toBeGreaterThan(3);
    expect(now.startsWith('daikome-'), '★版名の 頭が 変わりました★').toBe(true);
  });
});
