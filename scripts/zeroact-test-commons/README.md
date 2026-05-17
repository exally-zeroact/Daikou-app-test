# ZEROact 共通テスト基盤

ZEROact 合同会社の 3 プロジェクト (ダイコメ / Exally / 今治AI) で共有する自動検証基盤。
コードを「読んで判断する」のではなく「機械的に検証する」ことを目的とする。

## 含まれるツール (5 種)

| # | ツール                              | 目的                                                |
|---|-------------------------------------|-----------------------------------------------------|
| 1 | **Stryker.js** (mutation testing)   | 既存テストの実質網羅性を定量化                      |
| 2 | **fast-check** (property-based)     | 絶対ルール・不変条件を述語化して網羅検証            |
| 3 | **Playwright Geolocation helper**   | GPS / Geolocation を mock した実走シミュレーション  |
| 4 | **Cross-file handler audit**        | postMessage 送受信の接続断絶を自動検出              |
| 5 | **Semgrep custom rules**            | 絶対ルール違反 (例: GPS 直線距離) を taint 解析で検出 |

## 新プロジェクト導入手順 (3 ステップ)

### Step 1: 共通基盤を import (sparse-checkout or submodule)
```bash
# 既存リポジトリ root で実行
mkdir -p scripts/zeroact-test-commons
# A) sparse-checkout の場合 (推奨)
git remote add commons https://github.com/exally-zeroact/Daikou-app-test.git
git fetch commons main
git read-tree --prefix=scripts/zeroact-test-commons -u commons/main:scripts/zeroact-test-commons
# B) コピーで十分なら ↑ の代わりに該当ディレクトリを単純コピー
```

### Step 2: プロジェクト固有設定ファイルを作成
- `audit-handlers.config.js` (ダイコメ参考実装 = `audit-config.daikome.js`)
- `tests/property/` 配下にプロジェクト固有 invariant を追加
- `semgrep-rules/<project>/` に独自ルールを追加 (例: `daikome/`, `exally/`, `imabari-ai/`)
- `stryker.conf.json` を root にコピー・`mutate` 範囲をプロジェクトに合わせる

### Step 3: npm script を追加
```jsonc
{
  "scripts": {
    "audit:handlers": "node scripts/zeroact-test-commons/audit-message-handlers.js audit-handlers.config.js",
    "test:mutation": "stryker run",
    "test:property": "vitest run tests/property",
    "test:semgrep": "semgrep --config scripts/zeroact-test-commons/semgrep-rules/<project>/ ."
  }
}
```

## プロジェクト別適用例

### ダイコメ (PWA + Web Worker + Service Worker)
- audit-handlers: index.html ↔ Worker A / Worker B / SW の postMessage 整合
- property tests: distance_m 単調増加 / running=false ガード / Tier の絶対ルール
- Playwright geolocation: 1km 走行シミュレーション → distance_m 増加検証
- Semgrep: `state.distance_m += X` の X が GPS.calcDistance 由来でないことを taint で検証

### Exally (Next.js + Vercel Functions + AI)
- audit-handlers: client ↔ API route ↔ AI SDK のメッセージ整合
- property tests: spreadsheet cell の数式整合・命令冪等性
- Playwright: canvas-grid 操作の E2E
- Semgrep: API シークレット流入 / 未認証 IDOR

### 今治AI (2027〜)
- 設計開始時にこのテンプレートを Step 1 で取り込む
- audit-handlers / property tests / Playwright / Semgrep をプロジェクト初期から有効化

## 設計方針

- **既存 Vitest / npm run check:all を破壊しない**: 共通基盤の追加スクリプトはすべて新規。既存テストは無変更。
- **3 プロジェクト共通の汎用化**: ファイルパスやハンドラ名はすべて config から注入。コード本体はプロジェクト非依存。
- **絶対ルール文書化と機械検証の同期**: README に書いた絶対ルールが必ず property test / Semgrep rule として対応する構造にする。
