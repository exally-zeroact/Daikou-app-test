#!/usr/bin/env node
/**
 * build-bundle-emergency-medical-jp.js
 *
 * 災害拠点病院 759箇所 data/emergency-medical-jp.js
 *
 * 取得元（要追加実装）:
 *   - 厚生労働省「災害拠点病院一覧」 https://www.mhlw.go.jp/stf/seisakunitsuite/bunya/0000168829.html
 *     PDF/Excel 形式・スクレイピング+ジオコーディング必要
 *   - DPC公式リスト
 *
 * 現状: 既存 POI hospital + emergency=yes / 名前マッチによる暫定抽出
 */
const fs = require('fs');
const path = require('path');
const u = require('./bundle-utils.js');

const PROJECT_ROOT = path.join(__dirname, '..');
const OUT = path.join(PROJECT_ROOT, 'data', 'emergency-medical-jp.js');

// 暫定: hospital(id=4) + emergency=yes 属性 / 名前マッチ「災害」「救命」「救急」「総合病院」等
const items = [];
const dataDir = path.join(PROJECT_ROOT, 'data');
const poiFiles = fs.readdirSync(dataDir).filter(f => /^poi-.+\.js$/.test(f));
const emergRe = /災害|救命|救急|総合病院|医療センター|医大|大学病院/;
for (const file of poiFiles) {
  const text = fs.readFileSync(path.join(dataDir, file), 'utf8');
  const m = text.match(/window\.[A-Z_]+ = (\{[\s\S]*\});/);
  if (!m) continue;
  const o = JSON.parse(m[1]);
  for (const p of (o.pois || [])) {
    if (p.c !== 4) continue; // hospital のみ
    const isER = (p.a && p.a.er === 1) || (p.n && emergRe.test(p.n));
    if (!isER) continue;
    items.push({
      lat: p.lat / o.precision,
      lng: p.lng / o.precision,
      n: p.n || '',
      h24: p.a && p.a.h24 ? 1 : 0,
    });
  }
}

const data = u.buildPointBundle(items, (it) => {
  const o = {};
  if (it.n) o.n = it.n;
  if (it.h24) o.h = 1;
  return o;
});
data.source = 'STUB: OSM POI emergency=yes 抽出（本番は厚労省指定 759箇所）';
data.note = 'STUB: 厚労省「災害拠点病院一覧」PDF からの抽出+ジオコーディング追加実装必要';

const size = u.writeBundleJs(OUT, 'EMERGENCY_MEDICAL_JP', data, [
  `// ⚠️ STUB 暫定版: OSM ER 病院抽出（本番は厚労省指定一覧）`,
  `// 件数 ${items.length}（推定 759 が本来の網羅数）`,
]);
console.log(`✅ ${OUT}  count=${items.length} size=${(size/1024).toFixed(2)} KB`);
