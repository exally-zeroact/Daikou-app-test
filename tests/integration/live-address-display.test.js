// tests/integration/live-address-display.test.js
//
// ★設計変更宣言 (2026-05-23・住所② 現在地ライブ表示・カーナビ風):
//   Business.getCurrentLiveAddress public API の・behavior verify。
//   既存 4 段 fallback (= _safeGetNearestAddress) を・snap cache 経由で・呼ぶ・薄い wrapper。
//
// 検証内容:
//   1. snap 未 cache → null
//   2. snap cache あり (fresh = 5 秒以内) → 住所文字列
//   3. snap cache stale (= 5 秒超え) → null
//   4. snap cache 後・notifyMMSnap で・更新可能
//   5. public API export verify
//   6. _safeGetNearestAddress 流用 (= 同 fallback ロジック・新 logic ゼロ)
//   7. index.html 配線 verify (= grep ベース)
//
// 絶対ルール準拠:
//   ✓ distance_m / Meter / Worker B / map-matcher: 完全無関係
//   ✓ 既存 notifyMMSnap / _safeGetNearestAddress を・流用・新規 logic ゼロ
//   ✓ snap stale → null で・consumer 側で・現在地行 非表示 (= 既存挙動互換)

'use strict';

const fs = require('fs');
const path = require('path');

let Business;
let getCurrentLiveAddress;
let notifyMMSnap;
let resetLastMMSnap;
let ehimeBundle;

beforeAll(() => {
  delete require.cache[require.resolve(path.join('..', '..', 'js', 'business.js'))];
  Business = require(path.join('..', '..', 'js', 'business.js'));
  getCurrentLiveAddress = Business.getCurrentLiveAddress;
  notifyMMSnap = Business.notifyMMSnap;
  resetLastMMSnap = Business.__addressFormatter.resetLastMMSnap;
  if (typeof getCurrentLiveAddress !== 'function') {
    throw new Error('Business.getCurrentLiveAddress 未 export');
  }
  if (typeof notifyMMSnap !== 'function') {
    throw new Error('Business.notifyMMSnap 未 export');
  }
  // 本物 愛媛 bundle (= 司さん家 PIP 用)
  const ehimePath = path.join(__dirname, '..', '..', 'data', 'town-polygons-ehime.js');
  if (fs.existsSync(ehimePath)) {
    const sandbox = {};
    new Function('window', fs.readFileSync(ehimePath, 'utf8'))(sandbox);
    ehimeBundle = sandbox.TOWN_POLYGONS_EHIME;
  }
});

beforeEach(() => {
  resetLastMMSnap();
  // global.window mock (= bundle 解決 + RegionHelper)
  if (typeof global !== 'undefined') {
    global.window = {
      TOWN_POLYGONS_EHIME: ehimeBundle,
      RegionHelper: {
        getCurrentPref: function () {
          return 'ehime';
        },
      },
    };
  }
});

afterEach(() => {
  resetLastMMSnap();
  if (typeof global !== 'undefined') {
    delete global.window;
  }
});

// ─── 1-4. snap cache 状態別 behavior ─
describe('getCurrentLiveAddress: snap cache 状態別 behavior', () => {
  it('1. snap 未 cache → null', () => {
    expect(getCurrentLiveAddress()).toBeNull();
  });

  it('2. snap fresh (= 直後) → 住所文字列 (= 司さん家・本町七丁目 → 「今治市本町」)', () => {
    if (!ehimeBundle) {
      // data file 未生成環境 → skip
      return;
    }
    notifyMMSnap(34.077806599, 132.996956368);
    const r = getCurrentLiveAddress();
    expect(r).not.toBeNull();
    expect(r).toBe('今治市本町');
  });

  it('3. snap stale (= 5 秒超え) → null', () => {
    if (!ehimeBundle) return;
    notifyMMSnap(34.077806599, 132.996956368);
    // 5.5 秒 + 1ms 過去に・改竄
    const stash = Business.__addressFormatter.getLastMMSnap();
    expect(stash).not.toBeNull();
    stash.t = Date.now() - 5001;
    expect(getCurrentLiveAddress()).toBeNull();
  });

  it('4. notifyMMSnap で・cache 更新後・getCurrentLiveAddress が・最新位置を返す', () => {
    if (!ehimeBundle) return;
    notifyMMSnap(34.077806599, 132.996956368); // 司さん家
    expect(getCurrentLiveAddress()).toBe('今治市本町');
    // 別位置に更新 (= 松山市 市坪西町 代表点)
    notifyMMSnap(33.80677, 132.73824);
    const r2 = getCurrentLiveAddress();
    expect(r2).not.toBeNull();
    expect(r2).toMatch(/松山市/);
  });
});

