#!/usr/bin/env node
/**
 * build-bundle-night-clinics-jp.js
 *
 * 夜間休日診療所 ~3,000箇所 data/night-clinics-jp.js
 *
 * 取得元（要追加実装）:
 *   - 厚生労働省 / 各都道府県医師会 一覧（自治体毎に公開）
 *   - 統一API は無く、47県の医師会サイトをスクレイピング必要
 *
 * 現状: OSM clinic + dental + opening_hours の暫定抽出
 */
const fs = require('fs');
const path = require('path');
const u = require('./bundle-utils.js');

const PROJECT_ROOT = path.join(__dirname, '..');
const OUT = path.join(PROJECT_ROOT, 'data', 'night-clinics-jp.js');

// 暫定: clinic(20) で h24 or 夜間診療を示唆する opening_hours
const items = [];
const dataDir = path.join(PROJECT_ROOT, 'data');
const poiFiles = fs.readdirSync(dataDir).filter(f => /^poi-.+\.js$/.test(f));
const nightRe = /夜間|休日|時間外|24/;
for (const file of poiFiles) {
  const text = fs.readFileSync(path.join(dataDir, file), 'utf8');
  const m = text.match(/window\.[A-Z_]+ = (\{[\s\S]*\});/);
  if (!m) continue;
  const o = JSON.parse(m[1]);
  for (const p of (o.pois || [])) {
    if (p.c !== 20) continue;
    const open = p.a && (p.a.open || (p.a.h24 ? '24h' : ''));
    const nameMatch = p.n && nightRe.test(p.n);
    if (!(p.a && p.a.h24) && !nameMatch) continue;
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
data.source = 'STUB: OSM clinic h24/夜間 抽出（本番は厚労省+47都道府県医師会）';
data.note = 'STUB: 各県医師会サイトのスクレイピング統合が必要';

const size = u.writeBundleJs(OUT, 'NIGHT_CLINICS_JP', data, [
  `// ⚠️ STUB 暫定版: OSM 夜間診療所抽出`,
  `// 件数 ${items.length}（推定 3,000 が本来の網羅数）`,
]);
console.log(`✅ ${OUT}  count=${items.length} size=${(size/1024).toFixed(2)} KB`);
