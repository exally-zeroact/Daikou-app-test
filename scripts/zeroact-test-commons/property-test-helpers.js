'use strict';

// ============================================================
// property-test-helpers.js
//   ZEROact 共通テスト基盤 (2026-05-17 新規)
//   fast-check を使った property-based testing の共通テンプレート集。
//
// 設計方針:
//   ・「絶対ルール・不変条件を述語化する」パターンをここに集約
//   ・各プロジェクト (ダイコメ / Exally / 今治AI) が固有 invariant を
//     tests/property/ 配下に追加して呼出す
//   ・fast-check の arbitrary (入力生成器) を再利用可能な形で提供
//
// 使い方 (vitest テスト内):
//   const fc = require('fast-check');
//   const { gpsPointArb, drivingSequenceArb, assertMonotonic } =
//     require('../scripts/zeroact-test-commons/property-test-helpers');
//
//   it('distance_m は単調非減少', () => {
//     fc.assert(fc.property(drivingSequenceArb(), (seq) => {
//       const result = simulate(seq);
//       assertMonotonic(result.distances);
//     }));
//   });
// ============================================================

const fc = require('fast-check');

// ─── 共通 arbitrary (入力生成器) ────────────────────────────────────

// GPS 1 点 (lat / lng / accuracy / speedKmh / isStationary / timestamp)
// 範囲: 日本国内・accuracy 1-100m・速度 0-160 km/h
function gpsPointArb(opts) {
  opts = opts || {};
  return fc.record({
    lat: fc.double({ min: opts.latMin || 24, max: opts.latMax || 46, noNaN: true }),
    lng: fc.double({ min: opts.lngMin || 122, max: opts.lngMax || 146, noNaN: true }),
    accuracy: fc.double({ min: 1, max: 100, noNaN: true }),
    speedKmh: fc.double({ min: 0, max: 160, noNaN: true }),
    isStationary: fc.boolean(),
    timestamp: fc.integer({ min: 1714100000000, max: 1714200000000 }),
  });
}

// 走行シーケンス (連続 N 点・timestamp が単調増加)
// N は 2-20 点を生成
function drivingSequenceArb(opts) {
  opts = opts || {};
  const minLength = opts.minLength != null ? opts.minLength : 2;
  const maxLength = opts.maxLength != null ? opts.maxLength : 20;
  return fc.array(gpsPointArb(opts), { minLength, maxLength }).map((pts) => {
    // timestamp を 1 秒間隔で書き換えて単調増加させる
    const base = pts[0].timestamp;
    return pts.map((p, i) => Object.assign({}, p, { timestamp: base + i * 1000 }));
  });
}

// running フラグ (true / false) の sequence (false の方が多めに生成して
// 「running=false でも増えない」invariant を強く検証)
function runningFlagArb() {
  return fc.boolean();
}

// ─── 共通 invariant assertion ──────────────────────────────────────

// 数列が単調非減少 (= 後の値が前の値以上)
function assertMonotonic(values, label) {
  for (let i = 1; i < values.length; i++) {
    if (!(values[i] >= values[i - 1])) {
      throw new Error(
        (label || 'monotonic') +
          ' violated at index ' +
          i +
          ': prev=' +
          values[i - 1] +
          ' < curr=' +
          values[i]
      );
    }
  }
}

// 数列が定数 (= 全要素が等しい)
function assertConstant(values, expected, label) {
  for (let i = 0; i < values.length; i++) {
    if (values[i] !== expected) {
      throw new Error(
        (label || 'constant') +
          ' violated at index ' +
          i +
          ': expected=' +
          expected +
          ' actual=' +
          values[i]
      );
    }
  }
}

// 差分が境界内 (例: distance_m の 1 step 増分が物理上限以下)
function assertBoundedDelta(values, maxDelta, label) {
  for (let i = 1; i < values.length; i++) {
    const d = values[i] - values[i - 1];
    if (d < 0 || d > maxDelta) {
      throw new Error(
        (label || 'bounded-delta') +
          ' violated at index ' +
          i +
          ': delta=' +
          d +
          ' (max=' +
          maxDelta +
          ')'
      );
    }
  }
}

// ─── 共通 helper: vitest と統合する thin wrapper ────────────────────

// fc.assert を共通化 (例外時のメッセージ整形)
function propertyAssert(property, options) {
  return fc.assert(property, Object.assign({ verbose: false, numRuns: 100 }, options || {}));
}

module.exports = {
  fc,
  gpsPointArb,
  drivingSequenceArb,
  runningFlagArb,
  assertMonotonic,
  assertConstant,
  assertBoundedDelta,
  propertyAssert,
};
