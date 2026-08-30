'use strict';
// ============================================================
// ★★穴を 直線で 埋める時の ガード★★ 2026-08-30（指示役の指摘で 追加）
//
//   ★どちらの物差しか★
//     ★お金（距離）そのもの★を 見ます。上（多すぎ）を 止める門です。
//     タクシー認定モードでも 代行モード（係数1.0085・検定対象外・DM Light基準）でも
//     ★走っていない分を 足すのは おかしい★＝物差しを 選びません。
//
//   ★★なぜ この門が 要るか（指示役の指摘・2026-08-30）★★
//     穴を 直線で 埋める時、★天井の式にも 同じ直線を 足しています★（片側だけ 緩めない為）。
//     ⇒★両側で 相殺されるので、天井の門は「直線が 正しいか」を ★1度も 見ません★★
//     ⇒★GPS が 飛んでも 誰も 止められません★（都市部・トンネル出口の マルチパス）
//     ⇒★だから ここで 見ます★
//
//   ★見る事 2つ★
//     ①★長すぎる 途切れは 埋めない★（3分）
//     ②★速すぎる（＝位置が 飛んだ）物は 埋めない★（110km/h）
//     ★どちらも 境目の 両側で 測ります★
//
//   ★110km/h の 根拠（実測 2026-08-30）★
//     ・8月の 実車 277本の ★平均速度★ … 真ん中 20.8km/h ／ 上位1% 42.9 ／ ★最速 45.6★
//     ・車が 出した ★瞬間の 最速★（OBDの 生値・手元の 走行 全部）… ★96 km/h★
//     ⇒★穴の間の「平均」が 瞬間の最速を 超える事は 物理的に 有り得ない★ので
//       ★96 の 上＝110km/h★ に 置く。
//   ★3分の 根拠（実測）★
//     ・実車中の 途切れ … 10-30秒 23回／30-60秒 5回／1-3分 10回／3-10分 2回／★10分超 9回★
//     ・一番 危ないの ★22.5分・直線2,540m・平均6.8km/h＝ほぼ停車★（走ったのでは ない）
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
// ★エンジンと 同じ物差しで 作る★（EARTH_R=6371000 の まん丸の地球）
const M_PER_DEG_LNG = (Math.PI / 180) * 6371000 * Math.cos((LAT * Math.PI) / 180);
const LNG_PER_M = 1 / M_PER_DEG_LNG;
const T0 = 1700000000000;

// 穴を anaSec 秒 開けて、その間に susundaM メートル 位置が 進む走行
function hashiru(anaSec, susundaM) {
  const tk = createDistanceTracker(stubDec, { useSnapCache: false, enableRouting: false });
  tk.ingest({ lat: LAT, lng: 133.0, t: T0, acc: 5, spd: 20, synthetic: false, obd: true });
  tk.ingest({
    lat: LAT,
    lng: 133.0 + LNG_PER_M * 20,
    t: T0 + 1000,
    acc: 5,
    spd: 20,
    synthetic: false,
    obd: true,
  });
  const mae = tk.totalM();
  tk.ingest({
    lat: LAT,
    lng: 133.0 + LNG_PER_M * (20 + susundaM),
    t: T0 + 1000 + anaSec * 1000,
    acc: 5,
    spd: 20,
    synthetic: false,
    obd: true,
  });
  tk.flush();
  return { mae: mae, total: tk.totalM(), umeta: tk.totalM() - mae };
}

describe('★穴を 直線で 埋める時の ガード★', () => {
  it('★普通の 途切れは 埋める★（2分・80km/h ぶん）', () => {
    const r = hashiru(126, 2826);
    expect(r.umeta, '★埋めていません★').toBeGreaterThan(2700);
  });

  it('★長すぎる 途切れは 埋めない（3分の 境目・両側）★', () => {
    const uchi = hashiru(180, 2000); // ちょうど 3分 … 埋める
    const soto = hashiru(181, 2000); // 3分＋1秒 … 埋めない
    expect(uchi.umeta, '★3分ちょうどで 埋めていません★').toBeGreaterThan(1900);
    expect(soto.umeta, '★3分を 超えたのに 埋めています★').toBeLessThan(30);
  });

  it('★★速すぎる（＝位置が 飛んだ）物は 埋めない（110km/h の 境目・両側）★★', () => {
    // 60秒の 穴。110km/h ＝ 1,833m
    const uchi = hashiru(60, 1800); // 108 km/h … 埋める
    const soto = hashiru(60, 1900); // 114 km/h … ★埋めない★
    expect(uchi.umeta, '★110km/h の 内側なのに 埋めていません★').toBeGreaterThan(1700);
    expect(
      soto.umeta,
      '★110km/h を 超えているのに 埋めています★\n' +
        '  ＝GPS が 飛んだ時に 客へ 多く 請求します（天井の門は 相殺されて 気づけません）'
    ).toBeLessThan(30);
  });

  it('★GPS が 大きく 飛んだ時（25km）は 1mも 埋めない★', () => {
    const r = hashiru(60, 25000); // 60秒で 25km ＝ 1,500km/h
    expect(r.umeta, '★飛んだ位置を 足しています★').toBeLessThan(30);
  });

  it('★止まっていたら 0m（前後が 同じ場所）★', () => {
    const r = hashiru(120, 0);
    expect(r.umeta).toBeLessThan(30);
  });

  it('★捨てた分を 数えている（黙って 落とさない）★', () => {
    const src = require('fs').readFileSync(path.join(ROOT, 'js', 'pipeline-distance.js'), 'utf8');
    ['anaTooLongM', 'anaTooFastM', 'anaChordSkippedM'].forEach((k) => {
      expect(src.includes(k), '★' + k + ' を 数えていません★').toBe(true);
    });
  });

  it('★天井の式にも 同じ ガードが 掛かっている（片側だけに しない）★', () => {
    const p = path.join(ROOT, 'tests', 'integration', 'obd-main-distance-engine.test.js');
    const src = require('fs').readFileSync(p, 'utf8');
    expect(src.includes('(110 / 3.6) * dt'), '★天井の 速さの 上限が 違います★').toBe(true);
    expect(/dt > 180/.test(src), '★天井の 時間の 上限が ありません★').toBe(true);
  });
});
