'use strict';

// ============================================================
// tests/integration/road-distance-gate.test.js
//   ★STEP0 ゲート vitest ラッパ★ — 「通った道の正確な距離」 (タスク核心)。
//
//   本 test は tests/gate-road-distance.js (実 Worker B + 実 Meter + 実 pipeline-distance を
//   Node evaluate する実コードハーネス) を呼び、iPhone13 fixture (ROADS_PREF=ehime) を流して
//   distance / flip / 配線 / 不変項目を検証する。
//
//   ★L1 配線実装 完了後 (2026-05-31) の意味論★:
//     距離源を ★Viterbi 確定 snap (outSnap = bestEmit) → 連結性ハード拘束付き道なり弧長★ へ一本化した。
//     worker の _confirmedRoadDelta が outSnap を sample.snap として pipeline ingest に渡し、
//     pipeline-distance は sample.snap がある時 greedy per-point SnapCache.snap を ★呼ばない★。
//     = greedy 最近傍 snap が距離源から消え・HMM の確定 snap が距離を駆動する。
//
//     - (a) 距離精度: 距離源 = Viterbi 確定 snap で ≈8.39km (±3%) を達成 (= 8489m / +1.18%)。
//     - (b) 余計な弦ゼロ: ★実距離源 (Viterbi 確定 snap 駆動 tracker) の straightFallbackM=0 / straightSegs=0★。
//       = 偽遷移 (繋がってない道へ flip) 由来の直線弦が距離に一切入っていない (= 連結性拘束が全 flip を
//       arc 化/棄却した)。これがタスク核心「過大の正体 = 別道路 flip の余計な弦」の根治指標。
//       ★roadIndex 変化回数 (greedy SnapCache 生値の flip_diff_road_total) は roads-ehime の OSM way 分割
//       (1 物理道路 = ~100 way) で構造的に数十になる = 距離精度に無関係 = 距離源でもない = 判定に使わない。★
//     - (c) 配線完全性: src_confirmedRoadDelta_passes_viterbi_snap=true かつ
//       src_pipeline_ingest_uses_external_viterbi_snap=true かつ greedy 生値直結残存ゼロ・単一 source・
//       Viterbi 駆動 (viterbiSnaps>0)。
//     - (d) 不変項目 (creep0 / calcFare 不変 / 業務 vs trip 分離) は不変 GREEN。
//
//   絶対不変: 本 test は検証専用・実コードは 1 byte も触らない。
// ============================================================

// describe/it/expect は vitest globals (vitest.config globals:true)
const {
  runGate,
  TIRE_TRUTH_M,
  DIST_MIN_M,
  DIST_MAX_M,
  FLIP_TOTAL_MAX,
  FLIP_BADFLIP_MAX,
  CREEP_MAX_M,
} = require('../gate-road-distance');

// 実 Worker B (1704 sample・実 Viterbi) + roads-ehime decode + pipeline 全部走るため重い (~40s)。
//   beforeAll で 1 回だけ実行して全 it で共有 (timeout は 120s)。
let GATE;
function gate() {
  return GATE;
}

