# GeoMind

AIを使った世界地理クイズアプリ。React + Vite + PWA で構築。

## セットアップ

```bash
npm install
npm run dev
```

## 環境変数

`.env.example` をコピーして `.env` を作成し、APIキーを設定してください：

```
VITE_GEMINI_API_KEY=your_api_key_here
```

**注意:** `VITE_` で始まる変数はビルド時に客側アセットに埋め込まれるため公開されます。本番環境ではキー制限またはサーバー側プロキシを使用してください。

## 開発

```bash
npm run dev        # 開発サーバー起動
npm run build      # 本番ビルド
npm run test:e2e   # E2Eテスト
npm run lint       # Lint実行
```

## デプロイ

GitHub Pages で無料ホスティング中。リポジトリを public に設定し、GitHub Actions が自動デプロイします。
