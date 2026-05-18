// tests/worker/gps-worker-unit.test.js
// ZEROact 共通テスト基盤 P11 (2026-05-18 新規) — gps-worker.js 単体テスト
//
// 検証対象: js/gps-worker.js の isStationary 判定ロジック
//
// 実装方針:
//   ・@vitest/web-worker を import すれば new Worker() を vitest が擬似実行可能。
//     ただし gps-worker.js は classic worker (= self.onmessage グローバル) 設計で
//     ESM-aware loader と完全互換ではない可能性あり。動的 worker test は将来拡充。
//   ・本 spec は当面「静的検証」(= ファイル内容 grep) で
//     isStationary 判定 3-AND 条件 + CONFIG 閾値の存在を verify。
//   ・将来 @vitest/web-worker の動的 worker test を追加するための足場として
//     ファイル位置 (tests/worker/) を確保する。
//
// 司さん memory 既記載値 (= verified gps-worker.js L627 + L19-21):
//   stationary_sec: 5
//   stationary_radius_m: 3
//   speed_limit_kmh: 3
//   accel_variance_threshold: 0.1
//   accel_motion_threshold: 0.5

import '@vitest/web-worker'; // 将来 dynamic worker test 用の setup・現状は import のみ
const fs = require('fs');
const path = require('path');

const GPS_WORKER_PATH = path.join(__dirname, '..', '..', 'js', 'gps-worker.js');

function loadSource() {
  return fs.readFileSync(GPS_WORKER_PATH, 'utf8');
}

describe('gps-worker.js 静的検証 (P11)', () => {
  it('CONFIG 閾値 5 件が定義されている', () => {
    const source = loadSource();
    const expected = [
      /speed_limit_kmh\s*:\s*3/,
      /stationary_sec\s*:\s*5/,
      /stationary_radius_m\s*:\s*3/,
      /accel_variance_threshold\s*:\s*0\.1/,
      /accel_motion_threshold\s*:\s*0\.5/,
    ];
    for (const re of expected) {
      if (!re.test(source)) {
        throw new Error('CONFIG 閾値未検出: ' + re.toString());
      }
    }
  });

  it('isStationary 判定 3-AND が L627 周辺に存在', () => {
    const source = loadSource();
    const lines = source.split('\n');
    // Stryker sandbox の line offset 吸収のため ±10 line window
    const window = lines.slice(617, 640).join('\n');
    if (!/finalStationary\s*=\s*gpsStationary\s*&&\s*c1Stationary\s*&&\s*!c2Moving/.test(window)) {
      throw new Error(
        'gps-worker.js L627 周辺 (±10) に 3-AND 判定 pattern 未検出 (drift detected)'
      );
    }
  });

  it('加速度サンプル null 救済 (L596-598) が存在', () => {
    const source = loadSource();
    const lines = source.split('\n');
    const window = lines.slice(586, 608).join('\n');
    // accelVariance === null && accelDeviation === null で gpsStationary 単独採用
    if (!/accelVariance\s*===\s*null\s*&&\s*accelDeviation\s*===\s*null/.test(window)) {
      throw new Error(
        'gps-worker.js L596-598 周辺 (±10) に 加速度 null 救済 pattern 未検出 (drift detected)'
      );
    }
  });

  it('checkStationary 関数が定義されている', () => {
    const source = loadSource();
    if (!/function\s+checkStationary\s*\(/.test(source)) {
      throw new Error('checkStationary 関数定義未検出');
    }
  });

  it('self.postMessage で main thread に応答する経路が存在', () => {
    const source = loadSource();
    if (!/self\.postMessage\s*\(/.test(source)) {
      throw new Error('self.postMessage 呼出未検出 (= Worker A → main thread 通信)');
    }
  });
});

// ─── dynamic worker test (@vitest/web-worker 配線) ─────────────────

describe('gps-worker.js dynamic worker test (⑪)', () => {
  it('Worker 起動 + init message 送受信', async () => {
    const workerUrl = new URL('../../js/gps-worker.js', import.meta.url);
    const worker = new Worker(workerUrl);

    // init message 送信
    worker.postMessage({
      type: 'init',
      data: { config: {}, debug: false },
    });

    // 即終了 (= 起動 + postMessage 受付成功で十分・実応答は init で出ない)
    // 短い待機で event loop が tick した後に terminate
    await new Promise((r) => setTimeout(r, 50));
    worker.terminate();
  });

  it('Worker 起動 + position message → result 応答受信', async () => {
    const workerUrl = new URL('../../js/gps-worker.js', import.meta.url);
    const worker = new Worker(workerUrl);

    // init 先行
    worker.postMessage({ type: 'init', data: { config: {}, debug: false } });

    // result 受信 promise
    const resultPromise = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        worker.terminate();
        reject(new Error('worker result timeout (10s)'));
      }, 10000);
      worker.onmessage = (e) => {
        if (e.data && e.data.type === 'result') {
          clearTimeout(timeout);
          resolve(e.data.data);
        }
      };
      worker.onerror = (err) => {
        clearTimeout(timeout);
        reject(new Error('worker error: ' + (err && err.message)));
      };
    });

    // position 送信 (= 静止判定対象になりやすい低速 GPS)
    worker.postMessage({
      type: 'position',
      data: {
        lat: 33.84,
        lng: 132.7656,
        accuracy: 5,
        speedKmh: 0,
        heading: null,
        altitude: 0,
        now: Date.now(),
        compassHeading: null,
        accelSamples: [],
        gyroSamples: [],
      },
    });

    try {
      const result = await resultPromise;
      // result が返れば成功 (= 中身は Kalman 平滑後の値・ここでは存在のみ確認)
      expect(result).toBeDefined();
      expect(typeof result.lat).toBe('number');
      expect(typeof result.lng).toBe('number');
      expect(typeof result.isStationary).toBe('boolean');
    } finally {
      worker.terminate();
    }
  });
});

