'use strict';
// ============================================================
// ★事務所へ 送っている 最中に 乗車を 直しても、直した 額が 事務所へ 届く★（2026-10-12）
//
//   js/job-sync.js の _sync は 送る 前に dk_synced_shifts を 読み、送った 後に
//   「読んだ 時の 印＋受け取られた 勤務」を 書き戻していた。
//   A：送っている 間に 別の（送信済みの）勤務を 直すと、trip-edit が 外した 印が 書き戻しで 戻る
//      ＝直した 額が 二度と 送られない。
//   B：送っている その 勤務を 直すと、事務所が 受け取るのは 直す 前の 額なのに 送信済みに なる
//      （送る 前は 印が 無いので trip-edit は 外す 物が 無い）＝直した 額が 二度と 送られない。
//
//   本物の job-sync.js と trip-edit.js を、遅らせた fetch の 間に 回す。
// ============================================================
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const JS = path.join(ROOT, 'js', 'job-sync.js');
const TE = path.join(ROOT, 'js', 'trip-edit.js');

const RIDE_KEY = 'daikou_history_Mon Oct 12 2026';
let store;
let JobSync;
let TripEdit;
let sentBodies;
let release;

function shift(start, tripStart, fare) {
  return {
    start_time: start,
    end_time: start + 3600000,
    fare_total_yen: fare,
    trip_count: 1,
    trips: [
      { start_time: tripStart, end_time: tripStart + 600000, distance_m: 3000, fare_yen: fare },
    ],
  };
}

beforeEach(() => {
  store = {};
  globalThis.localStorage = {
    getItem: (k) => (Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null),
    setItem: (k, v) => {
      store[k] = String(v);
    },
    removeItem: (k) => {
      delete store[k];
    },
  };
  globalThis.DKConfig = { fn: (n) => 'https://example.invalid/' + n, headers: () => ({}) };
  sentBodies = [];
  // ★送っている 間を 作る★：受け取りは release() を 呼ぶまで 返さない
  globalThis.fetch = (url, opt) => {
    const body = JSON.parse(opt.body);
    sentBodies.push(body);
    return new Promise((resolve) => {
      release = () =>
        resolve({
          json: async () => ({ ok: true, accepted: body.shifts.map((s) => s.start_time) }),
        });
    });
  };
  store.dk_license_company = 'tok';
  store.dk_sync_company = 'tok';
  store.DAIKOME_DEVICE_ID = 'dev';
  store.dk_resend_once_v1 = '1';
  delete require.cache[require.resolve(JS)];
  delete require.cache[require.resolve(TE)];
  JobSync = require(JS);
  TripEdit = require(TE);
});
afterEach(() => {
  delete globalThis.localStorage;
  delete globalThis.DKConfig;
  delete globalThis.fetch;
});

const tick = () => new Promise((r) => setTimeout(r, 0));

function naosu(tripStart, discount, base) {
  store[RIDE_KEY] = store[RIDE_KEY] || JSON.stringify([]);
  const rides = JSON.parse(store[RIDE_KEY]);
  if (!rides.some((r) => r.trip_key === tripStart)) {
    rides.push({ trip_key: tripStart, fare: base, meter_fare: base, extras: [], discounts: [] });
    store[RIDE_KEY] = JSON.stringify(rides);
  }
  const r = TripEdit.apply({
    store: globalThis.localStorage,
    rideKey: RIDE_KEY,
    tripKey: tripStart,
    edit: { discounts: [{ name: '値引き', amount: discount }], now: Date.now() },
    business: null,
  });
  expect(r.ok).toBe(true);
}

// 走っている 送りの 受け取りを 返し、次の 送りが 出るまで 待つ
async function kaesu() {
  const n = sentBodies.length;
  release();
  for (let i = 0; i < 20 && sentBodies.length === n; i++) await tick();
}

