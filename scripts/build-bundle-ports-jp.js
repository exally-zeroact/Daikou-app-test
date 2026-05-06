#!/usr/bin/env node
/**
 * build-bundle-ports-jp.js
 *
 * 港湾・フェリーターミナル data/ports-jp.js
 *
 * 取得元（要追加実装）:
 *   - KSJ C02 港湾（URL未確定）
 *   - 国土交通省海事局・港湾局
 *   - OSM `harbour=*` `man_made=pier`
 *
 * 現状: 既存県別POIから harbor/marina/ferry を抽出（OSM抜けあり・暫定）
 */
const fs = require('fs');
const path = require('path');
const u = require('./bundle-utils.js');

const PROJECT_ROOT = path.join(__dirname, '..');
const OUT = path.join(PROJECT_ROOT, 'data', 'ports-jp.js');

// 暫定: POI 名前マッチ「港」「フェリー」「ターミナル」
const items = [];
const dataDir = path.join(PROJECT_ROOT, 'data');
const poiFiles = fs.readdirSync(dataDir).filter(f => /^poi-.+\.js$/.test(f));
const portRe = /港|フェリー|ターミナル|船着場|harbour|harbor|port/i;
for (const file of poiFiles) {
  const text = fs.readFileSync(path.join(dataDir, file), 'utf8');
  const m = text.match(/window\.[A-Z_]+ = (\{[\s\S]*\});/);
  if (!m) continue;
  const o = JSON.parse(m[1]);
  for (const p of (o.pois || [])) {
    if (p.n && portRe.test(p.n)) {
      items.push({
        lat: p.lat / o.precision,
        lng: p.lng / o.precision,
        n: p.n,
      });
    }
  }
}

const data = u.buildPointBundle(items, (it) => (it.n ? { n: it.n } : {}));
data.source = 'STUB: OSM POI 名前マッチ（本番は KSJ C02 + OSM harbour=*）';
data.note = 'STUB: KSJ C02 URL未確定・追加実装必要';

const size = u.writeBundleJs(OUT, 'PORTS_JP', data, [
  `// ⚠️ STUB 暫定版: OSM 名前マッチによる港抽出`,
  `// 本番は KSJ C02 港湾 + OSM harbour タグから再生成`,
  `// 件数 ${items.length}`,
]);
console.log(`✅ ${OUT}  count=${items.length} size=${(size/1024).toFixed(2)} KB`);
