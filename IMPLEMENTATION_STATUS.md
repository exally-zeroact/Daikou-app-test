# ダイコメ Map Matching 実装状況

最終更新: 2026-05-10
管理: 司さん + Claude

このファイルはダイコメの Map Matching / 距離計測関連の実装状況を一元管理する。
セッション間で継続してメンテナンスする。

────────────────────────────────────────────────────────────────────

## 絶対ルール (全セッション共通・例外なし)

- 実装済みの機能は必ず全て課金・業務フローに接続すること
- 「業務継続性」を理由に機能を参照値・dead code にしないこと
- 設計変更をした場合は必ず報告すること
- 安全側への勝手な格下げ禁止
- 距離計算は道路ジオメトリに沿った距離で課金・GPS 直線距離での課金は禁止
  - 「直線距離」= A→B の一発 haversine 課金を意味する
  - Kalman 平滑化済み GPS 連続点を polyline として累積した距離は許可
  - オフライン保持の道路データに沿った距離は許可
- リアルタイム交通流は対象外
- OBD-II / Web Bluetooth は実装しない

## ダイコメ哲学

- 「完全オフライン」ではなく「オフラインでもオンラインと同等に使える」
- 売り: ユーザーはスマホ 1 台用意するだけ・専用ハード不要
- 業務遂行は完全オフライン・補助同期はオンライン時に piggyback
- LINE 連携で更新通知・同期タイミングは LINE 接続時に乗せる

## 距離加算ポリシー (確定済)

- 全加算 (タクシー方式)
- U-turn / バック走行 / oneway 違反 snap も全て加算
- ONEWAY_PENALTY / TURN_RESTRICTION_PENALTY は snap 選択補助のみ
  距離加算は止めない
- T9 jumpProb は意図的逆走を検出しない設計

────────────────────────────────────────────────────────────────────

## ✅ 実装済み機能

### Map Matching コア (Phase A-D・全完了)

| ID | 機能 | 場所 | 状態 |
|----|------|------|------|
| M1 | log 空間 emission (underflow 防止) | map-matcher.js | 実装済 |
| M3 | Viterbi 窓 N=15/N=10 適応・top-2 commit | map-matcher.js | 実装済 |
| M5 | Catmull-Rom centripetal alpha=0.5 | map-matcher.js | 実装済 |
| M6 | Tile pin during routing | map-matcher.js | 実装済 |
| M7 | Grid bias LRU・OSRM /match 教師信号 | map-matcher.js | 実装済 |
| G1 | HDOP/PDOP 推定 (trajectory ベース) | map-matcher.js | 実装済 |
| G3 | 地磁気偏差テーブル補正 | gps-worker.js | 実装済 |
| G6 | iOS 1Hz GPS 補正 (N=10) | map-matcher.js | 実装済 |
| D1 | OSM access タグ・private 除外 | map-matcher.js + roads-decoder.js + build-roads.js | 実装済 |
| D3 | 緊急輸送道路 boost ×1.05 | map-matcher.js | 実装済 |
| D4 | 道路種別速度 cap (参照値・F7 で動作位置変更) | map-matcher.js / meter.js | 実装済 |
| F7 | calculateGapFill 速度クランプ 160km/h 絶対上限 | meter.js | 実装済 |
| B1 | roadsLoaded ack Set 管理 | meter.js | 実装済 |

### Map Matching 拡張 (T1-T12・全完了)

| ID | 機能 | 場所 | 状態 |
|----|------|------|------|
| T1 | DEM 3D 距離補正 (急坂対応) | map-matcher.js _apply3DCorrection | 実装済 |
| T2 | タイル間 border node 接続 (multi-tile Dijkstra) | map-matcher.js _runTileDijkstraMulti | 実装済 |
| T3 | POI proximity prior +5% | map-matcher.js (framework) | framework のみ・実 POI データ未投入 |
| T4 | turn:restriction 違反ペナルティ ×0.05 | map-matcher.js + roads-decoder.js | framework のみ・実 restrictions データ未投入 |
| T5 | Adaptive Kalman Q (道路種別連動) | gps-worker.js + gps.js + meter.js | 実装済 |
| T6 | maxspeed σ_perp チューニング (8 段階) | map-matcher.js + roads-decoder.js + build-roads.js | 実装済・47 県 v7 build 済 |
| T7 | 道路曲率による σ_perp 動的化 | map-matcher.js | 実装済 |
| T8 | Cross-user pheromone (Firebase) | map-matcher.js + firebase.js + meter.js | framework のみ・Firebase 本番運用未開始 |
| T9 | GPS jump 検出 + 確率ベース判定 | map-matcher.js | 実装済 |
| T10 | Lane-level matching (dual carriageway) | map-matcher.js | 実装済 |
| T11 | 時間帯条件付き oneway / 通行制限 | map-matcher.js (framework) | framework のみ・実データ未投入 |
| T12 | DeviceMotion 拡大活用 (急ブレーキ・慣性 quality) | gps-worker.js | 実装済 (急ブレーキのみ・慣性は quality check 止まり) |

