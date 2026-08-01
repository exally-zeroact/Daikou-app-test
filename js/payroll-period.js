// ============================================================
// js/payroll-period.js
// ★給与期間の区切り（司さんの実物と同じ）2026-08-01★
//
//   司さんの「代行計算表2026.xlsb」の給料1〜8 を全部読んで確かめた作り:
//     給料1 = 1月分 1/21 ~ 1/31 (11日)
//     給料2 = 2月分 2/21 ~ 2/28 ( 8日)  ← ★3月に食い込まない★
//     給料3 = 3月分 3/21 ~ 3/31 (11日)
//     給料4 = 4月分 4/21 ~ 4/30 (10日)
//     給料8 = 8月分 8/1  ~ 8/10 (10日)  ← 開始日も長さも変えられる必要がある
//
//   ★つまり「毎回11日分」ではない。「21日から その月の末日まで」＝月末締め★
//     長さは月によって 8日〜11日 と変わる。
//     （日数を11で固定すると、2月分の明細に3月1日〜3日が混ざって金額が合わなくなる）
//
//   ▼設定で変えられる（他のユーザー用）
//     startDay … 起算日（既定21日）
//     endMode  … 'month_end'(既定・月末締め) / 'days'(日数で切る)
//     days     … endMode='days' のときの日数
//   ▼throw しない・うるう年でも落ちない
// ============================================================
(function (global) {
  'use strict';

  const DEFAULT_START_DAY = 21; // 司さん
  const DEFAULT_END_MODE = 'month_end'; // 司さん（21日〜末日）
  const DEFAULT_DAYS = 11; // endMode='days' のときの既定

  function n(v, d) {
    const x = typeof v === 'number' ? v : parseInt(v, 10);
    return isFinite(x) ? x : d;
  }

  function pad(x) {
    return x < 10 ? '0' + x : String(x);
  }
  function ymd(d) {
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }
  function md(d) {
    return d.getMonth() + 1 + '/' + d.getDate();
  }

  // その月の日数（うるう年もこれで正しく出る）
  function daysInMonth(year, month1) {
    return new Date(year, month1, 0).getDate();
  }

  // その月の期間
  function periodOf(year, month, opts) {
    try {
      const now = new Date();
      const y = n(year, now.getFullYear());
      const m = n(month, now.getMonth() + 1);
      let startDay = n(opts && opts.startDay, DEFAULT_START_DAY);
      if (!(startDay >= 1 && startDay <= 28)) startDay = DEFAULT_START_DAY;

      const endMode = (opts && opts.endMode) === 'days' ? 'days' : DEFAULT_END_MODE;

      let days;
      if (endMode === 'days') {
        days = n(opts && opts.days, DEFAULT_DAYS);
        if (!(days >= 1 && days <= 62)) days = DEFAULT_DAYS;
      } else {
        // 月末締め: 起算日からその月の末日まで
        days = daysInMonth(y, m) - startDay + 1;
        if (!(days >= 1)) days = 1;
      }

      const start = new Date(y, m - 1, startDay);
      const dates = [];
      for (let i = 0; i < days; i++) {
        // 月をまたいでも Date が繰り上げる（endMode='days' のとき）
        dates.push(ymd(new Date(y, m - 1, startDay + i)));
      }
      const last = new Date(y, m - 1, startDay + days - 1);
      return {
        year: y,
        month: m,
        startDay: startDay,
        endMode: endMode,
        days: days,
        label: m + '月分',
        rangeLabel: md(start) + ' ~ ' + md(last),
        start: ymd(start),
        end: ymd(last),
        dates: dates,
      };
    } catch (_) {
      return {
        year: 0,
        month: 0,
        startDay: DEFAULT_START_DAY,
        endMode: DEFAULT_END_MODE,
        days: 0,
        label: '',
        rangeLabel: '',
        start: '',
        end: '',
        dates: [],
      };
    }
  }

  // 月を前後に送る
  function shift(ym, delta) {
    try {
      const y = n(ym && ym.year, new Date().getFullYear());
      const m = n(ym && ym.month, new Date().getMonth() + 1);
      const d = n(delta, 0);
      const t = new Date(y, m - 1 + d, 1);
      return { year: t.getFullYear(), month: t.getMonth() + 1 };
    } catch (_) {
      return { year: new Date().getFullYear(), month: new Date().getMonth() + 1 };
    }
  }

  const api = {
    DEFAULT_START_DAY: DEFAULT_START_DAY,
    DEFAULT_END_MODE: DEFAULT_END_MODE,
    DEFAULT_DAYS: DEFAULT_DAYS,
    daysInMonth: daysInMonth,
    periodOf: periodOf,
    shift: shift,
  };

  if (global) global.PayrollPeriod = api;
  /* eslint-disable no-undef */
  if (typeof module !== 'undefined' && typeof module.exports !== 'undefined') {
    module.exports = api;
  }
  /* eslint-enable no-undef */
})(typeof window !== 'undefined' ? window : globalThis);
