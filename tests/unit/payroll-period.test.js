'use strict';
// ============================================================
// 給与期間の区切り テスト (2026-08-01)
//
//   ★司さんの実物（代行計算表2026.xlsb の給料1〜8）に合わせる★
//     1枚 = 11日分。開始は毎月21日。ヘッダは「◯月分  1/21 ~ 1/31」。
//     司さん明言:「おれは毎月そのやり方」
//
//   ★守る性質★
//     1. 21日始まり・11日分（実物と同じ）
//     2. 前後に送れる
//     3. 月末が31日でも30日でも28日でも落ちない
//     4. 開始日・日数は設定で変えられる（他のユーザー用）
//     5. 何が来ても throw しない
// ============================================================
const P = require('../../js/payroll-period.js');

describe('★実物と同じ区切り（21日始まり・11日分）★', () => {
  it('2026年1月 → 1/21〜1/31', () => {
    const p = P.periodOf(2026, 1, { startDay: 21, days: 11 });
    expect(p.label).toBe('1月分');
    expect(p.rangeLabel).toBe('1/21 ~ 1/31');
    expect(p.dates.length).toBe(11);
    expect(p.dates[0]).toBe('2026-01-21');
    expect(p.dates[10]).toBe('2026-01-31');
  });

  it('2026年7月 → 7/21〜7/31（司さんが今使っている月）', () => {
    const p = P.periodOf(2026, 7, { startDay: 21, days: 11 });
    expect(p.label).toBe('7月分');
    expect(p.dates[0]).toBe('2026-07-21');
    expect(p.dates[10]).toBe('2026-07-31');
  });

  it('★2月（28日まで）でも落ちない＝翌月へまたぐ★', () => {
    const p = P.periodOf(2026, 2, { startDay: 21, days: 11 });
    expect(p.dates.length).toBe(11);
    expect(p.dates[0]).toBe('2026-02-21');
    expect(p.dates[7]).toBe('2026-02-28');
    expect(p.dates[8]).toBe('2026-03-01'); // 月をまたぐ
    expect(p.dates[10]).toBe('2026-03-03');
  });

  it('30日までの月（4月）', () => {
    const p = P.periodOf(2026, 4, { startDay: 21, days: 11 });
    expect(p.dates[9]).toBe('2026-04-30');
    expect(p.dates[10]).toBe('2026-05-01');
  });

  it('12月 → 年をまたぐ', () => {
    const p = P.periodOf(2026, 12, { startDay: 21, days: 11 });
    expect(p.dates[0]).toBe('2026-12-21');
    expect(p.dates[10]).toBe('2026-12-31');
  });
});

describe('前後に送れる', () => {
  it('次の月へ', () => {
    const p = P.shift({ year: 2026, month: 7 }, 1);
    expect(p).toEqual({ year: 2026, month: 8 });
  });
  it('12月の次は翌年1月', () => {
    expect(P.shift({ year: 2026, month: 12 }, 1)).toEqual({ year: 2027, month: 1 });
  });
  it('1月の前は前年12月', () => {
    expect(P.shift({ year: 2026, month: 1 }, -1)).toEqual({ year: 2025, month: 12 });
  });
});

describe('設定で変えられる（他のユーザー用）', () => {
  it('1日始まり・31日分にもできる', () => {
    const p = P.periodOf(2026, 7, { startDay: 1, days: 31 });
    expect(p.dates[0]).toBe('2026-07-01');
    expect(p.dates[30]).toBe('2026-07-31');
    expect(p.dates.length).toBe(31);
  });

  it('10日始まり・10日分', () => {
    const p = P.periodOf(2026, 7, { startDay: 10, days: 10 });
    expect(p.dates[0]).toBe('2026-07-10');
    expect(p.dates[9]).toBe('2026-07-19');
  });
});

describe('壊れた値でも止まらない', () => {
  it('★何が来ても throw しない★', () => {
    expect(() => P.periodOf(null, null, null)).not.toThrow();
    expect(() => P.periodOf('x', 'y', 'z')).not.toThrow();
    expect(() => P.shift(null, null)).not.toThrow();
  });

  it('おかしな開始日・日数は既定に倒す', () => {
    const p = P.periodOf(2026, 7, { startDay: 99, days: -5 });
    expect(p.dates.length).toBe(11); // 既定
    expect(p.dates[0]).toBe('2026-07-21'); // 既定
  });
});
