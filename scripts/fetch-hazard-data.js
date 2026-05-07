#!/usr/bin/env node
/**
 * fetch-hazard-data.js
 *
 * 47都道府県別に KSJ ZIP をダウンロードして
 *   input/{pref}/{flood,tsunami,landslide}.geojson
 * を「正しい属性付き」で出力する。
 *
 * 既存の fetch-real-data.js は 簡易 GML パーサで属性が落ちる問題があり
 * 本スクリプトは ZIP 同梱の GEOJSON / Shapefile を直接読むことで
 * KSJ オリジナル属性 (A31_105, A40_003, A48_004) を確実に保持する。
 *
 * 使い方:
 *   node scripts/fetch-hazard-data.js <pref>
 *   ex: node scripts/fetch-hazard-data.js ehime
 *
 * 出典:
 *   A31-21 国土数値情報「洪水浸水想定区域」(国交省)
 *   A40-16 国土数値情報「津波浸水想定」(国交省)
 *   A48-21 国土数値情報「土砂災害警戒区域」(国交省)
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

function requireGlobal(name) {
  try { return require(name); } catch {}
  const root = execSync('npm root -g', { encoding: 'utf8' }).trim();
  return require(path.join(root, name));
}
const shapefile = requireGlobal('shapefile');

// 47 都道府県 + KSJ コード (JIS X 0401)
const PREFS = {
  hokkaido:  '01',
  aomori:    '02', iwate:     '03', miyagi:    '04', akita:    '05', yamagata: '06', fukushima: '07',
  ibaraki:   '08', tochigi:   '09', gunma:     '10',
  saitama:   '11', chiba:     '12', tokyo:     '13', kanagawa:  '14',
  niigata:   '15', toyama:    '16', ishikawa:  '17', fukui:     '18',
  yamanashi: '19', nagano:    '20', gifu:      '21', shizuoka:  '22', aichi:    '23',
  mie:       '24', shiga:     '25', kyoto:     '26', osaka:     '27',
  hyogo:     '28', nara:      '29', wakayama:  '30',
  tottori:   '31', shimane:   '32', okayama:   '33', hiroshima: '34', yamaguchi:'35',
  tokushima: '36', kagawa:    '37', ehime:     '38', kochi:     '39',
  fukuoka:   '40', saga:      '41', nagasaki:  '42', kumamoto:  '43',
  oita:      '44', miyazaki:  '45', kagoshima: '46', okinawa:   '47',
};

const PROJECT_ROOT = path.join(__dirname, '..');
const UA = { 'User-Agent': 'Daikou-app-test/0.1 (zeroact24.729@outlook.com)' };

const PREF = process.argv[2];
if (!PREF || !PREFS[PREF]) {
  console.error('Usage: fetch-hazard-data.js <pref>');
  console.error('Available:', Object.keys(PREFS).join(' '));
  process.exit(1);
}
const PCODE = PREFS[PREF];
const OUT_DIR = path.join(PROJECT_ROOT, 'input', PREF);
const RAW_DIR = path.join(OUT_DIR, 'raw');
fs.mkdirSync(OUT_DIR, { recursive: true });
fs.mkdirSync(RAW_DIR, { recursive: true });

console.log(`[fetch-hazard-data] pref=${PREF} code=${PCODE}`);

// ─── HTTP / unzip helpers ──────────────────────────────────────────
async function fetchBuffer(url, timeoutMs = 240000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: UA });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  } finally { clearTimeout(t); }
}

function unzipTo(zipPath, dir) {
  fs.mkdirSync(dir, { recursive: true });
  execSync(`unzip -o "${zipPath}" -d "${dir}"`, { stdio: 'pipe' });
}

function findFiles(dir, pattern) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...findFiles(p, pattern));
    else if (pattern.test(e.name)) out.push(p);
  }
  return out;
}

async function downloadZipIfNeeded(url, fname) {
  const zipPath = path.join(RAW_DIR, fname);
  if (fs.existsSync(zipPath) && fs.statSync(zipPath).size > 1024) {
    console.log(`  cache: ${fname} (${(fs.statSync(zipPath).size/1024/1024).toFixed(1)} MB)`);
    return zipPath;
  }
  console.log(`  DL: ${url}`);
  const buf = await fetchBuffer(url);
  fs.writeFileSync(zipPath, buf);
  console.log(`  saved ${fname} (${(buf.length/1024/1024).toFixed(1)} MB)`);
  return zipPath;
}

// ─── A31 洪水 (浸水想定区域) ──────────────────────────────────────
// ZIP 内に多数の GEOJSON ファイル (河川別) → マージ
// 属性 A31_105 = 浸水ランク (1=<0.5m, 2=0.5-3m, 3=3-5m, 4=5-10m, 5=10-20m, 6=>20m)
// → depth 0-3 にマッピング:  1→0, 2→1, 3→2, 4-6→3
function rankToDepth(rank) {
  if (rank <= 1) return 0;
  if (rank === 2) return 1;
  if (rank === 3) return 2;
  return 3;
}

async function fetchA31() {
  const url = `https://nlftp.mlit.go.jp/ksj/gml/data/A31/A31-21/A31-21_${PCODE}_GML.zip`;
  const zipPath = await downloadZipIfNeeded(url, `A31-21_${PCODE}_GML.zip`);
  const extractDir = path.join(RAW_DIR, `A31-21_${PCODE}_GML`);
  unzipTo(zipPath, extractDir);
  const geojsons = findFiles(extractDir, /^A31-.*\.geojson$/i);
  console.log(`  A31: ${geojsons.length} 河川別 GEOJSON 発見`);
  const features = [];
  let counts = { 0: 0, 1: 0, 2: 0, 3: 0 };
  for (const gp of geojsons) {
    let text;
    try { text = fs.readFileSync(gp, 'utf8'); } catch { continue; }
    let json;
    try { json = JSON.parse(text); } catch { continue; }
    for (const f of (json.features || [])) {
      if (!f.geometry) continue;
      const props = f.properties || {};
      const rank = parseInt(props.A31_105, 10);
      if (isNaN(rank)) continue;
      const depth = rankToDepth(rank);
      counts[depth]++;
      features.push({
        type: 'Feature',
        properties: {
          depth,
          rank,
          basin: props.A31_102 || '',
          _raw: { A31_105: rank },
        },
        geometry: f.geometry,
      });
    }
  }
  fs.writeFileSync(path.join(OUT_DIR, 'flood.geojson'),
    JSON.stringify({ type: 'FeatureCollection', features }));
  console.log(`  A31 → flood.geojson: ${features.length} feats / depth 0:${counts[0]} 1:${counts[1]} 2:${counts[2]} 3:${counts[3]}`);
  return features.length;
}

// ─── A40 津波 (浸水想定) ───────────────────────────────────────────
// ZIP 内は Shapefile (.shp/.dbf)・GEOJSON 同梱無し
// 属性 A40_003 = 浸水深テキスト (Shift-JIS)
//   "0.01m〜0.3m未満" / "0.3m〜1m未満" / ... / "20m以上"
// 数値の先頭部分 (ASCII) は文字化けせずに残るので正規表現で抽出
async function fetchA40() {
  const url = `https://nlftp.mlit.go.jp/ksj/gml/data/A40/A40-16/A40-16_${PCODE}_GML.zip`;
  let zipPath;
  try {
    zipPath = await downloadZipIfNeeded(url, `A40-16_${PCODE}_GML.zip`);
  } catch (err) {
    console.log(`  A40: 取得失敗 (内陸県は津波データ無いので OK) ${err.message}`);
    fs.writeFileSync(path.join(OUT_DIR, 'tsunami.geojson'),
      JSON.stringify({ type: 'FeatureCollection', features: [] }));
    return 0;
  }
  const extractDir = path.join(RAW_DIR, `A40-16_${PCODE}_GML`);
  unzipTo(zipPath, extractDir);
  const shps = findFiles(extractDir, /^A40-.*\.shp$/i);
  if (shps.length === 0) {
    console.log(`  A40: shapefile 見つからず`);
    fs.writeFileSync(path.join(OUT_DIR, 'tsunami.geojson'),
      JSON.stringify({ type: 'FeatureCollection', features: [] }));
    return 0;
  }
  const features = [];
  let counts = { 0: 0, 1: 0, 2: 0, 3: 0 };
  for (const shpPath of shps) {
    const dbfPath = shpPath.replace(/\.shp$/i, '.dbf');
    if (!fs.existsSync(dbfPath)) continue;
    const src = await shapefile.open(shpPath, dbfPath);
    while (true) {
      const r = await src.read();
      if (r.done) break;
      const props = r.value.properties || {};
      const s = props.A40_003 || '';
      const m = s.match(/^([\d.]+)m/);
      const lead = m ? parseFloat(m[1]) : NaN;
      let depth;
      if (isNaN(lead)) depth = 0;
      else if (lead < 1) depth = 0;
      else if (lead < 2) depth = 1;
      else if (lead < 5) depth = 2;
      else depth = 3;
      counts[depth]++;
      features.push({
        type: 'Feature',
        properties: { depth, _raw: { lead_m: lead } },
        geometry: r.value.geometry,
      });
    }
  }
  fs.writeFileSync(path.join(OUT_DIR, 'tsunami.geojson'),
    JSON.stringify({ type: 'FeatureCollection', features }));
  console.log(`  A40 → tsunami.geojson: ${features.length} feats / depth 0:${counts[0]} 1:${counts[1]} 2:${counts[2]} 3:${counts[3]}`);
  return features.length;
}

// ─── A48 土砂災害警戒区域 ──────────────────────────────────────────
// ZIP 内に GEOJSON 同梱
// 属性 A48_004 = 区域種別
//   1 = 警戒区域 (yellow)
//   2 = 特別警戒区域 (red)
async function fetchA48() {
  const url = `https://nlftp.mlit.go.jp/ksj/gml/data/A48/A48-21/A48-21_${PCODE}_GML.zip`;
  let zipPath;
  try {
    zipPath = await downloadZipIfNeeded(url, `A48-21_${PCODE}_GML.zip`);
  } catch (err) {
    console.log(`  A48: 取得失敗 ${err.message}`);
    fs.writeFileSync(path.join(OUT_DIR, 'landslide.geojson'),
      JSON.stringify({ type: 'FeatureCollection', features: [] }));
    return 0;
  }
  const extractDir = path.join(RAW_DIR, `A48-21_${PCODE}_GML`);
  unzipTo(zipPath, extractDir);
  const geojsons = findFiles(extractDir, /^A48-.*\.geojson$/i);
  if (geojsons.length === 0) {
    console.log(`  A48: GEOJSON 見つからず`);
    fs.writeFileSync(path.join(OUT_DIR, 'landslide.geojson'),
      JSON.stringify({ type: 'FeatureCollection', features: [] }));
    return 0;
  }
  const features = [];
  let counts = { red: 0, yellow: 0 };
  for (const gp of geojsons) {
    let text;
    try { text = fs.readFileSync(gp, 'utf8'); } catch { continue; }
    let json;
    try { json = JSON.parse(text); } catch { continue; }
    for (const f of (json.features || [])) {
      if (!f.geometry) continue;
      const props = f.properties || {};
      const code = parseInt(props.A48_004, 10);
      const kind = code === 2 ? 'red' : 'yellow';
      counts[kind]++;
      features.push({
        type: 'Feature',
        properties: {
          kind,
          name: props.A48_005 || '',
          city: props.A48_002 || '',
          _raw: { A48_004: code },
        },
        geometry: f.geometry,
      });
    }
  }
  fs.writeFileSync(path.join(OUT_DIR, 'landslide.geojson'),
    JSON.stringify({ type: 'FeatureCollection', features }));
  console.log(`  A48 → landslide.geojson: ${features.length} feats / red:${counts.red} yellow:${counts.yellow}`);
  return features.length;
}

// ─── main ──────────────────────────────────────────────────────────
(async () => {
  const t0 = Date.now();
  let f31 = 0, f40 = 0, f48 = 0;
  try { f31 = await fetchA31(); } catch (e) { console.log(`  A31 failed: ${e.message}`); }
  try { f40 = await fetchA40(); } catch (e) { console.log(`  A40 failed: ${e.message}`); }
  try { f48 = await fetchA48(); } catch (e) { console.log(`  A48 failed: ${e.message}`); }
  console.log(`✅ ${PREF}: flood=${f31} tsunami=${f40} landslide=${f48} (${((Date.now()-t0)/1000).toFixed(1)}s)`);
})().catch(e => { console.error('FATAL:', e); process.exit(1); });
