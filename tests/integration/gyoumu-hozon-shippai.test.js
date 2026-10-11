'use strict';
// ============================================================
// ★業務の 記録が 保存できない 時に 黙って 消さない（10-11）★
//   前は ①業務終了で 履歴に 積めない（端末の 空きが 足りない・履歴が 壊れている）と、
//   次の 業務開始の abandon() が 積み直しに 転んでも state を 消した＝その晩の 業務が
//   事務所へ 上がらずに 消えた（代行10件・25,000円の 業務で 測ると 履歴に 残るのは 0円の 1件）。
//   ②壊れた 履歴は 毎回 積めなかった。③2回目の end() が 終了時刻を 書き直し 勤務時間が 伸びた。
//   ④save() の 失敗は dlog だけ。
//   ★本物の js/business.js を 回す★（写しを 持たない）。画面の 側は 本物の 字で 縛る。
//   ★わざと壊して 赤に なった 記録（10-11・11通り 全部 赤・後で 1通り 足した）★：中身の 無い 札を 落とさない 2本／abandon の 守りを 外す 3本／start の 早帰りを 外す 2本／
//     2回目 end で 時刻を 書き直す 1本／壊れを 退けない 3本／退けずに 上書き 3本／知らせを 毎回 1本／新しい 業務で 印を 戻さない 1本／
//     save が true を 返さない 1本／画面の 開始の 止めを 外す 1本／終了の 知らせを 外す 1本／送る 結果を 出す 1本。
// ============================================================
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const BJS = path.join(ROOT, 'js', 'business.js');
const H = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const HK = 'daikou_business_history';

function makeStorage() {
  const m = {};
  let dame = () => false;
  return {
    getItem: (k) => (Object.prototype.hasOwnProperty.call(m, k) ? m[k] : null),
    setItem: (k, v) => {
      if (dame(k)) {
        const e = new Error('QuotaExceededError');
        e.name = 'QuotaExceededError';
        throw e;
      }
      m[k] = String(v);
    },
    removeItem: (k) => {
      delete m[k];
    },
    key: (i) => Object.keys(m)[i] || null,
    get length() {
      return Object.keys(m).length;
    },
    m,
    setDame(f) {
      dame = f;
    },
  };
}

function makeMeter() {
  const s = {
    business_active: false,
    business_distance_m: 0,
    business_display_distance_m: 0,
    distance_m: 0,
  };
  return {
    getState: () => s,
    setBusinessActive: (v) => {
      s.business_active = !!v;
    },
    setBusinessDistance: (v) => {
      s.business_distance_m = v;
      s.business_display_distance_m = v;
    },
  };
}

function load(storage) {
  global.localStorage = storage;
  global.Meter = makeMeter();
  delete require.cache[require.resolve(BJS)];
  return require(BJS);
}
const hist = (s) => {
  try {
    return JSON.parse(s.getItem(HK) || '[]');
  } catch (_) {
    return null;
  }
};
const zenbu = () => true;
const rirekiDake = (k) => k === HK;

function hitoban(B) {
  B.start();
  for (let i = 0; i < 10; i++) B.onTripEnd(1000, 2500, Date.now());
}

