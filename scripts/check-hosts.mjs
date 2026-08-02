#!/usr/bin/env node
// ============================================================
// scripts/check-hosts.mjs
// ★4ホストの実物を叩いて、表(scripts/dk-hosts.mjs)どおりかを見る★ 2026-08-02
//
//   dk-hosts-pairing.test.js は「表が矛盾していないか」しか見ない（ネットに出ない）。
//   ★表が正しくても、実際に配信されている中身が違えば意味がない★ ので、ここで実物を見る。
//
//   見る物（読むだけ・1文字も変えない）:
//     1. / が開くか
//     2. js/dk-config.js の APP_BASE が、そのホストに正しい値か
//        ＝★事務所のQRが「別の側のメーター」を指していないか★（一番こわい取り違え）
//     3. 事務所に sw.js が居ないか（居ると「どのURLもメーターに化ける」事故が戻る）
//     4. メーターの /dashboard.html が事務所へ 308 で送られているか
//
//   使い方:
//     node scripts/check-hosts.mjs          … 表にある全ホスト
//     node scripts/check-hosts.mjs --side prod
//     node scripts/check-hosts.mjs --json
//
//   終了コード: 0=全部一致 / 1=違いあり
// ============================================================
import { HOSTS, sideOf } from './dk-hosts.mjs';

const argv = process.argv.slice(2);
const onlySide = (() => {
  const i = argv.indexOf('--side');
  return i >= 0 ? argv[i + 1] : null;
})();
const asJson = argv.includes('--json');

async function head(url) {
  try {
    const res = await fetch(url, { redirect: 'manual' });
    return { status: res.status, location: res.headers.get('location') || null };
  } catch (e) {
    return { status: 0, error: String(e && e.message ? e.message : e) };
  }
}

async function text(url) {
  try {
    const res = await fetch(url);
    if (!res.ok) return { status: res.status, body: null };
    return { status: res.status, body: await res.text() };
  } catch (e) {
    return { status: 0, error: String(e && e.message ? e.message : e) };
  }
}

function appBaseOf(body) {
  if (!body) return null;
  const m = body.match(/const\s+APP_BASE\s*=\s*'([^']+)'/);
  return m ? m[1] : null;
}

async function checkHost(host, spec) {
  const base = 'https://' + host;
  const out = { host, role: spec.role, side: spec.side, ng: [] };

  const root = await head(base + '/');
  out.root = root.status;
  if (root.status !== 200) out.ng.push(`/ が ${root.status}（開かない）`);

  const cfg = await text(base + '/js/dk-config.js');
  out.appBase = appBaseOf(cfg.body);
  if (!out.appBase) {
    out.ng.push(`js/dk-config.js から APP_BASE を読めない（HTTP ${cfg.status}）`);
  } else if (out.appBase !== spec.appBase) {
    out.ng.push(
      `★APP_BASE が違う: 実物=${out.appBase} / 表=${spec.appBase}★` +
        (sideOf(out.appBase.replace('https://', '')) &&
        sideOf(out.appBase.replace('https://', '')) !== spec.side
          ? ' ＝★側をまたいでいる。QRが反対側のメーターを指す★'
          : '')
    );
  }

  const sw = await head(base + '/sw.js');
  out.sw = sw.status;
  if (spec.serviceWorker) {
    if (sw.status !== 200) out.ng.push(`メーターなのに sw.js が ${sw.status}（圏外で動かなくなる）`);
  } else if (sw.status === 200) {
    out.ng.push('★事務所に sw.js が居る（どのURLもメーターに化ける事故が戻る）★');
  }

  // ★事務所のURLでメーター本体が出ないこと (2026-08-02 追加)★
  //   事務所はメーターを丸ごと proxy しているので、栓をしないと /index.html が素通りする。
  //   司さんが見た「どのURLもここにしかいかんけど」と見た目が同じ事故になる。
  if (spec.role === 'office') {
    const idx = await head(base + '/index.html');
    out.indexHtml = idx.status;
    if (idx.status === 200) {
      out.ng.push('★事務所の /index.html でメーター本体が出る（栓が無い）★');
    }
    // 事務所のトップは事務所の画面であること（メーターが出ていたら中身が入れ替わっている）
    const top = await text(base + '/');
    if (top.body && !/事務所|売上表|月次集計/.test(top.body)) {
      out.ng.push('★事務所のトップが事務所の画面でない（メーターが出ている可能性）★');
    }
  }

  // メーターの /dashboard.html は事務所へ送る（事務所側は proxy 先なので対象外）
  if (spec.role === 'meter') {
    const dash = await head(base + '/dashboard.html');
    out.dashboard = dash.status;
    out.dashboardTo = dash.location;
    const office = Object.entries(HOSTS).find(
      ([, h]) => h.role === 'office' && h.side === spec.side
    );
    const officeHost = office ? office[0] : null;
    if (dash.status !== 308 && dash.status !== 301) {
      out.ng.push(`/dashboard.html が ${dash.status}（事務所へ送っていない）`);
    } else if (officeHost && !(dash.location || '').includes(officeHost)) {
      out.ng.push(`/dashboard.html の行き先が ${dash.location}（${officeHost} ではない）`);
    }
  }

  return out;
}

const targets = Object.entries(HOSTS).filter(([, s]) => !onlySide || s.side === onlySide);
const results = [];
for (const [host, spec] of targets) results.push(await checkHost(host, spec));

if (asJson) {
  console.log(JSON.stringify(results, null, 2));
} else {
  console.log('★4ホストの実物を見た結果★');
  for (const r of results) {
    const mark = r.ng.length ? '✗' : '✓';
    console.log(
      `\n${mark} ${r.host}  [${r.role}/${r.side}]` +
        `\n    /=${r.root}  sw.js=${r.sw}` +
        (r.role === 'meter' ? `  /dashboard.html=${r.dashboard}→${r.dashboardTo || '-'}` : '') +
        `\n    APP_BASE=${r.appBase}`
    );
    r.ng.forEach((n) => console.log('    → ' + n));
  }
}

const bad = results.filter((r) => r.ng.length);
if (bad.length) {
  console.error(`\n★${bad.length}ホストが表と違います★`);
  process.exit(1);
}
console.log('\n全ホストが表どおりです。');
