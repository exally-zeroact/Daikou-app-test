#!/usr/bin/env node
/**
 * GeoJSON道路データ → ダイコメ用 roads-<prefecture>.js 変換 v6
 *
 * v6 (2026-05-07): typeCode 1byte → 16bit bitmap 2byte
 *   bit 0-3   typeCode (motorway-track, 0-12)
 *   bit 4     oneway
 *   bit 5-6   incline (00=なし, 01=登り急, 10=下り急, 11=方向不明)
 *   bit 7-9   lanes   (0=不明, 1-6=本数, 7=7+)
 *   bit 10-11 width   (00=不明, 01=≤2m, 10=2-5m, 11=>5m)
 *   bit 12-13 layer   (00=平面, 01=高架, 10=地下, 11=その他)
 *   bit 14-15 reserved
 *
 * v5: per-prefecture, 全通過グリッド登録 (継続)
 * v4: per-prefecture
 *
 * 圧縮パイプライン:
 *   1. Douglas-Peucker 5m 簡略化
 *   2. 1e5精度整数化
 *   3. 都道府県振り分け（重心 nearest）
 *   4. デルタ + Varint Zigzag + Base64
 *
 * 入力 GeoJSON properties で参照する OSM タグ:
 *   highway, oneway, incline, lanes, width, layer
 *
 * 使い方:
 *   node build-roads.js <input.geojson> <output_dir> <region> [--dem]
 *   --dem  : 国土地理院 標高タイル (tmp/tiles) で各道路の勾配を計算し
 *            OSM incline タグが無い道路の incline bit を補完する。
 *            事前に scripts/fetch-dem-tiles.js で県別に取得しておく。
 */

const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const USE_DEM = args.includes('--dem');
const onlyArg = args.find(a => a.startsWith('--only='));
const ONLY_PREF = onlyArg ? onlyArg.slice(7) : null; // 単一県のみ書き出す
const positional = args.filter(a => !a.startsWith('--'));
const [INPUT, OUTPUT_DIR, REGION] = positional;
if (!INPUT || !OUTPUT_DIR || !REGION) {
  console.error('Usage: build-roads.js <input.geojson> <output_dir> <region> [--dem] [--only=<pref>]');
  process.exit(1);
}

if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

// ─── 都道府県重心 ─────────────────────────────────────────────────
const PREFECTURES = {
  hokkaido:  [43.3, 142.8],
  aomori:    [40.8, 140.7], iwate:    [39.7, 141.2], miyagi:    [38.3, 140.9],
  akita:     [39.7, 140.4], yamagata: [38.2, 140.0], fukushima: [37.4, 140.2],
  ibaraki:   [36.4, 140.4], tochigi:  [36.7, 139.9], gunma:     [36.4, 139.0],
  saitama:   [35.9, 139.4], chiba:    [35.5, 140.2], tokyo:     [35.7, 139.7],
  kanagawa:  [35.4, 139.4],
  niigata:   [37.5, 138.9], toyama:   [36.6, 137.2], ishikawa:  [36.6, 136.7],
  fukui:     [35.8, 136.2], yamanashi:[35.6, 138.6], nagano:    [36.2, 138.0],
  gifu:      [35.6, 137.0], shizuoka: [34.9, 138.4], aichi:     [35.1, 137.0],
  mie:       [34.6, 136.5], shiga:    [35.1, 136.1], kyoto:     [35.2, 135.7],
  osaka:     [34.6, 135.5], hyogo:    [35.0, 134.9], nara:      [34.4, 135.8],
  wakayama:  [33.8, 135.5],
  tottori:   [35.4, 134.0], shimane:  [35.0, 132.8], okayama:   [34.9, 133.8],
  hiroshima: [34.5, 132.7], yamaguchi:[34.2, 131.6],
  tokushima: [33.9, 134.4], kagawa:   [34.3, 134.0],
  ehime:     [33.7, 132.9], kochi:    [33.5, 133.5],
  fukuoka:   [33.6, 130.7], saga:     [33.3, 130.1], nagasaki:  [32.9, 129.9],
  kumamoto:  [32.7, 130.7], oita:     [33.2, 131.4], miyazaki:  [32.0, 131.4],
  kagoshima: [31.4, 130.6], okinawa:  [26.5, 128.0],
};

