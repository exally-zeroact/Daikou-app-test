// ============================================================
// mm-data-pipeline.js (2026-05-13 新規)
// ★設計変更宣言: 起動時の段階的データロード制御
//   ダイコメ設計思想「全 47 県データを内包・どこでも即起動」を実現
//
// 段階:
//   Phase A: 全国共通データ (20 件) ロード (worker / main 振り分け)
//   Phase B: 47 県 roads データロード (worker・並列度 4)
//   Phase C: 47 県補助データ (tunnels / bridges / attrs 等) ロード (main・並列度 4)
//   Phase D: GPS 初回 fix 待ち (timeout 30 秒)
//   Phase E: MM warmup (worker から mmResult.committed=1 待ち・timeout 10 秒)
//
// API:
//   const pipeline = new MMDataPipeline({ worker, loader, onProgress });
//   await pipeline.warmup();
//   pipeline.ready の各フラグで状態確認
//
// 依存:
//   - window.DataLoader (data-loader.js)
//   - window.DataRegistry (data-registry.js)
//   - worker (map-matcher.js Worker instance)
// ============================================================

(function(global){
  'use strict';

  const DEFAULT_CONCURRENCY = 4;
  const GPS_TIMEOUT_MS = 30000;
  const MM_WARMUP_TIMEOUT_MS = 10000;

  class MMDataPipeline {
    constructor(opts){
      this.worker = (opts && opts.worker) || null;
      this.loader = (opts && opts.loader) || (global.DataLoader);
      this.onProgress = (opts && opts.onProgress) || null;
      this.ready = {
        globalLoaded: false,
        roadsLoaded: false,
        auxLoaded: false,
        gpsAcquired: false,
        mmWarmed: false,
      };
      this.stats = {
        globalOk: 0, globalFailed: [],
        roadsOk: 0,  roadsFailed: [],
        auxOk: 0,    auxFailed: [],
      };
      this._gpsResolver = null;
      this._mmResolver = null;
      this._loadedWorkerPrefs = new Set();   // roadsLoaded 受信 pref 記録用
    }

    _emit(phase, current, total, label){
      if(typeof this.onProgress === 'function'){
        try { this.onProgress({ phase, current, total, label }); } catch(_){}
      }
    }

    async _loadOne(entry, isOptional){
      try {
        const data = await this.loader.loadFromCache(entry.url);
        const value = data[entry.globalKey];
        if(!value){
          if(typeof dlog === 'function'){
            dlog('[Pipeline] ' + entry.url + ' 変数 ' + entry.globalKey + ' 未設定');
          }
          if(!isOptional) return { ok: false, entry: entry, reason: 'no global var' };
          return { ok: true, entry: entry, skipped: true };
        }
        if(entry.target === 'worker'){
          if(!this.worker){
            return { ok: false, entry: entry, reason: 'worker not ready' };
          }
          if(entry.handler === 'loadRoadsBundle'){
            // roads は roadsData / pois / conditionalRestrictions に分割送信
            this.worker.postMessage({ type: 'loadRoads', pref: entry.pref, roadsData: value });
            if(Array.isArray(value.pois) && value.pois.length > 0){
              this.worker.postMessage({ type: 'loadPois', pref: entry.pref, points: value.pois });
            }
            if(Array.isArray(value.conditionalRestrictions) && value.conditionalRestrictions.length > 0){
              this.worker.postMessage({
                type: 'loadConditionalRestrictions',
                pref: entry.pref,
                list: value.conditionalRestrictions,
              });
            }
          } else if(entry.msgType){
            this.worker.postMessage({ type: entry.msgType, data: value });
          }
        } else if(entry.target === 'main'){
          // main 側で findNearest 等が読む既存 window グローバルへ
          global[entry.globalKey] = value;
        }
        return { ok: true, entry: entry };
      } catch(e){
        if(typeof dlog === 'function'){
          dlog('[Pipeline] ' + entry.url + ' エラー: ' + (e && e.message));
        }
        return { ok: false, entry: entry, reason: e && e.message };
      }
    }

    async _loadParallel(entries, concurrency, phase){
      const total = entries.length;
      const queue = entries.slice();
      let done = 0;
      const results = [];
      const workers = [];
      for(let i = 0; i < concurrency; i++){
        workers.push((async () => {
          while(queue.length > 0){
            const e = queue.shift();
            const r = await this._loadOne(e, !!e.optional);
            results.push(r);
            done++;
            this._emit(phase, done, total, e.url);
          }
        })());
      }
      await Promise.all(workers);
      return results;
    }

    async loadGlobalData(){
      const entries = global.DataRegistry.DATA_REGISTRY.global;
      const results = await this._loadParallel(entries, DEFAULT_CONCURRENCY, 'global');
      for(const r of results){
        if(r.ok && !r.skipped) this.stats.globalOk++;
        else if(!r.ok) this.stats.globalFailed.push(r.entry.url);
      }
      this.ready.globalLoaded = true;
    }

    async loadRoadsData(){
      const def = global.DataRegistry.DATA_REGISTRY.perPref.find(d => d.kind === 'roads');
      if(!def) return;
      const entries = global.DataRegistry.expandPerPref(def);
      const results = await this._loadParallel(entries, DEFAULT_CONCURRENCY, 'roads');
      for(const r of results){
        if(r.ok) this.stats.roadsOk++;
        else this.stats.roadsFailed.push(r.entry.url);
      }
      this.ready.roadsLoaded = true;
    }

    async loadAuxData(){
      const auxKinds = ['tunnels','bridges','road-attrs','road-flood','road-jizen','road-yobo'];
      for(const kind of auxKinds){
        const def = global.DataRegistry.DATA_REGISTRY.perPref.find(d => d.kind === kind);
        if(!def) continue;
        const entries = global.DataRegistry.expandPerPref(def);
        const results = await this._loadParallel(entries, DEFAULT_CONCURRENCY, 'aux-' + kind);
        for(const r of results){
          if(r.ok) this.stats.auxOk++;
          else this.stats.auxFailed.push(r.entry.url);
        }
      }
      this.ready.auxLoaded = true;
    }

    // GPS 初回 fix 待ち (外部から notifyGpsFix() で resolve される)
    async waitForGPS(timeoutMs){
      if(this.ready.gpsAcquired) return;
      return new Promise((resolve) => {
        this._gpsResolver = resolve;
        const t = setTimeout(() => {
          if(this._gpsResolver){
            this._gpsResolver = null;
            if(typeof dlog === 'function') dlog('[Pipeline] GPS timeout');
            resolve();   // タイムアウトでも resolve (後追い)
          }
        }, timeoutMs || GPS_TIMEOUT_MS);
        // resolve 時に clear するため保持
        this._gpsTimer = t;
      });
    }
    notifyGpsFix(){
      this.ready.gpsAcquired = true;
      if(this._gpsResolver){
        const r = this._gpsResolver;
        this._gpsResolver = null;
        if(this._gpsTimer) clearTimeout(this._gpsTimer);
        r();
      }
    }

    // MM warmup (worker から mmResult.committed=1 を 1 回受信で resolve)
    async waitForMMWarmup(timeoutMs){
      if(this.ready.mmWarmed) return;
      return new Promise((resolve) => {
        this._mmResolver = resolve;
        const t = setTimeout(() => {
          if(this._mmResolver){
            this._mmResolver = null;
            if(typeof dlog === 'function') dlog('[Pipeline] MM warmup timeout');
            resolve();   // タイムアウトでも resolve
          }
        }, timeoutMs || MM_WARMUP_TIMEOUT_MS);
        this._mmTimer = t;
      });
    }
    notifyMMCommit(){
      this.ready.mmWarmed = true;
      if(this._mmResolver){
        const r = this._mmResolver;
        this._mmResolver = null;
        if(this._mmTimer) clearTimeout(this._mmTimer);
        r();
      }
    }

    async warmup(){
      const t0 = Date.now();
      if(typeof dlog === 'function') dlog('[Pipeline] warmup 開始');
      // Phase A: 全国共通
      await this.loadGlobalData();
      if(typeof dlog === 'function'){
        dlog('[Pipeline] Phase A 完了 ok=' + this.stats.globalOk +
             ' failed=' + this.stats.globalFailed.length);
      }
      // Phase B: 47 県 roads
      await this.loadRoadsData();
      if(typeof dlog === 'function'){
        dlog('[Pipeline] Phase B 完了 ok=' + this.stats.roadsOk +
             ' failed=' + this.stats.roadsFailed.length);
      }
      // ★設計変更宣言 (2026-05-13): Phase C を fire-and-forget で background 実行
      //   旧: await this.loadAuxData() で完了まで待機 (~14 秒のボトルネック)
      //   新: 起動時の warmup を 14 秒短縮・aux データは bg で順次完了
      //   失う機能: 業務開始直後の数秒間、findNearestTunnel/Bridge と
      //            道路属性警告 (school zone / flood 等) が無効
      //   絶対ルール準拠: MM 主機能 (Phase B roads) は同期完了済・道路距離課金担保
      this.loadAuxData().then(function(){
        if(typeof dlog === 'function'){
          dlog('[Pipeline] Phase C 完了 (bg) ok=' + this.stats.auxOk +
               ' failed=' + this.stats.auxFailed.length);
        }
      }.bind(this)).catch(function(e){
        if(typeof dlog === 'function'){
          dlog('[Pipeline] Phase C bg エラー: ' + (e && e.message));
        }
      });
      // Phase D: GPS
      await this.waitForGPS();
      if(typeof dlog === 'function') dlog('[Pipeline] Phase D 完了');
      // Phase E: MM warmup
      await this.waitForMMWarmup();
      if(typeof dlog === 'function') dlog('[Pipeline] Phase E 完了');
      const dur = Date.now() - t0;
      if(typeof dlog === 'function') dlog('[Pipeline] warmup 完了: ' + dur + 'ms');
    }
  }

  global.MMDataPipeline = MMDataPipeline;
})(typeof window !== 'undefined' ? window
   : typeof self !== 'undefined' ? self
   : typeof globalThis !== 'undefined' ? globalThis
   : this);
