// ============================================================
// ★請求書アプリ(代行請求書)の meisai に入れる1行を作る★ 2026-08-05
//
//   ★なぜ切り出したか★
//     `distance` に 5.4 を入れていたが、請求書アプリの distance は★整数の列★。
//     Postgres に弾かれ、しかも Edge Function 側の catch が握り潰していたので、
//     ★自動投入を立てても黙って1件も入らなかった★（立てた当日に発覚）。
//     関数の中に埋まっていると外から試せないので、ここに出してテストから触れるようにする。
//
//   ★入れ先の列の型（本物のDBを見て写した・2026-08-05実測）★
//     この表とずれた値を作ったらテストが赤になる。
// ============================================================

// 実測: information_schema.columns（本番 tnfwipbgfgjaymlszeid）
const MEISAI_COLUMNS = {
  user_id: 'uuid',
  company: 'text',
  date: 'date',
  destination: 'text',
  amount: 'integer',
  note: 'text',
  distance: 'integer', // ★小数を入れると落ちる★
  people: 'integer',
  name: 'text',
  extra: 'jsonb',
};

// 業務開始の日（日本時間）— 給料・売上表と同じ切り方
function businessDate(shiftStartMs) {
  if (!shiftStartMs || !isFinite(shiftStartMs)) return null;
  const d = new Date(shiftStartMs + 9 * 60 * 60 * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
}

function refOf(deviceId, shiftStartMs, seq) {
  return `${deviceId}:${shiftStartMs}:${seq}`;
}

// trips は dk_trips に入れたのと同じ形。done は既に入っている dk_ref の集合。
function buildMeisaiRows(opts) {
  const ownerId = opts.ownerId;
  const deviceId = opts.deviceId;
  const shiftStart = opts.shiftStartMs;
  const trips = Array.isArray(opts.trips) ? opts.trips : [];
  const done = opts.done instanceof Set ? opts.done : new Set(opts.done || []);

  const date = businessDate(shiftStart);
  if (!date) return [];

  return trips
    .filter((t) => t && t.payment_type === 'invoice' && t.customer_name)
    .filter((t) => !done.has(refOf(deviceId, shiftStart, t.seq)))
    .map((t) => ({
      user_id: ownerId,
      company: String(t.customer_name || ''), // 請求先（companies.name と同じ文字列）
      date: date, // ★同じ晩は同じ日付★
      destination: String(t.end_address || ''),
      amount: typeof t.fare_yen === 'number' ? Math.round(t.fare_yen) : null, // メーター確定の料金
      // ★整数km★ 小数は入らない。消える端数は extra に実測mで残す。
      distance: typeof t.distance_m === 'number' ? Math.round(t.distance_m / 1000) : null,
      name: '',
      note: '',
      extra: {
        dk_ref: refOf(deviceId, shiftStart, t.seq), // 二重登録を防ぐ鍵
        dk_from: String(t.start_address || ''), // 出発地（標準の列に無い）
        dk_source: 'daikome',
        dk_distance_m: typeof t.distance_m === 'number' ? t.distance_m : null, // ★正確な距離★
      },
    }));
}

export { MEISAI_COLUMNS, businessDate, refOf, buildMeisaiRows };