const REGION_PREFECTURES = {
  hokkaido: ['hokkaido'],
  tohoku:   ['aomori','iwate','miyagi','akita','yamagata','fukushima'],
  kanto:    ['ibaraki','tochigi','gunma','saitama','chiba','tokyo','kanagawa'],
  chubu:    ['niigata','toyama','ishikawa','fukui','yamanashi','nagano','gifu','shizuoka','aichi'],
  kansai:   ['mie','shiga','kyoto','osaka','hyogo','nara','wakayama'],
  chugoku:  ['tottori','shimane','okayama','hiroshima','yamaguchi'],
  shikoku:  ['tokushima','kagawa','ehime','kochi'],
  kyushu:   ['fukuoka','saga','nagasaki','kumamoto','oita','miyazaki','kagoshima','okinawa'],
};

const targetPrefs = REGION_PREFECTURES[REGION];
if (!targetPrefs) throw new Error(`未知の地方: ${REGION}`);
console.log(`  → 地方: ${REGION} (${targetPrefs.length}県: ${targetPrefs.join(', ')})`);

// ─── 道路種別コード (v6: track 追加) ───────────────────────────────
const TYPE_CODES = {
  motorway: 0, trunk: 1, primary: 2, secondary: 3, tertiary: 4,
  unclassified: 5, residential: 6,
  motorway_link: 7, trunk_link: 8, primary_link: 9,
  secondary_link: 10, tertiary_link: 11,
  track: 12,
};

// ─── v6 属性パーサ ─────────────────────────────────────────────────
const INCLINE_THRESHOLD = 6; // 急勾配閾値 (%)

// OSM raw incline タグ → 0=なし/不明, 1=登り急, 2=下り急, 3=方向不明・急
// 戻り値は確定的（OSM タグから直接読み取れた）の場合のみ非ゼロ
function parseInclineRaw(raw) {
  if (raw == null) return 0;
  let v = String(raw).trim();
  if (!v) return 0;
  if (/°$/.test(v)) {
    const deg = parseFloat(v);
    if (isNaN(deg)) return 0;
    return classifyPct(Math.tan(deg * Math.PI / 180) * 100);
  }
  if (/^[+-]?\d+(\.\d+)?\s*%?$/.test(v)) {
    const pct = parseFloat(v);
    if (isNaN(pct)) return 0;
    return classifyPct(pct);
  }
  const lower = v.toLowerCase();
  if (lower === 'up') return 1;
  if (lower === 'down') return 2;
  if (/^(yes|steep|very_steep|extreme|moderate)$/.test(lower)) return 3;
  return 0;
}
function classifyPct(pct) {
  if (Math.abs(pct) < INCLINE_THRESHOLD) return 0;
  return pct >= INCLINE_THRESHOLD ? 1 : 2;
}

// DEM 計算結果と OSM raw を統合した最終 incline (0/1/2/3)
//   優先順位: OSM raw が確定値 → それ
//             それ以外 → DEM 計算結果
//             どちらも不明 → 0
function classifyInclineCombined(raw, computedInclineCode) {
  const r = parseInclineRaw(raw);
  if (r !== 0) return r;
  return computedInclineCode || 0;
}

// oneway → 0/1
function parseOneway(raw) {
  if (raw == null) return 0;
  const v = String(raw).trim().toLowerCase();
  if (v === 'yes' || v === 'true' || v === '1' || v === '-1') return 1;
  return 0;
}

// lanes → 0=不明, 1-6=本数, 7=7+
function parseLanes(raw) {
  if (raw == null) return 0;
  const n = parseInt(String(raw), 10);
  if (isNaN(n) || n <= 0) return 0;
  if (n >= 7) return 7;
  return n;
}

