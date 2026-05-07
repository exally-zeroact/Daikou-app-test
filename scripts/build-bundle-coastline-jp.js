#!/usr/bin/env node
/**
 * build-bundle-coastline-jp.js
 *
 * OSM Geofabrik 8地方PBFから natural=coastline ways を抽出 → DP簡略化 → varint+base64
 *
 * 出力: data/coastline-jp.js  ~200KB目標
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const u = require('./bundle-utils.js');

// グローバルインストールの osm-pbf-parser を使う
function requireGlobal(name) {
  try { return require(name); } catch {}
  const root = execSync('npm root -g', { encoding: 'utf8' }).trim();
  return require(path.join(root, name));
}
const parseOsmPbf = requireGlobal('osm-pbf-parser');
const through = requireGlobal('through2');

const PROJECT_ROOT = path.join(__dirname, '..');
const TMP = path.join(PROJECT_ROOT, 'tmp');
const OUT = path.join(PROJECT_ROOT, 'data', 'coastline-jp.js');

const REGIONS = ['hokkaido','tohoku','kanto','chubu','kansai','chugoku','shikoku','kyushu'];

// Douglas-Peucker
function pointLineDist(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  if (dx === 0 && dy === 0) return Math.hypot(p[0]-a[0], p[1]-a[1]);
  const t = Math.max(0, Math.min(1, ((p[0]-a[0])*dx + (p[1]-a[1])*dy) / (dx*dx + dy*dy)));
  return Math.hypot(p[0]-(a[0]+t*dx), p[1]-(a[1]+t*dy));
}
function douglasPeucker(pts, tol) {
  if (pts.length < 3) return pts;
  let maxD = 0, maxIdx = 0;
  const a = pts[0], b = pts[pts.length-1];
  for (let i = 1; i < pts.length - 1; i++) {
    const d = pointLineDist(pts[i], a, b);
    if (d > maxD) { maxD = d; maxIdx = i; }
  }
  if (maxD > tol) {
    return douglasPeucker(pts.slice(0, maxIdx+1), tol).slice(0,-1)
      .concat(douglasPeucker(pts.slice(maxIdx), tol));
  }
  return [a, b];
}

(async () => {
  // 各地方PBF→ ノードIDからlat/lngを引く＋wayから coastline を抽出
  // 2-pass parse: pass1 でwayのid→nodeRefs, pass2 でnodeのlat/lng
  // メモリ: nodeIds は coastline way が参照する node のみに絞る → 数百万 (実用範囲)

  const TOL_DEG = 0.0005; // 度（≈50m）程度の簡略
  let allLines = []; // 全地方の line をマージ

  for (const region of REGIONS) {
    const pbfPath = path.join(TMP, `${region}-latest.osm.pbf`);
    if (!fs.existsSync(pbfPath)) {
      console.log(`  skip ${region}: PBF not cached`);
      continue;
    }
    console.log(`  ${region}: parsing PBF (${(fs.statSync(pbfPath).size/1024/1024).toFixed(1)} MB)`);

    // Pass 1: collect way nodeRefs for ways with natural=coastline
    const coastlineWays = []; // [[nodeId, nodeId, ...], ...]
    const neededNodes = new Set();
    let pass1Time = Date.now();
    await new Promise((resolve, reject) => {
      fs.createReadStream(pbfPath)
        .pipe(parseOsmPbf())
        .pipe(through.obj((items, enc, next) => {
          for (const item of items) {
            if (item.type === 'way' && item.tags && item.tags.natural === 'coastline') {
              coastlineWays.push(item.refs);
              for (const id of item.refs) neededNodes.add(id);
            }
          }
          next();
        }, () => resolve()))
        .on('error', reject);
    });
    console.log(`    pass1: ${coastlineWays.length} coastline ways / ${neededNodes.size} nodes / ${((Date.now()-pass1Time)/1000).toFixed(1)}s`);

    // Pass 2: read needed nodes' lat/lng
    const nodeMap = new Map();
    let pass2Time = Date.now();
    await new Promise((resolve, reject) => {
      fs.createReadStream(pbfPath)
        .pipe(parseOsmPbf())
        .pipe(through.obj((items, enc, next) => {
          for (const item of items) {
            if (item.type === 'node' && neededNodes.has(item.id)) {
              nodeMap.set(item.id, [item.lon, item.lat]);
            }
          }
          next();
        }, () => resolve()))
        .on('error', reject);
    });
    console.log(`    pass2: ${nodeMap.size} nodes resolved / ${((Date.now()-pass2Time)/1000).toFixed(1)}s`);

    // Way → coordinate sequence → DP simplify → integer
    let totalBefore = 0, totalAfter = 0;
    for (const refs of coastlineWays) {
      const coords = [];
      for (const id of refs) {
        const c = nodeMap.get(id);
        if (c) coords.push(c);
      }
      if (coords.length < 2) continue;
      totalBefore += coords.length;
      const simp = douglasPeucker(coords, TOL_DEG);
      totalAfter += simp.length;
      // 1e5 整数化 [lat, lng]
      const intPts = simp.map(([lng, lat]) => [Math.round(lat*u.PRECISION), Math.round(lng*u.PRECISION)]);
      allLines.push(intPts);
    }
    console.log(`    points: ${totalBefore.toLocaleString()} → ${totalAfter.toLocaleString()} (${(100-(100*totalAfter/totalBefore)).toFixed(1)}% 削減)`);
  }

  console.log(`\n  total lines: ${allLines.length}`);

  if (allLines.length === 0) {
    console.error('❌ No coastline data extracted');
    process.exit(1);
  }

  // grid 索引（line ごとの代表点で粗く）
  const grid = {};
  const linesB64 = allLines.map((pts, idx) => {
    // 代表点 = 線の中央
    const mid = pts[Math.floor(pts.length/2)];
    const k = u.gridKey(mid[0], mid[1]);
    (grid[k] ||= []).push(idx);
    return u.encodeLineB64(pts);
  });

  // bbox 全体
  let bbox = [Infinity, Infinity, -Infinity, -Infinity];
  for (const pts of allLines) for (const [lat, lng] of pts) {
    if (lat<bbox[0]) bbox[0]=lat; if (lng<bbox[1]) bbox[1]=lng;
    if (lat>bbox[2]) bbox[2]=lat; if (lng>bbox[3]) bbox[3]=lng;
  }

  const data = {
    v: 1,
    generated: new Date().toISOString(),
    precision: u.PRECISION,
    gridSize: u.GRID_INT,
    bbox,
    grid,
    lines: linesB64,
    source: 'OSM Geofabrik (natural=coastline・DP 50m簡略)',
  };

  const size = u.writeBundleJs(OUT, 'COASTLINE_JP', data, [
    `// 出典: OpenStreetMap (ODbL)・natural=coastline ways`,
    `// Geofabrik 8地方PBFから抽出・Douglas-Peucker 50m 簡略化`,
    `// 全国 ${allLines.length} ライン`,
  ]);
  console.log(`✅ ${OUT}  lines=${allLines.length} size=${(size/1024).toFixed(2)} KB`);
})().catch(e => { console.error('FATAL:', e); process.exit(1); });