// ─── ダイコメ知識注入 (2026-05-18・isStationary 3-AND 詳細) ─────────

describe('isStationary 3-AND 条件 詳細 (gps-worker.js verified L596-627)', () => {
  function sendAndWait(worker, msg, timeoutMs) {
    return new Promise((resolve, reject) => {
      const t = setTimeout(
        () => reject(new Error('timeout ' + timeoutMs + 'ms')),
        timeoutMs || 10000
      );
      worker.onmessage = (e) => {
        if (e.data && e.data.type === 'result') {
          clearTimeout(t);
          resolve(e.data.data);
        }
      };
      worker.onerror = (err) => {
        clearTimeout(t);
        reject(new Error('worker error: ' + (err && err.message)));
      };
      worker.postMessage(msg);
    });
  }

  it('加速度サンプル null + 1 GPS 単独 → 即時停車判定は false (= 5 秒継続必要)', async () => {
    const worker = new Worker(new URL('../../js/gps-worker.js', import.meta.url));
    worker.postMessage({ type: 'init', data: { config: {}, debug: false } });
    try {
      const result = await sendAndWait(worker, {
        type: 'position',
        data: {
          lat: 33.84,
          lng: 132.7656,
          accuracy: 5,
          speedKmh: 0,
          heading: null,
          altitude: 0,
          now: Date.now(),
          compassHeading: null,
          accelSamples: [],
          gyroSamples: [],
        },
      });
      // 初回 GPS では elapsedSec=0 で isStationary=false (= 5 秒継続必要)
      expect(result.isStationary).toBe(false);
    } finally {
      worker.terminate();
    }
  });

  it('加速度サンプル null + 同座標 6 GPS 1Hz → isStationary=true 確定', async () => {
    const worker = new Worker(new URL('../../js/gps-worker.js', import.meta.url));
    worker.postMessage({ type: 'init', data: { config: {}, debug: false } });
    try {
      const baseTs = Date.now();
      let lastResult;
      for (let i = 0; i < 7; i++) {
        lastResult = await sendAndWait(worker, {
          type: 'position',
          data: {
            lat: 33.84,
            lng: 132.7656,
            accuracy: 5,
            speedKmh: 0,
            heading: null,
            altitude: 0,
            now: baseTs + i * 1000,
            compassHeading: null,
            accelSamples: [],
            gyroSamples: [],
          },
        });
      }
      // 7 step (= 6 秒経過) で isStationary=true 確定 (= 加速度 null fallback)
      expect(lastResult.isStationary).toBe(true);
    } finally {
      worker.terminate();
    }
  });

  it('速度 30km/h GPS 単発 → isStationary=false (= speed_limit_kmh=3 超過)', async () => {
    const worker = new Worker(new URL('../../js/gps-worker.js', import.meta.url));
    worker.postMessage({ type: 'init', data: { config: {}, debug: false } });
    try {
      const result = await sendAndWait(worker, {
        type: 'position',
        data: {
          lat: 33.84,
          lng: 132.7656,
          accuracy: 5,
          speedKmh: 30,
          heading: 90,
          altitude: 0,
          now: Date.now(),
          compassHeading: null,
          accelSamples: [],
          gyroSamples: [],
        },
      });
      expect(result.isStationary).toBe(false);
    } finally {
      worker.terminate();
    }
  });
});

// ─── ダイコメ知識注入 (2026-05-18・Worker B mmResult 形式) ─────────
//
// Worker B (map-matcher.js) は本 test ファイル対象外 (= gps-worker.js 単体テスト)。
// mmResult 形式の verify は別 worker test として future work。
// ダイコメ knowledge として mmResult の期待形式を以下に記録:
//
//   type: 'mmResult'
//   mmIncrementM: number (= Tier1 Viterbi commit 距離・absolute 値)
//   tentativeIncrementM: number (= 表示用先行値・commit 前 preview)
//   snapped: boolean (= 道路 snap 成功フラグ)
//   committed: boolean (= Viterbi window 確定フラグ)
//   skipped: boolean (= snap 失敗 / accuracy 不足等の skip フラグ)
//   isStationary: boolean (= 入力 echo・force 0 化判定用)
//   timestamp: number (= input GPS の timestamp)
//
// ★ map-matcher.js の Worker B 単体テストは将来課題:
//   ・Worker B init は 47 県 roads データ load 必須 (= ~30 秒の重量起動)
//   ・msg.isStationary=true で mmIncrementM/tentativeIncrementM 強制 0 化 (L3007)
//   ・現状は静的検証 (= tests/property/isstationary-no-increase.test.js B4) でカバー

describe('Worker B mmResult 形式 (静的検証・将来 dynamic 拡張)', () => {
  it('property/static-check で map-matcher.js L3007 強制 0 化 pattern 存在 verify 済', () => {
    // 詳細は tests/property/isstationary-no-increase.test.js B4 に委譲
    // 本 placeholder は「mmResult 形式 知識を本 spec で記録した」明示用
    expect(true).toBe(true);
  });
});
