# VRChat アシスタント (vrchat-assistant)

> VRChat のフレンドの動向をリアルタイム監視し、AI が交流・ワールド探索・メディア管理・おすすめを代行します。
> 技術スタック：Node.js + SQLite + WebSocket + MCP

**[中文](./README.md) | [English](./README.en.md) | 日本語**

---

## これは何？

**常駐バックグラウンドサービス**です。VRChat の WebSocket に接続し、フレンドのオンライン/オフライン、ワールド移動、アバター変更、ステータス変化をリアルタイムに取得してローカルデータベースに保存します。すべての機能は **MCP インターフェース**経由で AI エージェント（Hermes など）に公開され、AI が交流・メディア管理・グループ操作・スマートレコメンドを代行します——VRChat クライアントを手動で操作する必要はありません。

このプロジェクトは **AI-first** です：プログラムは AI エージェントによる利用・拡張を前提としており、人間は要件の提示と受け入れを行い、開発は AI が担当します。詳細は下のドキュメント索引を参照してください。

## 主な機能

- 📡 **フレンド監視**：フレンドの動きをリアルタイム取得、自動再接続、Cookie 期限切れ時は OTP メール認証で自動ログイン——完全に無人運用
- 🤖 **スマートレコメンド**：AI フレンド推薦（親密度 + お気に入りグループ重み + ワールドの状況）、今入るべき部屋を推薦。好みは自然言語で設定でき、自動学習
- 🗺 **ワールド探索・レコメンド**：ワールド検索（VRChat 公式 / PlanetVRC 日本語ディレクトリ / 複数ソース融合）、新ワールド追跡、X クリエイターのワールド推薦の集約
- 💬 **ソーシャル操作**：ブープ（Boop）、ルーム招待、参加リクエスト、フレンド申請/削除、ワンクリックでワールドを開く（名前付きパイプ直接送信 + API フォールバック）、レート制限内蔵
- 🛍 **アセット検索**：BOOTH（pixiv のデジタルマーケット）で VRChat アセットを検索——アバター/衣装/3D モデル、人気ランキング・詳細・ローカルキャッシュ・ローカライズ表示対応
- 🖼 **メディア管理**：VRC+ の Prints アルバム / Gallery / カスタムブープ絵文字のアップロード・ダウンロード・削除
- 👥 **グループ管理**：グループ情報、グループルームのリアルタイム一覧、参加/退出、アナウンス覗き見、グループ熱度
- 🗄 **データと洞察**：イベント履歴、同インスタンスの相互クエリ、オンライン傾向分析、週間ゲームレポート、ニックネーム対応、ワールドメモと変更履歴
- 🛡 **セルフヒーリング運用**：自動データベースバックアップ（24h WAL オンラインバックアップ）、Hermes プラグイン管理（自動起動 + クラッシュ自己復旧）

## クイックスタート

**前提条件**：Node.js ≥ 18、VRChat アカウント（メール OTP または TOTP 二段階認証を有効化）。メール OTP ログイン時のみ IMAP 対応メール（OTP コード受信用）が必要です。

1. リポジトリをクローンし、`credentials.example.json` を `credentials.json` にコピーして VRChat アカウントを記入；認証は二択——メール OTP なら IMAP 認証コード、または `totp_secret` を設定して TOTP 自動ログイン
2. サービス起動：`node start-monitor.js`
3. 確認：`curl http://127.0.0.1:8799/health` が JSON で `auth.authenticated: true`、`ws.status: connected` を返す

> 完全な設定（認証情報、環境変数、自動起動、プラグイン導入）は AI エージェントに [AGENTS.md](./AGENTS.md) に従って実行させてください——あなたが行うのはアカウントの提供と受け入れだけです。

## ドキュメント索引

> プロジェクトの全ドキュメントは **AI エージェントと開発者**向けです。この README を読んだ後、必要に応じて参照してください：

| ドキュメント | 内容 | 読むタイミング |
|--------------|------|----------------|
| [AGENTS.md](./AGENTS.md) | 導入ガイド：認証情報、環境変数、起動、Hermes プラグイン、Agent Skill 導入、MCP 設定 | 導入 / 設定 / 初回利用時 |
| [skills/](./skills/) | すぐ使える Agent Skill 集（MCP ツール一覧、クエリワークフロー、開発ガイドラインなど。導入方法は AGENTS.md） | ツール呼び出し / 開発前 |
| [DEVELOPMENT.md](./DEVELOPMENT.md) | 開発ガイドライン：クロスプラットフォーム制約、PR 要件、データプライバシー、コード規約 | コード変更 / PR 提出時 |
| [ARCHITECTURE.md](./ARCHITECTURE.md) | システムアーキテクチャ：データフロー、モジュール責務、依存関係 | コードベース理解時 |
| [docs/history/](./docs/history/INDEX.md) | プロジェクト進化史：マイルストーン、月次リリース/PR とその意義 | 新規エージェントは最初に読む |
| [service-windows/](./service-windows/README.md) | Windows 自動起動 + クラッシュ自己復旧 + 毎日修復レポート（ワンクリックスクリプト） | Windows で常駐運用する場合 |
| [service-linux/](./service-linux/README.md) | Linux systemd ユーザーサービス：自動起動 + クラッシュ自己復旧 + journal ログ（ワンクリックスクリプト） | Linux で常駐運用する場合 |

