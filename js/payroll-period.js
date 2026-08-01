// ============================================================
// js/payroll-period.js
// ★給与期間の区切り（司さんの実物と同じ）2026-08-01★
//
//   司さんの「代行計算表2026.xlsb」の給料1〜8 の作り:
//     1枚 = 11日分・開始は毎月21日・ヘッダは「◯月分  1/21 ~ 1/31」
//   司さん明言:「おれは毎月そのやり方」
//
//   ▼他のユーザー用に開始日と日数は設定で変えられる（1日始まり31日分なども可）
//   ▼throw しない・月末が28/30/31日でも落ちない（足りない分は翌月へまたぐ）
// ============================================================
(function (global) {
  'use strict';

  const DEFAULT_START_DAY = 21; // 司さん
  const DEFAULT_DAYS = 11; // 司さん

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

  // その月の期間（開始日から days 日ぶん）
  function periodOf(year, month, opts) {
    try {
      const y = n(year, new Date().getFullYear());
      const m = n(month, new Date().getMonth() + 1);
      let startDay = n(opts && opts.startDay, DEFAULT_START_DAY);
      let days = n(opts && opts.days, DEFAULT_DAYS);
      if (!(startDay >= 1 && startDay <= 28)) startDay = DEFAULT_START_DAY;
      if (!(days >= 1 && days <= 62)) days = DEFAULT_DAYS;

      const start = new Date(y, m - 1, startDay);
      const dates = [];
      for (let i = 0; i < days; i++) {
        const d = new Date(y, m - 1, startDay + i); // 月をまたいでも Date が繰り上げる
        dates.push(ymd(d));
      }
      const last = new Date(y, m - 1, startDay + days - 1);
      return {
        year: y,
        month: m,
        label: m + '月分',
        rangeLabel: md(start) + ' ~ ' + md(last),
        start: ymd(start),
        end: ymd(last),
        dates: dates,
      };
    } catch (_) {
      return { year: 0, month: 0, label: '', rangeLabel: '', start: '', end: '', dates: [] };
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
    DEFAULT_DAYS: DEFAULT_DAYS,
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
