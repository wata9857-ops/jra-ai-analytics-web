# JRA AI 競馬アナリティクス（Web 画面）

GitHub Pages で配信する静的な画面（HTML / CSS / JavaScript）だけのリポジトリです。

- 予想データ・学習済みモデル・予想アルゴリズムは **含みません**。
- データは Supabase から、ログインした利用者の権限に応じて取得します（レース前の予想は有料会員・管理者のみ。データベースの行単位アクセス制御で保護）。
- `config.js` の `SUPABASE_ANON_KEY` は公開用のキーです（秘密の service_role キーはここには置きません）。
