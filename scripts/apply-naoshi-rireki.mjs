// ============================================================
// scripts/apply-naoshi-rireki.mjs
// ★直しの履歴（⑦）を 倉庫へ 当てる 専用の 道具★ 2026-11-08
//
//   ★なぜ 専用の 道具か★（apply-yaku-namae.mjs と 同じ 訳）
//     SQL の 門（sql-guard.mjs）は create trigger・create function・security definer を 通さない。門は 緩めず、ここで 字で 縛る。
//   ★守り（設計前 taiketsu 3回・止め 5つの 答え）★
//     ・ファイルからは ★関数 daikome.dk_naoshi_kiroku() の 塊だけ★ 切り出す（security definer・search_path = ''）
//     ・関数の 中身（注釈と 文字列を 落としてから）に execute・dblink・set_config・perform・update・delete・drop・
//       truncate・alter・grant・revoke・create・copy が 無い。insert の 先は dk_naoshi_rireki と dk_naoshi_rireki_ochi だけ。
//       呼べる 関数は 名簿（KANSU）だけ＝名簿は 関数の 下書きから 数えて 作った
//     ・表・決まり（RLS）・仕掛けは ★道具が 書く 決まった 字★（ファイルの 字は 当てない）。
//       仕掛けは 名簿（TAISHO）の 21表 × 3本（_i/_u/_d）・呼ぶ 先は daikome.dk_naoshi_kiroku() だけ
//     ・向き先は js/dk-config.js・本番の 止めは scripts/honban-tome.mjs（白名簿・本番は --honban の 時だけ）
//     ・当てた 後 ★倉庫を 読み戻して★ 数える（仕掛け 63本・RLS 2表・決まり 2本＝select だけ・ochi は 決まり 0本・関数の 字）
//
//   使い方:
//     node scripts/apply-naoshi-rireki.mjs                  … 見るだけ
//     node scripts/apply-naoshi-rireki.mjs --ateru          … テスト線で 当てる
//     node scripts/apply-naoshi-rireki.mjs --ateru --honban … 本番で 当てる（司さんの 許しの 後）
// ============================================================
/* eslint-env node */
/* eslint-disable no-console */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readToken, whereWeLooked } from './db-token.mjs';
import { HONBAN_REF, honbanNoTome } from './honban-tome.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

export const FILE = 'supabase/apply-naoshi-rireki.sql';
export const ATAMA = 'create or replace function daikome.dk_naoshi_kiroku()';

// 対象の 表（設計 v1 注8）。外した 物と 訳：dk_trips＝送り直しで 消して 入れ直す（合計は dk_shifts で 残る）／
// dk_fare_config＝自分の 履歴 dk_fare_config_history が 在る
export const TAISHO = [
  'daikou.meisai',
  'daikou.payments',
  'daikou.invoices',
  'daikou.invoice_no',
  'daikou.companies',
  'daikou.issuer',
  'daikome.dk_shifts',
  'daikome.dk_shift_edits',
  'daikome.dk_pay_adjustments',
  'daikome.dk_manual_days',
  'daikome.dk_meisai_hazushi',
  'daikome.dk_day_extras',
  'daikome.dk_month_extras',
  'daikome.dk_work_hours',
  'daikome.dk_payroll_settings',
  'daikome.dk_sales_settings',
  'daikome.dk_employees',
  'daikome.dk_hito_rireki',
  'daikome.dk_yaku_rireki',
  'daikome.dk_uriage_rireki',
  'daikome.dk_shime_rireki',
];

// 関数の 中で 呼んで よい 物（字の 後に「(」が 来る 物）。SQL の 言葉（in・any・exists 等）も ここで 許す
export const KANSU = new Set([
  'array_agg',
  'array_position',
  'any',
  'nullif',
  'current_setting',
  'coalesce',
  'split_part',
  'left',
  'jsonb_strip_nulls',
  'jsonb_build_object',
  'jsonb_object_agg',
  'jsonb_each',
  'to_jsonb',
  'unnest',
  'now',
  'array',
  'select',
  'in',
  'exists',
  'then',
  'and',
  'or',
  'from',
  'join',
  'lateral',
  'values',
  'when',
  'else',
  'daikome.dk_naoshi_rireki',
  'daikome.dk_naoshi_rireki_ochi',
]);

const NG = /\b(execute|dblink\w*|set_config|perform|update|delete|drop|truncate|alter|grant|revoke|create|copy|call|do)\b/i;

