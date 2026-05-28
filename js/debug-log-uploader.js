// ============================================================
// js/debug-log-uploader.js
// Eruda console log を Firebase RTDB に自動 upload するツール (= 2026-05-29)
//
// ★設計変更宣言 (= prod 同梱・feature flag OFF default):
//   feature flag (= URL ?debuglog=on で localStorage 有効化) で activate された端末でのみ
//   console.log / console.warn / console.error / dlog を override し・リングバッファに蓄積。
//   5 秒間隔 or 100 件溜まる毎に Firebase RTDB の debug_logs に REST 直叩きで upload。
//   司さんが Eruda Console で見るログを・Claude (= 解析側) も REST で並行参照可能にする。
//
//   prod の・距離機構 (= distance_m / calcFare / commit) / 課金経路 / Worker B /
//   map-matcher は・**1 byte も触らない**。本 file は独立・通常時は何もしない (= 早期 return)。
//
//   activation:
//     テストビルド (= !DEBUG.isProduction) では・既定 ON (= debug-trace.js と同方針)。
//     本番 (= daikou-app.vercel.app 等) では・既定 OFF。
//     ?debuglog=off で・テストビルドでも・明示 OFF 可能 (= localStorage に '0' 永続)。
//     ?debuglog=on は・本番でも・明示 ON 可能 (= localStorage '1' 永続)。
//
//   security:
//     Firebase RTDB の `debug_logs` スコープのみに書込・writeKey 必須・lines 5000 上限
//     Firebase rules (= debug_traces と同パターン) で・他 path 書込は完全に塞ぐ前提
//
//   multi-device 識別:
//     device_id: debug-trace.js と同じ localStorage キー (DAIKOME_DEVICE_ID) を共有
//     session_id: PWA load 毎に crypto.randomUUID() で生成・1 session = 1 record
//
//   絶対前提:
//     ・距離機構 / 課金経路 / Worker B / map-matcher / gps.js / gps-worker.js: 一切触らない
//     ・既存 console / Eruda 経路への干渉なし (= override は in-memory wrapper・元の関数を必ず呼ぶ)
//     ・flag OFF (= default) では・本 file は load されても何もせず終了
//     ・他 user / 通常 install では・サイレント (= UI 一切表示しない)
// ============================================================
/* eslint-disable no-console -- 本 file は debug 用・console.error は最終手段の log のみ */

