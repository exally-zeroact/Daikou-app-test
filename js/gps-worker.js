// ===========================================
// gps-worker.js
// GPS計算処理（Web Worker・2026/04/27追加）
// GPS取得はメインスレッド・計算処理のみWorkerで実行
// メインスレッドをブロックしないことでUI描画が安定する
// ===========================================
/* eslint-disable no-console -- ★設計変更宣言 (2026-05-15・lint Phase 6):
   本ファイルは Web Worker 内で動作・window.dlog が未定義のため代替手段なし。
   内部 wlog() ラッパーが console.log を呼ぶ箇所のみで使用 (= Class C)。 */

// デバッグフラグ（メインから初期化メッセージで受け取る）
let debug = false;
function wlog() {
  if (debug) console.log.apply(console, arguments);
}
// ★STEP0 診断 (2026-05-28): GPS層の値を main 経由で Eruda に出す (read-only・throttle)。
//   worker の console.log(wlog) は Eruda に届かないため postMessage で main に送り dlog させる。
//   speedKmh源/isStationary/accuracy/accLimit/reject理由 を・丸め signature 変化時のみ送信。
//   ★accept/reject/距離ロジックには一切影響しない (純診断・判定後に撤去)★。
let _gpsDbgSig = '';
function _postGpsDbg(o) {
  try {
    const sig =
      (o.rej || 'ok') +
      '|' +
      Math.round(o.spd || 0) +
      '|' +
      Math.round(o.acc || 0) +
      '|' +
      (o.lim || 0) +
      '|' +
      (o.stat ? 1 : 0) +
      '|' +
      (o.src || '');
    if (sig === _gpsDbgSig) return;
    _gpsDbgSig = sig;
    self.postMessage({ type: 'gpsDbg', data: o });
  } catch (_) {
    /* noop - 診断のみ */
  }
}

// ─── CONFIG（メインと同じ値・初期化メッセージで上書き可能） ───
let CONFIG = {
  speed_limit_kmh: 3,
  stationary_sec: 5,
  stationary_radius_m: 3,
  stationary_radius_jam_m: 1,
  resume_speed_kmh: 5,
  jump_limit_m_per_s: 50,
  max_acceleration_ms2: 8,
  heading_diff_threshold_deg: 90,
  heading_check_min_distance_m: 5,
  heading_check_min_speed_kmh: 5,
  kalman_Q: 3, // T5 既定値 (typeCode 不明時 / setRoadType 未受信時)
  jam_speed_max_kmh: 10,
  jam_duration_sec: 60,
  _kalman_Q_override: null, // コンパス融合で動的に変更
  // C-1：加速度variance静止判定（2026/04/30追加）
  accel_variance_threshold: 0.1, // m²/s⁴・経験的・実機テストで調整
  accel_variance_window_ms: 5000, // 直近5秒のサンプルで計算
  accel_variance_min_samples: 5, // この件数未満なら判定不能（null返す）
  // C-2：加速度合算ベクトル動き判定（2026/04/30追加）
  accel_motion_threshold: 0.5, // m/s²・|平均|a|-9.8| の閾値・実機調整
  accel_motion_window_ms: 5000, // 直近5秒のサンプルで計算
  accel_motion_min_samples: 5, // この件数未満なら判定不能（null返す）
  // ★Fix① (2026-05-28・★設計変更宣言★): 静止判定を加速度variance主体に作り直す。
  //   GPS速度(A3合成/Dopplerノイズ)を静止判定の主信号にしない。
  //   この速度以上は「確実に移動」(driftでは到達しない速度) として静止解除し、
  //   定速走行で加速度varidanceが低くても under-count しないための backstop。
  //   観測値: A3 静止 drift 速度 ≈ 3.1km/h → これを上回り・かつ実走行を拾う 10km/h。
  stationary_moving_speed_kmh: 10,
  // ★Fix② (2026-05-28): accuracy cap deadlock 手当て。移動時(直前frame非静止)のみ
  //   この値まで accuracy 上限を緩和し屋内/低速 deadlock(全reject→凍結)を回避。
  //   静止時は緩和せず(=base のまま厳格) drift を計上しない。観測: SE 屋内 acc 12-17m。
  accuracy_moving_max_m: 20,
  // ★Fix① v2 (2026-05-28・★設計変更宣言★・dwell time 業界標準準拠):
  //   速度 spike (1 step) で静止判定が defeat されないよう・連続 N step で
  //   speedKmh >= stationary_moving_speed_kmh を観測した時のみ高速ガード発火。
  //   = ArduPilot EKF_GLITCH_RAD「persistent then accept」 + Vehicle Stationary
  //     Detection 論文 (PMC4170787) dwell time 3 秒 (MM併用相当) と整合。
  //   = Linux CI で偽速度 spike 11.68km/h (1 step) が 10km/h backstop を defeat し
  //     creep 33m を出した事象 (run 26553931113 で観測) を遮断。
  //   3 step = 1Hz 端末で 3 秒・5Hz 端末で 0.6 秒。実走行(持続)は通過・spike は遮断。
  high_speed_dwell_steps: 3,
};

// ─── 状態変数（Worker内で保持） ───
let lastPosition = null;
let lowSpeedStart = null;
let _posStillStart = null; // ★Fix① (2026-05-28): 速度非依存の位置半径静止判定 anchor (accel不能時fallback)
let _highSpeedConsecCount = 0; // ★Fix① v2 (2026-05-28): 高速ガード dwell time カウンタ (連続 N step で fire)
let isStationary = false;
let trafficJamSince = null;
let isTrafficJam = false;
let kalman = null;

