// ============================================================
// meter.js  (ダイコメ メーター本体・白紙書き直し・clean-rebuild-pipeline)
//
// ★アーキテクチャ (2026-05-30 白紙書き直し)★
//   距離 distance_m = 「道路 snap 道なり累積」を ★単一エンジン★ で駆動する。
//     エンジン = js/pipeline-distance.js (createDistanceTracker・実走 9,677m 検証済)。
//     エンジンは Worker B (map-matcher.js) 内で動き、GPS 1 点ごとに ingest して
//     その区間の道なり増分を mmResult.pipelineDeltaM として main に返す。
//     meter は running gate 内で state.distance_m += pipelineDeltaM するだけ (= 単一経路)。
//
//   旧 meter.js の・distance_m 5 経路集計 (mm commit / retro Off-Road / gap fill /
//   Off-Road incremental / setDistance) や・13 orphan helper・Viterbi mmIncrementM 集計・
//   tier2 preview 二重回路・α-β filter は ★この新ファイルには存在しない★。
//
// ★絶対不可侵 (白紙でも完全保持)★
//   1. calcFare 料金式 (1000m¥1300 / 以降 420m¥100・多段 tiers/vehicle/surcharge/auto/
//      wait/clamp/round) = 旧 meter.js から 1 byte もじらず移植。
//   2. 公開メソッド signature = 全て維持 (return オブジェクト末尾参照・公開 28 メソッド
//      + テスト用 escape hatch 2 = 計 30 プロパティ。旧 meter.js と export 名・順序一致)。
//   3. getState が返す既存 state field キー (distance_m / fare_yen / business_distance_m /
//      display_distance_m / business_display_distance_m / tier2_pending_m /
//      business_tier2_pending_m / running / business_active / elapsed_sec / last_gps /
//      wait_sec / distanceSource / mm_* / offroad_* / gap_fill_* / pipeline_distance_m 等)
//      = 既存キーは消さない (index.html / business.js が読む)。距離 5 経路廃止に伴い
//      参照値となった field (mm_*/offroad_*/gap_fill_*) は 0 のまま温存 (= 後方互換キー)。
//   4. 非距離ロジック (住所 getNearestAddress / surcharge / vehicle / fareConfig /
//      elapsed 時間 / wait / business 状態) = 旧から clean に移植 (機能保持)。
//   5. Worker B プロトコル (post: gps/reset/loadRoads/configPlatform/softReset,
//      受信: mmResult/roadsLoaded) = 名前と形維持。
//      ※旧 'resetCommittedSnap' message は白紙書き直しで廃止 (meter は post せず・
//        map-matcher.js も handler 削除済・2026-05-30)。距離の gap/off-road 境界は
//        pipeline-distance エンジンが内部処理するため不要。
//   6. 距離 = 道路 snap 道なり累積の意味論・GPS 直線課金禁止・完全オフライン・
//      iOS/Android 両対応。
//
//   distance_m 加算は「running gate 内の state.distance_m += pipelineDeltaM」の ★1 経路のみ★
//   + 復元用 setDistance の代入。GPS.calcDistance による直線課金は meter.js には存在しない
//   (= haversine は pipeline-distance.js / Worker B 内に集約)。
// ============================================================

