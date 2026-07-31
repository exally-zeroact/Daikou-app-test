// supabase/functions/dk-sync-jobs
// ★メーターの実績(勤務・代行)を受け取って倉庫に入れる (2026-07-31)★
//   事務所機能(売上/請求/給料/集計)の入口。
//
//   入力(POST JSON): { url_token, device_id, shifts:[{ start_time, end_time, ..., trips:[...] }] }
//   出力: { ok:true, accepted:[start_time...] } | { ok:false, reason }
//
//   ▼設計の要点
//     ・会社は url_token で引く(ドライバー端末はログインを持たないため。dk-issue-license と同じ考え方)。
//     ・★その端末が本当にその会社の端末か(dk_company_devices)を必ず確認する★=よそからの書き込みを拒む。
//     ・同じ勤務を何度送られても増えない(冪等)。鍵 = (company_id, device_id, started_at)。
//     ・代行(trip)は勤務ごとに入れ直す(seq で一意)=送り直しで重複しない。
//     ・★未払い(status='off')でもデータは受け取る★。データを人質にしない(締めは別の層でやる)。
//     ・値は一切いじらない。メーターが確定した距離・料金をそのまま保存する。
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const MAX_SHIFTS = 50; // 1リクエストの勤務上限
const MAX_TRIPS = 300; // 勤務1件あたりの代行上限
const MAX_WAYPOINTS = 50;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' },
  });
}

function isNum(v: unknown): v is number {
  return typeof v === 'number' && isFinite(v);
}

function toIso(ms: unknown): string | null {
  if (!isNum(ms) || ms <= 0) return null;
  try {
    return new Date(ms).toISOString();
  } catch (_) {
    return null;
  }
}

function str(v: unknown): string {
  return typeof v === 'string' ? v.slice(0, 300) : '';
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      headers: {
        'access-control-allow-origin': '*',
        'access-control-allow-headers': 'content-type, authorization, apikey',
        'access-control-allow-methods': 'POST, OPTIONS',
      },
    });
  }
  if (req.method !== 'POST') return json({ ok: false, reason: 'method' }, 405);

  let input: { url_token?: string; device_id?: string; shifts?: unknown[] };
  try {
    input = await req.json();
  } catch {
    return json({ ok: false, reason: 'bad_json' }, 400);
  }

  const url_token = (input.url_token || '').trim();
  const device_id = (input.device_id || '').trim();
  const shifts = Array.isArray(input.shifts) ? input.shifts : [];
  if (!url_token || !device_id) return json({ ok: false, reason: 'missing' }, 400);
  if (!shifts.length) return json({ ok: true, accepted: [] });
  if (shifts.length > MAX_SHIFTS) return json({ ok: false, reason: 'too_many' }, 400);

  const sb = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  );

  // 会社を引く(service_role = RLSバイパス)
  const { data: co, error: coErr } = await sb
    .from('dk_companies')
    .select('company_id')
    .eq('url_token', url_token)
    .maybeSingle();
  if (coErr) return json({ ok: false, reason: 'db_error' }, 500);
  if (!co) return json({ ok: false, reason: 'invalid_url' }, 404);

  // ★その端末がこの会社の端末として登録されているかを確認(よそからの書き込みを拒む)★
  const { data: dev } = await sb
    .from('dk_company_devices')
    .select('device_id')
    .eq('company_id', co.company_id)
    .eq('device_id', device_id)
    .maybeSingle();
  if (!dev) return json({ ok: false, reason: 'unknown_device' }, 403);

  const accepted: number[] = [];

  for (const raw of shifts) {
    const s = raw as Record<string, unknown>;
    const startedAt = toIso(s?.start_time);
    if (!startedAt) continue; // 識別できない勤務は飛ばす(残りは処理する)

    try {
      // 勤務を入れる/更新する(冪等・鍵は company+device+開始時刻)
      const { data: shiftRow, error: sErr } = await sb
        .from('dk_shifts')
        .upsert(
          {
            company_id: co.company_id,
            device_id,
            started_at: startedAt,
            ended_at: toIso(s.end_time),
            elapsed_sec: isNum(s.elapsed_sec) ? Math.round(s.elapsed_sec) : null,
            total_distance_m: isNum(s.total_distance_m) ? s.total_distance_m : null,
            actual_total_m: isNum(s.actual_total_m) ? s.actual_total_m : null,
            empty_distance_m: isNum(s.empty_distance_m) ? s.empty_distance_m : null,
            fare_total_yen: isNum(s.fare_total_yen) ? Math.round(s.fare_total_yen) : null,
            trip_count: isNum(s.trip_count) ? Math.round(s.trip_count) : null,
          },
          { onConflict: 'company_id,device_id,started_at' }
        )
        .select('shift_id')
        .single();
      if (sErr || !shiftRow) continue;

      // 代行を入れ直す(送り直しでも重複しない)
      const rawTrips = Array.isArray(s.trips) ? (s.trips as Record<string, unknown>[]) : [];
      const trips = rawTrips
        .filter((t) => t && isNum(t.distance_m) && isNum(t.fare_yen))
        .slice(0, MAX_TRIPS)
        .map((t, i) => ({
          shift_id: shiftRow.shift_id,
          company_id: co.company_id,
          seq: isNum(t.seq) ? Math.round(t.seq) : i + 1,
          distance_m: t.distance_m as number, // ★そのまま★
          fare_yen: Math.round(t.fare_yen as number), // ★そのまま(円は整数)★
          // 掛け先(請求書払い)。変な支払区分は現金に倒す。
          customer_id: typeof t.customer_id === 'string' && t.customer_id ? t.customer_id : null,
          customer_name: str(t.customer_name),
          payment_type: t.customer_id && t.payment_type === 'invoice' ? 'invoice' : 'cash',
          started_at: toIso(t.start_time),
          ended_at: toIso(t.end_time),
          start_address: str(t.start_address),
          end_address: str(t.end_address),
          waypoints: Array.isArray(t.waypoints) ? t.waypoints.slice(0, MAX_WAYPOINTS) : [],
        }));

      // 同じ勤務の古い代行を消してから入れる = 件数が減る訂正にも追随できる
      await sb.from('dk_trips').delete().eq('shift_id', shiftRow.shift_id);
      if (trips.length) {
        const { error: tErr } = await sb.from('dk_trips').insert(trips);
        if (tErr) continue; // 代行が入らなかった勤務は「受け取った」と言わない=次回再送
      }

      accepted.push(s.start_time as number);
    } catch (_) {
      // この勤務は諦めて次へ(1件の失敗で全部を落とさない)
      continue;
    }
  }

  return json({ ok: true, accepted });
});
