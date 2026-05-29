// tests/drift-static/meter-isStationary-anchor.test.js
//
// ★設計変更宣言 Phase 6-7 (2026-05-21・(M) 分離・司さん採択):
//   旧: tests/property/isstationary-no-increase.test.js 内に・行アンカー線 ±10 の
//       静的 grep (B3 / B4) が混在。Stryker instrumentation で sandbox copy の行が
//       シフトし dry-run で false-fail していた。
//   新: 線アンカー block を本 file (= tests/drift-static/) に切出し・通常 vitest では
//       本 file を実行 (= 厳格度 ±10 完全保持) し・Stryker run では本 dir を exclude する
//       (= vitest.stryker.config.js exclude: 'tests/drift-static/**')。
//
//   絶対前提:
//     ・block コードは旧 file から **byte 不変** で移動 (= window slice index / regex /
//       error message / LINE_TOLERANCE すべて同一)
//     ・通常 CI (= npm test) で本 file が走り・行アンカー ±10 で同じ assertion 実行
//     ・mutation testing (= stryker) では sandbox 行シフト由来 false-fail を回避
//     ・prod 完全無変更 (= js/meter.js / js/map-matcher.js 1 byte も触らない)
//
//   旧 file 由来 (= tests/property/isstationary-no-increase.test.js):
//     describe '経路 1' の B3 → 本 file の it 'B3'
//     describe '経路 2' の B4 → 本 file の it 'B4'

'use strict';

const fs = require('fs');
const path = require('path');

const METER_JS_PATH = path.join(__dirname, '..', '..', 'js', 'meter.js');
const MAP_MATCHER_JS_PATH = path.join(__dirname, '..', '..', 'js', 'map-matcher.js');

function loadSource(filePath) {
  return fs.readFileSync(filePath, 'utf8');
}

describe('drift-static: meter.js L790 / map-matcher.js L3007 isStationary 早期 return (旧 isstationary-no-increase.test.js B3/B4)', () => {
  it('B3: meter.js L790 に update() 入口 isStationary 早期 return が存在', () => {
    const source = loadSource(METER_JS_PATH);
    const lines = source.split('\n');
    // L790 周辺で `if (gpsResult.isStationary)` パターン + early return を確認
    // Stryker sandbox の line offset 吸収のため window を ±10 line 拡張
    // 2026-05-18 更新 (Phase 3): L839 → L867 (+28) 移動・window 同期。
    // 2026-05-19 R1 更新 (Off-Road grace period): L867 → L884 (+17) 移動・window 同期。
    // 2026-05-24 更新 (道路 snap 構成・ZUPT helper 追加): L884 → L950 (+66) 移動・window 同期。
    // 2026-05-24 更新 (business preview 別回路・state 追加 + 別 if ブロック): L950 → L1006 (+56) 移動。
    // 2026-05-24 更新 (表示層 予測補間・state 追加 + 別ブロック): L1006 → L1039 (+33) 移動。
    // 2026-05-28 STEP0 診断 (_mmDbg helper + 診断call追加) で L1066 へ移動・window 同期。
    // 2026-05-28 PM mirror アーキ完成 (= mm/retro 経路に ZUPT 並記コメント追加) で L1095 へ移動・window 同期。
    // 2026-05-28 PM (例外条項適用) gap fill sanity check 追加で L1133 へ移動・window 同期。
    // 2026-05-28 PM Phase 3 (α-β filter + helper ~70 行追加) で L1202 へ移動・window 同期。
    // 2026-05-28 PM 再構築 (= Google MM 式統一・α-β filter 削除) で L1141 へ戻る・window 同期。
    // 2026-05-30 白紙書き直し 第四弾 (= pipeline-distance 並列統合・state/格納コメント +18 行上流追加) で
    //   block が L1160 へ移動・window slice を (1150,1180) へ同期 (= prod の if(gpsResult.isStationary) は 1byte 不変)。
    const window = lines.slice(1150, 1180).join('\n');
    if (!/if\s*\(\s*gpsResult\.isStationary\s*\)/.test(window)) {
      throw new Error(
        'meter.js L790 周辺 (±10) に if (gpsResult.isStationary) パターン未検出 (drift detected)'
      );
    }
    if (!/_updateMapMatching\s*\(\s*gpsResult\s*\)/.test(window)) {
      throw new Error('meter.js L790 周辺 (±10) に _updateMapMatching(gpsResult) 呼出 未検出');
    }
    if (!/return\s*;/.test(window)) {
      throw new Error('meter.js L790 周辺 (±10) に early return ; 未検出');
    }
  });

  it('B4: map-matcher.js L3007 に msg.isStationary 強制 0 化 pattern が存在', () => {
    const source = loadSource(MAP_MATCHER_JS_PATH);
    const lines = source.split('\n');
    // L3007 周辺で if (msg.isStationary === true) { mmIncrementM = 0; tentativeIncrementM = 0; }
    // Stryker sandbox の line offset 吸収のため window を ±10 line 拡張
    // 2026-05-26 Phase A+B (map-matcher tentativeDistanceM +28行) で block が L3035 へ移動・window 同期
    // 2026-05-27 Phase2-a (gap routing guard + 定数追加) で block が L3085 へ移動・window 同期
    // 2026-05-29 partial commit 早期化で block が L3121 へ移動・window 同期
    // 2026-05-29 PM real-trace 残存 creep 解析 (= freeze 条件拡張): block が L3159 / pattern も
    //   if (_effectivelyStationary) へ更新・window slice 同期。
    // 2026-05-30 白紙書き直し 第四弾 (= pipeline-distance 並列統合): importScripts + tracker manager
    //   (~58 行) を上流に additive 追加で block が L3251 へ移動・window slice を (3240,3300) へ同期。
    //   freeze block (= mmIncrementM=0 / tentativeIncrementM=0) は prod 1byte 不変・並列 ingest は freeze 上流。
    const window = lines.slice(3240, 3300).join('\n');
    if (!/if\s*\(\s*_effectivelyStationary\s*\)/.test(window)) {
      throw new Error(
        'map-matcher.js L3147 周辺 (±10) に if (_effectivelyStationary) pattern 未検出 (drift detected)'
      );
    }
    if (!/mmIncrementM\s*=\s*0/.test(window)) {
      throw new Error('map-matcher.js L3147 周辺 (±10) に mmIncrementM = 0 代入 未検出');
    }
    if (!/tentativeIncrementM\s*=\s*0/.test(window)) {
      throw new Error('map-matcher.js L3147 周辺 (±10) に tentativeIncrementM = 0 代入 未検出');
    }
  });
});