describe('★業務の 記録が 保存できない 時に 黙って 消さない（10-11）★', () => {
  it('終了で 積めず・次の 開始でも 積めない → 始めず・その晩の 25,000円は 残る → 空きが できたら 積めて 始まる', () => {
    const ls = makeStorage();
    const B = load(ls);
    hitoban(B);
    ls.setDame(rirekiDake);
    B.end();
    expect(B.getState().history_pushed).toBe(false);
    expect(B.start()).toBe(false);
    expect(B.getState().fare_total_yen).toBe(25000);
    expect(B.getState().trip_count).toBe(10);
    expect(B.getState().active).toBe(false);
    ls.setDame(() => false);
    expect(B.start()).toBe(true);
    const h = hist(ls);
    expect(h.length).toBe(1);
    expect(h[0].fare_total_yen).toBe(25000);
    expect(h[0].trip_count).toBe(10);
  });

  it('abandon() は 積めなければ false で state を 消さない', () => {
    const ls = makeStorage();
    const B = load(ls);
    hitoban(B);
    ls.setDame(rirekiDake);
    B.end();
    expect(B.abandon()).toBe(false);
    expect(B.getState().start_time).not.toBe(null);
    expect(B.getState().fare_total_yen).toBe(25000);
  });

  for (const kowareta of ['{bad', '{"a":1}', 'null']) {
    it(`壊れた 履歴（${kowareta}）→ 退けて 積む（毎晩 積めない・始められない に ならない）・退けた 字は 残す`, () => {
      const ls = makeStorage();
      ls.m[HK] = kowareta;
      const B = load(ls);
      hitoban(B);
      B.end();
      expect(B.getState().history_pushed).toBe(true);
      expect(hist(ls).length).toBe(1);
      expect(hist(ls)[0].fare_total_yen).toBe(25000);
      const nokoshi = Object.keys(ls.m).filter((k) =>
        k.startsWith('dk_business_history_kowareta_')
      );
      expect(nokoshi.length).toBe(1);
      expect(ls.m[nokoshi[0]]).toBe(kowareta);
      expect(B.start()).toBe(true);
    });
  }

  for (const nakami of [
    '[null]',
    '[{"start_time":1,"end_time":2,"fare_total_yen":100}, null, 5]',
  ]) {
    it(`履歴に 中身の 無い 札（${nakami.length}字）→ 落として 積む・元の 業務は 残す・次も 始まる`, () => {
      const ls = makeStorage();
      ls.m[HK] = nakami;
      const B = load(ls);
      hitoban(B);
      B.end();
      expect(B.getState().history_pushed).toBe(true);
      const h = hist(ls);
      expect(h.every((x) => x && typeof x === 'object')).toBe(true);
      expect(h[0].fare_total_yen).toBe(25000);
      expect(h.length).toBe(nakami.startsWith('[null]') ? 1 : 2);
      expect(B.start()).toBe(true);
    });
  }

  it('壊れた 履歴を 退ける 空きも 無い → 積めない（壊れた 字は 上書きしない）', () => {
    const ls = makeStorage();
    ls.m[HK] = '{bad';
    const B = load(ls);
    hitoban(B);
    ls.setDame((k) => k === HK || k.startsWith('dk_business_history_kowareta_'));
    B.end();
    expect(B.getState().history_pushed).toBe(false);
    expect(ls.m[HK]).toBe('{bad');
    expect(B.start()).toBe(false);
  });

  it('積めなかった 業務の 2回目の end() は 終了時刻を 変えない（勤務時間が 伸びない）・積めたら 1件', () => {
    const ls = makeStorage();
    const B = load(ls);
    hitoban(B);
    ls.setDame(rirekiDake);
    B.end();
    const t1 = B.getState().end_time;
    const e1 = B.getReport().elapsed_sec;
    const nowOrig = Date.now;
    Date.now = () => nowOrig() + 3600 * 1000; // 日報画面に 1時間 いた
    try {
      ls.setDame(() => false);
      B.end();
    } finally {
      Date.now = nowOrig;
    }
    expect(B.getState().end_time).toBe(t1);
    expect(B.getState().history_pushed).toBe(true);
    expect(hist(ls).length).toBe(1);
    expect(hist(ls)[0].elapsed_sec).toBe(e1);
    B.end(); // 3回目も 増えない
    expect(hist(ls).length).toBe(1);
  });

  it('save() の 失敗は 1つの 業務で 1回だけ 知らせる・新しい 業務で もう一度', () => {
    const ls = makeStorage();
    const B = load(ls);
    let n = 0;
    B.onHozonShippai(() => n++);
    B.start();
    ls.setDame((k) => k !== HK);
    for (let i = 0; i < 5; i++) expect(B.save()).toBe(false);
    expect(n).toBe(1);
    ls.setDame(() => false);
    expect(B.save()).toBe(true);
    ls.setDame((k) => k !== HK);
    B.save();
    expect(n).toBe(1); // 揺れても 同じ 業務では 1回
    ls.setDame(() => false);
    B.end();
    B.start();
    ls.setDame((k) => k !== HK);
    B.save();
    expect(n).toBe(2);
  });

  it('全部 書けない 端末でも 転ばない（start は false でなく 業務は 手元で 動く）', () => {
    const ls = makeStorage();
    const B = load(ls);
    ls.setDame(zenbu);
    expect(() => hitoban(B)).not.toThrow();
    expect(B.getState().fare_total_yen).toBe(25000);
  });

  it('画面：業務開始は 始められない false で 止めて 知らせる（本物の 字で 縛る）', () => {
    expect(H).toMatch(
      /if \(Business\.start\(\) === false && !Business\.getState\(\)\.active\) \{\s*showToastLong\(\s*'前の 業務が 端末に 保存できていないので[^']*'\s*\);\s*return;\s*\}/
    );
  });

  it('画面：業務終了で 積めていなければ 知らせ・送る 結果の 知らせは 出さない', () => {
    const i = H.indexOf('function _syncAfterEnd() {');
    const f = H.slice(i, H.indexOf('\n      }\n', i));
    expect(f).toMatch(
      /const tsumenai =\s*typeof Business !== 'undefined' && Business\.getState\(\)\.history_pushed !== true;/
    );
    expect(f).toMatch(
      /if \(tsumenai\)\s*showToastLong\(\s*'この 業務は 端末に 保存できませんでした/
    );
    expect(f).toMatch(/const say = function \(msg\) \{\s*if \(tsumenai\) return;/);
  });

  it('画面：保存の 失敗の 受け口を 登録している', () => {
    expect(H).toMatch(
      /Business\.onHozonShippai\(function \(\) \{\s*showToastLong\(\s*'業務の 記録が 端末に 保存できませんでした/
    );
  });
});
