-- ============================================================
-- ★ダイコメ「使える人」★ 2026-08-06
--
--   司さん「ダイコメ用の作れや 最終は別アプリやろが」
--     → Exally の表(exally_entitlements)には載せない。
--       ダイコメ自身の部屋(daikome)に持たせる＝独立する時にそのまま持って出られる。
--
--   ★今までの形★
--     ダイコメの棚は全部 owner_id = auth.uid()。
--     ＝★会社の持ち主1人しか事務所に入れない★。人を足す方法が無かった。
--
--   ★これから★
--     daikome.dk_members に「このメールの人は、この会社を使える」を持つ。
--     ・持ち主(owner)だけが 足す/外す できる
--     ・外した人はその場で入れなくなる（active=false）
--     ・★持ち主は自分を外せない★（誰も入れなくなるのを防ぐ）
--
--   ▼メールで持つ理由
--     まだアカウントを作っていない人にも先に席を用意できる。
--     初めて入った時に user_id を結び付ける。
-- ============================================================

create table if not exists daikome.dk_members (
  company_id uuid not null references daikome.dk_companies (company_id) on delete cascade,
  email text not null,
  user_id uuid,                      -- 初めて入った時に埋まる
  role text not null default 'staff', -- 'owner' | 'staff'
  active boolean not null default true,
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (company_id, email)
);

create index if not exists dk_members_email_idx on daikome.dk_members (lower(email));
create index if not exists dk_members_user_idx on daikome.dk_members (user_id);

-- ★今 入っている人（＝会社の持ち主）を必ず1行入れる★
--   これが無いと、切り替えた瞬間に司さん自身が入れなくなる。
insert into daikome.dk_members (company_id, email, user_id, role, active, note)
select c.company_id, lower(u.email), c.owner_id, 'owner', true, '会社を作った人'
from daikome.dk_companies c
join auth.users u on u.id = c.owner_id
where c.owner_id is not null
on conflict (company_id, email) do update
  set role = 'owner', active = true, user_id = excluded.user_id, updated_at = now();

-- ─────────────────────────────────────────
-- ★この人が使える会社★（持ち主 または 外されていない使える人）
--   security definer = 棚の鍵に関係なく判定できる（判定そのものが鍵に引っかかると無限ループになる）
-- ─────────────────────────────────────────
create or replace function daikome.my_companies()
returns setof uuid
language sql
stable
security definer
set search_path = daikome, public, auth
as $$
  select c.company_id from daikome.dk_companies c where c.owner_id = auth.uid()
  union
  select m.company_id from daikome.dk_members m
   where m.active
     and (m.user_id = auth.uid()
          or lower(m.email) = lower(coalesce(nullif(current_setting('request.jwt.claims', true), '')::json ->> 'email', '')))
$$;

revoke all on function daikome.my_companies() from public;
grant execute on function daikome.my_companies() to authenticated;

-- ★持ち主かどうか★（足す/外す を許すのは持ち主だけ）
create or replace function daikome.is_owner(cid uuid)
returns boolean
language sql
stable
security definer
set search_path = daikome, public, auth
as $$
  select exists (select 1 from daikome.dk_companies c where c.company_id = cid and c.owner_id = auth.uid())
$$;

revoke all on function daikome.is_owner(uuid) from public;
grant execute on function daikome.is_owner(uuid) to authenticated;

-- ─────────────────────────────────────────
-- 使える人の棚の鍵
-- ─────────────────────────────────────────
alter table daikome.dk_members enable row level security;

drop policy if exists dk_members_read on daikome.dk_members;
create policy dk_members_read on daikome.dk_members
  for select using (company_id in (select daikome.my_companies()));

-- ★足す/直す/外す は持ち主だけ★
drop policy if exists dk_members_write on daikome.dk_members;
create policy dk_members_write on daikome.dk_members
  for all using (daikome.is_owner(company_id)) with check (daikome.is_owner(company_id));

grant select on daikome.dk_members to authenticated;
grant insert, update, delete on daikome.dk_members to authenticated;

-- public にも同じ名前の窓口を出す（アプリのコードは今までどおり）
create or replace view public.dk_members with (security_invoker = true) as
  select * from daikome.dk_members;
grant select, insert, update, delete on public.dk_members to authenticated, anon;

-- ★持ち主は自分を外せない★（誰も入れなくなるのを防ぐ）
create or replace function daikome.dk_members_guard()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' then
    -- ★会社ごと消す時は通す (2026-08-06)★
    --   通さないと、持ち主の行が盾になって★会社そのものを消せなくなる★。
    --   （on delete cascade で消えに来た時、親はもう居ない）
    if not exists (select 1 from daikome.dk_companies c where c.company_id = old.company_id) then
      return old;
    end if;
    if old.role = 'owner' then
      raise exception '会社の持ち主は外せません';
    end if;
    return old;
  end if;
  if tg_op = 'UPDATE' and old.role = 'owner' and (new.active = false or new.role <> 'owner') then
    raise exception '会社の持ち主は外せません';
  end if;
  new.updated_at := now();
  new.email := lower(new.email);
  return new;
end
$$;

drop trigger if exists dk_members_guard_trg on daikome.dk_members;
create trigger dk_members_guard_trg
  before update or delete on daikome.dk_members
  for each row execute function daikome.dk_members_guard();

drop trigger if exists dk_members_ins_trg on daikome.dk_members;
create trigger dk_members_ins_trg
  before insert on daikome.dk_members
  for each row execute function daikome.dk_members_guard();
