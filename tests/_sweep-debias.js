'use strict';
// tests/_sweep-debias.js
// ★過大ゼロ de-bias スイープ (2026-06-08)★
//   目的: 現行 -2% 過小を「過大ゼロ(全業務 eng≤tire)を壁にして」0% へ詰める設定を実測で探す。
//   生GPS弦(過大+1%)には寄せない = smoothedRawMode を土台に、平滑窓/arc回収等を振って測る。
//   絶対ルール: 業務別(代行開始→精算終了)のみ・distance_m 算出のみ・過大ゼロが最優先。

const fs = require('fs');
const path = require('path');
global.window = global;
global.self = global;
eval(fs.readFileSync(path.join(__dirname, '..', 'js', 'roads-decoder.js'), 'utf8'));
eval(fs.readFileSync(path.join(__dirname, '..', 'data', 'roads-ehime.js'), 'utf8'));
const dec = new global.RoadDecoder(global.ROADS_EHIME);
dec.buildOffsetTable();
const { computeDistance } = require(path.join(__dirname, '..', 'js', 'pipeline-distance.js'));

function splitTrips(s) {
  const trips = [];
  let cur = null;
  for (let i = 0; i < s.length; i++) {
    const b = s[i].biz || {};
    const it = b.it != null ? b.it : b.run;
    if (it === 1) {
      if (!cur) cur = { s: i, e: i };
      cur.e = i;
    } else if (cur) {
      trips.push(cur);
      cur = null;
    }
  }
  if (cur) trips.push(cur);
  return trips.filter((t) => t.e - t.s > 20);
}
function loadFixture(file) {
  let a;
  try {
    a = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', file), 'utf8'));
  } catch (e) {
    return null;
  }
  a = a.filter((x) => x && Number.isFinite(x.lat)).sort((x, y) => x.t - y.t);
  return { all: a, trips: splitTrips(a) };
}

const GROUPS = [
  {
    name: '0606',
    tire: [null, 3.57, 3.39],
    devices: ['0606-Android.slim.json', '0606-iPhone13.slim.json', '0606-iPhoneSE.slim.json'],
  },
  {
    name: 'rt3',
    tire: [1.5, 8.58, 9.59, 1.72],
    devices: ['realtest3-Android.slim.json', 'realtest3-iPhoneSE.slim.json'],
  },
];

// 全 (業務×端末) の seg を 1 度だけ展開 (高速化)
const SEGS = [];
for (const g of GROUPS) {
  for (const f of g.devices) {
    const fx = loadFixture(f);
    if (!fx) continue;
    g.tire.forEach((tv, ti) => {
      if (tv == null || !fx.trips[ti]) return;
      const tr = fx.trips[ti];
      SEGS.push({
        key: `${g.name}t${ti + 1}/${f.split('-')[1].replace('.slim.json', '')}`,
        seg: fx.all.slice(tr.s, tr.e + 1),
        tire: tv,
      });
    });
  }
}

// ── 試す設定 (土台 smoothedRawMode・過大ゼロを保ちつつ長さ回収) ──
const CONFIGS = [
  { name: 'baseline(win5)', opts: { enableRouting: true } },
  { name: 'win4', opts: { enableRouting: true, smoothWindow: 4 } },
  { name: 'win3', opts: { enableRouting: true, smoothWindow: 3 } },
  {
    name: 'win3+cap1.3',
    opts: { enableRouting: true, smoothWindow: 3, smoothDopplerCapRatio: 1.3 },
  },
  {
    name: 'win3+cap1.2',
    opts: { enableRouting: true, smoothWindow: 3, smoothDopplerCapRatio: 1.2 },
  },
  { name: 'win5+cap1.2', opts: { enableRouting: true, smoothDopplerCapRatio: 1.2 } },
];

function pct(eng, tire) {
  return (eng / tire - 1) * 100;
}

console.log(
  '================ 過大ゼロ de-bias スイープ (' + SEGS.length + ' 業務×端末) ================\n'
);
const results = [];
for (const c of CONFIGS) {
  const ps = [];
  let maxP = -Infinity;
  let worstKey = '';
  for (const s of SEGS) {
    const eng = computeDistance(s.seg, dec, c.opts).distance_m / 1000;
    const p = pct(eng, s.tire);
    ps.push(p);
    if (p > maxP) {
      maxP = p;
      worstKey = s.key;
    }
  }
  const mean = ps.reduce((a, b) => a + b, 0) / ps.length;
  const minP = Math.min(...ps);
  const mae = ps.reduce((a, b) => a + Math.abs(b), 0) / ps.length;
  const overZero = maxP <= 0.05; // 過大ゼロ判定 (浮動小数 0.05% 許容)
  results.push({ name: c.name, mean, maxP, minP, mae, overZero, worstKey });
  console.log(
    `${c.name.padEnd(16)} 平均${(mean >= 0 ? '+' : '') + mean.toFixed(2)}%  最大${(maxP >= 0 ? '+' : '') + maxP.toFixed(2)}%(${worstKey})  最小${minP.toFixed(2)}%  MAE${mae.toFixed(2)}  ${overZero ? '✓過大ゼロ' : '★過大!'}`
  );
}

// 過大ゼロを保った中で「平均が最も 0 に近い」= タイヤに最も近い設定
const safe = results.filter((r) => r.overZero);
safe.sort((a, b) => Math.abs(a.mean) - Math.abs(b.mean));
console.log('\n=== 推奨 (過大ゼロ維持 & タイヤ最接近) ===');
if (safe.length) {
  const best = safe[0];
  console.log(
    `  ★ ${best.name}  平均${(best.mean >= 0 ? '+' : '') + best.mean.toFixed(2)}%  最大${best.maxP.toFixed(2)}%  MAE${best.mae.toFixed(2)}`
  );
} else {
  console.log('  過大ゼロを保つ設定なし(全て過大) → 別アプローチ要');
}
