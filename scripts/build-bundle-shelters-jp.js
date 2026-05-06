#!/usr/bin/env node
/**
 * build-bundle-shelters-jp.js
 *
 * 指定避難場所・指定避難所を data/shelters-jp.js に出力。
 *
 * 取得元（要追加実装・本セッションでは URL 未確定）:
 *   - KSJ A23 (避難所・URLパターン要調査・カタログ https://nlftp.mlit.go.jp/ksj/gml/datalist/KsjTmplt-A23.html)
 *   - 自治体オープンデータ（市町村別公開）
 *   - 国交省ハザードマップポータル GeoJSON
 *
 * 現状: スタブ実装（既存 input/{pref}/poi.geojson の public_facility/sightseeing から
 *       「避難」「学校」キーワード含むものを暫定流用）
 */
const fs = require('fs');
const path = require('path');
const u = require('./bundle-utils.js');

const PROJECT_ROOT = path.join(__dirname, '..');
const OUT = path.join(PROJECT_ROOT, 'data', 'shelters-jp.js');

// 暫定: 県別POIから「避難」「広場」「学校」「公園」名前で抽出
const items = [];
const dataDir = path.join(PROJECT_ROOT, 'data');
const poiFiles = fs.readdirSync(dataDir).filter(f => /^poi-.+\.js$/.test(f));
const shelterRe = /避難|広場|公民館|集会所|防災/;
for (const file of poiFiles) {
  const text = fs.readFileSync(path.join(dataDir, file), 'utf8');
  const m = text.match(/window\.[A-Z_]+ = (\{[\s\S]*\});/);
  if (!m) continue;
  const o = JSON.parse(m[1]);
  for (const p of (o.pois || [])) {
    // school + public_facility + sightseeing から名前マッチ
    if ([6, 7, 8].includes(p.c) && p.n && shelterRe.test(p.n)) {
      items.push({
        lat: p.lat / o.precision,
        lng: p.lng / o.precision,
        n: p.n,
        kinds: 1, // bitmap: 1=地震, 2=洪水, 4=土砂, 8=津波, 16=火事, 32=内水
      });
    }
  }
}

const data = u.buildPointBundle(items, (it) => {
  const o = {};
  if (it.n) o.n = it.n;
  if (it.kinds) o.k = it.kinds;
  return o;
});
data.source = 'STUB: OSM POI 名前マッチによる暫定抽出（本番は KSJ A23 を使う想定）';
data.note = 'STUB: KSJ A23 URL未確定・カタログから手動取得が必要';

const size = u.writeBundleJs(OUT, 'SHELTERS_JP', data, [
  `// ⚠️ STUB 暫定版: OSM 名前マッチ（避難・広場・公民館等）`,
  `// 本番は KSJ A23 / 自治体オープンデータからの再生成必要`,
  `// 件数 ${items.length}`,
]);
console.log(`✅ ${OUT}  count=${items.length} size=${(size/1024).toFixed(2)} KB`);
