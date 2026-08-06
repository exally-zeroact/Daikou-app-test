'use strict';
// ============================================================
// ★ダイコメ 管理画面（運営＝司さん専用）★ 2026-08-07
//
//   司さん「ダイコメの管理アプリを（Exally系の）ように作って
//           そこでおれが権限持つようしろ」
//         「ダイコメ用の作れや 最終は別アプリやろが」
//         「だれがそんな指示したんど おれは管理画面っていよろが」
//
//   ★他のアプリの管理画面を全部見てから作った（2026-08-07）★
//     payslip-app/admin.html（Kyually）／ nomiya-app/castally-admin.html（Castally）
//     どちらも同じ形:
//       ログイン → 管理者か判定 → お客さん一覧 → ★押して切り替えるだけ★
//       人の追加・削除・招待は無い。管理者を増やすのもSQL手打ち。
//     代行請求・アマかせには管理画面そのものが無い。
//
//   ★ダイコメで押す物は「プラン」ではなく 使う/止める と 席数★
//     dk_companies.status / seat_limit は★元からある★。新しい仕組みは足さない。
//
//   ★倉庫の側で実際にログインして確かめた（テストDB）★
//     ① 運営は管理者と分かる／お客さんははじかれる
//     ② 運営には会社が全部見える（2社）
//     ③ お客さんには他社が★0件★
//     ④ 運営が「止める」を押せる（on→off）
//     ⑤ 席数を変えられる（3→9）
//     ⑥ ★お客さんは他社を止められない・席数も変えられない★
//        （返り値が空＝1行も書き換わっていない。1回目は既にoffで判定できず、
//          onに戻してからやり直した）
// ============================================================
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const HTML = fs.readFileSync(path.join(ROOT, 'daikome-admin.html'), 'utf8');
const JS = fs.readFileSync(path.join(ROOT, 'js', 'daikome-admin.js'), 'utf8');
const SQL = fs.readFileSync(path.join(ROOT, 'supabase', 'apply-dk-admins.sql'), 'utf8');

describe('★他のアプリの管理画面と同じ形であること★', () => {
  it('画面は3つの状態を出し分ける（ログイン / 権限なし / 一覧）', () => {
    ['id="login"', 'id="denied"', 'id="panel"'].forEach(function (s) {
      expect(HTML, s + ' が無い').toContain(s);
    });
    expect(JS).toMatch(/\['login', 'denied', 'panel'\]/);
  });

  it('メール＋パスワードで入る（やり方を増やしていない）', () => {
    expect(JS).toContain('signInWithPassword');
    expect(JS, '★魔法のリンクや二段階を足している★').not.toMatch(/signInWithOtp|magiclink/i);
  });

  it('権限が無ければ はっきり断る', () => {
    expect(HTML).toContain('ダイコメの運営ではありません');
    expect(JS).toMatch(/show\('denied'\)/);
  });

  it('しぼり込み・更新・件数がある（他の2つと同じ）', () => {
    expect(HTML).toContain('id="q"');
    expect(HTML).toContain('id="refresh"');
    // 整形で改行が入るので、文字と数の出どころを別々に見る（書き方に縛られない）
    expect(JS, '★件数を出していない★').toContain('全部で ');
    expect(JS, '★件数の元が rows でない★').toContain('rows.length');
    expect(JS, '★止めている会社の数を出していない★').toContain('止めている会社 ');
  });

  it('★人の追加・削除は入れていない★（他の2つにも無い）', () => {
    expect(JS, '★勝手に機能を足している★').not.toMatch(/admin\/users|signUp|招待|delete\(\)/);
  });
});

