// Firebase読み書き・オフライン対応
const FB = (() => {
  let vehicleId = 'v1';
  let sessionId = null;
  let offlineQueue = [];
  let isOnline = true;
  let _db = null;

  // db取得（遅延初期化）
  function getDb(){
    if(!_db){
      try { _db = firebase.database(); } catch(e){ console.error('DB init error:', e); }
    }
    return _db;
  }

  window.addEventListener('online',  () => { isOnline = true; flushQueue(); });
  window.addEventListener('offline', () => { isOnline = false; });

  function setVehicleId(id){ vehicleId = id; }

  function generateSessionId(){
    sessionId = 'session_' + Date.now() + '_' + vehicleId;
    return sessionId;
  }

  function updateVehicle(data){
    const db = getDb(); if(!db) return;
    if(!vehicleId) return;
    const payload = { ...data, updated_at: Date.now() };
    if(isOnline){
      db.ref('vehicles/' + vehicleId).update(payload).catch(e => {
        console.error('[FB] 書き込みエラー:', e);
        offlineQueue.push(payload);
      });
    } else {
      offlineQueue.push(payload);
    }
  }

  function flushQueue(){
    const db = getDb(); if(!db) return;
    if(offlineQueue.length === 0) return;
    const q = [...offlineQueue];
    offlineQueue = [];
    q.forEach(data => {
      db.ref('vehicles/' + vehicleId).update(data).catch(e => { offlineQueue.push(data); });
    });
  }

  function startSession(fareConfigSnapshot){
    const db = getDb(); if(!db || !vehicleId) return;
    sessionId = generateSessionId();
    db.ref('sessions_log/' + sessionId).set({
      vehicle_id: vehicleId,
      start_time: Date.now(),
      end_time: null,
      trip_distance_m: 0,
      total_fare_yen: 0,
      fare_config_snapshot: fareConfigSnapshot,
      status: 'driving'
    });
    db.ref('vehicles/' + vehicleId).update({ status: 'driving' });
  }

  function endSession(finalState){
    const db = getDb(); if(!db || !vehicleId || !sessionId) return;
    db.ref('sessions_log/' + sessionId).update({
      end_time: Date.now(),
      trip_distance_m: Math.round(finalState.distance_m),
      total_fare_yen: finalState.fare_yen,
      status: 'finished'
    });
    db.ref('vehicles/' + vehicleId).update({
      status: 'finished',
      'session/distance_m': Math.round(finalState.distance_m),
      'session/fare_yen': finalState.fare_yen,
    });
  }

  function setIdle(){
    const db = getDb(); if(!db || !vehicleId) return;
    db.ref('vehicles/' + vehicleId).update({
      status: 'idle',
      session: { distance_m: 0, fare_yen: 0, elapsed_sec: 0 }
    });
  }

  // ★設計変更宣言 (2026-05-10): fareConfig v2 migration
  //   旧形式 (version 不在) を v2 化して callback に渡す
  //   surchargeRate (旧単一倍率) は surcharges[0] として保持
  //   破壊的変更なし・旧キーは維持
  function _migrateFareConfig(cfg){
    if(!cfg || cfg.version === 2) return cfg;
    const out = Object.assign({}, cfg);
    out.version = 2;
    if(!Array.isArray(out.tiers)) out.tiers = [];
    if(!Array.isArray(out.surcharges)){
      out.surcharges = [];
      const r = parseFloat(cfg.surchargeRate);
      if(!isNaN(r) && r > 1.0){
        out.surcharges.push({
          id: 'legacy',
          name: '割増',
          rate: r,
          color: '#FF9500',
          active_default: false,
        });
      }
    }
    if(typeof out.minFare === 'undefined') out.minFare = null;
    if(typeof out.maxFare === 'undefined') out.maxFare = null;
    if(typeof out.rounding !== 'number') out.rounding = 10;
    if(!out.autoSurcharges){
      out.autoSurcharges = {
        night:    { enabled: false, from: 22, to: 5,  rate: 1.2 },
        weekend:  { enabled: false, rate: 1.1 },
        winter:   { enabled: false, from: '12-15', to: '03-15', rate: 1.1 },
      };
    }
    if(!Array.isArray(out.vehicles)) out.vehicles = [];
    if(typeof out.vehiclesEnabled !== 'boolean') out.vehiclesEnabled = false;
    if(!out.wait) out.wait = { enabled: false, freeMins: 5, ratePerMin: 100 };
    return out;
  }

  function loadFareConfig(callback){
    const db = getDb(); if(!db){ return; }
    db.ref('fare_config/default').once('value').then(snap => {
      const raw = snap.val();
      if(!raw) return;
      const config = _migrateFareConfig(raw);
      callback(config);
      // migration が走った場合は書き戻す (raw === config なら no-op)
      if(raw.version !== 2){
        try { db.ref('fare_config/default').set(config); } catch(e){}
      }
    }).catch(e => console.error('[FB] loadFareConfig error:', e));
  }

  function saveFareConfig(config){
    const db = getDb(); if(!db) return;
    db.ref('fare_config/default').set(config);
  }

  function watchVehicle(vid, callback){
    const db = getDb(); if(!db) return;
    db.ref('vehicles/' + vid).on('value', snap => { callback(snap.val()); });
  }

  // T8 (2026-05-09): Cross-user Pheromone via Firebase RDB
  //   pref ごとに「全ドライバ走行頻度」を集約・読み出し
  //   path: pheromone/{pref}/{roadIndex} = count (number)
  //   ・ markVisited(pref, roadIndex): セッション中に snap した road を 1 回だけ集約 (重複防止)
  //   ・ pushSessionAggregates(): セッション内で集計したカウントを transaction で +1 加算
  //   ・ subscribeCrossUserPheromone(pref, callback): 全ドライバの走行頻度を購読 → callback で渡す
  //   オフライン / 未接続時は localQueue に積まれ flushQueue で再送
  const _sessionVisited = new Map();    // pref → Set(roadIndex) - 当 session で +1 済の road
  function markVisited(pref, roadIndex){
    if(!pref || roadIndex == null) return;
    let set = _sessionVisited.get(pref);
    if(!set){ set = new Set(); _sessionVisited.set(pref, set); }
    set.add(roadIndex);
  }
  function pushSessionAggregates(){
    const db = getDb(); if(!db) return;
    if(!isOnline) return;        // オフライン時は次回オンラインで flush
    for(const [pref, set] of _sessionVisited){
      for(const roadIndex of set){
        // RTDB transaction でアトミック +1
        db.ref('pheromone/' + pref + '/' + roadIndex)
          .transaction(curr => (curr || 0) + 1)
          .catch(e => console.error('[FB] pheromone+1 error:', e));
      }
    }
    _sessionVisited.clear();
  }
  function subscribeCrossUserPheromone(pref, callback){
    const db = getDb(); if(!db) return null;
    const ref = db.ref('pheromone/' + pref);
    const handler = ref.on('value', snap => {
      const obj = snap.val() || {};
      const list = [];
      for(const k in obj){
        const idx = parseInt(k, 10);
        if(!isNaN(idx)) list.push({ roadIndex: idx, count: obj[k] | 0 });
      }
      callback(list);
    });
    return function unsubscribe(){ ref.off('value', handler); };
  }

  // Phase 3 (2026-05-10): 設定画面「過去データを削除」ボタン用
  //   training-data/{deviceId}/* の全ファイルを Firebase Storage から削除
  //   listAll() で全 ref 取得 → 各 ref delete を Promise.all で並列実行
  function deleteAllTrainingData(deviceId) {
    return new Promise(function(resolve, reject) {
      if (typeof firebase === 'undefined' || !firebase.storage) {
        return reject(new Error('Firebase Storage not initialized'));
      }
      if (!deviceId) {
        return reject(new Error('deviceId required'));
      }
      try {
        const folder = firebase.storage().ref('training-data/' + deviceId);
        folder.listAll().then(function(result) {
          const promises = (result.items || []).map(function(item) {
            return item.delete().catch(function() {});
          });
          Promise.all(promises).then(function() {
            resolve({ deleted: promises.length });
          }).catch(reject);
        }).catch(function(err) {
          // 該当 folder が空 (= 過去送信なし) は成功扱い
          if (err && err.code === 'storage/object-not-found') {
            return resolve({ deleted: 0 });
          }
          reject(err);
        });
      } catch (e) {
        reject(e);
      }
    });
  }

  // Phase 2.B (2026-05-10): training-uploader 用 Cloud Storage upload
  //   path: training-data/{deviceId}/{date}-{firstId}.json[.gz]
  //   blob: gzip 済 (CompressionStream) または raw JSON
  //   失敗時は reject・上位 (training-uploader) で retry queue 管理
  function uploadTrainingBatch(path, blob) {
    return new Promise(function(resolve, reject) {
      if (typeof firebase === 'undefined' || !firebase.storage) {
        return reject(new Error('Firebase Storage not initialized'));
      }
      if (!isOnline) {
        return reject(new Error('offline'));
      }
      try {
        const ref = firebase.storage().ref(path);
        const metadata = { contentType: blob.type || 'application/octet-stream' };
        const task = ref.put(blob, metadata);
        task.on('state_changed',
          null,
          function(err) { reject(err); },
          function() { resolve({ path: path, size: blob.size }); }
        );
      } catch (e) {
        reject(e);
      }
    });
  }

  return {
    setVehicleId, updateVehicle, startSession, endSession,
    setIdle, loadFareConfig, saveFareConfig, watchVehicle,
    // T8 (2026-05-09)
    markVisited, pushSessionAggregates, subscribeCrossUserPheromone,
    // Phase 2.B (2026-05-10)
    uploadTrainingBatch,
    // Phase 3 (2026-05-10)
    deleteAllTrainingData,
  };
})();
