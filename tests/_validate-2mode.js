'use strict';
// tests/_validate-2mode.js
// ★STEP1 検証ハーネス (2026-06-08・テストツール先行)★
//
// 目的: 距離コアの「現行(出荷)方式」と「2モード適応方式(将来 flag)」を、★実機 fixture を
//   業務別(代行開始→精算終了)に分割★ し、各業務でタイヤ値に対する誤差・過大ゼロ・3台収束を
//   並べて出す。2モード実装はこのハーネスの数値を ★越えられた時だけ★ 採用する(根拠なき置換禁止)。
//
// 絶対ルール: ①業務別のみ(合計/勝手な分割禁止 = feedback_daikome_business_only)
//   ②distance_m 算出のみ・calcFare 非依存 ③過大ゼロ=eng≤tire が最優先・国交省バンド -4%〜0%
//
// 実行: node tests/_validate-2mode.js  [--mode=current|two|both]
//   --mode=current : 出荷 DEFAULTS のみ (baseline 確立)
//   --mode=two     : adaptiveTwoMode:true のみ (実装後)
//   --mode=both    : 両方を並べて比較 (既定・実装後)
//
// 完全オフライン: roads-decoder.js + data/roads-ehime.js を global shim で eval。

const fs = require('fs');
const path = require('path');

const ARGV = process.argv.slice(2);
function argVal(name, def) {
  const hit = ARGV.find((a) => a.startsWith('--' + name + '='));
  return hit ? hit.split('=')[1] : def;
}
const MODE = argVal('mode', 'current'); // current | two | both

global.window = global;
global.self = global;
eval(fs.readFileSync(path.join(__dirname, '..', 'js', 'roads-decoder.js'), 'utf8'));
eval(fs.readFileSync(path.join(__dirname, '..', 'data', 'roads-ehime.js'), 'utf8'));
const dec = new global.RoadDecoder(global.ROADS_EHIME);
dec.buildOffsetTable();
const { computeDistance } = require(path.join(__dirname, '..', 'js', 'pipeline-distance.js'));

// ── 業務分割 (overcount-zero-routing.test.js と同一規則・biz.it/run===1 の連続区間) ──
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

// ── 真値表 (overcount-zero-routing.test.js から踏襲・愛媛実機)。tire[i]=trip(i+1) のタイヤ値(km) ──
// device グループ: 同一走行を複数端末が同時記録 → 3台収束(spread)の評価母集団。
const GROUPS = [
  {
    name: '0606 (愛媛・昼)',
    tire: [null, 3.57, 3.39],
    devices: [
      { dev: 'Android', f: '0606-Android.slim.json' },
      { dev: 'iPhone13', f: '0606-iPhone13.slim.json' },
      { dev: 'iPhoneSE', f: '0606-iPhoneSE.slim.json' },
    ],
  },
  {
    name: 'realtest3 (愛媛)',
    tire: [1.5, 8.58, 9.59, 1.72],
    devices: [
      { dev: 'Android', f: 'realtest3-Android.slim.json' },
      { dev: 'iPhoneSE', f: 'realtest3-iPhoneSE.slim.json' },
    ],
  },
];

// ── 距離計算 (mode 別 opts) ──
function optsFor(mode) {
  if (mode === 'two') return { enableRouting: true, adaptiveTwoMode: true };
  // current = 出荷 DEFAULTS (smoothedRawMode) 明示
  return { enableRouting: true };
}

function computeTrip(seg, mode) {
  return computeDistance(seg, dec, optsFor(mode)).distance_m / 1000;
}

// ── 評価実行 ──
const MODES = MODE === 'both' ? ['current', 'two'] : [MODE];

function pct(eng, tire) {
  return (eng / tire - 1) * 100;
}
function fmtPct(p) {
  return (p >= 0 ? '+' : '') + p.toFixed(2) + '%';
}

console.log('===============================================================');
console.log(' 2モード検証ハーネス  mode=' + MODE + '  (業務別・タイヤ値基準)');
console.log('===============================================================');

const summary = { overcount: [], underband: [], rows: [] };

for (const g of GROUPS) {
  console.log('\n■ ' + g.name);
  // trip index ごとに device 値を集めて spread を出す
  const tripCount = g.tire.length;
  for (let ti = 0; ti < tripCount; ti++) {
    const tv = g.tire[ti];
    if (tv == null) continue;
    const perMode = {};
    for (const mode of MODES) perMode[mode] = [];
    const devLabels = [];
    for (const d of g.devices) {
      const fx = loadFixture(d.f);
      if (!fx || !fx.trips[ti]) continue;
      const tr = fx.trips[ti];
      const seg = fx.all.slice(tr.s, tr.e + 1);
      devLabels.push(d.dev);
      for (const mode of MODES) {
        const eng = computeTrip(seg, mode);
        const p = pct(eng, tv);
        perMode[mode].push({ dev: d.dev, eng, p });
        summary.rows.push({ group: g.name, trip: ti + 1, mode, dev: d.dev, eng, tire: tv, p });
        if (p > 0.05)
          summary.overcount.push(
            `${g.name} trip${ti + 1} ${d.dev} [${mode}] ${fmtPct(p)} (eng=${eng.toFixed(3)} tire=${tv})`
          );
        if (p < -4)
          summary.underband.push(`${g.name} trip${ti + 1} ${d.dev} [${mode}] ${fmtPct(p)} 過小`);
      }
    }
    console.log(`  trip${ti + 1}  tire=${tv}km  端末[${devLabels.join('/')}]`);
    for (const mode of MODES) {
      const arr = perMode[mode];
      if (!arr.length) continue;
      const ps = arr.map((x) => x.p);
      const spread = Math.max(...ps) - Math.min(...ps);
      const detail = arr.map((x) => `${x.dev}=${x.eng.toFixed(3)}(${fmtPct(x.p)})`).join('  ');
      console.log(`     [${mode.padEnd(7)}] ${detail}   spread=${spread.toFixed(2)}pt`);
    }
  }
}

console.log('\n===============================================================');
console.log(' 判定');
console.log('===============================================================');
console.log('  過大 (eng>tire+0.05%) 違反: ' + summary.overcount.length + ' 件');
for (const v of summary.overcount) console.log('    ★過大 ' + v);
console.log('  過小 (< -4% 国交省バンド外) 違反: ' + summary.underband.length + ' 件');
for (const v of summary.underband) console.log('    ★過小 ' + v);

// mode ごとの平均絶対誤差・最大過大
for (const mode of MODES) {
  const rows = summary.rows.filter((r) => r.mode === mode);
  if (!rows.length) continue;
  const mae = rows.reduce((s, r) => s + Math.abs(r.p), 0) / rows.length;
  const maxOver = Math.max(...rows.map((r) => r.p));
  const minP = Math.min(...rows.map((r) => r.p));
  console.log(
    `  [${mode}] 平均絶対誤差=${mae.toFixed(2)}pt  最大過大=${fmtPct(maxOver)}  最大過小=${fmtPct(minP)}  (n=${rows.length})`
  );
}

const pass = summary.overcount.length === 0 && summary.underband.length === 0;
console.log('\n=== ' + (pass ? 'PASS (全業務 過大ゼロ + バンド内)' : 'FAIL') + ' ===');

// 結果を JSON 保存 (CI/比較用)
const OUT = path.join(__dirname, '..', 'data', 'test-results');
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(
  path.join(OUT, 'validate-2mode.json'),
  JSON.stringify({ mode: MODE, pass, summary }, null, 2)
);

if (!pass) process.exit(1);
