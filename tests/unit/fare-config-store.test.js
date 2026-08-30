'use strict';
// ============================================================
// ★★料金表の 引っ越し（Firebase → Supabase）の 見張り★★ 2026-08-30
//
//   ★司さんの指示★「全部Supabaseに引越ししたろが」「★Firebaseは2度と使うな★」「引っ越しもしろよ」
//
//   ★どちらの物差しか★
//     ★距離の採点では ありません★。距離には 1文字も 触りません。
//     ★お金（料金）そのもの★を 見ます: ★引っ越しの 前後で 1円も 変わらない事★。
//
//   ★ここで 見る事★
//     ①★Firebase を 1行も 呼んでいない★（司さんの「2度と使うな」）
//     ②★787通りの 距離で 料金が 1円も 変わらない★（前の値と 新しい置き場の 既定が 同じ）
//     ③★足りない所を 埋めても 在る値は 書き換えない★（勝手に 料金を 変えない）
//     ④★倉庫に 無い会社でも 空にしない★（既定を 返す）
//     ⑤★変えた記録が 残る／戻せる★（前は 上書き1件だけで 戻せなかった）
//
//   ★既定の値は 2026-08-30 に 引っ越し元から 読んだ 実物と 同じ★
//     base_fare 1300 ／ base_distance_m 1000 ／ add_fare 100 ／ add_distance_m 420
//     rounding 1 ／ version 2 ／ 夜間・週末・冬・待ち＝全部 OFF
// ============================================================
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const P = path.join(ROOT, 'js', 'fare-config-store.js');
const S = require(P);
const M = require(path.join(ROOT, 'js', 'meter.js'));

// ★2026-08-30 に 引っ越し元から 読んだ 実物★（この値から 1円も 動かさない）
const HIKKOSHI_MOTO = {
  version: 2,
  base_fare: 1300,
  base_distance_m: 1000,
  add_fare: 100,
  add_distance_m: 420,
  rounding: 1,
  tiersEnabled: false,
  vehiclesEnabled: false,
  zonesEnabled: false,
  autoSurcharges: {
    night: { enabled: false, from: 22, to: 5, rate: 1.2 },
    weekend: { enabled: false, rate: 1.1 },
    winter: { enabled: false, from: '12-15', to: '03-15', rate: 1.1 },
  },
  wait: { enabled: false, freeMins: 5, ratePerMin: 100 },
};