// width → 00=不明 / 01=狭(≤2m) / 10=中(2-5m) / 11=広(>5m)
// 数値+単位（"3.5", "3.5 m", "10 ft" など）。数値のみは m と仮定
function parseWidth(raw) {
  if (raw == null) return 0;
  const v = String(raw).trim();
  if (!v) return 0;
  const m = v.match(/^([+-]?\d+(?:\.\d+)?)\s*(m|ft|feet)?$/i);
  if (!m) return 0;
  let num = parseFloat(m[1]);
  if (isNaN(num) || num <= 0) return 0;
  const unit = (m[2] || 'm').toLowerCase();
  if (unit === 'ft' || unit === 'feet') num *= 0.3048;
  if (num <= 2) return 1;
  if (num <= 5) return 2;
  return 3;
}

// layer → 00=平面 / 01=高架 / 10=地下 / 11=その他
function parseLayer(raw) {
  if (raw == null) return 0;
  const n = parseInt(String(raw), 10);
  if (isNaN(n)) return 0;
  if (n === 0) return 0;
  if (n >= 1) return 1;
  if (n <= -1) return 2;
  return 3;
}

// 4ビット typeCode + 4ビット incline/oneway + 8ビット lanes/width/layer
//   bit 0-3   typeCode
//   bit 4     oneway
//   bit 5-6   incline
//   bit 7-9   lanes
//   bit 10-11 width
//   bit 12-13 layer
//   bit 14-15 reserved
function packAttrBitmap(typeCode, props, inclineCode) {
  let bits = typeCode & 0x0F;
  bits |= (parseOneway(props.oneway) & 0x01) << 4;
  bits |= ((inclineCode != null ? inclineCode : parseInclineRaw(props.incline)) & 0x03) << 5;
  bits |= (parseLanes(props.lanes) & 0x07) << 7;
  bits |= (parseWidth(props.width) & 0x03) << 10;
  bits |= (parseLayer(props.layer) & 0x03) << 12;
  return bits & 0xFFFF;
}

// ─── Douglas-Peucker ──────────────────────────────────────────────
const DP_TOLERANCE = 5;

function pointLineDist(p, a, b) {
  const [px, py] = p, [ax, ay] = a, [bx, by] = b;
  const dx = bx - ax, dy = by - ay;
  if (dx === 0 && dy === 0) return Math.hypot(px - ax, py - ay);
  const t = ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy);
  const tC = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + tC * dx), py - (ay + tC * dy));
}

function douglasPeucker(points, tolerance) {
  if (points.length < 3) return points;
  let maxDist = 0, maxIdx = 0;
  const first = points[0], last = points[points.length - 1];
  for (let i = 1; i < points.length - 1; i++) {
    const d = pointLineDist(points[i], first, last);
    if (d > maxDist) { maxDist = d; maxIdx = i; }
  }
  if (maxDist > tolerance) {
    const left = douglasPeucker(points.slice(0, maxIdx + 1), tolerance);
    const right = douglasPeucker(points.slice(maxIdx), tolerance);
    return left.slice(0, -1).concat(right);
  }
  return [first, last];
}

// ─── Varint + Zigzag ──────────────────────────────────────────────
function zigzagEncode(n) { return (n << 1) ^ (n >> 31); }

function writeVarint(buf, n) {
  while (n >= 0x80) { buf.push((n & 0x7f) | 0x80); n = n >>> 7; }
  buf.push(n & 0x7f);
}
function writeSignedVarint(buf, n) { writeVarint(buf, zigzagEncode(n)); }

// ─── 都道府県判定 ────────────────────────────────────────────────
function nearestPrefecture(lat, lon, prefList) {
  let best = null, bestDist = Infinity;
  for (const pref of prefList) {
    const [pLat, pLon] = PREFECTURES[pref];
    const dLat = lat - pLat;
    const dLon = lon - pLon;
    const d = dLat * dLat + dLon * dLon;
    if (d < bestDist) { bestDist = d; best = pref; }
  }
  return best;
}

// ─── DEM (オプション) ─────────────────────────────────────────────
let dem = null;
if (USE_DEM) {
  const createDem = require('./dem-lookup.js');
  dem = createDem({ zoom: 14 });
  console.log(`  → DEM 標高タイル lookup 有効 (z=14)`);
}

