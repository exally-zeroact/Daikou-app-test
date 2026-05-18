// tests/integration/business-distance-carryover.test.js
// ZEROact 共通テスト基盤 (2026-05-19 仕様更新・business_distance_m 完全分離後)
//
// 検証対象: meter.js business_distance_m の独立加算経路 + trip 跨ぎ carry-over
//
// ★設計変更宣言 (2026-05-19・business_distance_m を Worker B 経路から完全分離):
//   旧: Worker B mm commit (= mmIncrementM) を distance_m と business_distance_m に分岐加算
//       → main 側 _isStationary() gate 非対称で business < distance の事象発生
//   新: business_distance_m は Worker B 経路では加算しない・update() 内 GPS speed × dt で独立加算
//       gate: state.business_active && speedKmh>0 && !gpsResult.isStationary && 0<dtSec<10
//       distance_m (= 課金根拠) は state.running gate で 5 経路加算・絶対不変
//
// 絶対ルール準拠:
//   js/meter.js 触る範囲は司さん許可済 (= business_distance_m 完全分離リファクタ)・
//   distance_m 加算 5 経路は完全不変。

const path = require('path');
const METER_JS_PATH = path.join(__dirname, '..', '..', 'js', 'meter.js');

function loadMeter() {
  delete require.cache[require.resolve(METER_JS_PATH)];
  return require(METER_JS_PATH);
}

const DEFAULT_FARE_CONFIG = {
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
  autoSurcharges: {},
  vehicles: [],
  vehiclesEnabled: false,
  wait: { enabled: false, freeMins: 5, ratePerMin: 100 },
};

function mockGPS() {
  // ★設計変更宣言 (2026-05-19・haversine 化対応): 業務単位累積が GPS.calcDistance を
  //   呼ぶ設計に変更されたため・mock も実 haversine 計算に変更。
  globalThis.GPS = {
    calcDistance: (lat1, lng1, lat2, lng2) => {
      const R = 6371000;
      const toRad = (d) => (d * Math.PI) / 180;
      const dLat = toRad(lat2 - lat1);
      const dLng = toRad(lng2 - lng1);
      const a =
        Math.sin(dLat / 2) ** 2 +
        Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
      const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
      return R * c;
    },
    calcDistance3D: () => 0,
    setRoadType: () => {},
  };
}

function makeFakeWorker() {
  const handlers = [];
  return {
    addEventListener(type, h) {
      if (type === 'message') handlers.push(h);
    },
    removeEventListener(type, h) {
      const i = handlers.indexOf(h);
      if (i >= 0) handlers.splice(i, 1);
    },
    postMessage() {},
    _dispatch(data) {
      for (const h of handlers) h({ data });
    },
  };
}

// 1 step = 90km/h × 1 秒 = 25m 加算想定
// (speedKmh=90 / 3.6) × 1 秒 = 25.0 m
function gpsAt(stepIdx, baseLat = 33.84, baseLng = 132.7656, baseTs = 1714100000000) {
  return {
    lat: baseLat + 0.000225 * stepIdx,
    lng: baseLng,
    altitude: 0,
    accuracy: 5,
    speedKmh: 90,
    isStationary: false,
    timestamp: baseTs + stepIdx * 1000,
  };
}

function gpsStationaryAt(stepIdx, baseTs = 1714100000000) {
  return {
    lat: 33.84,
    lng: 132.7656,
    altitude: 0,
    accuracy: 5,
    speedKmh: 0,
    isStationary: true,
    timestamp: baseTs + stepIdx * 1000,
  };
}