// 注釈と 文字列（'…'・"…" は 名前なので 残す）を 落とす
export function hagasu(x) {
  return String(x)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, ' ')
    .replace(/'(?:[^']|'')*'/g, "''");
}

export function kiridasu(sql) {
  const s = String(sql).replace(/\r\n/g, '\n');
  const a0 = s.indexOf(ATAMA + '\n');
  if (a0 < 0) throw new Error('dk_naoshi_kiroku の 塊が 見つからない');
  if (s.indexOf(ATAMA + '\n', a0 + 1) >= 0) throw new Error('dk_naoshi_kiroku の 塊が 2つ 在る');
  const owari = s.indexOf('\n$fn$;', a0);
  if (owari < 0) throw new Error('dk_naoshi_kiroku の 終わりが 見つからない');
  const block = s.slice(a0, owari + '\n$fn$;'.length);
  const a = block.indexOf('$fn$');
  const b = block.lastIndexOf('$fn$');
  if (a < 0 || a === b) throw new Error('$fn$ の 囲いが 読めない');
  if ((block.slice(a + 4, b).match(/\$\w*\$/g) || []).length)
    throw new Error('囲いの 中に 別の $…$ が 在る');
  const soto = block.slice(0, a) + block.slice(b + 4);
  if ((soto.match(/;/g) || []).length !== 1) throw new Error('囲いの 外に 別の 文が 在る');
  const atama = hagasu(block.slice(0, a));
  if (!/\breturns\s+trigger\b/i.test(atama)) throw new Error('returns trigger で ない');
  if (!/\bsecurity\s+definer\b/i.test(atama)) throw new Error('security definer が 無い');
  if (/\bsecurity\s+invoker\b/i.test(atama)) throw new Error('security invoker が 在る');
  if (!/\bset\s+search_path\s*=\s*''/i.test(block.slice(0, a)))
    throw new Error("search_path を '' に 固定していない");
  const naka = hagasu(block.slice(a + 4, b));
  const ng = naka.match(NG);
  if (ng) throw new Error('dk_naoshi_kiroku に ' + ng[0] + ' が 在る');
  // insert の 先（引用符・空白を 外して 名前で 比べる）
  const ins = naka.match(/\binsert\s+into\s+(?:"[^"]+"|\w+)(?:\s*\.\s*(?:"[^"]+"|\w+))?/gi) || [];
  if (!ins.length) throw new Error('insert が 無い');
  for (const i of ins) {
    const t = i
      .replace(/^insert\s+into\s+/i, '')
      .replace(/["\s]/g, '')
      .toLowerCase();
    if (t !== 'daikome.dk_naoshi_rireki' && t !== 'daikome.dk_naoshi_rireki_ochi')
      throw new Error('dk_naoshi_kiroku が ' + t + ' へ 入れる');
  }
  // 呼ぶ 物は 名簿だけ（字(…) の 形を 全部 拾う・部屋付きも）
  const yobi = naka.match(/(?:"[^"]+"|[a-z_][\w$]*)(?:\s*\.\s*(?:"[^"]+"|[a-z_][\w$]*))?\s*\(/gi) || [];
  for (const y of yobi) {
    const t = y
      .replace(/\($/, '')
      .replace(/["\s]/g, '')
      .toLowerCase()
      .replace(/^pg_catalog\./, '');
    if (!KANSU.has(t)) throw new Error('dk_naoshi_kiroku が 名簿に 無い ' + t + ' を 呼ぶ');
  }
  return block;
}

const POL_KOU = 'user_id = (select auth.uid())';
const POL_KOME =
  'company_id in (select c.company_id from daikome.dk_companies c where c.owner_id = (select auth.uid()))';

// 道具が 書く 決まった 字（ファイルの 字は 当てない）
export function kimatta() {
  const hyou = [
    `create table if not exists daikome.dk_naoshi_rireki (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  tbl text not null,
  op text not null check (op in ('I','U','D')),
  bun_op text not null,
  pk jsonb not null,
  user_id uuid,
  company_id uuid,
  dare_shu text not null,
  dare text not null,
  auth_uid uuid,
  kawatta text[] not null default '{}',
  mae jsonb,
  ato jsonb
);`,
    `create table if not exists daikome.dk_naoshi_rireki_ochi (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  tbl text,
  err text
);`,
    'create index if not exists dk_naoshi_rireki_user on daikome.dk_naoshi_rireki (user_id, id) where user_id is not null;',
    'create index if not exists dk_naoshi_rireki_co on daikome.dk_naoshi_rireki (company_id, id) where company_id is not null;',
    'alter table daikome.dk_naoshi_rireki enable row level security;',
    'alter table daikome.dk_naoshi_rireki_ochi enable row level security;',
    'drop policy if exists dk_naoshi_rireki_kou on daikome.dk_naoshi_rireki;',
    `create policy dk_naoshi_rireki_kou on daikome.dk_naoshi_rireki for select to authenticated using (${POL_KOU});`,
    'drop policy if exists dk_naoshi_rireki_kome on daikome.dk_naoshi_rireki;',
    `create policy dk_naoshi_rireki_kome on daikome.dk_naoshi_rireki for select to authenticated using (${POL_KOME});`,
    // ★2026-11-14 本番前 taiketsu 止め S1★: 既定の権限に頼らない（抜けると請求書の画面が 42501＝「確かめられませんでした」）
    'grant select on daikome.dk_naoshi_rireki to authenticated;',
  ];
  return hyou;
}

export function shikake() {
  const out = [];
  for (const t of TAISHO) {
    const na = 'dk_naoshi_' + t.split('.')[1];
    out.push(
      `create or replace trigger ${na}_i after insert on ${t} referencing new table as naoshi_ato for each statement execute function daikome.dk_naoshi_kiroku();`,
      `create or replace trigger ${na}_u after update on ${t} referencing old table as naoshi_mae new table as naoshi_ato for each statement execute function daikome.dk_naoshi_kiroku();`,
      `create or replace trigger ${na}_d after delete on ${t} referencing old table as naoshi_mae for each statement execute function daikome.dk_naoshi_kiroku();`
    );
  }
  return out;
}

export const YOMIMODOSHI = `select
  (select count(*) from pg_trigger g join pg_proc p on p.oid = g.tgfoid join pg_namespace pn on pn.oid = p.pronamespace
     where g.tgname like 'dk\\_naoshi\\_%' and not g.tgisinternal
       and pn.nspname = 'daikome' and p.proname = 'dk_naoshi_kiroku') as shikake,
  (select count(*) from pg_trigger g where g.tgname like 'dk\\_naoshi\\_%' and not g.tgisinternal) as shikake_zen,
  (select coalesce(json_agg(n.nspname || '.' || c.relname || ':' || g.tgname order by 1), '[]') from pg_trigger g
     join pg_class c on c.oid = g.tgrelid join pg_namespace n on n.oid = c.relnamespace
     where g.tgname like 'dk\\_naoshi\\_%' and not g.tgisinternal) as shikake_na,
  (select bool_and(c.relrowsecurity) from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'daikome' and c.relname in ('dk_naoshi_rireki', 'dk_naoshi_rireki_ochi')) as rls,
  (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'daikome' and c.relname in ('dk_naoshi_rireki', 'dk_naoshi_rireki_ochi')) as hyou,
  (select coalesce(json_agg(json_build_object('na', policyname, 'cmd', cmd, 'qual', qual) order by policyname), '[]')
     from pg_policies where schemaname = 'daikome' and tablename = 'dk_naoshi_rireki') as kimari,
  (select count(*) from pg_policies where schemaname = 'daikome' and tablename = 'dk_naoshi_rireki_ochi') as kimari_ochi,
  (select pg_get_functiondef(p.oid) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'daikome' and p.proname = 'dk_naoshi_kiroku' limit 1) as d,
  (select p.prosecdef from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'daikome' and p.proname = 'dk_naoshi_kiroku' limit 1) as definer,
  (select has_table_privilege('authenticated', c.oid, 'select') from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'daikome' and c.relname = 'dk_naoshi_rireki') as kengen`;

// 読み戻しの 判じ（当てる 前の 字は 完全一致で 縛った。当てた 後は PG が 直した 形で 持つ＝中身で 数える・設計 v3 注3）
export function hanjiru(r, block) {
  const ng = [];
  const x = r || {};
  const meiwa = shikake()
    .map((s) => {
      const m = s.match(/trigger (\S+) after \w+ on (\S+) /);
      return m[2] + ':' + m[1];
    })
    .sort();
  const aru = (Array.isArray(x.shikake_na) ? x.shikake_na : []).slice().sort();
  if (Number(x.shikake) !== meiwa.length) ng.push('仕掛け ' + x.shikake + '本（' + meiwa.length + '本の 筈）');
  if (Number(x.shikake_zen) !== meiwa.length) ng.push('dk_naoshi_ の 仕掛けが ' + x.shikake_zen + '本（他の 関数を 呼ぶ 物が 在る）');
  if (JSON.stringify(aru) !== JSON.stringify(meiwa)) ng.push('仕掛けの 名前と 表が 名簿と 違う');
  if (Number(x.hyou) !== 2) ng.push('表が ' + x.hyou + '個');
  if (x.rls !== true) ng.push('RLS が 入っていない 表が 在る');
  const k = Array.isArray(x.kimari) ? x.kimari : [];
  if (k.length !== 2) ng.push('決まりが ' + k.length + '本');
  for (const p of k) {
    const q = String(p.qual || '');
    if (p.cmd !== 'SELECT') ng.push(p.na + ' が select で ない（' + p.cmd + '）');
    if (!/auth\.uid\(\)/.test(q) || /^\(?\s*true\s*\)?$/i.test(q)) ng.push(p.na + ' の 式が おかしい');
  }
  if (Number(x.kimari_ochi) !== 0) ng.push('ochi に 決まりが ' + x.kimari_ochi + '本（誰かに 見える）');
  if (x.definer !== true) ng.push('関数が security definer で ない');
  if (x.kengen !== true) ng.push('authenticated が dk_naoshi_rireki を select できない（請求書の画面が 42501）');
  const d = String(x.d || '');
  if (!d.includes('jsonb_object_agg(c, x.j -> c)') || !d.includes("v_dare := 'jimusho:'"))
    ng.push('関数の 字が ファイルと 違う');
  if (block && !d.replace(/\s+/g, ' ').includes('insert into daikome.dk_naoshi_rireki_ochi (tbl, err)'))
    ng.push('関数に 落ちた 訳の 記録が 無い');
  return ng;
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
      'User-Agent': 'daikome-apply-naoshi-rireki',
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

async function main() {
  const args = process.argv.slice(2);
  const ateru = args.includes('--ateru');
  const t = readToken();
  if (!t) {
    console.error('NG: 鍵が無い（探した所: ' + whereWeLooked().join(' / ') + '）');
    process.exit(2);
  }
  const ref = readProjectRef();
  const tome = honbanNoTome(ref, args, !ateru);
  if (tome) {
    console.error(tome);
    process.exit(3);
  }
  console.log('向き先: ' + (ref === HONBAN_REF ? '★本番★' : 'テスト') + ' ' + ref + ' ／ 鍵: ' + t.from);
  const block = kiridasu(fs.readFileSync(path.join(ROOT, FILE), 'utf8'));
  const mae = await runSql(ref, t.token, YOMIMODOSHI);
  console.log('前: ' + (mae.ok ? JSON.stringify({ ...mae.body[0], d: undefined, shikake_na: undefined }) : mae.status));
  if (!ateru) {
    console.log('\n見るだけ（当てるには --ateru）');
    return;
  }
  // ★表・関数・決まり・仕掛けを 1つの 取引で★（半分だけ 出来た 間を 作らない）
  const q = ['begin;', ...kimatta(), block, ...shikake(), 'commit;'].join('\n');
  const r = await runSql(ref, t.token, q);
  if (!r.ok) {
    console.error('NG: 当てられなかった（1つの 取引なので 何も 変わっていない筈） ' + r.status + ' ' + JSON.stringify(r.body).slice(0, 400));
    process.exit(4);
  }
  const ato = await runSql(ref, t.token, YOMIMODOSHI);
  if (!ato.ok) {
    console.error('NG: 読み戻せなかった ' + ato.status);
    process.exit(5);
  }
  const ng = hanjiru(ato.body[0], block);
  console.log('後: 仕掛け ' + ato.body[0].shikake + '本 ／ RLS ' + ato.body[0].rls + ' ／ 決まり ' + (ato.body[0].kimari || []).length + '本 ／ ochi の 決まり ' + ato.body[0].kimari_ochi + '本');
  ng.forEach((x) => console.log('  ★' + x));
  console.log('\nKAKUNIN: ' + (ng.length ? '★NG★' : 'OK'));
  if (ng.length) process.exit(6);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((e) => {
    console.error('NG: ' + (e && e.message ? e.message : e));
    process.exit(1);
  });
}