// ─── 道路セグメント勾配 → incline コード ────────────────────────
// DP 簡略後の整数 lat/lng 列 → 各セグメント勾配 (%) → 道路全体の判定
//   any segment >= +6% → 1 (登り急)
//   any segment <= -6% → 2 (下り急)
//   両方あり → 3 (混在・方向不明)
//   どれも閾値未満 → 0 (なし)
//   サンプル取得失敗多 → null (DEM 不明・OSM raw にフォールバック)
const PRECISION_INV = 1 / 1e5;
function haversineM(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const toRad = Math.PI / 180;
  const dLat = (lat2 - lat1) * toRad;
  const dLng = (lng2 - lng1) * toRad;
  const a = Math.sin(dLat/2)**2 + Math.cos(lat1*toRad)*Math.cos(lat2*toRad)*Math.sin(dLng/2)**2;
  return 2 * R * Math.asin(Math.sqrt(a));
}
function computeInclineFromDem(simplified) {
  if (!dem) return null;
  const n = simplified.length;
  if (n < 2) return null;
  // 各頂点で標高を取得
  const elevs = new Array(n);
  let okCount = 0;
  for (let i = 0; i < n; i++) {
    const lat = simplified[i][0] * PRECISION_INV;
    const lng = simplified[i][1] * PRECISION_INV;
    const h = dem.elev(lat, lng);
    elevs[i] = h;
    if (!isNaN(h)) okCount++;
  }
  if (okCount < 2) return null; // 全/ほぼ DEM 未取得
  // 連続する有効頂点間の勾配を計算
  let hasUp = false, hasDown = false, maxAbs = 0;
  for (let i = 0; i < n - 1; i++) {
    const ha = elevs[i], hb = elevs[i + 1];
    if (isNaN(ha) || isNaN(hb)) continue;
    const lat1 = simplified[i][0] * PRECISION_INV;
    const lng1 = simplified[i][1] * PRECISION_INV;
    const lat2 = simplified[i + 1][0] * PRECISION_INV;
    const lng2 = simplified[i + 1][1] * PRECISION_INV;
    const distM = haversineM(lat1, lng1, lat2, lng2);
    if (distM < 5) continue; // 短すぎる線分はノイズ
    const grad = (hb - ha) / distM * 100; // %
    if (Math.abs(grad) > maxAbs) maxAbs = Math.abs(grad);
    if (grad >= INCLINE_THRESHOLD) hasUp = true;
    if (grad <= -INCLINE_THRESHOLD) hasDown = true;
  }
  if (hasUp && hasDown) return 3;
  if (hasUp) return 1;
  if (hasDown) return 2;
  return 0;
}

// ─── メイン処理 ──────────────────────────────────────────────────
console.log(`  → 入力: ${INPUT}`);
const raw = fs.readFileSync(INPUT, 'utf8');
const geo = JSON.parse(raw);
if (!geo.features) throw new Error('Invalid GeoJSON');

let totalRoads = 0;
let totalPointsBefore = 0, totalPointsAfter = 0;
let droppedUnknownType = 0;
let demCalcCount = 0, demFromOSM = 0, demFromDem = 0;

const buckets = {};
const bboxByPref = {};
for (const p of targetPrefs) { buckets[p] = []; bboxByPref[p] = [Infinity, Infinity, -Infinity, -Infinity]; }

// 属性充足率カウンタ
const attrCounters = {};
for (const p of targetPrefs) attrCounters[p] = { oneway: 0, incline: 0, lanes: 0, width: 0, layer: 0, track: 0, inclineFromOSM: 0, inclineFromDem: 0 };