// eslint-disable-next-line no-unused-vars -- 他ファイルから Meter をグローバル参照 (cross-file global pattern)
const Meter = (() => {
  // ─── state 初期化 ──────────────────────────────────────────
  //   ★既存キーは消さない (index.html / business.js が読む)。
  let state = {
    running: false, // 代行中 (= 課金 gate)
    distance_m: 0, // 課金距離 (= 道路 snap 道なり累積・pipeline delta 駆動・不可侵)
    distanceSource: 'pipeline', // 直近で distance_m を更新したソース ('pipeline' | 'inline')
    fare_yen: 0, // 課金料金
    elapsed_sec: 0, // 経過時間 (getState で都度計算)
    elapsed_accumulated_sec: 0, // 累積走行時間 (= stop / businessEnd で確定加算・内部)
    last_resume_time: null, // 直近 start / resume の時刻 (= 都度計算の基準・内部)
    business_active: false, // 業務中フラグ (= Business.start/end で外部設定)
    business_distance_m: 0, // 業務単位累積距離 (= 業務 active gate・trip 跨ぎ保持)
    start_time: null, // 代行開始時刻
    last_gps: null, // {lat,lng,accuracy,altitude,compassHeading} | null
    last_timestamp: null, // 最後の GPS 時刻
    last_speed_kmh: 0, // 直近 GPS 速度
    last_isStationary: false, // gps.js isStationary 判定
    // ─── 表示用 (予測補間・実距離値 1 byte 不変の表示専用 layer) ───
    display_distance_m: 0, // 課金 display (= distance_m を 10m 滑らかに先取り表示)
    last_display_update_time: null,
    _prev_target_distance_m: 0,
    _prev_target_time: null,
    _target_velocity_mps: 0,
    business_display_distance_m: 0, // 業務 display (= business_distance_m を滑らか追従)
    last_business_display_update_time: null,
    _prev_business_target_distance_m: 0,
    _prev_business_target_time: null,
    _business_target_velocity_mps: 0,
    // ─── 待機料金 ───
    wait_sec: 0, // 累積待機時間 (秒・速度 < 3km/h で加算)
    // ─── 後方互換キー (旧 5 経路廃止で参照値化・0 のまま温存・index.html が読む) ───
    tier2_pending_m: 0, // 旧 tier2 preview (= 廃止・常に 0)
    business_tier2_pending_m: 0, // 旧 business preview (= 廃止・常に 0)
    gps_predictive_distance_m: 0, // 旧 GPS predictive (= 廃止・常に 0)
    mm_distance_m: 0, // Map Matching 参照距離 (= pipeline と同値を mirror)
    mm_snap_count: 0, // snap 成功回数 (Worker B stats)
    mm_total_count: 0, // update 呼出回数
    mm_skip_count: 0, // snap skip 回数
    offroad_distance_m: 0, // 旧 Off-Road 加算 (= 廃止・常に 0)
    offroad_count: 0, // 旧 Off-Road 起動回数 (= 廃止・常に 0)
    gap_fill_count: 0, // 旧 gap fill 回数 (= 廃止・常に 0)
    gap_fill_total_m: 0, // 旧 gap fill 距離 (= 廃止・常に 0)
    // ─── 新距離エンジン参照値 (= Worker B pipeline 累積・比較表示用) ───
    pipeline_distance_m: 0,
  };

  // ─── 表示予測補間の定数 (10m 滑らか・距離値 1 byte 不変の表示専用) ───
  //   target_velocity_mps = 直近 1 秒の target 増分 / dt (= 自己整合・GPS speed 依存なし)
  //   予測 = velocity × min(1.0, 経過秒) で・GPS 待ち間も display を滑らかに先取り。
  //   屋内駐車 / 停車 (= target 0 進捗) → velocity 0 → 予測 0 (= creep しない)。
  const DISP_V_CLAMP_MPS = 36; // 予測 velocity 上限 (= 約 130km/h)
  const DISP_PREDICT_MAX_M = 10; // 1 step あたり予測先取りの上限 (= 10m 滑らか)

  // ─── fareConfig (v2・後方互換維持) ───
  let fareConfig = {
    version: 2,
    base_fare: 1300,
    base_distance_m: 1000,
    add_fare: 100,
    add_distance_m: 420,
    tiers: [],
    surcharges: [],
    minFare: null,
    maxFare: null,
    rounding: 10,
    autoSurcharges: {
      night: { enabled: false, from: 22, to: 5, rate: 1.2 },
      weekend: { enabled: false, rate: 1.1 },
      winter: { enabled: false, from: '12-15', to: '03-15', rate: 1.1 },
    },
    vehicles: [],
    vehiclesEnabled: false,
    wait: { enabled: false, freeMins: 5, ratePerMin: 100 },
  };

  // 業務画面で ON/OFF された手動 surcharge の id Set
  let _activeSurchargeIds = new Set();
  // 業務開始時に選択された車種 id (vehiclesEnabled=true のみ有効)
  let _activeVehicleId = null;
  // F6: 業務中の fareConfig 変更を抑制 (= 走行中の急変防止)
  let _fareConfigFrozen = false;

  // ─── Map Matching (Worker B) 連携 ───
  const MM_ENABLED = true;
  let mmWorker = null;
  let _workerLoadedPrefs = new Set(); // roadsLoaded ack を track して MM ready 判定に使う

  // ★代行開始直後の Worker B バッファ残骸 drain (= driveDist が 0.17km 等で開始する事象防止)。
  //   Meter.start() は worker に 'reset' を ASYNC で送るが、直前 commit が queue に残り
  //   start 完了直後の tick で届く race を回避する。drain window 中の pipelineDeltaM は
  //   distance_m / business_distance_m いずれにも加算しない。
  let _drainMmUntil = 0;
  const MM_DRAIN_AFTER_START_MS = 500;
  // 旧 Off-Road grace period の escape hatch 用 (= テスト互換・新距離では未使用だが API 維持)。
  let _offRoadGraceUntil = 0;
  const OFFROAD_GRACE_AFTER_START_MS = 5000;

  // Worker B 健全性 (= 直近 useful な mmResult を受けた時刻・getMMStats 用)
  let lastMmUsefulAt = 0;

  // MM 評価インフラ: latency 循環バッファ + 候補数累積 (getMMStats 用)
  const _MM_LATENCY_BUFFER_SIZE = 1000;
  const _mmLatencyBuf = new Float32Array(_MM_LATENCY_BUFFER_SIZE);
  let _mmLatencyIdx = 0;
  let _mmLatencyCount = 0;
  let _mmCandCountSum = 0;
  let _mmCandCountSamples = 0;
  let _lastMcmN = 0;
  let _lastSnapTypeCode = null;

  function _recordMmLatency(ms) {
    if (typeof ms !== 'number' || !isFinite(ms) || ms < 0) return;
    _mmLatencyBuf[_mmLatencyIdx] = ms;
    _mmLatencyIdx = (_mmLatencyIdx + 1) % _MM_LATENCY_BUFFER_SIZE;
    if (_mmLatencyCount < _MM_LATENCY_BUFFER_SIZE) _mmLatencyCount++;
  }
  function _calcP99Latency() {
    if (_mmLatencyCount === 0) return 0;
    const arr = new Array(_mmLatencyCount);
    for (let i = 0; i < _mmLatencyCount; i++) arr[i] = _mmLatencyBuf[i];
    arr.sort(function (a, b) {
      return a - b;
    });
    const idx = Math.floor(_mmLatencyCount * 0.99);
    return arr[Math.min(idx, _mmLatencyCount - 1)];
  }

  // 起動時 warm up: 代行開始前から GPS を保持 (= 「代行開始」押下で即計測開始)。
  let lastWarmupGps = null;

  // ─── fareConfig 公開 API ───
  function setFareConfig(config) {
    if (_fareConfigFrozen) {
      if (typeof dlog === 'function')
        dlog('[Meter] setFareConfig ignored (frozen during business)');
      return;
    }
    fareConfig = { ...fareConfig, ...config };
  }
  function getFareConfig() {
    return { ...fareConfig };
  }

  // ─── Worker B 連携 ───
  function setMapMatcher(worker) {
    if (mmWorker) {
      try {
        mmWorker.removeEventListener('message', _onMmWorkerMessage);
      } catch (e) {
        /* noop - intentionally empty */
      }
    }
    mmWorker = worker || null;
    _workerLoadedPrefs = new Set(); // 新 Worker 起動で再カウント
    if (mmWorker) {
      mmWorker.addEventListener('message', _onMmWorkerMessage);
    }
  }
  function isMmReady() {
    return mmWorker && _workerLoadedPrefs.size > 0;
  }

  // ─── Worker B からの mmResult ハンドラ (= 距離駆動の単一受信点) ───
  //   新アーキ: state.distance_m += m.pipelineDeltaM (= 道路 snap 道なり区間増分) を
  //   running gate 内で実行する。business_distance_m は business_active gate で加算。
  //   旧 Viterbi mmIncrementM / tentative / Off-Road / gap は ★参照しない★。
  function _onMmWorkerMessage(e) {
    const m = e && e.data;
    if (!m) return;
    if (m.type === 'roadsLoaded') {
      if (m.ok && m.pref) _workerLoadedPrefs.add(m.pref);
      return;
    }
    if (m.type !== 'mmResult') return;

    // 新距離エンジン参照値 (= 並列累積・比較表示用・課金には使わない)
    if (typeof m.pipelineTotalM === 'number' && m.pipelineTotalM >= 0) {
      state.pipeline_distance_m = m.pipelineTotalM;
    }

    // ★距離駆動: pipeline delta を距離に加算する単一経路★
    const delta =
      typeof m.pipelineDeltaM === 'number' && m.pipelineDeltaM > 0 ? m.pipelineDeltaM : 0;
    if (delta > 0 && Date.now() >= _drainMmUntil) {
      lastMmUsefulAt = Date.now();
      // 参照値 mirror (= 後方互換 stats・mm_distance_m は pipeline と同じ道なり距離)
      state.mm_distance_m += delta;
      // 課金距離 (running gate・絶対不可侵経路)
      if (state.running) {
        state.distance_m += delta;
        state.fare_yen = calcFare(state.distance_m);
        state.distanceSource = 'pipeline';
      }
      // 業務単位累積 (business_active gate・空車中も加算・後付メーター対等)
      if (state.business_active) {
        state.business_distance_m = (state.business_distance_m || 0) + delta;
      }
    } else if (delta > 0 && Date.now() < _drainMmUntil) {
      // drain window 中の残骸は破棄 (= 代行開始直後 0.17km 等を防ぐ)。stats のみ更新。
      lastMmUsefulAt = Date.now();
      state.mm_distance_m += delta;
      if (typeof dlog === 'function') {
        dlog('[Meter] drain pipelineDelta ' + delta.toFixed(1) + 'm (代行開始直後の残骸)');
      }
    }

    // snap stats / road type 伝達 (= getMMStats / GPS Kalman Q 動的化用・距離には無関係)
    if (m.snap && m.snap.typeCode != null) {
      const newTypeCode = m.snap.typeCode;
      if (newTypeCode !== _lastSnapTypeCode) {
        _lastSnapTypeCode = newTypeCode;
        if (typeof GPS !== 'undefined' && typeof GPS.setRoadType === 'function') {
          try {
            GPS.setRoadType(newTypeCode);
          } catch (_) {
            /* noop - intentionally empty */
          }
        }
      }
    }
    // commit が起きた road を Firebase cross-user pheromone に集約
    if (m.committed && m.snap && m.snap.prefecture && m.snap.roadIndex != null) {
      if (typeof FB !== 'undefined' && typeof FB.markVisited === 'function') {
        try {
          FB.markVisited(m.snap.prefecture, m.snap.roadIndex);
        } catch (_) {
          /* noop - intentionally empty */
        }
      }
    }
    if (m.snapped) state.mm_snap_count++;
    if (m.skipped) {
      state.mm_skip_count++;
      if (typeof dlog === 'function' && m._reason) dlog('[MM] skip: ' + m._reason);
    }
    if (typeof m.latencyMs === 'number') _recordMmLatency(m.latencyMs);
    if (typeof m.candidatesCount === 'number') {
      _mmCandCountSum += m.candidatesCount;
      _mmCandCountSamples++;
    }
    if (typeof m.mcmN === 'number') _lastMcmN = m.mcmN;
  }

  // ─── 代行開始 ───
  function start() {
    const now = Date.now();
    const WARMUP_MAX_AGE_MS = 5000;
    const warmupValid =
      lastWarmupGps && lastWarmupGps.timestamp && now - lastWarmupGps.timestamp < WARMUP_MAX_AGE_MS;
    // business_* は trip 跨ぎで保持 (= 業務単位累積・businessEnd でのみ 0 化)。
    const prevBusinessDist = (state && state.business_distance_m) || 0;
    const prevBusinessActive = !!(state && state.business_active);
    const prevBusinessDisplay = (state && state.business_display_distance_m) || prevBusinessDist;
    state = {
      running: true,
      distance_m: 0,
      distanceSource: 'pipeline',
      fare_yen: fareConfig.base_fare,
      elapsed_sec: 0,
      elapsed_accumulated_sec: 0,
      last_resume_time: now,
      business_active: prevBusinessActive,
      business_distance_m: prevBusinessDist,
      start_time: now,
      last_gps: warmupValid
        ? {
            lat: lastWarmupGps.lat,
            lng: lastWarmupGps.lng,
            accuracy: lastWarmupGps.accuracy,
            altitude: lastWarmupGps.altitude,
            compassHeading: lastWarmupGps.compassHeading,
          }
        : null,
      last_timestamp: warmupValid ? now : null,
      last_speed_kmh: warmupValid ? lastWarmupGps.speedKmh : 0,
      last_isStationary: false,
      // 表示用 (trip 単位 0 化)
      display_distance_m: 0,
      last_display_update_time: null,
      _prev_target_distance_m: 0,
      _prev_target_time: null,
      _target_velocity_mps: 0,
      // business display (per-trip 引き継ぎ)
      business_display_distance_m: prevBusinessDisplay,
      last_business_display_update_time: null,
      _prev_business_target_distance_m: prevBusinessDisplay,
      _prev_business_target_time: null,
      _business_target_velocity_mps: 0,
      wait_sec: 0,
      // 後方互換キー (= 廃止・0 維持)
      tier2_pending_m: 0,
      business_tier2_pending_m: (state && state.business_tier2_pending_m) || 0,
      gps_predictive_distance_m: 0,
      mm_distance_m: 0,
      mm_snap_count: 0,
      mm_total_count: 0,
      mm_skip_count: 0,
      offroad_distance_m: 0,
      offroad_count: 0,
      gap_fill_count: 0,
      gap_fill_total_m: 0,
      pipeline_distance_m: (state && state.pipeline_distance_m) || 0,
    };
    // fareConfig v2: 業務開始時 default ON の surcharge を初期 active に
    _activeSurchargeIds = new Set();
    if (Array.isArray(fareConfig.surcharges)) {
      for (const s of fareConfig.surcharges) {
        if (s && s.active_default && s.id) _activeSurchargeIds.add(s.id);
      }
    }
    // vehicle 初期選択 (default フラグ・なければ最初の vehicle)
    if (
      fareConfig.vehiclesEnabled &&
      Array.isArray(fareConfig.vehicles) &&
      fareConfig.vehicles.length > 0
    ) {
      const def = fareConfig.vehicles.find((v) => v && v.default);
      _activeVehicleId = (def && def.id) || fareConfig.vehicles[0].id || null;
    } else {
      _activeVehicleId = null;
    }
    _fareConfigFrozen = true; // F6: 業務開始で凍結
    lastMmUsefulAt = Date.now();
    _drainMmUntil = Date.now() + MM_DRAIN_AFTER_START_MS;
    _offRoadGraceUntil = Date.now() + OFFROAD_GRACE_AFTER_START_MS;
    // Worker B 連続性リセット (= prevSnap / Viterbi 窓初期化・pipeline tracker reset)
    if (mmWorker) {
      try {
        mmWorker.postMessage({ type: 'reset' });
      } catch (e) {
        /* noop - intentionally empty */
      }
    }
  }

  // ─── 代行一時停止 ───
  function stop() {
    state.running = false;
    if (state.last_resume_time !== null) {
      state.elapsed_accumulated_sec += Date.now() - state.last_resume_time;
      state.last_resume_time = null;
    }
  }

  // ─── 業務終了 ───
  function businessEnd() {
    state.running = false;
    if (state.last_resume_time !== null) {
      state.elapsed_accumulated_sec += Date.now() - state.last_resume_time;
      state.last_resume_time = null;
    }
    state.business_active = false;
    _fareConfigFrozen = false;
    if (mmWorker) {
      try {
        mmWorker.postMessage({ type: 'reset' });
      } catch (e) {
        /* noop - intentionally empty */
      }
    }
    if (typeof FB !== 'undefined' && typeof FB.pushSessionAggregates === 'function') {
      try {
        FB.pushSessionAggregates();
      } catch (_) {
        /* noop - intentionally empty */
      }
    }
  }

  // ─── 代行中断 (空車・trip 単位 reset) ───
  function reset() {
    stop();
    const prevBusinessDist = (state && state.business_distance_m) || 0;
    const prevBusinessActive = !!(state && state.business_active);
    const prevBusinessDisplay = (state && state.business_display_distance_m) || prevBusinessDist;
    state = {
      running: false,
      distance_m: 0,
      distanceSource: 'pipeline',
      fare_yen: 0,
      elapsed_sec: 0,
      elapsed_accumulated_sec: 0,
      last_resume_time: null,
      business_active: prevBusinessActive,
      business_distance_m: prevBusinessDist,
      start_time: null,
      last_gps: null,
      last_timestamp: null,
      last_speed_kmh: 0,
      last_isStationary: false,
      display_distance_m: 0,
      last_display_update_time: null,
      _prev_target_distance_m: 0,
      _prev_target_time: null,
      _target_velocity_mps: 0,
      business_display_distance_m: prevBusinessDisplay,
      last_business_display_update_time: null,
      _prev_business_target_distance_m: prevBusinessDisplay,
      _prev_business_target_time: null,
      _business_target_velocity_mps: 0,
      wait_sec: 0,
      tier2_pending_m: 0,
      business_tier2_pending_m: (state && state.business_tier2_pending_m) || 0,
      gps_predictive_distance_m: 0,
      mm_distance_m: 0,
      mm_snap_count: 0,
      mm_total_count: 0,
      mm_skip_count: 0,
      offroad_distance_m: 0,
      offroad_count: 0,
      gap_fill_count: 0,
      gap_fill_total_m: 0,
      pipeline_distance_m: (state && state.pipeline_distance_m) || 0,
    };
    lastMmUsefulAt = 0;
    // trip reset では softReset (= lastCommittedSnap / prevSnap のみクリア・窓は維持)。
    if (mmWorker) {
      try {
        mmWorker.postMessage({ type: 'softReset' });
      } catch (e) {
        /* noop - intentionally empty */
      }
    }
    // warmup GPS もクリア (= 次回代行開始時の距離爆発防止)。
    lastWarmupGps = null;
  }

  // ─── 代行再開 ───
  function resume() {
    if (state.running) return;
    state.running = true;
    state.last_resume_time = Date.now();
  }

  // ─── GPS 1 step 処理 ───
  //   距離計算は Worker B (pipeline-distance) が行う。meter は GPS を Worker B に転送し、
  //   待機時間累積と last_gps 保持を行う。距離 distance_m への加算は _onMmWorkerMessage
  //   (= pipelineDeltaM 受信) でのみ起きる。
  function update(gpsResult) {
    // ★isStationary 早期 return: 停車中は距離を一切動かさない (= creep 防止・絶対)。
    //   停車中でも Worker B にハートビートを送り Viterbi の時間進行 commit 機会を作る。
    if (gpsResult.isStationary) {
      _updateMapMatching(gpsResult);
      return;
    }

    // 待機時間累積 (fareConfig v2): 速度 < 3km/h かつ running で wait_sec を増加。
    if (state.running && state.last_timestamp) {
      const dtSec2 = (gpsResult.timestamp - state.last_timestamp) / 1000;
      if (dtSec2 > 0 && dtSec2 < 60 && (gpsResult.speedKmh || 0) < 3) {
        state.wait_sec += dtSec2;
      }
    }

    // last_gps 保持 (= 復元 / heading 表示用・距離計算には使わない)。
    state.last_gps = {
      lat: gpsResult.lat,
      lng: gpsResult.lng,
      accuracy: gpsResult.accuracy,
      altitude: gpsResult.altitude,
      compassHeading: gpsResult.compassHeading || null,
    };
    state.last_timestamp = gpsResult.timestamp;
    state.last_speed_kmh = gpsResult.speedKmh || 0;
    state.last_isStationary = gpsResult.isStationary === true;

    // Phase 2.A 訓練データ収集 (位置情報は送られない・将来 AI 推論基盤)。
    if (
      typeof TrainingCollector !== 'undefined' &&
      typeof TrainingCollector.collectIfEligible === 'function'
    ) {
      try {
        TrainingCollector.collectIfEligible(gpsResult);
      } catch (_) {
        /* noop - intentionally empty */
      }
    }

    // Worker B に GPS 転送 (= pipeline tracker ingest → pipelineDeltaM 返却)。
    _updateMapMatching(gpsResult);
  }

  // ─── Worker B に GPS を転送 ───
  function _updateMapMatching(gpsResult) {
    if (!MM_ENABLED) return;
    if (gpsResult.isStationary) {
      // 停車中も heartbeat を送り isStationary=true を伝える (= Worker B が delta=0 を返す)。
      if (mmWorker && _workerLoadedPrefs.size > 0) {
        try {
          mmWorker.postMessage({
            type: 'gps',
            lat: gpsResult.lat,
            lng: gpsResult.lng,
            timestamp: gpsResult.timestamp,
            accuracy: gpsResult.accuracy,
            speedKmh: gpsResult.speedKmh,
            headingDeg: gpsResult.compassHeading != null ? gpsResult.compassHeading : null,
            altitude: typeof gpsResult.altitude === 'number' ? gpsResult.altitude : null,
            isStationary: true,
          });
        } catch (e) {
          if (typeof dlog === 'function') dlog('[MM] worker post error: ' + e.message);
        }
      }
      return;
    }
    if (typeof gpsResult.lat !== 'number' || typeof gpsResult.lng !== 'number') return;
    if (mmWorker && _workerLoadedPrefs.size > 0) {
      state.mm_total_count++;
      try {
        mmWorker.postMessage({
          type: 'gps',
          lat: gpsResult.lat,
          lng: gpsResult.lng,
          timestamp: gpsResult.timestamp,
          accuracy: gpsResult.accuracy,
          speedKmh: gpsResult.speedKmh,
          headingDeg: gpsResult.compassHeading != null ? gpsResult.compassHeading : null,
          altitude: typeof gpsResult.altitude === 'number' ? gpsResult.altitude : null,
          isStationary: gpsResult.isStationary === true,
        });
      } catch (e) {
        if (typeof dlog === 'function') dlog('[MM] worker post error: ' + e.message);
      }
    }
    // Worker B 不在時は何もしない (= GPS 直線課金は絶対不可・距離据え置き)。
  }

  // ─── calcFare (★1 byte もじらず移植★・v2 多段階パイプライン) ───
  //   Step 1 距離料金 (tiers 優先・旧 base+add fallback)
  //   Step 2 vehicle 倍率 + addon / Step 3 手動 surcharges 乗算
  //   Step 4 autoSurcharges 乗算 / Step 5 wait 料金 / Step 6 clamp / Step 7 丸め
  function calcFare(distanceM) {
    let fare = 0;

    // Step 1: 距離料金
    if (Array.isArray(fareConfig.tiers) && fareConfig.tiers.length > 0) {
      // 新形式: tiers 配列 走査
      if (distanceM <= fareConfig.base_distance_m) {
        fare = fareConfig.base_fare;
      } else {
        fare = fareConfig.base_fare;
        for (const tier of fareConfig.tiers) {
          if (!tier || typeof tier.from_m !== 'number') continue;
          if (distanceM <= tier.from_m) continue;
          const tierEnd =
            tier.to_m === null || tier.to_m === undefined
              ? distanceM
              : Math.min(distanceM, tier.to_m);
          const tierDist = tierEnd - tier.from_m;
          if (tierDist <= 0) continue;
          const ad = tier.add_distance_m > 0 ? tier.add_distance_m : 1;
          const af = tier.add_fare || 0;
          const steps = Math.floor(tierDist / ad) + 1;
          fare += steps * af;
          if (tier.to_m === null || tier.to_m === undefined) break;
          if (distanceM <= tier.to_m) break;
        }
      }
    } else {
      // 旧形式 fallback: base + add 単純計算
      if (distanceM <= fareConfig.base_distance_m) {
        fare = fareConfig.base_fare;
      } else {
        const extra = distanceM - fareConfig.base_distance_m;
        const steps = Math.ceil(extra / fareConfig.add_distance_m);
        fare = fareConfig.base_fare + steps * fareConfig.add_fare;
      }
    }

    // Step 2: vehicle 倍率 + addon
    if (fareConfig.vehiclesEnabled && _activeVehicleId && Array.isArray(fareConfig.vehicles)) {
      const v = fareConfig.vehicles.find((x) => x && x.id === _activeVehicleId);
      if (v) {
        const mul = typeof v.multiplier === 'number' && v.multiplier > 0 ? v.multiplier : 1.0;
        const addon = typeof v.addon === 'number' ? v.addon : 0;
        fare = fare * mul + addon;
      }
    }

    // Step 3: 手動 surcharges 乗算
    let manualMul = 1.0;
    if (Array.isArray(fareConfig.surcharges)) {
      for (const id of _activeSurchargeIds) {
        const s = fareConfig.surcharges.find((x) => x && x.id === id);
        if (s && typeof s.rate === 'number' && s.rate >= 1.0) manualMul *= s.rate;
      }
    }
    fare *= manualMul;

    // Step 4: autoSurcharges 自動判定 (現在時刻ベース)
    fare *= _calcAutoSurchargeMultiplier(new Date());

    // Step 5: wait 料金加算
    if (fareConfig.wait && fareConfig.wait.enabled) {
      const waitMin = (state.wait_sec || 0) / 60;
      const free = typeof fareConfig.wait.freeMins === 'number' ? fareConfig.wait.freeMins : 5;
      const rate =
        typeof fareConfig.wait.ratePerMin === 'number' ? fareConfig.wait.ratePerMin : 100;
      const billable = Math.max(0, waitMin - free);
      fare += billable * rate;
    }

    // Step 6: min/max clamp
    if (
      typeof fareConfig.minFare === 'number' &&
      fareConfig.minFare > 0 &&
      fare < fareConfig.minFare
    ) {
      fare = fareConfig.minFare;
    }
    if (
      typeof fareConfig.maxFare === 'number' &&
      fareConfig.maxFare > 0 &&
      fare > fareConfig.maxFare
    ) {
      fare = fareConfig.maxFare;
    }

    // Step 7: 丸め
    const unit =
      typeof fareConfig.rounding === 'number' && fareConfig.rounding > 0 ? fareConfig.rounding : 1;
    if (unit > 1) fare = Math.round(fare / unit) * unit;
    else fare = Math.round(fare);

    return fare;
  }

  // autoSurcharges 自動判定: 現在時刻に該当する全 auto rule の rate 積
  function _calcAutoSurchargeMultiplier(now) {
    if (!fareConfig.autoSurcharges) return 1.0;
    let mul = 1.0;
    const a = fareConfig.autoSurcharges;
    // night: 時刻範囲 (wraparound 対応)
    if (a.night && a.night.enabled) {
      const h = now.getHours();
      const f = a.night.from,
        t = a.night.to;
      const inRange = f <= t ? h >= f && h < t : h >= f || h < t;
      if (inRange && typeof a.night.rate === 'number') mul *= a.night.rate;
    }
    // weekend: 土日固定
    if (a.weekend && a.weekend.enabled) {
      const dow = now.getDay();
      if ((dow === 0 || dow === 6) && typeof a.weekend.rate === 'number') mul *= a.weekend.rate;
    }
    // winter: 月日範囲 (年跨ぎ対応・MM-DD 文字列)
    if (a.winter && a.winter.enabled) {
      const mmdd =
        String(now.getMonth() + 1).padStart(2, '0') + '-' + String(now.getDate()).padStart(2, '0');
      const f = a.winter.from || '12-15';
      const t = a.winter.to || '03-15';
      const inRange = f <= t ? mmdd >= f && mmdd <= t : mmdd >= f || mmdd <= t;
      if (inRange && typeof a.winter.rate === 'number') mul *= a.winter.rate;
    }
    return mul;
  }

  // ─── fareConfig v2 surcharge / vehicle 公開 API ───
  function setSurchargeActive(id, active) {
    if (!id) return;
    if (active) _activeSurchargeIds.add(id);
    else _activeSurchargeIds.delete(id);
    state.fare_yen = calcFare(state.distance_m);
  }
  function toggleSurcharge(id) {
    if (!id) return;
    if (_activeSurchargeIds.has(id)) _activeSurchargeIds.delete(id);
    else _activeSurchargeIds.add(id);
    state.fare_yen = calcFare(state.distance_m);
  }
  function getActiveSurcharges() {
    return Array.from(_activeSurchargeIds);
  }
  function getSurchargeMultiplier() {
    let mul = 1.0;
    if (Array.isArray(fareConfig.surcharges)) {
      for (const id of _activeSurchargeIds) {
        const s = fareConfig.surcharges.find((x) => x && x.id === id);
        if (s && typeof s.rate === 'number' && s.rate >= 1.0) mul *= s.rate;
      }
    }
    mul *= _calcAutoSurchargeMultiplier(new Date());
    return mul;
  }
  function setVehicleType(vehicleId) {
    _activeVehicleId = vehicleId || null;
    state.fare_yen = calcFare(state.distance_m);
  }
  function getVehicleType() {
    return _activeVehicleId;
  }

  // ─── 表示用 予測補間ヘルパ (= 距離値 1 byte 不変の表示専用 layer・10m 滑らか) ───
  //   target = 実距離値。velocity = 直近 1 秒の target 増分 / dt (自己整合)。
  //   display = max(prev_display, target + 予測先取り) で単調増加 + 滑らか化。
  function _smoothDisplay(target, prevDisplay, prevTarget, prevTargetTime, velRef, now) {
    let velocity = velRef.v || 0;
    if (prevTargetTime !== null) {
      const dt = (now - prevTargetTime) / 1000;
      if (dt > 0.05) {
        const inc = target - prevTarget;
        const instV = inc > 0 ? inc / dt : 0;
        // 自己整合: target が進んだ時のみ velocity を更新 (= 停車中 velocity 0 → 予測 0)。
        velocity = instV > 0 ? Math.min(instV, DISP_V_CLAMP_MPS) : 0;
      }
    }
    velRef.v = velocity;
    velRef.prevTarget = target;
    velRef.prevTargetTime = now;
    let predict = 0;
    if (velocity > 0 && prevTargetTime !== null) {
      const sinceTarget = (now - prevTargetTime) / 1000;
      predict = Math.min(velocity * Math.min(1.0, Math.max(0, sinceTarget)), DISP_PREDICT_MAX_M);
    }
    const candidate = target + predict;
    return Math.max(prevDisplay || 0, candidate);
  }

  // ─── getState ───
  function getState() {
    // elapsed_sec は都度計算 (= 累積 + 直近 resume 経過・setInterval 全廃)。
    const elapsedSec =
      state.running && state.last_resume_time !== null
        ? Math.floor((state.elapsed_accumulated_sec + (Date.now() - state.last_resume_time)) / 1000)
        : Math.floor((state.elapsed_accumulated_sec || 0) / 1000);

    const now = Date.now();
    // 課金 display: distance_m を 10m 滑らかに先取り表示 (= 実距離値は不変)。
    const target = state.distance_m || 0;
    const velRef = {
      v: state._target_velocity_mps,
      prevTarget: state._prev_target_distance_m,
      prevTargetTime: state._prev_target_time,
    };
    const display = _smoothDisplay(
      target,
      state.display_distance_m,
      state._prev_target_distance_m,
      state._prev_target_time,
      velRef,
      now
    );
    state._target_velocity_mps = velRef.v;
    state._prev_target_distance_m = velRef.prevTarget;
    state._prev_target_time = velRef.prevTargetTime;
    state.display_distance_m = display;
    state.last_display_update_time = now;

    // 業務 display: business_distance_m を滑らか追従 (= 別回路・実距離値は不変)。
    const btarget = state.business_distance_m || 0;
    const bvelRef = {
      v: state._business_target_velocity_mps,
      prevTarget: state._prev_business_target_distance_m,
      prevTargetTime: state._prev_business_target_time,
    };
    const bdisplay = _smoothDisplay(
      btarget,
      state.business_display_distance_m,
      state._prev_business_target_distance_m,
      state._prev_business_target_time,
      bvelRef,
      now
    );
    state._business_target_velocity_mps = bvelRef.v;
    state._prev_business_target_distance_m = bvelRef.prevTarget;
    state._prev_business_target_time = bvelRef.prevTargetTime;
    state.business_display_distance_m = bdisplay;
    state.last_business_display_update_time = now;

    return { ...state, elapsed_sec: elapsedSec };
  }

  // ─── getMMStats ───
  function getMMStats() {
    const total = state.mm_total_count;
    const snap = state.mm_snap_count;
    const skip = state.mm_skip_count;
    return {
      total_count: total,
      snap_count: snap,
      skip_count: skip,
      snap_rate: total > 0 ? snap / total : 0,
      skip_rate: total > 0 ? skip / total : 0,
      mm_distance_m: state.mm_distance_m,
      distance_m: state.distance_m,
      distance_source: state.distanceSource,
      mm_silent_ms: lastMmUsefulAt > 0 ? Date.now() - lastMmUsefulAt : null,
      p99_latency_ms: _calcP99Latency(),
      latency_samples: _mmLatencyCount,
      avg_candidates: _mmCandCountSamples > 0 ? _mmCandCountSum / _mmCandCountSamples : 0,
      worker_active: !!mmWorker,
      mcm_window_size: _lastMcmN,
    };
  }

  // ─── 復元 / 外部設定 API ───
  function setDistance(distanceM) {
    const v = Number.isFinite(distanceM) && distanceM >= 0 ? distanceM : 0;
    state.distance_m = v;
    state.fare_yen = calcFare(v);
    // 復元時は display を即時同期 (= 0 から数百秒かけて追従するのを防ぐ)。
    state.display_distance_m = v;
    state._prev_target_distance_m = v;
    state._prev_target_time = null;
    state._target_velocity_mps = 0;
  }
  function setBusinessDistance(m) {
    const bv = typeof m === 'number' && m >= 0 ? m : 0;
    state.business_distance_m = bv;
    state.business_display_distance_m = bv;
    state._prev_business_target_distance_m = bv;
    state._prev_business_target_time = null;
    state._business_target_velocity_mps = 0;
  }
  function setBusinessActive(active) {
    state.business_active = !!active;
  }
  function setLastGps(lat, lng, altitude, speedKmh, timestamp) {
    state.last_gps = { lat, lng, altitude };
    state.last_timestamp = timestamp;
    state.last_speed_kmh = speedKmh || 0;
  }
  function setElapsedAccumulated(savedSec) {
    const v = typeof savedSec === 'number' && savedSec >= 0 ? savedSec : 0;
    state.elapsed_accumulated_sec = v;
    state.last_resume_time = Date.now();
  }

  // ─── warm up: 代行開始前から GPS を保持 (state には触らない) ───
  function updateGpsOnly(gpsResult) {
    if (!gpsResult || typeof gpsResult.lat !== 'number' || typeof gpsResult.lng !== 'number')
      return;
    lastWarmupGps = {
      lat: gpsResult.lat,
      lng: gpsResult.lng,
      accuracy: gpsResult.accuracy,
      altitude: gpsResult.altitude || 0,
      compassHeading: gpsResult.compassHeading || null,
      timestamp: gpsResult.timestamp || Date.now(),
      speedKmh: gpsResult.speedKmh || 0,
    };
  }

  // ─── 業務開始時 warmup GPS prime (= 待機中初回 GPS からラグ最小で計測開始) ───
  function primeFromWarmup() {
    const now = Date.now();
    const WARMUP_MAX_AGE_MS = 5000;
    const warmupValid =
      lastWarmupGps && lastWarmupGps.timestamp && now - lastWarmupGps.timestamp < WARMUP_MAX_AGE_MS;
    if (!warmupValid) return false;
    state.last_gps = {
      lat: lastWarmupGps.lat,
      lng: lastWarmupGps.lng,
      accuracy: lastWarmupGps.accuracy,
      altitude: lastWarmupGps.altitude,
      compassHeading: lastWarmupGps.compassHeading || null,
    };
    state.last_timestamp = lastWarmupGps.timestamp;
    state.last_speed_kmh = lastWarmupGps.speedKmh || 0;
    return true;
  }

  // ============================================================
  // 住所検索 (= 表示専用・距離 / 課金 / Worker B とは無関係) ───
  //   県別 fine → 全国 fine (後方互換) → coarse 付近 の 4 段フォールバック。
  // ============================================================
  function _haversineMetersForAddr(lat1, lng1, lat2, lng2) {
    const R = 6371000;
    const toRad = Math.PI / 180;
    const dLat = (lat2 - lat1) * toRad;
    const dLng = (lng2 - lng1) * toRad;
    const a =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLng / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }
  // JIS X 0401 都道府県コード (2 桁文字列) → ローマ字 pref 名 (perPref 命名規則)
  const _JIS_TO_PREF = {
    '01': 'hokkaido',
    '02': 'aomori',
    '03': 'iwate',
    '04': 'miyagi',
    '05': 'akita',
    '06': 'yamagata',
    '07': 'fukushima',
    '08': 'ibaraki',
    '09': 'tochigi',
    10: 'gunma',
    11: 'saitama',
    12: 'chiba',
    13: 'tokyo',
    14: 'kanagawa',
    15: 'niigata',
    16: 'toyama',
    17: 'ishikawa',
    18: 'fukui',
    19: 'yamanashi',
    20: 'nagano',
    21: 'gifu',
    22: 'shizuoka',
    23: 'aichi',
    24: 'mie',
    25: 'shiga',
    26: 'kyoto',
    27: 'osaka',
    28: 'hyogo',
    29: 'nara',
    30: 'wakayama',
    31: 'tottori',
    32: 'shimane',
    33: 'okayama',
    34: 'hiroshima',
    35: 'yamaguchi',
    36: 'tokushima',
    37: 'kagawa',
    38: 'ehime',
    39: 'kochi',
    40: 'fukuoka',
    41: 'saga',
    42: 'nagasaki',
    43: 'kumamoto',
    44: 'oita',
    45: 'miyazaki',
    46: 'kagoshima',
    47: 'okinawa',
  };
  function _jisToPref(jis) {
    if (typeof jis !== 'string' && typeof jis !== 'number') return null;
    const key = String(jis);
    return _JIS_TO_PREF[key] || _JIS_TO_PREF[Number(key)] || null;
  }
  function _getFineBundleForPref(pref) {
    if (typeof window === 'undefined') return null;
    const upper = pref.toUpperCase().replace(/-/g, '_');
    const bundle = window['ADDRESSES_FINE_' + upper];
    if (bundle && Array.isArray(bundle.items)) return bundle;
    return null;
  }
  function _searchFineItems(items, lat, lng, targetLatI, targetLngI) {
    const COORD_SCALE = 100000;
    const FINE_RADIUS_M = 500;
    const fineRangeI = 520;
    let best = null;
    let bestDist = Infinity;
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      const dLatI = it.lat - targetLatI;
      if (dLatI > fineRangeI || dLatI < -fineRangeI) continue;
      const dLngI = it.lng - targetLngI;
      if (dLngI > fineRangeI || dLngI < -fineRangeI) continue;
      const itemLat = it.lat / COORD_SCALE;
      const itemLng = it.lng / COORD_SCALE;
      const distM = _haversineMetersForAddr(lat, lng, itemLat, itemLng);
      if (distM <= FINE_RADIUS_M && distM < bestDist) {
        bestDist = distM;
        best = it;
      }
    }
    return best;
  }
  function getNearestAddress(lat, lng, accuracy) {
    if (typeof lat !== 'number' || typeof lng !== 'number' || !isFinite(lat) || !isFinite(lng)) {
      return null;
    }
    if (typeof accuracy === 'number' && isFinite(accuracy) && accuracy > 50) {
      return null;
    }
    const COORD_SCALE = 100000;
    const targetLatI = Math.round(lat * COORD_SCALE);
    const targetLngI = Math.round(lng * COORD_SCALE);
    const COARSE_RADIUS_M = 25000;
    const coarseRangeI = 25000;

    // ① coarse から最近傍 (~25km 内) を引いて県コードを取得
    let bestCoarse = null;
    let bestCoarseDistM = Infinity;
    if (
      typeof window !== 'undefined' &&
      window.ADDRESSES_COARSE_JP &&
      Array.isArray(window.ADDRESSES_COARSE_JP.items)
    ) {
      const coarseItems = window.ADDRESSES_COARSE_JP.items;
      for (let i = 0; i < coarseItems.length; i++) {
        const it = coarseItems[i];
        const dLatI = it.lat - targetLatI;
        if (dLatI > coarseRangeI || dLatI < -coarseRangeI) continue;
        const dLngI = it.lng - targetLngI;
        if (dLngI > coarseRangeI || dLngI < -coarseRangeI) continue;
        const itemLat = it.lat / COORD_SCALE;
        const itemLng = it.lng / COORD_SCALE;
        const distM = _haversineMetersForAddr(lat, lng, itemLat, itemLng);
        if (distM <= COARSE_RADIUS_M && distM < bestCoarseDistM) {
          bestCoarseDistM = distM;
          bestCoarse = it;
        }
      }
    }
    let prefName = null;
    if (bestCoarse && typeof bestCoarse.c === 'string' && bestCoarse.c.length >= 2) {
      prefName = _jisToPref(bestCoarse.c.substring(0, 2));
    }

    // ② 該当県の fine が load 済なら fine 検索 (~500m 内)
    if (prefName) {
      const bundle = _getFineBundleForPref(prefName);
      if (bundle) {
        const best = _searchFineItems(bundle.items, lat, lng, targetLatI, targetLngI);
        if (best) return best.n;
      }
    }

    // ③ 後方互換: 全国版 ADDRESSES_FINE_JP が load 済ならそれも検索
    if (
      typeof window !== 'undefined' &&
      window.ADDRESSES_FINE_JP &&
      Array.isArray(window.ADDRESSES_FINE_JP.items)
    ) {
      const best = _searchFineItems(
        window.ADDRESSES_FINE_JP.items,
        lat,
        lng,
        targetLatI,
        targetLngI
      );
      if (best) return best.n;
    }

    // ④ fine miss / fine 未 load → coarse 結果 (市区町村 + 付近)
    if (bestCoarse) return bestCoarse.n + ' 付近';

    return null;
  }
  function _anyFinePrefLoaded() {
    if (typeof window === 'undefined') return false;
    for (const code of Object.keys(_JIS_TO_PREF)) {
      const pref = _JIS_TO_PREF[code];
      const upper = pref.toUpperCase().replace(/-/g, '_');
      const bundle = window['ADDRESSES_FINE_' + upper];
      if (bundle && Array.isArray(bundle.items) && bundle.items.length > 0) return true;
    }
    return false;
  }
  function isAddressDataReady() {
    const coarseReady =
      typeof window !== 'undefined' &&
      window.ADDRESSES_COARSE_JP &&
      Array.isArray(window.ADDRESSES_COARSE_JP.items) &&
      window.ADDRESSES_COARSE_JP.items.length > 0;
    if (coarseReady) return true;
    const fineLegacyReady =
      typeof window !== 'undefined' &&
      window.ADDRESSES_FINE_JP &&
      Array.isArray(window.ADDRESSES_FINE_JP.items) &&
      window.ADDRESSES_FINE_JP.items.length > 0;
    if (fineLegacyReady) return true;
    return _anyFinePrefLoaded();
  }

  // ─── 公開 API (= 公開 28 メソッド + テスト escape hatch 2 = 30 プロパティ・signature 完全維持) ───
  return {
    start,
    stop,
    businessEnd,
    reset,
    resume,
    update,
    updateGpsOnly,
    primeFromWarmup,
    setElapsedAccumulated,
    getState,
    getMMStats,
    setFareConfig,
    getFareConfig,
    calcFare,
    getNearestAddress,
    isAddressDataReady,
    setDistance,
    setLastGps,
    setMapMatcher,
    isMmReady,
    setBusinessDistance,
    setBusinessActive,
    setSurchargeActive,
    toggleSurcharge,
    getActiveSurcharges,
    getSurchargeMultiplier,
    setVehicleType,
    getVehicleType,
    // ★テスト用 escape hatch (prod からは呼ばない)
    _setDrainMmUntil: function (t) {
      _drainMmUntil = typeof t === 'number' ? t : 0;
    },
    _setOffRoadGraceUntil: function (t) {
      _offRoadGraceUntil = typeof t === 'number' ? t : 0;
    },
  };
})();

// Node test context: require('./meter.js') で Meter API オブジェクトを取得可能。
// browser / Worker context: module 未定義のため no-op。
// eslint-disable-next-line no-undef -- node 環境のみ・typeof guard で browser/Worker は no-op
if (typeof module !== 'undefined' && typeof module.exports !== 'undefined') module.exports = Meter;