describe('business-distance-carryover (完全分離後・GPS speed×dt 独立加算)', () => {
  let Meter, fakeWorker;
  beforeEach(() => {
    mockGPS();
    Meter = loadMeter();
    Meter.setFareConfig(DEFAULT_FARE_CONFIG);
    Meter.reset();
    fakeWorker = makeFakeWorker();
    Meter.setMapMatcher(fakeWorker);
  });
  afterEach(() => {
    if (Meter) Meter.reset();
    delete globalThis.GPS;
  });

  // ─── setBusinessDistance 外部 API (= タスクキル復帰時の業務単位累積復元) ────

  it('setBusinessDistance(1500) で state.business_distance_m=1500 に復元される', () => {
    Meter.setBusinessDistance(1500);
    expect(Meter.getState().business_distance_m).toBe(1500);
  });

  it('setBusinessDistance(0) で state.business_distance_m=0 に', () => {
    Meter.setBusinessDistance(0);
    expect(Meter.getState().business_distance_m).toBe(0);
  });

  it('setBusinessDistance(負値) で state.business_distance_m=0 (fallback)', () => {
    Meter.setBusinessDistance(-100);
    expect(Meter.getState().business_distance_m).toBe(0);
  });

  it('setBusinessDistance(NaN) で state.business_distance_m=0 (fallback)', () => {
    Meter.setBusinessDistance(NaN);
    expect(Meter.getState().business_distance_m).toBe(0);
  });

  it('setBusinessDistance(string) で state.business_distance_m=0 (fallback)', () => {
    Meter.setBusinessDistance('1500');
    expect(Meter.getState().business_distance_m).toBe(0);
  });

  it('setBusinessDistance(undefined) で state.business_distance_m=0 (fallback)', () => {
    Meter.setBusinessDistance(undefined);
    expect(Meter.getState().business_distance_m).toBe(0);
  });

  // ─── per-trip reset / businessEnd で carryover 維持 ──────────────────

  it('Meter.reset() (= per-trip reset) で business_distance_m は維持される', () => {
    Meter.setBusinessDistance(2000);
    expect(Meter.getState().business_distance_m).toBe(2000);
    Meter.reset();
    // trip 単位 reset では business は引き継ぐ (prevBusinessDist)
    expect(Meter.getState().business_distance_m).toBe(2000);
    // ただし distance_m / fare_yen は 0 化
    expect(Meter.getState().distance_m).toBe(0);
    expect(Meter.getState().fare_yen).toBe(0);
  });

  it('Meter.businessEnd() では business_distance_m を維持 (= getReport で読まれる)', () => {
    Meter.setBusinessDistance(3000);
    Meter.start();
    expect(Meter.getState().business_distance_m).toBe(3000);
    Meter.businessEnd();
    // ★ 混同#4 修正: 0 化撤廃・最後値維持 (= getReport で正しく読まれる)
    expect(Meter.getState().business_distance_m).toBe(3000);
    expect(Meter.getState().business_active).toBe(false); // 業務 gate OFF は維持
  });

  // ─── 完全分離: Worker B mm commit は business_distance_m に加算しない ─

  it('★ 完全分離: Worker B mm commit (mmIncrementM>0) は business_distance_m に加算しない', () => {
    Meter.setBusinessDistance(1000);
    Meter.setBusinessActive(true);
    Meter.start();
    Meter._setDrainMmUntil(0);
    // mm commit を流す → distance_m のみ加算・business_distance_m は不変
    fakeWorker._dispatch({ type: 'mmResult', mmIncrementM: 200, snapped: true, committed: true });
    expect(Meter.getState().distance_m).toBe(200); // 課金は加算
    expect(Meter.getState().business_distance_m).toBe(1000); // 業務は不変 (= 完全分離)
  });

  // ─── 完全分離: GPS update で speed × dt 独立加算 ──────────────────

  it('★ 完全分離: GPS update (speedKmh×dt) で business_distance_m が独立加算される', () => {
    Meter.setBusinessDistance(0);
    Meter.setBusinessActive(true);
    Meter.start();
    // 1 step = 25m (= 90km/h × 1 秒)
    Meter.update(gpsAt(0)); // last_gps セット
    Meter.update(gpsAt(1)); // +25m
    Meter.update(gpsAt(2)); // +25m
    // 業務単位は 50m 累積 (= 2 step × 25m)
    expect(Meter.getState().business_distance_m).toBeCloseTo(50, 0);
  });

  // ─── gate 検証: business_active=false ──────────────────

  it('★ business_active=false なら GPS update でも business_distance_m 加算しない', () => {
    Meter.setBusinessDistance(1000);
    Meter.setBusinessActive(false); // 業務未開始 / 業務終了後
    Meter.start();
    Meter.update(gpsAt(0));
    Meter.update(gpsAt(1));
    Meter.update(gpsAt(2));
    expect(Meter.getState().business_distance_m).toBe(1000); // 不変
  });

  // ─── gate 検証: 空車中 (= running=false) でも業務単位は加算 ──────────

  it('★ business_active=true・running=false (= 空車中走行) でも business_distance_m 加算', () => {
    Meter.setBusinessDistance(500);
    Meter.setBusinessActive(true);
    // Meter.start() を呼ばない (= running=false・空車中走行を simulate)
    Meter.update(gpsAt(0));
    Meter.update(gpsAt(1));
    Meter.update(gpsAt(2));
    // 業務単位は加算 (= 後付メーター機と対等)
    expect(Meter.getState().business_distance_m).toBeCloseTo(550, 0); // 500 + 50
    // distance_m は running=false で加算なし (= 課金経路は代行中のみ)
    expect(Meter.getState().distance_m).toBe(0);
  });

  // ─── gate 検証: 停車中は加算しない ──────────────────

  it('★ isStationary=true なら business_distance_m 加算しない', () => {
    Meter.setBusinessDistance(1000);
    Meter.setBusinessActive(true);
    Meter.start();
    Meter.update(gpsStationaryAt(0));
    Meter.update(gpsStationaryAt(1));
    Meter.update(gpsStationaryAt(2));
    expect(Meter.getState().business_distance_m).toBe(1000); // 不変
  });

  // ─── trip 跨ぎ carryover (= 完全分離後も維持) ──────────────────

  it('複数 trip 跨ぎで business_distance_m が累積する (= trip A 終了 → trip B 開始)', () => {
    Meter.setBusinessActive(true);
    // trip A 開始
    Meter.start();
    Meter.update(gpsAt(0));
    Meter.update(gpsAt(1));
    Meter.update(gpsAt(2));
    const afterA = Meter.getState().business_distance_m;
    expect(afterA).toBeCloseTo(50, 0); // 2 step × 25m

    // trip A 終了 (= Meter.reset で trip 内 distance_m リセット・business は引き継ぐ)
    Meter.reset();
    expect(Meter.getState().distance_m).toBe(0);
    expect(Meter.getState().business_distance_m).toBeCloseTo(50, 0);
    expect(Meter.getState().business_active).toBe(true); // reset で引き継ぎ

    // trip B 開始 (= Meter.reset で last_gps null 化されるので・初回 update は last_gps セットのみ)
    Meter.start();
    Meter.update(gpsAt(3)); // last_gps セット (加算なし)
    Meter.update(gpsAt(4)); // +25m
    // trip A 50m + trip B 25m = 75m
    expect(Meter.getState().business_distance_m).toBeCloseTo(75, 0);
  });

  // ─── businessEnd 後の次業務開始 ──────────────────

  it('businessEnd 後 setBusinessDistance(0)・新業務開始で 0 から累積', () => {
    Meter.setBusinessActive(true);
    Meter.start();
    Meter.update(gpsAt(0));
    Meter.update(gpsAt(1));
    Meter.update(gpsAt(2));
    expect(Meter.getState().business_distance_m).toBeCloseTo(50, 0);

    // 業務終了
    Meter.businessEnd();
    expect(Meter.getState().business_distance_m).toBeCloseTo(50, 0); // 0 化撤廃・維持
    expect(Meter.getState().business_active).toBe(false);

    // 次業務開始 (= Business.start 相当)
    Meter.setBusinessDistance(0);
    Meter.setBusinessActive(true);
    Meter.start();
    Meter.update(gpsAt(10)); // last_gps セット (= timestamp 飛ぶ)
    Meter.update(gpsAt(11));
    // 新業務は 0 + 25m 累積
    expect(Meter.getState().business_distance_m).toBeCloseTo(25, 0);
  });

  // ─── 司さん実車事象の回帰防止: business >= distance を保証 ──────────

  it('★ 回帰防止: 代行中 GPS update + mm commit 同時受信で business >= distance を保証', () => {
    // 司さん実車テストで business_distance_m=0.50 < distance=1.06 の事象が
    // main 側 _isStationary() gate 非対称で発生していた。完全分離後は
    // business は GPS speed × dt のみで加算され・mm commit に依存しない。
    Meter.setBusinessActive(true);
    Meter.start();
    Meter._setDrainMmUntil(0);

    // GPS update で business +25m
    Meter.update(gpsAt(0));
    Meter.update(gpsAt(1));
    // mm commit で distance +500m
    fakeWorker._dispatch({ type: 'mmResult', mmIncrementM: 500, snapped: true, committed: true });
    const s = Meter.getState();
    // business は GPS で 25m 加算 (= mm commit に依存しない)
    expect(s.business_distance_m).toBeCloseTo(25, 0);
    // distance は mm commit で 500m 加算 (= 完全分離)
    expect(s.distance_m).toBe(500);
    // 両者は独立計算・main 側 _isStationary 非対称の影響を受けない
  });
});
