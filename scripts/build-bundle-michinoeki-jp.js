#!/usr/bin/env node
/**
 * build-bundle-michinoeki-jp.js
 *
 * 道の駅一覧を data/michinoeki-jp.js に出力。
 *
 * 取得元（要追加実装）:
 *   - 公式: https://www.mlit.go.jp/road/eki/  (HTML スクレイピング要)
 *   - 政府オープンデータポータル CKAN API
 *   - G空間情報センター
 *
 * 現状: スタブ実装（既存 input/{pref}/poi.geojson から michinoeki を集約）
 *       → 将来 OSM 抜けを公式リストで補完する build に置き換え
 */
const fs = require('fs');
const path = require('path');
const u = require('./bundle-utils.js');

const PROJECT_ROOT = path.join(__dirname, '..');
const OUT = path.join(PROJECT_ROOT, 'data', 'michinoeki-jp.js');

// 既存の県別 POI 由来 michinoeki を全国集約（OSM抜けあり・暫定）
// 本番は国交省公式リスト 1229箇所を使う想定
const items = [];
const dataDir = path.join(PROJECT_ROOT, 'data');
const poiFiles = fs.readdirSync(dataDir).filter(f => /^poi-.+\.js$/.test(f));
for (const file of poiFiles) {
  const text = fs.readFileSync(path.join(dataDir, file), 'utf8');
  const m = text.match(/window\.[A-Z_]+ = (\{[\s\S]*\});/);
  if (!m) continue;
  const o = JSON.parse(m[1]);
  for (const p of (o.pois || [])) {
    if (p.c === 70) { // michinoeki = id 70
      items.push({
        lat: p.lat / o.precision,
        lng: p.lng / o.precision,
        n: p.n || '',
      });
    }
  }
}

const data = u.buildPointBundle(items, (it) => (it.n ? { n: it.n } : {}));
data.source = 'OSM POI 集約版（暫定・本番は国交省登録一覧 1229箇所を使う想定）';
data.note = 'STUB: replace with build from https://www.mlit.go.jp/road/eki/';

const size = u.writeBundleJs(OUT, 'MICHINOEKI_JP', data, [
  `// ⚠️ STUB 暫定版: OSM POI 集約・本番は国交省登録一覧から再生成`,
  `// 道の駅 ${items.length} 件（OSM 抜けあり）`,
]);
console.log(`✅ ${OUT}  count=${items.length} size=${(size/1024).toFixed(2)} KB`);
