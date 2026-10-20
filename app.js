// JRA AI 競馬アナリティクス — Web フロントエンド（GitHub Pages で配信する静的サイト）
//   ・データは Supabase から取得。レース前の予想は「有料会員・管理者」だけにデータベース（RLS）が返す。
//     この画面のコードには予想データもモデルも含まれない（ログインした人の権限で、その都度サーバーから受け取るだけ）。
//   ・接続設定が空のときは、架空のデータによるデモ表示。
(function () {
  "use strict";
  const CFG = window.APP_CONFIG || {};
  const DEMO = !(CFG.SUPABASE_URL && CFG.SUPABASE_ANON_KEY);
  const sb = DEMO ? null : window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
  });
  const app = document.getElementById("app");
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const md = (s) => window.DOMPurify.sanitize(window.marked.parse(String(s || "")));
  const pct = (x, d = 1) => (x == null ? "—" : (x * 100).toFixed(d) + "%");
  const yen = (x) => (x == null ? "—" : Math.round(x).toLocaleString("ja-JP") + "円");
  const fmtTime = (iso) => { if (!iso) return ""; const d = new Date(iso); return d.toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Tokyo" }); };
  const fmtDate = (s) => { if (!s) return ""; const d = new Date(s + "T00:00:00+09:00"); return d.toLocaleDateString("ja-JP", { month: "long", day: "numeric", weekday: "short", timeZone: "Asia/Tokyo" }); };
  const gradePill = (g) => g ? `<span class="pill ${g === "G1" ? "g1" : g === "G2" ? "g2" : g === "G3" ? "g3" : "free"}">${esc(g)}</span>` : "";

  let state = { session: null, profile: null };

  // ---------------- データ取得（デモ時は架空データ） ----------------
  const Demo = {
    races: [
      { race_id: "DEMO00000011", race_date: new Date(Date.now() + 864e5).toISOString().slice(0, 10), post_time: new Date(Date.now() + 864e5).toISOString(), course: "東京", race_num: 11, race_name: "デモステークス", grade: "G2", surface: "芝", distance: 1800, field: 12, status: "scheduled" },
      { race_id: "DEMO00000009", race_date: new Date(Date.now() - 864e5).toISOString().slice(0, 10), post_time: new Date(Date.now() - 864e5).toISOString(), course: "京都", race_num: 9, race_name: "サンプル特別", grade: "", surface: "ダート", distance: 1400, field: 14, status: "finished" },
    ],
    prediction(id) {
      if (id !== "DEMO00000009") return null;
      return { payload: { character: { kind: "混戦", text: "（デモ）上位の勝率が接近した混戦です。" }, horses: [
        { umaban: 3, horse: "デモホースA", mark: "◎", p: 0.24, ability_rank: 1, odds: 4.2, ev: 1.01 },
        { umaban: 7, horse: "デモホースB", mark: "○", p: 0.18, ability_rank: 2, odds: 5.1, ev: 0.92 },
        { umaban: 1, horse: "デモホースC", mark: "▲", p: 0.12, ability_rank: 4, odds: 7.8, ev: 0.94 } ],
        preview_md: "### 🔮 レース前の AI 解説（デモ）\n\nこれは**架空のデータ**による表示例です。",
        recommendation: { action: "bet", reasons: ["（デモ）単勝の期待値が 0.9 以上の馬を少額で。"], tickets: [{ type: "単勝", combo: "3", names: "デモホースA", stake: 100, why: "期待値 1.01" }], total: 100, exp_return: 101 } } };
    },
    review(id) { return id === "DEMO00000009" ? { payload: { review_md: "### 📝 レース後の振り返り（デモ）\n\n本命は **2 着**でした。" } } : null; },
  };

  async function getRaces() {
    if (DEMO) return Demo.races;
    const { data, error } = await sb.from("races").select("*").order("race_date", { ascending: false }).order("race_num", { ascending: true }).limit(200);
    if (error) throw error;
    return data || [];
  }
  async function getPrediction(id) {
    if (DEMO) return Demo.prediction(id);
    const { data, error } = await sb.from("predictions").select("payload,model_version,generated_at").eq("race_id", id).maybeSingle();
    if (error) throw error;
    return data;   // 権限が無い場合、データベースが行を返さない（null）
  }
  async function getTeaser(id) {
    if (DEMO) return { teaser: { character: "混戦", n_horses: 12, has_recommendation: true } };
    const { data } = await sb.from("prediction_teasers").select("teaser,generated_at").eq("race_id", id).maybeSingle();
    return data;
  }
  async function getReview(id) {
    if (DEMO) return Demo.review(id);
    const { data } = await sb.from("reviews").select("payload,published_at").eq("race_id", id).maybeSingle();
    return data;
  }
  async function getPerf() {
    if (DEMO) return { payload: { live: { n: 3, roi: 0.92, stake: 900, ret: 830, hit: 1, series: [{ date: "2026-10-01", cum: -100 }, { date: "2026-10-08", cum: 120 }, { date: "2026-10-15", cum: -70 }] },
      backtest: { rule: "（デモ）単勝・AI期待値0.9以上", dev: 0.92, test: 0.87, test_bets: 5525 } } };
    const { data } = await sb.from("performance").select("payload,updated_at").eq("id", "summary").maybeSingle();
    return data;
  }
  async function loadProfile() {
    if (DEMO || !state.session) { state.profile = null; return; }
    const { data } = await sb.from("profiles").select("role,subscription_status,subscription_current_period_end,email,display_name").eq("id", state.session.user.id).maybeSingle();
    state.profile = data;
  }
  const isPremium = () => {
    const p = state.profile;
    if (!p) return false;
    if (p.role === "admin") return true;
    return p.subscription_status === "active" && (!p.subscription_current_period_end || new Date(p.subscription_current_period_end) > new Date());
  };
  const roleLabel = () => !state.profile ? "ゲスト" : state.profile.role === "admin" ? "管理者" : isPremium() ? "有料会員" : "無料会員";

  // ---------------- 画面 ----------------
  function setNav(r) {
    document.querySelectorAll("[data-r]").forEach((a) => a.classList.toggle("on", a.dataset.r === r));
    const acct = document.getElementById("acct");
    acct.textContent = state.session ? `👤 ${roleLabel()}` : "ログイン";
  }

  function raceCard(r, hasReview) {
    const now = new Date();
    const started = r.post_time && new Date(r.post_time) <= now;
    const badge = hasReview ? '<span class="pill done">🏁 結果・振り返り</span>'
      : started ? '<span class="pill open">✅ 予想公開中</span>'
      : isPremium() ? '<span class="pill open">⭐ 会員閲覧可</span>' : '<span class="pill lock">🔒 会員限定</span>';
    return `<a class="race" href="#/race/${encodeURIComponent(r.race_id)}">
      <div class="rn">${esc(r.course || "")}<br>${r.race_num ? esc(r.race_num) + "R" : ""}<small>${fmtTime(r.post_time)}</small></div>
      <div class="t"><b>${esc(r.race_name || "")} ${gradePill(r.grade)}</b><span>${esc(r.surface || "")}${esc(r.distance || "")}m・${esc(r.field || "")}頭</span></div>
      <div>${badge}</div></a>`;
  }

  async function viewHome() {
    setNav("home");
    const [races, perf] = await Promise.all([getRaces().catch(() => []), getPerf().catch(() => null)]);
    const up = races.filter((r) => r.status !== "finished").slice(0, 6);
    const done = races.filter((r) => r.status === "finished").slice(0, 4);
    const p = perf?.payload || {};
    app.innerHTML = `
      <section class="hero"><h1>AI が出走馬の「勝つ確率」を計算し、根拠と買い方まで日本語で解説します。</h1>
        <p>JRA-VAN の 30 年分・14 万レースの記録で学習・検証した予想モデル。レース後には、予想が当たった理由・外れた理由も振り返ります。</p>
        <div class="cta"><a class="btn gold" href="#/races">今週の予想を見る</a><a class="btn ghost" href="#/stats">成績を見る</a></div></section>
      <div class="grid g4">
        <div class="card kpi"><div class="l">ライブ成績（公開した予想）</div><div class="v">${p.live ? pct(p.live.roi, 0) : "記録待ち"}</div><div class="s">${p.live ? p.live.n + "レース・的中 " + p.live.hit : "レース前に公開した予想だけで集計"}</div></div>
        <div class="card kpi"><div class="l">過去の検証（未使用期間）</div><div class="v">${p.backtest ? pct(p.backtest.test, 0) : "—"}</div><div class="s">${p.backtest ? esc(p.backtest.rule) : ""}</div></div>
        <div class="card kpi"><div class="l">学習データ</div><div class="v">14万R</div><div class="s">JRA-VAN 1986〜2026年</div></div>
        <div class="card kpi"><div class="l">あなたの会員種別</div><div class="v">${roleLabel()}</div><div class="s">${isPremium() ? "レース前の予想をすべて閲覧できます" : "レース前の予想は有料会員限定"}</div></div>
      </div>
      <div class="sec">これからのレース</div>
      ${up.length ? up.map((r) => raceCard(r, false)).join("") : '<div class="card muted">公開予定の予想はまだありません。</div>'}
      <div class="sec">最近の結果と振り返り（どなたでも閲覧できます）</div>
      ${done.length ? done.map((r) => raceCard(r, true)).join("") : '<div class="card muted">まだありません。</div>'}`;
  }

  async function viewRaces() {
    setNav("races");
    const races = await getRaces();
    const byDay = {};
    races.forEach((r) => (byDay[r.race_date] = byDay[r.race_date] || []).push(r));
    app.innerHTML = `<div class="sec">予想一覧</div>
      <p class="muted">🔒 のレースは、発走前は有料会員限定です。発走時刻を過ぎると、どなたでも予想と振り返りを閲覧できます。</p>
      ${Object.keys(byDay).sort().reverse().map((d) => `<div class="day">${fmtDate(d)}</div>` + byDay[d].map((r) => raceCard(r, r.status === "finished")).join("")).join("") || '<div class="card muted">まだ予想がありません。</div>'}`;
  }

  function horsesTable(hs) {
    const max = Math.max(...hs.map((h) => h.p || 0), 0.01);
    return `<div class="tbl-wrap"><table class="horses"><thead><tr><th></th><th>馬番</th><th>馬名</th><th>AI 勝率</th><th class="hide-sm">能力</th><th>オッズ</th><th>期待値</th></tr></thead><tbody>
      ${hs.map((h) => `<tr><td class="mk ${h.mark?.startsWith("◎") ? "m1" : h.mark?.startsWith("○") ? "m2" : h.mark?.startsWith("▲") ? "m3" : ""}">${esc(h.mark || "")}</td>
        <td><span class="umaban">${esc(h.umaban)}</span></td><td class="nm">${esc(h.horse)}${h.longshot ? ' <span class="pill lock">☆穴</span>' : ""}</td>
        <td><div style="display:flex;align-items:center;gap:8px"><div class="bar"><i style="width:${Math.round(((h.p || 0) / max) * 100)}%"></i></div><b>${pct(h.p)}</b></div></td>
        <td class="hide-sm">${h.ability_rank ?? "—"}位</td><td>${h.odds ?? "—"}</td>
        <td class="ev ${h.ev >= 1 ? "good" : "low"}">${h.ev != null ? h.ev.toFixed(2) : "—"}</td></tr>`).join("")}
      </tbody></table></div><p class="muted">期待値＝AI 勝率×単勝オッズ。1.00 で長期的に収支トントン。</p>`;
  }

  function recCard(rec) {
    if (!rec) return "";
    if (rec.action !== "bet") return `<div class="card rec"><h3>🤖 AI のおすすめ：見送り</h3><p>${esc((rec.reasons || [])[0] || "")}</p></div>`;
    return `<div class="card rec"><h3>🤖 AI のおすすめの買い方（合計 ${yen(rec.total)}）</h3>
      <table>${rec.tickets.map((t) => `<tr><td><b>${esc(t.type)}</b></td><td>${esc(t.combo)}　${esc(t.names)}</td><td style="text-align:right">${yen(t.stake)}</td></tr>`).join("")}</table>
      <p class="muted">${[rec.unit_note ? esc(rec.unit_note) + "。" : "", rec.exp_return != null ? "AI 推定の期待払戻 " + yen(rec.exp_return) + "。" : "", esc((rec.reasons || [])[0] || "")].join("")}</p></div>`;
  }

  async function viewRace(id) {
    setNav("races");
    const races = await getRaces();
    const r = races.find((x) => x.race_id === id);
    if (!r) { app.innerHTML = '<div class="card">レースが見つかりません。</div>'; return; }
    const [pred, review] = await Promise.all([getPrediction(id), getReview(id)]);
    const head = `<div class="sec">${esc(r.race_name)} ${gradePill(r.grade)}</div>
      <p class="muted">${fmtDate(r.race_date)} ${esc(r.course)}${r.race_num ? esc(r.race_num) + "R" : ""}・${esc(r.surface)}${esc(r.distance)}m・${esc(r.field)}頭・発走 ${fmtTime(r.post_time)}</p>`;
    let body = "";
    if (pred && pred.payload) {
      const p = pred.payload;
      body += `<div class="grid g2"><div class="card"><h3>📌 レースの性格：${esc(p.character?.kind || "")}</h3><p>${esc(p.character?.text || "")}</p></div>${recCard(p.recommendation)}</div>
        <div class="sec">AI の予想</div><div class="card">${horsesTable(p.horses || [])}</div>
        <div class="sec">レース前の AI 解説</div><div class="card md">${md(p.preview_md)}</div>`;
    } else {
      const t = await getTeaser(id);
      body += `<div class="lockbox"><div style="font-size:2rem">🔒</div><h3>このレースの予想は、発走前は有料会員限定です</h3>
        <p>${t ? `レースの性格：<b>${esc(t.teaser?.character || "—")}</b>・${esc(t.teaser?.n_horses || "")}頭・AI のおすすめ：<b>${t.teaser?.has_recommendation ? "あり" : "見送り"}</b>` : ""}</p>
        <p class="muted">発走時刻（${fmtTime(r.post_time)}）を過ぎると、どなたでも閲覧できます。</p>
        <div class="cta" style="display:flex;gap:10px;justify-content:center;flex-wrap:wrap">
        ${state.session ? `<a class="btn gold" href="#/account">有料会員について</a>` : `<a class="btn gold" href="#/account">ログイン・会員登録</a>`}</div></div>`;
    }
    if (review && review.payload) body += `<div class="sec">レース後の振り返り</div><div class="card md">${md(review.payload.review_md)}</div>`;
    app.innerHTML = head + body;
  }

  let chart;
  async function viewStats() {
    setNav("stats");
    const perf = await getPerf();
    const p = perf?.payload || {};
    app.innerHTML = `<div class="sec">成績</div>
      <div class="grid g3">
        <div class="card kpi"><div class="l">ライブ成績（レース前に公開した予想だけ）</div><div class="v">${p.live ? pct(p.live.roi, 1) : "記録待ち"}</div><div class="s">${p.live ? `${p.live.n}レース・購入 ${yen(p.live.stake)}・払戻 ${yen(p.live.ret)}` : ""}</div></div>
        <div class="card kpi"><div class="l">過去の検証：選択に使った期間</div><div class="v">${p.backtest ? pct(p.backtest.dev, 0) : "—"}</div><div class="s">2014〜2020年</div></div>
        <div class="card kpi"><div class="l">過去の検証：使っていない期間</div><div class="v">${p.backtest ? pct(p.backtest.test, 0) : "—"}</div><div class="s">2021〜2026年・${p.backtest?.test_bets?.toLocaleString?.() || ""}点</div></div>
      </div>
      <div class="card" style="margin-top:14px"><h3>ライブ成績の累積損益（100円単位の買い目）</h3><div class="chart"><canvas id="cum"></canvas></div></div>
      <div class="card" style="margin-top:14px"><h3>この成績の読み方</h3><p>回収率 100% が収支トントンです。JRA の払戻率は約 70〜80% のため、長期で 100% を超えるのは非常に難しく、
      このサイトでも「長期で 100% を確実に超える方法」は見つかっていません。AI は損失を小さくし、レースの理解を深めるための道具としてお使いください。</p></div>`;
    const s = p.live?.series || [];
    if (chart) chart.destroy();
    if (s.length && window.Chart) {
      chart = new window.Chart(document.getElementById("cum"), { type: "line",
        data: { labels: s.map((x) => x.date), datasets: [{ label: "累積損益（円）", data: s.map((x) => x.cum), borderColor: "#12664F", backgroundColor: "rgba(18,102,79,.12)", fill: true, tension: .25 }] },
        options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } } } });
    }
  }

  async function viewAccount(msg) {
    setNav("account");
    if (DEMO) { app.innerHTML = '<div class="card">デモ表示中のため、ログインは利用できません（接続設定後に有効になります）。</div>'; return; }
    if (!state.session) {
      app.innerHTML = `<div class="sec">ログイン・会員登録</div>${msg || ""}
        <div class="grid g2"><div class="card"><h3>ログイン</h3><form class="form" id="f-login">
          <input type="email" name="email" placeholder="メールアドレス" autocomplete="email" required>
          <input type="password" name="pw" placeholder="パスワード" autocomplete="current-password" required minlength="8">
          <button class="btn" type="submit">ログイン</button></form></div>
        <div class="card"><h3>無料会員登録</h3><p class="muted">無料会員は、結果・振り返り・成績を閲覧できます。レース前の予想は有料会員限定です。</p>
          <form class="form" id="f-signup"><input type="email" name="email" placeholder="メールアドレス" autocomplete="email" required>
          <input type="password" name="pw" placeholder="パスワード（12文字以上推奨）" autocomplete="new-password" required minlength="8">
          <button class="btn gold" type="submit">登録する</button></form></div></div>`;
      document.getElementById("f-login").onsubmit = async (e) => {
        e.preventDefault(); const f = new FormData(e.target);
        const { error } = await sb.auth.signInWithPassword({ email: f.get("email"), password: f.get("pw") });
        if (error) viewAccount(`<div class="alert err">ログインできませんでした：${esc(error.message)}</div>`);
      };
      document.getElementById("f-signup").onsubmit = async (e) => {
        e.preventDefault(); const f = new FormData(e.target);
        const { error } = await sb.auth.signUp({ email: f.get("email"), password: f.get("pw"), options: { emailRedirectTo: location.origin + location.pathname } });
        viewAccount(error ? `<div class="alert err">登録できませんでした：${esc(error.message)}</div>` : '<div class="alert ok">確認メールを送りました。メール内のリンクを開くと登録が完了します。</div>');
      };
      return;
    }
    const p = state.profile || {};
    app.innerHTML = `<div class="sec">会員情報</div>${msg || ""}
      <div class="grid g2"><div class="card"><h3>${esc(p.email || state.session.user.email)}</h3>
        <p>会員種別：<b>${roleLabel()}</b><br>購読状態：${esc(p.subscription_status || "none")}${p.subscription_current_period_end ? "（" + new Date(p.subscription_current_period_end).toLocaleDateString("ja-JP") + " まで）" : ""}</p>
        <button class="btn ghost" id="b-logout">ログアウト</button></div>
      <div class="card"><h3>有料会員（レース前の AI 予想）</h3>
        <p>有料会員になると、発走前の AI 予想・推奨の買い方・レース前解説をすべて閲覧できます。</p>
        ${isPremium() ? '<p class="alert ok">現在、すべての予想を閲覧できます。</p>'
          : CFG.SUBSCRIBE_URL ? `<a class="btn gold" href="${esc(CFG.SUBSCRIBE_URL)}" rel="noopener">購読する</a>` : '<button class="btn gold" disabled>購読の受付は準備中です</button>'}</div></div>`;
    document.getElementById("b-logout").onclick = async () => { await sb.auth.signOut(); location.hash = "#/"; };
  }

  function viewAbout() {
    setNav("about");
    app.innerHTML = `<div class="sec">使い方</div><div class="grid">
      <div class="card step"><div class="n">1</div><div><h3>予想一覧から気になるレースを選ぶ</h3><p>発走前の予想は有料会員限定です。発走後は、どなたでも予想と振り返りを閲覧できます。</p></div></div>
      <div class="card step"><div class="n">2</div><div><h3>AI の勝率・期待値・解説を読む</h3><p>「期待値」は AI 勝率×オッズ。1.00 で長期的に収支トントンです。AI が市場より高く評価している馬ほど期待値が高くなります。</p></div></div>
      <div class="card step"><div class="n">3</div><div><h3>おすすめの買い方を参考にする</h3><p>AI は、30 年分の検証で最も損失が小さかった買い方だけを提案し、根拠がないレースは「見送り」を推奨します。</p></div></div>
      <div class="card step"><div class="n">4</div><div><h3>レース後に振り返る</h3><p>予想と結果を比べ、当たった理由・外れた理由を解説します。</p></div></div></div>`;
  }

  // ---------------- ルーター ----------------
  async function route() {
    const h = location.hash || "#/";
    try {
      if (h.startsWith("#/race/")) await viewRace(decodeURIComponent(h.slice(7)));
      else if (h === "#/races") await viewRaces();
      else if (h === "#/stats") await viewStats();
      else if (h === "#/account") await viewAccount();
      else if (h === "#/about") viewAbout();
      else await viewHome();
      window.scrollTo(0, 0);
    } catch (e) {
      app.innerHTML = `<div class="alert err">読み込みに失敗しました。時間をおいて再度お試しください。（${esc(e.message || e)}）</div>`;
    }
  }

  async function init() {
    if (DEMO) document.getElementById("banner").innerHTML = '<div class="demo">デモ表示中：架空のデータです（接続設定 config.js が未設定）。</div>';
    if (sb) {
      const { data } = await sb.auth.getSession();
      state.session = data.session;
      await loadProfile();
      sb.auth.onAuthStateChange(async (_ev, session) => { state.session = session; await loadProfile(); route(); });
    }
    window.addEventListener("hashchange", route);
    route();
  }
  init();
})();