// T5 (2026-05-09): Adaptive Kalman Q (道路種別連動)
//   map-matcher.js で commit された snap の typeCode を main 経由で受信し、
//   typeCode に応じて Q を動的化する。
//   motorway/trunk: 直線・信頼度高 → Q 小 (1.5)
//   residential/track: カーブ多・信頼度低 → Q 大 (4.0)
//   typeCode 不明時は CONFIG.kalman_Q (=3) を使う。
let _currentTypeCode = null;
function _typeCodeToQ(typeCode) {
  if (typeCode == null) return CONFIG.kalman_Q;
  switch (typeCode) {
    case 0:
    case 1:
      return 1.5; // motorway / trunk
    case 7:
    case 8:
      return 1.5; // motorway_link / trunk_link
    case 2:
    case 3:
      return 2.5; // primary / secondary
    case 9:
    case 10:
      return 2.5; // primary_link / secondary_link
    case 4:
    case 5:
      return 3.0; // tertiary / unclassified
    case 11:
      return 3.0; // tertiary_link
    case 6:
    case 12:
      return 4.0; // residential / track
    default:
      return CONFIG.kalman_Q;
  }
}
function _getDynamicBaseQ() {
  return _typeCodeToQ(_currentTypeCode);
}

// 2026-05-09 (P4 廃止): cellular tunnel hint 完全削除
//   理由: layer (v6 attribute) + tunnels-{pref}.js データで道路属性ベースに代替
//   利点: iOS Safari/PWA でも同等動作・接続不安定時の偽陽性なし
//   詳細: map-matcher.js の _computeLayerScore で prevLayer 連続性 boost に置換
// 2026-05-30 (§4 死コード一掃): _prevAccuracy は write-only (= 参照 0・grep 実証済) で
//   除去。accuracy は processPosition 内 local + lastPosition に保持され差分には未使用。

// ─── Kalmanフィルター（案D・2026/04/27） ───
// ★設計変更宣言 Phase 1.ZUPT (2026-05-10): Zero Velocity Update
//   現 Kalman は position-only (vx/vy 状態を持たない) のため、
//   ユーザー指示「vx/vy を 0 に強制リセット」は process noise Q の override で実現する。
//   ZUPT active 中: Q = 0.01 (≒ 速度ドリフト 0)
//     → decayed accuracy ≒ 既存 _accuracy (= 位置共分散維持)
//     → K ≒ 0 (新 GPS 値による位置移動は小・GPS noise 由来 drift を抑制)
//   ZUPT inactive: 既存通り T5 動的 Q (typeCode 連動) または qOverride
//   起動条件: 直前 frame の isStationary 判定 (3 点 AND: GPS+C-1+C-2)
//   停車終了で自動的に通常 Q に復帰 (Off-Road Mode 中の慣性誤差累積も抑える効果)
const ZUPT_Q = 0.01;
// ★設計変更宣言 Phase A-5 (2026-05-26・案 N: R-only Sage-Husa Adaptive R):
//   観測残差 (innovation) を直近 N=10 step 蓄積し RMS を取って R̂ を推定。
//   effectiveAccuracy = max(報告 accuracy, R̂) で chip の accuracy 過小報告 (= multipath で
//   誤って小値を吐くケース) を補正。R̂ は SAGE_HUSA_R_MAX_M で上限 clamp し過剰 filter を防止。
//   buffer N<5 は既存 accuracy をそのまま使用 (fallback)。
//   絶対ルール準拠:
//     ・Q 3 系統 (= ZUPT / コンパス融合 / T5 typeCode 連動): 1byte 不変
//     ・calcFare / distance_m 加算 5 経路 / running gate / Worker B: 1byte 不変
const SAGE_HUSA_BUFFER_N = 10;
const SAGE_HUSA_MIN_SAMPLES = 5;
const SAGE_HUSA_R_MAX_M = 35; // R̂ 上限 (= getDynamicAccuracyLimit 最大値と同期)
class KalmanGPS {
  constructor() {
    this._lat = null;
    this._lng = null;
    this._accuracy = 0;
    this._timestamp = null;
    this._zuptActive = false; // Phase 1.ZUPT: 停車中フラグ
    this._innovBuffer = []; // Phase A-5: 観測残差距離 (m) 直近 N=10 step
    this._adaptiveR = null; // Phase A-5: 推定 R̂ (m)・buffer N>=5 で更新
  }
  reset() {
    this._lat = null;
    this._lng = null;
    this._accuracy = 0;
    this._timestamp = null;
    this._zuptActive = false;
    this._innovBuffer = []; // Phase A-5: buffer もリセット
    this._adaptiveR = null;
  }
  // Phase 1.ZUPT: 停車検出に応じて ZUPT モードを切替
  setZuptActive(active) {
    this._zuptActive = !!active;
  }
  update(lat, lng, accuracy, timestamp, qOverride) {
    if (this._lat === null) {
      this._lat = lat;
      this._lng = lng;
      this._accuracy = accuracy;
      this._timestamp = timestamp;
      return { lat, lng };
    }
    const dt = (timestamp - this._timestamp) / 1000;
    if (dt <= 0 || dt > 30) {
      this._lat = lat;
      this._lng = lng;
      this._accuracy = accuracy;
      this._timestamp = timestamp;
      return { lat, lng };
    }
    // Phase 1.ZUPT: ZUPT active 中は速度成分 (Q) を 0 ≒ ZUPT_Q に強制
    //   通常時: T5 typeCode 連動の動的 Q または qOverride (コンパス融合)
    //   ZUPT active 時: ZUPT_Q (0.01) に強制し速度ドリフトを抑制
    let Q;
    if (this._zuptActive) {
      Q = ZUPT_Q;
    } else if (qOverride != null) {
      Q = qOverride;
    } else {
      Q = _getDynamicBaseQ();
    }
    // Phase A-5 (案 N): R adaptive 補正
    //   buffer N>=5 で R̂ 有・effectiveAccuracy = max(報告 accuracy, R̂)。
    //   buffer N<5 は fallback で報告 accuracy をそのまま使用。
    let effectiveAccuracy = accuracy;
    if (this._adaptiveR != null && this._innovBuffer.length >= SAGE_HUSA_MIN_SAMPLES) {
      effectiveAccuracy = Math.max(accuracy, this._adaptiveR);
    }
    const decayed = Math.sqrt(this._accuracy * this._accuracy + Q * Q * dt * dt);
    const K = (decayed * decayed) / (decayed * decayed + effectiveAccuracy * effectiveAccuracy);
    // Phase A-5: innovation 距離 (m) 計算・buffer 蓄積・R̂ 推定
    //   観測残差 = (lat - this._lat) ・(lng - this._lng) を meter 換算
    //   buffer push + N>10 で shift・N>=5 で RMS から R̂ 更新
    //   R̂ は SAGE_HUSA_R_MAX_M で上限 clamp (= 過剰 filter 防止)
    const innovLat = lat - this._lat;
    const innovLng = lng - this._lng;
    const meterPerDegLat = 111000;
    const meterPerDegLng = 111000 * Math.cos((this._lat * Math.PI) / 180);
    const innovDistM = Math.sqrt(
      innovLat * meterPerDegLat * (innovLat * meterPerDegLat) +
        innovLng * meterPerDegLng * (innovLng * meterPerDegLng)
    );
    this._innovBuffer.push(innovDistM);
    if (this._innovBuffer.length > SAGE_HUSA_BUFFER_N) this._innovBuffer.shift();
    if (this._innovBuffer.length >= SAGE_HUSA_MIN_SAMPLES) {
      let sumSq = 0;
      for (let i = 0; i < this._innovBuffer.length; i++) {
        sumSq += this._innovBuffer[i] * this._innovBuffer[i];
      }
      const rms = Math.sqrt(sumSq / this._innovBuffer.length);
      this._adaptiveR = Math.min(rms, SAGE_HUSA_R_MAX_M);
    }
    this._lat = this._lat + K * innovLat;
    this._lng = this._lng + K * innovLng;
    this._accuracy = Math.sqrt((1 - K) * decayed * decayed);
    this._timestamp = timestamp;
    if (!isFinite(this._lat) || !isFinite(this._lng)) {
      wlog('[GPS] Kalman異常値 → フォールバック');
      this._lat = lat;
      this._lng = lng;
      this._accuracy = accuracy;
      return { lat, lng };
    }
    return { lat: this._lat, lng: this._lng };
  }
}

