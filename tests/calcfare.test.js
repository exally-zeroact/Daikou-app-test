// tests/calcfare.test.js
// js/meter.js の calcFare 境界テスト
//
// ★設計変更宣言 (2026-05-15・Phase C・V8 coverage 計測可能化):
//   旧: new Function('window','dlog',...) sandbox + 末尾 return Meter で load
//       → V8 coverage instrument は require/import 経路のみ追跡するため計測対象外 (0%)
//   新: meter.js 末尾に module.exports = Meter を追加 (Phase C) したので require() で直接 load
//       require.cache を都度クリアして毎回 fresh IIFE 評価 (fresh state) を強制
//       → V8 coverage 計測有効化
//
// 絶対ルール準拠: 距離計算ロジックは触らず、入力 → 出力の境界値だけ検証
// calcFare の実装は js/meter.js:820-902 (旧形式 fallback path・tiers=[] のとき)

// describe / it / expect / beforeEach は vitest.config.js の globals:true で自動注入
const path = require('path');

const METER_JS_PATH = path.join(__dirname, '..', 'js', 'meter.js');

function loadMeter() {
  // require.cache を都度クリアして毎回 fresh IIFE 評価を強制 (state リーク回避)
  delete require.cache[require.resolve(METER_JS_PATH)];
  return require(METER_JS_PATH);
}

// ─── 旧形式 (tiers=[]) calcFare の手計算検算 ───────────────────────────
// js/meter.js:1018-1024 (2026-05-15 修正後):
//   if(distanceM <= base_distance_m){ fare = base_fare; }     ← 境界 inclusive に修正
//   else { steps = Math.floor((distanceM - base_distance_m) / add_distance_m) + 1;
//          fare = base_fare + steps * add_fare; }
// その後 Step 7 で rounding (default 10円単位) を Math.round(fare / unit) * unit。
// default config: base_fare=1300 / base_distance_m=1000 / add_fare=100 / add_distance_m=420 / rounding=10
function expectedFareLegacy(distanceM, cfg) {
  const { base_fare, base_distance_m, add_fare, add_distance_m, rounding } = cfg;
  let fare;
  // 2026-05-15: meter.js の修正に合わせて `<` → `<=` に変更
  if (distanceM <= base_distance_m) {
    fare = base_fare;
  } else {
    const extra = distanceM - base_distance_m;
    const steps = Math.floor(extra / add_distance_m) + 1;
    fare = base_fare + steps * add_fare;
  }
  const unit = rounding > 0 ? rounding : 1;
  return unit > 1 ? Math.round(fare / unit) * unit : Math.round(fare);
}

describe('Meter.calcFare 境界値テスト (旧形式・tiers=[])', () => {
  let Meter;
  const DEFAULT_CFG = {
    base_fare: 1300,
    base_distance_m: 1000,
    add_fare: 100,
    add_distance_m: 420,
    rounding: 10,
    tiers: [], // 旧形式 fallback path に入れる
    surcharges: [],
    vehicles: [],
    vehiclesEnabled: false,
    wait: { enabled: false, freeMins: 5, ratePerMin: 100 },
    autoSurcharges: {
      night: { enabled: false },
      weekend: { enabled: false },
      winter: { enabled: false },
    },
    minFare: null,
    maxFare: null,
  };

  beforeEach(() => {
    Meter = loadMeter();
    Meter.setFareConfig(DEFAULT_CFG);
  });

  it('distance=0 → fare=base_fare (1,300)', () => {
    expect(Meter.calcFare(0)).toBe(1300);
  });

  it('distance=999 → fare=base_fare (1,300・< base_distance_m)', () => {
    expect(Meter.calcFare(999)).toBe(1300);
  });

  it('distance=1000 → fare=base_fare (1,300・境界値 inclusive・2026-05-15 修正点)', () => {
    // ★設計変更宣言 (2026-05-15・1000m 境界バグ修正):
    //   旧コード (meter.js:1018) は `if(distanceM < base_distance_m)` で strict 未満。
    //   1000m ちょうどは else 分岐に入り fare=1300+1×100=1400 となる off-by-one bug があった。
    //   修正後 (`<=`) では 1000m ちょうども base_fare 適用範囲に含まれ fare=1300 となる。
    //   司さんの仕様意図「1000m まで base_fare」と一致。
    expect(Meter.calcFare(1000)).toBe(1300);
  });

  it('distance=1001 → fare=base_fare+追加料金 1 回 (1,400・境界 +1m で加算料金発生)', () => {
    // distance=1001m: extra=1 / steps=Math.floor(1/420)+1=1 / fare=1300+1×100=1400
    expect(Meter.calcFare(1001)).toBe(1400);
  });

  it('distance=1420 → fare=base_fare+追加料金 2 回 (1,500)', () => {
    // extra=420, steps=Math.floor(420/420)+1 = 2, fare=1300+200=1500
    expect(Meter.calcFare(1420)).toBe(1500);
  });

  it('distance=5000 → 手計算値と一致', () => {
    // extra=4000, steps=Math.floor(4000/420)+1 = 9+1 = 10, fare=1300+10*100=2300
    expect(Meter.calcFare(5000)).toBe(2300);
    expect(Meter.calcFare(5000)).toBe(expectedFareLegacy(5000, DEFAULT_CFG));
  });

  it('多数の距離点で expectedFareLegacy ヘルパと一致', () => {
    const samples = [0, 100, 500, 999, 1001, 1420, 1421, 2000, 3000, 5000, 10000, 20000];
    samples.forEach((d) => {
      expect(Meter.calcFare(d)).toBe(expectedFareLegacy(d, DEFAULT_CFG));
    });
  });
});

