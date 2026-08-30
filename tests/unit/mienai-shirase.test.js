'use strict';
// ============================================================
// ★★「見えていなかった分」を 知らせる 線★★ 2026-08-30
//
//   ★どちらの物差しか★
//     ★これは 距離の採点では ありません★。★距離は 1mmも 変わりません★。
//     タクシー認定モードでも 代行モード（係数1.0085・検定対象外・DM Light基準）でも
//     ★同じ数を 出すだけ★です。
//
//   ★なぜ 要るか（2026-08-30・司さんの申告「300円ほど 少なく出た」）★
//     点が 10秒より 長く 来ないと、その間の 距離は 加算されません（過大ゼロの為・わざと）。
//     ★エラーも 出ず 合計だけ 小さくなる★＝うちの決まり
//     「#ERROR より『黙って 合計が 小さくなる』を 先に 潰せ」の 現物。
//     ⇒★直せない間も「落ちた事が 分かる」ようにする★（指示役 2026-08-30 の裁定）。
//
//   ★★線＝「落ちた m」では なく ★実際の 料金の差★で 引く★★
//     ★calcFare(距離 ＋ 見えなかった分) − calcFare(距離) が ★100円 以上★ の時だけ 出す★
//
//     ★なぜ m で 引かないか（★ここを 消さないでください★）★
//       ・料金は ★階段★（1000mまで1300円／以降 ★420mごと +100円★）
//       ・★「◯◯m 未満なら 変わらない」は 階段の 料金では 成り立ちません★
//         同じ 落ちた分でも ★元の距離が 段の どこに 居たか★で 変わります:
//           落ちた分 100m → 段を またぐ割合 ★24%★／200m → ★48%★／
//           400m → ★95%★／419m → ★100%★（2026-08-30 実測）
//       ・実際 0609-Android は ★257m しか 落ちていないのに ★100円★ 変わります★
//         ＝★420m の線だと この1本を 見逃していました★
//       ⇒★見積もらず、★料金の 式を 通して★ 判定する★
//
//   ★合計で 判定します（1回ずつでは ありません）★
//     0609-Android は 穴が 何回か 在り、★1回ずつ 見たら どれも 0円★。
//     知りたいのは「★この走行の 請求が いくら ずれたか★」なので ★合計が 正しい★。
//
//   ★見込みは 小さめに 取ります★
//     穴の 前後の 速度の ★小さい方★ × 秒数（js/pipeline-distance.js）。
//     ★実際に 落ちた分は もっと 多い事が 在ります★
//     （同じ穴を 位置の 弦で 数えると +515.9m＝2,826.0m。途中で 80km/h 出ていた）。
//     ⇒★少なめに 言う＝「思ったより 少なかった」で 済む★
//
//   ★2026-08-30 実測（実物4本・エンジンから 直接）★
//     0610-Android    4,921m ／ 1回 126秒 2,310m ／ 2,300円 → 2,800円 ＝★+500円★ ★出す★
//     0610b-Android  20,538m ／ 0回                          ＝    0円  出さない
//     しまなみ(OBD)  12,910m ／ 0回                          ＝    0円  出さない
//     0609-Android   23,912m ／ 1回  25秒   257m ／ 6,800円 → 6,900円 ＝★+100円★ ★出す★
//     ⇒★出る 2本／出ない 2本★（★出る組と 出ない組の 両方で 見ています★）
// ============================================================
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const mod = require(path.join(ROOT, 'js', 'pipeline-distance.js'));
const { createDistanceTracker } = mod;
const M = require(path.join(ROOT, 'js', 'meter.js'));

// ★司さんの 基本設定★（zeroact-memory/projects/daikome/memory.md）
const RYOKIN = {
  version: 2,
  base_fare: 1300,
  base_distance_m: 1000,
  add_fare: 100,
  add_distance_m: 420,
  tiers: [],
  surcharges: [],
  minFare: null,
  maxFare: null,
  rounding: 10,
};

const stubDec = {
  snapToNearestRoad() {
    return null;
  },
  getRoadsNear() {
    return [];
  },
  calcRoadDistance() {
    return null;
  },
  decodeRoadAt() {
    return null;
  },
};

// ★線★: 料金の差が これ以上なら 出す
const SEN_EN = 100;

