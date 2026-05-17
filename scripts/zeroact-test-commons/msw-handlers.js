/* eslint-env node */
'use strict';

// ============================================================
// scripts/zeroact-test-commons/msw-handlers.js
// ZEROact 共通テスト基盤 P10 (2026-05-18 新規)
//
// 目的: MSW v2 で外部 API fetch を mock する handler 集 + setup factory。
//       ダイコメ / Exally / 今治AI 共通で使える handler を集約。
//
// 用途:
//   ・Node テスト (= vitest):  setupServer(...handlers).listen()
//   ・Browser テスト (= Playwright e2e): setupWorker(...handlers).start()
//
// 対象 fetch endpoint:
//   ・Firebase Remote Config (= viterbi_n_ios 等の A/B 値返却)
//   ・Anthropic Claude API   (= ai-review / bug-hunter test 用)
//   ・Gemini Flash API       (= ai-review / llm-as-judge test 用)
//   ・Sentry ingest endpoint (= sentry-config が送る event を吸収・noop response)
//
// 注意:
//   ・ダイコメは navigator.geolocation + Worker postMessage 中心で
//     直接 fetch は限定的・主に Firebase / LLM / Sentry のみ
//   ・MSW v2 は http.get/post を使う (= v1 の rest.* は廃止)
// ============================================================

const { http, HttpResponse } = require('msw');

// ─── Firebase Remote Config mock ──────────────────────────────

// /v1/projects/{project}/namespaces/firebase:fetch (= Firebase RC fetch endpoint)
// MSW v2 の path-to-regexp は ":" を parameter として解釈するため URL 内 ":fetch" で
// parse error。RegExp 直接指定で回避。
function firebaseRemoteConfigHandler(values) {
  return http.post(
    /^https:\/\/firebaseremoteconfig\.googleapis\.com\/v1\/projects\/[^/]+\/namespaces\/firebase:fetch/,
    () => {
      const entries = {};
      for (const k of Object.keys(values || {})) {
        entries[k] = String(values[k]);
      }
      return HttpResponse.json({
        entries,
        state: 'UPDATE',
      });
    }
  );
}

// ─── Anthropic Claude API mock ────────────────────────────────

function anthropicMessagesHandler(verdict, reasoning) {
  return http.post('https://api.anthropic.com/v1/messages', () => {
    const text = JSON.stringify({
      verdict: verdict || 'OK',
      reasoning: reasoning || 'mocked response',
    });
    return HttpResponse.json({
      id: 'msg_mock',
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text }],
      model: 'claude-haiku-mock',
      stop_reason: 'end_turn',
      usage: { input_tokens: 10, output_tokens: 20 },
    });
  });
}

// ─── Gemini Flash API mock ────────────────────────────────────

function geminiGenerateContentHandler(verdict, reasoning) {
  // ":generateContent" を parameter として解釈されないよう RegExp 直接指定
  return http.post(
    /^https:\/\/generativelanguage\.googleapis\.com\/v1beta\/models\/[^:]+:generateContent/,
    () => {
      const text = JSON.stringify({
        verdict: verdict || 'OK',
        reasoning: reasoning || 'mocked response',
      });
      return HttpResponse.json({
        candidates: [
          {
            content: { role: 'model', parts: [{ text }] },
            finishReason: 'STOP',
          },
        ],
      });
    }
  );
}

// ─── Sentry ingest mock (= event 送信を吸収) ──────────────────

function sentryIngestHandler() {
  // subdomain + path wildcard を RegExp で表現
  return http.post(/^https:\/\/[^.]+\.ingest\.[^/]+\.sentry\.io\/api\/[^/]+\/envelope\//, () => {
    return new HttpResponse(null, { status: 200 });
  });
}

// ─── factory ──────────────────────────────────────────────────

// 全 mock handler を returns (= 個別 override は呼出側で .use(...) して取捨)
function defaultHandlers(options) {
  options = options || {};
  return [
    firebaseRemoteConfigHandler(
      options.firebaseRC || {
        viterbi_n_ios: 10,
        fare_display_mode: 'classic',
        warmup_retry_count: 3,
      }
    ),
    anthropicMessagesHandler(options.anthropicVerdict, options.anthropicReasoning),
    geminiGenerateContentHandler(options.geminiVerdict, options.geminiReasoning),
    sentryIngestHandler(),
  ];
}

// Node テスト (vitest) 用 server factory
function makeServer(handlers) {
  // 動的 require (= msw/node は node 環境必須・browser 環境では落ちる)
  const { setupServer } = require('msw/node');
  return setupServer(...(handlers || defaultHandlers()));
}

// Browser テスト (Playwright addInitScript or service worker) 用 worker factory
// 注: ブラウザ環境専用・Node test では require('msw/browser') で落ちる
function makeWorker(handlers) {
  const { setupWorker } = require('msw/browser');
  return setupWorker(...(handlers || defaultHandlers()));
}

module.exports = {
  // handler factories
  firebaseRemoteConfigHandler,
  anthropicMessagesHandler,
  geminiGenerateContentHandler,
  sentryIngestHandler,
  // factories
  defaultHandlers,
  makeServer,
  makeWorker,
  // re-export MSW primitives for advanced use
  http,
  HttpResponse,
};