**MCP ツール**：サービスはフレンド照会、ソーシャル操作、メディア管理、グループ操作、ワールドレコメンド、アセット検索などの分野をカバーする MCP ツールを公開しています。**完全なツール一覧（全ツール）は [skills/vrc-monitor-agent/SKILL.md](./skills/vrc-monitor-agent/SKILL.md) の「MCP ツール」セクションに統一登録されています**——エージェントはそこから呼び出します。他の skill は各分野のワークフロー補助です（ツールの重複登録はしません）：`vrchat-social-queries`（ソーシャル：オンライン/同インスタンス/パターン/ニックネーム）、`vrchat-world-queries`（ワールド：待逛/レコメンド/情報探索）、`vrchat-group-queries`（グループ：照会/アナウンス）、`booth-query-display`（BOOTH 検索/表示）、`vrchat-assistant-development`（開発ガイドライン）、`review-workflow`（PR/issue レビューワークフロー）。

## 🧰 補助ツール（ローカル・任意）

- `open-world.mjs`：ルームを作成し**実行中の VRChat クライアント**内で開く（名前付きパイプ直接送信、失敗時は API 招待にサイレントフォールバック）— `node open-world.mjs <ワールドIDまたは名前>`
- `prepare_image.py`：アップロード前の画像処理（絵文字の正方形化 / Prints 16:9 / Gallery 4:3）
- `migrate-vrcx0.mjs`：VRCX からの履歴データをワンクリック移行 — `node migrate-vrcx0.mjs`

## 🛠 トラブルシューティング

**Q: WebSocket に接続できない？**
A: 中国国内のネットワーク環境ではプロキシが必要な場合があります。サービスは直接接続に 6 秒失敗するとローカルプロキシ（デフォルト `127.0.0.1:7892`、`VRC_MONITOR_WS_PROXY` 環境変数で上書き可）に自動フォールバックします——手動操作は不要です。

**Q: OTP ログインが失敗し続ける？**
A: `credentials.json` の `imap_auth_code` が正しい IMAP 認証コードか（ログインパスワードではない）確認してください。認証失敗後は 120 秒（401 レート制限時は 5 分）のクールダウン後に自動再試行します。

**Q: Authenticator（TOTP）二段階認証を有効にしていて自動ログインできない？**
A: 自動ログインに対応しています：`credentials.json` に `totp_secret`（Authenticator の otpauth:// URI または base32 キー）を設定すると、RFC 6238 でローカル生成したコードで起動時・実行中 401・WS 再接続を全て自動ログインします（有効時は `/health` の `auth.totpAutoEnabled: true`）。未設定の場合は `/health` が `auth.needsTotp: true` を返した際、MCP ツール `submit_totp` で現在の 6 桁コードを送信してログインを完了できます。自動チャネルの優先順位：メール OTP → 自動 TOTP → 手動 `submit_totp`。

**Q: Cookie の期限切れは手動で対応が必要？**
A: 不要です。サービス起動時と WS 再接続時に自動で OTP ログインを行い、有効な Cookie は `auth_cookie.txt` に自動保存されます。**実行中に** API が 401（Cookie 期限切れ）を返した場合も自動で再ログインを試みます。TOTP が必要な場合、`totp_secret` を設定していれば自動で完了し、未設定なら `needsTotp` 状態になり `submit_totp` を呼べば完了します（再起動不要）。

**Q: ログイン失敗・手動対応が必要なときにどう知る？**
A: オプションの**ログイン状態の通知**（issue #69）：`notify-config.example.json` を `notify-config.json` にコピーして `enabled: true` に設定すると、`needsTotp` 突入・メール OTP 取得失敗・実行中 401 自動再認証失敗・認証復旧の際にホストへ通知します（正常な自動ログイン成功時は通知しません）。`channels` は `desktop`（Linux notify-send / macOS osascript / Windows PowerShell toast）と `webhook`（webhook_url へ JSON を POST）に対応。`consecutive_fail_threshold`（既定 3）連続失敗して初めて通知し、`min_interval_sec`（既定 300）で防災。デスクトップ通知はシステム通知デーモン（Linux dunst/mako）が必要で、無い場合は静かに降格します。

**Q: データベースファイルが大きすぎる？**
A: 正常です。約 30 万イベント ≈ 300+ MB。better-sqlite3（WAL モード）はオンデマンド読み込みで、DB 全体をメモリに載せません。

## 💬 コミュニティ

QQ グループ：**851865556** — 利用方法の質問、機能提案、フィードバックはこちらへ。

## ☕ スポンサー

このプロジェクトが役に立ったら、コーヒーをごちそうしてください：

![QRコード](assets/sponsor-qrcodes.png)

**トークンの費用をサポートしてください** 🙏

## 📄 ライセンス

MIT — [LICENSE](LICENSE) を参照。
