-- ============================================================
-- supabase/apply-naoshi-rireki.sql
-- ★直しの履歴（⑦）＝請求・入金・明細・売上・給料の表を「誰が・いつ・何を・前→後」で積む★ 2026-11-08
--
--   ★当て方★ node scripts/apply-naoshi-rireki.mjs --ateru（この ファイルからは 関数の 塊だけ 切り出す。
--     表・決まり（RLS）・仕掛け（21表×3本）は 道具が 決まった 字で 書く＝ファイルの 字は 当てない）
--   ★決まり★
--     ・お金の 出方は 変えない（記録だけ）。★履歴を 読んで 勝ち負けや お金を 決める 物は 作らない★（uriage_at と 同じ＝表示だけ）
--     ・記録が 落ちても 客の 保存は 止めない（文に 1つの 例外の 区切り・落ちた 訳は dk_naoshi_rireki_ochi へ）
--     ・仕掛けは after … for each statement（行ごとに しない＝500件の 取り込みで 区切りが 500 に ならない）
--     ・主キーは pg_index から 取る（手で 書かない）。主キーを 書き換える 文は 外側で つなぎ D と I で 残す
--     ・誰：authenticated＝jimusho:<uid>（頭の x-dk-dare は 信じない）／service_role＝頭 x-dk-dare（device:/jimusho:/ai:）
--           無ければ kansu:service_role／anon＝fumei:anon／jwt 無し（postgres 直）＝chokusetsu:<session_user>
--     ・jsonb の 列（extra 等）は 変わった 時に 列ごと 前後を 写す
--   ★残らない 道（設計 v2 注3）★ 乗車ごとの 直しが 残るのは 請求書払いの 生きた 明細の 行だけ。
--     現金の 乗車・明細を 読めなかった 送り・事務所が 消した 行・合計が 同じに なる 直しは 乗車ごとには 残らない
--     （お金の 合計は dk_shifts.fare_total_yen で 残る）。dk_trips は 送り直しで 消して 入れ直す＝対象に しない。
-- ============================================================

create or replace function daikome.dk_naoshi_kiroku()
returns trigger
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_tbl text := tg_table_schema || '.' || tg_table_name;
  v_pk text[];
  v_claims jsonb;
  v_hdr jsonb;
  v_role text;
  v_shu text;
  v_dare text;
  v_uid uuid;
