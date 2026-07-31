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
-- 4) 勤務(シフト) = 業務開始 → 業務終了。1晩の勤務ぜんたい。
--    メーターが localStorage に貯めた履歴を dk-sync-jobs が入れる。
--    ★鍵 = (company_id, device_id, started_at)★ … 同じ勤務を何度送っても増えない(冪等)。
-- ---------------------------------------------------------------------------
create table if not exists dk_shifts (
  shift_id         uuid primary key default gen_random_uuid(),
  company_id       uuid not null references dk_companies(company_id) on delete cascade,
  device_id        text not null,
  driver_id        uuid,                    -- 後で dk_drivers に紐付ける(今は空)
  started_at       timestamptz not null,
  ended_at         timestamptz,
  elapsed_sec      int,
  total_distance_m double precision,        -- 総走行(空車込み)
  actual_total_m   double precision,        -- 実車の合計
  empty_distance_m double precision,        -- 空車 = 総走行 − 実車
  fare_total_yen   int,                     -- 売上合計
  trip_count       int,                     -- 代行の件数
  created_at       timestamptz default now(),
  unique (company_id, device_id, started_at)
);

create index if not exists dk_shifts_company_started_idx
  on dk_shifts (company_id, started_at desc);

-- ---------------------------------------------------------------------------
-- 5) 代行 = 代行開始 → 精算終了。★課金の単位。売上と歩合の元ネタ。★
--    距離・料金はメーターが確定した値をそのまま入れる(再計算・補正はしない)。
-- ---------------------------------------------------------------------------
create table if not exists dk_trips (
  trip_id       uuid primary key default gen_random_uuid(),
  shift_id      uuid not null references dk_shifts(shift_id) on delete cascade,
  company_id    uuid not null references dk_companies(company_id) on delete cascade,
  seq           int not null,               -- 勤務内の何件目か(明細の順を毎回同じにする)
  distance_m    double precision not null,  -- ★メーター確定値★
  fare_yen      int not null,               -- ★メーター確定値★
  -- 請求書払い(掛け)。実車中に「請求書」ボタンで選ばれた会社。未選択なら現金。
  --   customer_name は「その時の名前」を焼き付ける(後でマスタから消えても過去の請求書が壊れない)
  customer_id   uuid,
  customer_name text default '',
  payment_type  text not null default 'cash',   -- 'cash' | 'invoice'
  started_at    timestamptz,
  ended_at      timestamptz,
  start_address text default '',
  end_address   text default '',
  waypoints     jsonb default '[]'::jsonb,
  created_at    timestamptz default now(),
  unique (shift_id, seq)
);

-- 既存の表にも足せるように(冪等)
alter table dk_trips add column if not exists customer_id   uuid;
alter table dk_trips add column if not exists customer_name text default '';
alter table dk_trips add column if not exists payment_type  text not null default 'cash';

-- 掛けの集計(請求書作成)を速くする
create index if not exists dk_trips_customer_idx
  on dk_trips (company_id, customer_id, started_at)
  where customer_id is not null;

create index if not exists dk_trips_company_started_idx
  on dk_trips (company_id, started_at desc);

-- ---------------------------------------------------------------------------
-- 5.5) 請求書マスタ(掛け先の会社一覧)
--      ★実車中の「請求書」ボタンを押すと、この一覧から会社を選ぶ★
--      ドライバー端末はこれを持ち歩く(オフラインでも一覧が出る必要があるため)。
--      登録・編集は事務所側(ログインした会社)が行う。
-- ---------------------------------------------------------------------------
create table if not exists dk_customers (
  customer_id  uuid primary key default gen_random_uuid(),
  company_id   uuid not null references dk_companies(company_id) on delete cascade,
  name         text not null,               -- 会社名(ドライバーが見て選ぶ名前)
  kana         text default '',             -- 並べ替え/検索用
  honorific    text default '御中',          -- 請求書の宛名につける敬称
  billing_name text default '',             -- 請求書の正式な宛先(空なら name を使う)
  closing_day  int  default 31,             -- 締め日(31=月末)
  note         text default '',
  active       boolean not null default true, -- false = 一覧に出さない(過去データは残る)
  sort_order   int default 0,               -- よく使う会社を上に出す
  created_at   timestamptz default now(),
  updated_at   timestamptz default now()
);

create index if not exists dk_customers_company_idx
  on dk_customers (company_id, active, sort_order, name);

alter table dk_customers enable row level security;

-- 事務所(ログインした会社)は自分の掛け先を読める/作れる/直せる
drop policy if exists dk_customers_owner_sel on dk_customers;
create policy dk_customers_owner_sel on dk_customers
  for select using (
    company_id in (select company_id from dk_companies where owner_id = auth.uid())
  );

drop policy if exists dk_customers_owner_ins on dk_customers;
create policy dk_customers_owner_ins on dk_customers
  for insert with check (
    company_id in (select company_id from dk_companies where owner_id = auth.uid())
  );

drop policy if exists dk_customers_owner_upd on dk_customers;
create policy dk_customers_owner_upd on dk_customers
  for update using (
    company_id in (select company_id from dk_companies where owner_id = auth.uid())
  );
-- ※delete は作らない。消すのでなく active=false にする(過去の請求書が壊れないように)。

-- RLS: 会社は自分の実績だけ読める。書き込みは Edge Function(service_role)のみ。
alter table dk_shifts enable row level security;
alter table dk_trips  enable row level security;

drop policy if exists dk_shifts_owner_sel on dk_shifts;
create policy dk_shifts_owner_sel on dk_shifts
  for select using (
    company_id in (select company_id from dk_companies where owner_id = auth.uid())
  );

drop policy if exists dk_trips_owner_sel on dk_trips;
create policy dk_trips_owner_sel on dk_trips
  for select using (
    company_id in (select company_id from dk_companies where owner_id = auth.uid())
  );

-- ---------------------------------------------------------------------------
-- 6) 確認: ここまでが正しく入ったかを目で見る
--    期待: 4つの表が rls_enabled = true で並び、ポリシーが5本(select 4 / delete 1)出る。
-- ---------------------------------------------------------------------------
select tablename, rowsecurity as rls_enabled
  from pg_tables
 where schemaname = 'public'
   and tablename in ('dk_companies', 'dk_company_devices', 'dk_shifts', 'dk_trips')
 order by tablename;

select tablename, policyname, cmd
  from pg_policies
 where schemaname = 'public'
   and tablename in ('dk_companies', 'dk_company_devices', 'dk_shifts', 'dk_trips')
 order by tablename, policyname;
