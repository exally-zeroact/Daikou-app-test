// ============================================================
// scripts/kinshi-commit-msg.mjs
// ★commit の文に 実在の字（司さん・会社・お客さん・働く人の 本物）を 書かせない★ 2026-10-10
//
//   ★なぜ★
//     公開 repo の試験から 本物の住所や名前を消した commit の文に、消した本物の値と
//     「司さんの家」という札を そのまま書いていた（10-10 だけで 本番3本・テスト線3本）。
//     ファイルを直しても commit の文は 公開の履歴に残る。
//
//   ★一覧は repo に置かない★（置くと それ自体が 実在の字の一覧になる）
//     CI   … secret KINSHI_JI（1行に 1語）
//     手元 … ~/.tsukurimono/kinshi-ji.txt
//     どちらも無ければ「未測定」で 赤（黙って 通さない）。
//   ★当たっても 字は出さない★（公開の CI の記録は 誰でも読める）。出すのは 数と commit の頭だけ。
//
//   使い方:
//     node scripts/kinshi-commit-msg.mjs --file .git/COMMIT_EDITMSG   … commit-msg の門（.husky/commit-msg）
//     node scripts/kinshi-commit-msg.mjs --range <base>..<head>      … CI（push・PR の commit 全部）
//     node scripts/kinshi-commit-msg.mjs --self-test                 … 自分の歯を確かめる
// ============================================================
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';

// 札（場所を 辿る手がかりになる 書き方）。本物の値ではないので repo に置いてよい
export const FUDA = ['司さん家', '司さんの家', '司さん宅', '司さんの自宅'];

// 比べる前の ならし：全角/半角・大文字小文字・空白の揺れを ならす
export function narasu(s) {
  return String(s).normalize('NFKC').toLowerCase().replace(/\s+/g, '');
}

export function ichiran(text) {
  return String(text || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
}

// 当たった語の数だけを返す（字は返さない）
export function ataru(msg, words) {
  const m = narasu(msg);
  let n = 0;
  for (const w of words) {
    const k = narasu(w);
    if (k.length >= 2 && m.includes(k)) n++;
  }
  return n;
}

function yomuIchiran() {
  if (process.env.KINSHI_JI && process.env.KINSHI_JI.trim()) {
    return { words: ichiran(process.env.KINSHI_JI), from: 'secret KINSHI_JI' };
  }
  const p = join(homedir(), '.tsukurimono', 'kinshi-ji.txt');
  if (existsSync(p))
    return { words: ichiran(readFileSync(p, 'utf8')), from: '~/.tsukurimono/kinshi-ji.txt' };
  return null;
}

function selfTest() {
  const words = ['見本太郎', 'SAMPLE Co', '架空区見本台1-2-3'];
  const all = [...words, ...FUDA];
  const cases = [
    ['そのまま', '試験の 見本太郎 を消した', 1],
    ['全角と空白の揺れ', 'ＳＡＭＰＬＥ　ｃｏ を外す', 1],
    ['番地', '架空区見本台１－２－３ の点', 1],
    ['札', '司さんの家から 1.3km', 1],
    ['札の別の形', '司さん宅 のそば', 1],
    ['種類と数だけ', '付近の点を 2点 移した・実機の記録7本', 0],
    ['1字だけの語は 数えない', '見', 0],
  ];
  let ok = 0;
  for (const [name, msg, want] of cases) {
    const got = ataru(msg, name === '1字だけの語は 数えない' ? ['見'] : all) > 0 ? 1 : 0;
    const pass = got === want;
    if (pass) ok++;
    console.log(`${pass ? '✓' : '✗'} ${name}`);
  }
  console.log(`自己確認: ${ok}/${cases.length}`);
  return ok === cases.length;
}

function main() {
  const argv = process.argv.slice(2);
  const at = (k) => {
    const i = argv.indexOf(k);
    return i >= 0 ? argv[i + 1] : null;
  };
  if (argv.includes('--self-test')) {
    if (selfTest()) process.exitCode = 0;
    return;
  }
  const li = yomuIchiran();
  if (!li || !li.words.length) {
    console.error(
      '★未測定★ 禁止の字の一覧がありません（secret KINSHI_JI も ~/.tsukurimono/kinshi-ji.txt も無い）。'
    );
    console.error('  ★飛ばさない★＝見ていない物を 通すと 実在の字が 公開の履歴に入る。');
    return;
  }
  const words = [...li.words, ...FUDA];
  const file = at('--file');
  const range = at('--range');
  if (file) {
    const msg = readFileSync(file, 'utf8')
      .split(/\r?\n/)
      .filter((l) => !l.startsWith('#'))
      .join('\n');
    const n = ataru(msg, words);
    if (n) {
      console.error(
        `★commit の文に 実在の字か 札が ${n} 語 入っています★（字は出しません・一覧＝${li.from}）`
      );
      console.error(
        '  消した物は「付近の点を N点」「取引先 22社」のように 種類と数で書いてください。'
      );
      return;
    }
    console.log(`✓ commit の文の 実在の字 0 件（${words.length} 語で見た）`);
    process.exitCode = 0;
    return;
  }
  if (range) {
    const out = execFileSync('git', ['log', '--format=%H%x00%B%x01', range], { encoding: 'utf8' });
    const commits = out
      .split('\x01')
      .map((c) => c.trim())
      .filter(Boolean);
    let bad = 0;
    for (const c of commits) {
      const [sha, msg] = c.split('\x00');
      const n = ataru(msg || '', words);
      if (n) {
        bad++;
        console.error(`★${sha.slice(0, 9)} の文に 実在の字か 札が ${n} 語★（字は出しません）`);
      }
    }
    if (!commits.length) {
      console.error(`★未測定★ ${range} に commit が 0本（範囲の取り違え）`);
      return;
    }
    if (bad) return;
    console.log(`✓ commit の文の 実在の字 0 件（${commits.length} 本・${words.length} 語で見た）`);
    process.exitCode = 0;
    return;
  }
  console.error('使い方: --file <COMMIT_EDITMSG> | --range <base>..<head> | --self-test');
}

const isMain = (() => {
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1] || '');
  } catch (_) {
    return false;
  }
})();
if (isMain) {
  process.exitCode = 1; // ★既定は 赤★。通った1か所でだけ 0
  main();
}
