// ★時計を 進める 道具★（★FAKE_NOW が 正・DK_FAKE_NOW も 通す★／経営者 2026-09-02 の決定）
//
//   ▼なぜ この作りか（★2回 間違えた★ので 残します）
//     ①★vi.setSystemTime は 先に vi.useFakeTimers() を 呼ばないと 何もしない★。
//       しかも useFakeTimers は setTimeout/setInterval まで 止めるので
//       ダイコメの GPS の 試験（時間を 進める物）が 壊れます。
//     ②★時計を「止める」と 経過時間が 0 のまま★になり、
//       「◯秒 経つまで 待つ」試験が ★進まなくなります★。
//       実測 … road-distance-gate.test.js が ★8秒 → 212秒★（止めた時）。
//   ⇒ ★止めるのでは なく「ずらす」★。針は 本物のまま 進み、日付だけ 未来へ。
//
//   ▼効かなかった時は ★黙って 通さず 止める★（Exally 2026-09-02 の空振り）。
const T = process.env.FAKE_NOW || process.env.DK_FAKE_NOW;
if (T) {
  const mato = new Date(T).getTime();
  if (!Number.isFinite(mato)) {
    console.error('★FAKE_NOW が 日付として 読めません★: ' + T);
    process.exit(9);
  }
  const R = Date;
  const ZURE = mato - R.now(); // ★ずれ幅★（針は そのまま 進む）
  class FakeDate extends R {
    constructor(...a) {
      super(...(a.length ? a : [R.now() + ZURE]));
    }
    static now() {
      return R.now() + ZURE;
    }
  }
  FakeDate.parse = R.parse;
  FakeDate.UTC = R.UTC;
  globalThis.Date = FakeDate;

  // ★効いたかを その場で 確かめる（効かなければ 止まる）★
  const hi = (d) =>
    d.getFullYear() +
    '-' +
    String(d.getMonth() + 1).padStart(2, '0') +
    '-' +
    String(d.getDate()).padStart(2, '0');
  const matoHi = hi(new R(mato));
  if (hi(new Date()) !== matoHi || hi(new Date(Date.now())) !== matoHi) {
    console.error('★時計を 進められませんでした（道具が 効いていません）★');
    process.exit(9);
  }
  // ★針が 止まっていないかも 確かめる★（②の 再発 防止）
  const a = Date.now();
  for (let i = 0; i < 3e6; i++) {
    /* 少し 時間を 使う */
  }
  if (Date.now() === a && R.now() !== a - ZURE) {
    console.error('★時計の 針が 止まっています（経過時間を 測る 試験が 壊れます）★');
    process.exit(9);
  }
}