describe('★料金表の 引っ越し（Firebase → Supabase）★', () => {
  it('★① Firebase を 1行も 呼んでいない★（司さん 2026-08-30「2度と使うな」）', () => {
    const src = fs.readFileSync(P, 'utf8');
    // ★注記の中の「Firebase」は 説明。★呼ぶ書き方★が 無い事を 見る
    ['firebase.', 'getDb(', 'db.ref(', 'firebaseio', 'firebasedatabase'].forEach((w) => {
      expect(src.includes(w), '★Firebase を 呼ぶ書き方が 入っています: ' + w + '★').toBe(false);
    });
  });

  it('★② 787通りの 距離で 料金が 1円も 変わらない★', () => {
    const mae = HIKKOSHI_MOTO;
    const ato = S.totonoeru(null); // ★倉庫が 空の時に 使う 既定★
    let chigau = 0;
    let mita = 0;
    for (let m = 0; m <= 39300; m += 50) {
      M.setFareConfig(mae);
      const a = M.calcFare(m);
      M.setFareConfig(ato);
      const b = M.calcFare(m);
      mita++;
      if (a !== b) chigau++;
    }
    expect(mita, '★何通り 見たかを 数える（0通りなら 何も 見ていない）★').toBe(787);
    expect(chigau, '★料金が 変わった 距離が ' + chigau + ' 通り あります★').toBe(0);
  });

  it('★③ 在る値は 書き換えない（足りない所だけ 埋める）★', () => {
    const r = S.totonoeru({ base_fare: 1500, add_distance_m: 500 });
    expect(r.base_fare, '★入っていた値を 書き換えています★').toBe(1500);
    expect(r.add_distance_m).toBe(500);
    // 足りない所は 既定で 埋まる
    expect(r.base_distance_m).toBe(1000);
    expect(r.add_fare).toBe(100);
    expect(r.wait.enabled).toBe(false);
  });

  it('★④ 倉庫に 無い会社でも 空に しない（既定を 返す）★', async () => {
    const before = global.window;
    global.window = {}; // 倉庫に つながっていない
    try {
      delete require.cache[require.resolve(P)];
      // eslint-disable-next-line global-require
      const S2 = require(P);
      const r = await S2.yomu('dummy-company');
      expect(r.config.base_fare, '★空を 返しています★').toBe(1300);
      expect(r.moto).toBe('kitei');
    } finally {
      global.window = before;
      delete require.cache[require.resolve(P)];
    }
  });

  it('★⑤ 変えた記録が 残り、戻せる★（前は 上書き1件だけで 戻せなかった）', async () => {
    // ★字を 見るだけでは 弱い★（棚の 名前を 変えても 気づけなかった・2026-08-30 実測）
    //   ⇒★偽の 倉庫を 用意して「どの棚に 何を 書いたか」を 実際に 数えます★
    const kaita = [];
    const nise = {
      from(tana) {
        return {
          select() {
            // ★本物と 同じ つなぎ方に する★（.eq() の 後に .maybeSingle() も .order() も 来る）
            const tsugi = {
              maybeSingle: async () => ({ data: null }),
              order() {
                return { limit: async () => ({ data: [{ before_config: { base_fare: 1200 } }] }) };
              },
            };
            return { eq: () => tsugi, order: tsugi.order };
          },
          async upsert(row) {
            kaita.push({ tana: tana, kind: 'upsert', row: row });
            return {};
          },
          async insert(row) {
            kaita.push({ tana: tana, kind: 'insert', row: row });
            return {};
          },
        };
      },
    };
    const before = global.window;
    global.window = { DKSupabase: nise };
    try {
      delete require.cache[require.resolve(P)];
      // eslint-disable-next-line global-require
      const S2 = require(P);
      await S2.kaku('c1', { base_fare: 1500 }, 'a@example.com');
      const honntai = kaita.filter((x) => x.tana === 'dk_fare_config');
      const kiroku = kaita.filter((x) => x.tana === 'dk_fare_config_history');
      expect(honntai.length, '★料金表を 保存していません★').toBe(1);
      expect(kiroku.length, '★変えた記録を 残していません★（棚の名前が 違うかも）').toBe(1);
      expect(kiroku[0].row.after_config.base_fare).toBe(1500);
      expect(kiroku[0].row.changed_by).toBe('a@example.com');
      expect(kiroku[0].row.is_revert).toBe(false);

      // ★戻すと 1件 増え、戻した印が 付く★
      kaita.length = 0;
      await S2.modosu('c1', 'b@example.com');
      const k2 = kaita.filter((x) => x.tana === 'dk_fare_config_history');
      expect(k2.length, '★戻した事を 記録していません★').toBe(1);
      expect(k2[0].row.is_revert, '★戻した印が 付いていません★').toBe(true);
      expect(k2[0].row.after_config.base_fare, '★1つ前に 戻っていません★').toBe(1200);
    } finally {
      global.window = before;
      delete require.cache[require.resolve(P)];
    }
  });

  it('★⑥ 棚の 作り方（SQL）も repo に 在る★（口約束に しない）', () => {
    const sql = path.join(ROOT, 'supabase', 'dk_fare_config.sql');
    expect(fs.existsSync(sql), '★棚を 作る SQL が ありません★').toBe(true);
    const s = fs.readFileSync(sql, 'utf8');
    expect(s).toContain('dk_fare_config');
    expect(s).toContain('dk_fare_config_history');
    expect(s, '★鍵(RLS)を 掛けていません★').toContain('row level security');
  });
});
