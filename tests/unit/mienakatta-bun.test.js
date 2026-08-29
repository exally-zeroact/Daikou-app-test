'use strict';
// ============================================================
// ★★「見えていなかった間」を 数えている事を 機械で 縛る★★ 2026-08-30
//
//   ★どちらの物差しか★
//     ★これは 距離の採点では ありません★。距離は ★1mmも 変わりません★。
//     タクシー認定モードでも 代行モード（係数1.0085・検定対象外・DM Light基準）でも
//     ★同じ数を 出すだけ★の 記録係です。
//
//   ★なぜ 要るか（2026-08-30・司さんの申告）★
//     従業員「こないだ いつもより 距離も 金額も 少なく出た」＝★300円ほど★。
//     420m刻み×3段 ＝ ★約1,260m★。
//     実測すると、アプリに 点が 1つも 来ない時間が ★60秒★ あると
//     72km/h で ★約1,208m（＝ちょうど300円）★ が 消えます。
//     ところが ★捨てた事を 誰も 数えていませんでした★（stats に 1つも 無かった）
//     ＝★エラーも 出ず 合計だけ 小さくなる★＝うちの決まり
//       「#ERROR より『黙って 合計が 小さくなる』を 先に潰せ」の 現物。
//
//   ★これで 何が 変わるか★
//     門（gate-bg-freeze-nagaana / gate-obd-mienai）は ★試験の中で 落ちたか★しか 見えません。
//     この数は ★実機の 走行で 落ちたか★が 見えます。★直さなくても 分かるように なります★。
//
//   ★距離は 触っていません（実測）★
//     実物の fixture ★68本（fixture×モード）★で 足す前と 後の distance_m を 突き合わせ、
//     ★1本も 変わっていない★事を 確かめてから 入れました。
// ============================================================
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const mod = require(path.join(ROOT, 'js', 'pipeline-distance.js'));
const { createDistanceTracker } = mod;

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

const LAT = 34.0;
const SPD = 20.0; // m/s = 72km/h
// ★エンジンと 同じ物差しで 作る★（EARTH_R=6371000 の まん丸の地球）
//   ここを 間違えると 自分の換算ミスを エンジンのせいに します（2026-08-30 に 実際に やった）
const M_PER_DEG_LNG = (Math.PI / 180) * 6371000 * Math.cos((LAT * Math.PI) / 180);
const LNG_PER_M = 1 / M_PER_DEG_LNG;

function hashiru(anaSec) {
  const tk = createDistanceTracker(stubDec, { useSnapCache: false, enableRouting: false });
  const T0 = 1700000000000;
  let susunda = 0;
  for (let s = 0; s <= 1000; s++) {
    if (anaSec > 0 && s > 300 && s < 300 + anaSec) {
      susunda += SPD; // ★車は 走っている（点だけ 来ない）★
      continue;
    }
    tk.ingest({
      lat: LAT,
      lng: 133.0 + LNG_PER_M * susunda,
      t: T0 + s * 1000,
      acc: 5,
      spd: SPD,
      synthetic: false,
      obd: true,
    });
    susunda += SPD;
  }
  tk.flush();
  return { total: tk.totalM(), mienai: tk.mienakattaBun() };
}

describe('★「見えていなかった間」を 数えている★', () => {
  it('★出口が 在る★（外されたら ここが 赤）', () => {
    const tk = createDistanceTracker(stubDec, { useSnapCache: false, enableRouting: false });
    expect(
      typeof tk.mienakattaBun,
      '★mienakattaBun が 無くなっています★\n' +
        '  ＝落ちた事を 外から 見られない状態に 戻っています（黙って 小さくなる）'
    ).toBe('function');
  });

  it('★穴が 無い時は 0★（普段は 何も 出さない）', () => {
    const r = hashiru(0);
    expect(r.mienai).toEqual({ kaisuu: 0, byou: 0, meter: 0 });
  });

  it('★10秒の 内側（9秒）は 0★（捨てていないので 数えない）', () => {
    const r = hashiru(9);
    expect(r.mienai.kaisuu, '9秒は 捨てていないのに 数えています').toBe(0);
  });

  it('★10秒を 超えたら 数える（秒数と メートルが 合っている）★', () => {
    [11, 30, 60, 120].forEach((a) => {
      const r = hashiru(a);
      expect(r.mienai.kaisuu, a + '秒の穴を 数えていません').toBe(1);
      expect(r.mienai.byou, a + '秒の穴の 秒数が 合っていません').toBeCloseTo(a, 1);
      // その間に 走ったはずの 距離 = 速度 × 秒数
      expect(r.mienai.meter, a + '秒の穴の メートルが 合っていません').toBeCloseTo(SPD * a, 0);
    });
  });

  it('★数えた分だけ 距離が 足りない（数と 実害が 一致している）★', () => {
    const soko = hashiru(0).total;
    [11, 30, 60].forEach((a) => {
      const r = hashiru(a);
      const tarinai = soko - r.total; // 実際に 足りない分
      expect(
        Math.abs(tarinai - r.mienai.meter),
        a +
          '秒: 数えた ' +
          r.mienai.meter +
          'm と 実際に 足りない ' +
          tarinai.toFixed(1) +
          'm が 合いません\n' +
          '  ＝数だけ 出して 実害と ずれていたら、読む人を 惑わせます'
      ).toBeLessThan(15);
    });
  });

  it('★60秒 見えないと 約1,200m＝約300円★（司さんの申告と 同じ桁である事）', () => {
    const r = hashiru(60);
    expect(r.mienai.meter).toBeGreaterThan(1100);
    expect(r.mienai.meter).toBeLessThan(1300);
    // 料金は 420m ごとに 100円（1000m以下は 1,300円）
    const en = Math.floor(r.mienai.meter / 420) * 100;
    expect(en, '60秒ぶんが 300円の 桁に なっていません').toBeGreaterThanOrEqual(200);
  });
});