describe('★ダイコメ自身に持たせること（最後は別アプリ）★', () => {
  it('管理者の棚は daikome の中', () => {
    expect(SQL).toContain('create table if not exists daikome.dk_admins');
  });

  it('★Exally の表に寄りかかっていない★', () => {
    const code = SQL.split('\n')
      .filter((l) => !l.trim().startsWith('--'))
      .join('\n');
    expect(code, '★exally_admins を使うと独立できない★').not.toMatch(/exally_admins|exally\./i);
    expect(JS, '★画面が Exally の表を読んでいる★').not.toContain('exally_admins');
    expect(JS, 'ダイコメ自身の管理者表を見ていない').toContain("from('dk_admins')");
  });

  // ★2026-08-07 司さん「アドレスも勝手に決めるなや」★
  //   私が司さんのアドレスを SQL に直接書き込んで自動登録していた。
  //   誰を運営にするかは司さんが決めること。Kyually も コメントのままにしてある。
  it('★アドレスを直接書き込んでいない★（誰を運営にするかは司さんが決める）', () => {
    const code = SQL.split('\n')
      .filter((l) => !l.trim().startsWith('--'))
      .join('\n');
    const mails = code.match(/[\w.+-]+@[\w-]+\.[\w.]+/g) || [];
    expect(mails, '★実行される所にアドレスが書いてある★ ' + mails.join(', ')).toEqual([]);
    expect(code, '★勝手に管理者を登録している★').not.toMatch(/insert into daikome\.dk_admins/i);
  });

  it('登録のやり方は手順として残してある（コメント）', () => {
    expect(SQL, '登録の手順が書いていない').toContain('ここに運営のログインメール');
    expect(SQL, '外し方が書いていない').toContain('delete from daikome.dk_admins');
  });

  it('★管理者の一覧は漏らさない★（自分の行だけ読める）', () => {
    expect(SQL).toMatch(/dk_admins_read_self[\s\S]{0,120}account_id = auth\.uid\(\)/);
  });
});

describe('★運営だけが 見られる・変えられること★', () => {
  it('会社を全部見られるのは管理者だけ', () => {
    expect(SQL).toMatch(/dk_companies_admin_read[\s\S]{0,120}is_dk_admin\(\)/);
  });

  it('状態と席数を変えられるのは管理者だけ', () => {
    expect(SQL).toMatch(/dk_companies_admin_write[\s\S]{0,160}is_dk_admin\(\)/);
  });

  it('★お客さん自身の鍵は消していない★（今までどおり自分の会社は見える）', () => {
    // 追加した policy は admin 用だけ。既存の owner 用を drop していないこと。
    expect(SQL, '★お客さんが自分の会社を見られなくなる★').not.toMatch(
      /drop policy[^\n]*owner[^\n]*on daikome\.dk_companies/i
    );
  });

  it('端末数・最後に走った日を出すための鍵もある', () => {
    expect(SQL).toContain('dk_company_devices_admin_read');
    expect(SQL).toContain('dk_shifts_admin_read');
  });
});

describe('★押す物は「使う/止める」と「席数」であること★', () => {
  // ボタンは JS が組み立てる（一覧は毎回作り直すため）
  it('プランではなく 状態を押す', () => {
    expect(JS, '★「使う」ボタンが無い★').toContain('>使う<');
    expect(JS, '★「止める」ボタンが無い★').toContain('>止める<');
    expect(JS).toMatch(/function setStatus/);
    expect(JS, '★他アプリのプラン(体験/有料)を持ち込んでいる★').not.toMatch(/体験|お試し|有料/);
  });

  it('席数を変えられる', () => {
    expect(JS, '★席数の欄が無い★').toContain('data-act="seat"');
    expect(JS).toMatch(/function setSeat/);
    expect(JS, '席数が負になる').toContain('Math.max(0,');
  });

  it('★押した瞬間に画面を変え、失敗したら戻す★（待たせない）', () => {
    // var/let/const は整形の道具が変えるので、どれでも通るようにする
    expect(JS, '★状態: 失敗しても戻していない★').toMatch(
      /(var|let|const) before = r\.status;[\s\S]{0,220}r\.status = before;/
    );
    expect(JS, '★席数: 失敗しても戻していない★').toMatch(
      /(var|let|const) before = r\.seat;[\s\S]{0,260}r\.seat = before;/
    );
  });

  it('★止めた/使えるようにした を言葉で出す★', () => {
    expect(JS).toMatch(/を止めました/);
    expect(JS).toMatch(/使えるようにしました/);
  });
});

