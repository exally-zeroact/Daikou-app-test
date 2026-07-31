-- ============================================================================
-- ダイコメ 独立プロジェクト 一発構築SQL (2026-07-31)
--
--   ★使い方: 新しい Supabase プロジェクトの SQL Editor に、このファイルを丸ごと貼って1回実行。★
--   何度実行しても同じ結果になる(冪等)ので、失敗したらそのまま貼り直してよい。
--
--   これが作るもの:
--     dk_companies        … 契約している会社(1社1行)。会社URL(?c=)のトークン・契約台数・ON/OFF。
--     dk_company_devices  … 有効化されたスマホ(台数カウントの真実源)。
--     RLS                 … ログインした会社が「自分の会社と自分の端末」だけ見られる鍵。
--
--   ★含めていないもの(意図的)★
--     ・admin_token / 秘密リンク方式 … アカウント(マジックリンク)方式に置き換え済のため入れない。
--     ・テスト会社の自動作成         … アカウント方式では dashboard.html の登録フォームから作るのが正。
--
--   この後にやること(手順書 docs/DAIKOME_STANDALONE_MIGRATION.md 参照):
--     1) Ed25519 鍵ペアを作り、秘密鍵を Edge Function secret DK_LICENSE_PRIVKEY に入れる
--     2) Edge Function dk-issue-license / dk-register-company をデプロイ
--     3) Auth のメールログインを有効化 + リダイレクト許可URL を登録
--     4) js/dk-config.js の SB_URL / ANON_KEY を新プロジェクトの値に差し替え
--     5) js/license-v2.js の PUBLIC_KEY を新しい公開鍵に差し替え
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1) 会社(契約単位)
--    url_token = 会社ごとの固有URL ?c=<これ>。推測不能な乱数(16byte hex)。ドライバーに配る。
--    status    = 'on' | 'off'。'off' は未払い等での停止。★会社側から戻せてはいけない(下のRLS参照)★
--    seat_limit= 契約台数(有効化できるスマホの数)。
--    owner_id  = この会社にログインできる人(auth.users.id)。1オーナー1会社。
-- ---------------------------------------------------------------------------
create table if not exists dk_companies (
  company_id uuid primary key default gen_random_uuid(),
  url_token  text unique not null,
  name       text default '',
  contact    text default '',
  status     text not null default 'on',
  seat_limit int  not null default 1,
  plan       text default '',
  owner_id   uuid,
  created_at timestamptz default now()
);

-- 既存プロジェクトから移す場合に備え、列は個別にも足せるように(冪等)
alter table dk_companies add column if not exists contact  text default '';
alter table dk_companies add column if not exists plan     text default '';
alter table dk_companies add column if not exists owner_id uuid;

-- 1オーナー = 1会社(owner_id が入っている行の中で一意)
create unique index if not exists dk_companies_owner_uidx
  on dk_companies (owner_id) where owner_id is not null;

-- ---------------------------------------------------------------------------
-- 2) 有効化されたスマホ(台数カウントの真実源)
--    ★台数はスマホ(device_id)単位★(車VIN固定は「めんどくさい」で撤回済・司さん決定 2026-07-28)。
--    同じスマホの再有効化は席を消費しない(主キーが (company_id, device_id) なので upsert で冪等)。
--    vin は参考情報として保存するだけ。判定には使わない。
-- ---------------------------------------------------------------------------
create table if not exists dk_company_devices (
  company_id uuid not null references dk_companies(company_id) on delete cascade,
  device_id  text not null,
  vin        text default '',
  last_seen  timestamptz default now(),
  created_at timestamptz default now(),
  primary key (company_id, device_id)
);

-- 台数カウント(会社ごとの件数)を速くする
create index if not exists dk_company_devices_company_idx
  on dk_company_devices (company_id);

-- ---------------------------------------------------------------------------
-- 3) RLS(行レベルセキュリティ) = 「誰がどの行を見られるか」の鍵
--    ・ログインした会社は、自分の会社と自分の端末だけ。他社の行は存在ごと見えない。
--    ・匿名(anonキーだけ)では0件。列挙できない。
--    ・書き込み(会社作成・端末登録)は Edge Function(service_role)だけ。service_role は RLS を通り抜ける。
-- ---------------------------------------------------------------------------
alter table dk_companies       enable row level security;
alter table dk_company_devices enable row level security;

-- 自分の会社だけ「読める」
drop policy if exists dk_companies_owner_sel on dk_companies;
create policy dk_companies_owner_sel on dk_companies
  for select using (owner_id = auth.uid());

-- ★update ポリシーは作らない(重要)★
--   会社側に update を許すと、停止(status='off')を本人が 'on' に戻せてしまい、
--   「未払いで止める」仕組みが丸ごと無効になる。status/seat_limit の変更は
--   管理(service_role)/課金フロー専用。insert も Edge Function 経由のみ。
drop policy if exists dk_companies_owner_upd on dk_companies;

-- 自分の会社の端末だけ「読める」
drop policy if exists dk_devices_owner_sel on dk_company_devices;
create policy dk_devices_owner_sel on dk_company_devices
  for select using (
    company_id in (select company_id from dk_companies where owner_id = auth.uid())
  );

-- 自分の会社の端末だけ「外せる」(壊れた/入れ替えたスマホの席を空ける)
drop policy if exists dk_devices_owner_del on dk_company_devices;
create policy dk_devices_owner_del on dk_company_devices
  for delete using (
    company_id in (select company_id from dk_companies where owner_id = auth.uid())
  );

-- insert/update(端末登録)は dk-issue-license(service_role)経由のみ。ポリシーを作らない = 誰も直接書けない。

-- ---------------------------------------------------------------------------
-- 4) 確認: ここまでが正しく入ったかを目で見る
--    期待: 2つの表が rls_enabled = true で並び、ポリシーが3本(select 2 / delete 1)出る。
-- ---------------------------------------------------------------------------
select tablename, rowsecurity as rls_enabled
  from pg_tables
 where schemaname = 'public' and tablename in ('dk_companies', 'dk_company_devices')
 order by tablename;

select tablename, policyname, cmd
  from pg_policies
 where schemaname = 'public' and tablename in ('dk_companies', 'dk_company_devices')
 order by tablename, policyname;