function hashiru(f) {
  const p = path.join(ROOT, 'tests', 'fixtures', f);
  const d = JSON.parse(fs.readFileSync(p, 'utf8'));
  const arr = (d.samples || d.points || (Array.isArray(d) ? d : []))
    .slice()
    .sort((a, b) => (a.t || 0) - (b.t || 0));
  const tk = createDistanceTracker(stubDec, { useSnapCache: false, enableRouting: false });
  arr.forEach((s) => {
    if (!Number.isFinite(s.lat) || !Number.isFinite(s.lng) || !Number.isFinite(s.t)) return;
    const obdAri = s.obd != null && s.obd >= 0;
    tk.ingest({
      lat: s.lat,
      lng: s.lng,
      t: s.t,
      acc: s.acc == null ? 5 : s.acc,
      spd: obdAri ? s.obd / 3.6 : s.spd == null ? -1 : s.spd,
      synthetic: false,
      obd: obdAri,
    });
  });
  tk.flush();
  const m = tk.mienakattaBun();
  const kyori = tk.totalM();
  M.setFareConfig(RYOKIN);
  const ima = M.calcFare(kyori);
  const naoshitara = M.calcFare(kyori + m.meter);
  return { kyori: kyori, mienai: m, sa: naoshitara - ima, dasu: naoshitara - ima >= SEN_EN };
}

describe('★「見えていなかった分」を 知らせる 線★', () => {
  it('★料金の 式を 通して 判定している（自分で 割り算していない）★', () => {
    M.setFareConfig(RYOKIN);
    // 同じ「落ちた分」でも 元の距離の 位置で 料金差が 変わる事を 機械で 押さえる
    const ochi = 100;
    const chigau = new Set();
    for (let moto = 1000; moto < 1420; moto += 1) {
      chigau.add(M.calcFare(moto + ochi) - M.calcFare(moto));
    }
    expect(
      chigau.size,
      '★同じ 落ちた分なら 料金差も 同じ、に なっています★\n' +
        '  ＝料金が 階段でなくなった、か 計算式を 通していません'
    ).toBeGreaterThan(1);
    expect(chigau.has(0), '★100m 落ちても 変わらない場合が 在る（＝階段）★').toBe(true);
    expect(chigau.has(100), '★100m 落ちて 100円 変わる場合も 在る（＝階段）★').toBe(true);
  });

  it('★出る組と 出ない組の 両方で 見ている★', () => {
    const deru = ['0610-Android.json', 'realtrace-0609-Android-OBD.json'].map(hashiru);
    const denai = ['0610b-Android.json', 'realtrace-0618-shimanami-obd.json'].map(hashiru);
    deru.forEach((r, i) => {
      expect(r.dasu, '★出るはずの ' + i + ' 本目が 出ません★（差 ' + r.sa + '円）').toBe(true);
    });
    denai.forEach((r, i) => {
      expect(r.dasu, '★出ないはずの ' + i + ' 本目が 出ています★（差 ' + r.sa + '円）').toBe(false);
    });
  });

  it('★実測の 値が 変わっていない★（変わったら 気づける）', () => {
    expect(hashiru('0610-Android.json').sa).toBe(500);
    expect(hashiru('realtrace-0609-Android-OBD.json').sa).toBe(100);
    expect(hashiru('0610b-Android.json').sa).toBe(0);
    expect(hashiru('realtrace-0618-shimanami-obd.json').sa).toBe(0);
  });

  it('★何回 出しても 同じ答え★（昨日は 出たのに、を 起こさない）', () => {
    const s = new Set();
    for (let i = 0; i < 10; i++) s.add(hashiru('0610-Android.json').sa);
    expect(s.size, '★同じ走行なのに 答えが ' + s.size + ' 種類 出ました★').toBe(1);
  });

  it('★止まっていた穴では 出ない★（狼少年に しない）', () => {
    const r = hashiru('0610b-Android.json');
    expect(r.mienai.meter, '★止まっている穴で 距離を 見込んでいます★').toBe(0);
    expect(r.sa).toBe(0);
  });

  it('★見込みは 小さめ（穴の 前後の 速度の 小さい方）★', () => {
    const src = fs.readFileSync(path.join(ROOT, 'js', 'pipeline-distance.js'), 'utf8');
    expect(
      /Math\.min\(_mae, _ato\)/.test(src),
      '★小さい方を 使う書き方が 消えています★\n' +
        '  ＝多めに 見込むと「300円 損した」と 思わせて 実際は 100円、が 起きます'
    ).toBe(true);
  });
});
