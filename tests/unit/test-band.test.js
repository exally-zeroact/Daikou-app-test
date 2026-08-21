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

  it('★帯から1タップで本番へ移れる★（端末に入ってしまった人が自分で戻れる）', () => {
    const h = read('index.html');
    const i = h.indexOf('id="testBand"');
    const band = h.slice(i, i + 1500);
    expect(band, '★本番へ移るボタンが無い★').toContain('https://daikou-app.vercel.app/');
    expect(band, '★押す物だと分からない★').toContain('本番を開く');
  });
});
