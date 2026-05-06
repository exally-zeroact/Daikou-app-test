#!/usr/bin/env node
/**
 * build-bundle-coastline-jp.js
 *
 * 海岸線（簡略）を data/coastline-jp.js に出力。
 *
 * 取得元（要追加実装）:
 *   - KSJ C23 海岸線（URL未確定・カタログ要確認）
 *   - 国土地理院 基盤地図情報 海岸線
 *   - OSM `natural=coastline` (Geofabrik から抽出)
 *
 * 現状: 空のプレースホルダ（取得元確定後に実装）
 */
const path = require('path');
const u = require('./bundle-utils.js');

const PROJECT_ROOT = path.join(__dirname, '..');
const OUT = path.join(PROJECT_ROOT, 'data', 'coastline-jp.js');

const data = {
  v: 1,
  generated: new Date().toISOString(),
  precision: u.PRECISION,
  lines: [],
  source: 'STUB: KSJ C23 / 国土地理院 / OSM natural=coastline 要追加実装',
  note: 'STUB: 海岸線データ未統合・本番は OSM Geofabrik 抽出 + 簡略化を実装予定',
};

const size = u.writeBundleJs(OUT, 'COASTLINE_JP', data, [
  `// ⚠️ STUB プレースホルダ: 海岸線データ未統合`,
  `// 実装方針: OSM way[natural=coastline] を Geofabrik から抽出 → DP簡略化`,
]);
console.log(`✅ ${OUT}  STUB size=${(size/1024).toFixed(2)} KB`);
