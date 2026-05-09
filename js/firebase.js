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

  function loadFareConfig(callback){
    const db = getDb(); if(!db){ return; }
    db.ref('fare_config/default').once('value').then(snap => {
      const config = snap.val();
      if(config) callback(config);
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

  return {
    setVehicleId, updateVehicle, startSession, endSession,
    setIdle, loadFareConfig, saveFareConfig, watchVehicle,
    // T8 (2026-05-09)
    markVisited, pushSessionAggregates, subscribeCrossUserPheromone,
  };
})();