describe('Meter.calcFare 待機料金加算', () => {
  let Meter;
  beforeEach(() => {
    Meter = loadMeter();
    Meter.setFareConfig({
      base_fare: 1300,
      base_distance_m: 1000,
      add_fare: 100,
      add_distance_m: 420,
      rounding: 10,
      tiers: [],
      wait: { enabled: true, freeMins: 5, ratePerMin: 100 },
    });
  });

  it('wait_sec=0 なら距離料金のみ (default 内部 state)', () => {
    // 初期 state.wait_sec=0 なので待機料金=0
    expect(Meter.calcFare(0)).toBe(1300);
  });
  // 注: wait_sec の蓄積は GPS update 経由でしか入らないため、calcFare 単体テストでは
  //     待機加算 path の存在確認のみに留める (絶対ルール: 触らない箇所は触らない)。
});

describe('Meter.calcFare 自動割増 (autoSurcharges) の整数丸め', () => {
  let Meter;
  beforeEach(() => {
    Meter = loadMeter();
  });

  it('autoSurcharges 全 disabled なら倍率 1.0 (距離料金そのまま)', () => {
    Meter.setFareConfig({
      base_fare: 1300,
      base_distance_m: 1000,
      add_fare: 100,
      add_distance_m: 420,
      rounding: 10,
      tiers: [],
      autoSurcharges: {
        night: { enabled: false, from: 22, to: 5, rate: 1.2 },
        weekend: { enabled: false, rate: 1.1 },
        winter: { enabled: false, from: '12-15', to: '03-15', rate: 1.1 },
      },
    });
    expect(Meter.calcFare(500)).toBe(1300);
  });
});

describe('Meter.calcFare 丸め単位 (rounding)', () => {
  let Meter;
  beforeEach(() => {
    Meter = loadMeter();
  });

  it('rounding=10 で 10 円単位に丸め (default 動作確認)', () => {
    Meter.setFareConfig({
      base_fare: 1305,
      base_distance_m: 1000,
      add_fare: 100,
      add_distance_m: 420,
      rounding: 10,
      tiers: [],
    });
    // 距離 0 → fare=1305 → Math.round(1305/10)*10 = 1310
    expect(Meter.calcFare(0)).toBe(1310);
  });

  it('rounding=1 (or 0) で整数丸めのみ', () => {
    Meter.setFareConfig({
      base_fare: 1304,
      base_distance_m: 1000,
      add_fare: 100,
      add_distance_m: 420,
      rounding: 1,
      tiers: [],
    });
    expect(Meter.calcFare(0)).toBe(1304);
  });
});

describe('Meter.calcFare 最低/最高料金 clamp (minFare / maxFare)', () => {
  let Meter;
  beforeEach(() => {
    Meter = loadMeter();
  });

  it('minFare=2000 で距離料金 1,300 を 2,000 に底上げ', () => {
    Meter.setFareConfig({
      base_fare: 1300,
      base_distance_m: 1000,
      add_fare: 100,
      add_distance_m: 420,
      rounding: 10,
      tiers: [],
      minFare: 2000,
      maxFare: null,
    });
    expect(Meter.calcFare(0)).toBe(2000);
  });

  it('maxFare=1500 で 5,000m の高額計算を 1,500 に圧縮', () => {
    Meter.setFareConfig({
      base_fare: 1300,
      base_distance_m: 1000,
      add_fare: 100,
      add_distance_m: 420,
      rounding: 10,
      tiers: [],
      minFare: null,
      maxFare: 1500,
    });
    expect(Meter.calcFare(5000)).toBe(1500);
  });
});