for (const f of geo.features) {
  if (!f.geometry) continue;
  const g = f.geometry;
  const lines = g.type === 'LineString' ? [g.coordinates]
              : g.type === 'MultiLineString' ? g.coordinates : null;
  if (!lines) continue;

  const props = f.properties || {};
  const typeCode = TYPE_CODES[props.highway];
  if (typeCode === undefined) { droppedUnknownType++; continue; }

  for (const coords of lines) {
    if (coords.length < 2) continue;
    const intPoints = coords.map(([lon, lat]) => [
      Math.round(lat * 1e5), Math.round(lon * 1e5),
    ]);
    totalPointsBefore += intPoints.length;
    const simplified = douglasPeucker(intPoints, DP_TOLERANCE);
    if (simplified.length < 2) continue;
    totalPointsAfter += simplified.length;

    const midIdx = Math.floor(simplified.length / 2);
    const [midLat, midLon] = simplified[midIdx];
    const pref = nearestPrefecture(midLat / 1e5, midLon / 1e5, targetPrefs);
    if (!pref) continue;

    // incline: OSM raw 優先、無ければ DEM 計算
    const rawIncline = parseInclineRaw(props.incline);
    let inclineCode = rawIncline;
    let inclineSource = rawIncline ? 'osm' : null;
    if (!rawIncline && dem) {
      const computed = computeInclineFromDem(simplified);
      demCalcCount++;
      if (computed != null) {
        inclineCode = computed;
        if (computed) inclineSource = 'dem';
      }
    }
    if (inclineSource === 'osm') demFromOSM++;
    else if (inclineSource === 'dem') demFromDem++;

    const bitmap = packAttrBitmap(typeCode, props, inclineCode);

    const bb = bboxByPref[pref];
    for (const [lat, lon] of simplified) {
      if (lat < bb[0]) bb[0] = lat;
      if (lon < bb[1]) bb[1] = lon;
      if (lat > bb[2]) bb[2] = lat;
      if (lon > bb[3]) bb[3] = lon;
    }
    buckets[pref].push([bitmap, simplified]);
    totalRoads++;

    const c = attrCounters[pref];
    if ((bitmap >> 4) & 0x01) c.oneway++;
    if ((bitmap >> 5) & 0x03) c.incline++;
    if ((bitmap >> 7) & 0x07) c.lanes++;
    if ((bitmap >> 10) & 0x03) c.width++;
    if ((bitmap >> 12) & 0x03) c.layer++;
    if (typeCode === 12) c.track++;
    if (inclineSource === 'osm') c.inclineFromOSM++;
    if (inclineSource === 'dem') c.inclineFromDem++;
  }
}

console.log(`  → 道路数: ${totalRoads}`);
console.log(`  → 不明な道路種別スキップ: ${droppedUnknownType}`);
console.log(`  → 簡略化前後の点数: ${totalPointsBefore} → ${totalPointsAfter} (${((1 - totalPointsAfter / totalPointsBefore) * 100).toFixed(1)}%削減)`);

const meta = { region: REGION, generated: new Date().toISOString(), prefectures: {} };

