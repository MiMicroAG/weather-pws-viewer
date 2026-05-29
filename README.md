# weather-pws-viewer

Weather Underground に登録した個人気象観測局 (PWS: Personal Weather Station) のデータを、iPhone のホーム画面に置いて常時参照できる PWA Web アプリです。

WunderStation iOS アプリ風の見た目で、複数局切替・期間切替 (24h〜1年)・自動更新に対応します。Node.js + Express + Docker、フロントはバンドラ不要の HTML/CSS/JS + Chart.js です。

## こんな人向け

- 自宅に PWS (Davis、Ambient Weather、Ecowitt 等) を設置し Wunderground に送信している
- iPhone から直近の気温・湿度・風速や 24 時間のチャートを素早く見たい
- WunderStation iOS アプリが終売 / 機能不足で困っている
- 自分のサーバに置いて 1 ヶ月や半年といった長期トレンドも見たい

## 機能

- **3 ページ swipe UI** — 現在値カード / 履歴チャート / 設定
- **8 カードの現在値** — 気温・露点・湿度・気圧・風速 (持続)・突風・雨量・日射 / UV、各カードに 24h max/min と発生時刻
- **6 チャート** — 気温・露点、気圧、湿度、風速・突風、風向 (散布図)、雨量
- **期間切替** — `24h / 1日 / 1週 / 2週 / 1月 / 半年 / 1年` プリセット + 過去任意日 + 期間長指定
- **自動更新** — 60 秒間隔 (設定で変更可)、`visibilitychange` でバックグラウンド時は停止
- **PWA** — `apple-touch-icon` 180px + standalone display で iPhone のホーム画面に追加可
- **文字サイズ** — 小 / 中 / 大 / 特大 の 4 段階 (Chart.js のラベルも追従)
- **マルチステーション** — `config/stations.json` を編集して複数局を切替
- **日本語ラベル + メートル法** — °C / hPa / m/s / mm
- **API キーをサーバ側に隠蔽** — Wunderground 側エンドポイントをサーバが正規化してプロキシ。フロントには `apiKey` を一切露出しない

## 必要なもの

- Weather Underground のアカウント
- 自分の PWS を Wunderground に登録 (= "PWS owner" 状態)
- **Wunderground PWS Owner API キー** (https://www.wunderground.com/member/api-keys から発行)
- Docker + Docker Compose (もしくは Node.js 20 直接)
- 公開する場合は HTTPS で配信できるリバースプロキシ (Caddy / Nginx / Traefik など)。PWA は HTTP では動きません

## 使い方 (Docker)

```bash
git clone https://github.com/MiMicroAG/weather-pws-viewer.git
cd weather-pws-viewer

# 1. API キーを設定
cp .env.example .env
echo "WU_API_KEY=YOUR_KEY_HERE" > .env

# 2. ステーション設定
$EDITOR config/stations.json
# 例: [{"id":"YOUR_STATION_ID","label":"自宅","location":"Tokyo","timezone":"Asia/Tokyo"}]

# 3. 起動
docker compose up -d --build

# 4. ブラウザで http://localhost:3000/ を開く
```

iPhone から使う場合は HTTPS で公開し、Safari で開いて「ホーム画面に追加」してください。

## 使い方 (Node.js 直接)

```bash
npm install
WU_API_KEY=YOUR_KEY node server.js
# http://localhost:3000/
```

## アーキテクチャ

```
ブラウザ (iPhone / Safari PWA)
   │  HTTPS
   ▼
Reverse Proxy (Caddy 等)
   │
   ▼
weather-pws-viewer:3000  (Node.js + Express, Docker)
   ├ /                       静的配信 (HTML/CSS/JS/Chart.js)
   └ /api/...
       ├ /api/stations
       ├ /api/observations/current?stationId=X
       └ /api/observations/history?stationId=X&range=R&endDate=YYYY-MM-DD
          │  in-memory キャッシュ (current 60s / 当日 600s / 過去日 24h / 最大 1000 エントリ LRU)
          ▼
       api.weather.com (Wunderground PWS Owner API)
```

### キャッシュ戦略

| データ | TTL |
|---|---|
| 現在値 (`current`) | 60 秒 |
| 履歴 (当日分) | 600 秒 |
| 履歴 (過去日分) | 24 時間 |
| `partial: true` レスポンス | キャッシュなし |

長期 range (例: 1 年 = 365 日分) のリクエストは並列度 5 で取得し、同一日のデータは別 range 間で再利用されます。

### 期間切替

| range | 粒度 | 使用 Wunderground エンドポイント |
|---|---|---|
| `24h`, `1d` | 5 分 | `observations/all/1day` (当日) / `history/all` (過去日) |
| `1w` | 時 | `observations/hourly/7day` / `history/hourly` × 7 |
| `2w` | 時 | `history/hourly` × 14 |
| `1mo`, `6mo`, `1y` | 日 | `history/daily` × 30 〜 365 |

### セキュリティ

- API キーはサーバ環境変数 (`.env` で gitignore)
- `stationId` は `config/stations.json` の allowlist で検証 (未登録は 404)
- `endDate` は `YYYY-MM-DD` 形式 + 未来日不可 + 過去 2 年以内
- upstream fetch は 10 秒タイムアウト + 429/5xx で指数バックオフ
- upstream の生エラーはクライアントに漏らさずサーバログのみ
- helmet で CSP (`default-src 'self'` 等) を設定
- 非 root (`USER node`) で動作

## ファイル構成

```
weather-pws-viewer/
├ server.js                # Express + キャッシュ + Wunderground プロキシ
├ config/stations.json     # ステーションマスタ (allowlist)
├ public/
│  ├ index.html
│  ├ app.js                # フロント本体 (バンドラなし)
│  ├ style.css
│  ├ sw.js                 # Service Worker (静的 SWR / API はキャッシュなし)
│  ├ manifest.webmanifest
│  ├ vendor/chart.umd.min.js   # Dockerfile が node_modules からコピー
│  └ icons/                # 180/192/512 px PNG
├ Dockerfile               # node:20-alpine、non-root、npm ci
├ docker-compose.yml
├ package.json
├ .env.example
└ .gitignore
```

## リバースプロキシ配下に置く場合 (例: Caddy)

サブパス `/weather/` で配信したい場合の例:

```caddy
redir /weather /weather/ 308
handle_path /weather/* {
    reverse_proxy weather-pws-viewer:3000
}
```

フロントは全パス相対 (`./api/...`、`./vendor/...`) なのでサブパス配信でそのまま動きます。

## ライセンス

MIT (LICENSE 参照)

## 開発について

このプロジェクトは Claude Code を中心に、以下のワークフローで構築されました。

1. iPhone のスクショから仕様を抽出 → Plan モードで設計確定
2. Codex CLI による仕様レビュー
3. リモートホストの Claude Code (ヘッドレス) に実装を委譲
4. Codex CLI でコード監査 (Critical 1 件 + Warning 10 件 + Suggestion 5 件を検出)
5. 検出された全項目を再度ヘッドレス Claude Code に修正委譲

詳しい経緯は [note 記事(https://note.com/kurigohanx/n/n087f020ace5e)] に書きました。

Issue / PR 歓迎します。
