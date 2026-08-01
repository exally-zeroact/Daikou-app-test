-- ============================================================================
-- ダイコメ 給料（共有本番倉庫 tnfwipbgfgjaymlszeid 用）2026-08-01
--
--   ★このファイルは「足すだけ」★
--     ・新しい表 3つ を作るだけ
--     ・既に在る物（dk_shifts / dk_trips / dk_shift_edits / meisai / companies / pay_* …）は
--       ★1バイトも触らない★
--
--   ▼司さんの実物（代行計算表2026.xlsb）を再現するために要る物
--     売上・経費は既に dk_shifts / dk_shift_edits にある（売上表で作った物をそのまま使う）。
--     足りないのは「誰が」「何時間」働いたか と、係数などの設定だけ。
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1) 従業員マスタ
--    role = '2種' / '1種' など。係数と最低保証は dk_payroll_settings 側で役割ごとに決める。
-- ---------------------------------------------------------------------------
create table if not exists dk_employees (
  employee_id uuid primary key default gen_random_uuid(),
  company_id  uuid not null references dk_companies(company_id) on delete cascade,
  name        text not null,
  role        text not null default '2種',
  active      boolean not null default true,   -- 辞めた人は false（過去の明細は残る）
  sort_order  int default 0,
  note        text default '',
  created_at  timestamptz default now(),
  updated_at  timestamptz default now()
);

create index if not exists dk_employees_company_idx
  on dk_employees (company_id, active, sort_order, name);

-- ---------------------------------------------------------------------------
-- 2) 働いた時数（日ごと・人ごと）★手入力★
--    車に紐づける（誰がどの車に乗ったか）。既定の時数はその車の時数だが、個別に直せる。
-- ---------------------------------------------------------------------------
create table if not exists dk_work_hours (
  company_id  uuid not null references dk_companies(company_id) on delete cascade,
  work_date   date not null,
  employee_id uuid not null references dk_employees(employee_id) on delete cascade,
  device_id   text default '',                 -- 乗った車（空でもよい）
  hours       double precision not null default 0,
  updated_at  timestamptz default now(),
  primary key (company_id, work_date, employee_id)
);

create index if not exists dk_work_hours_date_idx
  on dk_work_hours (company_id, work_date);

-- ---------------------------------------------------------------------------
-- 3) 給料の決め方（会社ごと）★全部変えられる（司さん指示）★
--    roles の既定は司さんの実物と同じ: 2種=係数0.35/保証1150, 1種=係数0.30/保証1000
-- ---------------------------------------------------------------------------
create table if not exists dk_payroll_settings (
  company_id                 uuid primary key references dk_companies(company_id) on delete cascade,
  pool_mode                  text not null default 'others_total', -- others_total | all_total | per_car
  deduct_reserve_before_rate boolean not null default true,        -- 積立を引いてから時数で割る
  reserve_pool_rate          double precision not null default 0.05,
  reserve_owner_rate         double precision not null default 0.05,
  period_start_day           int not null default 21,              -- 給与期間の開始日（司さん=21日）
  period_days                int not null default 11,              -- 1枚に出す日数（司さん=11日）
  owner_device_id            text default '',                      -- 自分の車（母数から外す）
  roles                      jsonb not null default
    '{"2種":{"rate":0.35,"floor":1150},"1種":{"rate":0.30,"floor":1000}}'::jsonb,
  updated_at                 timestamptz default now()
);

-- ---------------------------------------------------------------------------
-- 4) 鍵（RLS）— 新しい3つの表にだけ。会社は自分の分だけ 読める/足せる/直せる
-- ---------------------------------------------------------------------------
alter table dk_employees        enable row level security;
alter table dk_work_hours       enable row level security;
alter table dk_payroll_settings enable row level security;

create policy dk_employees_owner_sel on dk_employees
  for select using (company_id in (select company_id from dk_companies where owner_id = auth.uid()));
create policy dk_employees_owner_ins on dk_employees
  for insert with check (company_id in (select company_id from dk_companies where owner_id = auth.uid()));
create policy dk_employees_owner_upd on dk_employees
  for update using (company_id in (select company_id from dk_companies where owner_id = auth.uid()));

create policy dk_work_hours_owner_sel on dk_work_hours
  for select using (company_id in (select company_id from dk_companies where owner_id = auth.uid()));
create policy dk_work_hours_owner_ins on dk_work_hours
  for insert with check (company_id in (select company_id from dk_companies where owner_id = auth.uid()));
create policy dk_work_hours_owner_upd on dk_work_hours
  for update using (company_id in (select company_id from dk_companies where owner_id = auth.uid()));
create policy dk_work_hours_owner_del on dk_work_hours
  for delete using (company_id in (select company_id from dk_companies where owner_id = auth.uid()));

create policy dk_payroll_settings_owner_sel on dk_payroll_settings
  for select using (company_id in (select company_id from dk_companies where owner_id = auth.uid()));
create policy dk_payroll_settings_owner_ins on dk_payroll_settings
  for insert with check (company_id in (select company_id from dk_companies where owner_id = auth.uid()));
create policy dk_payroll_settings_owner_upd on dk_payroll_settings
  for update using (company_id in (select company_id from dk_companies where owner_id = auth.uid()));

-- 確認
select tablename, rowsecurity as rls_enabled
  from pg_tables
 where schemaname = 'public'
   and tablename in ('dk_employees', 'dk_work_hours', 'dk_payroll_settings')
 order by tablename;
