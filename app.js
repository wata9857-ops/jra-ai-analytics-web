// JRA AI 競馬アナリティクス — Web フロントエンド（GitHub Pages で配信する静的サイト）
//   ・データは Supabase から取得。レース前の予想は「有料会員・管理者」だけにデータベース（RLS）が返す。
//     この画面のコードには予想データもモデルも含まれない（ログインした人の権限で、その都度サーバーから受け取るだけ）。
//   ・接続設定が空のときは、架空のデータによるデモ表示。
//   ・v33: 結果の出たレースは「結果 → AI の予想が何着だったか → 収支 → 配当 → 振り返り → レース前の予想」の順に表示。
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
  // 損益：プラスは「+」、マイナスは「▲」（色だけに頼らない）
  const pl = (x) => (x == null || isNaN(x) ? "—" : x > 0 ? `<span class="plus">+${num(x)}円</span>` : x < 0 ? `<span class="minus">▲${num(-x)}円</span>` : "±0円");
  const roiCls = (r) => (r == null ? "" : r >= 1 ? "plus" : "minus");
  const fmtTime = (iso) => (iso ? new Date(iso).toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Tokyo" }) : "");
  const fmtDate = (s) => (s ? new Date(s + "T00:00:00+09:00").toLocaleDateString("ja-JP", { month: "long", day: "numeric", weekday: "short", timeZone: "Asia/Tokyo" }) : "");
  const gradeChip = (g) => (g && /^G[123]$/.test(g) ? `<span class="chip ${g.toLowerCase()}">${esc(g)}</span>` : g ? `<span class="chip">${esc(g)}</span>` : "");
  const surfChip = (s) => (s ? `<span class="chip ${String(s).startsWith("芝") ? "turf" : "dirt"}">${esc(s)}</span>` : "");
  const gate = (h) => { const w = h.waku || wakuOf(h.umaban, h._field); return `<span class="gate w${w || 1}">${esc(h.umaban)}</span>`; };
  // 枠番が無いデータ用：JRA の枠の決め方（頭数から算出）
  function wakuOf(u, n) {
    if (!u || !n) return 1;
    if (n <= 8) return u;
    const base = Math.floor(n / 8), extra = n % 8, start = 8 - extra; let k = 0;
    for (let w = 1; w <= 8; w++) { k += base + (w > start ? 1 : 0); if (u <= k) return w; }
    return 8;
  }
  const mkCls = (m) => (m?.startsWith("◎") ? "m1" : m?.startsWith("○") ? "m2" : m ? "m3" : "");

  let state = { session: null, profile: null };

  // ---------------- データ取得（デモ時は架空データ） ----------------
  const Demo = {
    races: [
      { race_id: "DEMO00000011", race_date: new Date(Date.now() + 864e5).toISOString().slice(0, 10), post_time: new Date(Date.now() + 864e5).toISOString(), course: "東京", race_num: 11, race_name: "デモステークス", grade: "G2", surface: "芝", distance: 1800, field: 12, status: "scheduled" },
      { race_id: "DEMO00000009", race_date: new Date(Date.now() - 864e5).toISOString().slice(0, 10), post_time: new Date(Date.now() - 864e5).toISOString(), course: "京都", race_num: 9, race_name: "サンプル特別", grade: "", surface: "ダート", distance: 1400, field: 10, status: "finished",
        summary: { winner: "デモホースB", ai_top1_pos: 2, net: 380 } },
    ],
    prediction(id) {
      if (id !== "DEMO00000009") return null;
      const H = [[3, "デモホースA", "◎", .24, .27, 2, 4.2], [7, "デモホースB", "○", .18, .15, 3, 5.1], [1, "デモホースC", "▲", .12, .09, 5, 7.8],
        [5, "デモホースD", "△", .10, .19, 1, 3.4], [9, "デモホースE", "", .08, .07, 6, 11.5], [2, "デモホースF", "", .07, .08, 4, 9.9]];
      return { payload: { model_version: "v33", character: { kind: "混戦", text: "（デモ）上位の勝率が接近した混戦です。" },
        horses: H.map(([u, n, m, p, q, pop, o], i) => ({ umaban: u, horse: n, mark: m, p, p_ai: p * 1.05, mkt_p: q, pop, odds: o, ev: p * o, ai_rank: i + 1, p_top3: Math.min(.9, p * 2.6) })),
        preview_md: "### レース前の AI 解説（デモ）\n\nこれは**架空のデータ**による表示例です。",
        recommendation: { action: "bet", level: "少額", reasons: ["（デモ）AI の評価が市場より高い馬を少額で。"], tickets: [{ type: "単勝", combo: "3", names: "デモホースA", stake: 200, why: "期待値 1.01" }, { type: "複勝", combo: "7", names: "デモホースB", stake: 300, why: "3着内率 47%" }], total: 500, exp_return: 505 } } };
    },
    review(id) {
      if (id !== "DEMO00000009") return null;
      const R = [[1, 7, "デモホースB", 3, 5.1, 2], [2, 3, "デモホースA", 2, 4.2, 1], [3, 9, "デモホースE", 6, 11.5, 5], [4, 5, "デモホースD", 1, 3.4, 4], [5, 1, "デモホースC", 5, 7.8, 3], [6, 2, "デモホースF", 4, 9.9, 6]];
      return { payload: { result: R.map(([pos, u, n, pop, o, ar]) => ({ pos, umaban: u, horse: n, pop, odds: o, ai_rank: ar })),
        pays: { "単勝": [{ nums: [7], pay: 510 }], "複勝": [{ nums: [7], pay: 180 }, { nums: [3], pay: 160 }, { nums: [9], pay: 310 }], "馬連": [{ nums: [3, 7], pay: 1240 }], "三連複": [{ nums: [3, 7, 9], pay: 6820 }], "三連単": [{ nums: [7, 3, 9], pay: 31570 }] },
        settle: { stake: 500, ret: 540, tickets: [{ type: "単勝", combo: "3", stake: 200, ret: 0 }, { type: "複勝", combo: "7", stake: 300, ret: 540 }] },
        review_md: "### レース後の振り返り（デモ）\n\n本命は **2 着**でした。" } };
    },
  };

  async function getRaces() {
    if (DEMO) return Demo.races;
    const { data, error } = await sb.from("races").select("*").order("race_date", { ascending: false }).order("race_num", { ascending: true }).limit(300);
    if (error) throw error;
    return data || [];
  }
  async function getPrediction(id) {
    if (DEMO) return Demo.prediction(id);
    const { data, error } = await sb.from("predictions").select("payload,model_version,generated_at").eq("race_id", id).maybeSingle();
    if (error) throw error;
    return data; // 権限が無い場合、データベースが行を返さない（null）
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
    if (DEMO) return { payload: { live: { n: 3, roi: 0.92, stake: 1500, ret: 1380, hit: 1, series: [{ date: "2026-10-01", cum: -500 }, { date: "2026-10-08", cum: 380 }, { date: "2026-10-15", cum: -120 }] },
      accuracy: { rows: [{ label: "AI 1位の勝率", ai: 0.30, mkt: 0.33 }, { label: "AI 1位の3着内率", ai: 0.63, mkt: 0.65 }] } } };
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
  const roleLabel = () => (!state.profile ? "ゲスト" : state.profile.role === "admin" ? "管理者" : isPremium() ? "有料会員" : "無料会員");

  function setNav(r) {
    document.querySelectorAll("[data-r]").forEach((a) => a.classList.toggle("on", a.dataset.r === r));
    document.getElementById("acct").textContent = state.session ? roleLabel() : "ログイン";
    document.getElementById("who").textContent = state.session ? `${roleLabel()}でご利用中` : "ゲスト";
  }

  // ---------------- 共通部品 ----------------
  function figs(items, cls = "") {
    return `<div class="figs ${cls}">${items.map((f) => `<div class="fig ${f.key ? "key" : ""}"><div class="l">${f.l}</div><div class="v">${f.v}</div>${f.s ? `<div class="s">${f.s}</div>` : ""}</div>`).join("")}</div>`;
  }
  function moneyFigs(m, labelPrefix = "") {
    if (!m || !m.stake) return "";
    const net = (m.ret || 0) - m.stake, roi = m.ret / m.stake;
    return figs([
      { l: labelPrefix + "購入額", v: yen(m.stake), s: m.n != null ? `${num(m.n)}レース` : m.count != null ? `${m.count}点` : "" },
      { l: "払戻額", v: yen(m.ret), s: m.hit != null ? `的中 ${num(m.hit)}` : "" },
      { l: "収支", v: pl(net), key: true },
      { l: "回収率", v: `<span class="${roiCls(roi)}">${pct(roi, 1)}</span>`, s: "100%で収支トントン" },
    ], "f4");
  }

  function raceRow(r) {
    const started = r.post_time && new Date(r.post_time) <= new Date();
    const s = r.summary || {};
    const right = r.status === "finished"
      ? `<span class="chip done">確定</span>${s.winner ? `<br>1着 ${esc(s.winner)}` : ""}${s.ai_top1_pos ? ` ／ AI1位 ${esc(s.ai_top1_pos)}着` : ""}`
      : started ? `<span class="chip">発走済み</span>` : isPremium() ? `<span class="chip">予想公開中</span>` : `<span class="chip lock">会員限定</span>`;
    return `<a class="rrow" href="#/race/${encodeURIComponent(r.race_id)}">
      <div class="rn">${esc(r.course || "")} ${r.race_num ? esc(r.race_num) + "R" : ""}<small>${fmtTime(r.post_time)}発走</small></div>
      <div class="t"><b>${esc(r.race_name || "")}</b> ${gradeChip(r.grade)}<span>${esc(r.surface || "")}${esc(r.distance || "")}m・${esc(r.field || "")}頭</span></div>
      <div class="res">${right}</div></a>`;
  }

  // ---------------- トップ ----------------
  async function viewHome() {
    setNav("home");
    const [races, perf] = await Promise.all([getRaces().catch(() => []), getPerf().catch(() => null)]);
    const up = races.filter((r) => r.status !== "finished").slice(0, 8);
    const done = races.filter((r) => r.status === "finished").slice(0, 6);
    const p = perf?.payload || {};
    app.innerHTML = `
      <p class="lead">出走馬ごとに、AI 独自の能力評価と、オッズを加味した勝率を出します。結果が出たら、予想した馬が何着だったか・収支はどうだったかを、そのまま載せます。</p>
      <p>JRA-VAN の 1986 年以降の全レースで学習し、学習に使っていない年で検証しています。当たったレースも外れたレースも、すべて成績に含めています。</p>
      ${p.live ? `<div class="h-sec"><h2>ライブ成績</h2><span class="aside">発走前に公開した予想だけで集計</span></div>${moneyFigs(p.live)}` : ""}
      <div class="h-sec"><h2>これからのレース</h2><a class="aside" href="#/races">すべて見る</a></div>
      ${up.length ? `<div class="rlist">${up.map(raceRow).join("")}</div>` : '<div class="sheet muted">公開予定の予想はまだありません。</div>'}
      <div class="h-sec"><h2>結果と答え合わせ</h2><span class="aside">どなたでも閲覧できます</span></div>
      ${done.length ? `<div class="rlist">${done.map(raceRow).join("")}</div>` : '<div class="sheet muted">まだありません。</div>'}`;
  }

  async function viewRaces() {
    setNav("races");
    const races = await getRaces();
    const byDay = {};
    races.forEach((r) => (byDay[r.race_date] = byDay[r.race_date] || []).push(r));
    app.innerHTML = `<div class="h-sec"><h2>レース一覧</h2><span class="aside">発走前の予想は有料会員限定・発走後はどなたでも閲覧可</span></div>
      ${Object.keys(byDay).sort().reverse().map((d) => `<div class="day">${fmtDate(d)}</div><div class="rlist">${byDay[d].map(raceRow).join("")}</div>`).join("") || '<div class="sheet muted">まだ予想がありません。</div>'}`;
  }

  // ---------------- レース詳細 ----------------
  function horsesTable(hs, field) {
    const hasAi = hs.some((h) => h.p_ai != null);
    return `<div class="tbl-wrap"><table class="t"><thead><tr><th>印</th><th>馬番</th><th>馬名</th>
      ${hasAi ? '<th class="r">AI独自</th>' : ""}<th class="r">勝率</th><th class="hide-sm">AI <span style="color:var(--ai)">■</span>／人気 <span style="color:#9C9583">■</span></th>
      <th class="r">3着内</th><th class="r">人気</th><th class="r">オッズ</th><th class="r">期待値</th></tr></thead><tbody>
      ${hs.map((h) => {
        const q = h.mkt_p ?? (h.odds ? 0.8 / h.odds : null);
        const gap = h.ai_rank && h.pop ? h.pop - h.ai_rank : null;
        return `<tr><td class="mk ${mkCls(h.mark)}">${esc(h.mark || "")}</td><td>${gate({ ...h, _field: field })}</td>
        <td class="nm">${esc(h.horse)}${gap >= 3 ? ` <span class="diff-up" title="人気より AI の評価が高い">↑</span>` : ""}</td>
        ${hasAi ? `<td class="r">${h.ai_rank ? h.ai_rank + "位" : "—"}</td>` : ""}
        <td class="r"><b>${pct(h.p)}</b></td>
        <td class="hide-sm"><div class="bar2"><i style="width:${Math.min(100, (h.p_ai ?? h.p ?? 0) * 250)}%"></i><b style="width:${Math.min(100, (q || 0) * 250)}%"></b></div></td>
        <td class="r">${pct(h.p_top3, 0)}</td><td class="r">${h.pop ?? "—"}</td><td class="r">${h.odds ?? "—"}</td>
        <td class="r ${h.ev >= 1 ? "plus" : ""}">${h.ev != null ? h.ev.toFixed(2) : "—"}</td></tr>`;
      }).join("")}
      </tbody></table></div>
      <p class="note">「AI独自」はオッズを使わない能力評価の順位。勝率は AI の評価に市場（オッズ）の情報を合わせた確率です。期待値＝勝率×単勝オッズ（1.00 で長期的に収支トントン）。↑は人気より AI の評価が 3 つ以上高い馬。</p>`;
  }

  function recBlock(rec) {
    if (!rec) return "";
    if (rec.action !== "bet") return `<div class="sheet"><h3>AI の買い方：見送り</h3><p>${esc((rec.reasons || [])[0] || "")}</p></div>`;
    return `<div class="sheet"><h3>AI の買い方 <span class="chip">${esc(rec.level || "標準")}</span>　合計 ${yen(rec.total)}</h3>
      <table class="t"><thead><tr><th>券種</th><th>買い目</th><th class="hide-sm">根拠</th><th class="r">金額</th></tr></thead><tbody>
      ${rec.tickets.map((t) => `<tr><td><b>${esc(t.type)}</b></td><td>${esc(t.combo)}　<span class="muted">${esc(t.names)}</span></td><td class="hide-sm muted">${esc(t.why || "")}</td><td class="r">${yen(t.stake)}</td></tr>`).join("")}
      </tbody></table><p class="note">${[rec.unit_note ? esc(rec.unit_note) + "。" : "", esc((rec.reasons || [])[0] || "")].join("")}</p></div>`;
  }

  // 予想順位（左）→ 実際の着順（右）の対応図。AI 上位 3 頭と実際の 1〜3 着の馬を線で結ぶ
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

  function verdictBlock(result, marks) {
    const byRank = {};
    result.forEach((r) => { if (r.ai_rank) byRank[r.ai_rank] = r; });
    const lab = ["◎ AI 1位", "○ AI 2位", "▲ AI 3位"];
    return `<div class="verdict">${[1, 2, 3].map((k) => {
      const r = byRank[k];
      if (!r) return `<div class="vc"><div class="vk">${lab[k - 1]}</div><div class="vh">—</div></div>`;
      return `<div class="vc"><div class="vk">${lab[k - 1]}</div><div class="vh">${gate(r)} ${esc(r.horse)}</div>
        <div class="vr ${r.pos === 1 ? "plus" : ""}">${r.pos ? r.pos + "<small>着</small>" : "<small>取消・除外</small>"}</div><div class="vk">${esc(r.pop ?? "-")}番人気・${esc(r.odds ?? "-")}倍</div></div>`;
    }).join("")}</div>`;
  }

  function resultTable(result, field) {
    return `<div class="tbl-wrap"><table class="t"><thead><tr><th>着</th><th>馬番</th><th>馬名</th><th class="r">人気</th><th class="r">オッズ</th><th class="r">AI予想</th><th class="hide-sm">差</th></tr></thead><tbody>
      ${result.filter((r) => r.pos).sort((a, b) => a.pos - b.pos).slice(0, 8).map((r) => {
        const d = r.ai_rank ? r.ai_rank - r.pos : null;
        return `<tr class="${r.pos <= 3 && r.ai_rank <= 3 ? "hit" : ""}"><td class="pos ${r.pos === 1 ? "p1" : ""}">${r.pos}</td><td>${gate({ ...r, _field: field })}</td><td class="nm">${esc(r.horse)}</td>
        <td class="r">${esc(r.pop ?? "—")}</td><td class="r">${esc(r.odds ?? "—")}</td><td class="r"><b>${r.ai_rank ? r.ai_rank + "位" : "—"}</b></td>
        <td class="hide-sm muted">${d == null ? "" : d === 0 ? "予想どおり" : d > 0 ? `予想より ${d} つ上` : `予想より ${-d} つ下`}</td></tr>`;
      }).join("")}</tbody></table></div><p class="note">緑の行は「AI の上位 3 頭」が実際に 3 着以内に入った馬。</p>`;
  }

  function paysTable(pays) {
    const order = ["単勝", "複勝", "枠連", "馬連", "ワイド", "馬単", "三連複", "三連単"];
    const rows = order.filter((k) => pays && pays[k] && pays[k].length);
    if (!rows.length) return "";
    return `<table class="t"><tbody>${rows.map((k) => `<tr><th style="width:5em">${k}</th><td>${pays[k].map((e) => `<span class="num">${e.nums.join("-")}</span>　<b class="num">${num(e.pay)}円</b>`).join("<br>")}</td></tr>`).join("")}</tbody></table>`;
  }

  function settleBlock(st) {
    if (!st) return '<div class="sheet muted">このレースは AI の買い方が「見送り」だったため、収支はありません。</div>';
    return moneyFigs({ stake: st.stake, ret: st.ret, count: (st.tickets || []).length }) +
      `<table class="t" style="margin-top:8px"><thead><tr><th>券種</th><th>買い目</th><th class="r">金額</th><th class="r">払戻</th></tr></thead><tbody>
      ${(st.tickets || []).map((t) => `<tr class="${t.ret > 0 ? "hit" : ""}"><td>${esc(t.type)}</td><td class="num">${esc(t.combo)}</td><td class="r">${yen(t.stake)}</td><td class="r">${t.ret > 0 ? "<b>" + yen(t.ret) + "</b>" : "—"}</td></tr>`).join("")}
      </tbody></table>`;
  }

  async function viewRace(id) {
    setNav("races");
    const races = await getRaces();
    const r = races.find((x) => x.race_id === id);
    if (!r) { app.innerHTML = '<div class="sheet">レースが見つかりません。</div>'; return; }
    const [pred, review] = await Promise.all([getPrediction(id), getReview(id)]);
    const P = pred?.payload, V = review?.payload;
    let html = `<div class="race-head"><div class="meta">${fmtDate(r.race_date)}　${esc(r.course)} ${r.race_num ? esc(r.race_num) + "R" : ""}　${fmtTime(r.post_time)}発走</div>
      <h1>${esc(r.race_name)} ${gradeChip(r.grade)}</h1><div>${surfChip(r.surface)} <span class="chip">${esc(r.distance)}m</span> <span class="chip">${esc(r.field)}頭</span>
      ${P?.character?.kind ? `<span class="chip">${esc(P.character.kind)}</span>` : ""}</div></div>`;
    if (V && V.result) {
      html += `<div class="h-sec"><h2>結果</h2><span class="aside">AI の上位 3 頭は何着だったか</span></div>${verdictBlock(V.result)}
        <div class="cols c2" style="margin-top:12px"><div>${resultTable(V.result, r.field)}</div><div class="sheet">${slopeChart(V.result)}
        <p class="note">左が AI の予想順位、右が実際の着順。藍の太線＝予想上位 3 頭が 3 着以内、朱線＝予想 4 位以下から 3 着以内（見逃し）、点線＝予想上位だが 4 着以下。</p></div></div>
        <div class="h-sec"><h2>収支</h2><span class="aside">AI の買い方どおりに購入した場合</span></div>${settleBlock(V.settle)}
        <div class="h-sec"><h2>配当</h2></div>${paysTable(V.pays)}
        ${V.review_md ? `<div class="h-sec"><h2>振り返り</h2></div><div class="sheet md">${md(V.review_md)}</div>` : ""}`;
    } else if (V && V.review_md) {
      html += `<div class="h-sec"><h2>振り返り</h2></div><div class="sheet md">${md(V.review_md)}</div>`;
    }
    if (P) {
      const body = `<div class="cols c2"><div class="sheet"><h3>レースの性格：${esc(P.character?.kind || "")}</h3><p>${esc(P.character?.text || "")}</p></div>${recBlock(P.recommendation)}</div>
        <div class="h-sec"><h2>AI の予想</h2><span class="aside">${esc(P.model_version || "")}</span></div>${horsesTable(P.horses || [], r.field)}
        ${P.preview_md ? `<div class="h-sec"><h2>レース前の解説</h2></div><div class="sheet md">${md(P.preview_md)}</div>` : ""}`;
      html += V ? `<details class="more"><summary>レース前の予想（発走前に公開した内容）</summary><div>${body}</div></details>` : body;
    } else if (!V) {
      const t = await getTeaser(id);
      html += `<div class="lockbox"><h3>このレースの予想は、発走前は有料会員限定です</h3>
        <p>${t ? `レースの性格：<b>${esc(t.teaser?.character || "—")}</b>・${esc(t.teaser?.n_horses || "")}頭・AI の買い方：<b>${t.teaser?.has_recommendation ? "あり" : "見送り"}</b>` : ""}</p>
        <p class="note">発走時刻（${fmtTime(r.post_time)}）を過ぎると、どなたでも予想と結果を閲覧できます。</p>
        <div class="cta" style="justify-content:center"><a class="btn shu" href="#/account">${state.session ? "有料会員について" : "ログイン・会員登録"}</a></div></div>`;
    }
    app.innerHTML = html;
  }

  // ---------------- 成績 ----------------
  let chart;
  async function viewStats() {
    setNav("stats");
    const perf = await getPerf();
    const p = perf?.payload || {};
    const acc = p.accuracy, bt = p.backtest;
    let html = `<div class="h-sec"><h2>ライブ成績</h2><span class="aside">発走前に公開した予想だけ・損失も含めて全件</span></div>
      ${p.live ? moneyFigs(p.live) + `<div class="sheet" style="margin-top:12px"><h3>累積の収支</h3><div class="chart"><canvas id="cum"></canvas></div></div>` : '<div class="sheet muted">記録が始まるとここに表示されます。</div>'}`;
    if (acc && acc.rows) {
      html += `<div class="h-sec"><h2>予想の精度</h2><span class="aside">${esc(acc.period || "")}</span></div>
        <div class="tbl-wrap"><table class="t"><thead><tr><th>指標</th><th class="r">AI（統合）</th><th class="r">AI独自評価</th><th class="r">人気順</th><th class="hide-sm">見方</th></tr></thead><tbody>
        ${acc.rows.map((x) => `<tr><td>${esc(x.label)}</td><td class="r"><b>${x.fmt === "n" ? (x.ai ?? 0).toFixed(2) : pct(x.ai)}</b></td><td class="r">${x.ai_only == null ? "—" : x.fmt === "n" ? x.ai_only.toFixed(2) : pct(x.ai_only)}</td>
          <td class="r">${x.fmt === "n" ? (x.mkt ?? 0).toFixed(2) : pct(x.mkt)}</td><td class="hide-sm muted">${esc(x.note || "")}</td></tr>`).join("")}
        </tbody></table></div><p class="note">${esc(acc.note || "")}</p>`;
    }
    if (bt && bt.rows) {
      html += `<div class="h-sec"><h2>過去データでの検証</h2><span class="aside">${esc(bt.period || "")}</span></div>
        <div class="tbl-wrap"><table class="t"><thead><tr><th>買い方</th><th class="r">レース</th><th class="r">購入</th><th class="r">払戻</th><th class="r">収支</th><th class="r">回収率</th><th class="r hide-sm">的中率</th></tr></thead><tbody>
        ${bt.rows.map((x) => `<tr><td>${esc(x.label)}</td><td class="r">${num(x.races)}</td><td class="r">${yen(x.stake)}</td><td class="r">${yen(x.ret)}</td><td class="r">${pl(x.ret - x.stake)}</td>
          <td class="r ${roiCls(x.roi)}"><b>${pct(x.roi)}</b></td><td class="r hide-sm">${pct(x.hit_rate, 0)}</td></tr>`).join("")}
        </tbody></table></div>${bt.by_year ? `<div class="sheet" style="margin-top:12px"><h3>年ごとの回収率（${esc(bt.by_year_label || "")}）</h3><div class="chart"><canvas id="yr"></canvas></div></div>` : ""}
        <p class="note">${esc(bt.note || "")}</p>`;
    }
    html += `<div class="sheet" style="margin-top:16px"><h3>この成績の読み方</h3><p>回収率 100% が収支トントンです。JRA の払戻率は券種により 70〜80% で、全馬券を買い続けると長期では 70〜80% 程度に収束します。
      このサイトは成績を良く見せるための選別をせず、見送りや外れも含めて掲載しています。過去の検証は、その年より前のデータだけで作ったモデルと買い方で計算しています。</p></div>`;
    app.innerHTML = html;
    if (chart) chart.destroy();
    const s = p.live?.series || [];
    if (s.length && window.Chart) {
      chart = new window.Chart(document.getElementById("cum"), { type: "line",
        data: { labels: s.map((x) => x.date), datasets: [{ data: s.map((x) => x.cum), borderColor: "#1B1A17", borderWidth: 1.8, pointRadius: 2, fill: { target: "origin", above: "rgba(20,83,45,.12)", below: "rgba(184,32,43,.12)" }, tension: 0 }] },
        options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { y: { ticks: { callback: (v) => v.toLocaleString("ja-JP") + "円" } } } } });
    }
    if (bt?.by_year && window.Chart) {
      const ys = Object.keys(bt.by_year);
      new window.Chart(document.getElementById("yr"), { type: "bar",
        data: { labels: ys, datasets: [{ data: ys.map((y) => bt.by_year[y] * 100), backgroundColor: ys.map((y) => (bt.by_year[y] >= 1 ? "#14532D" : "#B8202B")) }] },
        options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { y: { suggestedMin: 50, ticks: { callback: (v) => v + "%" } } } } });
    }
  }

  // ---------------- 会員 ----------------
  async function viewAccount(msg) {
    setNav("account");
    if (DEMO) { app.innerHTML = '<div class="sheet" style="margin-top:18px">デモ表示中のため、ログインは利用できません（接続設定後に有効になります）。</div>'; return; }
    if (!state.session) {
      app.innerHTML = `<div class="h-sec"><h2>ログイン・会員登録</h2></div>${msg || ""}
        <div class="cols c2"><div class="sheet"><h3>ログイン</h3><form class="form" id="f-login">
          <input type="email" name="email" placeholder="メールアドレス" autocomplete="email" required>
          <input type="password" name="pw" placeholder="パスワード" autocomplete="current-password" required minlength="8">
          <button class="btn" type="submit">ログイン</button></form></div>
        <div class="sheet"><h3>無料会員登録</h3><p class="note">無料会員は、結果・答え合わせ・成績を閲覧できます。発走前の予想は有料会員限定です。</p>
          <form class="form" id="f-signup"><input type="email" name="email" placeholder="メールアドレス" autocomplete="email" required>
          <input type="password" name="pw" placeholder="パスワード（12文字以上推奨）" autocomplete="new-password" required minlength="8">
          <button class="btn ghost" type="submit">登録する</button></form></div></div>`;
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
    app.innerHTML = `<div class="h-sec"><h2>会員情報</h2></div>${msg || ""}
      <div class="cols c2"><div class="sheet"><h3>${esc(p.email || state.session.user.email)}</h3>
        <p>会員種別：<b>${roleLabel()}</b><br>購読状態：${esc(p.subscription_status || "none")}${p.subscription_current_period_end ? "（" + new Date(p.subscription_current_period_end).toLocaleDateString("ja-JP") + " まで）" : ""}</p>
        <button class="btn ghost" id="b-logout">ログアウト</button></div>
      <div class="sheet"><h3>有料会員（発走前の AI 予想）</h3>
        <p>発走前の予想・買い方・レース前の解説をすべて閲覧できます。</p>
        ${isPremium() ? '<p class="alert ok">現在、すべての予想を閲覧できます。</p>'
          : CFG.SUBSCRIBE_URL ? `<a class="btn shu" href="${esc(CFG.SUBSCRIBE_URL)}" rel="noopener">購読する</a>` : '<button class="btn" disabled>購読の受付は準備中です</button>'}</div></div>`;
    document.getElementById("b-logout").onclick = async () => { await sb.auth.signOut(); location.hash = "#/"; };
  }

  function viewAbout() {
    setNav("about");
    app.innerHTML = `<div class="h-sec"><h2>見方</h2></div><div class="steps">
      <div class="sheet"><div><h3>AI独自評価と勝率</h3><p>「AI独自」はオッズを一切使わず、スピード指数・上がり・近走・コース適性・調教・騎手などから出した能力の順位です。
        「勝率」は、その評価に市場（オッズ）の情報を合わせた確率です。人気と AI独自評価がずれている馬が、AI の見どころです。</p></div></div>
      <div class="sheet"><div><h3>期待値</h3><p>勝率×単勝オッズ。1.00 で長期的に収支トントン、1.00 を超える馬は AI が市場より高く評価している馬です。</p></div></div>
      <div class="sheet"><div><h3>買い方と金額</h3><p>AI の確信度に応じて「標準」「少額」「最少」の 3 段階で金額を変えます。根拠が弱いレースは見送るのではなく金額を小さくします。</p></div></div>
      <div class="sheet"><div><h3>答え合わせ</h3><p>結果が出たら、AI の上位 3 頭が何着だったか、収支と回収率、配当を最初に表示します。外れたレースもそのまま残します。</p></div></div></div>`;
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
    document.getElementById("today").textContent = new Date().toLocaleDateString("ja-JP", { year: "numeric", month: "long", day: "numeric", weekday: "short", timeZone: "Asia/Tokyo" });
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
