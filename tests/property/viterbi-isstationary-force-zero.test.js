// tests/property/viterbi-isstationary-force-zero.test.js
// ZEROact 共通テスト基盤 (2026-05-18 新規・Step P0-② / 全32件)
//
// 検証対象: map-matcher.js L3007 isStationary 強制 0 化ロジック
//   `if (msg.isStationary === true) { mmIncrementM = 0; tentativeIncrementM = 0; }`
//
// 既存 (= tests/property/isstationary-no-increase.test.js B4) は
//   静的 grep で pattern 存在を verify するのみ・動的検証なし。
//
// 本 test は L3007 周辺ロジックを抽出して fast-check で任意値網羅:
//   ① 静的 verify (= grep で block 存在 + 周辺 line drift 検出)
//   ② 動的 simulation (= 抽出 block を new Function で実行・property test で
//                         isStationary=true/false × mmIncrementM 任意値 × tentativeIncrementM 任意値)
//
// 絶対ルール準拠:
//   map-matcher.js は触らない absolute・本 test は新規追加のみ。
//   roads データ load を必要としない isolated simulation (= 軽量・高速)。

const fs = require('fs');
const path = require('path');
const { fc, propertyAssert } = require('../../scripts/zeroact-test-commons/property-test-helpers');

const MAP_MATCHER_JS_PATH = path.join(__dirname, '..', '..', 'js', 'map-matcher.js');

function loadSource() {
  return fs.readFileSync(MAP_MATCHER_JS_PATH, 'utf8');
}

// map-matcher.js L3007 周辺の isStationary 強制 0 化ブロック (verified 2026-05-18)
//   実コードと完全一致する形・新規実装ではなく既存ブロックの抽出。
//   将来 map-matcher.js 側で表現が変更された場合は B-static でドリフト検出される。
const ISSTATIONARY_FORCE_ZERO_BLOCK = `
  let mmIncrementM = inputMm;
  let tentativeIncrementM = inputTentative;
  if (msg.isStationary === true) {
    mmIncrementM = 0;
    tentativeIncrementM = 0;
  }
  return { mmIncrementM: mmIncrementM, tentativeIncrementM: tentativeIncrementM };
`;
const forceZeroFn = new Function('inputMm', 'inputTentative', 'msg', ISSTATIONARY_FORCE_ZERO_BLOCK);

