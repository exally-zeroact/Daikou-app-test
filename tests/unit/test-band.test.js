// ============================================================
// ★テスト用のアプリだと 一目で分かる★（2026-08-21）
//
//   ★起きた事★
//     司さんが3台のスマホを入れ直したら、設定画面の「アプリ バージョン」が
//     ★daikome-c7a5b18＝テスト線の版★になっていた。
//     ＝★テスト用のアプリを ホーム画面に入れていた★（本番は daikome-2d3b1ca）
//     テスト用は ★テストの倉庫★を向くので、そのまま働くと
//     ★売上・給料・請求に1件も入らない★。
//
//   ★なぜ気づけなかったか★
//     ・画面のどこにも「本番／テスト」が出ていない
//     ・見分けが ★版の字（設定画面の1行）だけ★ だった
//     ・事務所が配るQRは本番を指している（実測）＝QRは無罪。
//       つまり ★URLを直接 開くと 誰でもテスト版を入れられる★状態だった
//
//   ★直し★
//     ①画面の一番上に ★「テスト用（本番ではありません）」の赤い帯★
//     ②ホーム画面アプリの名前を ★【テスト用】ダイコメ★ に（入れてしまってもアイコンで分かる）
//     ★本番(Daikou-app)には 帯を入れない★＝この試験は ★テスト線に在る事★ を見張る。
// ============================================================
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

describe('★テスト用のアプリだと 一目で分かる★', () => {
  it('画面の一番上に「テスト用」の帯が在る', () => {
    const h = read('index.html');
    expect(h, '★テスト用の帯が無い（本番と見分けが付かない）★').toContain('id="testBand"');
    expect(h).toContain('テスト用（本番ではありません）');
  });

  it('★帯は body のすぐ後ろ＝どの画面を開いても最初に見える★', () => {
    const h = read('index.html');
    const body = h.indexOf('<body');
    const band = h.indexOf('id="testBand"');
    expect(band, '★帯が body より前に在る★').toBeGreaterThan(body);
    expect(band - body, '★帯が body から離れすぎ（別の物が先に出る）★').toBeLessThan(1200);
  });

  it('ホーム画面アプリの名前が【テスト用】で始まる（メーター・事務所とも）', () => {
    const m = JSON.parse(read('manifest.json'));
    const o = JSON.parse(read('office-manifest.json'));
    expect(m.name, '★入れた時の名前が本番と同じ★').toContain('テスト用');
    expect(m.short_name).toContain('テスト');
    expect(o.name, '★事務所の名前が本番と同じ★').toContain('テスト用');
  });

  it('★本番の入口(URL)が どこかに書いてある★（間違えた人が戻れる）', () => {
    const m = JSON.parse(read('manifest.json'));
    expect(m.description, '★本番のURLが書いていない★').toContain('daikou-app.vercel.app');
  });

  it('★テスト用は スマホのホーム画面に入れられない★（display=browser）', () => {
    const m = JSON.parse(read('manifest.json'));
    const o = JSON.parse(read('office-manifest.json'));
    // ★2026-08-21 司さん「テスト用開いたら…そのあとぐちゃぐちゃにならんのか？」★
    //   ＝アイコンが2つ並ぶ事が そもそもの間違いのもと。
    //   テスト用は ★入れられない（ブラウザで開くだけ）★にして、間違いを物理的に止める。
    expect(m.display, '★テスト用のメーターがホーム画面アプリとして入れられる★').toBe('browser');
    // ★事務所は standalone のまま★＝iPhoneが7日でログインを消すのを避ける決まりが在る
    //   （tests/integration/dashboard-office-tabs.test.js）。事務所は従業員に配る物ではないので、
    //   名前を【テスト用】にする所までで止める。
    expect(o.display, '★事務所の決まり(standalone)を壊している★').toBe('standalone');
    expect(o.name).toContain('テスト用');
  });

  it('★引っ越しのボタンは 帯に残さない★（2026-08-25 司さん）', () => {
    // ★司さん★「なんでユーザーは本番前提やのに 本番へ引っ越すとか出てくるんど」
    //   引っ越しは ★2026-08-21 の1回きり★で ★もう済んでいる★（2026-08-25 に数えた）
    //     本番の倉庫 … 3台とも 08/25 に触っている（1466 14:52 / 4987 14:49 / 1173 14:50）
    //     テストの倉庫 … 端末 0台 ／ 打刻は 08/02 が最後
    //   ★済んだ物を残すと 押せてしまう★。決めた事は ★消すまで動き続ける★（26日 動かした前歴）。
    // ★コメントの字を数えない★（2026-08-25 実測：説明のコメントを拾って 嘘の赤を出した）
    //   見るのは ★客に見える所と 実際に動く所★ だけ。
    const h = read('index.html').replace(/<!--[\s\S]*?-->/g, '');
    expect(h, '★引っ越しのボタンが残っている★').not.toContain('本番へ引っ越す');
    expect(h, '★引っ越しの部品を まだ読んでいる★').not.toContain('js/dk-migrate.js');
    expect(h, '★引っ越しの呼び出しが残っている★').not.toContain('DKMigrateStart');
    // 帯そのものは残す（テスト線の目印）
    const i = h.indexOf('id="testBand"');
    expect(i, '★帯まで消してしまっている★').toBeGreaterThan(-1);
  });

  // ============================================================
  // ★2026-08-21 司さん「本番を開く押しても開かんかった」★
  //   帯は pointer-events:none（帯の下の画面を押せるようにする為）。
  //   その中の <a> で ★auto に戻していないと、ボタンは DOM に在るのに 永久に押せない★。
  //   ★事務所(dashboard.html)には auto が入っていて、メーター(index.html)には入っていなかった★。
  //   ＝「在る事」だけ数えていた この試験が ★押せない物を緑で通していた★。
  //   ⇒ ★押せるか（pointer-events）まで数える★。
  // ============================================================
  it('★帯の中のボタンは 実際に押せる（pointer-events を auto に戻している）★', () => {
    // 2026-08-25：index.html の帯からは ★押す物を外した★（引っ越しが済んだ為）。
    //   押す物が在るのは 事務所の画面だけ。
    const targets = [['dashboard.html', 'https://daikome-jimusho.vercel.app/']];
    for (const [file, href] of targets) {
      const h = read(file);
      const i = h.indexOf('id="testBand"');
      expect(i, `★${file} に帯が無い★`).toBeGreaterThan(-1);
      // 帯の開始タグ〜閉じ </div> までを取り出す（帯の中だけを見る）
      const band = h.slice(Math.max(0, i - 400), i + 2000);
      expect(band, `★${file} の帯が pointer-events:none ではない（作りが変わった）★`).toMatch(
        /pointer-events:\s*none/
      );
      const a = band.slice(band.indexOf(href));
      const style = a.slice(0, a.indexOf('</a'));
      expect(style, `★${file} の「本番を開く」が 押せない（帯の pointer-events:none のまま）★`).toMatch(
        /pointer-events:\s*auto/
      );
    }
  });
});
