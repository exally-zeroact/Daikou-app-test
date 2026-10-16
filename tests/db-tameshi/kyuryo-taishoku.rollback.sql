-- ★辞めた 人の 門（dk_kyuryo_get）の 確かめ★ 2026-10-16＝テスト線の 倉庫だけで、必ず rollback で 終わる（後に 残る 行 0）
-- 当て方：node <scratchpad>/tameshi-rollback.mjs <worktree> この ファイル（本番の 向き先なら 投げない・commit の 字は 書かない）
-- 期待（2026-10-16 テスト線 実測）：1 true／2 true／3 true／4 false/taishoku／5 false/taishoku／6 true
begin;
create temp table t as
  select w.company_id, w.employee_id, w.work_date d from daikome.dk_work_hours w order by w.work_date limit 1;
delete from daikome.dk_kyuryo_pub where employee_id = (select employee_id from t);
insert into daikome.dk_kyuryo_pub (token, company_id, employee_id, pw_hash)
  select 'zz-taishoku-tameshi', company_id, employee_id, extensions.crypt('pw', extensions.gen_salt('bf')) from t;
create temp table k (n text, v text);
insert into k select '1 今いる人・働いた日を含む', public.dk_kyuryo_get('zz-taishoku-tameshi','pw', d - 10, d + 20)::jsonb->>'ok' from t;
insert into k select '2 今いる人・働いていない遠い月', public.dk_kyuryo_get('zz-taishoku-tameshi','pw', d + 100, d + 130)::jsonb->>'ok' from t;
update daikome.dk_employees set active = false where employee_id = (select employee_id from t);
insert into k select '3 辞めた・働いた日を含む', coalesce(public.dk_kyuryo_get('zz-taishoku-tameshi','pw', d - 10, d + 20)::jsonb->>'ok','') || '/' || coalesce(public.dk_kyuryo_get('zz-taishoku-tameshi','pw', d - 10, d + 20)::jsonb->>'reason','') from t;
insert into k select '4 辞めた・働いていない月', coalesce(public.dk_kyuryo_get('zz-taishoku-tameshi','pw', d + 100, d + 130)::jsonb->>'ok','') || '/' || coalesce(public.dk_kyuryo_get('zz-taishoku-tameshi','pw', d + 100, d + 130)::jsonb->>'reason','') from t;
insert into k select '5 辞めた・63日', coalesce(public.dk_kyuryo_get('zz-taishoku-tameshi','pw', d - 30, d + 33)::jsonb->>'ok','') || '/' || coalesce(public.dk_kyuryo_get('zz-taishoku-tameshi','pw', d - 30, d + 33)::jsonb->>'reason','') from t;
insert into k select '6 辞めた・61日', coalesce(public.dk_kyuryo_get('zz-taishoku-tameshi','pw', d - 30, d + 31)::jsonb->>'ok','') || '/' || coalesce(public.dk_kyuryo_get('zz-taishoku-tameshi','pw', d - 30, d + 31)::jsonb->>'reason','') from t;
select n, v from k order by n;
rollback;
