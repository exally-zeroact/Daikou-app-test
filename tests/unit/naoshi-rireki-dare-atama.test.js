'use strict';
// ============================================================
// 直しの履歴（⑦）2押し目＝関数2本が 頭 x-dk-dare を 付けているか（2026-11-08）
//   倉庫の 仕掛け daikome.dk_naoshi_kiroku() は service_role の 書き込みの「誰」を この 頭で 決める。
//   頭が 無いと 全部「kansu:service_role」に なり、運転手の 直しと 事務所の 直しが 見分けられない。
// ============================================================
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

// service_role の 口（createClient(…SERVICE_ROLE_KEY…, {…})）を 字で 拾う
function serviceKuchi(src) {
  // 呼びごとに 区切る（次の createClient( か「);」で 止める＝別の 口を 1つに 拾わない）
  const out = [];
  let i = src.indexOf('createClient(');
  while (i >= 0) {
    const tsugi = src.indexOf('createClient(', i + 1);
    const owari = src.indexOf(');', i);
    const end = Math.min(tsugi < 0 ? Infinity : tsugi, owari < 0 ? Infinity : owari);
    const body = src.slice(i, end === Infinity ? undefined : end);
    if (body.includes('SUPABASE_SERVICE_ROLE_KEY')) out.push({ at: i, body });
    i = tsugi;
  }
  return out;
}

function syncOk(src) {
  const k = serviceKuchi(src);
  if (k.length !== 1) return 'service_role の 口が ' + k.length + '個';
  if (
    !/'x-dk-dare':\s*\('device:'\s*\+\s*encodeURIComponent\(device_id\)\)\.slice\(0,\s*200\)/.test(
      k[0].body
    )
  )
    return '頭が device:<encodeURIComponent(device_id)> で ない';
  // 書き込みは 端末の 確かめの 後だけ（口の 後に unknown_device が 来て、upsert/insert は その 後）
  const chk = src.indexOf("reason: 'unknown_device'");
  const kaki = src.search(/\.(upsert|insert|update|delete)\(/);
  if (chk < 0 || kaki < 0 || kaki < chk) return '端末の 確かめより 前に 書く 所が 在る';
  return '';
}

function fixOk(src) {
  const k = serviceKuchi(src);
  if (k.length !== 1) return 'service_role の 口が ' + k.length + '個';
  if (!/'x-dk-dare':\s*'jimusho:'\s*\+\s*uid\b/.test(k[0].body))
    return '頭が jimusho:<uid> で ない';
  const uidAt = src.indexOf("reason: 'no_user'");
  if (uidAt < 0 || k[0].at < uidAt) return '口が uid を 確かめる 前に 作られている';
  return '';
}

describe('直しの履歴（⑦）の 頭 x-dk-dare', () => {
  const sync = read('supabase/functions/dk-sync-jobs/index.ts');
  const fix = read('supabase/functions/dk-fix-fare/index.ts');

  it('dk-sync-jobs＝device:<端末>（ASCII に 包む・200字まで）・書くのは 端末の 確かめの 後', () => {
    expect(syncOk(sync)).toBe('');
  });

  it('dk-fix-fare＝jimusho:<uid>・口は uid を 確かめた 後', () => {
    expect(fixOk(fix)).toBe('');
  });

  it('わざと 壊す：頭を 外す・包まない・uid の 前に 口を 作る＝全部 赤', () => {
    expect(
      syncOk(sync.replace(/,\s*\{ global: \{ headers: \{ 'x-dk-dare'[^\n]*\n/, '\n'))
    ).not.toBe('');
    expect(syncOk(sync.replace('encodeURIComponent(device_id)', 'device_id'))).not.toBe('');
    expect(fixOk(fix.replace("'jimusho:' + uid", "'jimusho:?'"))).not.toBe('');
    const mae = fix.replace(
      '  // ★呼んだ人を 確かめる★',
      "  const sb0 = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);\n  // ★呼んだ人を 確かめる★"
    );
    expect(fixOk(mae)).not.toBe('');
  });

  it('頭の 字は 倉庫の 仕掛けが 受ける 形（device:/jimusho: の 頭・ASCII）', () => {
    const atama = ('device:' + encodeURIComponent('運転手の 端末')).slice(0, 200);
    expect(/^[\x21-\x7e]+$/.test(atama)).toBe(true);
    expect(atama.split(':')[0]).toBe('device');
  });
});
