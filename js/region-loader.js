// 都道府県別データの動的読み込み（橋・トンネル・道路）
// 2026/05: 橋・トンネルを地方別 → 都道府県別に統一
//          公開 API（findNearestBridge / findNearestTunnel / ensureLoaded）は無変更
const RegionLoader = (() => {
  // 都道府県別データ（橋・トンネル）
  const tunnelsData = {};        // pref → 配列
  const bridgesData = {};
  const loaded = { tunnels: new Set(), bridges: new Set() };
  const loading = { tunnels: new Map(), bridges: new Map() };

  // 道路（roads-decoder ベース）
  const roadDecoders = new Map();
  const loadedRoads = new Set();
  const loadingRoads = new Map();

  // 47 都道府県の重心 [lat, lon]
  const PREFECTURES = {
    hokkaido:  [43.3, 142.8],
    aomori:    [40.8, 140.7], iwate:    [39.7, 141.2], miyagi:    [38.3, 140.9],
    akita:     [39.7, 140.4], yamagata: [38.2, 140.0], fukushima: [37.4, 140.2],
    ibaraki:   [36.4, 140.4], tochigi:  [36.7, 139.9], gunma:     [36.4, 139.0],
    saitama:   [35.9, 139.4], chiba:    [35.5, 140.2], tokyo:     [35.7, 139.7],
    kanagawa:  [35.4, 139.4],
    niigata:   [37.5, 138.9], toyama:   [36.6, 137.2], ishikawa:  [36.6, 136.7],
    fukui:     [35.8, 136.2], yamanashi:[35.6, 138.6], nagano:    [36.2, 138.0],
    gifu:      [35.6, 137.0], shizuoka: [34.9, 138.4], aichi:     [35.1, 137.0],
    mie:       [34.6, 136.5], shiga:    [35.1, 136.1], kyoto:     [35.2, 135.7],
    osaka:     [34.6, 135.5], hyogo:    [35.0, 134.9], nara:      [34.4, 135.8],
    wakayama:  [33.8, 135.5],
    tottori:   [35.4, 134.0], shimane:  [35.0, 132.8], okayama:   [34.9, 133.8],
    hiroshima: [34.5, 132.7], yamaguchi:[34.2, 131.6],
    tokushima: [33.9, 134.4], kagawa:   [34.3, 134.0],
    ehime:     [33.7, 132.9], kochi:    [33.5, 133.5],
    fukuoka:   [33.6, 130.7], saga:     [33.3, 130.1], nagasaki:  [32.9, 129.9],
    kumamoto:  [32.7, 130.7], oita:     [33.2, 131.4], miyazaki:  [32.0, 131.4],
    kagoshima: [31.4, 130.6], okinawa:  [26.5, 128.0],
  };

  // 互換用 region 判定（既存 getRegion を維持）
  function getRegion(lat, lng) {
    if (lat > 41.5) return 'hokkaido';
    if (lat < 28) return 'kyushu-okinawa';
    if (lat < 34 && lng < 132) return 'kyushu-okinawa';
    if (32.5 <= lat && lat <= 34.5 && 132 <= lng && lng <= 134.7) return 'shikoku';
    if (33 <= lat && lat <= 35.7 && 131 <= lng && lng <= 134.5) return 'chugoku';
    if (33 <= lat && lat <= 35.8 && 134.5 <= lng && lng <= 136.5) return 'kinki';
    if (33.5 <= lat && lat <= 35.5 && 136 <= lng && lng <= 137) return 'kinki';
    if (34.5 <= lat && lat <= 37.5 && 136 <= lng && lng <= 139) return 'chubu';
    if (36.5 <= lat && lat <= 38.5 && 137 <= lng && lng <= 139.8) return 'chubu';
    if (34.5 <= lat && lat <= 37 && 138.5 <= lng && lng <= 141) return 'kanto';
    if (lat >= 36.5) return 'tohoku';
    return null;
  }

  function getPrefecture(lat, lng) {
    let best = null, bestDist = Infinity;
    for (const pref in PREFECTURES) {
      const [pLat, pLng] = PREFECTURES[pref];
      const dLat = lat - pLat;
      const dLng = lng - pLng;
      const d = dLat * dLat + dLng * dLng;
      if (d < bestDist) { bestDist = d; best = pref; }
    }
    return best;
  }

  // 中心の県＋N 県（重心距離順）を返す
  function nearestPrefectures(lat, lng, n = 5) {
    const arr = [];
    for (const pref in PREFECTURES) {
      const [pLat, pLng] = PREFECTURES[pref];
      const dLat = lat - pLat;
      const dLng = lng - pLng;
      arr.push({ pref, d: dLat * dLat + dLng * dLng });
    }
    arr.sort((a, b) => a.d - b.d);
    return arr.slice(0, n).map(x => x.pref);
  }

  // 県別 JS 動的読み込み（共通）
  function loadFile(prefecture, kind) {
    if (!prefecture) return Promise.resolve(null);
    const dataMap = (kind === 'tunnels') ? tunnelsData : bridgesData;
    const loadedSet = loaded[kind];
    const loadingMap = loading[kind];
    const varPrefix = (kind === 'tunnels') ? 'TUNNELS_' : 'BRIDGES_';

    if (loadedSet.has(prefecture)) return Promise.resolve(dataMap[prefecture]);
    if (loadingMap.has(prefecture)) return loadingMap.get(prefecture);

    const promise = new Promise((resolve) => {
      const script = document.createElement('script');
      script.src = `data/${kind}-${prefecture}.js`;
      script.async = true;
      script.onload = () => {
        const varName = varPrefix + prefecture.toUpperCase().replace(/-/g, '_');
        const data = window[varName];
        if (data) {
          dataMap[prefecture] = data;
          loadedSet.add(prefecture);
          if (typeof dlog === 'function') {
            dlog(`[Region] ${kind}/${prefecture}: ${data.length}件`);
          }
          resolve(data);
        } else {
          console.warn(`[Region] ${kind}/${prefecture} 変数なし`);
          resolve(null);
        }
        loadingMap.delete(prefecture);
      };
      script.onerror = () => {
        // 県ファイルが存在しない（橋・トンネルが0件の県）は警告レベルを下げる
        if (typeof dlog === 'function') {
          dlog(`[Region] ${kind}/${prefecture} 読み込み失敗（県内データなしの可能性）`);
        }
        loadingMap.delete(prefecture);
        resolve(null);
      };
      document.head.appendChild(script);
    });

    loadingMap.set(prefecture, promise);
    return promise;
  }

  // 公開 API: 現在地に基づき必要な県を読み込む（橋＋トンネル両方）
  // 後方互換: シグネチャ ensureLoaded(lat, lng) は維持
  function ensureLoaded(lat, lng) {
    const prefs = nearestPrefectures(lat, lng, 5);
    for (const pref of prefs) {
      loadFile(pref, 'tunnels');
      loadFile(pref, 'bridges');
    }
  }

  // 公開 API（シグネチャ無変更）
  function findNearestTunnel(lat, lng, maxDistanceM = 500) {
    return findNearest(lat, lng, maxDistanceM, tunnelsData, loaded.tunnels);
  }
  function findNearestBridge(lat, lng, maxDistanceM = 500) {
    return findNearest(lat, lng, maxDistanceM, bridgesData, loaded.bridges);
  }

  function findNearest(lat, lng, maxDistanceM, dataMap, loadedSet) {
    let best = null;
    let bestDist = maxDistanceM;
    for (const pref of loadedSet) {
      const list = dataMap[pref];
      if (!list) continue;
      for (const t of list) {
        const midLat = t[4][0];
        const midLng = t[4][1];
        const d = haversine(lat, lng, midLat, midLng);
        if (d < bestDist) {
          bestDist = d;
          best = { item: t, distanceToMid_m: d };
        }
      }
    }
    return best;
  }

  function haversine(lat1, lng1, lat2, lng2) {
    const R = 6371000;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLng = (lng2 - lng1) * Math.PI / 180;
    const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLng/2)**2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  }

  function getStats() {
    let totalT = 0, totalB = 0;
    for (const pref of loaded.tunnels) totalT += (tunnelsData[pref] || []).length;
    for (const pref of loaded.bridges) totalB += (bridgesData[pref] || []).length;
    let totalRoads = 0;
    for (const pref of loadedRoads) {
      const decoder = roadDecoders.get(pref);
      if (decoder) totalRoads += decoder.numRoads;
    }
    return {
      // 旧キー名は互換のため残しつつ、内訳は県別になっている
      loadedTunnelRegions: Array.from(loaded.tunnels),
      loadedBridgeRegions: Array.from(loaded.bridges),
      loadedTunnelPrefectures: Array.from(loaded.tunnels),
      loadedBridgePrefectures: Array.from(loaded.bridges),
      totalTunnels: totalT,
      totalBridges: totalB,
      loadedRoadPrefectures: Array.from(loadedRoads),
      totalRoads: totalRoads,
    };
  }

  // ════════════════════════════════════════════════════════════
  // roads-*.js（都道府県別道路データ）対応
  // ════════════════════════════════════════════════════════════

  function loadRoadFile(prefecture) {
    if (!prefecture) return Promise.resolve(null);
    if (loadedRoads.has(prefecture)) return Promise.resolve(roadDecoders.get(prefecture));
    if (loadingRoads.has(prefecture)) return loadingRoads.get(prefecture);

    if (typeof window.RoadDecoder !== 'function') {
      console.warn('[Region] RoadDecoder 未定義（roads-decoder.js を先に読み込んでください）');
      return Promise.resolve(null);
    }

    const promise = new Promise((resolve) => {
      const script = document.createElement('script');
      script.src = `data/roads-${prefecture}.js`;
      script.async = true;
      script.onload = () => {
        const varName = 'ROADS_' + prefecture.toUpperCase().replace(/-/g, '_');
        const data = window[varName];
        if (data && (data.v === 4 || data.v === 5)) {
          try {
            const decoder = new window.RoadDecoder(data);
            const result = decoder.buildOffsetTable();
            roadDecoders.set(prefecture, decoder);
            loadedRoads.add(prefecture);
            if (typeof dlog === 'function') {
              dlog(`[Region] roads/${prefecture}: ${data.numRoads}本 (build ${result.ms.toFixed(0)}ms)`);
            }
            resolve(decoder);
          } catch (e) {
            console.warn(`[Region] roads/${prefecture} デコーダー構築失敗:`, e.message);
            resolve(null);
          }
        } else {
          console.warn(`[Region] roads/${prefecture} 変数なし or 未対応バージョン`);
          resolve(null);
        }
        loadingRoads.delete(prefecture);
      };
      script.onerror = () => {
        console.warn(`[Region] roads/${prefecture} 読み込み失敗`);
        loadingRoads.delete(prefecture);
        resolve(null);
      };
      document.head.appendChild(script);
    });

    loadingRoads.set(prefecture, promise);
    return promise;
  }

  function ensureRoadsLoaded(prefectures) {
    if (!prefectures || prefectures.length === 0) return Promise.resolve([]);
    return Promise.all(prefectures.map(loadRoadFile));
  }

  function getRoadDecoder(prefecture) {
    return roadDecoders.get(prefecture) || null;
  }

  function snapToNearestRoad(lat, lng, options) {
    if (loadedRoads.size === 0) return null;
    let best = null;
    let bestPref = null;
    for (const pref of loadedRoads) {
      const decoder = roadDecoders.get(pref);
      if (!decoder) continue;
      const snap = decoder.snapToNearestRoad(lat, lng, options);
      if (snap && (!best || snap.distanceM < best.distanceM)) {
        best = snap;
        bestPref = pref;
      }
    }
    if (best) best.prefecture = bestPref;
    return best;
  }

  function calcRoadDistance(snapA, snapB) {
    if (!snapA || !snapB) return null;
    if (snapA.prefecture !== snapB.prefecture) {
      const R = 6371000;
      const tr = Math.PI / 180;
      const dLat = (snapB.snapLat - snapA.snapLat) * tr;
      const dLng = (snapB.snapLng - snapA.snapLng) * tr;
      const a = Math.sin(dLat/2)**2 + Math.cos(snapA.snapLat*tr)*Math.cos(snapB.snapLat*tr)*Math.sin(dLng/2)**2;
      return {
        distanceM: R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a)),
        onSameRoad: false
      };
    }
    const decoder = roadDecoders.get(snapA.prefecture);
    if (!decoder) return null;
    return decoder.calcRoadDistance(snapA, snapB);
  }

  return {
    // 公開 API（シグネチャ維持）
    getRegion, ensureLoaded, findNearestTunnel, findNearestBridge, getStats,
    getPrefecture, ensureRoadsLoaded, getRoadDecoder,
    snapToNearestRoad, calcRoadDistance,
    // 追加（参考）
    nearestPrefectures,
  };
})();