### データ・フォーマット

| 項目 | 状態 |
|------|------|
| roads-{pref}.js v7 (24-bit bitmap・maxspeed bit 16-18) | 47 県全 build 済・合計 213 MB |
| DP_TOLERANCE = 3m | 採択済・47 県 build 反映済 |
| tunnels-{region}.js / bridges-{region}.js | 既存・8 region 合計 9,644 トンネル / 6,309 km |
| DEM (5m mesh) tiles | 既存・47 県全カバー |
| backbone graph (cross-pref routing) | 既存・31 MB |

### Firebase 連携

| 項目 | 状態 |
|------|------|
| sessions_log (走行履歴) | 既存稼働 |
| vehicles ステータス | 既存稼働 |
| fareConfig (料金設定) | 既存稼働 |
| pheromone (T8 cross-user・markVisited / pushSessionAggregates) | framework のみ・本番運用未開始 |

────────────────────────────────────────────────────────────────────

## ❌ 未実装機能 (リリース前に実装する)

### Phase 1: フォールバック強化 (1-2 日工数・最優先)

| ID | 機能 | 詳細 | 場所 |
|----|------|------|------|
| Phase1.B | トンネル A→B polyline 精緻化 | ✅ 実装完了 (2026-05-10・commit c18b2c57)。region-loader.js に findTunnelByPosition / findBridgeByPosition / calcInfraPolylineDistance を追加。meter.js calculateGapFill が A・B 両方が同じ infra 上にあれば polyline 距離で計算・Math.max(polylineDist, naive) で過少課金防止 | meter.js + region-loader.js |
| Phase1.C | Off-Road Mode (GPS polyline 累積) | snap 連続失敗 N 回検出時に Kalman 平滑化済 GPS 連続点を polyline として累積。GPS accuracy >50m / 物理上限 160km/h / isStationary はフィルタ。公道復帰で通常モード | meter.js + map-matcher.js 拡張 |
| Phase1.ZUPT | Zero Velocity Update | 停車検出時に Kalman 速度ドリフトをリセット。既存 isStationary 判定の延長 | gps-worker.js 拡張 |

### Phase 2: AI 訓練データ収集 framework (2 日工数)

| ID | 機能 | 詳細 | 場所 |
|----|------|------|------|
| Phase2.A | training-collector | GPS 良好時 (accuracy<=20m + 速度>5km/h) に DeviceMotion 4 秒窓 + GPS 速度 をペアで IndexedDB に保存 | js/training-collector.js (新規) |
| Phase2.B | training-uploader | 既存 Firebase 接続時 (LINE 同期等) に自動送信。Service Worker Background Sync 活用。失敗時 retry queue | js/training-uploader.js (新規) + Cloud Storage |
| Phase2.C | 蓄積データの仕様 | 1 サンプル ≈ 2KB・1 trip 約 300KB・gzip 50KB・最大 100MB ローカル保持 | spec |

### Phase 3: 同意 UI + 利用規約 (0.5 日工数)

| ID | 機能 | 詳細 | 場所 |
|----|------|------|------|
| Phase3.UI | 注意書き表示 | 初回起動時バナー「データ収集について [詳しく見る]」 | index.html |
| Phase3.Settings | 設定画面 | 「学習データ提供」トグル (デフォルト ON)・過去データ削除ボタン | settings.html |
| Phase3.Terms | 利用規約改定 | 1 段落追加 (匿名加速度+速度送信・位置情報なし・opt-out 可) | terms |

### Phase 4: AI 推論統合 (将来・データ蓄積後・2-4 週間工数)

| ID | 機能 | 詳細 | 場所 |
|----|------|------|------|
| Phase4.A | モデル訓練 | Google Colab で CarSpeedNet 系統 LSTM を fine-tune・ONNX 化 | 司さん作業 |
| Phase4.B | ONNX Runtime Web 統合 | Worker B にロード・GPS 不在時に推論起動 | map-matcher.js 拡張 |
| Phase4.C | モデル配信 | js/models/carspeed.onnx を Service Worker でキャッシュ | sw.js |

実装条件: ユーザー数 50 driver 達成 OR 1000 trip 以上の訓練データ蓄積

────────────────────────────────────────────────────────────────────

