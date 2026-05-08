// ============================================================
// road-graph-loader.js
// MM-4b (2026-05-08): data/road-graph-{pref}.js を遅延ロードし
// Worker B（map-matcher.js）に転送するための main thread 側ローダー
//
// 設計:
//   - activeRegion（ユーザー選択県）単位で lazy-load
//   - 既存 RegionLoader.loadRoadFile と同等のパターン（重複ロード防止）
//   - ロード結果は window.ROAD_GRAPH_<PREF> として global に置かれる
//   - 公開 API: loadGraphFile(pref) / ensureLoaded(prefs) / getStats()
//   - 転送は index.html の _forwardRoadGraphToMmWorker(prefs) 経由
// ============================================================

const RoadGraphLoader = (() => {
  const loaded = new Set();
  const loading = new Map();

  function _varName(pref){
    return 'ROAD_GRAPH_' + String(pref).toUpperCase().replace(/-/g, '_');
  }

  function loadGraphFile(pref){
    if(!pref) return Promise.resolve(null);
    if(loaded.has(pref)){
      return Promise.resolve(window[_varName(pref)] || null);
    }
    if(loading.has(pref)) return loading.get(pref);

    const promise = new Promise((resolve) => {
      const script = document.createElement('script');
      script.src = 'data/road-graph-' + pref + '.js';
      script.async = true;
      script.onload = () => {
        const data = window[_varName(pref)];
        if(data){
          loaded.add(pref);
          if(typeof dlog === 'function'){
            dlog('[RoadGraph] loaded ' + pref +
                 ' nodes=' + data.numNodes +
                 ' edges=' + data.numEdges +
                 ' shortcuts=' + data.numShortcuts);
          }
          resolve(data);
        } else {
          if(typeof dlog === 'function'){
            dlog('[RoadGraph] ' + pref + ' loaded but global not set');
          }
          resolve(null);
        }
        loading.delete(pref);
      };
      script.onerror = () => {
        // road-graph-{pref}.js が未ビルドの県は 404 になる（正常・MM はフォールバック動作）
        if(typeof dlog === 'function'){
          dlog('[RoadGraph] ' + pref + ' not found (graph file not built yet?)');
        }
        loading.delete(pref);
        resolve(null);
      };
      document.head.appendChild(script);
    });

    loading.set(pref, promise);
    return promise;
  }

  function ensureLoaded(prefs){
    if(!Array.isArray(prefs)) return Promise.resolve([]);
    return Promise.all(prefs.map(loadGraphFile));
  }

  function getStats(){
    return {
      loadedPrefectures: Array.from(loaded),
      totalLoaded: loaded.size,
    };
  }

  return { loadGraphFile, ensureLoaded, getStats };
})();