(function () {
  'use strict';

  // ─── 定数 ────────────────────────────────────────────────
  const FLAG_KEY = 'DAIKOME_DEBUGLOG_ENABLED';
  const DEVICE_ID_KEY = 'DAIKOME_DEVICE_ID'; // debug-trace.js と共有
  const DEVICE_LABEL_KEY = 'DAIKOME_DEVICE_LABEL'; // debug-trace.js と共有
  const WRITE_KEY = 'DAIKOME_DEBUG_2026'; // Firebase rules validation 共有 key
  const DB_URL = 'https://daikou-app-c821a-default-rtdb.asia-southeast1.firebasedatabase.app';
  const FLUSH_INTERVAL_MS = 5000; // 5 秒間隔 flush
  const FLUSH_THRESHOLD = 100; // 100 件溜まったら flush
  const MAX_BUFFER = 5000; // overflow guard

  // ─── Feature flag handling (= ?debuglog=on/off で切替) ────
  try {
    const params = new URLSearchParams(location.search);
    const t = params.get('debuglog');
    if (t === 'on') {
      localStorage.setItem(FLAG_KEY, '1');
    } else if (t === 'off') {
      localStorage.setItem(FLAG_KEY, '0');
    }
  } catch (_) {
    /* ignore */
  }

  // ─── enabled 判定 ───
  let _enabled = false;
  try {
    const stored = localStorage.getItem(FLAG_KEY);
    if (stored === '1') {
      _enabled = true;
    } else if (stored === '0') {
      _enabled = false;
    } else {
      const _isProd = typeof DEBUG !== 'undefined' && DEBUG && DEBUG.isProduction === true;
      _enabled = !_isProd;
    }
  } catch (_) {
    _enabled = false;
  }
  if (!_enabled) return;

  // ─── device_id / session_id 取得 ───
  let deviceId;
  try {
    deviceId = localStorage.getItem(DEVICE_ID_KEY);
    if (!deviceId) {
      deviceId =
        typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
          ? crypto.randomUUID()
          : 'fallback-' + Date.now() + '-' + Math.random().toString(36).slice(2, 10);
      localStorage.setItem(DEVICE_ID_KEY, deviceId);
    }
  } catch (_) {
    deviceId = 'no-storage';
  }
  const sessionId =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : 'sess-' + Date.now() + '-' + Math.random().toString(36).slice(2, 10);
  const startedAt = Date.now();

  // ─── リングバッファ ───
  const buffer = [];
  let droppedCount = 0;
  let uploadInflight = false;

  function _push(level, args) {
    if (buffer.length >= MAX_BUFFER) {
      droppedCount++;
      return;
    }
    let text = '';
    try {
      text = Array.from(args)
        .map(function (a) {
          if (a == null) return String(a);
          if (typeof a === 'string') return a;
          if (typeof a === 'number' || typeof a === 'boolean') return String(a);
          try {
            return JSON.stringify(a);
          } catch (_) {
            return '[unserializable]';
          }
        })
        .join(' ');
    } catch (_) {
      text = '[stringify-failed]';
    }
    buffer.push({ t: Date.now() - startedAt, lvl: level, m: text });
    if (buffer.length >= FLUSH_THRESHOLD) {
      _maybeFlush('threshold');
    }
  }

  // ─── console / dlog の override (= 元関数は必ず呼ぶ・透過) ─
  const _origConsole = {
    log: console.log.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
    info: console.info ? console.info.bind(console) : console.log.bind(console),
  };
  console.log = function () {
    _push('log', arguments);
    _origConsole.log.apply(null, arguments);
  };
  console.warn = function () {
    _push('warn', arguments);
    _origConsole.warn.apply(null, arguments);
  };
  console.error = function () {
    _push('error', arguments);
    _origConsole.error.apply(null, arguments);
  };
  console.info = function () {
    _push('info', arguments);
    _origConsole.info.apply(null, arguments);
  };
  // dlog (= debug-config.js が提供する global) も hook
  if (typeof window !== 'undefined' && typeof window.dlog === 'function') {
    const _origDlog = window.dlog;
    window.dlog = function () {
      _push('dlog', arguments);
      _origDlog.apply(null, arguments);
    };
  }

  // ─── flush (= Firebase RTDB に PATCH で session record 更新) ───
  function _maybeFlush(triggerSource) {
    if (uploadInflight) return;
    if (buffer.length === 0) return;
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
    uploadInflight = true;
    // バッファ全件取り出し (= 送信中の追記は次 flush へ)
    const lines = buffer.splice(0, buffer.length);
    let label = '';
    try {
      label = localStorage.getItem(DEVICE_LABEL_KEY) || '';
    } catch (_) {
      /* ignore */
    }
    const meta = {
      device_id: deviceId,
      device_label: label,
      session_id: sessionId,
      started_at: startedAt,
      userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : '',
      last_flush_at: Date.now(),
      flush_trigger: triggerSource,
      dropped_count: droppedCount,
    };
    // PATCH で・既存 record の lines に追記 + meta を最新化
    // RTDB は PATCH で部分更新可・session_id 単位の record 構造
    const path = '/debug_logs/' + deviceId + '/' + sessionId;
    // append: 各 line を push key で追加 (= concurrent flush でも順序保持)
    const updates = { meta: meta, writeKey: WRITE_KEY };
    for (let i = 0; i < lines.length; i++) {
      const key = 'lines/' + (startedAt + lines[i].t) + '-' + i;
      updates[key] = lines[i];
    }
    fetch(DB_URL + path + '.json', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updates),
    })
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        uploadInflight = false;
      })
      .catch(function () {
        // 失敗時はバッファに戻す (= 先頭挿入で順序保持)
        for (let i = lines.length - 1; i >= 0; i--) {
          if (buffer.length < MAX_BUFFER) buffer.unshift(lines[i]);
        }
        uploadInflight = false;
      });
  }

  // ─── 5 秒間隔 flush + visibilitychange + beforeunload ───
  setInterval(function () {
    _maybeFlush('periodic');
  }, FLUSH_INTERVAL_MS);

  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) _maybeFlush('hidden');
    });
  }
  if (typeof window !== 'undefined') {
    window.addEventListener('beforeunload', function () {
      // beforeunload では fetch が間に合わない可能性 → sendBeacon で best-effort
      if (buffer.length === 0) return;
      try {
        const lines = buffer.splice(0, buffer.length);
        const updates = { writeKey: WRITE_KEY };
        for (let i = 0; i < lines.length; i++) {
          const key = 'lines/' + (startedAt + lines[i].t) + '-' + i;
          updates[key] = lines[i];
        }
        const path = '/debug_logs/' + deviceId + '/' + sessionId + '.json';
        const blob = new Blob([JSON.stringify(updates)], { type: 'application/json' });
        if (navigator.sendBeacon) {
          navigator.sendBeacon(DB_URL + path, blob);
        }
      } catch (_) {
        /* best-effort */
      }
    });
  }

  // ─── window 公開 (= 手動 flush / 状態確認用) ───
  if (typeof window !== 'undefined') {
    window.debugLogUploader = {
      flushNow: function () {
        _maybeFlush('manual');
      },
      getStatus: function () {
        return {
          enabled: _enabled,
          buffered: buffer.length,
          dropped: droppedCount,
          session_id: sessionId,
          device_id: deviceId,
          started_at: startedAt,
        };
      },
    };
  }

  // 初期化完了ログ (= override 後の console.log なので自身もバッファに入る)
  console.log(
    '[debug-log-uploader] init OK session=' +
      sessionId.slice(0, 8) +
      ' device=' +
      deviceId.slice(0, 8)
  );
})();
