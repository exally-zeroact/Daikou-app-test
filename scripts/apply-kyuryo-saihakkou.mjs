// ============================================================
// scripts/apply-kyuryo-saihakkou.mjs
// ★給料の 本人リンクを 作り直す 倉庫の 関数 dk_kyuryo_saihakkou ★1本だけ★ を 当てる★ 2026-10-16
//
//   ★なぜ 専用の 道具か★（apply-kyuryo-get.mjs と 同じ 訳）
//     SQL の 門（sql-guard.mjs）は 関数を 作る SQL を 通さない。門は 緩めず、この 1本だけ 字で 切り出して 当てる。
//   ★今回 変えた 事★ 辞めた 人（今いる人で ない）には 作り直さない（reason 'taishoku'）
//     前は active を 見ず、辞めた 人にも 新しい 初回コードを 作れた（対立役・指示役 10-16）
//
//   ★守り★
//     ・supabase/apply-kyuryo-haifu.sql から ★dk_kyuryo_saihakkou の 塊だけ★ 切り出す（他の 関数・grant は 当てない）
//     ・切り出した 字に 別の 文が 紛れていない（$fn$ の 外に ; が 1つ だけ）
//     ・中身に insert・delete・drop・truncate・alter・grant・revoke・create が 無い（update は dk_kyuryo_pub の 作り直しで 要る）
//     ・向き先は js/dk-config.js（この repo の 倉庫 以外には 当たらない）・★本番は --honban を 付けた 時だけ★
//     ・当てた 後 ★倉庫に 入った 関数の 字を 読み戻して★ 直した 字が 在るか 数える（KAKUNIN）
//
//   使い方:
//     node scripts/apply-kyuryo-saihakkou.mjs                 … 見るだけ
//     node scripts/apply-kyuryo-saihakkou.mjs --ateru         … テスト線で 当てる
//     node scripts/apply-kyuryo-saihakkou.mjs --ateru --honban … 本番で 当てる（本番の 手元で）
// ============================================================
/* eslint-env node */
/* eslint-disable no-console */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readToken, whereWeLooked } from './db-token.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SQL_FILE = path.join(ROOT, 'supabase', 'apply-kyuryo-haifu.sql');
const HONBAN_REF = 'tnfwipbgfgjaymlszeid';

export const ARU = [
  ["'not_yours'", 'よその 会社の 人は 作り直さない'],
  ["'taishoku'", '辞めた 人には 作り直さない（10-16）'],
  ['coalesce(e.active, true) = false', '今いる人で ない 人を 見分ける'],
];

export function kiridasu(sql) {
  const s = String(sql).replace(/\r\n/g, '\n');
  const re = /create or replace function public\.dk_kyuryo_saihakkou\(p_employee_id uuid\)\n[\s\S]*?\n\$fn\$;/;
  const m = s.match(re);
  if (!m) throw new Error('dk_kyuryo_saihakkou の 塊が 見つからない');
  const block = m[0];
  const a = block.indexOf('$fn$');
  const b = block.lastIndexOf('$fn$');
  if (a < 0 || a === b) throw new Error('$fn$ の 囲いが 読めない');
  const soto = block.slice(0, a) + block.slice(b + 4);
  if ((soto.match(/;/g) || []).length !== 1) throw new Error('囲いの 外に 別の 文が 在る');
  if (!/security definer/.test(block.slice(0, a))) throw new Error('security definer が 無い');
  if (!/set search_path = daikome, public, extensions/.test(block.slice(0, a)))
    throw new Error('search_path を 固定していない');
  const naka = block.slice(a + 4, b).replace(/--[^\n]*/g, '');
  const ng = naka.match(/\b(insert|delete|drop|truncate|alter|grant|revoke|create)\b/i);
  if (ng) throw new Error('作り直しの 関数に ' + ng[0] + ' が 在る');
  return block;
}

export function kazoeru(def) {
  const d = String(def || '');
  const aru = ARU.map(([k, w]) => ({ k, w, ok: d.includes(k) }));
  return { aru, ok: d.length > 0 && aru.every((x) => x.ok) };
}

function readProjectRef() {
  const src = fs.readFileSync(path.join(ROOT, 'js', 'dk-config.js'), 'utf8');
  const m = src.match(/https:\/\/([a-z0-9]{20})\.supabase\.co/);
  if (!m) throw new Error('js/dk-config.js から向き先を読めなかった');
  return m[1];
}

async function runSql(ref, token, query) {
  const res = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'User-Agent': 'daikome-apply-kyuryo-saihakkou',
    },
    body: JSON.stringify({ query }),
  });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch (_) {
    body = text;
  }
  return { ok: res.ok, status: res.status, body };
}

async function yomimodosu(ref, token) {
  const r = await runSql(
    ref,
    token,
    "select pg_get_functiondef('public.dk_kyuryo_saihakkou(uuid)'::regprocedure) as d"
  );
  if (!r.ok) throw new Error('関数を 読み戻せない: ' + r.status);
  return (r.body && r.body[0] && r.body[0].d) || '';
}

async function main() {
  const args = process.argv.slice(2);
  const ateru = args.includes('--ateru');
  const honban = args.includes('--honban');
  const t = readToken();
  if (!t) {
    console.error('NG: 鍵が無い（探した所: ' + whereWeLooked().join(' / ') + '）');
    process.exit(2);
  }
  const ref = readProjectRef();
  console.log('向き先: ' + (ref === HONBAN_REF ? '★本番★' : 'テスト') + ' ' + ref + ' ／ 鍵: ' + t.from);
  const mae = kazoeru(await yomimodosu(ref, t.token));
  mae.aru.forEach((x) => console.log('  前 ' + (x.ok ? '在り' : '★無し★') + '  ' + x.k + '  … ' + x.w));
  if (!ateru) {
    console.log('\n見るだけ（当てるには --ateru）。KAKUNIN: ' + (mae.ok ? 'OK' : 'まだ'));
    return;
  }
  if (ref === HONBAN_REF && !honban) {
    console.error('\nNG: 向き先が 本番。本番に 当てるのは --honban を 付けた 時だけ');
    process.exit(3);
  }
  const r = await runSql(ref, t.token, kiridasu(fs.readFileSync(SQL_FILE, 'utf8')));
  if (!r.ok) {
    console.error('\nNG: 当てられなかった ' + r.status + ' ' + JSON.stringify(r.body).slice(0, 300));
    process.exit(4);
  }
  const ato = kazoeru(await yomimodosu(ref, t.token));
  ato.aru.forEach((x) => console.log('  後 ' + (x.ok ? '在り' : '★無し★') + '  ' + x.k + '  … ' + x.w));
  console.log('\nKAKUNIN: ' + (ato.ok ? 'OK' : '★NG★'));
  if (!ato.ok) process.exit(5);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((e) => {
    console.error('NG: ' + (e && e.message ? e.message : e));
    process.exit(1);
  });
}
