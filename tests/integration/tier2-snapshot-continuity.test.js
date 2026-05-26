// tests/integration/tier2-snapshot-continuity.test.js
// Phase A+B (2026-05-26): tier2_pending_m を射影点弧長 (snapshot) に変更した際の不変条件検証。
//
// 検証対象 (meter.js _onMmWorkerMessage):
//   ・tier2_pending_m = m.tentativeDistanceM (SET・snapshot) ← 旧 += 累積から変更
//   ・commit 差分減算 (tier2 -= mmIncrementM) 撤去
//   ・commit 時 dm + tier2 の和が連続 (= commit 無音ハンドオフ)
//
// 絶対ルール準拠の証明:
//   ・distance_m (課金) は m.mmIncrementM のみで増加・tentativeDistanceM 非依存
//     → map-matcher の Phase B hysteresis (tentativeDistanceM のみ改変) は mm/課金を変えない
//   ・fare_yen = calcFare(distance_m)・tentativeDistanceM 非依存

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
  globalThis.GPS = {
    calcDistance: () => 0,
    calcDistance3D: () => 0,
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

// mmResult: mmIncrementM (= commit・課金) と tentativeDistanceM (= snapshot・表示) を別個に与える
function mkMmResult(mmIncrementM, tentativeDistanceM, opts) {
  opts = opts || {};
  return {
    type: 'mmResult',
    mmIncrementM: mmIncrementM,
    tentativeDistanceM: tentativeDistanceM,
    tentativeIncrementM: 0,
    snapped: opts.snapped !== false,
    committed: mmIncrementM > 0,
    isStationary: opts.isStationary || false,
    timestamp: opts.timestamp || Date.now(),
  };
}

describe('tier2 snapshot continuity (Phase A+B・dm+t2 連続 / 課金は tentativeDistanceM 非依存)', () => {
  let Meter, fakeWorker;

  beforeEach(() => {
    mockGPS();
    Meter = loadMeter();
    Meter.setFareConfig(DEFAULT_FARE_CONFIG);
    Meter.reset();
    fakeWorker = makeFakeWorker();
    Meter.setMapMatcher(fakeWorker);
    if (typeof Meter.setBusinessActive === 'function') Meter.setBusinessActive(true);
    Meter.start();
    Meter._setDrainMmUntil(0); // drain 無効化 (= 即時加算)
  });

  afterEach(() => {
    if (Meter) Meter.reset();
    delete globalThis.GPS;
  });

  it('tier2 は SET (snapshot) で更新される (= 累積でない)', () => {
    fakeWorker._dispatch(mkMmResult(0, 10)); // snapshot 10
    expect(Meter.getState().tier2_pending_m).toBe(10);
    fakeWorker._dispatch(mkMmResult(0, 25)); // snapshot 25 (累積なら 35)
    expect(Meter.getState().tier2_pending_m).toBe(25);
    fakeWorker._dispatch(mkMmResult(0, 40)); // snapshot 40 (累積なら 75)
    expect(Meter.getState().tier2_pending_m).toBe(40);
  });

  it('★commit 時に dm + tier2 の和が連続 (= 一気飛び解消の核心)', () => {
    // step1/2: 未 commit・snapshot が伸びる
    fakeWorker._dispatch(mkMmResult(0, 20));
    const before = Meter.getState();
    const sumBefore = before.distance_m + before.tier2_pending_m;
    expect(sumBefore).toBe(20); // dm=0 + t2=20

    // step3: commit 15m + post-commit snapshot 5m
    fakeWorker._dispatch(mkMmResult(15, 5));
    const after = Meter.getState();
    const sumAfter = after.distance_m + after.tier2_pending_m;

    // dm は 0→15 に跳ねるが・和は連続 (= 20 のまま・+15 の二重計上が起きない)
    expect(after.distance_m).toBe(15);
    expect(after.tier2_pending_m).toBe(5);
    expect(sumAfter).toBe(20);
    expect(sumAfter).toBe(sumBefore); // ★連続性★
  });

  it('★distance_m (課金) は mmIncrementM のみで決まり tentativeDistanceM に非依存', () => {
    // tentativeDistanceM が異常巨大 (= 仮に B hysteresis が無効でも) でも distance_m は mmIncrementM のみ
    fakeWorker._dispatch(mkMmResult(15, 9999));
    const s = Meter.getState();
    expect(s.distance_m).toBe(15); // ★課金は 15 (mmIncrementM) のみ・9999 に汚染されない★
    expect(s.tier2_pending_m).toBe(9999); // 表示 preview のみ snapshot を反映
  });

  it('★fare_yen = calcFare(distance_m)・tentativeDistanceM 非依存', () => {
    // base 1300 / 1000m まで・以降 420m ごと +100
    fakeWorker._dispatch(mkMmResult(1000, 5000)); // distance_m=1000・snapshot 5000
    const s = Meter.getState();
    expect(s.distance_m).toBe(1000);
    expect(s.fare_yen).toBe(1300); // ★1000m=base・snapshot 5000 に引きずられない★
  });

  it('business_distance_m も commit (mmIncrementM) のみ・business_tier2 は snapshot SET', () => {
    fakeWorker._dispatch(mkMmResult(30, 12));
    const s = Meter.getState();
    expect(s.business_distance_m).toBe(30); // commit のみ
    expect(s.business_tier2_pending_m).toBe(12); // snapshot SET
  });
});