// ============================================================
// ★運営が新しいお客さんを登録できること★ 2026-08-07
//   司さん「おれが新規で登録してやるんやろが」
//   今までは★お客さん自身が事務所から登録する★形しか無かった。
//   売るのは司さんなので、司さんの側から登録して会社URL(QR)を渡せるようにした。
//
//   ★倉庫の側で実際に確かめた（テストDB）★
//     運営が登録 → 201・会社URLが出る／持ち主は空（お客さんが登録した時に埋まる）
//     ★運営でない人が登録 → 403★
//     作った会社は消して置き土産ゼロ
// ============================================================
describe('★運営が新しい会社を登録できること★', () => {
  it('登録の欄がある（会社名・連絡先・台数）', () => {
    ['id="newName"', 'id="newContact"', 'id="newSeat"', 'id="newAdd"'].forEach(function (s) {
      expect(HTML, s + ' が無い').toContain(s);
    });
  });

  it('★会社名は必須★（名前の無い会社を作らせない）', () => {
    expect(JS).toMatch(/if \(!name\)[\s\S]{0,120}会社名を入れてください/);
  });

  it('★連絡先の打ち間違いをその場で止める★（空は許す）', () => {
    expect(JS).toMatch(/if \(contact &&[\s\S]{0,120}\[a-z\]\{2,\}/);
  });

  it('★渡す会社URLを出す★（登録して終わりにしない）', () => {
    expect(HTML).toContain('id="newUrl"');
    expect(JS, '会社URLを組み立てていない').toMatch(/APP_BASE[\s\S]{0,80}'\/\?c=' \+/);
    expect(HTML, 'コピーできない').toContain('id="newCopy"');
  });

  it('★url_token は毎回ちがう物を作る★（人が推せない長さ）', () => {
    expect(JS).toMatch(/getRandomValues/);
    expect(JS, '短すぎる').toMatch(/Uint8Array\(16\)/);
  });

  it('★台数は1以上★', () => {
    expect(JS).toMatch(/Math\.max\(1, parseInt\(\$\('newSeat'\)/);
  });

  it('登録できるのは運営だけ（倉庫の鍵）', () => {
    expect(SQL).toMatch(/dk_companies_admin_insert[\s\S]{0,140}is_dk_admin\(\)/);
  });

  it('★持ち主は空のまま★（お客さんが自分で事務所に登録した時に埋まる）', () => {
    // 運営が勝手に自分を持ち主にしない
    expect(JS, '★運営が持ち主になってしまう★').not.toMatch(/owner_id\s*:/);
  });
});

describe('★危ない物を置いていないこと★', () => {
  it('サービス鍵をブラウザに置いていない', () => {
    expect(JS, '★サービス鍵が漏れる★').not.toMatch(/service_role|SERVICE_ROLE/);
    expect(HTML, '★サービス鍵が漏れる★').not.toMatch(/service_role|SERVICE_ROLE/);
  });

  it('倉庫の向き先は共通の設定から取る（直書きしない）', () => {
    expect(JS).toContain('window.DKConfig');
    expect(JS, '★倉庫を直書きしている★').not.toMatch(/https:\/\/[a-z0-9]{16,}\.supabase\.co/);
  });

  it('★事務所の画面には出さない★（運営専用・お客さんに見せない）', () => {
    const allow = fs.readFileSync(path.join(ROOT, 'scripts', 'office-allow.mjs'), 'utf8');
    expect(allow, '★事務所に管理画面が並ぶ★').not.toContain('daikome-admin.html');
  });
});
