// ============================================================
// scripts/auth-mail-otp.mjs
// ★ログインのメールに「6桁の番号」を入れる★ 2026-08-03
//
//   ★なぜ変えるか（司さんの指摘が正解だった）★
//     今: メール届く → ★リンクを押す★ → ブラウザが開く → そっちでログイン
//         → ★アプリ側は「まだ誰も入っていない」ままなので、何回やっても聞かれる★
//     アプリとブラウザは別々の場所にログイン情報を持つ。リンクで飛ぶ限り直らない。
//     （「ホーム画面に追加すれば直る」は間違いだった。リンクがブラウザで開く以上、同じ）
//
//   後: メール届く → ★6桁の番号が書いてある★ → 開いている画面に打ち込む
//       → その場でログイン完了。★ブラウザに飛ばない★
//
//   ※リンクも残す（パソコンで開いている時はリンクの方が早い）。
//     番号を足すだけなので、今までのやり方も壊れない。
//
//   使い方:
//     node scripts/auth-mail-otp.mjs           … 今の本文を見るだけ
//     node scripts/auth-mail-otp.mjs --apply   … 6桁を入れる
// ============================================================
import { readToken, whereWeLooked } from './db-token.mjs';

const PROJECT = 'tnfwipbgfgjaymlszeid';

export const SUBJECT = 'ダイコメ ログイン用の番号';

// ★{{ .Token }} が6桁の番号★（Supabaseが差し込む）
export const TEMPLATE = [
  '<h2>ダイコメ ログイン</h2>',
  '<p>ログイン画面に、この番号を打ち込んでください。</p>',
  '<p style="font-size:32px;font-weight:700;letter-spacing:8px;margin:16px 0">{{ .Token }}</p>',
  '<p style="color:#666;font-size:13px">この番号は1時間で使えなくなります。</p>',
  '<hr style="border:0;border-top:1px solid #ddd;margin:20px 0">',
  '<p style="color:#666;font-size:13px">パソコンで開いている場合は、こちらを押しても入れます。</p>',
  '<p><a href="{{ .ConfirmationURL }}">ログインする</a></p>',
].join('\n');

// 6桁が入っているか（入っていなければ「番号を打つ」やり方が成立しない）
export function hasToken(tpl) {
  return /\{\{\s*\.Token\s*\}\}/.test(String(tpl || ''));
}

const isMain = process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('auth-mail-otp.mjs');
if (isMain) {
  const found = readToken();
  if (!found) {
    console.error('鍵が見つかりません。探した場所:');
    whereWeLooked().forEach((p) => console.error('  ' + p));
    process.exitCode = 2;
  } else {
    const H = { Authorization: 'Bearer ' + found.token, 'Content-Type': 'application/json' };
    const url = `https://api.supabase.com/v1/projects/${PROJECT}/config/auth`;
    const cur = await fetch(url, { headers: H }).then((r) => r.json());

    console.log('鍵の出どころ: ' + found.from);
    console.log('\n★今の本文★');
    console.log(cur.mailer_templates_magic_link_content || '(既定のまま)');
    console.log('\n6桁の番号: ' + (hasToken(cur.mailer_templates_magic_link_content) ? 'ある' : '★無い★'));

    if (!process.argv.includes('--apply')) {
      console.log('\n見ただけです。入れるなら --apply を付けてください。');
      process.exitCode = hasToken(cur.mailer_templates_magic_link_content) ? 0 : 1;
    } else {
      const res = await fetch(url, {
        method: 'PATCH',
        headers: H,
        // ★メールの本文と件名だけ。他の設定には触らない★
        body: JSON.stringify({
          mailer_subjects_magic_link: SUBJECT,
          mailer_templates_magic_link_content: TEMPLATE,
        }),
      });
      if (!res.ok) {
        console.error('失敗: ' + res.status + ' ' + (await res.text()));
        process.exitCode = 1;
      } else {
        const after = await fetch(url, { headers: H }).then((r) => r.json());
        console.log('\n★入れたあと★');
        console.log(after.mailer_templates_magic_link_content);
        const ok = hasToken(after.mailer_templates_magic_link_content);
        console.log('\n6桁の番号: ' + (ok ? 'ある' : '★入っていない★'));
        console.log('SITE_URL は ' + after.site_url + '（変えていない）');
        process.exitCode = ok ? 0 : 1;
      }
    }
  }
}