// Phase 1.ZUPT: 直前 frame の停車判定を carry
//   processPosition 内で stationary 検出は Kalman 後に走るため、
//   今 frame の Kalman に ZUPT を適用するには「前 frame の判定」を使う必要あり (1 frame lag)
let _isStationaryLast = false;

// ─── 動的accuracy閾値 ───
function getDynamicAccuracyLimit(speedKmh, now) {
  let limit;
  if (speedKmh < 30) limit = 10;
  else if (speedKmh < 60) limit = 15;
  else if (speedKmh < 100) limit = 25;
  else limit = 35;
  const hour = new Date(now).getHours();
  if (hour >= 22 || hour < 5) limit *= 1.2;
  return limit;
}

// ─── 渋滞モード判定 ───
function checkTrafficJam(speedKmh, now) {
  if (speedKmh > 0 && speedKmh < CONFIG.jam_speed_max_kmh) {
    if (!trafficJamSince) trafficJamSince = now;
    const durationSec = (now - trafficJamSince) / 1000;
    if (durationSec >= CONFIG.jam_duration_sec) {
      if (!isTrafficJam) wlog('[GPS] 渋滞モード開始');
      isTrafficJam = true;
      return true;
    }
  } else if (speedKmh >= CONFIG.jam_speed_max_kmh) {
    if (isTrafficJam) wlog('[GPS] 渋滞モード解除');
    trafficJamSince = null;
    isTrafficJam = false;
  }
  return isTrafficJam;
}

