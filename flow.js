// flow.js — v86: 能力分析の「隊列の予測」コマ送り（各コーナー・直線の残り 600/400/200m・ゴール）
//   PC が送る P.flow = {checkpoints:[{label,rem}], horses:[{u,w,name,rank}], frames:[[[馬身,内外],...],...], has_draw}
//   PrismFlow.html(flow) で枠を書き、PrismFlow.mount(root) で動かす（再生・一時停止・スライダー・コマ送り・馬をタップで名前）
(function () {
  "use strict";
  const WAKU = { 1: ["#ffffff", "#222"], 2: ["#222222", "#fff"], 3: ["#e03a3a", "#fff"], 4: ["#2a6fdb", "#fff"],
    5: ["#f2d100", "#222"], 6: ["#1f9d4c", "#fff"], 7: ["#f08a00", "#fff"], 8: ["#f39ac0", "#222"] };
  const SEG_MS = 2600;          // 1 コマ（地点から次の地点まで）の時間
  const W = 640, L = 34, R = 26, TOP = 40, LANE_PX = 22;
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const color = (h, draw) => {
    if (draw && WAKU[h.w]) return WAKU[h.w];
    return h.rank <= 3 ? ["#a12e43", "#fff"] : h.rank <= 6 ? ["#2f6aa8", "#fff"] : ["#8a95a0", "#fff"];
  };

  function html(flow) {
    if (!flow || !flow.frames || !flow.frames.length) return "";
    const n = flow.frames.length;
    const cps = flow.checkpoints.map((c, i) => `<button type="button" class="pf-cp" data-i="${i}">${esc(c.label)}</button>`).join("");
    return `<div class="pf" data-flow="${esc(JSON.stringify(flow))}">
      <div class="pf-head"><b class="pf-lab"></b><span class="pf-sub muted"></span></div>
      <div class="pf-svg"></div>
      <div class="pf-ctl"><button type="button" class="pf-btn pf-prev" aria-label="前のコマ">◀</button>
        <button type="button" class="pf-btn pf-play" aria-label="再生">▶ 再生</button>
        <button type="button" class="pf-btn pf-next" aria-label="次のコマ">▶</button>
        <input class="pf-rng" type="range" min="0" max="${(n - 1) * 100}" value="0" step="1" aria-label="レースの地点"></div>
      <div class="pf-cps">${cps}</div>
      <p class="pf-info muted">馬の丸をタップすると馬名が出ます。</p>
      <div class="pf-order"></div></div>`;
  }

  function mount(root) {
    (root || document).querySelectorAll(".pf:not([data-on])").forEach((el) => {
      el.setAttribute("data-on", "1");
      let F;
      try { F = JSON.parse(el.getAttribute("data-flow")); } catch (e) { return; }
      const n = F.frames.length, H = F.horses, draw = !!F.has_draw;
      let maxX = 4, maxL = 4;
      F.frames.forEach((fr) => fr.forEach(([x, l]) => { maxX = Math.max(maxX, x); maxL = Math.max(maxL, l); }));
      maxX = Math.ceil(maxX + 1);
      const HGT = TOP + (Math.ceil(maxL) + 1) * LANE_PX + 26;
      const sx = (x) => W - R - (x / maxX) * (W - L - R);      // 先頭が右（右へ走る）
      const sy = (l) => TOP + 12 + l * LANE_PX;
      let t = 0, playing = false, last = 0, sel = null;
      const svgBox = el.querySelector(".pf-svg");
      // 目盛り（馬身）
      let grid = "";
      const step = maxX > 20 ? 5 : 2;
      for (let x = 0; x <= maxX; x += step) {
        grid += `<line x1="${sx(x)}" y1="${TOP}" x2="${sx(x)}" y2="${HGT - 22}" stroke="#e6e9ec" stroke-width=".7"/>`
          + `<text x="${sx(x)}" y="${HGT - 8}" class="pf-ax" text-anchor="middle">${x === 0 ? "先頭" : x + "馬身"}</text>`;
      }
      svgBox.innerHTML = `<svg viewBox="0 0 ${W} ${HGT}" width="100%" role="img" aria-label="隊列の予測">
        <rect x="${L - 10}" y="${TOP}" width="${W - L - R + 20}" height="${HGT - TOP - 22}" rx="6" fill="#eef5ec"/>
        <line x1="${L - 10}" y1="${TOP}" x2="${W - R + 10}" y2="${TOP}" stroke="#7a8a77" stroke-width="3"/>
        <text x="${L - 6}" y="${TOP - 6}" class="pf-ax">内ラチ</text><text x="${W - R}" y="${TOP - 6}" class="pf-ax" text-anchor="end">進行方向 →</text>
        <text x="${L - 6}" y="${HGT - 26}" class="pf-ax">外</text>${grid}<g class="pf-hs">${H.map((h, i) => {
          const [bg, fg] = color(h, draw);
          return `<g class="pf-h" data-i="${i}" style="cursor:pointer"><title>${esc((h.u ? h.u + "番 " : "") + h.name + "（実力 " + h.rank + " 位）")}</title>
            <circle r="10" fill="${bg}" stroke="${bg === "#ffffff" ? "#555" : "#fff"}" stroke-width="1.3"/>
            <text class="pf-n" text-anchor="middle" dy="4" fill="${fg}">${draw && h.u ? h.u : h.rank}</text></g>`;
        }).join("")}</g></svg>`;
      const gs = [...svgBox.querySelectorAll(".pf-h")];
      const lab = el.querySelector(".pf-lab"), sub = el.querySelector(".pf-sub"), rng = el.querySelector(".pf-rng");
      const play = el.querySelector(".pf-play"), info = el.querySelector(".pf-info"), order = el.querySelector(".pf-order");
      const cpb = [...el.querySelectorAll(".pf-cp")];
      const nm = (h) => `${draw && h.u ? h.u + " " : ""}${h.name}`;
      function draw_(tt) {
        t = Math.max(0, Math.min(n - 1, tt));
        const a = Math.floor(t), b = Math.min(n - 1, a + 1), f = t - a;
        const e = f * f * (3 - 2 * f);
        const pos = H.map((_, i) => {
          const p = F.frames[a][i], q = F.frames[b][i];
          return [p[0] + (q[0] - p[0]) * e, p[1] + (q[1] - p[1]) * e];
        });
        gs.forEach((g, i) => {
          g.setAttribute("transform", `translate(${sx(pos[i][0]).toFixed(1)},${sy(pos[i][1]).toFixed(1)})`);
          g.querySelector("circle").setAttribute("stroke-width", sel === i ? "3" : "1.3");
          if (sel === i) g.querySelector("circle").setAttribute("stroke", "#111");
        });
        const k = Math.round(t), c = F.checkpoints[k];
        lab.textContent = c.label;
        sub.textContent = c.rem > 0 ? `ゴールまで ${c.rem}m` : "ゴール（予想の着順）";
        rng.value = Math.round(t * 100);
        cpb.forEach((x, i) => x.classList.toggle("on", i === k));
        const ord = H.map((h, i) => [pos[i][0], i]).sort((x, y) => x[0] - y[0]);
        order.innerHTML = `<b>先頭から：</b>` + ord.map(([x, i], j) => `<span class="pf-o${sel === i ? " on" : ""}">${j + 1}. ${esc(nm(H[i]))}</span>`).join("");
      }
      function stop() { playing = false; play.textContent = "▶ 再生"; }
      function frame(ts) {
        if (!el.isConnected) return;
        if (!playing) return;
        const dt = last ? ts - last : 0;
        last = ts;
        let nt = t + dt / SEG_MS;
        if (nt >= n - 1) { nt = n - 1; stop(); }
        draw_(nt);
        if (playing) requestAnimationFrame(frame);
      }
      play.addEventListener("click", () => {
        if (playing) { stop(); return; }
        if (t >= n - 1) t = 0;
        playing = true; last = 0; play.textContent = "❚❚ 一時停止";
        requestAnimationFrame(frame);
      });
      el.querySelector(".pf-prev").addEventListener("click", () => { stop(); draw_(Math.ceil(t) - 1); });
      el.querySelector(".pf-next").addEventListener("click", () => { stop(); draw_(Math.floor(t) + 1); });
      rng.addEventListener("input", () => { stop(); draw_(Number(rng.value) / 100); });
      cpb.forEach((x) => x.addEventListener("click", () => { stop(); draw_(Number(x.dataset.i)); }));
      gs.forEach((g) => g.addEventListener("click", () => {
        const i = Number(g.dataset.i);
        sel = sel === i ? null : i;
        gs.forEach((x) => x.querySelector("circle").setAttribute("stroke", color(H[Number(x.dataset.i)], draw)[0] === "#ffffff" ? "#555" : "#fff"));
        const h = H[i];
        info.textContent = sel === null ? "馬の丸をタップすると馬名が出ます。" : `${h.u ? h.u + "番 " : ""}${h.name}（実力 ${h.rank} 位）`;
        draw_(t);
      }));
      draw_(0);
    });
  }
  window.PrismFlow = { html, mount };
})();
