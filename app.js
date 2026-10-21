// JRA AI 競馬アナリティクス — Web フロントエンド（GitHub Pages で配信する静的サイト）
//   ・データは Supabase から取得。レース前の予想は「ゴールド会員・管理者」だけにデータベース（RLS）が返す。
//     この画面のコードには予想データもモデルも含まれない（ログインした人の権限で、その都度サーバーから受け取るだけ）。
//   ・接続設定が空のときは、架空のデータによるデモ表示。
// v34:
//   ・固まる不具合の対策
//     1) ログイン状態の通知（onAuthStateChange）の中で Supabase を await しない（ライブラリ内部のロックで全通信が止まる既知の問題）
//     2) 画面の切り替えは「最後に押した画面」だけを描画（古い描画は破棄）＝連打しても処理が積み重ならない
//     3) データは短時間キャッシュし、同じ通信を同時に二重に送らない（in-flight 共有）
//     4) グラフは画面を離れるときに必ず破棄（メモリとサイズ監視の残留を防ぐ）
//     5) イベントは document に 1 つだけ（描画のたびに登録し直さない）、ボタンは処理中は無効化
//   ・レースの検索・絞り込み（日付・カレンダー・競馬場・クラス・芝ダ・レース名）、同じ日のレースへの移動
//   ・4 つの買い方（AI推奨・安定・高配当・バランス）の買い目と、結果が出たレースでの収支比較・累計
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
  const num = (x) => (x == null || isNaN(x) ? "—" : Math.round(x).toLocaleString("ja-JP"));
  const pct = (x, d = 1) => (x == null || isNaN(x) ? "—" : (x * 100).toFixed(d) + "%");
  const yen = (x) => (x == null || isNaN(x) ? "—" : num(x) + "円");
  const pl = (x) => (x == null || isNaN(x) ? "—" : x > 0 ? `<span class="plus">+${num(x)}円</span>` : x < 0 ? `<span class="minus">▲${num(-x)}円</span>` : "±0円");
  const roiCls = (r) => (r == null ? "" : r >= 1 ? "plus" : "minus");
  const JST = { timeZone: "Asia/Tokyo" };
  const fmtTime = (iso) => (iso ? new Date(iso).toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit", ...JST }) : "");
  const fmtDate = (s, y) => (s ? new Date(s + "T00:00:00+09:00").toLocaleDateString("ja-JP", { ...(y ? { year: "numeric" } : {}), month: "long", day: "numeric", weekday: "short", ...JST }) : "");
  const todayStr = () => new Date().toLocaleDateString("sv-SE", JST);
  const monthEnd = (ym) => { const [y, m] = ym.split("-").map(Number); return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10); };
  const addDays = (s, n) => { const d = new Date(s + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  const gradeChip = (g) => (g && /^J?G[123]$/.test(g) ? `<span class="chip ${g.replace("J", "").toLowerCase()}">${esc(g)}</span>` : g ? `<span class="chip">${esc(g)}</span>` : "");
  const surfChip = (s) => (s ? `<span class="chip ${String(s).startsWith("芝") ? "turf" : "dirt"}">${esc(s)}</span>` : "");
  function wakuOf(u, n) {
    if (!u || !n) return 1;
    if (n <= 8) return u;
    const base = Math.floor(n / 8), extra = n % 8, start = 8 - extra; let k = 0;
    for (let w = 1; w <= 8; w++) { k += base + (w > start ? 1 : 0); if (u <= k) return w; }
    return 8;
  }
  const gate = (h, n) => `<span class="gate w${h.waku || wakuOf(h.umaban, n) || 1}">${esc(h.umaban)}</span>`;
  const mkCls = (m) => (m?.startsWith("◎") ? "m1" : m?.startsWith("○") ? "m2" : m ? "m3" : "");
  const STRAT = {
    ai: { name: "AI推奨", sub: "見送りあり", risk: "中" },
    stable: { name: "安定型", sub: "的中重視", risk: "低" },
    balance: { name: "バランス型", sub: "的中と配当の両立", risk: "中" },
    high: { name: "高配当型", sub: "大きな配当を狙う", risk: "高" },
  };
  const SORDER = ["ai", "stable", "balance", "high"];
  const COURSES = ["札幌", "函館", "福島", "新潟", "東京", "中山", "中京", "京都", "阪神", "小倉"];

  let state = { session: null, profile: null };

  // ---------------- 通信（キャッシュ＋二重送信防止） ----------------
  const cache = new Map();
  function cached(key, ttlMs, fn) {
    const c = cache.get(key);
    const now = Date.now();
    if (c && (c.p || now - c.t < ttlMs)) return c.p || Promise.resolve(c.v);
    const p = fn().then((v) => { cache.set(key, { v, t: Date.now() }); return v; },
      (e) => { cache.delete(key); throw e; });
    cache.set(key, { p, t: now });
    return p;
  }
  const clearCache = () => cache.clear();

  // ---------------- デモデータ ----------------
  const Demo = (() => {
    const d0 = todayStr(), dm = addDays(d0, -3);
    const races = [
      { race_id: "DEMO1", race_date: addDays(d0, 1), post_time: addDays(d0, 1) + "T15:40:00+09:00", course: "東京", race_num: 11, race_name: "デモステークス", grade: "G2", surface: "芝", distance: 1800, field: 12, status: "scheduled" },
      { race_id: "DEMO2", race_date: addDays(d0, 1), post_time: addDays(d0, 1) + "T14:50:00+09:00", course: "東京", race_num: 10, race_name: "サンプル特別", grade: "", surface: "ダート", distance: 1600, field: 16, status: "scheduled" },
      { race_id: "DEMO3", race_date: dm, post_time: dm + "T15:30:00+09:00", course: "京都", race_num: 9, race_name: "テスト記念", grade: "", surface: "ダート", distance: 1400, field: 10, status: "finished" },
      { race_id: "DEMO4", race_date: dm, post_time: dm + "T15:00:00+09:00", course: "京都", race_num: 8, race_name: "見本賞", grade: "", surface: "芝", distance: 2000, field: 14, status: "finished" },
    ];
    const H = [[3, "デモホースA", "◎", .24, .27, 2, 4.2], [7, "デモホースB", "○", .18, .15, 3, 5.1], [1, "デモホースC", "▲", .12, .09, 5, 7.8],
      [5, "デモホースD", "△", .10, .19, 1, 3.4], [9, "デモホースE", "", .08, .07, 6, 11.5], [2, "デモホースF", "", .07, .08, 4, 9.9]];
    const strategies = {
      ai: { skip: false, reason: "（デモ）較正後の期待値が基準以上の買い目だけ。", tickets: [{ type: "馬連", combo: "3-7", names: "A - B", stake: 200, p: .06, ev: 1.04 }], total: 200 },
      stable: { skip: false, reason: "（デモ）3着内率の高い馬の複勝。", tickets: [{ type: "複勝", combo: "3", names: "A", stake: 300, p: .55, ev: .92 }], total: 300 },
      balance: { skip: false, reason: "（デモ）期待値が最も高い買い目 1 点。", tickets: [{ type: "ワイド", combo: "3-7", names: "A - B", stake: 200, p: .2, ev: .98 }], total: 200 },
      high: { skip: false, reason: "（デモ）的中率は低いが配当の大きい三連複。", tickets: [{ type: "三連複", combo: "3-7-9", names: "A - B - E", stake: 100, p: .02, ev: 1.1 }, { type: "三連複", combo: "1-3-7", names: "C - A - B", stake: 100, p: .02, ev: 1.0 }], total: 200 },
    };
    const pred = { model_version: "v33", character: { kind: "混戦", text: "（デモ）上位の勝率が接近した混戦です。" },
      horses: H.map(([u, n, m, p, q, pop, o], i) => ({ umaban: u, horse: n, mark: m, p, p_ai: p * 1.05, mkt_p: q, pop, odds: o, ev: p * o, ai_rank: i + 1, p_top3: Math.min(.9, p * 2.6) })),
      preview_md: "### レース前の解説（デモ）\n\n架空のデータによる表示例です。", strategies, recommended: "ai" };
    const R = [[1, 7, "デモホースB", 3, 5.1, 2], [2, 3, "デモホースA", 2, 4.2, 1], [3, 9, "デモホースE", 6, 11.5, 5], [4, 5, "デモホースD", 1, 3.4, 4], [5, 1, "デモホースC", 5, 7.8, 3], [6, 2, "デモホースF", 4, 9.9, 6]];
    const review = { result: R.map(([pos, u, n, pop, o, ar]) => ({ pos, umaban: u, horse: n, pop, odds: o, ai_rank: ar })),
      pays: { "単勝": [{ nums: [7], pay: 510 }], "複勝": [{ nums: [7], pay: 180 }, { nums: [3], pay: 160 }, { nums: [9], pay: 310 }], "ワイド": [{ nums: [3, 7], pay: 420 }], "馬連": [{ nums: [3, 7], pay: 1240 }], "三連複": [{ nums: [3, 7, 9], pay: 6820 }], "三連単": [{ nums: [7, 3, 9], pay: 31570 }] },
      strategies: { ai: { stake: 200, ret: 2480 }, stable: { stake: 300, ret: 480 }, balance: { stake: 200, ret: 840 }, high: { stake: 200, ret: 6820 } },
      review_md: "### レース後の振り返り（デモ）\n\n本命は **2 着**でした。" };
    const index = { DEMO3: { winner: "デモホースB", ai1_pos: 2, nets: { ai: 2280, stable: 180, balance: 640, high: 6620 } } };
    const perf = { live: { n: 3, roi: 0.92, stake: 1500, ret: 1380, hit: 1, series: [{ date: dm, cum: -120 }] },
      strategies_live: { ai: { n: 1, stake: 200, ret: 2480 }, stable: { n: 1, stake: 300, ret: 480 }, balance: { n: 1, stake: 200, ret: 840 }, high: { n: 1, stake: 200, ret: 6820 } } };
    const member = { factor_names: ["能力", "近走", "末脚", "距離", "コース", "馬場", "展開", "騎手", "厩舎", "血統", "状態"],
      factor_help: { "能力": "これまでの対戦成績から見た総合力" },
      horses: Object.fromEntries(H.map(([u, n], i) => [String(u), { horse: n, ai_rank: i + 1, pop: H[i][5], strong: i < 2 ? ["近走", "末脚"] : [], weak: i > 3 ? ["距離"] : [],
        story: `（デモ）前走は東京芝1800mで${i + 2}着。近 3 走は安定して上位に来ています。坂路の追い切りはメンバー上位の時計です。`,
        factors: { "能力": 90 - i * 12, "近走": 80 - i * 10, "末脚": 70 - i * 5, "距離": 60, "コース": 55, "馬場": 50, "展開": 45, "騎手": 65, "厩舎": 40, "血統": 75, "状態": 50 } }])),
      strategies: Object.fromEntries(Object.entries(strategies).map(([k, v]) => [k, { ...v, tickets: v.tickets.map((t) => ({ ...t, reason: "（デモ）3番 デモホースA（AI能力 1 位・2 番人気・近走と末脚が高評価）。期待値 1.12。" })) }])),
      recommended: "ai", review: { strategies: review.strategies, review_md: review.review_md, recommended: "ai" } };
    index.DEMO3 = { ...index.DEMO3, ai1_win: false, trio: true, ai_top3_in_top3: 3 };
    review.hits = { ai1_pos: 2, ai_top3_in_top3: 2, trio: false, exact: false, ai1_win: false };
    return { races, pred, review, index, perf, member };
  })();

  // ---------------- データ取得 ----------------
  const RACE_COLS = "race_id,race_date,post_time,course,race_num,race_name,grade,surface,distance,field,status";
  function queryRaces(f) {
    const key = "races:" + JSON.stringify(f);
    return cached(key, 60e3, async () => {
      if (DEMO) {
        let r = Demo.races.slice();
        if (f.date) r = r.filter((x) => x.race_date === f.date);
        if (f.from) r = r.filter((x) => x.race_date >= f.from);
        if (f.to) r = r.filter((x) => x.race_date <= f.to);
        if (f.status) r = r.filter((x) => (f.status === "finished" ? x.status === "finished" : x.status !== "finished"));
        if (f.course) r = r.filter((x) => x.course === f.course);
        if (f.q) r = r.filter((x) => (x.race_name || "").includes(f.q));
        return r;
      }
      let q = sb.from("races").select(RACE_COLS);
      if (f.date) q = q.eq("race_date", f.date);
      if (f.from) q = q.gte("race_date", f.from);
      if (f.to) q = q.lte("race_date", f.to);
      if (f.status === "finished") q = q.eq("status", "finished");
      if (f.status === "upcoming") q = q.neq("status", "finished");
      if (f.course) q = q.eq("course", f.course);
      if (f.surface) q = q.ilike("surface", f.surface + "%");
      if (f.grade === "重賞") q = q.in("grade", ["G1", "G2", "G3", "JG1", "JG2", "JG3"]);
      else if (f.grade) q = q.eq("grade", f.grade);
      if (f.q) q = q.ilike("race_name", `%${f.q.replace(/[%_]/g, "")}%`);
      const asc = f.order === "asc";
      q = q.order("race_date", { ascending: asc }).order("post_time", { ascending: true }).range(f.offset || 0, (f.offset || 0) + (f.limit || 120) - 1);
      const { data, error } = await q;
      if (error) throw error;
      return data || [];
    });
  }
  const raceDates = (from, to) => cached(`dates:${from}:${to}`, 300e3, async () => {
    if (DEMO) return [...new Set(Demo.races.map((r) => r.race_date))];
    const { data, error } = await sb.from("races").select("race_date").gte("race_date", from).lte("race_date", to).limit(2000);
    if (error) throw error;
    return [...new Set((data || []).map((r) => r.race_date))];
  });
  const getRace = (id) => cached("race:" + id, 60e3, async () => {
    if (DEMO) return Demo.races.find((r) => r.race_id === id) || null;
    const { data, error } = await sb.from("races").select(RACE_COLS).eq("race_id", id).maybeSingle();
    if (error) throw error;
    return data;
  });
  const getPrediction = (id) => cached("pred:" + id + ":" + (state.session?.user?.id || "anon"), 60e3, async () => {
    if (DEMO) return id === "DEMO3" || id === "DEMO1" ? { payload: Demo.pred } : null;
    const { data, error } = await sb.from("predictions").select("payload,model_version,generated_at").eq("race_id", id).maybeSingle();
    if (error) throw error;
    return data; // 権限が無い場合、データベースが行を返さない（null）
  });
  const getTeaser = (id) => cached("teaser:" + id, 60e3, async () => {
    if (DEMO) return { teaser: { character: "混戦", n_horses: 12, has_recommendation: true } };
    const { data } = await sb.from("prediction_teasers").select("teaser,generated_at").eq("race_id", id).maybeSingle();
    return data;
  });
  const getReview = (id) => cached("review:" + id, 60e3, async () => {
    if (DEMO) return id === "DEMO3" ? { payload: Demo.review } : null;
    const { data } = await sb.from("reviews").select("payload,published_at").eq("race_id", id).maybeSingle();
    return data;
  });
  const getPerfRow = (rid) => cached("perf:" + rid, 120e3, async () => {
    if (DEMO) return { payload: rid === "summary" ? Demo.perf : Demo.index };
    const { data } = await sb.from("performance").select("payload,updated_at").eq("id", rid).maybeSingle();
    return data;
  });
  const getPerf = () => getPerfRow("summary");
  const getMember = (id) => (!state.session && !DEMO ? Promise.resolve(null) : cached("member:" + id + ":" + (state.session?.user?.id || "demo"), 60e3, async () => {
    if (DEMO) return Demo.member || null;
    const { data, error } = await sb.from("member_details").select("payload").eq("race_id", id).maybeSingle();
    if (error) return null;   // テーブル未作成・権限なし
    return data?.payload || null;
  }));
  const getMemberPerf = (rid) => (!state.session && !DEMO ? Promise.resolve(null) : cached("mperf:" + rid + ":" + (state.session?.user?.id || "demo"), 120e3, async () => {
    if (DEMO) return rid === "detail" ? Demo.perf : null;
    const { data, error } = await sb.from("member_perf").select("payload").eq("id", rid).maybeSingle();
    if (error) return null;
    return data?.payload || null;
  }));
  // ログインしているのに会員用のデータを読めなかったとき（通信の失敗・同期待ち）
  const noData = () => `<div class="sheet muted">このレースの詳しいデータを読み込めませんでした。時間をおいて再度お試しください。
    <button type="button" class="linkbtn" data-act="retry">再読み込み</button></div>`;
  // 会員限定の部分（未ログインのときに代わりに表示）
  function memberLock(title, what) {
    return `<div class="mlock"><div class="mlock-ic" aria-hidden="true">🔒</div><div><b>${esc(title)}</b><p>${esc(what)}</p>
      <a class="btn shu" href="#/account">無料会員登録・ログイン</a></div></div>`;
  }
  const getIndex = async () => {
    const pub = await getPerfRow("race_index").then((r) => r?.payload || {}).catch(() => ({}));
    const mem = await getMemberPerf("race_index").catch(() => null);
    if (!mem) return pub;
    const out = { ...pub };
    Object.entries(mem).forEach(([k, v]) => { out[k] = { ...(out[k] || {}), ...v }; });
    return out;
  };

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
  const roleLabel = () => (!state.profile ? (state.session ? "会員" : "ゲスト") : state.profile.role === "admin" ? "管理者" : isPremium() ? "ゴールド会員" : "無料会員");

  function setNav(r) {
    document.querySelectorAll("[data-r]").forEach((a) => {
      const on = a.dataset.r === r;
      a.classList.toggle("on", on);
      if (on) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current");
    });
    document.getElementById("acct").textContent = state.session ? roleLabel() : "ログイン";
    document.getElementById("who").textContent = state.session ? `${roleLabel()}でご利用中` : "";
  }

  // ---------------- グラフ（画面を離れるときに必ず破棄） ----------------
  let charts = [];
  function destroyCharts() { charts.forEach((c) => { try { c.destroy(); } catch (e) { /* 破棄済み */ } }); charts = []; }
  function makeChart(id, cfg) {
    const el = document.getElementById(id);
    if (!el || !window.Chart) return;
    charts.push(new window.Chart(el, cfg));
  }

  // ---------------- 共通部品 ----------------
  function figs(items, cls = "") {
    return `<div class="figs ${cls}">${items.map((f) => `<div class="fig ${f.key ? "key" : ""}"><div class="l">${f.l}</div><div class="v">${f.v}</div>${f.s ? `<div class="s">${f.s}</div>` : ""}</div>`).join("")}</div>`;
  }
  function moneyFigs(m) {
    if (!m || !m.stake) return "";
    const net = (m.ret || 0) - m.stake, roi = m.ret / m.stake;
    return figs([
      { l: "購入額", v: yen(m.stake), s: m.n != null ? `${num(m.n)}レース` : "" },
      { l: "払戻額", v: yen(m.ret), s: m.hit != null ? `的中 ${num(m.hit)}` : "" },
      { l: "収支", v: pl(net), key: true },
      { l: "回収率", v: `<span class="${roiCls(roi)}">${pct(roi, 1)}</span>`, s: "100%で収支トントン" },
    ], "f4");
  }
  const empty = (t) => `<div class="sheet muted">${t}</div>`;
  // v35: 金額ではなく回収率（%）で見せる。100% 以上だけ控えめに色を付け、100% 未満は通常の文字色（損失を強調しない）
  const roiTag = (r, d = 0) => (r == null || isNaN(r) ? "—" : `<span class="roi ${r >= 1 ? "up" : ""}">${pct(r, d)}</span>`);
  function roiBar(r) {
    const w = r == null ? 0 : Math.max(2, Math.min(100, (r / 2) * 100));   // 0〜200% を棒の長さに、中央の線が 100%
    return `<span class="rbar" aria-hidden="true"><i style="width:${w}%"></i><b></b></span>`;
  }

  function raceRow(r, idx) {
    const started = r.post_time && new Date(r.post_time) <= new Date();
    const s = idx?.[r.race_id];
    let right;
    if (r.status === "finished") {
      const k = s?.rec || "ai", st = s?.stakes?.[k], rt = s?.rets?.[k];
      const badge = (s?.pre === false ? '<span class="chip post">参考</span>' : "") + (s?.ai1_win ? '<span class="hitchip">◎的中</span>' : s?.trio ? '<span class="hitchip">三連複的中</span>' : "");
      right = `<span class="st st-done">結果</span>${badge}${s?.ai1_pos ? `<span class="rs">AI1位 <b>${esc(s.ai1_pos)}着</b></span>` : ""}${st ? `<span class="rs">${STRAT[k].name} ${roiTag(rt / st)}</span>` : ""}`;
    } else {
      right = started ? `<span class="st">発走済み</span>` : isPremium() ? `<span class="st st-open">予想あり</span>` : `<span class="st st-lock">会員限定</span>`;
    }
    return `<a class="rrow" href="#/race/${encodeURIComponent(r.race_id)}">
      <div class="rn"><b>${r.race_num ? esc(r.race_num) + "R" : ""}</b><small>${fmtTime(r.post_time)}</small></div>
      <div class="t"><b>${esc(r.race_name || "")}</b> ${gradeChip(r.grade)}<small class="rmeta">${esc(r.course || "")}・${esc(r.surface || "")}${esc(r.distance || "")}m・${esc(r.field || "")}頭</small></div>
      <div class="res">${right}</div></a>`;
  }
  function groupedList(races, idx) {
    if (!races.length) return empty("条件に合うレースがありません。");
    const byDay = new Map();
    races.forEach((r) => { if (!byDay.has(r.race_date)) byDay.set(r.race_date, new Map()); const m = byDay.get(r.race_date); if (!m.has(r.course)) m.set(r.course, []); m.get(r.course).push(r); });
    let h = "";
    for (const [d, m] of byDay) {
      h += `<h3 class="day">${fmtDate(d, true)}</h3>`;
      for (const [c, rs] of m) {
        rs.sort((a, b) => (a.race_num || 0) - (b.race_num || 0));
        h += `<h4 class="course-h">${esc(c || "")}</h4><div class="rlist">${rs.map((r) => raceRow(r, idx)).join("")}</div>`;
      }
    }
    return h;
  }

  // ---------------- トップ ----------------
  let homeDone = [], homeIdx = {};
  function homeDoneList(filter) {
    const f = filter || "all";
    const list = f === "all" ? homeDone : f === "重賞" ? homeDone.filter((r) => /G[123]/.test(r.grade || "")) : homeDone.filter((r) => r.course === f);
    return list.length ? groupedList(list, homeIdx) : empty("条件に合うレースがありません。");
  }
  async function viewHome(tok) {
    setNav("home");
    const t = todayStr();
    const [up, done, perf, idx] = await Promise.all([
      queryRaces({ from: t, status: "upcoming", order: "asc", limit: 60 }).catch(() => []),
      queryRaces({ status: "finished", limit: 24 }).catch(() => []),
      getPerf().catch(() => null), getIndex()]);
    if (tok !== routeTok) return;
    homeDone = done; homeIdx = idx;
    const p = perf?.payload || {};
    const nextDay = up[0]?.race_date;
    const upDay = up.filter((r) => r.race_date === nextDay);
    const sl = p.strategies_live || {}, bt = p.strategies_backtest || {};
    const cards = SORDER.map((k) => {
      const s = sl[k] || {}, b = bt[k] || {}, roi = s.stake ? s.ret / s.stake : null;
      return `<a class="scard" href="#/stats" aria-label="${STRAT[k].name}の成績を見る">
        <span class="sn">${STRAT[k].name}<small>${STRAT[k].sub}</small></span>
        <span class="sv">${roi == null ? '<span class="roi wait">—</span>' : roiTag(roi)}</span>${roiBar(roi)}
        <span class="ss">${s.stake ? `回収率・${num(s.n)}レース・的中率 ${pct(s.hit / s.n, 0)}` : "発走前の記録はまだありません"}</span>
        ${b.full_roi != null ? `<span class="sb">過去の検証 ${pct(b.full_roi, 0)}</span>` : ""}</a>`;
    }).join("");
    const courses = [...new Set(done.map((r) => r.course).filter(Boolean))];
    const hasG = done.some((r) => /G[123]/.test(r.grade || ""));
    const chips = [["all", "すべて"], ...courses.map((c) => [c, c]), ...(hasG ? [["重賞", "重賞"]] : [])]
      .map(([v, l], i) => `<button type="button" class="fchip ${i === 0 ? "on" : ""}" data-act="hf" data-v="${esc(v)}" aria-pressed="${i === 0}">${esc(l)}</button>`).join("");
    app.innerHTML = `
      <div class="h-sec"><h2>買い方ごとの回収率</h2><a class="more-link" href="#/stats">詳しく見る ›</a></div>
      <div class="scards">${cards}</div>
      <p class="note">回収率は公開したレースでの通算（100% で購入額と同じ払戻）。「過去の検証」は 2016〜2026 年のデータでの通算です。</p>
      <div class="h-sec"><h2>${nextDay ? `次の開催　${fmtDate(nextDay)}` : "これからのレース"}</h2><a class="more-link" href="#/races?tab=upcoming">すべて見る ›</a></div>
      ${upDay.length ? groupedList(upDay, idx).replace(/<h3 class="day">.*?<\/h3>/, "") : empty("公開予定の予想はまだありません。")}
      <div class="h-sec"><h2>最近の結果</h2><a class="more-link" href="#/races?tab=finished">すべて見る ›</a></div>
      ${done.length ? `<div class="fchips" role="group" aria-label="最近の結果の絞り込み">${chips}</div>` : ""}
      <div id="home-done">${done.length ? homeDoneList("all") : empty("まだありません。")}</div>`;
  }

  // ---------------- レース一覧（検索・絞り込み・カレンダー） ----------------
  function parseQuery() {
    const h = location.hash.split("?")[1] || "";
    return Object.fromEntries(new URLSearchParams(h));
  }
  function setQuery(f) {
    const q = new URLSearchParams(Object.entries(f).filter(([, v]) => v != null && v !== "")).toString();
    const h = "#/races" + (q ? "?" + q : "");
    if (location.hash !== h) location.hash = h;
  }
  function calendar(month, dates, sel) {
    const [y, m] = month.split("-").map(Number);
    const first = new Date(Date.UTC(y, m - 1, 1)), days = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const set = new Set(dates), t = todayStr();
    let cells = "";
    for (let i = 0; i < first.getUTCDay(); i++) cells += "<span></span>";
    for (let d = 1; d <= days; d++) {
      const ds = `${month}-${String(d).padStart(2, "0")}`;
      const has = set.has(ds);
      cells += has ? `<button type="button" class="cd has ${ds === sel ? "sel" : ""} ${ds === t ? "today" : ""}" data-act="date" data-v="${ds}">${d}</button>`
        : `<span class="cd ${ds === t ? "today" : ""}">${d}</span>`;
    }
    const prev = new Date(Date.UTC(y, m - 2, 1)).toISOString().slice(0, 7), next = new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 7);
    return `<div class="cal"><div class="cal-h"><button type="button" class="ib" data-act="month" data-v="${prev}" aria-label="前の月">‹</button>
      <b>${y}年${m}月</b><button type="button" class="ib" data-act="month" data-v="${next}" aria-label="次の月">›</button></div>
      <div class="cal-g"><i>日</i><i>月</i><i>火</i><i>水</i><i>木</i><i>金</i><i>土</i>${cells}</div>
      <p class="note">● のある日にレースがあります。日付を押すとその日のレースを表示します。</p></div>`;
  }
  async function viewRaces(tok) {
    setNav("races");
    const f = parseQuery();
    const tab = f.tab || "all";
    const month = f.month || (f.date || todayStr()).slice(0, 7);
    const qf = { status: tab === "all" ? "" : tab, date: f.date || "", course: f.course || "", surface: f.surface || "", grade: f.grade || "", q: f.q || "",
      order: tab === "upcoming" ? "asc" : (f.order || "desc"), limit: Number(f.limit || 120) };
    if (tab === "upcoming" && !f.date) qf.from = todayStr();
    const [races, dates, idx] = await Promise.all([queryRaces(qf), raceDates(month + "-01", monthEnd(month)).catch(() => []), getIndex()]);
    if (tok !== routeTok) return;
    const tabs = [["upcoming", "これから"], ["finished", "結果"], ["all", "すべて"]]
      .map(([k, l]) => `<button type="button" class="tab ${tab === k ? "on" : ""}" data-act="tab" data-v="${k}" aria-pressed="${tab === k}">${l}</button>`).join("");
    const opt = (v, l, cur) => `<option value="${esc(v)}" ${v === cur ? "selected" : ""}>${esc(l)}</option>`;
    const active = ["date", "course", "surface", "grade", "q"].filter((k) => f[k]).length;
    const hasCond = ["date", "course", "surface", "grade", "q"].some((k) => f[k]);
    app.innerHTML = `${hasCond ? backBar("条件を指定したレース一覧") : ""}
      <div class="filters" id="filters">
        <div class="tabs" role="group" aria-label="表示するレース">${tabs}</div>
        <form class="frow" id="f-search" role="search">
          <input type="search" name="q" value="${esc(f.q || "")}" placeholder="レース名で検索（例：天皇賞）" enterkeyhint="search" aria-label="レース名で検索">
          <button class="btn" type="submit">検索</button>
        </form>
        <details class="fmore" ${active ? "open" : ""}><summary>絞り込み${active ? `（${active}件）` : ""}</summary>
        <div class="frow sel">
          <label>日付<input type="date" name="date" value="${esc(f.date || "")}" data-act="date-input"></label>
          <label>競馬場<select data-act="filter" data-k="course">${opt("", "すべて", f.course || "")}${COURSES.map((c) => opt(c, c, f.course)).join("")}</select></label>
          <label>芝・ダート<select data-act="filter" data-k="surface">${opt("", "すべて", f.surface || "")}${opt("芝", "芝", f.surface)}${opt("ダ", "ダート", f.surface)}${opt("障", "障害", f.surface)}</select></label>
          <label>クラス<select data-act="filter" data-k="grade">${opt("", "すべて", f.grade || "")}${opt("重賞", "重賞（G1〜G3）", f.grade)}${opt("G1", "G1", f.grade)}${opt("G2", "G2", f.grade)}${opt("G3", "G3", f.grade)}</select></label>
          ${tab !== "upcoming" ? `<label>並び順<select data-act="filter" data-k="order">${opt("desc", "新しい順", f.order || "desc")}${opt("asc", "古い順", f.order)}</select></label>` : ""}
        </div>
        ${f.date ? `<div class="daynav"><button type="button" class="btn ghost" data-act="date" data-v="${addDays(f.date, -1)}">‹ 前日</button>
          <b>${fmtDate(f.date, true)}</b><button type="button" class="btn ghost" data-act="date" data-v="${addDays(f.date, 1)}">翌日 ›</button></div>` : ""}
        ${active ? `<button type="button" class="linkbtn" data-act="clear">条件をすべて解除</button>` : ""}
        </details>
      </div>
      <details class="more cal-wrap" ${f.month ? "open" : ""}><summary>カレンダーから選ぶ</summary><div>${calendar(month, dates, f.date)}</div></details>
      <div class="count">${races.length >= qf.limit ? `${num(races.length)}件以上` : `${num(races.length)}件`}</div>
      ${groupedList(races, idx)}
      ${races.length >= qf.limit ? `<div class="cta center"><button type="button" class="btn ghost" data-act="more">さらに表示</button></div>` : ""}`;
  }

  // ---------------- レース詳細 ----------------
  function horsesTable(hs, field, posMap) {
    const hasAi = hs.some((h) => h.p_ai != null);
    const hasPos = posMap && Object.keys(posMap).length;
    return `<div class="tbl-wrap"><table class="t"><thead><tr>${hasPos ? '<th class="c">着</th>' : ""}<th>印</th><th>馬番</th><th>馬名</th>
      ${hasAi ? '<th class="r">AI独自</th>' : ""}<th class="r">勝率</th><th class="hide-sm">AI <span style="color:var(--ai)">■</span>／人気 <span style="color:#9C9583">■</span></th>
      <th class="r">3着内</th><th class="r">人気</th><th class="r">オッズ</th><th class="r hide-sm">期待値</th></tr></thead><tbody>
      ${hs.map((h) => {
        const q = h.mkt_p ?? (h.odds ? 0.8 / h.odds : null);
        const gap = h.ai_rank && h.pop ? h.pop - h.ai_rank : null;
        const ps = hasPos ? posMap[h.umaban] : null;
        const hit = ps && ps <= 3 && h.mark;
        return `<tr class="${hit ? "hit" : ""}">${hasPos ? `<td class="c pos ${ps === 1 ? "p1" : ""}">${ps ? ps : "—"}</td>` : ""}<td class="mk ${mkCls(h.mark)}">${esc(h.mark || "")}${hit ? '<span class="hitstamp">的中</span>' : ""}</td><td>${gate(h, field)}</td>
        <td class="nm">${esc(h.horse)}${gap >= 3 ? ` <span class="diff-up" title="人気より AI の評価が高い">↑</span>` : ""}</td>
        ${hasAi ? `<td class="r">${h.ai_rank ? h.ai_rank + "位" : "—"}</td>` : ""}
        <td class="r"><b>${pct(h.p)}</b></td>
        <td class="hide-sm"><div class="bar2"><i style="width:${Math.min(100, (h.p_ai ?? h.p ?? 0) * 250)}%"></i><b style="width:${Math.min(100, (q || 0) * 250)}%"></b></div></td>
        <td class="r">${pct(h.p_top3, 0)}</td><td class="r">${h.pop ?? "—"}</td><td class="r">${h.odds ?? "—"}</td>
        <td class="r hide-sm ${h.ev >= 1 ? "plus" : ""}">${h.ev != null ? h.ev.toFixed(2) : "—"}</td></tr>`;
      }).join("")}
      </tbody></table></div>
      <p class="note">AI独自＝オッズを使わない能力の順位。勝率＝AI の評価に市場（オッズ）の情報を合わせた確率。↑＝人気より AI の評価が 3 つ以上高い馬。</p>`;
  }

  // 4 つの買い方（レース前）
  function strategyPlans(P) {
    const S = P.strategies;
    if (!S) return P.recommendation ? oldRec(P.recommendation) : "";
    const st = P.strategy_stats || {};
    return `<div class="splans">${SORDER.filter((k) => S[k]).map((k) => {
      const s = S[k], m = STRAT[k], v = st[k];
      const body = s.skip ? `<p class="skip">見送り</p><p class="note">${esc(s.reason || "")}</p>`
        : `<table class="t compact"><tbody>${(s.tickets || []).map((t) => `<tr><td><b>${esc(t.type)}</b></td><td class="num">${esc(t.combo)}</td><td class="r">${yen(t.stake)}</td></tr>
            ${t.reason ? `<tr class="why"><td colspan="3">${esc(t.reason)}</td></tr>` : ""}`).join("")}</tbody></table>
          <div class="pmeta"><span>合計 <b>${yen(s.total)}</b></span>${s.p_any != null ? `<span>的中確率 ${pct(s.p_any, 0)}</span>` : ""}${s.ev != null ? `<span>期待値 ${s.ev.toFixed(2)}</span>` : ""}</div>
          <p class="note">${esc(s.reason || "")}</p>`;
      return `<section class="splan ${P.recommended === k ? "rec" : ""}"><header><b>${m.name}</b><span class="risk r-${m.risk}">リスク${m.risk}</span>${P.recommended === k ? '<span class="chip done">おすすめ</span>' : ""}</header>
        <p class="ssub">${m.sub}${v?.full_roi != null ? `・過去の検証 ${pct(v.full_roi, 0)}` : v?.test_roi != null ? `・検証 ${pct(v.test_roi, 0)}` : ""}</p>${body}</section>`;
    }).join("")}</div><p class="note">金額は総資金 10 万円の場合（1 口＝総資金の 0.1%）。期待値は過去の同じ条件の買い目の実績で補正した値です。</p>`;
  }
  function oldRec(rec) {
    if (rec.action !== "bet") return `<div class="sheet"><h3>AI の買い方：見送り</h3><p>${esc((rec.reasons || [])[0] || "")}</p></div>`;
    return `<div class="sheet"><h3>AI の買い方　合計 ${yen(rec.total)}</h3><table class="t compact"><tbody>
      ${rec.tickets.map((t) => `<tr><td><b>${esc(t.type)}</b></td><td>${esc(t.combo)}</td><td class="r">${yen(t.stake)}</td></tr>`).join("")}</tbody></table></div>`;
  }

  function slopeChart(result) {
    const rows = result.filter((r) => r.ai_rank && r.pos);
    if (!rows.length) return "";
    const pick = rows.filter((r) => r.ai_rank <= 3 || r.pos <= 3);
    const maxR = Math.max(6, ...pick.map((r) => Math.max(r.ai_rank, r.pos)));
    const W = 560, top = 34, rowH = 26, H = top + maxR * rowH + 10, xl = 150, xr = W - 150;
    const y = (k) => top + (k - 0.5) * rowH;
    let s = `<svg class="slope" viewBox="0 0 ${W} ${H}" role="img" aria-label="AI の予想順位と実際の着順の対応">
      <text x="${xl}" y="18" text-anchor="end" font-size="12" fill="#6E6A5F">AI の予想順位</text><text x="${xr}" y="18" font-size="12" fill="#6E6A5F">実際の着順</text>`;
    for (let k = 1; k <= maxR; k++) {
      s += `<text x="${xl + 20}" y="${y(k) + 4}" font-size="11" text-anchor="middle" fill="#9C9583">${k}</text><text x="${xr - 20}" y="${y(k) + 4}" font-size="11" text-anchor="middle" fill="${k <= 3 ? "#1B1A17" : "#9C9583"}" font-weight="${k <= 3 ? 700 : 400}">${k}</text>`;
    }
    s += `<line x1="${xr - 34}" x2="${xr - 6}" y1="${y(3) + rowH / 2}" y2="${y(3) + rowH / 2}" stroke="#B8202B" stroke-dasharray="3 2"/>`;
    pick.sort((a, b) => a.ai_rank - b.ai_rank).forEach((r) => {
      const good = r.ai_rank <= 3 && r.pos <= 3, missed = r.ai_rank > 3 && r.pos <= 3;
      const col = good ? "#1F3A5F" : missed ? "#B8202B" : "#9C9583";
      s += `<line x1="${xl + 32}" y1="${y(r.ai_rank)}" x2="${xr - 32}" y2="${y(r.pos)}" stroke="${col}" stroke-width="${good ? 2.6 : 1.6}" ${good || missed ? "" : 'stroke-dasharray="4 3"'}/>
        <text x="${xl}" y="${y(r.ai_rank) + 4}" text-anchor="end" font-size="12.5" fill="${col}" font-weight="${r.ai_rank <= 3 ? 700 : 400}">${esc(r.umaban)}番 ${esc(r.horse).slice(0, 9)}</text>
        <text x="${xr}" y="${y(r.pos) + 4}" font-size="12.5" fill="${col}" font-weight="${r.pos <= 3 ? 700 : 400}">${esc(r.horse).slice(0, 9)}（${esc(r.pop ?? "-")}人気）</text>`;
    });
    return s + "</svg>";
  }
  function hitBanner(h) {
    if (!h) return "";
    const items = [];
    if (h.ai1_win) items.push('<span class="hb big">◎ AI 1位が 1 着 的中</span>');
    if (h.exact) items.push('<span class="hb big">AI 上位 3 頭が着順どおり（三連単）</span>');
    else if (h.trio) items.push('<span class="hb">AI 上位 3 頭で三連複 的中</span>');
    if (!h.trio && h.ai_top3_in_top3 >= 2) items.push(`<span class="hb">AI 上位 3 頭のうち ${h.ai_top3_in_top3} 頭が 3 着以内</span>`);
    if (!items.length) items.push(`<span class="hb muted">AI 上位 3 頭のうち 3 着以内は ${h.ai_top3_in_top3} 頭</span>`);
    return `<div class="hitbanner">${items.join("")}</div>`;
  }
  function verdictBlock(result, field) {
    const byRank = {};
    result.forEach((r) => { if (r.ai_rank) byRank[r.ai_rank] = r; });
    const lab = ["◎ AI 1位", "○ AI 2位", "▲ AI 3位"];
    return `<div class="verdict">${[1, 2, 3].map((k) => {
      const r = byRank[k];
      if (!r) return `<div class="vc"><div class="vk">${lab[k - 1]}</div><div class="vh">—</div></div>`;
      return `<div class="vc ${r.pos && r.pos <= 3 ? "vhit" : ""}">${r.pos && r.pos <= 3 ? '<span class="vstamp">的中</span>' : ""}<div class="vk">${lab[k - 1]}</div><div class="vh">${gate(r, field)} ${esc(r.horse)}</div>
        <div class="vr ${r.pos === 1 ? "plus" : ""}">${r.pos ? r.pos + "<small>着</small>" : "<small>取消・除外</small>"}</div><div class="vk">${esc(r.pop ?? "-")}番人気・${esc(r.odds ?? "-")}倍</div></div>`;
    }).join("")}</div>`;
  }
  function resultTable(result, field) {
    return `<div class="tbl-wrap"><table class="t"><thead><tr><th>着</th><th>馬番</th><th>馬名</th><th class="r">人気</th><th class="r">オッズ</th><th class="r">AI予想</th><th class="hide-sm">差</th></tr></thead><tbody>
      ${result.filter((r) => r.pos).sort((a, b) => a.pos - b.pos).slice(0, 8).map((r) => {
        const d = r.ai_rank ? r.ai_rank - r.pos : null;
        return `<tr class="${r.pos <= 3 && r.ai_rank <= 3 ? "hit" : ""}"><td class="pos ${r.pos === 1 ? "p1" : ""}">${r.pos}</td><td>${gate(r, field)}</td><td class="nm">${esc(r.horse)}</td>
        <td class="r">${esc(r.pop ?? "—")}</td><td class="r">${esc(r.odds ?? "—")}</td><td class="r"><b>${r.ai_rank ? r.ai_rank + "位" : "—"}</b></td>
        <td class="hide-sm muted">${d == null ? "" : d === 0 ? "予想どおり" : d > 0 ? `予想より ${d} つ上` : `予想より ${-d} つ下`}</td></tr>`;
      }).join("")}</tbody></table></div><p class="note">緑の行は AI の上位 3 頭が 3 着以内に入った馬。</p>`;
  }
  function paysTable(pays) {
    const order = ["単勝", "複勝", "枠連", "馬連", "ワイド", "馬単", "三連複", "三連単"];
    const rows = order.filter((k) => pays && pays[k] && pays[k].length);
    if (!rows.length) return "";
    return `<table class="t pays"><tbody>${rows.map((k) => `<tr><th>${k}</th><td>${pays[k].map((e) => `<span class="num">${e.nums.join("-")}</span>　<b class="num">${num(e.pay)}円</b>`).join("<br>")}</td></tr>`).join("")}</tbody></table>`;
  }
  // 4 つの買い方の収支比較（結果が出たレース）
  function strategyCompare(V, P) {
    const S = V.strategies;
    if (!S) return V.settle ? `<p>回収率 ${roiTag(V.settle.ret / V.settle.stake)}</p>` : empty("このレースは買い方の記録がありません。");
    const rec = P?.recommended || V.recommended || "ai";
    const ks = SORDER.filter((k) => S[k]);
    const rows = ks.map((k) => {
      const s = S[k], plan = P?.strategies?.[k];
      const roi = s.stake ? s.ret / s.stake : null;
      const res = s.skip || !s.stake ? '<span class="res-skip">見送り</span>' : s.ret > 0 ? '<span class="res-hit">的中</span>' : '<span class="res-miss">不的中</span>';
      const tk = s.skip || !s.stake ? "" : (s.tickets || plan?.tickets || []).map((t) => `<span class="tk ${t.ret > 0 ? "hit" : ""}">${esc(t.type)} ${esc(t.combo)}</span>`).join(" ");
      return `<tr class="${k === rec ? "rec" : ""}"><td><b>${STRAT[k].name}</b>${k === rec ? ' <span class="chip done">おすすめ</span>' : ""}<div class="tks">${tk}</div></td>
        <td class="c">${res}</td><td class="r"><b>${roi == null ? "—" : roiTag(roi)}</b></td></tr>`;
    }).join("");
    const money = ks.filter((k) => S[k].stake).map((k) => `<tr><td>${STRAT[k].name}</td><td class="r">${yen(S[k].stake)}</td><td class="r">${yen(S[k].ret)}</td></tr>`).join("");
    return `<div class="tbl-wrap"><table class="t scmp"><thead><tr><th>買い方・買い目</th><th class="c">結果</th><th class="r">回収率</th></tr></thead><tbody>${rows}</tbody></table></div>
      ${money ? `<details class="more"><summary>金額で見る（1 口 100 円の場合）</summary><div><table class="t compact"><thead><tr><th>買い方</th><th class="r">購入</th><th class="r">払戻</th></tr></thead><tbody>${money}</tbody></table></div></details>` : ""}
      <p class="note">すべて発走前に決めた買い目で計算しています（結果を見てから選び直したものではありません）。回収率 100% で購入額と同じ払戻。${V.strategies_note ? esc(V.strategies_note) : ""}</p>`;
  }
  function factorTable(M, hs, field, posMap) {
    const F = M.factor_names || [], H = M.horses || {};
    const order = (hs || []).map((h) => String(h.umaban)).filter((u) => H[u]);
    const rows = (order.length ? order : Object.keys(H)).map((u) => {
      const x = H[u], ps = posMap?.[u];
      return `<tr class="${ps && ps <= 3 ? "hit" : ""}"><td class="nm">${gate({ umaban: u }, field)} ${esc(x.horse)}${ps ? ` <small class="muted">${ps}着</small>` : ""}</td>
        ${F.map((k) => { const v = x.factors?.[k]; return `<td class="fc ${v >= 70 ? "hi" : ""}" style="--v:${v == null ? 0 : v}" title="${esc(k)} ${v ?? "—"}">${v == null ? "—" : v}</td>`; }).join("")}</tr>`;
    }).join("");
    return `<div class="tbl-wrap"><table class="t ftab"><thead><tr><th>馬</th>${F.map((k) => `<th class="c" title="${esc(M.factor_help?.[k] || "")}">${esc(k)}</th>`).join("")}</tr></thead><tbody>${rows}</tbody></table></div>
      <details class="more"><summary>評価要素の意味</summary><div><table class="t compact"><tbody>${F.map((k) => `<tr><th>${esc(k)}</th><td>${esc(M.factor_help?.[k] || "")}</td></tr>`).join("")}</tbody></table>
      <p class="note">点数は今回の出走馬の中での相対評価（0〜100、100 が最も高い）。色が濃いほど高評価です。</p></div></details>`;
  }
  function storyCards(M, hs, field, posMap) {
    const H = M.horses || {};
    const order = (hs || []).map((h) => String(h.umaban)).filter((u) => H[u]);
    const list = order.length ? order : Object.keys(H);
    const card = (u) => { const x = H[u], ps = posMap?.[u];
      return `<article class="story ${ps && ps <= 3 ? "hit" : ""}"><header>${gate({ umaban: u }, field)} <b>${esc(x.horse)}</b>
        <span class="muted">AI能力 ${x.ai_rank ?? "—"}位・${x.pop ?? "—"}番人気</span>${ps ? `<span class="spos ${ps <= 3 ? "on" : ""}">${ps}着</span>` : ""}</header>
        <p>${esc(x.story || "")}</p>${(x.strong || []).length ? `<div class="tags">${x.strong.map((k) => `<span class="tag up">${esc(k)}</span>`).join("")}${(x.weak || []).map((k) => `<span class="tag dn">${esc(k)}</span>`).join("")}</div>` : ""}</article>`; };
    return `<div class="stories">${list.slice(0, 6).map(card).join("")}</div>
      ${list.length > 6 ? `<details class="more"><summary>ほかの ${list.length - 6} 頭の解説</summary><div class="stories">${list.slice(6).map(card).join("")}</div></details>` : ""}`;
  }
  // 戻るボタン（アプリ内の履歴があれば戻り、無ければ一覧へ）
  const backBar = (label, sticky) => `<div class="backbar ${sticky ? "sticky" : ""}"><button type="button" class="backbtn" data-act="back" aria-label="前の画面に戻る">‹ 戻る</button><span class="crumb">${esc(label || "")}</span></div>`;
  function sameDayNav(r, list) {
    if (!list || list.length < 2) return "";
    const courses = [...new Set(list.map((x) => x.course))];
    const mine = list.filter((x) => x.course === r.course).sort((a, b) => (a.race_num || 0) - (b.race_num || 0));
    const i = mine.findIndex((x) => x.race_id === r.race_id);
    const prev = mine[i - 1], next = mine[i + 1];
    return `<nav class="sdnav" aria-label="同じ日のレース">
      <div class="sd-row">${prev ? `<a class="ib" href="#/race/${encodeURIComponent(prev.race_id)}" aria-label="前のレース">‹</a>` : '<span class="ib off">‹</span>'}
      <div class="rchips">${mine.map((x) => `<a class="rc ${x.race_id === r.race_id ? "on" : ""}" href="#/race/${encodeURIComponent(x.race_id)}">${esc(x.race_num)}R</a>`).join("")}</div>
      ${next ? `<a class="ib" href="#/race/${encodeURIComponent(next.race_id)}" aria-label="次のレース">›</a>` : '<span class="ib off">›</span>'}</div>
      <p class="swipe-hint">左右にスワイプで前後のレースへ</p>
      ${courses.length > 1 ? `<div class="sd-c">${courses.map((c) => { const f = list.filter((x) => x.course === c).sort((a, b) => (a.race_num || 0) - (b.race_num || 0)); const pick = f.find((x) => x.race_num === r.race_num) || f[0]; return `<a class="cc ${c === r.course ? "on" : ""}" href="#/race/${encodeURIComponent(pick.race_id)}">${esc(c)}</a>`; }).join("")}</div>` : ""}
    </nav>`;
  }

  async function viewRace(tok, id) {
    setNav("races");
    const r = await getRace(id);
    if (tok !== routeTok) return;
    if (!r) { app.innerHTML = empty("レースが見つかりません。"); return; }
    const [pred, review, sameDay, M] = await Promise.all([getPrediction(id), getReview(id), queryRaces({ date: r.race_date, order: "asc", limit: 60 }).catch(() => []), getMember(id)]);
    if (tok !== routeTok) return;
    const P = pred?.payload, V = review?.payload;
    const posMap = {};
    (V?.result || []).forEach((x) => { if (x.pos) posMap[x.umaban] = x.pos; });
    const member = !!state.session || DEMO;
    let html = backBar(`${fmtDate(r.race_date)} ${r.course || ""} ${r.race_num ? r.race_num + "R" : ""}`, true) + sameDayNav(r, sameDay) + `<div class="race-head"><div class="meta">${fmtDate(r.race_date, true)}　${esc(r.course)} ${r.race_num ? esc(r.race_num) + "R" : ""}　${fmtTime(r.post_time)}発走</div>
      <h1>${esc(r.race_name)} ${gradeChip(r.grade)}</h1><div>${surfChip(r.surface)} <span class="chip">${esc(r.distance)}m</span> <span class="chip">${esc(r.field)}頭</span>
      ${P?.character?.kind ? `<span class="chip">${esc(P.character.kind)}</span>` : ""}${(P?.pre === false || V?.pre === false) ? '<span class="chip post">事後予想（参考）</span>' : ""}</div>
      ${(P?.pre === false || V?.pre === false) ? `<p class="note postnote">${esc(P?.post_note || "発走後に予想したレース（事後予想・参考）です。通算成績には含めていません。")}</p>` : ""}</div>`;
    if (V && V.result) {
      const R = M?.review;
      html += `<div class="h-sec"><h2>結果</h2><span class="aside">AI の上位 3 頭は何着だったか</span></div>${hitBanner(V.hits)}${verdictBlock(V.result, r.field)}
        <div class="h-sec"><h2>買い方ごとの結果</h2></div>${R ? strategyCompare({ ...V, strategies: R.strategies, recommended: R.recommended, strategies_note: M.strategies_note }, { ...P, strategies: M.strategies, recommended: M.recommended })
          : member ? noData() : memberLock("4 つの買い方の結果は会員限定です", "AI推奨・安定型・バランス型・高配当型の買い目と、それぞれの回収率・的中を見られます。")}
        <div class="cols c2" style="margin-top:12px"><div>${resultTable(V.result, r.field)}</div><div class="sheet">${slopeChart(V.result)}
        <p class="note">左が AI の予想順位、右が実際の着順。藍＝予想上位 3 頭が 3 着以内、朱＝予想 4 位以下から 3 着以内、点線＝予想上位だが 4 着以下。</p></div></div>
        <div class="h-sec"><h2>配当</h2></div>${paysTable(V.pays)}
        ${R?.review_md ? `<div class="h-sec"><h2>振り返り</h2></div><div class="sheet md">${md(R.review_md)}</div>` : ""}`;
    }
    if (P) {
      const horses = P.horses || [];
      const body = `<div class="h-sec"><h2>AI の予想</h2><span class="aside">${esc(P.model_version || "")}</span></div>${horsesTable(horses, r.field, V ? posMap : null)}
        ${P.character?.text ? `<div class="sheet"><h3>レースの性格：${esc(P.character.kind || "")}</h3><p>${esc(P.character.text)}</p></div>` : ""}
        <div class="h-sec"><h2>買い方と選んだ理由</h2><span class="aside">会員限定</span></div>
        ${M?.strategies ? strategyPlans({ strategies: M.strategies, recommended: M.recommended, strategy_stats: M.strategy_stats })
          : member ? noData() : memberLock("買い方と、その馬を選んだ理由は会員限定です", "4 つの買い方の買い目・金額・期待値と、1 点ごとの選んだ理由を見られます。")}
        <div class="h-sec"><h2>評価要素の点数</h2><span class="aside">会員限定</span></div>
        ${M?.horses ? factorTable(M, horses, r.field, V ? posMap : null)
          : member ? noData() : memberLock("評価要素ごとの点数は会員限定です", "能力・近走・末脚・距離・コース・馬場・展開・騎手・厩舎・血統・状態の 11 項目を、馬ごとに見られます。")}
        <div class="h-sec"><h2>馬ごとの AI 解説</h2><span class="aside">会員限定</span></div>
        ${M?.horses ? storyCards(M, horses, r.field, V ? posMap : null)
          : member ? noData() : memberLock("馬ごとの AI 解説は会員限定です", "前走・近走の成績、調教の時計、スピード指数などをもとにした解説を見られます。")}
        ${M?.preview_md ? `<details class="more"><summary>レース全体の解説</summary><div class="md">${md(M.preview_md)}</div></details>` : ""}`;
      html += V ? `<details class="more" open><summary>レース前の予想と、評価・解説（発走前の内容）</summary><div>${body}</div></details>` : body;
    } else if (!V) {
      const t = await getTeaser(id);
      if (tok !== routeTok) return;
      html += `<div class="lockbox"><h3>このレースの予想は、発走前はゴールド会員限定です</h3>
        <p>${t ? `レースの性格：<b>${esc(t.teaser?.character || "—")}</b>・${esc(t.teaser?.n_horses || "")}頭` : ""}</p>
        <p class="note">発走時刻（${fmtTime(r.post_time)}）を過ぎると、予想と結果を閲覧できます（評価の詳細と解説は会員限定）。</p>
        <div class="cta center"><a class="btn shu" href="#/account">${state.session ? "ゴールド会員について" : "ログイン・会員登録"}</a></div></div>`;
    }
    app.innerHTML = html;
    const on = app.querySelector(".rchips .on");
    if (on) on.scrollIntoView({ block: "nearest", inline: "center" });
  }

  // ---------------- 成績 ----------------
  async function viewStats(tok) {
    setNav("stats");
    const [perf, det, idx] = await Promise.all([getPerf(), getMemberPerf("detail"), getIndex()]);
    if (tok !== routeTok) return;
    const pub = perf?.payload || {};
    const p = det || pub;
    const sl = p.strategies_live || {}, sb2 = det ? (p.strategies_backtest || {}) : {};
    let html = `<div class="h-sec"><h2>買い方ごとの通算成績</h2><span class="aside">発走前に予想して公開したレースだけ・外れも含めて全件</span></div>`;
    const liveRows = (p.n_pre ?? 1) > 0 ? SORDER.filter((k) => sl[k]) : [];
    html += liveRows.length ? `<div class="tbl-wrap"><table class="t"><thead><tr><th>買い方</th><th class="r">レース</th><th class="r">的中率</th><th class="r">回収率</th><th class="hide-sm"></th></tr></thead><tbody>
      ${liveRows.map((k) => { const s = sl[k], roi = s.stake ? s.ret / s.stake : null; if (!s.stake) return `<tr><td><b>${STRAT[k].name}</b><div class="muted">${STRAT[k].sub}</div></td><td colspan="4" class="muted">これまでのレースはすべて見送り（期待値が基準に届かなかったため）</td></tr>`;
        return `<tr><td><b>${STRAT[k].name}</b><div class="muted">${STRAT[k].sub}</div></td><td class="r">${num(s.n)}</td><td class="r">${pct(s.hit / s.n, 0)}</td><td class="r"><b>${roiTag(roi, 1)}</b></td><td class="hide-sm">${roiBar(roi)}</td></tr>`; }).join("")}
      </tbody></table></div>
      <details class="more"><summary>金額で見る（1 口 100 円の場合）</summary><div><table class="t compact"><thead><tr><th>買い方</th><th class="r">購入</th><th class="r">払戻</th></tr></thead><tbody>
      ${liveRows.filter((k) => sl[k].stake).map((k) => `<tr><td>${STRAT[k].name}</td><td class="r">${yen(sl[k].stake)}</td><td class="r">${yen(sl[k].ret)}</td></tr>`).join("")}</tbody></table></div></details>
      ${p.strategies_live_note ? `<p class="note">${esc(p.strategies_live_note)}</p>` : ""}
      ${Object.keys(idx).length ? `<div class="sheet" style="margin-top:12px"><h3>回収率の推移（通算）</h3><div class="chart"><canvas id="cum4"></canvas></div></div>` : ""}`
      : empty("発走前に予想して公開したレースの結果が出ると、ここに買い方ごとの通算成績を表示します。");
    const sa = p.strategies_after || {};
    if (SORDER.some((k) => sa[k]?.stake)) {
      html += `<div class="h-sec"><h2>参考：発走後に予想したレース</h2><span class="aside">${num(p.n_post || 0)} レース・通算成績には含めない</span></div>
        <div class="tbl-wrap"><table class="t"><thead><tr><th>買い方</th><th class="r">購入レース</th><th class="r">的中率</th><th class="r">回収率</th></tr></thead><tbody>
        ${SORDER.map((k) => { const x = sa[k] || {}; return x.stake ? `<tr><td><b>${STRAT[k].name}</b></td><td class="r">${num(x.n)}</td><td class="r">${pct(x.hit / x.n, 0)}</td><td class="r">${roiTag(x.ret / x.stake, 1)}</td></tr>`
          : `<tr><td><b>${STRAT[k].name}</b></td><td colspan="3" class="muted">すべて見送り</td></tr>`; }).join("")}</tbody></table></div>
        <p class="note">${esc(p.strategies_after_note || "")}</p>`;
    }
    if (!det) {
      const bt = pub.strategies_backtest || {};
      html += `<div class="h-sec"><h2>過去データでの検証</h2></div>
        <div class="scards">${SORDER.filter((k) => bt[k]).map((k) => `<div class="scard"><span class="sn">${STRAT[k].name}<small>${STRAT[k].sub}</small></span><span class="sv">${roiTag(bt[k].full_roi)}</span>${roiBar(bt[k].full_roi)}<span class="ss">2016〜2026 年の通算回収率</span></div>`).join("")}</div>
        ${memberLock("詳しい検証結果は会員限定です", "年ごとの回収率、選択期間と検証期間の比較、信頼区間、予想の精度（人気順との比較）などを見られます。")}`;
    }
    if (Object.keys(sb2).length) {
      html += `<div class="h-sec"><h2>過去データでの検証</h2><span class="aside">${esc(p.strategies_backtest_period || "")}</span></div>
        <div class="tbl-wrap"><table class="t"><thead><tr><th>買い方</th><th class="r">購入率</th><th class="r">的中率</th><th class="r">2016〜20<br><small>選択</small></th><th class="r">2021〜26<br><small>検証</small></th><th class="r">2016〜26<br><small>通算</small></th><th class="r hide-sm">90%区間<br><small>検証</small></th><th class="r hide-sm">高額配当<br><small>を除く</small></th></tr></thead><tbody>
        ${SORDER.filter((k) => sb2[k]).map((k) => { const s = sb2[k]; return `<tr><td><b>${STRAT[k].name}</b><div class="muted">${esc(s.rule || "")}</div></td><td class="r">${pct(s.coverage, 0)}</td><td class="r">${pct(s.hit_rate, 0)}</td>
          <td class="r ${roiCls(s.dev_roi)}">${pct(s.dev_roi)}</td><td class="r ${roiCls(s.test_roi)}"><b>${pct(s.test_roi)}</b></td><td class="r ${roiCls(s.full_roi)}">${pct(s.full_roi)}</td><td class="r hide-sm">${s.ci90 ? pct(s.ci90[0], 0) + "〜" + pct(s.ci90[1], 0) : "—"}</td><td class="r hide-sm">${pct(s.trimmed)}</td></tr>`; }).join("")}
        </tbody></table></div><div class="sheet" style="margin-top:12px"><h3>年ごとの回収率</h3><div class="chart"><canvas id="yr4"></canvas></div></div>
        <p class="note">${esc(p.strategies_backtest_note || "")}</p>`;
    }
    const acc = det ? p.accuracy : null;
    if (acc && acc.rows) {
      html += `<div class="h-sec"><h2>予想の精度</h2><span class="aside">${esc(acc.period || "")}</span></div>
        <div class="tbl-wrap"><table class="t"><thead><tr><th>指標</th><th class="r">AI（統合）</th><th class="r">AI独自</th><th class="r">人気順</th></tr></thead><tbody>
        ${acc.rows.map((x) => `<tr><td>${esc(x.label)}<div class="muted">${esc(x.note || "")}</div></td><td class="r"><b>${x.fmt === "n" ? (x.ai ?? 0).toFixed(2) : pct(x.ai)}</b></td><td class="r">${x.ai_only == null ? "—" : x.fmt === "n" ? x.ai_only.toFixed(2) : pct(x.ai_only)}</td>
          <td class="r">${x.fmt === "n" ? (x.mkt ?? 0).toFixed(2) : pct(x.mkt)}</td></tr>`).join("")}
        </tbody></table></div>`;
    }
    html += `<details class="more"><summary>この成績の読み方</summary><div><p>回収率 100% が収支トントンです。JRA の払戻率は券種により 70〜80% で、全馬券を買い続けると長期では 70〜80% 程度に収束します。
      成績は良く見せるための選別をせず、見送りや外れも含めて掲載しています。過去の検証は、その年より前のデータだけで作ったモデルと買い方で計算しています。</p></div></details>`;
    app.innerHTML = html;
    const colors = { ai: "#1B1A17", stable: "#1F3A5F", balance: "#3F6B3A", high: "#B8202B" };
    const rows = Object.values(idx).sort((x, y) => (x.date || "").localeCompare(y.date || ""));
    if (rows.length) {
      const acc = {}, ser = {};
      rows.forEach((x) => SORDER.forEach((k) => {
        const a = acc[k] || (acc[k] = { s: 0, r: 0 });
        a.s += x.stakes?.[k] || 0; a.r += x.rets?.[k] || 0;
        (ser[k] || (ser[k] = [])).push(a.s ? Math.round((a.r / a.s) * 1000) / 10 : null);
      }));
      makeChart("cum4", { type: "line", data: { labels: rows.map((x, i) => `${i + 1}`), datasets: SORDER.filter((k) => ser[k].some((v) => v != null)).map((k) => ({ label: STRAT[k].name, data: ser[k], borderColor: colors[k], borderWidth: 2, pointRadius: 2, tension: 0, spanGaps: true })) },
        options: { responsive: true, maintainAspectRatio: false, animation: false, plugins: { legend: { position: "bottom" } },
          scales: { x: { title: { display: true, text: "レース（古い順）" } }, y: { suggestedMin: 0, suggestedMax: 150, ticks: { callback: (v) => v + "%" } } } } });
    }
    const ks = SORDER.filter((k) => sb2[k]?.by_year);
    if (ks.length) {
      const ys = [...new Set(ks.flatMap((k) => Object.keys(sb2[k].by_year)))].sort();
      makeChart("yr4", { type: "bar", data: { labels: ys, datasets: ks.map((k) => ({ label: STRAT[k].name, data: ys.map((y) => (sb2[k].by_year[y] ?? null) * 100), backgroundColor: colors[k] })) },
        options: { responsive: true, maintainAspectRatio: false, animation: false, plugins: { legend: { position: "bottom" } }, scales: { y: { suggestedMin: 50, ticks: { callback: (v) => v + "%" } } } } });
    }
  }

  // ---------------- 会員 ----------------
  async function viewAccount(tok, msg) {
    setNav("account");
    if (DEMO) { app.innerHTML = empty("デモ表示中のため、ログインは利用できません（接続設定後に有効になります）。"); return; }
    if (!state.session) {
      app.innerHTML = `<div class="h-sec"><h2>ログイン・会員登録</h2></div>${msg || ""}
        <div class="cols c2"><div class="sheet"><h3>ログイン</h3><form class="form" id="f-login">
          <input type="email" name="email" placeholder="メールアドレス" autocomplete="email" required>
          <input type="password" name="pw" placeholder="パスワード" autocomplete="current-password" required minlength="8">
          <button class="btn" type="submit">ログイン</button></form></div>
        <div class="sheet"><h3>無料会員登録</h3><p class="note">無料会員になると、評価要素の点数・馬ごとの AI 解説・4 つの買い方と選んだ理由・詳しい成績を閲覧できます（発走後のレース）。発走前の予想はゴールド会員限定です。</p>
          <form class="form" id="f-signup"><input type="email" name="email" placeholder="メールアドレス" autocomplete="email" required>
          <input type="password" name="pw" placeholder="パスワード（12文字以上推奨）" autocomplete="new-password" required minlength="8">
          <button class="btn ghost" type="submit">登録する</button></form></div></div>`;
      return;
    }
    const p = state.profile || {};
    app.innerHTML = `<div class="h-sec"><h2>会員情報</h2></div>${msg || ""}
      <div class="cols c2"><div class="sheet"><h3>${esc(p.email || state.session.user.email)}</h3>
        <p>会員種別：<b>${roleLabel()}</b><br>購読状態：${esc(p.subscription_status || "none")}${p.subscription_current_period_end ? "（" + new Date(p.subscription_current_period_end).toLocaleDateString("ja-JP") + " まで）" : ""}</p>
        <button type="button" class="btn ghost" data-act="logout">ログアウト</button></div>
      <div class="sheet"><h3>ゴールド会員（発走前の AI 予想）</h3>
        <p>発走前の予想・4 つの買い方・レース前の解説をすべて閲覧できます。</p>
        ${isPremium() ? '<p class="alert ok">現在、すべての予想を閲覧できます。</p>'
          : CFG.SUBSCRIBE_URL ? `<a class="btn shu" href="${esc(CFG.SUBSCRIBE_URL)}" rel="noopener">購読する</a>` : '<button type="button" class="btn" disabled>購読の受付は準備中です</button>'}</div></div>`;
  }

  function viewAbout() {
    setNav("about");
    app.innerHTML = `<div class="h-sec"><h2>見方</h2></div><div class="steps">
      <div class="sheet"><div><h3>AI独自と勝率</h3><p>「AI独自」はオッズを使わず、スピード指数・上がり・近走・適性・調教・騎手などから出した能力の順位。「勝率」はそれに市場（オッズ）の情報を合わせた確率です。</p></div></div>
      <div class="sheet"><div><h3>4 つの買い方</h3><p><b>AI推奨</b>：統合の期待値と AI 能力評価の期待値の両方が基準を超えた買い目だけを最大 3 点。無ければ見送り。<b>安定型</b>：複勝・ワイド中心で当たりやすさ重視。<b>バランス型</b>：毎レース期待値が最も高い買い目。<b>高配当型</b>：三連複・馬連の高配当を最大 3 点。</p></div></div>
      <div class="sheet"><div><h3>期待値</h3><p>1.00 で長期的に収支トントン。過去の同じ条件の買い目が実際にどれだけ戻ったかで補正しています。</p></div></div>
      <div class="sheet"><div><h3>会員の種類</h3><div class="tbl-wrap"><table class="t compact"><thead><tr><th></th><th class="c">ゲスト</th><th class="c">無料会員</th><th class="c">ゴールド会員</th></tr></thead><tbody>
        <tr><td>結果・的中・配当・AI の印と勝率（発走後）</td><td class="c">○</td><td class="c">○</td><td class="c">○</td></tr>
        <tr><td>評価要素の点数・馬ごとの AI 解説（発走後）</td><td class="c">—</td><td class="c">○</td><td class="c">○</td></tr>
        <tr><td>4 つの買い方・選んだ理由・買い方ごとの結果</td><td class="c">—</td><td class="c">○</td><td class="c">○</td></tr>
        <tr><td>詳しい成績・検証結果</td><td class="c">—</td><td class="c">○</td><td class="c">○</td></tr>
        <tr><td>発走前の予想・買い方・解説</td><td class="c">—</td><td class="c">—</td><td class="c">○</td></tr></tbody></table></div></div></div>
      <div class="sheet"><div><h3>答え合わせ</h3><p>結果が出たら、AI の上位 3 頭の着順と、4 つの買い方それぞれの収支を表示します。外れたレースもそのまま残します。</p></div></div></div>`;
  }

  // ---------------- ルーター（最後の操作だけを描画） ----------------
  let routeTok = 0;
  const hist = [];   // アプリ内の移動履歴（戻るボタン用）
  function goBack() {
    if (hist.length > 1) history.back();
    else location.hash = location.hash.startsWith("#/race/") ? "#/races" : "#/races?tab=all";
  }
  async function route() {
    const tok = ++routeTok;
    const cur = location.hash || "#/";
    if (hist.length > 1 && hist[hist.length - 2] === cur) hist.pop(); else if (hist[hist.length - 1] !== cur) hist.push(cur);
    if (hist.length > 50) hist.shift();
    destroyCharts();
    const h = location.hash || "#/";
    const path = h.split("?")[0];
    document.body.classList.add("busy");
    try {
      if (path.startsWith("#/race/")) await viewRace(tok, decodeURIComponent(path.slice(7)));
      else if (path === "#/races") await viewRaces(tok);
      else if (path === "#/stats") await viewStats(tok);
      else if (path === "#/account") await viewAccount(tok);
      else if (path === "#/about") viewAbout();
      else await viewHome(tok);
      if (tok === routeTok && !path.startsWith("#/races")) window.scrollTo(0, 0);
    } catch (e) {
      if (tok === routeTok) {
        app.innerHTML = `<div class="alert err">読み込みに失敗しました。通信状況をご確認ください。（${esc(e.message || e)}）</div>
          <div class="cta"><button type="button" class="btn" data-act="retry">再読み込み</button></div>`;
      }
    } finally {
      if (tok === routeTok) document.body.classList.remove("busy");
    }
  }
  let routeTimer = null;
  function scheduleRoute() { clearTimeout(routeTimer); routeTimer = setTimeout(route, 0); }

  // ---------------- 操作（document に 1 つだけ登録） ----------------
  let searchTimer = null;
  document.addEventListener("click", async (e) => {
    const el = e.target.closest("[data-act]");
    if (!el || el.tagName === "SELECT" || el.tagName === "INPUT") return;
    const act = el.dataset.act, f = parseQuery();
    if (act === "tab") { setQuery({ ...f, tab: el.dataset.v, date: "", limit: "" }); }
    else if (act === "date") { setQuery({ ...f, tab: "all", date: el.dataset.v, month: el.dataset.v.slice(0, 7), limit: "" }); }
    else if (act === "month") { setQuery({ ...f, month: el.dataset.v }); }
    else if (act === "clear") { setQuery({ tab: f.tab }); }
    else if (act === "more") { setQuery({ ...f, limit: String(Number(f.limit || 120) + 120) }); }
    else if (act === "retry") { clearCache(); scheduleRoute(); }
    else if (act === "back") { goBack(); }
    else if (act === "hf") {
      document.querySelectorAll(".fchip").forEach((b) => { const on = b === el; b.classList.toggle("on", on); b.setAttribute("aria-pressed", on); });
      const box = document.getElementById("home-done");
      if (box) box.innerHTML = homeDoneList(el.dataset.v);
    }
    else if (act === "logout") {
      if (el.disabled) return;
      el.disabled = true;
      await sb.auth.signOut();
      location.hash = "#/";
    }
  });
  document.addEventListener("change", (e) => {
    const el = e.target;
    if (el.dataset?.act === "filter") setQuery({ ...parseQuery(), [el.dataset.k]: el.value, limit: "" });
    if (el.dataset?.act === "date-input") setQuery({ ...parseQuery(), tab: el.value ? "all" : parseQuery().tab, date: el.value, month: el.value ? el.value.slice(0, 7) : "", limit: "" });
  });
  document.addEventListener("submit", async (e) => {
    const form = e.target;
    e.preventDefault();
    const btn = form.querySelector("button[type=submit]");
    if (btn?.disabled) return;
    const fd = new FormData(form);
    if (form.id === "f-search") {
      clearTimeout(searchTimer);
      setQuery({ ...parseQuery(), q: String(fd.get("q") || "").trim(), tab: parseQuery().tab || "all", limit: "" });
      return;
    }
    if (btn) btn.disabled = true;
    try {
      if (form.id === "f-login") {
        const { error } = await sb.auth.signInWithPassword({ email: fd.get("email"), password: fd.get("pw") });
        if (error) viewAccount(routeTok, `<div class="alert err">ログインできませんでした：${esc(error.message)}</div>`);
      } else if (form.id === "f-signup") {
        const { error } = await sb.auth.signUp({ email: fd.get("email"), password: fd.get("pw"), options: { emailRedirectTo: location.origin + location.pathname } });
        viewAccount(routeTok, error ? `<div class="alert err">登録できませんでした：${esc(error.message)}</div>` : '<div class="alert ok">確認メールを送りました。メール内のリンクを開くと登録が完了します。</div>');
      }
    } finally { if (btn) btn.disabled = false; }
  });
  // レース名の入力中は 0.5 秒止まってから検索（1 文字ごとに通信しない）
  document.addEventListener("input", (e) => {
    const el = e.target;
    if (el.form?.id !== "f-search") return;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      const v = el.value.trim();
      if (v === (parseQuery().q || "")) return;
      setQuery({ ...parseQuery(), q: v, tab: parseQuery().tab || "all", limit: "" });
    }, 500);
  });

  // スワイプ：レース詳細＝前後のレース、日付を選んだ一覧＝前日・翌日、それ以外＝画面下のタブの順に移動
  //   表やカレンダーなど横に動かす部品の上、画面の端（iPhone の「戻る」操作と重なる）から始まる操作は対象外
  const TABS = ["#/", "#/races", "#/stats", "#/account"];
  const TAB_NAME = { "#/": "トップ", "#/races": "レース", "#/stats": "成績", "#/account": "会員" };
  let sw = null;
  function toast(t) {
    let el = document.getElementById("toast");
    if (!el) { el = document.createElement("div"); el.id = "toast"; el.setAttribute("role", "status"); document.body.appendChild(el); }
    el.textContent = t; el.classList.add("show");
    clearTimeout(toast.t); toast.t = setTimeout(() => el.classList.remove("show"), 900);
  }
  function swipe(dir) {
    const h = location.hash || "#/", path = h.split("?")[0];
    if (path.startsWith("#/race/")) {
      const a = document.querySelector(`.sdnav a[aria-label="${dir === "next" ? "次のレース" : "前のレース"}"]`);
      if (a) { toast(dir === "next" ? "次のレース ›" : "‹ 前のレース"); location.hash = a.getAttribute("href"); }
      else toast(dir === "next" ? "この日の最後のレースです" : "この日の最初のレースです");
      return;
    }
    const f = parseQuery();
    if (path === "#/races" && f.date) { setQuery({ ...f, date: addDays(f.date, dir === "next" ? 1 : -1), limit: "" }); toast(dir === "next" ? "翌日 ›" : "‹ 前日"); return; }
    const i = TABS.indexOf(path === "" ? "#/" : path);
    if (i < 0) return;
    const j = i + (dir === "next" ? 1 : -1);
    if (j < 0 || j >= TABS.length) return;
    toast(dir === "next" ? `${TAB_NAME[TABS[j]]} ›` : `‹ ${TAB_NAME[TABS[j]]}`);
    location.hash = TABS[j];
  }
  document.addEventListener("touchstart", (e) => {
    sw = null;
    if (e.touches.length !== 1) return;
    const t = e.touches[0];
    if (t.clientX < 24 || t.clientX > window.innerWidth - 24) return;
    if (e.target.closest(".tbl-wrap, .rchips, .cal, .chart, .slope, input, select, textarea, .sd-c")) return;
    sw = { x: t.clientX, y: t.clientY, t: Date.now() };
  }, { passive: true });
  document.addEventListener("touchend", (e) => {
    if (!sw) return;
    const t = e.changedTouches[0], dx = t.clientX - sw.x, dy = t.clientY - sw.y, dt = Date.now() - sw.t;
    sw = null;
    if (dt > 700 || Math.abs(dx) < 70 || Math.abs(dx) < Math.abs(dy) * 1.8) return;
    swipe(dx < 0 ? "next" : "prev");
  }, { passive: true });

  async function init() {
    document.getElementById("today").textContent = new Date().toLocaleDateString("ja-JP", { year: "numeric", month: "long", day: "numeric", weekday: "short", ...JST });
    if (DEMO) document.getElementById("banner").innerHTML = '<div class="demo">デモ表示中：架空のデータです（接続設定 config.js が未設定）。</div>';
    window.addEventListener("hashchange", scheduleRoute);
    if (sb) {
      try {
        const { data } = await sb.auth.getSession();
        state.session = data.session;
        await loadProfile();
      } catch (e) { state.session = null; }
      // 注意：このコールバックの中で Supabase の処理を await すると、ライブラリ内部のロックで以後の通信が止まる（画面が固まる原因）。
      //       必ず setTimeout で外に出してから処理する。
      sb.auth.onAuthStateChange((ev, session) => {
        if (ev === "TOKEN_REFRESHED" || ev === "INITIAL_SESSION") { state.session = session; return; }
        setTimeout(async () => {
          const changed = (state.session?.user?.id || null) !== (session?.user?.id || null);
          state.session = session;
          if (!changed) return;
          clearCache();
          try { await loadProfile(); } catch (e) { state.profile = null; }
          scheduleRoute();
        }, 0);
      });
    }
    route();
  }
  init();
})();
