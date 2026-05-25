// tests/integration/sensor-gps-warmup.test.js
//
// ★設計変更宣言 (2026-05-25・S1+S2+S3 センサー / GPS / Worker A 先行起動):
//   タイミング前倒し・並列化のみ。距離取得パラメータ・isStationary 判定本体・
//   accelBuffer / gyroBuffer サンプリングは・1 byte 不変。
//
// 検証内容 (= static source verify):
//   1. gps.js: _WATCH_OPTIONS (= enableHighAccuracy / timeout / maximumAge) 1 byte 不変
//   2. gps.js: initWorker が・public API に・追加 (= 重複 spawn 防止 if (!worker) gate 維持)
//   3. gps.js: accelBuffer / gyroBuffer の・上限 200 / サンプリング: 1 byte 不変
//   4. gps.js: _isBizActive で・データ蓄積 gate (= 既存維持・業務前は蓄積しない)
//   5. index.html: _earlyWarmupSensorsAndGps 関数定義
//   6. index.html: DOMContentLoaded で・呼出
//   7. index.html: 関数内で・GPS.initWorker / GPS.startCompass / GPS.startMotion / Meter.updateGpsOnly 呼出
//   8. index.html: permission gate (= localStorage 'compass_granted' / 'motion_granted' === '1') で・先行登録
//   9. index.html: gpsStarted=false 維持 (= 本関数で watchPosition 開始しない)

'use strict';

const fs = require('fs');
const path = require('path');

let gpsSrc;
let html;
beforeAll(() => {
  gpsSrc = fs.readFileSync(path.join(__dirname, '..', '..', 'js', 'gps.js'), 'utf8');
  html = fs.readFileSync(path.join(__dirname, '..', '..', 'index.html'), 'utf8');
});

describe('1. gps.js _WATCH_OPTIONS 1 byte 不変', () => {
  it('enableHighAccuracy: true 維持', () => {
    expect(gpsSrc).toMatch(
      /const _WATCH_OPTIONS\s*=\s*\{\s*enableHighAccuracy:\s*true,\s*timeout:\s*3000,\s*maximumAge:\s*0\s*\}/
    );
  });

  it('maximumAge: 0 維持 (= 課金根拠 重要)', () => {
    expect(gpsSrc).toMatch(/maximumAge:\s*0/);
  });

  it('timeout: 3000 維持', () => {
    expect(gpsSrc).toMatch(/timeout:\s*3000/);
  });
});

