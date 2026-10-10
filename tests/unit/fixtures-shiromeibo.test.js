'use strict';
// ============================================================
// ★tests/fixtures の白名簿の門★ 2026-10-10
//
//   公開 repo の tests/fixtures に 実機の走りの記録（GPS）が入っていて、
//   家のそばの点や 客の乗り降りの場所が 誰でも取れた（配信からは .vercelignore で外した）。
//   今ある実機の記録22本は 試験の真値の材料なので 残すが、★これから先は 足させない★。
//
//   名簿 = tests/fixtures-shiromeibo.json（名前・git の中身の sha256・種類）
//     ・名簿に無いファイルが tests/fixtures に足された → 赤
//     ・名簿の sha256 と中身が違う（中身を差し替えた）→ 赤
//     ・「実機（凍結）」は 下の FROZEN の名前だけ＝新しい実機の記録を 名簿に足しても 赤
//     ・新しく足せるのは「合成」「公」だけ
//   新しい実機の記録は repo の外（tests/lib/trace-zairyou.js の DK_TRACE_DIR の先例）に置き、手元で走らせる。
//
//   sha256 は 作業木でなく git の中身（blob）から取る＝Windows の改行の変換で ずれない。
// ============================================================
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const MEIBO = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'tests', 'fixtures-shiromeibo.json'), 'utf8')
);
const KINDS = new Set(['実機（凍結）', '合成', '公']);

// 2026-10-10 に凍結した 実機の走りの記録（これ以外の名前を「実機」で足すのは 赤）
const FROZEN = new Set([
  '0606-Android.slim.json',
  '0606-iPhone13.slim.json',
  '0606-iPhoneSE.slim.json',
  '0610-Android.json',
  '0610-iPhone13.json',
  '0610-iPhoneSE.json',
  '0610b-Android.json',
  'real-trace-iphone13-8.39km-tire.json',
  'real-trace-iphone13-親-16min.json',
  'real-trace-iphone13-親-7min-after-38ed5e46.json',
  'real-trace-iphoneSE-5km-tire5.0.json',
  'realdevice-android.json',
  'realdevice-iphone13-noisy.json',
  'realdevice-iphonese.json',
  'realtest3-Android.slim.json',
  'realtest3-iPhoneSE.slim.json',
  'realtrace-0609-Android-OBD.json',
  'realtrace-0617-daiko-dm.json',
  'realtrace-0618-shimanami-obd.json',
  'shimanami-Android.slim.json',
  'shimanami-iPhone13.slim.json',
  'shimanami-iPhoneSE.slim.json',
]);

// git が追っている tests/fixtures の 名前 → sha256（git の中身から）
function oiteAru() {
  const out = execFileSync('git', ['-C', ROOT, 'ls-files', '-s', '-z', 'tests/fixtures'], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  const m = new Map();
  for (const rec of out.split('\0').filter(Boolean)) {
    const [meta, p] = rec.split('\t');
    const oid = meta.split(' ')[1];
    const buf = execFileSync('git', ['-C', ROOT, 'cat-file', 'blob', oid], {
      maxBuffer: 256 * 1024 * 1024,
    });
    m.set(p.replace('tests/fixtures/', ''), crypto.createHash('sha256').update(buf).digest('hex'));
  }
  return m;
}

export function terasu(aru, meibo) {
  const bad = [];
  for (const [name, sha] of aru) {
    const it = meibo[name];
    if (!it) bad.push(`名簿に無い: ${name}`);
    else if (it.sha256 !== sha) bad.push(`中身が名簿と違う: ${name}`);
  }
  for (const [name, it] of Object.entries(meibo)) {
    if (!KINDS.has(it.kind)) bad.push(`種類が読めない: ${name}`);
    if (it.kind === '実機（凍結）' && !FROZEN.has(name)) bad.push(`新しい実機の記録: ${name}`);
    if (!aru.has(name)) bad.push(`名簿にだけ在る（消したら名簿からも消す）: ${name}`);
  }
  return bad;
}

describe('★tests/fixtures の白名簿★', () => {
  const aru = oiteAru();

  it('★見る相手が 本当に居る★（git が読めずに 0本で緑にならない）', () => {
    expect(aru.size).toBeGreaterThan(10);
  });

  it('★名簿と 名前・中身が 全部 合う★', () => {
    expect(terasu(aru, MEIBO.items)).toEqual([]);
  });

  it('実機（凍結）は 22本を超えない', () => {
    const n = Object.values(MEIBO.items).filter((i) => i.kind === '実機（凍結）').length;
    expect(n).toBeLessThanOrEqual(FROZEN.size);
  });
});

describe('★門の歯（わざと壊して 赤になる）★', () => {
  const aru = new Map([
    ['a.json', 'x1'],
    ['synthetic-b.jsonl', 'x2'],
  ]);
  const ok = {
    'a.json': { sha256: 'x1', kind: '合成' },
    'synthetic-b.jsonl': { sha256: 'x2', kind: '合成' },
  };

  it('合う時は 何も出ない', () => {
    expect(terasu(aru, ok)).toEqual([]);
  });

  it('★名簿に無いファイルを足すと 赤★', () => {
    const a2 = new Map(aru).set('new-trace.json', 'x3');
    expect(terasu(a2, ok)).toContain('名簿に無い: new-trace.json');
  });

  it('★名前はそのまま 中身を差し替えると 赤★', () => {
    const a2 = new Map(aru).set('synthetic-b.jsonl', 'zz');
    expect(terasu(a2, ok)).toContain('中身が名簿と違う: synthetic-b.jsonl');
  });

  it('★新しい実機の記録を 名簿に「実機」で足しても 赤★', () => {
    const a2 = new Map(aru).set('realtrace-1231.json', 'x4');
    const m2 = { ...ok, 'realtrace-1231.json': { sha256: 'x4', kind: '実機（凍結）' } };
    expect(terasu(a2, m2)).toContain('新しい実機の記録: realtrace-1231.json');
  });

  it('名簿にだけ在る名前は 赤（名簿を古いまま残さない）', () => {
    const m2 = { ...ok, 'gone.json': { sha256: 'x9', kind: '合成' } };
    expect(terasu(aru, m2)).toContain('名簿にだけ在る（消したら名簿からも消す）: gone.json');
  });
});
