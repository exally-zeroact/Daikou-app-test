// tests/drift-static/viterbi-isStationary-anchor.test.js
//
// ★設計変更宣言 Phase 6-7 (2026-05-21・(M) 分離・司さん採択):
//   旧: tests/property/viterbi-isstationary-force-zero.test.js 内に・行アンカー線 ±10 の
//       静的 grep (B-static1 / B-static2) が混在。
//   新: 本 file へ切出し・通常 vitest では実行・Stryker run では exclude。
//
//   block コードは旧 file から **byte 不変** で移動。
//
//   旧 file 由来 (= tests/property/viterbi-isstationary-force-zero.test.js):
//     B-static1 → 本 file の it 'B-static1'
//     B-static2 → 本 file の it 'B-static2'

'use strict';

const fs = require('fs');
const path = require('path');

const MAP_MATCHER_JS_PATH = path.join(__dirname, '..', '..', 'js', 'map-matcher.js');

function loadSource() {
  return fs.readFileSync(MAP_MATCHER_JS_PATH, 'utf8');
}

describe('drift-static: map-matcher.js L3007 isStationary 強制 0 化 block 位置 (旧 viterbi-isstationary-force-zero.test.js B-static1/B-static2)', () => {
  it('B-static1: map-matcher.js L3007 周辺に強制 0 化 block 存在 (drift 検出)', () => {
    const source = loadSource();
    const lines = source.split('\n');
    // Stryker sandbox の line offset 吸収のため window を ±10 line 拡張
    // 2026-05-26 Phase A+B (map-matcher tentativeDistanceM +28行) で block が L3035 へ移動・window 同期
    // 2026-05-27 Phase2-a (gap routing guard + 定数追加) で block が L3085 へ移動・window 同期
    // 2026-05-29 partial commit 早期化 (raw haver tentative ~50 行追加) で block が L3121 へ移動・window 同期
    // 2026-05-29 PM real-trace 残存 creep 解析 (= freeze 条件拡張 effectively stationary):
    //   旧: if (msg.isStationary === true) で freeze
    //   新: const _effectivelyStationary = msg.isStationary === true || _lowSpeed; if (_effectivelyStationary)
    //   anchor regex / pattern を新 block 構造に合わせ更新・window slice 同期 (= L3159 へ移動)。
    // 2026-05-30 白紙書き直し 第四弾 (= pipeline-distance 並列統合・importScripts + tracker manager ~58 行
    //   を上流に additive 追加): block が L3251 へ移動・window slice を (3240,3300) へ同期。
    //   freeze block (= mmIncrementM=0 / tentativeIncrementM=0 / _effectivelyStationary 宣言) は prod 1byte 不変。
    const window = lines.slice(3240, 3300).join('\n');
    if (!/if\s*\(\s*_effectivelyStationary\s*\)/.test(window)) {
      throw new Error(
        'map-matcher.js L3147 周辺 (±10) に if (_effectivelyStationary) 未検出 (drift detected)'
      );
    }
    if (!/mmIncrementM\s*=\s*0/.test(window)) {
      throw new Error('map-matcher.js L3147 周辺 (±10) に mmIncrementM = 0 代入 未検出');
    }
    if (!/tentativeIncrementM\s*=\s*0/.test(window)) {
      throw new Error('map-matcher.js L3147 周辺 (±10) に tentativeIncrementM = 0 代入 未検出');
    }
    if (
      !/_effectivelyStationary\s*=\s*msg\.isStationary\s*===\s*true\s*\|\|\s*_lowSpeed/.test(window)
    ) {
      throw new Error(
        'map-matcher.js L3147 周辺 (±10) に _effectivelyStationary 宣言 (= isStationary OR _lowSpeed) 未検出'
      );
    }
  });

  it('B-static2: 強制 0 化が postMessage 直前 (= 出力直前) に配置', () => {
    const source = loadSource();
    const lines = source.split('\n');
    let forceZeroLineNo = -1;
    let postMessageLineNo = -1;
    // 2026-05-29 PM: anchor pattern を if (_effectivelyStationary) へ更新・range も同期で拡張
    // 2026-05-30 白紙書き直し 第四弾 (= pipeline-distance 並列統合): block が L3251 へ移動・range を 3240..3310 へ同期。
    for (let i = 3240; i < 3310 && i < lines.length; i++) {
      if (/if\s*\(\s*_effectivelyStationary\s*\)/.test(lines[i])) {
        forceZeroLineNo = i + 1;
      }
      if (forceZeroLineNo > 0 && /self\.postMessage\s*\(/.test(lines[i])) {
        postMessageLineNo = i + 1;
        break;
      }
    }
    if (forceZeroLineNo < 0) {
      throw new Error('isStationary 強制 0 化 block 未検出');
    }
    if (postMessageLineNo < 0) {
      throw new Error('postMessage 呼出未検出 (= 強制 0 化後の出力経路欠落)');
    }
    if (postMessageLineNo <= forceZeroLineNo) {
      throw new Error(
        '配置違反: 強制 0 化 (L' +
          forceZeroLineNo +
          ') の前に postMessage (L' +
          postMessageLineNo +
          ') が来ている'
      );
    }
    // 出力直前 (= 30 line 以内) に配置されていることを確認
    if (postMessageLineNo - forceZeroLineNo > 30) {
      throw new Error(
        '強制 0 化と postMessage の距離が大きすぎる (' +
          (postMessageLineNo - forceZeroLineNo) +
          ' lines)・出力経路に副作用が挿入された可能性'
      );
    }
  });
});