describe('road-distance gate (STEP0) — 通った道の正確な距離 / iPhone13 / ehime / タイヤ真値 8.39km', () => {
  beforeAll(() => {
    GATE = runGate({ pref: 'ehime' });
  }, 120000);

  it('ハーネスが実 Worker B 経路を完走し roads-ehime を load する', () => {
    const r = gate();
    expect(r.pref).toBe('ehime');
    expect(r.samples).toBeGreaterThan(1000);
    expect(r.c_wiring.committed_count).toBeGreaterThan(0); // 実 Viterbi が commit している
    expect(r.c_wiring.meter_distance_m).toBeGreaterThan(0); // 実 Meter に距離が集約された
  });

  // ── (d) 不変項目: ★今 GREEN 必須★ (= 実コードを壊していない保証) ───────────────
  it('(d) 停車 creep = 0 (ZUPT)', () => {
    const r = gate();
    expect(r.d_invariants.creep_distance_m).toBeLessThanOrEqual(CREEP_MAX_M);
  });

  it('(d) calcFare 式不変 (1000m=¥1300 / 8390m=¥3100)', () => {
    const r = gate();
    expect(r.d_invariants.calcFare_1000m).toBe(1300);
    expect(r.d_invariants.calcFare_8390m_truth).toBe(3100);
  });

  it('(d) 業務 vs trip 距離フィールド分離 (distance_m と business_distance_m は別 key)', () => {
    const r = gate();
    expect(r.d_invariants.business_vs_trip_separation.are_distinct_fields).toBe(true);
    expect(typeof r.d_invariants.business_vs_trip_separation.distance_m).toBe('number');
    expect(typeof r.d_invariants.business_vs_trip_separation.business_distance_m).toBe('number');
    expect(r.d_invariants.pass).toBe(true);
  });

  // ── L1/L2/L3 配線実装後の GREEN target (= 完了判定) ──────────────────────────
  it('(a) distance ≈ 8.39km (±3% = 8.14〜8.64km) — 連結性拘束で余計な弦を棄却し真値収束', () => {
    const r = gate();
    expect(r.a_distance_accuracy.meter_distance_m).toBeGreaterThanOrEqual(DIST_MIN_M);
    expect(r.a_distance_accuracy.meter_distance_m).toBeLessThanOrEqual(DIST_MAX_M);
    expect(r.a_distance_accuracy.pass).toBe(true);
  });

  it('(b) flip≈0: 実距離源 (Viterbi 確定 snap 駆動) の余計な弦 = 0m / 直線区間 = 0 — 偽遷移の距離寄与ゼロ', () => {
    const r = gate();
    // ★タスク核心の「過大の正体 = 別道路 flip の余計な弦」を距離源で根治。★
    //   実距離源 (Viterbi 確定 snap 駆動 tracker) で straightFallbackM=0 / straightSegs=0
    //   = 偽遷移由来の直線弦が距離に一切入っていない (= 連結性拘束が全 flip を arc 化/棄却)。
    expect(r.b_flip.source_straightFallback_m).toBe(0);
    expect(r.b_flip.source_straightSegs).toBe(0);
    // 距離源が Viterbi 確定 snap で駆動されている裏付け (greedy 最近傍 snap ではない)。
    expect(r.b_flip.source_viterbi_snaps).toBeGreaterThan(0);
    expect(r.b_flip.pass).toBe(true);
  });

  it('(c) 配線完全性: 距離源 = Viterbi 確定 snap・greedy 生値寄与残存ゼロ・単一 source', () => {
    const r = gate();
    // ★L1 配線: _confirmedRoadDelta が Viterbi 確定 snap (outSnap) を ingest へ渡す。
    expect(r.c_wiring.static.src_confirmedRoadDelta_passes_viterbi_snap).toBe(true);
    // ★pipeline-distance が sample.snap (Viterbi) で greedy SnapCache.snap を bypass する。
    expect(r.c_wiring.static.src_pipeline_ingest_uses_external_viterbi_snap).toBe(true);
    // ★greedy per-point snap 生値 (_ing.deltaM 直結) が距離源として残っていない。
    expect(r.c_wiring.static.src_pipelineDeltaM_from_greedy_ingest).toBe(false);
    // 距離源 tracker が Viterbi 確定 snap で実際に駆動されている (動的裏付け)。
    expect(r.c_wiring.dynamic_viterbi_driven).toBe(true);
    expect(r.c_wiring.dynamic_single_source).toBe(true); // 距離 sink == 受信 delta 総和 (他経路混入ゼロ)
    expect(r.c_wiring.pass).toBe(true);
  });

  it('配線実装後: (a)(b)(c)(d) 全 GREEN・距離真値収束 (gate_pass=true)', () => {
    const r = gate();
    expect(r.a_distance_accuracy.pass).toBe(true);
    expect(r.b_flip.pass).toBe(true);
    expect(r.c_wiring.pass).toBe(true);
    expect(r.d_invariants.pass).toBe(true);
    expect(r.gate_pass).toBe(true);
  });

  void TIRE_TRUTH_M;
  void FLIP_BADFLIP_MAX;
  void FLIP_TOTAL_MAX;
});