describe('★送っている 最中の 直しが その場で 事務所へ 届く★', () => {
  it('A：別の 送信済みの 勤務を 直すと（画面は 送り直しを 呼ぶ）、直した 額が 続けて 送られる', async () => {
    // 勤務1000 は 送信済み・勤務2000 を これから 送る
    store.daikou_business_history = JSON.stringify([
      shift(1000, 1100, 2000),
      shift(2000, 2100, 2500),
    ]);
    store.dk_synced_shifts = JSON.stringify(['1000']);
    const p = JobSync.sync();
    await tick();
    expect(sentBodies.map((b) => b.shifts.map((s) => s.start_time))).toEqual([[2000]]);

    naosu(1100, 500, 2000); // 送っている 間に 勤務1000 の 乗車を 500円 値引き
    expect(JSON.parse(store.dk_synced_shifts)).toEqual([]);
    const pGamen = JobSync.sync(); // index.html _te_save は r.resend の 時 JobSync.sync() を 呼ぶ

    await kaesu();
    expect(sentBodies.length, '直した 勤務が その場で 送られない').toBe(2);
    const s1000 = sentBodies[1].shifts.find((s) => s.start_time === 1000);
    expect(s1000 && s1000.trips[0].fare_yen).toBe(1500);
    release();
    await p;
    await pGamen;
    expect(JSON.parse(store.dk_synced_shifts).sort()).toEqual(['1000', '2000']);
  });

  it('B：送っている その 勤務を 直すと、直す 前の 額で 送信済みに せず 続けて 直した 額を 送る', async () => {
    store.daikou_business_history = JSON.stringify([shift(2000, 2100, 2500)]);
    store.dk_synced_shifts = JSON.stringify([]);
    const p = JobSync.sync();
    await tick();
    expect(sentBodies[0].shifts[0].trips[0].fare_yen).toBe(2500);

    naosu(2100, 700, 2500); // 送っている 間に その 乗車を 700円 値引き（印が 無いので 画面は 送り直しを 呼ばない）

    await kaesu();
    expect(sentBodies.length, '直した 額が その場で 送られない').toBe(2);
    expect(sentBodies[1].shifts[0].trips[0].fare_yen).toBe(1800);
    release();
    const r = await p;
    expect(r.ok).toBe(true);
    expect(r.sent, '同じ 勤務を 2回 送っても 1件').toBe(1);
    expect(JSON.parse(store.dk_synced_shifts)).toEqual(['2000']);
  });

  it('送っている 間に [続ける] → 伸びた 版を 積むと、伸びた 版が 続けて 送られる', async () => {
    store.daikou_business_history = JSON.stringify([shift(2000, 2100, 2500)]);
    store.dk_synced_shifts = JSON.stringify([]);
    const p = JobSync.sync();
    await tick();
    // 業務を 続けて もう 1件 走り、同じ 勤務が 伸びて 積み直された
    const nobita = shift(2000, 2100, 2500);
    nobita.trips.push({ start_time: 2900, end_time: 3000, distance_m: 2000, fare_yen: 900 });
    nobita.fare_total_yen = 3400;
    nobita.trip_count = 2;
    store.daikou_business_history = JSON.stringify([nobita]);

    await kaesu();
    expect(sentBodies.length).toBe(2);
    expect(sentBodies[1].shifts[0].fare_total_yen).toBe(3400);
    release();
    await p;
    expect(JSON.parse(store.dk_synced_shifts)).toEqual(['2000']);
  });

  it('送っている 間に 業務を 終えて 呼ぶと、今 終えた 勤務も 送り「◯件」に 入る', async () => {
    store.daikou_business_history = JSON.stringify([shift(1000, 1100, 2000)]);
    store.dk_synced_shifts = JSON.stringify([]);
    const p = JobSync.sync();
    await tick();
    store.daikou_business_history = JSON.stringify([
      shift(1000, 1100, 2000),
      shift(5000, 5100, 3000),
    ]);
    const pOwari = JobSync.sync(); // index.html _syncAfterEnd

    await kaesu();
    expect(sentBodies.length).toBe(2);
    expect(sentBodies[1].shifts.map((s) => s.start_time)).toEqual([5000]);
    release();
    const r = await pOwari;
    expect(r.sent, '今 終えた 勤務が「送りました」の 数に 入っていない').toBe(2);
    await p;
    expect(JSON.parse(store.dk_synced_shifts).sort()).toEqual(['1000', '5000']);
  });

  it('送っている 間に 何も 起きなければ 1回だけ 送り、今まで 通り 送信済みに なる', async () => {
    store.daikou_business_history = JSON.stringify([shift(2000, 2100, 2500)]);
    store.dk_synced_shifts = JSON.stringify(['1000']);
    const p = JobSync.sync();
    await tick();
    release();
    const r = await p;
    expect(sentBodies.length).toBe(1);
    expect(r.sent).toBe(1);
    expect(JSON.parse(store.dk_synced_shifts).sort()).toEqual(['1000', '2000']);
  });
});
