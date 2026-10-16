'use strict';
// ============================================================
// ★店データ（poi-update）と 道（osm-update）の 定時は ずらす★ 2026-10-16
//   同じ 時刻だと 2本が 約11分 差で 始まる（本番の 9-01・10-01 実測）。poi の push が osm の checkout の 後に 入ると、
//   osm の push（やり直し 無し）が 拒否されて 道の データが 1か月 古い まま 残る（対立役 W-b・指示役）。
//   poi は 長い 月で 19分、見張り・書き継ぎ・積み直しの 見張りで 約7分 延びる＝30分 程度。
//   ★見る 事★ 同じ 日で、osm は poi より 2時間 以上 後（同じ 日で ない なら 日の 差で 足りる）。
//   ★わざと壊して 赤に なった 記録（2026-10-16）★：osm を '0 18 1 * *' に 戻す→1本 赤
// ============================================================
const fs = require('fs');
const path = require('path');

const WF = path.resolve(__dirname, '..', '..', '.github', 'workflows');
function teiji(f) {
  const y = fs.readFileSync(path.join(WF, f), 'utf8');
  const m = /- cron: '([^']+)'/.exec(y);
  if (!m) return null;
  const [mi, h, d, mo, w] = m[1].trim().split(/\s+/);
  return { mi: Number(mi), h: Number(h), d, mo, w };
}

describe('★店データと 道の 定時は ずらす★', () => {
  it('osm-update は poi-update より 2時間 以上 後に 始まる', () => {
    const poi = teiji('poi-update.yml');
    const osm = teiji('osm-update.yml');
    expect(poi, 'poi-update の 定時が 読めない').toBeTruthy();
    expect(osm, 'osm-update の 定時が 読めない').toBeTruthy();
    expect(Number.isFinite(poi.h) && Number.isFinite(osm.h), '時が 数で ない（* や 範囲）').toBe(
      true
    );
    if (poi.d === osm.d) {
      const sa = osm.h * 60 + osm.mi - (poi.h * 60 + poi.mi);
      expect(sa, '★osm が poi と 近すぎる（分）★').toBeGreaterThanOrEqual(120);
    } else {
      expect(Number(osm.d), '★osm が poi より 前の 日★').toBeGreaterThan(Number(poi.d));
    }
  });
});