begin
  begin
    select array_agg(a.attname::text order by array_position(i.indkey::int2[], a.attnum))
      into v_pk
      from pg_catalog.pg_index i
      join pg_catalog.pg_attribute a on a.attrelid = i.indrelid and a.attnum = any (i.indkey)
     where i.indrelid = tg_relid and i.indisprimary;
    if v_pk is null then
      raise exception 'no primary key';
    end if;

    v_claims := nullif(current_setting('request.jwt.claims', true), '')::jsonb;
    v_hdr := nullif(current_setting('request.headers', true), '')::jsonb;
    v_role := coalesce(v_claims ->> 'role', '');
    v_uid := nullif(v_claims ->> 'sub', '')::uuid;
    if v_role = 'authenticated' then
      v_shu := 'jimusho';
      v_dare := 'jimusho:' || coalesce(v_uid::text, '?');
    elsif v_role = 'service_role' then
      v_dare := left(nullif(v_hdr ->> 'x-dk-dare', ''), 200);
      v_shu := split_part(coalesce(v_dare, ''), ':', 1);
      if v_dare is null or v_shu not in ('device', 'jimusho', 'ai') then
        v_shu := 'kansu';
        v_dare := 'kansu:service_role' || coalesce(' ' || v_dare, '');
      end if;
    elsif v_role = 'anon' then
      v_shu := 'fumei';
      v_dare := 'fumei:anon';
    else
      v_shu := 'chokusetsu';
      v_dare := 'chokusetsu:' || session_user;
    end if;

    if tg_op = 'INSERT' then
      insert into daikome.dk_naoshi_rireki
        (tbl, op, bun_op, pk, user_id, company_id, dare_shu, dare, auth_uid, kawatta, mae, ato)
      select v_tbl, 'I', tg_op, s.k,
             coalesce((s.j ->> 'user_id')::uuid,
               case when tg_table_name = 'dk_meisai_hazushi' then
                 (select mm.user_id from daikou.meisai mm where mm.id = (s.j ->> 'meisai_id')::uuid) end), (s.j ->> 'company_id')::uuid,
             v_shu, v_dare, v_uid, '{}'::text[], null,
             s.k || jsonb_strip_nulls(jsonb_build_object(
               'amount', s.j -> 'amount', 'paid', s.j -> 'paid', 'yen', s.j -> 'yen',
               'fare_total_yen', s.j -> 'fare_total_yen', 'uriage_yen', s.j -> 'uriage_yen',
               'sales_yen', s.j -> 'sales_yen', 'total', s.j -> 'total', 'seikyu_yen', s.j -> 'seikyu_yen'))
        from (select x.j, (select jsonb_object_agg(c, x.j -> c) from unnest(v_pk) c) k
                from (select to_jsonb(n) j from naoshi_ato n) x) s;
    elsif tg_op = 'DELETE' then
      insert into daikome.dk_naoshi_rireki
        (tbl, op, bun_op, pk, user_id, company_id, dare_shu, dare, auth_uid, kawatta, mae, ato)
      select v_tbl, 'D', tg_op, s.k,
             coalesce((s.j ->> 'user_id')::uuid,
               case when tg_table_name = 'dk_meisai_hazushi' then
                 (select mm.user_id from daikou.meisai mm where mm.id = (s.j ->> 'meisai_id')::uuid) end), (s.j ->> 'company_id')::uuid,
             v_shu, v_dare, v_uid, '{}'::text[], s.j, null
        from (select x.j, (select jsonb_object_agg(c, x.j -> c) from unnest(v_pk) c) k
                from (select to_jsonb(o) j from naoshi_mae o) x) s;
    else
      insert into daikome.dk_naoshi_rireki
        (tbl, op, bun_op, pk, user_id, company_id, dare_shu, dare, auth_uid, kawatta, mae, ato)
      select v_tbl,
             case when m.j is null then 'I' when a.j is null then 'D' else 'U' end,
             tg_op,
             coalesce(a.k, m.k),
             coalesce((coalesce(a.j, m.j) ->> 'user_id')::uuid,
               case when tg_table_name = 'dk_meisai_hazushi' then
                 (select mm.user_id from daikou.meisai mm where mm.id = (coalesce(a.j, m.j) ->> 'meisai_id')::uuid) end),
             (coalesce(a.j, m.j) ->> 'company_id')::uuid,
             v_shu, v_dare, v_uid,
             case when m.j is null or a.j is null then array['★主キー替え'] else d.keys end,
             case when a.j is null then m.j when m.j is null then null else d.mae end,
             case when m.j is null then a.j when a.j is null then null else d.ato end
        from (select x.j, (select jsonb_object_agg(c, x.j -> c) from unnest(v_pk) c) k
                from (select to_jsonb(o) j from naoshi_mae o) x) m
        full join (select x.j, (select jsonb_object_agg(c, x.j -> c) from unnest(v_pk) c) k
                     from (select to_jsonb(n) j from naoshi_ato n) x) a on a.k = m.k
        left join lateral (
               select array_agg(e.key order by e.key) keys,
                      jsonb_object_agg(e.key, m.j -> e.key) mae,
                      jsonb_object_agg(e.key, e.value) ato
                 from jsonb_each(a.j) e
                where m.j is not null and (m.j -> e.key) is distinct from e.value) d on true
       where m.j is null or a.j is null or d.keys is not null;
    end if;

  exception when others then
    begin
      insert into daikome.dk_naoshi_rireki_ochi (tbl, err)
      values (v_tbl, left(sqlstate || ' ' || sqlerrm, 300));
    exception when others then
      raise warning 'dk_naoshi_kiroku: %', sqlstate;
    end;
  end;
  return null;
end;
$fn$;
