// ★借りた道具が 借りたまま か を 毎回 数える★（指示役 2026-09-02 の 取り込み条件）
//
// ★出どころ（正本）★
//   repo … exally-zeroact/rakually-test （Rakunally）
//   道具 … tools/fake-clock.mjs
//   版   … commit 5f2f43f「道具が 見張りを 乗っ取っていた（--self-test の取り違え）」
//   借りた日 … 2026-09-02 ／ 大きさ 15,582 バイト
//
// ★借り物の決まり（3つ）★
//   ① ★正本は Rakunally 側★。ここに在るのは 写し。
//   ② ★毎回 バイト一致を 数える★（この試験）。
//   ③ ★自分で 書き換えない★。直したい時は ★正本を 直して 配り直す★。
//
// ★この試験が 赤に なったら★
//   (A) 私たちが 写しを 触った  … ★戻す★（正本から 写し直す）
//   (B) 正本が 進んだ           … ★写し直して この試験の sha256 を 更新する★（中身は 触らない）
//   どちらも ★直し方は「写し直す」だけ★。ここで 中身を いじらない。
//
// ★正本が この機械に 無い時（CI など）★
//   ★「未測定」と 言う★。★0件・一致 とは 書かない★（持っていない物を 0 と言わない）
//
// ★★わざと壊して 赤に なる事を 見た（2026-09-02 実測）★★
//   壊し方 … 写し tools/fake-clock.mjs の 末尾に ★1行 足した★（printf で 2行・中身は 変えず）
//   結果   … ★4本中 2本が 赤★
//              × ★私たちが 写しを 書き換えていない（記録した sha256 と 同じ）★
//                  expected 7200deb7… to be e14288e4…
//              × ★正本と バイト一致★
//              ✓ 残り2本（在る／出どころが 消えていない）は 緑のまま＝★見ている所が 違う★事も 確かめた
//   戻した後 … ★4本とも 緑★（sha256 が e14288e4… に 戻った事も 数えた）
//   ⇒ ★空振りでは ありません★（[[feedback_cannot_reproduce_means_measure_elsewhere]] の 形で 確かめた）
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const UTSUSHI = path.join(__dirname, '..', '..', 'tools', 'fake-clock.mjs');
// ★正本の 置き場（この機械での 場所）★ 無ければ 下で 未測定と 言う
const SEIHON = 'C:/Users/zeroa/rakually-test/tools/fake-clock.mjs';
const KIROKU = 'e14288e4ec2c57c127a4277a574f517e00c2d5c57b885c8c49c2bbd74b8f3b06';

const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

describe('★借りた 時計の道具（Rakunally の 写し）★', () => {
  it('★写しが 在る★', () => {
    expect(fs.existsSync(UTSUSHI), '★tools/fake-clock.mjs が 在りません★').toBe(true);
  });

  it('★私たちが 写しを 書き換えていない（記録した sha256 と 同じ）★', () => {
    expect(
      sha(UTSUSHI),
      '★写しが 変わっています＝自分で 直したのなら 戻してください（直すのは 正本の側）★'
    ).toBe(KIROKU);
  });

  it('★正本と バイト一致（正本が 無い機械では 未測定と 言う）★', () => {
    if (!fs.existsSync(SEIHON)) {
      // eslint-disable-next-line no-console
      console.log(
        '  🟡 正本が この機械に 在りません … ★未測定★（一致・0件 とは 書きません）: ' + SEIHON
      );
      return;
    }
    expect(
      sha(SEIHON),
      '★正本と 写しが 違います（どちらかが 動いた）＝★写し直す★だけ で 直してください' +
        '／正本が 進んでいたなら この試験の sha256 も 更新する（★中身は 触らない★）★'
    ).toBe(sha(UTSUSHI));
  });

  it('★写しは 借り物だと 中に 書いてある（出どころが 消えていない）★', () => {
    const naka = fs.readFileSync(UTSUSHI, 'utf8');
    expect(naka.indexOf('fake-clock.mjs') >= 0).toBe(true);
    expect(naka.indexOf('FAKE_NOW') >= 0).toBe(true);
    // ★ダイコメの 昔の名前も 通る事★（これが 消えたら うちの試験が 黙って 進まなくなる）
    expect(naka.indexOf('DK_FAKE_NOW') >= 0, '★DK_FAKE_NOW が 消えています★').toBe(true);
  });
});