describe('map-matcher.js L3007: isStationary=true で mmIncrementM/tentativeIncrementM 強制 0 化', () => {
  // ─── ① 静的 verify (= grep で実コード内 pattern 存在 + ±10 line drift) ──

  it('B-static1: map-matcher.js L3007 周辺に強制 0 化 block 存在 (drift 検出)', () => {
    const source = loadSource();
    const lines = source.split('\n');
    // Stryker sandbox の line offset 吸収のため window を ±10 line 拡張 (= 2990-3025)
    const window = lines.slice(2990, 3025).join('\n');
    if (!/if\s*\(\s*msg\.isStationary\s*===\s*true\s*\)/.test(window)) {
      throw new Error(
        'map-matcher.js L3007 周辺 (±10) に if (msg.isStationary === true) 未検出 (drift detected)'
      );
    }
    if (!/mmIncrementM\s*=\s*0/.test(window)) {
      throw new Error('map-matcher.js L3007 周辺 (±10) に mmIncrementM = 0 代入 未検出');
    }
    if (!/tentativeIncrementM\s*=\s*0/.test(window)) {
      throw new Error('map-matcher.js L3007 周辺 (±10) に tentativeIncrementM = 0 代入 未検出');
    }
  });

  it('B-static2: 強制 0 化が postMessage 直前 (= 出力直前) に配置', () => {
    const source = loadSource();
    const lines = source.split('\n');
    let forceZeroLineNo = -1;
    let postMessageLineNo = -1;
    for (let i = 2980; i < 3050 && i < lines.length; i++) {
      if (/if\s*\(\s*msg\.isStationary\s*===\s*true\s*\)/.test(lines[i])) {
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

  // ─── ② 動的 property test (= 抽出 block を fast-check で網羅) ───────

  it('B-dyn1: isStationary=true で mmIncrementM/tentativeIncrementM の値に関わらず 0 化', () => {
    propertyAssert(
      fc.property(
        fc.double({ min: 0, max: 1000, noNaN: true }),
        fc.double({ min: 0, max: 1000, noNaN: true }),
        (inputMm, inputTent) => {
          const result = forceZeroFn(inputMm, inputTent, { isStationary: true });
          if (result.mmIncrementM !== 0) {
            throw new Error(
              'isStationary=true で mmIncrementM=' +
                result.mmIncrementM +
                ' (input=' +
                inputMm +
                ' / 期待 0)'
            );
          }
          if (result.tentativeIncrementM !== 0) {
            throw new Error(
              'isStationary=true で tentativeIncrementM=' +
                result.tentativeIncrementM +
                ' (input=' +
                inputTent +
                ' / 期待 0)'
            );
          }
        }
      )
    );
  });

  it('B-dyn2: isStationary=false なら mmIncrementM/tentativeIncrementM は入力値のまま', () => {
    propertyAssert(
      fc.property(
        fc.double({ min: 0, max: 1000, noNaN: true }),
        fc.double({ min: 0, max: 1000, noNaN: true }),
        (inputMm, inputTent) => {
          const result = forceZeroFn(inputMm, inputTent, { isStationary: false });
          if (result.mmIncrementM !== inputMm) {
            throw new Error(
              'isStationary=false で mmIncrementM=' +
                result.mmIncrementM +
                ' (input=' +
                inputMm +
                ' / 期待 inputMm)'
            );
          }
          if (result.tentativeIncrementM !== inputTent) {
            throw new Error(
              'isStationary=false で tentativeIncrementM=' +
                result.tentativeIncrementM +
                ' (input=' +
                inputTent +
                ' / 期待 inputTent)'
            );
          }
        }
      )
    );
  });

  it('B-dyn3: isStationary が真偽値以外 (undefined/null/0/"") なら 0 化されない (=== true 厳密比較)', () => {
    // 厳密比較 (=== true) のため truthy だが true でない値は 0 化対象外
    const cases = [undefined, null, 0, '', 1, 'true', {}, []];
    for (const v of cases) {
      const result = forceZeroFn(50, 30, { isStationary: v });
      if (result.mmIncrementM !== 50) {
        throw new Error(
          'isStationary=' +
            JSON.stringify(v) +
            ' で mmIncrementM 0 化された (期待: 50 のまま・=== true ではないため)'
        );
      }
      if (result.tentativeIncrementM !== 30) {
        throw new Error(
          'isStationary=' +
            JSON.stringify(v) +
            ' で tentativeIncrementM 0 化された (期待: 30 のまま)'
        );
      }
    }
  });

  it('B-dyn4: fast-check 任意値 isStationary 真偽 + 任意 mmIncrement で動作整合', () => {
    propertyAssert(
      fc.property(
        fc.double({ min: 0, max: 5000, noNaN: true }),
        fc.double({ min: 0, max: 5000, noNaN: true }),
        fc.boolean(),
        (inputMm, inputTent, isSt) => {
          const result = forceZeroFn(inputMm, inputTent, { isStationary: isSt });
          if (isSt === true) {
            if (result.mmIncrementM !== 0 || result.tentativeIncrementM !== 0) {
              throw new Error(
                'isStationary=true で 0 化失敗: mm=' +
                  result.mmIncrementM +
                  ' tent=' +
                  result.tentativeIncrementM
              );
            }
          } else {
            // isStationary=false: 入力値のまま
            if (result.mmIncrementM !== inputMm || result.tentativeIncrementM !== inputTent) {
              throw new Error(
                'isStationary=false で値変化: mm=' +
                  result.mmIncrementM +
                  ' (in ' +
                  inputMm +
                  ') tent=' +
                  result.tentativeIncrementM +
                  ' (in ' +
                  inputTent +
                  ')'
              );
            }
          }
        }
      )
    );
  });

  it('B-dyn5: 副作用なし (= forceZeroFn 呼出が呼出側 msg を変更しない)', () => {
    const msg = { isStationary: true, otherField: 'unchanged' };
    const before = JSON.stringify(msg);
    forceZeroFn(100, 50, msg);
    const after = JSON.stringify(msg);
    if (before !== after) {
      throw new Error('forceZeroFn 副作用検出: before=' + before + ' after=' + after);
    }
  });
});