// ─── 方位角計算（案U用） ───
function calcBearing(lat1, lng1, lat2, lng2) {
  const φ1 = (lat1 * Math.PI) / 180;
  const φ2 = (lat2 * Math.PI) / 180;
  const Δλ = ((lng2 - lng1) * Math.PI) / 180;
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

function angleDiff(a, b) {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

// ─── 静止判定 ───
// ─── C-1：加速度variance計算（2026/04/30追加） ───
// 直近のサンプルから加速度合算ベクトル|a|=√(x²+y²+z²)の分散を計算
// 静止時：variance ほぼ0（重力のみ）
// 走行中：variance > 0.5（振動・加速・減速）
// 戻り値：variance (m²/s⁴) | null（サンプル不足／加速度なし端末）
function calcAccelVariance(accelSamples, now) {
  if (!accelSamples || !Array.isArray(accelSamples)) return null;
  if (accelSamples.length < CONFIG.accel_variance_min_samples) return null;

  // 時間ウィンドウ内のサンプルのみ抽出（学術論文5秒推奨）
  const windowMs = CONFIG.accel_variance_window_ms;
  const recent = accelSamples.filter((s) => s && typeof s.t === 'number' && now - s.t < windowMs);
  if (recent.length < CONFIG.accel_variance_min_samples) return null;

  // 合算ベクトルの大きさ |a| = √(x² + y² + z²)
  // この方法はスマホの向きに依存しない（重力含むが大きさは同じ）
  const magnitudes = recent.map((s) => Math.sqrt(s.x * s.x + s.y * s.y + s.z * s.z));

  // 平均
  const mean = magnitudes.reduce((a, b) => a + b, 0) / magnitudes.length;

  // 分散
  const variance =
    magnitudes.reduce((sum, m) => sum + (m - mean) * (m - mean), 0) / magnitudes.length;

  return variance;
}

// 2026-05-09 (P4/P5 廃止) + 2026-05-30 (§4 死コード一掃):
//   旧 MM-5 加速度路面セマンティクス検出 (_calcAccelLayerHint・accelLayerHint='bridge'/'normal'
//   と ACCEL_LAYER_*/ACCEL_BRIDGE_* 定数) は除去。
//   理由: layer (v6 attribute) + bridges-/tunnels-{pref}.js データで道路属性ベースに代替済で
//         本関数は呼出 0 件 (= grep 実証済・dead)。橋/トンネル判定は map-matcher の
//         _computeLayerScore (prevLayer 連続性 boost) が担う。

// ─── C-2：加速度合算ベクトル動き判定（2026/04/30追加） ───
// 直近のサンプルから |a|=√(x²+y²+z²) の平均を計算し、9.8（重力）からの偏差を返す
// 静止時：|平均|a|| ≈ 9.8 → 偏差 ≈ 0
// 動いてる時：加減速・振動で平均|a| が 9.8 から離れる → 偏差大
// 平均値を使うのは体勢変化（一瞬の値）に対する頑健性のため
// 戻り値：偏差 (m/s²) | null（サンプル不足／加速度なし端末）
function calcAccelMagnitudeDeviation(accelSamples, now) {
  if (!accelSamples || !Array.isArray(accelSamples)) return null;
  if (accelSamples.length < CONFIG.accel_motion_min_samples) return null;

  // 時間ウィンドウ内のサンプルのみ抽出
  const windowMs = CONFIG.accel_motion_window_ms;
  const recent = accelSamples.filter((s) => s && typeof s.t === 'number' && now - s.t < windowMs);
  if (recent.length < CONFIG.accel_motion_min_samples) return null;

  // 合算ベクトルの大きさ |a| = √(x² + y² + z²)
  const magnitudes = recent.map((s) => Math.sqrt(s.x * s.x + s.y * s.y + s.z * s.z));

  // 平均（瞬間値ではなく平均で体勢変化に頑健化）
  const meanMag = magnitudes.reduce((a, b) => a + b, 0) / magnitudes.length;

  // 9.8（地球の重力加速度）からの絶対偏差
  return Math.abs(meanMag - 9.8);
}

// T12 (2026-05-09): DeviceMotion 拡大活用
//   ① 急ブレーキ検出: 加速度の長軸 (進行方向) 方向で連続して負の値が出たら急ブレーキ
//      速度クランプを GPS 速度ではなく加速度ベース速度推定で抑える
//   ② GPS gap 区間の慣性航法補間: GPS 圏外時に加速度を時間積分して位置を推定
//      過信防止のため積分時間 5 秒上限・dead reckoning 30m 上限
//   accelSamples: [{ x, y, z, t }, ...] (t=epoch ms)・x: east, y: north, z: up は端末座標系で
//      正確には端末姿勢に依存するが、ここでは |a| ベース近似のみ
const T12_HARD_BRAKE_THRESHOLD = 4.0; // m/s² | a |の正味偏差 (含む水平+垂直成分)
const T12_HARD_BRAKE_MIN_SAMPLES = 3;
const T12_INERTIAL_MAX_GAP_SEC = 5; // 5 秒以内の GPS gap のみ慣性で補間
const T12_INERTIAL_MAX_DRIFT_M = 30; // 慣性推定 30m 超なら信用しない (lat/lng 維持)

// 急ブレーキ検出: 直近 N サンプルの |a|-9.8 が一貫して大きい (= 強い動き)
//   かつ GPS 速度が下降中なら急ブレーキ確度高
function _detectHardBrake(accelSamples, prevSpeedKmh, currSpeedKmh, _now) {
  if (!accelSamples || accelSamples.length < T12_HARD_BRAKE_MIN_SAMPLES) return false;
  const recent = accelSamples.slice(-T12_HARD_BRAKE_MIN_SAMPLES);
  let count = 0;
  for (const s of recent) {
    if (!s) continue;
    const mag = Math.sqrt(s.x * s.x + s.y * s.y + s.z * s.z);
    if (Math.abs(mag - 9.8) > T12_HARD_BRAKE_THRESHOLD) count++;
  }
  // 全 sample が threshold 超 + GPS 速度 -10 km/h 以上の減速 = 急ブレーキ
  if (count >= T12_HARD_BRAKE_MIN_SAMPLES && prevSpeedKmh - currSpeedKmh > 10) {
    return true;
  }
  return false;
}

// 慣性航法による gap 補間: 直前位置 + dt + 加速度積分 → 推定位置
//   limited fallback として位置の微小補正のみ (主体は GPS の Kalman 後座標)
function _inertialGapCorrection(prevPos, accelSamples, currLat, currLng, dt) {
  if (!prevPos || !accelSamples || accelSamples.length === 0) return null;
  if (dt <= 0 || dt > T12_INERTIAL_MAX_GAP_SEC) return null;
  // 直近サンプルの平均水平加速度 (端末座標系の x/y を概略で水平に流用)
  let sx = 0,
    sy = 0,
    n = 0;
  for (const s of accelSamples) {
    if (!s) continue;
    sx += s.x;
    sy += s.y;
    n++;
  }
  if (n === 0) return null;
  const ax = sx / n,
    ay = sy / n;
  // 速度初期値 (前 GPS から求める) + 積分
  const v0 = (prevPos.speedKmh || 0) / 3.6;
  // 進行方向は heading 不明なので簡易に「水平速度方向 = 0」と仮定し
  // ax/ay の二乗平均を水平速度変動として扱う (= drift estimate)
  const aMag = Math.sqrt(ax * ax + ay * ay);
  const driftDist = v0 * dt + 0.5 * aMag * dt * dt;
  if (driftDist > T12_INERTIAL_MAX_DRIFT_M) return null;
  // この関数は「GPS が来ない区間の補間」用だが、本実装では
  // GPS が届いている前提なので driftDist を quality-check として使用するのみ
  return { driftDist: driftDist };
}

// ★Fix① (2026-05-28): 旧 speed ベース静止判定。GPS速度(A3/Doppler)が主信号のため creep を招き、
//   主経路からは外した(= checkPositionStationary + accel 主体に置換)。但し関数自体は
//   単体テスト契約 + 実機検証中の即時 rollback 余地として保持する(= 意図的に未使用)。
// eslint-disable-next-line no-unused-vars
function checkStationary(speedKmh, lat, lng, now) {
  if (isStationary && speedKmh >= CONFIG.resume_speed_kmh) {
    lowSpeedStart = null;
    return false;
  }
  if (speedKmh < CONFIG.speed_limit_kmh) {
    if (!lowSpeedStart) {
      lowSpeedStart = { time: now, lat, lng };
      return isStationary;
    }
    const elapsedSec = (now - lowSpeedStart.time) / 1000;
    const movedM = calcDistance(lowSpeedStart.lat, lowSpeedStart.lng, lat, lng);
    const radius = isTrafficJam ? CONFIG.stationary_radius_jam_m : CONFIG.stationary_radius_m;
    if (elapsedSec >= CONFIG.stationary_sec && movedM < radius) return true;
    return isStationary;
  }
  lowSpeedStart = null;
  return false;
}

// ★Fix① (2026-05-28): 速度に依存しない位置半径のみの静止判定。
//   A3合成速度/Dopplerノイズに左右されず・accel 判定不能(iOS権限拒否等)時の fallback。
//   半径超で move = anchor 再設定し非静止 / 半径内 stationary_sec 継続で静止。
function checkPositionStationary(lat, lng, now) {
  if (!_posStillStart) {
    _posStillStart = { time: now, lat, lng };
    return isStationary;
  }
  const elapsedSec = (now - _posStillStart.time) / 1000;
  const movedM = calcDistance(_posStillStart.lat, _posStillStart.lng, lat, lng);
  const radius = isTrafficJam ? CONFIG.stationary_radius_jam_m : CONFIG.stationary_radius_m;
  if (movedM >= radius) {
    _posStillStart = { time: now, lat, lng }; // 半径超 = 移動 → anchor 再設定し非静止
    return false;
  }
  if (elapsedSec >= CONFIG.stationary_sec) return true; // radius 内で継続 = 静止
  return isStationary;
}

// ─── Vincenty公式（WGS84楕円体） ───
function calcDistance(lat1, lng1, lat2, lng2) {
  if (lat1 === lat2 && lng1 === lng2) return 0;
  const a = 6378137,
    b = 6356752.314245,
    f = 1 / 298.257223563;
  const L = ((lng2 - lng1) * Math.PI) / 180;
  const U1 = Math.atan((1 - f) * Math.tan((lat1 * Math.PI) / 180));
  const U2 = Math.atan((1 - f) * Math.tan((lat2 * Math.PI) / 180));
  const sinU1 = Math.sin(U1),
    cosU1 = Math.cos(U1);
  const sinU2 = Math.sin(U2),
    cosU2 = Math.cos(U2);
  let lambda = L,
    lambdaP,
    iterLimit = 100;
  let sinSigma, cosSigma, sigma, sinAlpha, cosSqAlpha, cos2SigmaM;
  do {
    const sinLambda = Math.sin(lambda),
      cosLambda = Math.cos(lambda);
    sinSigma = Math.sqrt(
      cosU2 * sinLambda * (cosU2 * sinLambda) +
        (cosU1 * sinU2 - sinU1 * cosU2 * cosLambda) * (cosU1 * sinU2 - sinU1 * cosU2 * cosLambda)
    );
    if (sinSigma === 0) return 0;
    cosSigma = sinU1 * sinU2 + cosU1 * cosU2 * cosLambda;
    sigma = Math.atan2(sinSigma, cosSigma);
    sinAlpha = (cosU1 * cosU2 * sinLambda) / sinSigma;
    cosSqAlpha = 1 - sinAlpha * sinAlpha;
    cos2SigmaM = cosSqAlpha === 0 ? 0 : cosSigma - (2 * sinU1 * sinU2) / cosSqAlpha;
    const C = (f / 16) * cosSqAlpha * (4 + f * (4 - 3 * cosSqAlpha));
    lambdaP = lambda;
    lambda =
      L +
      (1 - C) *
        f *
        sinAlpha *
        (sigma + C * sinSigma * (cos2SigmaM + C * cosSigma * (-1 + 2 * cos2SigmaM * cos2SigmaM)));
  } while (Math.abs(lambda - lambdaP) > 1e-12 && --iterLimit > 0);
  if (iterLimit === 0) return haversineDistance(lat1, lng1, lat2, lng2);
  const uSq = (cosSqAlpha * (a * a - b * b)) / (b * b);
  const A = 1 + (uSq / 16384) * (4096 + uSq * (-768 + uSq * (320 - 175 * uSq)));
  const B = (uSq / 1024) * (256 + uSq * (-128 + uSq * (74 - 47 * uSq)));
  const deltaSigma =
    B *
    sinSigma *
    (cos2SigmaM +
      (B / 4) *
        (cosSigma * (-1 + 2 * cos2SigmaM * cos2SigmaM) -
          (B / 6) *
            cos2SigmaM *
            (-3 + 4 * sinSigma * sinSigma) *
            (-3 + 4 * cos2SigmaM * cos2SigmaM)));
  return b * A * (sigma - deltaSigma);
}

function haversineDistance(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const aa =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(aa), Math.sqrt(1 - aa));
}

function _calcDistance3D(lat1, lng1, alt1, lat2, lng2, alt2) {
  const flat = calcDistance(lat1, lng1, lat2, lng2);
  if (alt1 == null || alt2 == null) return flat;
  const altDiff = alt2 - alt1;
  if (Math.abs(altDiff) > 100) return flat;
  return Math.sqrt(flat * flat + altDiff * altDiff);
}

// ─── メイン処理（GPS座標を受け取って計算） ───
function processPosition(data) {
  const {
    lat,
    lng,
    accuracy,
    speedKmh,
    heading,
    altitude,
    now,
    compassHeading,
    accelData,
    accelSamples,
    gyroData,
    gyroSamples,
    speedSrc, // ★STEP0 診断: gps.js が付与 (= 'dop'=Doppler / 'hav'=A3 haversine代用)
  } = data;

  // ① 動的accuracy閾値
  // ★Fix② (2026-05-28): 静止時(直前frame)は base のまま厳格(drift計上しない)・
  //   移動時は base を下限に accuracy_moving_max_m まで緩和(屋内/低速で全reject→凍結→jump を回避)。
  //   isStationary は直前frame の値(本frame判定は後段) = Fix① で信頼できる。安全側=過少。
  const _accLimitBase = getDynamicAccuracyLimit(speedKmh, now);
  const accLimit = isStationary
    ? _accLimitBase
    : Math.max(_accLimitBase, CONFIG.accuracy_moving_max_m);
  if (accuracy > accLimit) {
    _postGpsDbg({
      rej: 'accuracy',
      spd: speedKmh,
      src: speedSrc,
      acc: accuracy,
      lim: accLimit,
      stat: isStationary,
    });
    return null;
  }

  // ② ジャンプ判定
  if (lastPosition) {
    const jump = calcDistance(lastPosition.lat, lastPosition.lng, lat, lng);
    const timeDiff = (now - lastPosition.timestamp) / 1000;
    if (timeDiff > 0 && jump / timeDiff > CONFIG.jump_limit_m_per_s) {
      _postGpsDbg({
        rej: 'jump',
        spd: speedKmh,
        src: speedSrc,
        acc: accuracy,
        lim: accLimit,
        stat: isStationary,
      });
      return null;
    }
  }

  // ②-1 Doppler-Speed Sanity Gate (= Phase A-4・2026-05-26):
  //   Doppler 速度 (= 衛星受信機 GPS chip 由来・gps.js L456 で speedKmh に変換) と
  //   haversine 速度 (= 直線距離 / 経過時間) の整合性検証。
  //   speedKmh <= 0 (= speed null fallback in gps.js L456) または dtSec >= 5 は skip。
  //   |dopplerMs - haverMs| > 10 m/s (= 36 km/h 差) で異常 GPS 点と判定し reject。
  //   絶対ルール準拠: distance_m 加算 5 経路 / calcFare / Worker B: 1byte 不変。
  //   後退検出 (= Phase A-3) との整合: 後退中 Doppler は符号なし・絶対値で出力されるため
  //   haversine と同等値・diff < 10 m/s で通過 (= 後退距離加算は維持される)。
  if (lastPosition && speedKmh > 0) {
    const dtSec = (now - lastPosition.timestamp) / 1000;
    if (dtSec > 0 && dtSec < 5) {
      const haverDist = calcDistance(lastPosition.lat, lastPosition.lng, lat, lng);
      const haverMs = haverDist / dtSec;
      const dopplerMs = speedKmh / 3.6;
      const speedDiff = Math.abs(dopplerMs - haverMs);
      if (speedDiff > 10) {
        wlog('[GPS] Doppler-haversine 速度不整合 skip: diff=' + speedDiff.toFixed(1) + 'm/s');
        _postGpsDbg({
          rej: 'doppler',
          spd: speedKmh,
          src: speedSrc,
          acc: accuracy,
          lim: accLimit,
          stat: isStationary,
        });
        return null;
      }
    }
  }

  // ②-2 加速度異常判定（案Z）
  if (lastPosition && lastPosition.speedKmh != null && lastPosition.speedKmh > 1 && speedKmh > 1) {
    const dt = (now - lastPosition.timestamp) / 1000;
    if (dt > 0 && dt < 5) {
      const dvMs = (speedKmh - lastPosition.speedKmh) / 3.6;
      const acceleration = dvMs / dt;
      if (Math.abs(acceleration) > CONFIG.max_acceleration_ms2) {
        wlog('[GPS] 加速度異常: ' + acceleration.toFixed(1) + 'm/s²・スキップ');
        _postGpsDbg({
          rej: 'accel',
          spd: speedKmh,
          src: speedSrc,
          acc: accuracy,
          lim: accLimit,
          stat: isStationary,
        });
        return null;
      }
    }
  }

  // ②-3 進行方向整合性（案U + コンパス融合）
  // GPS headingより精度の高いコンパスheadingを優先使用
  const effectiveHeading = compassHeading != null ? compassHeading : heading;
  if (
    lastPosition &&
    effectiveHeading != null &&
    effectiveHeading >= 0 &&
    speedKmh >= CONFIG.heading_check_min_speed_kmh
  ) {
    const movedDistance = calcDistance(lastPosition.lat, lastPosition.lng, lat, lng);
    if (movedDistance >= CONFIG.heading_check_min_distance_m) {
      const movementBearing = calcBearing(lastPosition.lat, lastPosition.lng, lat, lng);
      const diff = angleDiff(effectiveHeading, movementBearing);
      // ★設計変更宣言 Phase A-3 (2026-05-26・後退検出・タクシーメーター標準準拠):
      //   後退駐車中 (= diff ≈ 180°・低速 0.5〜10 km/h) は・GPS 点を・reject せず採用。
      //   後退距離は・既存 Worker B route distance / Off-Road retroactive で・distance_m に正常加算。
      //   高速時 (= speedKmh >= 10) で・diff ≈ 180° は・「真の異常 GPS」 (= multipath 等) と・判定し reject 維持。
      //   絶対ルール準拠:
      //     ・calcFare / distance_m 加算 5 経路: 1 byte 不変 (= 既存救済機構で距離反映)
      //     ・Worker B: 1 byte 不変
      //     ・既存コンパス融合 Q (= L558-573) は・isReverse 時も・matchRatio 負値で Q 大 (= GPS 信頼) と・妥当動作
      //   誤検出リスク:
      //     ・スマホ逆向き設置 + 低速走行のみ・誤加算量 数 m (= 低速時・許容)
      const isReverse = Math.abs(diff - 180) < 30 && speedKmh >= 0.5 && speedKmh < 10;
      if (!isReverse && diff > CONFIG.heading_diff_threshold_deg) {
        wlog(
          '[GPS] 方向不整合: ' +
            diff.toFixed(0) +
            '°・スキップ' +
            (compassHeading != null ? '（コンパス）' : '（GPS）')
        );
        _postGpsDbg({
          rej: 'heading',
          spd: speedKmh,
          src: speedSrc,
          acc: accuracy,
          lim: accLimit,
          stat: isStationary,
        });
        return null;
      }
      if (isReverse) {
        wlog(
          '[GPS] 後退検出: diff=' +
            diff.toFixed(0) +
            '° speed=' +
            speedKmh.toFixed(1) +
            'km/h・GPS 点採用 (= 後退距離加算)'
        );
      }
      // コンパスとGPS移動方向の一致度でKalman_Qを動的調整
      // 一致（diff小）→ Q小さく（より強くフィルター・ノイズ除去）
      // 不一致（diff大）→ Q大きく（GPS座標をより信頼）
      if (compassHeading != null) {
        const matchRatio = 1 - diff / CONFIG.heading_diff_threshold_deg; // 0〜1
        // T5: ベース Q を typeCode 連動の動的値にし、コンパス融合は乗算で適用
        const baseQ = _getDynamicBaseQ();
        CONFIG._kalman_Q_override = baseQ * (0.5 + 0.5 * (1 - matchRatio));
        CONFIG._compassDebug =
          'コンパス融合: 方向差' +
          diff.toFixed(0) +
          '° baseQ=' +
          baseQ.toFixed(1) +
          ' Q=' +
          CONFIG._kalman_Q_override.toFixed(1) +
          ' typeCode=' +
          (_currentTypeCode != null ? _currentTypeCode : '?');
        wlog('[GPS] ' + CONFIG._compassDebug);
      }
    }
  }

  // ③ 渋滞モード
  checkTrafficJam(speedKmh, now);

  // ④ Kalmanフィルター（コンパス融合Q値で更新）
  // Phase 1.ZUPT (2026-05-10): 直前 frame の isStationary 判定を carry
  //   今 frame の Kalman に ZUPT (Q ≈ 0) を適用して GPS noise 由来 drift を抑制
  //   停車終了で自動的に通常 Q に復帰
  kalman.setZuptActive(_isStationaryLast);
  const filtered = kalman.update(lat, lng, accuracy, now, CONFIG._kalman_Q_override);
  CONFIG._kalman_Q_override = null; // 使い捨て

  // ⑤ 静止判定（★Fix① 2026-05-28・★設計変更宣言★：加速度variance主体に作り直し）
  //   旧: finalStationary = gpsStationary && c1Stationary && !c2Moving (3点AND)。
  //       gpsStationary = checkStationary(speedKmh,...) が GPS速度<3 を必須としたため、
  //       A3合成速度/Dopplerノイズの偽速度(観測 3.1km/h)で gpsStationary=false に落ち、
  //       accel が「静止」と言っても 3点AND が非静止 → 空車中 drift を計上(creep)。
  //   新: GPS速度(A3/Doppler)を静止判定の主信号にしない。
  //       (a) 高速(>=stationary_moving_speed_kmh)は確実に移動 → 静止解除(定速走行 under-count防止)
  //       (b) 低速域は accel(物理的な動き)を主信号: C-1静止 かつ C-2動きなし → 静止
  //       (c) accel 判定不能(iOS権限拒否等)は位置半径のみ(checkPositionStationary)に fallback
  //           (= A3速度ではなく位置で判定)
  //   安全側=過少(過大課金NG): accel が「静止」と言えば停止扱い(drift を計上しない)。
  const accelVariance = calcAccelVariance(accelSamples, now);
  const accelDeviation = calcAccelMagnitudeDeviation(accelSamples, now);
  // 位置半径のみの静止判定 (速度非依存・accel不能時 fallback / 診断比較用・毎frame維持)
  const posStationary = checkPositionStationary(filtered.lat, filtered.lng, now);

  // ★Fix① v2 (2026-05-28・dwell time 業界標準準拠):
  //   speedKmh >= stationary_moving_speed_kmh を ★連続 high_speed_dwell_steps step★ 観測した時のみ
  //   高速ガード発火。1 step の偽速度 spike (= A3 drift 由来) は dwell 未達で accel 判定に落とし
  //   creep を遮断。Linux CI run 26553931113 で spd=11.68km/h 1 step spike が backstop を defeat した
  //   事象 → 本 dwell time で遮断。ArduPilot EKF_GLITCH_RAD「persistent then accept」と整合。
  let highSpeedFire = false;
  if (speedKmh >= CONFIG.stationary_moving_speed_kmh) {
    _highSpeedConsecCount++;
    if (_highSpeedConsecCount >= CONFIG.high_speed_dwell_steps) {
      highSpeedFire = true;
    }
  } else {
    _highSpeedConsecCount = 0;
  }

  let finalStationary;
  if (highSpeedFire) {
    // (a) ★連続 N step★ で高速 → 確実に移動 (drift spike では達しない) → 計上
    finalStationary = false;
  } else if (accelVariance === null && accelDeviation === null) {
    // (c) 加速度判定不能 → 位置半径のみ (A3/Doppler 速度に依存しない fallback)
    finalStationary = posStationary;
  } else {
    // (b) accel 主体: C-1（分散小=静止）かつ NOT C-2（合算ベクトル大=動き）→ 物理的に静止
    const c1Stationary = accelVariance === null || accelVariance < CONFIG.accel_variance_threshold;
    const c2Moving = accelDeviation !== null && accelDeviation > CONFIG.accel_motion_threshold;

    // チューニング用ログ：accel 主体判定と位置半径判定が食い違う時のみ出力
    if ((c1Stationary && !c2Moving) !== posStationary) {
      wlog(
        '[C-1+C-2] 判定不一致 pos=' +
          posStationary +
          ' C1=' +
          c1Stationary +
          ' C2_moving=' +
          c2Moving +
          ' var=' +
          (accelVariance != null ? accelVariance.toFixed(3) : 'null') +
          ' dev=' +
          (accelDeviation != null ? accelDeviation.toFixed(3) : 'null') +
          ' speed=' +
          speedKmh.toFixed(1) +
          'km/h'
      );
    }

    // ★accel が物理的静止を示せば停止扱い (GPS速度は参照しない = A3/Doppler 偽速度を無視)
    finalStationary = c1Stationary && !c2Moving;
  }
  isStationary = finalStationary;
  // Phase 1.ZUPT (2026-05-10): 次 frame の Kalman 用に判定を carry
  _isStationaryLast = finalStationary;

  // T12 (2026-05-09): 急ブレーキ検出 → 速度クランプを強化
  //   速度誤検出 (GPS spike) を抑え、急ブレーキ後の異常な高速度報告をフィルタ
  let hardBrake = false;
  let clampedSpeedKmh = speedKmh;
  if (lastPosition) {
    hardBrake = _detectHardBrake(accelSamples, lastPosition.speedKmh, speedKmh, now);
    if (hardBrake) {
      // 急ブレーキ時は GPS 速度の上振れをクランプ (前 GPS 速度 ÷ 1.2 を上限)
      const cap = Math.max(5, lastPosition.speedKmh / 1.2);
      if (speedKmh > cap) {
        clampedSpeedKmh = cap;
        wlog('[T12] hardBrake clamp: ' + speedKmh.toFixed(1) + ' → ' + cap.toFixed(1) + ' km/h');
      }
    }
  }
  // T12: GPS gap 区間の慣性航法 quality check (大きな drift 推定なら GPS 信用度を下げる)
  let inertialDriftHint = null;
  if (lastPosition) {
    const dt = (now - lastPosition.timestamp) / 1000;
    if (dt > 1 && dt <= T12_INERTIAL_MAX_GAP_SEC) {
      const inertial = _inertialGapCorrection(
        lastPosition,
        accelSamples,
        filtered.lat,
        filtered.lng,
        dt
      );
      if (inertial) inertialDriftHint = inertial.driftDist;
    }
  }

  lastPosition = {
    lat: filtered.lat,
    lng: filtered.lng,
    timestamp: now,
    speedKmh: clampedSpeedKmh,
    altitude,
  };

  // ★STEP0 診断: accept 時の最終値 (speedKmh源/isStationary/accuracy/accLimit) を出力
  _postGpsDbg({
    rej: null,
    spd: clampedSpeedKmh,
    src: speedSrc,
    acc: accuracy,
    lim: accLimit,
    stat: isStationary,
  });
  // 2026-05-09 (P4/P5): cellularLayerHint / accelLayerHint 廃止
  //   layer (v6 attribute) + tunnels-/bridges-{pref}.js データで完全代替
  return {
    lat: filtered.lat,
    lng: filtered.lng,
    altitude,
    accuracy,
    speedKmh: clampedSpeedKmh,
    isStationary,
    timestamp: now,
    compassHeading: compassHeading != null ? compassHeading : null,
    _debugCompass: compassHeading != null && CONFIG._compassDebug ? CONFIG._compassDebug : null,
    accelData: accelData || null,
    accelSampleCount: accelSamples ? accelSamples.length : 0,
    gyroData: gyroData || null,
    gyroSampleCount: gyroSamples ? gyroSamples.length : 0,
    // T12 (2026-05-09): diagnostic - 急ブレーキ / 慣性 drift
    hardBrake: hardBrake,
    inertialDriftHint: inertialDriftHint,
  };
}

// ─── メッセージ受信 ───
self.onmessage = function (e) {
  const { type, data } = e.data;

  if (type === 'init') {
    // 初期化：CONFIGとdebugフラグを受け取る
    if (data.config) CONFIG = Object.assign(CONFIG, data.config);
    if (data.debug !== undefined) debug = data.debug;
    kalman = new KalmanGPS();
    lastPosition = null;
    lowSpeedStart = null;
    _posStillStart = null; // ★Fix① (2026-05-28): 位置半径 anchor リセット
    _highSpeedConsecCount = 0; // ★Fix① v2 (2026-05-28): 高速ガード dwell time カウンタリセット
    isStationary = false;
    trafficJamSince = null;
    isTrafficJam = false;
    _isStationaryLast = false; // Phase 1.ZUPT: ZUPT carry リセット
    // 2026-05-09 (P4): cellular polling 廃止
    wlog('[Worker] 初期化完了');
    return;
  }

  if (type === 'reset') {
    // stop()時にリセット
    if (kalman) kalman.reset();
    lastPosition = null;
    lowSpeedStart = null;
    _posStillStart = null; // ★Fix① (2026-05-28): 位置半径 anchor リセット
    _highSpeedConsecCount = 0; // ★Fix① v2 (2026-05-28): 高速ガード dwell time カウンタリセット
    isStationary = false;
    trafficJamSince = null;
    isTrafficJam = false;
    _currentTypeCode = null; // T5: typeCode もリセット
    _isStationaryLast = false; // Phase 1.ZUPT: ZUPT carry リセット
    return;
  }

  // T5 (2026-05-09): main 経由で map-matcher の commit typeCode を受信
  //   _currentTypeCode に保持し、次回以降の Kalman 更新で動的 Q を選択
  if (type === 'setRoadType') {
    if (data && typeof data.typeCode === 'number') {
      _currentTypeCode = data.typeCode;
    } else if (data && data.typeCode == null) {
      _currentTypeCode = null;
    }
    return;
  }

  if (type === 'position') {
    // GPS座標を受け取って計算
    const result = processPosition(data);
    if (result === null) return; // スキップ
    self.postMessage({ type: 'result', data: result });
  }
};
