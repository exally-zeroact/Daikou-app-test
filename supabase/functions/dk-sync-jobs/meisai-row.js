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

// ============================================================
// ★直した代行を請求書アプリにも届ける★ 2026-08-05
//
//   司さん「その業務押したら追加料金や値引きや請求書などちゃんと編集できな」
//   メーターの履歴で金額や請求先を直すと、その業務は送り直される。
//   ところが★既に入っている行は飛ばす★作りだったので、
//   ★請求書アプリだけ古い金額のまま残る★。それを塞ぐ。
//
//   ▼直す時に触る列は限る
//     金額 / 距離 / 請求先 / 日付 / 行き先 だけ。
//     ★備考(note)・人数(people)・名前(name) は司さんが後から書いた物なので絶対に触らない★
//   ▼中身が同じなら何もしない（無駄な書き込みをしない）
// ============================================================
const UPDATABLE = ['company', 'date', 'destination', 'amount', 'distance'];

// rows = これから入れたい行 / existing = 既に入っている行 [{id, extra, company, date, ...}]
function planMeisaiWrite(rows, existing) {
  const byRef = new Map();
  (Array.isArray(existing) ? existing : []).forEach((e) => {
    const ref = e && e.extra && e.extra.dk_ref;
    if (ref) byRef.set(String(ref), e);
  });

  const inserts = [];
  const updates = [];
  (Array.isArray(rows) ? rows : []).forEach((r) => {
    const cur = byRef.get(String(r.extra.dk_ref));
    if (!cur) return inserts.push(r);
    const patch = {};
    UPDATABLE.forEach((c) => {
      const a = cur[c] === undefined ? null : cur[c];
      const b = r[c] === undefined ? null : r[c];
      if (String(a) !== String(b)) patch[c] = b;
    });
    // 正確な距離も更新する（extra は自分の物なので、司さんの書いた列とは別）
    const curM = cur.extra ? cur.extra.dk_distance_m : undefined;
    if (String(curM === undefined ? null : curM) !== String(r.extra.dk_distance_m)) {
      patch.extra = Object.assign({}, cur.extra, { dk_distance_m: r.extra.dk_distance_m });
    }
    if (Object.keys(patch).length) updates.push({ id: cur.id, patch: patch });
  });
  return { inserts, updates };
}

export { MEISAI_COLUMNS, businessDate, refOf, buildMeisaiRows, planMeisaiWrite, UPDATABLE };