for (const pref of targetPrefs) {
  if (ONLY_PREF && pref !== ONLY_PREF) continue; // 指定県のみ出力
  const entries = buckets[pref];
  if (entries.length === 0) {
    console.log(`  → ⚠️  ${pref}: 道路0件（スキップ）`);
    continue;
  }

  // バイナリエンコード（v6: bitmap 2byte little-endian）
  const byteBuf = [];
  for (const [bitmap, points] of entries) {
    byteBuf.push(bitmap & 0xFF);          // LSB
    byteBuf.push((bitmap >> 8) & 0xFF);   // MSB
    writeVarint(byteBuf, points.length);
    writeSignedVarint(byteBuf, points[0][0]);
    writeSignedVarint(byteBuf, points[0][1]);
    for (let i = 1; i < points.length; i++) {
      writeSignedVarint(byteBuf, points[i][0] - points[i - 1][0]);
      writeSignedVarint(byteBuf, points[i][1] - points[i - 1][1]);
    }
  }

  const buffer = Buffer.from(byteBuf);
  const roadsB64 = buffer.toString('base64');

  // グリッドインデックス（v5 から踏襲：全通過グリッド登録）
  const GRID_INT = 1000;
  const grid = {};

  function addCellsAlongSegment(cells, A, B) {
    const dy = B[0] - A[0];
    const dx = B[1] - A[1];
    const dist = Math.sqrt(dy * dy + dx * dx);
    const SAMPLE_INTERVAL = GRID_INT / 4;
    const numSamples = Math.ceil(dist / SAMPLE_INTERVAL);
    if (numSamples <= 1) return;
    for (let s = 1; s < numSamples; s++) {
      const t = s / numSamples;
      const lat = A[0] + dy * t;
      const lng = A[1] + dx * t;
      const gy = Math.floor(lat / GRID_INT);
      const gx = Math.floor(lng / GRID_INT);
      cells.add(gy + '_' + gx);
    }
  }

  entries.forEach(([, points], idx) => {
    const cellsForRoad = new Set();
    for (let i = 0; i < points.length; i++) {
      const gy = Math.floor(points[i][0] / GRID_INT);
      const gx = Math.floor(points[i][1] / GRID_INT);
      cellsForRoad.add(gy + '_' + gx);
      if (i < points.length - 1) {
        addCellsAlongSegment(cellsForRoad, points[i], points[i + 1]);
      }
    }
    for (const key of cellsForRoad) {
      (grid[key] ||= []).push(idx);
    }
  });

  const PREF_UPPER = pref.toUpperCase().replace(/-/g, '_');
  const c = attrCounters[pref];
  const out = `// Auto-generated by .github/workflows/osm-update.yml
// Source: Geofabrik ${REGION}-latest.osm.pbf → ${pref}
// Generated: ${new Date().toISOString()}
// Format v6: per-prefecture, 16bit attr bitmap + varint + base64 + 全通過グリッド登録
//   bitmap: typeCode(4) | oneway(1) | incline(2) | lanes(3) | width(2) | layer(2) | reserved(2)
// © OpenStreetMap contributors (ODbL)
window.ROADS_${PREF_UPPER} = ${JSON.stringify({
    v: 6,
    region: REGION,
    prefecture: pref,
    generated: new Date().toISOString(),
    precision: 1e5,
    bbox: bboxByPref[pref],
    gridSize: GRID_INT,
    numRoads: entries.length,
    types: Object.fromEntries(Object.entries(TYPE_CODES).map(([k, v]) => [v, k])),
    attrLegend: {
      typeCode: 'bit 0-3',
      oneway:   'bit 4 (1=oneway)',
      incline:  'bit 5-6 (0=none, 1=up≥6%, 2=down≥6%, 3=steep dir-unknown)',
      lanes:    'bit 7-9 (0=unknown, 1-6=lanes, 7=7+)',
      width:    'bit 10-11 (0=unknown, 1=≤2m, 2=2-5m, 3=>5m)',
      layer:    'bit 12-13 (0=ground, 1=bridge+, 2=tunnel-, 3=other)',
    },
    attrCounts: c,
    grid,
    roadsB64,
  })};
`;

  const outPath = path.join(OUTPUT_DIR, `roads-${pref}.js`);
  fs.writeFileSync(outPath, out);
  const size = fs.statSync(outPath).size;
  const pct = (n) => `${((n / entries.length) * 100).toFixed(1)}%`;
  console.log(`  → ${pref}: ${entries.length}本・${(size / 1024 / 1024).toFixed(2)} MB → ${outPath}`);
  console.log(`     attr 充足: oneway ${pct(c.oneway)} / incline ${pct(c.incline)} (osm ${pct(c.inclineFromOSM)} + dem ${pct(c.inclineFromDem)}) / lanes ${pct(c.lanes)} / width ${pct(c.width)} / layer ${pct(c.layer)} / track ${pct(c.track)}`);

  meta.prefectures[pref] = {
    numRoads: entries.length,
    sizeBytes: size,
    bbox: bboxByPref[pref],
    attrCounts: c,
  };
}

const metaPath = path.join(OUTPUT_DIR, `meta-${REGION}.json`);
fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
console.log(`  → meta: ${metaPath}`);
if (USE_DEM && dem) {
  const s = dem.stats();
  console.log(`  DEM lookup stats: hits=${s.hits} misses=${s.misses} naSamples=${s.naSamples} cacheTiles=${s.cacheTiles} (5m=${s.tiles5m}/10m=${s.tiles10m}/missing=${s.tilesMissing})`);
  console.log(`  incline 出典: OSM=${demFromOSM} / DEM=${demFromDem} / 計算試行=${demCalcCount}`);
}
console.log(`✅ 全${targetPrefs.length}県の出力完了`);
