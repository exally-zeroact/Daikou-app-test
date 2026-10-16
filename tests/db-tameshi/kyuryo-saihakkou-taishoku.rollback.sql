-- ★辞めた 人には 本人リンクを 作り直さない（dk_kyuryo_saihakkou）の 確かめ★ 2026-10-16＝テスト線の 倉庫だけ・必ず rollback
-- 当て方：node tests/db-tameshi/tameshi-rollback.mjs <worktree> この ファイル
-- 期待：1 今いる人＝true／2 辞めた人＝false/taishoku／3 よその 会社の 人＝false/not_yours
begin;
-- 持ち主の 居る 会社に 仮の 人を 1人 足す（rollback で 消える）
insert into daikome.dk_employees (company_id, name, role, active)
  select company_id, 'zz-saihakkou-tameshi', '2種', true from daikome.dk_companies where owner_id is not null order by company_id limit 1;
create temp table t as
  select e.employee_id, e.company_id, c.owner_id
  from daikome.dk_employees e join daikome.dk_companies c on c.company_id = e.company_id
  where e.name = 'zz-saihakkou-tameshi';
-- この 取引の 中だけ 会社の 持ち主として 呼ぶ（auth.uid() が 読む 値）
select set_config('request.jwt.claims', json_build_object('sub', owner_id::text, 'role', 'authenticated')::text, true) from t;
create temp table k (n text, v text);
insert into k select '1 今いる人', public.dk_kyuryo_saihakkou(employee_id)::jsonb->>'ok' from t;
update daikome.dk_employees set active = false where employee_id = (select employee_id from t);
insert into k select '2 辞めた人', coalesce(public.dk_kyuryo_saihakkou(employee_id)::jsonb->>'ok','') || '/' || coalesce(public.dk_kyuryo_saihakkou(employee_id)::jsonb->>'reason','') from t;
insert into k select '3 よその会社の人', coalesce(public.dk_kyuryo_saihakkou(gen_random_uuid())::jsonb->>'ok','') || '/' || coalesce(public.dk_kyuryo_saihakkou(gen_random_uuid())::jsonb->>'reason','') from t;
select n, v from k order by n;
rollback;