describe('2. gps.js initWorker public API 追加', () => {
  it('initWorker が・return オブジェクトに・含まれる (= 末尾 export)', () => {
    // return { ... initWorker, } pattern (= 末尾配置)
    const m = gpsSrc.match(/return\s*\{[\s\S]*?initWorker[\s\S]*?\};/);
    expect(m).not.toBeNull();
  });

  it('initWorker 関数定義は・1 byte 不変 (= function initWorker)', () => {
    expect(gpsSrc).toMatch(/function initWorker\(\)\s*\{/);
  });
});

describe('3. gps.js accelBuffer / gyroBuffer 上限 1 byte 不変', () => {
  it('accelBuffer 上限 200 維持', () => {
    expect(gpsSrc).toMatch(/if \(accelBuffer\.length > 200\) accelBuffer\.shift\(\)/);
  });

  it('gyroBuffer 上限 200 維持', () => {
    expect(gpsSrc).toMatch(/if \(gyroBuffer\.length > 200\) gyroBuffer\.shift\(\)/);
  });
});

describe('4. gps.js _isBizActive 蓄積 gate 1 byte 不変', () => {
  it('startMotion 内で・_isBizActive=false なら early return (= 蓄積しない)', () => {
    // window.addEventListener('devicemotion', ...) の・冒頭に・if (!_isBizActive) return
    expect(gpsSrc).toMatch(
      /addEventListener\(\s*['"]devicemotion['"]\s*,[\s\S]*?if \(!_isBizActive\) return/
    );
  });
});

describe('5. index.html _earlyWarmupSensorsAndGps 関数定義', () => {
  it('_earlyWarmupSensorsAndGps 関数定義あり', () => {
    expect(html).toMatch(/function _earlyWarmupSensorsAndGps\(\)\s*\{/);
  });
});

describe('6. index.html DOMContentLoaded で・先行起動呼出', () => {
  it('DOMContentLoaded で・_earlyWarmupSensorsAndGps 呼出', () => {
    expect(html).toMatch(
      /document\.addEventListener\(['"]DOMContentLoaded['"],\s*_earlyWarmupSensorsAndGps\)/
    );
  });

  it('readyState === "loading" 時の・ガード分岐あり', () => {
    expect(html).toMatch(/if \(document\.readyState === ['"]loading['"]\)/);
  });
});

describe('7. _earlyWarmupSensorsAndGps 関数内・S1+S2+S3 呼出', () => {
  let funcBlock;
  beforeAll(() => {
    const m = html.match(/function _earlyWarmupSensorsAndGps\(\)\s*\{[\s\S]*?\n\s\s\s\s\s\s\}/);
    funcBlock = m ? m[0] : '';
  });

  it('S2: GPS.initWorker 呼出 (= Worker A 先行 spawn)', () => {
    expect(funcBlock).toMatch(/GPS\.initWorker\(\)/);
  });

  it('S1: GPS.startCompass 呼出 (= リスナー先行登録)', () => {
    expect(funcBlock).toMatch(/GPS\.startCompass\(\)/);
  });

  it('S1: GPS.startMotion 呼出', () => {
    expect(funcBlock).toMatch(/GPS\.startMotion\(\)/);
  });

  it('S3: Meter.updateGpsOnly 呼出 (= lastWarmupGps prime)', () => {
    expect(funcBlock).toMatch(/Meter\.updateGpsOnly/);
  });

  it('S3: getCurrentPosition 呼出 (= 先行 prime・既存 _WATCH_OPTIONS 同等値)', () => {
    expect(funcBlock).toMatch(/navigator\.geolocation\.getCurrentPosition/);
    // 既存 _WATCH_OPTIONS と同等 (= enableHighAccuracy:true / timeout:3000 / maximumAge:0)
    expect(funcBlock).toMatch(/enableHighAccuracy:\s*true/);
    expect(funcBlock).toMatch(/timeout:\s*3000/);
    expect(funcBlock).toMatch(/maximumAge:\s*0/);
  });
});

describe('8. permission gate (= localStorage 既存済 のみ・先行登録)', () => {
  let funcBlock;
  beforeAll(() => {
    const m = html.match(/function _earlyWarmupSensorsAndGps\(\)\s*\{[\s\S]*?\n\s\s\s\s\s\s\}/);
    funcBlock = m ? m[0] : '';
  });

  it("compass_granted === '1' check で・GPS.startCompass 呼出", () => {
    expect(funcBlock).toMatch(/localStorage\.getItem\(['"]compass_granted['"]\)\s*===\s*['"]1['"]/);
  });

  it("motion_granted === '1' check で・GPS.startMotion 呼出", () => {
    expect(funcBlock).toMatch(/localStorage\.getItem\(['"]motion_granted['"]\)\s*===\s*['"]1['"]/);
  });
});

describe('9. gpsStarted=false 維持 (= 本関数で watchPosition 開始しない)', () => {
  let funcBlock;
  beforeAll(() => {
    const m = html.match(/function _earlyWarmupSensorsAndGps\(\)\s*\{[\s\S]*?\n\s\s\s\s\s\s\}/);
    funcBlock = m ? m[0] : '';
  });

  it('GPS.start 呼出は・本関数内に・なし (= startGPS で・初起動)', () => {
    expect(funcBlock).not.toMatch(/GPS\.start\(/);
  });

  it('gpsStarted=true への代入は・本関数内に・なし', () => {
    expect(funcBlock).not.toMatch(/gpsStarted\s*=\s*true/);
  });

  it('startGPS\\(\\) 呼出は・本関数内に・なし (= 既存 startGPS フロー維持)', () => {
    expect(funcBlock).not.toMatch(/startGPS\(\)/);
  });
});

describe('10. 不可侵境界 verify (= distance_m / 課金経路 1 byte 不変)', () => {
  let funcBlock;
  beforeAll(() => {
    const m = html.match(/function _earlyWarmupSensorsAndGps\(\)\s*\{[\s\S]*?\n\s\s\s\s\s\s\}/);
    funcBlock = m ? m[0] : '';
  });

  it('本関数内・state.distance_m / business_distance_m に・write しない', () => {
    expect(funcBlock).not.toMatch(/state\.distance_m\s*=/);
    expect(funcBlock).not.toMatch(/business_distance_m\s*=/);
  });

  it('本関数内・Meter.setDistance / setBusinessDistance / start 等・距離変更 API なし', () => {
    expect(funcBlock).not.toMatch(/Meter\.setDistance/);
    expect(funcBlock).not.toMatch(/Meter\.setBusinessDistance/);
    expect(funcBlock).not.toMatch(/Meter\.start\(/);
  });

  it('本関数内・Meter API は・updateGpsOnly のみ (= lastWarmupGps prime 専用・課金不変)', () => {
    const meterCalls = funcBlock.match(/Meter\.\w+/g) || [];
    const uniqueMeterCalls = [...new Set(meterCalls)];
    expect(uniqueMeterCalls.length).toBeLessThanOrEqual(1);
    if (uniqueMeterCalls.length === 1) {
      expect(uniqueMeterCalls[0]).toBe('Meter.updateGpsOnly');
    }
  });
});
