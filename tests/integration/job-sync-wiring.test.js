'use strict';
// ============================================================
// job-sync 配線テスト (2026-07-31)
//   ★「作ったのに繋がっていない」を防ぐ★ (社内ルール: 実装したら必ず配線確認)
//   ・index.html が job-sync.js を読み込み、起動処理から init() を呼んでいる
//   ・読込順が正しい(dk-config → job-sync)
//   ・sw.js の PRECACHE に入っている(オフライン起動で欠けない)
//   ・★job-sync が業務コア(距離・料金・business.js)に一切触っていない★
// ============================================================
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

describe('job-sync の配線', () => {
  const html = read('index.html');
  const src = read('js/job-sync.js');

  it('index.html が job-sync.js を読み込んでいる', () => {
    expect(html).toMatch(/<script src="js\/job-sync\.js"><\/script>/);
  });

  it('読込順: dk-config → job-sync (接続先が先に載る)', () => {
    const c = html.indexOf('js/dk-config.js');
    const j = html.indexOf('src="js/job-sync.js"');
    expect(c).toBeGreaterThan(-1);
    expect(j).toBeGreaterThan(-1);
    expect(c).toBeLessThan(j);
  });

  it('★起動処理から JobSync.init() が呼ばれている(呼ばれなければ一生送らない)★', () => {
    expect(html).toMatch(/window\.JobSync[\s\S]{0,120}\.init\(\)/);
  });

  it('sw.js の PRECACHE に入っている', () => {
    expect(read('sw.js')).toMatch(/['"]\/js\/job-sync\.js['"]/);
  });

  it('接続先を直書きしていない(dk-config 経由)', () => {
    expect(src).not.toMatch(/[a-z0-9]{15,}\.supabase\.co/);
    expect(src).toMatch(/_cfg\(\)/);
  });

  it('★業務コアに触っていない(距離・料金・メーター・business.js を参照しない)★', () => {
    // コメント行を除いた実コードだけを見る
    const code = src
      .split('\n')
      .map((l) => l.split('//')[0])
      .join('\n');
    expect(code).not.toMatch(/\bMeter\./);
    expect(code).not.toMatch(/\bBusiness\./);
    expect(code).not.toMatch(/distance_m\s*=/); // 距離への代入
    expect(code).not.toMatch(/calcFare/);
    expect(code).not.toMatch(/map-matcher/);
    expect(code).not.toMatch(/setBusinessActive/);
  });

  it('★履歴は読むだけ(書き換え・削除をしない)★', () => {
    const code = src
      .split('\n')
      .map((l) => l.split('//')[0])
      .join('\n');
    // 履歴キーへの setItem / removeItem が無いこと
    expect(code).not.toMatch(/setItem\(\s*HISTORY_KEY/);
    expect(code).not.toMatch(/removeItem\(\s*HISTORY_KEY/);
    expect(code).not.toMatch(/_set\(\s*HISTORY_KEY/);
  });
});

describe('job-sync の Edge Function', () => {
  const fn = read('supabase/functions/dk-sync-jobs/index.ts');

  it('端末が会社のものか確認している(よそからの書き込みを拒む)', () => {
    expect(fn).toMatch(/dk_company_devices/);
    expect(fn).toMatch(/unknown_device/);
  });

  it('冪等: 勤務は (company_id, device_id, started_at) で upsert', () => {
    expect(fn).toMatch(/onConflict:\s*'company_id,device_id,started_at'/);
  });

  it('★未払い(status=off)でもデータは受け取る(データを人質にしない)★', () => {
    // status で弾く分岐が無いこと
    expect(fn).not.toMatch(/status\s*===?\s*['"]off['"]/);
  });

  it('移設SQLに dk_shifts / dk_trips が入っている(引っ越しの取り残し防止)', () => {
    const sql = read('supabase/migrate-standalone.sql');
    expect(sql).toMatch(/create table if not exists dk_shifts/);
    expect(sql).toMatch(/create table if not exists dk_trips/);
    expect(sql).toMatch(/dk_shifts_owner_sel/);
    expect(sql).toMatch(/dk_trips_owner_sel/);
  });
});