// ─── 5. public API export verify ─
describe('Business public API export', () => {
  it('getCurrentLiveAddress が・Business object に・export されている', () => {
    expect(typeof Business.getCurrentLiveAddress).toBe('function');
  });

  it('notifyMMSnap も・export されている (= 住所① 既存)', () => {
    expect(typeof Business.notifyMMSnap).toBe('function');
  });
});

// ─── 6. 新 logic ゼロ verify (= _safeGetNearestAddress 流用) ─
describe('getCurrentLiveAddress: 新 logic ゼロ・既存 4 段 fallback 流用', () => {
  it('source code で・_safeGetNearestAddress 流用が・確認できる', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'js', 'business.js'), 'utf8');
    // getCurrentLiveAddress 内に・_safeGetNearestAddress 呼出 含む
    const m = src.match(/function getCurrentLiveAddress\(\)\s*\{[\s\S]*?\n\s\s\}/);
    expect(m).not.toBeNull();
    expect(m[0]).toContain('_safeGetNearestAddress');
    expect(m[0]).toContain('_lastMMSnap');
    expect(m[0]).toContain('_MM_SNAP_FRESH_MS');
  });

  it('独自 PIP / 独自 fallback logic を・持たない (= wrapper のみ)', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'js', 'business.js'), 'utf8');
    const m = src.match(/function getCurrentLiveAddress\(\)\s*\{[\s\S]*?\n\s\s\}/);
    const body = m[0];
    // body 内・独自 _findTownPolygonAddress / _pointInPolygon 呼出なし
    expect(body).not.toMatch(/_findTownPolygonAddress\(/);
    expect(body).not.toMatch(/_pointInPolygon\(/);
  });
});

// ─── 7. index.html 配線 verify (= updateWaypointCardUI 拡張) ─
describe('index.html: updateWaypointCardUI 配線 verify', () => {
  let html;
  beforeAll(() => {
    html = fs.readFileSync(path.join(__dirname, '..', '..', 'index.html'), 'utf8');
  });

  it('updateWaypointCardUI 内で・Business.getCurrentLiveAddress 呼出', () => {
    const m = html.match(/function updateWaypointCardUI\(\)\s*\{[\s\S]*?\n\s\s\s\s\s\s\}/);
    expect(m).not.toBeNull();
    expect(m[0]).toContain('Business.getCurrentLiveAddress');
  });

  it('route-live CSS class が・定義されている (= 青パルス style)', () => {
    expect(html).toMatch(/\.route-live\s*\{/);
    expect(html).toMatch(/@keyframes route-live-pulse/);
    // 青色
    expect(html).toMatch(/#2196f3/i);
  });

  it('liveSuffix で・「→ 📡」を・末尾追加 (= カーナビ風)', () => {
    const m = html.match(/function updateWaypointCardUI\(\)\s*\{[\s\S]*?\n\s\s\s\s\s\s\}/);
    expect(m[0]).toContain('📡');
    expect(m[0]).toContain('route-live');
  });

  it('直前 (= 末尾) と・同住所なら・現在地行 を・省略 (= 重複回避)', () => {
    const m = html.match(/function updateWaypointCardUI\(\)\s*\{[\s\S]*?\n\s\s\s\s\s\s\}/);
    // 「liveAddr !== prevTail」or・同等の重複 check 含む
    expect(m[0]).toMatch(/liveAddr\s*&&\s*liveAddr\s*!==\s*prevTail/);
  });
});

// ─── 8. 不可侵境界 verify ─
describe('不可侵境界 verify (= 表示専用・コア無変更)', () => {
  it('business.js getCurrentLiveAddress は・Meter / Worker B に touch しない', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'js', 'business.js'), 'utf8');
    const m = src.match(/function getCurrentLiveAddress\(\)\s*\{[\s\S]*?\n\s\s\}/);
    const body = m[0];
    // Meter への代入なし (= state.* = ... 等の・直接代入を持たない)
    expect(body).not.toMatch(/Meter\.\w+\s*=/);
    // map-matcher への postMessage なし (= snap cache を読むだけ)
    expect(body).not.toMatch(/postMessage/);
  });
});
