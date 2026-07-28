// supabase/functions/dk-register-company
// ダイコメ ライセンス: 会社セルフ登録 → 会社URL自動発行 (2026-07-27・LP用)。
//   入力(POST JSON): { company_name, contact?, seat_limit? }
//   出力: { ok:true, company_id, url_token, company_url } | { ok:false, reason }
//   url_token = 推測不能な乱数(16byte hex)。dk_companies を service_role で作成。
//   ★今は無料発行(Stripe課金は将来・status:'on'で発行)。スパム対策は将来Stripe/認証でゲート★。
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const APP_BASE = 'https://daikou-app-test.vercel.app'; // 会社URLのベース(本番切替時に差替)

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' },
  });
}

function randToken(): string {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      headers: {
        'access-control-allow-origin': '*',
        'access-control-allow-headers': 'content-type, authorization, apikey',
        'access-control-allow-methods': 'POST, OPTIONS',
      },
    });
  }
  if (req.method !== 'POST') return json({ ok: false, reason: 'method' }, 405);

  let input: { company_name?: string; contact?: string; seat_limit?: number | string };
  try {
    input = await req.json();
  } catch {
    return json({ ok: false, reason: 'bad_json' }, 400);
  }
  const name = (input.company_name || '').trim();
  const contact = (input.contact || '').trim();
  let seat = parseInt(String(input.seat_limit), 10);
  if (!Number.isFinite(seat)) seat = 1;
  seat = Math.max(1, Math.min(50, seat)); // 1〜50台に制限
  if (!name) return json({ ok: false, reason: 'no_name' }, 400);
  if (name.length > 100 || contact.length > 200)
    return json({ ok: false, reason: 'too_long' }, 400);

  const sb = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  );

  // url_token の衝突は極めて稀だが unique 制約に当たったら1回だけ再試行。
  let row = null;
  for (let attempt = 0; attempt < 2 && !row; attempt++) {
    const url_token = randToken();
    const admin_token = randToken(); // 代表者ページ用の別トークン(秘密)
    const { data, error } = await sb
      .from('dk_companies')
      .insert({ url_token, admin_token, name, contact, seat_limit: seat, status: 'on' })
      .select('company_id, url_token, admin_token')
      .single();
    if (!error && data) row = data;
    else if (error && error.code !== '23505') return json({ ok: false, reason: 'db_error' }, 500);
  }
  if (!row) return json({ ok: false, reason: 'token_collision' }, 500);

  return json({
    ok: true,
    company_id: row.company_id,
    url_token: row.url_token,
    company_url: APP_BASE + '/?c=' + row.url_token,
    admin_token: row.admin_token,
    manage_url: APP_BASE + '/manage.html?k=' + row.admin_token, // 代表者用 管理リンク
  });
});
