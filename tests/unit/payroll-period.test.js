'use strict';
// ============================================================
// 給与期間の区切り テスト (2026-08-01 実物を読み直して修正)
//
//   ★正解は司さんの実物★ 代行計算表2026.xlsb の 給料1〜8 のヘッダと日付行を全部読んだ結果:
//     給料1 = 1月分 1/21 ~ 1/31 (11日)
//     給料2 = 2月分 2/21 ~ 2/28 ( 8日)   ← 翌月にまたいでいない
//     給料3 = 3月分 3/21 ~ 3/31 (11日)
//     給料4 = 4月分 4/21 ~ 4/30 (10日)
//     給料7 = 7月分 7/21 ~ 7/31 (11日)
//     給料8 = 8月分 8/1  ~ 8/10 (10日)  ← 開始日も長さも変えられる必要がある
//
//   ★つまり「11日ぶん固定」は1月だけたまたま合っていた★
//     本当は「21日から その月の末日まで」＝月末締め。長さは月で変わる。
//     （前に入れた days:11 のままだと 2月が 3/3 まで伸びて、2月分の明細に3月の日が混ざる）
//
//   ★守る性質★
//     1. 既定 = 21日始まり・月末締め（実物と同じ）
//     2. 日数固定にもできる（給料8のような 8/1~8/10）
//     3. 前後に送れる / 年をまたいでも落ちない
//     4. 何が来ても throw しない
// ============================================================
const P = require('../../js/payroll-period.js');

describe('★実物と同じ区切り（21日始まり・月末締め）★', () => {
  it('給料1 = 1月分 1/21〜1/31（11日）', () => {
    const p = P.periodOf(2026, 1);
    expect(p.label).toBe('1月分');
    expect(p.rangeLabel).toBe('1/21 ~ 1/31');
    expect(p.dates.length).toBe(11);
    expect(p.dates[0]).toBe('2026-01-21');
    expect(p.dates[10]).toBe('2026-01-31');
  });

  it('★給料2 = 2月分 2/21〜2/28（8日・3月に食い込まない）★', () => {
    const p = P.periodOf(2026, 2);
    expect(p.rangeLabel).toBe('2/21 ~ 2/28');
    expect(p.dates.length).toBe(8);
    expect(p.dates[0]).toBe('2026-02-21');
    expect(p.dates[7]).toBe('2026-02-28');
    expect(p.end).toBe('2026-02-28');
  });

  it('給料4 = 4月分 4/21〜4/30（10日）', () => {
    const p = P.periodOf(2026, 4);
    expect(p.rangeLabel).toBe('4/21 ~ 4/30');
    expect(p.dates.length).toBe(10);
    expect(p.dates[9]).toBe('2026-04-30');
  });

  it('給料7 = 7月分 7/21〜7/31（司さんが今使っている月）', () => {
    const p = P.periodOf(2026, 7);
    expect(p.label).toBe('7月分');
    expect(p.dates[0]).toBe('2026-07-21');
    expect(p.dates[10]).toBe('2026-07-31');
  });

  it('うるう年の2月（2028年）でも合う', () => {
    const p = P.periodOf(2028, 2);
    expect(p.dates.length).toBe(9);
    expect(p.dates[8]).toBe('2028-02-29');
  });

  it('12月 → 年末で切れる（翌年に食い込まない）', () => {
    const p = P.periodOf(2026, 12);
    expect(p.dates[0]).toBe('2026-12-21');
    expect(p.dates[p.dates.length - 1]).toBe('2026-12-31');
  });
});

describe('★給料8のような「日数で切る」形にもできる★', () => {
  it('8月分 8/1 ~ 8/10', () => {
    const p = P.periodOf(2026, 8, { startDay: 1, endMode: 'days', days: 10 });
    expect(p.rangeLabel).toBe('8/1 ~ 8/10');
    expect(p.dates.length).toBe(10);
    expect(p.dates[0]).toBe('2026-08-01');
    expect(p.dates[9]).toBe('2026-08-10');
  });

  it('日数で切ると月をまたいでもよい（21日始まり11日分）', () => {
    const p = P.periodOf(2026, 2, { startDay: 21, endMode: 'days', days: 11 });
    expect(p.dates.length).toBe(11);
    expect(p.dates[8]).toBe('2026-03-01');
  });

  it('1日始まり・月末締め＝ふつうの1ヶ月', () => {
    const p = P.periodOf(2026, 7, { startDay: 1 });
    expect(p.dates.length).toBe(31);
    expect(p.dates[0]).toBe('2026-07-01');
    expect(p.dates[30]).toBe('2026-07-31');
  });
});

describe('前後に送れる', () => {
  it('次の月へ', () => {
    expect(P.shift({ year: 2026, month: 7 }, 1)).toEqual({ year: 2026, month: 8 });
  });
  it('12月の次は翌年1月', () => {
    expect(P.shift({ year: 2026, month: 12 }, 1)).toEqual({ year: 2027, month: 1 });
  });
  it('1月の前は前年12月', () => {
    expect(P.shift({ year: 2026, month: 1 }, -1)).toEqual({ year: 2025, month: 12 });
  });
});

describe('壊れた値でも止まらない', () => {
  it('★何が来ても throw しない★', () => {
    expect(() => P.periodOf(null, null, null)).not.toThrow();
    expect(() => P.periodOf('x', 'y', 'z')).not.toThrow();
    expect(() => P.shift(null, null)).not.toThrow();
    expect(() => P.periodOf(2026, 7, { endMode: 'なにこれ' })).not.toThrow();
  });

  it('おかしな開始日は既定(21日)に倒す', () => {
    const p = P.periodOf(2026, 7, { startDay: 99 });
    expect(p.dates[0]).toBe('2026-07-21');
  });

  it('おかしな日数は既定に倒す', () => {
    const p = P.periodOf(2026, 7, { startDay: 21, endMode: 'days', days: -5 });
    expect(p.dates.length).toBe(11);
  });

  it('月が範囲外でも日付は作れる', () => {
    expect(() => P.periodOf(2026, 13)).not.toThrow();
    expect(() => P.periodOf(2026, 0)).not.toThrow();
  });
});
