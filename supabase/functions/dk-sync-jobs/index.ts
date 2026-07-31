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

  // 会社を引く(service_role = RLSバイパス)。owner_id は請求書アプリへの橋渡しに使う。
  const { data: co, error: coErr } = await sb
    .from('dk_companies')
    .select('company_id, owner_id')
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

      // ★請求書アプリ(代行請求書)の明細に流し込む (2026-08-01・司さん承認)★
      //   請求書払いの代行だけ。会社を選ばなかった代行(現金)は入れない。
      //   ・重複しない鍵 dk_ref = 端末:勤務開始:何件目 (再送で trip_id が変わっても変わらない)
      //   ・★既に入っている行には一切触らない★=事務所が後から書いた備考/人数を絶対に消さない
      //   ・失敗しても勤務の受け取りは取り消さない(明細は次回の再送で入る)
      await pushToInvoiceApp(sb, co.owner_id as string | null, device_id, s, trips);

      accepted.push(s.start_time as number);
    } catch (_) {
      // この勤務は諦めて次へ(1件の失敗で全部を落とさない)
      continue;
    }
  }

  return json({ ok: true, accepted });
});

// 代行請求書アプリの `meisai` に、請求書払いの代行を1件1行で入れる。
//   meisai の列: company(会社名) / date / destination(行き先) / amount(金額) / distance(距離) /
//                name(名前) / note(備考) / people(人数) / extra(jsonb・自由項目)
//   ★extra.dk_ref に安定した鍵を入れて二重登録を防ぐ★
async function pushToInvoiceApp(
  sb: ReturnType<typeof createClient>,
  ownerId: string | null,
  deviceId: string,
  shift: Record<string, unknown>,
  trips: Record<string, unknown>[]
): Promise<void> {
  try {
    // ★★既定オフ (2026-08-01)★★
    //   代行請求書アプリは既に実務で使われていて、明細が1000件超入っている。
    //   司さんは今そこへ「手入力」している。自動投入を同時に走らせると★二重になる★。
    //   よって Edge Function secret `DK_MEISAI_AUTOPUSH=1` を明示的に立てるまで何もしない。
    //   (手入力から自動に切り替える、と決めた時に立てる)
    if (Deno.env.get('DK_MEISAI_AUTOPUSH') !== '1') return;

    if (!ownerId) return; // 会社がまだアカウント登録していない = 請求書アプリ側に置き場が無い
    const invoiceTrips = trips.filter((t) => t.payment_type === 'invoice' && t.customer_name);
    if (!invoiceTrips.length) return;

    const shiftStart = isNum(shift.start_time) ? shift.start_time : 0;
    const refOf = (t: Record<string, unknown>) => `${deviceId}:${shiftStart}:${t.seq}`;
    const refs = invoiceTrips.map(refOf);

    // 既に入っている分を調べる(入っている行には触らない)
    const { data: exist } = await sb
      .from('meisai')
      .select('extra')
      .eq('user_id', ownerId)
      .in('extra->>dk_ref', refs);
    const done = new Set(
      (exist || [])
        .map((r: Record<string, unknown>) => {
          const e = r.extra as Record<string, unknown> | null;
          return e && typeof e.dk_ref === 'string' ? e.dk_ref : null;
        })
        .filter(Boolean) as string[]
    );

    const rows = invoiceTrips
      .filter((t) => !done.has(refOf(t)))
      .map((t) => {
        const started = t.started_at ? String(t.started_at) : null;
        return {
          user_id: ownerId,
          company: String(t.customer_name || ''), // 請求先(companies.name と同じ文字列)
          date: started ? started.slice(0, 10) : null, // YYYY-MM-DD
          destination: String(t.end_address || ''), // 行き先 = 到着地
          amount: t.fare_yen, // ★メーター確定の料金をそのまま★
          distance:
            typeof t.distance_m === 'number' ? Math.round((t.distance_m / 1000) * 10) / 10 : null, // km(小数1桁)
          name: '',
          note: '',
          extra: {
            dk_ref: refOf(t), // ★二重登録を防ぐ鍵★
            dk_from: String(t.start_address || ''), // 出発地(請求書アプリの標準列に無いので自由項目へ)
            dk_source: 'daikome',
          },
        };
      });
    if (!rows.length) return;
    await sb.from('meisai').insert(rows);
  } catch (_) {
    // 請求書側で何が起きても、ダイコメの実績受け取りは止めない
  }
}
