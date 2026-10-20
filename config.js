// Web サイトの接続設定（このファイルは公開されます）
//   SUPABASE_ANON_KEY は「公開してよい」キーです。データの保護はデータベース側のアクセス制御（RLS）で行います。
//   ※ service_role キー（書き込み用の秘密キー）は絶対にここに書かないでください（PC の .streamlit/secrets.toml にだけ置く）。
//   空のままだと、架空のデータによるデモ表示になります。
window.APP_CONFIG = {
  SUPABASE_URL: "",
  SUPABASE_ANON_KEY: "",
  SUBSCRIBE_URL: ""   // 将来の決済（Stripe Checkout など）のページ。空なら「準備中」と表示
};
