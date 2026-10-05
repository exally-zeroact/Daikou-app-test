-- ============================================================
-- ★★請求書の 額を 車ごとに 打てる ように する★★ 2026-10-06
--
--   ★司さん★「売り上げから請求書アプリに入ってるその日の金額を引く」
--             「2は両方に対応しろ」（請求書アプリの 額 と 入力画面で 打つ 額の 両方）
--   ★Excel（代行計算表2026）★ 入力シートに 車ごとの 請求書の 欄が 在る。
--     請求書が 下げるのは ★現金だけ★（現金 ＝ 売上 − 請求書 − 電子決済）。
--     ★売上合計も 給料も 下げない★（司さん 10-06「1A」＝給料は 引かない）。
--
--   ★足す 列★ seikyu_yen（その 回／その 日の その 車の 請求書の 額）
--     ・dk_shift_edits … メーターで 走った 車（1回の 業務ごと）
--     ・dk_manual_days … メーターの 無い 車（会社×日×車）
--     ★expenses には 入れない★（expenses は 売上から 引かれる＝給料が 下がる）
--
--   ★窓（public の view）は 列を 最後に 足す★（create or replace は 末尾に 足すのだけ 許される）
--     本番の 今の 並び（2026-10-06 実測 information_schema）：
--       dk_shift_edits … shift_id,company_id,toll_yen,bridge_yen,other_yen,other_label,note,
--                        updated_at,hours,expenses,denshi_yen
--       dk_manual_days … company_id,work_date,device_id,sales_yen,hours,toll_yen,bridge_yen,
--                        other_yen,trip_count,note,updated_at,expenses,denshi_yen
--     ★dk_manual_days は apply-tebiki-kyori.sql（距離 2列）を 先に 当てる★（この ファイルは その 後ろに 足す）
--   ★security_invoker は 付け直す★／★何度 流しても 同じ★
-- ============================================================

alter table daikome.dk_shift_edits
  add column if not exists seikyu_yen integer;

alter table daikome.dk_manual_days
  add column if not exists seikyu_yen integer;

create or replace view public.dk_shift_edits as
select
  shift_id,
  company_id,
  toll_yen,
  bridge_yen,
  other_yen,
  other_label,
  note,
  updated_at,
  hours,
  expenses,
  denshi_yen,
  seikyu_yen
from daikome.dk_shift_edits;

alter view public.dk_shift_edits set (security_invoker = true);

create or replace view public.dk_manual_days as
select
  company_id,
  work_date,
  device_id,
  sales_yen,
  hours,
  toll_yen,
  bridge_yen,
  other_yen,
  trip_count,
  note,
  updated_at,
  expenses,
  denshi_yen,
  actual_total_m,
  total_distance_m,
  seikyu_yen
from daikome.dk_manual_days;

alter view public.dk_manual_days set (security_invoker = true);
