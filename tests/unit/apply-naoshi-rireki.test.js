// ============================================================
// scripts/apply-naoshi-rireki.mjs の 守り（直しの履歴 ⑦・2026-11-08）
//   ①本物の SQL から 関数の 塊だけ 切り出せる
//   ②中に 書き換え・execute 等が 混ざったら 止まる／insert の 先が 違えば 止まる／名簿に 無い 関数を 呼べば 止まる
//   ③security definer・search_path '' が 無ければ 止まる（注釈の 字では 通さない）
//   ④道具が 書く 仕掛けは 21表 × 3本・呼ぶ 先は 1つ・ON は 名簿だけ
//   ⑤読み戻しの 判じ：わざと 壊した 4つ（ON 違い・呼ぶ 関数違い・using (true)・ochi の RLS 抜け）が 全部 NG
// ============================================================
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const ROOT = path.resolve(__dirname, '..', '..');
let M;
beforeAll(async () => {
  M = await import(pathToFileURL(path.join(ROOT, 'scripts', 'apply-naoshi-rireki.mjs')).href);
});
const SQL = fs.readFileSync(path.join(ROOT, 'supabase', 'apply-naoshi-rireki.sql'), 'utf8');
const MEJIRUSHI = '  return null;\nend;\n$fn$;';

describe('apply-naoshi-rireki の 守り', () => {
  it('① 関数の 塊だけ 切り出す', () => {
    const b = M.kiridasu(SQL);
    expect(b.startsWith(M.ATAMA)).toBe(true);
    expect(b.trimEnd().endsWith('$fn$;')).toBe(true);
    expect(SQL).toContain(MEJIRUSHI);
  });
  for (const [na, ire, kotae] of [
    ['update', 'update daikou.meisai set amount = 0;', 'update'],
    ['delete', 'delete from daikome.dk_naoshi_rireki;', 'delete'],
    ['execute', "execute 'dro' || 'p table daikou.meisai';", 'execute'],
    ['perform', 'perform daikome.is_dk_admin();', 'perform'],
    ['set_config', "v_x := set_config('role', 'postgres', true);", 'set_config'],
    ['dblink', "v_x := dblink('x', 'y');", 'dblink'],
    ['insert の 先違い', 'insert into daikou.meisai (amount) values (1);', 'daikou.meisai'],
    [
      '引用符の insert の 先違い',
      'insert into "daikou"."payments" (paid) values (1);',
      'daikou.payments',
    ],
    ['名簿に 無い 関数', 'v_x := daikome.is_dk_admin();', 'daikome.is_dk_admin'],
    ['名簿に 無い 関数（pg_sleep）', 'v_x := pg_sleep(10);', 'pg_sleep'],
  ]) {
    it('② ' + na + ' が 在れば 止まる', () => {
      const s = SQL.replace(MEJIRUSHI, '  ' + ire + '\n' + MEJIRUSHI);
      expect(s).not.toBe(SQL);
      expect(() => M.kiridasu(s)).toThrow(kotae);
    });
  }
  it('② 文字列や 注釈の 中の 字では 止まらない', () => {
    const s = SQL.replace(
      MEJIRUSHI,
      "  -- update delete execute\n  raise warning 'update delete %', 1;\n" + MEJIRUSHI
    );
    expect(() => M.kiridasu(s)).not.toThrow();
  });
  it('③ 注釈の 字では security definer に ならない', () => {
    const s = SQL.replace('security definer\n', 'security invoker -- security definer\n');
    expect(s).not.toBe(SQL);
    expect(() => M.kiridasu(s)).toThrow('security');
  });
  it("③ search_path が '' で なければ 止まる", () => {
    const s = SQL.replace("set search_path = ''", 'set search_path = public');
    expect(s).not.toBe(SQL);
    expect(() => M.kiridasu(s)).toThrow('search_path');
  });
  it('④ 仕掛けは 21表 × 3本・呼ぶ 先は 1つ', () => {
    const s = M.shikake();
    expect(M.TAISHO.length).toBe(21);
    expect(s.length).toBe(63);
    for (const x of s) {
      expect(x).toMatch(/ execute function daikome\.dk_naoshi_kiroku\(\);$/);
      expect(x).toMatch(/for each statement/);
      const on = x.match(/ on (\S+) /)[1];
      expect(M.TAISHO).toContain(on);
    }
    expect(M.TAISHO).not.toContain('daikome.dk_trips');
  });
  it('④ 決まりは select だけ・ochi に 決まりを 置かない', () => {
    const k = M.kimatta().join('\n');
    expect((k.match(/create policy/g) || []).length).toBe(2);
    expect((k.match(/for select to authenticated/g) || []).length).toBe(2);
    expect(k).not.toMatch(/create policy[^\n]*dk_naoshi_rireki_ochi/);
    expect(k).toMatch(/alter table daikome\.dk_naoshi_rireki_ochi enable row level security/);
    expect(k).not.toMatch(/using \(true\)/);
  });

  // 当てた 後の 読み戻しの 判じ
  const yoi = () => {
    const na = M.shikake()
      .map((s) => {
        const m = s.match(/trigger (\S+) after \w+ on (\S+) /);
        return m[2] + ':' + m[1];
      })
      .sort();
    return {
      shikake: 63,
      shikake_zen: 63,
      shikake_na: na,
      rls: true,
      hyou: 2,
      kimari: [
        {
          na: 'dk_naoshi_rireki_kome',
          cmd: 'SELECT',
          qual: '(company_id IN ( SELECT ... ( SELECT auth.uid() AS uid)))',
        },
        {
          na: 'dk_naoshi_rireki_kou',
          cmd: 'SELECT',
          qual: '(user_id = ( SELECT auth.uid() AS uid))',
        },
      ],
      kimari_ochi: 0,
      definer: true,
      kengen: true,
      d: M.kiridasu(SQL),
    };
  };
  it('⑤ 正しい 読み戻しは NG 0', () => {
    expect(M.hanjiru(yoi(), true)).toEqual([]);
  });
  for (const [na, kowasu] of [
    ['ON 違い', (r) => (r.shikake_na[0] = 'daikome.dk_trips:' + r.shikake_na[0].split(':')[1])],
    ['呼ぶ 関数違い', (r) => (r.shikake = 62)],
    ['using (true)', (r) => (r.kimari[1].qual = 'true')],
    ['ochi の RLS 抜け', (r) => (r.rls = false)],
    ['ochi に 決まり', (r) => (r.kimari_ochi = 1)],
    ['決まりが insert', (r) => (r.kimari[0].cmd = 'INSERT')],
    ['invoker', (r) => (r.definer = false)],
    ['authenticated の select 抜け（42501）', (r) => (r.kengen = false)],
  ]) {
    it('⑤ わざと 壊す：' + na + ' は NG', () => {
      const r = yoi();
      kowasu(r);
      expect(M.hanjiru(r, true).length).toBeGreaterThan(0);
    });
  }
});
