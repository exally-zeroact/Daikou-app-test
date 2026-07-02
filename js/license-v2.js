// ============================================================
// js/license-v2.js
// ★ライセンスv2 状態機械 (2026-07-02・会社URL/QR+署名トークン方式・STEP2の純ロジック)★
//
//   evaluateLicense(payload, nowMs, {running}) = 純関数。副作用なし・距離/課金に無関係。
//   payload = 署名検証済みトークンの中身 or null。{ exp(ms), status:'on'|'off', company_id, device_id, vin }
//     ※署名検証(crypto Ed25519)は別モジュール。ここは「検証済み中身→状態」だけ。
//   返り: { state, allowed, daysLeft, message }
//     state:  'active' | 'warning'(残り<=WARN_DAYS日) | 'expired'(期限切れ or status off) | 'unlicensed'
//     allowed: 業務開始してよいか。★running=true(業務中/客乗せ中)は常に true=絶対止めない★
//     message: 客前に出る想定なので中立(「未払い/料金/支払」は出さない)
// ============================================================
(function () {
  'use strict';

  const WARN_DAYS = 7; // 残りこの日数以下で「Wi-Fiのある所で開いて」警告
  const DAY = 24 * 60 * 60 * 1000;

  function evaluateLicense(payload, nowMs, opts) {
    opts = opts || {};
    const running = opts.running === true;

    let state, daysLeft, message;

    if (!payload || typeof payload !== 'object') {
      state = 'unlicensed';
      daysLeft = 0;
      message = 'ライセンスがありません。会社から配布されたURL/QRで有効化してください';
    } else {
      const exp = Number(payload.exp) || 0;
      const off = payload.status === 'off';
      if (off) {
        state = 'expired';
        daysLeft = 0;
        message = 'ご利用が停止されています。事務所にご確認ください'; // 中立(未払い等は出さない)
      } else if (exp <= nowMs) {
        state = 'expired';
        daysLeft = 0;
        message = 'Wi-Fiのある所でダイコメを開いて更新してください';
      } else {
        daysLeft = Math.ceil((exp - nowMs) / DAY);
        if (daysLeft <= WARN_DAYS) {
          state = 'warning';
          message = 'あと' + daysLeft + '日でWi-Fiのある所でダイコメを開いてください';
        } else {
          state = 'active';
          message = '';
        }
      }
    }

    // ★業務中(客乗せ中)は絶対に止めない: state は正しく返すが allowed は true★
    const allowedByState = state === 'active' || state === 'warning';
    const allowed = running ? true : allowedByState;

    return { state: state, allowed: allowed, daysLeft: daysLeft, message: message };
  }

  const api = { evaluateLicense: evaluateLicense, WARN_DAYS: WARN_DAYS };

  if (typeof window !== 'undefined') window.LicenseV2 = api;
  /* eslint-disable no-undef */
  if (typeof module !== 'undefined' && typeof module.exports !== 'undefined') {
    module.exports = api;
  }
  /* eslint-enable no-undef */
})();