## 🚫 不採用と確定済 (再評価条件付き)

| 項目 | 不採用理由 | 再評価条件 |
|------|----------|----------|
| 国土地理院 1/2,500 (Phase E) | 測量法承認申請リスク | 国土地理院がオープンデータ化した時 |
| Overture Maps Transportation | Japan は 100% OSM source・size 1.89x | TomTom Japan 寄与が顕著になった時 |
| OBD-II / Web Bluetooth | ユーザー判断 (スマホ単体哲学) | (再評価予定なし) |
| DP_TOLERANCE = 4 (格下げ) | 安全側格下げ禁止ルール | (再評価予定なし) |
| Federated Learning | 実装コスト過大・ダイコメ規模で overkill | 1000+ driver 規模になった時 |
| 国土数値情報 道路ライン | 1/25,000 精度・OSM より低精度 | (再評価予定なし) |
| DRM / MMS 商用ライセンス | 年額数百万-数千万・予算規模 | 大手参入時 |
| VICS / JARTIC | 絶対ルール「リアルタイム交通流対象外」 | (除外確定) |

不採用スクリプト (温存・ARCHIVED コメント付き):
- scripts/parse-gsi-2500-gml.js
- scripts/merge-gsi-into-osm.js
- scripts/fetch-gsi-2500-roads.js
- scripts/build-roads.js の --gsi-2500-dir 関連

────────────────────────────────────────────────────────────────────

## 想定 DER (距離誤差率)

| 段階 | DER 想定 | 状態 |
|------|---------|------|
| baseline (現状・Phase A-E + T1-T12 + DP=3) | 0.3-1.0% | 達成済 |
| Phase 1 完了後 | 0.2-0.7% | 未実装 |
| Phase 2-3 完了後 (蓄積 framework・推論なし) | 0.2-0.7% | 未実装・効果は推論時 |
| Phase 4 完了後 (AI 推論統合) | 0.1-0.5% | 将来 |
| Google Maps (推定) | 0.5-1.5% | 比較対象 |

────────────────────────────────────────────────────────────────────

## blind spot (どの方式でも対応困難・全国スケール)

| 場所 | 全国数 | 業務遭遇率 | 1 件影響 |
|------|-------|-----------|--------|
| 地下駐車場 (深・3 階以上) | 7,500-16,000 箇所 | 都市 5-15% | 100-300m |
| 5km 超 OSM 未登録トンネル | 100-500 個 | <0.01% | 500m-2km |
| 大規模屋内通路 (倉庫・工場) | 数百-千 | 一般 0.5% | 100-500m |
| 超高層ビル街 multipath | 5-10 km² | 都市 5-15% | 50-200m |
| 山間部 GPS 弱林道 | 30,000 km 級 | <0.01% | 500-1000m |

業務影響: 1 trip 中 0.5-2% (一般代行)・5-10% (都市部代行)
1 件あたり 50-100 円課金漏れ
年間影響: 中規模 50 driver 業者で 7 万円/年
業界全体 (Apple/Google も) が完全解決していない領域・許容範囲

────────────────────────────────────────────────────────────────────

## 実装ロードマップ (リリース前に全部完了)

| 順序 | フェーズ | 工数 | 累計 |
|------|--------|------|------|
| 1 | Phase 1.B トンネル精緻化 | 1 日 | 1 日 |
| 2 | Phase 1.C Off-Road Mode | 4-8 時間 | 1.5-1.8 日 |
| 3 | Phase 1.ZUPT | 4-8 時間 | 2-2.3 日 |
| 4 | Phase 2.A 訓練データ収集 | 1 日 | 3-3.3 日 |
| 5 | Phase 2.B 送信 framework | 1 日 | 4-4.3 日 |
| 6 | Phase 3.UI + Terms | 0.5 日 | 4.5-4.8 日 |
| 7 | 統合テスト + commit/push | 0.5 日 | 5-5.3 日 |

合計: 約 5 日工数 (リリース前に全部実装)

Phase 4 (AI 推論) は データ蓄積後に判断・別フェーズ

────────────────────────────────────────────────────────────────────

## 検証手段

- tests/replay-mm.js (合成 fixture・3 ケース)
- tests/meter-mm-priority.js (16 アサーション)
- tests/compare-baseline.js
- 実機テスト: トンネル・地下駐車場・私道・農道のシナリオ別計測 (リリース前)

────────────────────────────────────────────────────────────────────

## 関連ドキュメント

- CLAUDE.md (本リポジトリのルール・絶対ルール)
- このファイル (IMPLEMENTATION_STATUS.md・実装状況管理)
- Claude memory (司さんの自動メモリ・横断的決定事項)
