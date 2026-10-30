"use strict";
/* 双色球选号 · 静态版前端（原生 JS，无外部依赖）。
   与 web/static/app.js 的界面逻辑一致，区别：数据来自 data/draws.json，统计 / 查询 / 对奖在主线程用 core.js 计算，
   规则过滤与机选在 Web Worker（assets/worker.js）里跑，买号记录存在本浏览器 localStorage。 */
const S = window.SSQ;
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const fmt = (n) => (n === null || n === undefined || n === "" ? "—" : Number(n).toLocaleString("zh-CN"));
const pad = (n) => String(n).padStart(2, "0");
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const params = new URLSearchParams(location.search);
const mqMobile = matchMedia("(width < 1024px)");
const two = (n) => String(n).padStart(2, "0");
const nowStr = (d = new Date()) => `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`;

const balls = (reds, blues, { size = "", dan = [], hitReds = null, hitBlue = null, wrap = false } = {}) => {
  const bl = Array.isArray(blues) ? blues : (blues == null ? [] : [blues]);
  const one = (n, cls) => `<span class="ball ${cls} ${size}${hitReds && cls !== "blue" && hitReds.includes(n) ? " hit" : ""}${cls === "blue" && hitBlue === n ? " hit" : ""}">${pad(n)}</span>`;
  const parts = [];
  if (dan.length) parts.push(dan.map((n) => one(n, "dan")).join(""), '<span class="sep" title="胆 | 拖">|</span>');
  parts.push(reds.map((n) => one(n, "")).join(""));
  if (bl.length) parts.push('<span class="sep">+</span>', bl.map((n) => one(n, "blue")).join(""));
  return `<span class="balls${wrap ? " wrap" : ""}">${parts.join("")}</span>`;
};

/* ---------- Toast / 对话框 ---------- */
function toast(msg, { error = false, action = null } = {}) {
  const el = document.createElement("div");
  el.className = "toast" + (error ? " error" : "");
  el.setAttribute("role", error ? "alert" : "status");
  el.innerHTML = `<span>${esc(msg)}</span>`;
  if (action) { const b = document.createElement("button"); b.className = "btn btn-ghost"; b.textContent = action.label; b.onclick = () => { action.run(); el.remove(); }; el.append(b); }
  const close = document.createElement("button"); close.className = "btn btn-icon"; close.setAttribute("aria-label", "关闭"); close.title = "关闭";
  close.innerHTML = '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>'; close.onclick = () => el.remove();
  el.append(close);
  $("#toasts").append(el);
  while ($("#toasts").children.length > 3) $("#toasts").firstElementChild.remove();
  setTimeout(() => el.remove(), error ? 8000 : 4000);
}
/** actions: [{value, label, kind: primary|danger|secondary|ghost}]，返回被点按钮的 value；取消 / Esc 返回 ""。 */
function choiceDialog({ title, body, actions }) {
  const dlg = $("#confirm");
  $("#confirm-title").textContent = title; $("#confirm-body").textContent = body;
  $("#confirm-actions").innerHTML = [{ value: "cancel", label: "取消", kind: "ghost" }, ...actions]
    .map((a) => `<button class="btn btn-${a.kind || "secondary"}" value="${esc(a.value)}">${esc(a.label)}</button>`).join("");
  const opener = document.activeElement;
  dlg.returnValue = ""; dlg.showModal(); $("button[value=cancel]", dlg).focus();
  return new Promise((resolve) => dlg.addEventListener("close", () => {
    resolve(dlg.returnValue === "cancel" ? "" : dlg.returnValue); opener && opener.focus && opener.focus({ preventScroll: true });
  }, { once: true }));
}
const confirmDialog = async ({ title, body, confirmLabel = "确定", danger = false }) =>
  (await choiceDialog({ title, body, actions: [{ value: "ok", label: confirmLabel, kind: danger ? "danger" : "primary" }] })) === "ok";

/* ---------- 主题 ---------- */
const THEME_NAMES = { light: "亮色", dark: "暗色", system: "跟随系统" };
function setThemePref(pref) {
  if (!THEME_NAMES[pref]) pref = "system";
  try { localStorage.setItem("ssq-theme", pref); } catch { /* 隐私模式等：只在本次生效 */ }
  const dark = pref === "dark" || (pref === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  document.documentElement.dataset.themePref = pref;
  const tc = $('meta[name="theme-color"]'); if (tc) tc.content = dark ? "#111214" : "#FFFFFF";
  $$("#theme-seg button").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.themePref === pref)));
  $("#theme-btn").setAttribute("aria-label", `主题：${THEME_NAMES[pref]}（点按切换）`); $("#theme-btn").title = `主题：${THEME_NAMES[pref]}`;
  if (state.tab === "stats" && state.rows) renderStats();
}
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => { if (document.documentElement.dataset.themePref === "system") setThemePref("system"); });

/* ---------- 状态与导航 ---------- */
const TITLES = { history: "历史查询", stats: "冷热与遗漏", filter: "规则过滤", pick: "机选", picks: "买号与对奖" };
const DEFAULT_RULES = { odd: null, big: null, sum: null, span: null, ac: null, run: null, repeat: null, kill_red: [], dan_red: [], kill_blue: [], exclude_history: false };
const DEMO_RULES = { odd: [2, 3, 4], big: [2, 3, 4], sum: [80, 130], span: [20, 32], ac: [6, 10], run: [1, 2], repeat: null, kill_red: [1, 33], dan_red: [7], kill_blue: [16], exclude_history: true };
const loadRules = () => {
  try {
    const r = { ...DEFAULT_RULES, ...JSON.parse(localStorage.getItem("ssq-rules") || "{}") };
    for (const k of ["kill_red", "dan_red", "kill_blue"]) if (!Array.isArray(r[k])) r[k] = [];
    return r;
  } catch { return { ...DEFAULT_RULES, kill_red: [], dan_red: [], kill_blue: [] }; }
};
const state = {
  tab: "history", rows: null, byCode: null, meta: null, statsCache: {}, stats: null, statsN: "50", historyPage: 1, picks: null, picked: [],
  rules: loadRules(),
  entry: { play: "single", dt: "dan", dan: [], reds: [], blues: [] },
};
if (params.get("preset") === "demo") state.rules = { ...DEMO_RULES, kill_red: [...DEMO_RULES.kill_red], dan_red: [...DEMO_RULES.dan_red], kill_blue: [...DEMO_RULES.kill_blue] };
const saveRules = () => { try { localStorage.setItem("ssq-rules", JSON.stringify(state.rules)); } catch { /* 忽略 */ } };

function scrollTop() { if (mqMobile.matches) window.scrollTo({ top: 0 }); else $(".content").scrollTop = 0; }
function go(tab, { push = true } = {}) {
  if (!TITLES[tab]) tab = "history";
  const changedTab = state.tab !== tab;
  state.tab = tab;
  $$(".nav-item").forEach((b) => { const on = b.dataset.tab === tab; b.setAttribute("aria-selected", String(on)); b.tabIndex = on ? 0 : -1; if (on) b.setAttribute("aria-current", "page"); else b.removeAttribute("aria-current"); });
  $$(".view").forEach((v) => (v.hidden = v.id !== `view-${tab}`));
  $("#page-title").textContent = TITLES[tab];
  document.title = `${TITLES[tab]} · 双色球选号`;
  if (push) { const u = new URL(location); u.searchParams.set("tab", tab); history.replaceState(null, "", u); }
  if (changedTab) scrollTop();
  if (!state.rows) return;
  syncHelp();
  ({ history: loadHistory, stats: loadStats, filter: renderFilter, pick: renderPick, picks: loadPicks })[tab]();
}
$$(".nav-item").forEach((b) => b.addEventListener("click", () => go(b.dataset.tab)));
$(".nav").addEventListener("keydown", (e) => {
  const fwd = ["ArrowDown", "ArrowRight"], back = ["ArrowUp", "ArrowLeft"];
  if (![...fwd, ...back].includes(e.key)) return;
  const items = $$(".nav-item"); const i = items.indexOf(document.activeElement); if (i < 0) return;
  e.preventDefault(); const n = items[(i + (fwd.includes(e.key) ? 1 : items.length - 1)) % items.length]; n.focus(); go(n.dataset.tab);
});
const syncNavOrientation = () => $(".nav").setAttribute("aria-orientation", mqMobile.matches ? "horizontal" : "vertical");
mqMobile.addEventListener("change", () => { syncNavOrientation(); if (state.tab === "stats" && state.rows) renderStats(); });
document.addEventListener("click", (e) => { const g = e.target.closest("[data-goto]"); if (g) go(g.dataset.goto); });

/* ---------- 开奖数据 ---------- */
async function loadData() {
  const res = await fetch("data/draws.json", { cache: "no-cache" });
  if (!res.ok) throw new Error(`读取 data/draws.json 失败（HTTP ${res.status}）`);
  let json;
  try { json = await res.json(); } catch { throw new Error("data/draws.json 不是有效的 JSON"); }
  const rows = S.parseDraws(json).sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));
  if (!rows.length) throw new Error("data/draws.json 里没有开奖记录");
  state.rows = rows; state.byCode = new Map(rows.map((r) => [r.code, r]));
  const l = rows[rows.length - 1];
  state.meta = { count: rows.length, first: rows[0].code, latest: l, next_code: String(Number(l.code) + 1), generated_at: json.generated_at || "" };
}
const genLocal = (iso) => { const d = new Date(iso); return isNaN(d) ? "" : nowStr(d).slice(0, 16); };
function renderMeta() {
  const m = state.meta, l = m.latest;
  const pill = $("#data-pill");
  pill.dataset.status = "done"; pill.textContent = `数据更新到第 ${l.code} 期`;
  pill.title = `共 ${fmt(m.count)} 期（${m.first} – ${l.code}），最新开奖 ${l.draw_date}${m.generated_at ? `，导出于 ${genLocal(m.generated_at)}` : ""}`;
  const card = `
      <div class="card draw-card">
        <div class="draw-code"><b>第 ${l.code} 期</b><span class="muted small">${l.draw_date}（周${esc(l.week)}）</span></div>
        ${balls(l.reds, l.blue, { size: "lg" })}
        <div class="kv"><span>和值 / 跨度</span><b>${l.sum} / ${l.reds[5] - l.reds[0]}</b></div>
        <div class="kv"><span>本期销售额</span><b>${fmt(l.sales)} 元</b></div>
        <div class="kv"><span>奖池</span><b>${fmt(l.poolmoney)} 元</b></div>
        <div class="kv"><span>一等奖</span><b>${fmt(l.prize1_num)} 注 × ${fmt(l.prize1_money)} 元</b></div>
        <div class="kv"><span>二等奖</span><b>${fmt(l.prize2_num)} 注 × ${fmt(l.prize2_money)} 元</b></div>
      </div>`;
  $("#panel").innerHTML = card + `
      <div class="card draw-card">
        <h3>下一期</h3>
        <div class="kv"><span>预计期号</span><b>${m.next_code}</b></div>
        <div class="kv"><span>数据范围</span><b>${m.first} – ${l.code}</b></div>
        ${m.generated_at ? `<div class="kv"><span>数据导出于</span><b>${genLocal(m.generated_at)}</b></div>` : ""}
        <p class="small">单注中一等奖的概率为 1 / ${fmt(S.RED_COMBOS * 16)}，与选号方法无关。</p>
      </div>
      <div class="card draw-card" id="panel-picks"><h3>我的买号</h3></div>`;
  $("#latest-mobile").innerHTML = `
      <div class="card draw-card">
        <div class="latest-head"><b>最新开奖 · 第 ${l.code} 期</b><span class="muted small">${l.draw_date} 周${esc(l.week)}</span></div>
        ${balls(l.reds, l.blue, { size: "lg" })}
        <div class="latest-kv">
          <div class="kv"><span>和值 / 跨度</span><b>${l.sum} / ${l.reds[5] - l.reds[0]}</b></div>
          <div class="kv"><span>一等奖</span><b>${fmt(l.prize1_num)} 注</b></div>
          <div class="kv"><span>奖池</span><b>${l.poolmoney == null ? "—" : (l.poolmoney / 1e8).toFixed(2) + " 亿"}</b></div>
          <div class="kv"><span>下一期</span><b>${m.next_code}</b></div>
        </div>
      </div>`;
  renderPanelPicks();
}

/* ---------- 买号记录（localStorage） ---------- */
const PICKS_KEY = "ssq-picks";
const store = {
  read() {
    let raw = null;
    try { raw = localStorage.getItem(PICKS_KEY); } catch { throw new Error("浏览器禁止了本地存储，无法读写买号记录"); }
    if (!raw) return { version: 1, next_id: 1, items: [] };
    let d;
    try { d = JSON.parse(raw); } catch { d = null; }
    if (!d || !Array.isArray(d.items)) {
      // 数据损坏：先备份原文再重置，避免静默丢失
      try { localStorage.setItem(`${PICKS_KEY}-broken-${Date.now()}`, raw); } catch { /* 忽略 */ }
      toast("本地买号记录已损坏，原始内容已另存备份并重置", { error: true });
      return { version: 1, next_id: 1, items: [] };
    }
    const maxId = d.items.reduce((m, x) => Math.max(m, Number(x.id) || 0), 0);
    return { version: 1, next_id: Math.max(Number(d.next_id) || 1, maxId + 1), items: d.items };
  },
  write(d) {
    try { localStorage.setItem(PICKS_KEY, JSON.stringify(d)); }
    catch (e) { throw new Error(e && e.name === "QuotaExceededError" ? "本地存储空间已满，请先导出并删除部分记录" : "写入本地存储失败"); }
  },
  /** 先全部校验（与 web/ 的 POST /api/picks 一样，全部有效才写入），返回新 id。 */
  add(rawItems, { createdAt = null } = {}) {
    const norm = rawItems.map((x, i) => {
      try { return S.normalizeTicket(x); } catch (e) { throw new Error(rawItems.length > 1 ? `第 ${i + 1} 注：${e.message}` : e.message); }
    });
    const d = this.read(), ts = nowStr(), ids = [];
    norm.forEach((n, i) => { const id = d.next_id++; ids.push(id); d.items.push({ id, created_at: (createdAt && createdAt[i]) || ts, ...n }); });
    this.write(d);
    return ids;
  },
  remove(id) { const d = this.read(); d.items = d.items.filter((x) => x.id !== id); this.write(d); },
};
function computePicks() {
  const d = store.read();
  const recs = d.items.map((x) => ({ id: x.id, created_at: x.created_at, play: x.play, dan: x.dan || [], reds: x.reds || [], blues: x.blues || [],
    target_code: String(x.target_code), multiple: Number(x.multiple) || 1, source: x.source || "manual", note: x.note || "" }));
  return (state.picks = S.listPicks(recs, state.byCode));
}
function renderPanelPicks() {
  const el = $("#panel-picks");
  let s;
  try { s = computePicks().summary; } catch (e) { if (el) el.innerHTML = `<h3>我的买号</h3><p class="small">${esc(e.message)}</p>`; return; }
  $("#nav-picks-count").textContent = s.records || "";
  if (!el) return;
  el.innerHTML = `<h3>我的买号</h3>${s.records ? `
      <div class="kv"><span>记录 / 注数</span><b>${s.records} 条 / ${fmt(s.bets)} 注</b></div>
      <div class="kv"><span>待开奖</span><b>${s.pending_records} 条</b></div>
      <div class="kv"><span>已开奖投入 / 回报</span><b>${fmt(s.drawn_cost)} / ${fmt(s.prize)} 元</b></div>`
      : `<p class="small">还没有买号记录。可在「机选」生成后保存，或在「买号与对奖」手动录入。记录只存在本浏览器。</p>`}`;
}
window.addEventListener("storage", (e) => { if (e.key === PICKS_KEY && state.rows) { renderPanelPicks(); if (state.tab === "picks") loadPicks(); } });

/* ---------- 过滤引擎（Worker，失败时退回主线程） ---------- */
const engine = (() => {
  let worker = null, local = null, seq = 0, readyP = null, info = null;
  const waits = new Map();
  function viaWorker(type, payload) {
    return new Promise((resolve, reject) => { const id = ++seq; waits.set(id, { resolve, reject }); worker.postMessage({ id, type, payload }); });
  }
  function fallback(payload) {
    if (worker) { worker.terminate(); worker = null; }
    for (const w of waits.values()) w.reject(new Error("worker-failed"));
    waits.clear();
    local = S.createEngine();
    return local.init(payload);
  }
  return {
    init(payload) {
      readyP = (async () => {
        try {
          worker = new Worker("assets/worker.js");
          worker.onmessage = (e) => { const { id, ok, result, error } = e.data; const w = waits.get(id); if (!w) return; waits.delete(id); ok ? w.resolve(result) : w.reject(new Error(error)); };
          const failed = new Promise((_, rej) => { worker.onerror = (ev) => { ev.preventDefault && ev.preventDefault(); rej(new Error("worker-failed")); }; });
          info = await Promise.race([viaWorker("init", payload), failed]);
          info.mode = "worker";
        } catch {
          info = fallback(payload); info.mode = "main";
        }
        return info;
      })();
      return readyP;
    },
    get info() { return info; },
    async call(type, payload) {
      await readyP;
      if (local) return local[type](payload);
      return viaWorker(type, payload);
    },
  };
})();

/* ---------- 1 历史查询 ---------- */
function historyQuery() {
  const q = { page: state.historyPage, size: 20 };
  for (const [k, v] of new FormData($("#history-form"))) if (String(v).trim()) q[k] = String(v).trim();
  return q;
}
function loadHistory() {
  const q = historyQuery(), tb = $("#history-table tbody");
  try {
    const d = S.queryDraws(state.rows, q);
    const filters = Object.entries(q).filter(([k]) => !["page", "size"].includes(k));
    $("#history-total").textContent = filters.length ? `筛选出 ${fmt(d.total)} 期` : `共 ${fmt(d.total)} 期`;
    const hitReds = S.parseNums(q.reds || "", 1, 33);
    const hitBlue = q.blue ? S.parseNums(q.blue, 1, 16)[0] ?? null : null;
    tb.innerHTML = d.items.length ? d.items.map((r) => `<tr>
      <td class="c-s3"><span class="code">${r.code}</span></td><td class="c-s3 c-end">${r.draw_date} <span class="muted">周${esc(r.week)}</span></td>
      <td class="c-wide">${balls(r.reds, r.blue, { hitReds: hitReds.length ? hitReds : null, hitBlue })}</td>
      <td class="num" data-label="和值">${r.sum}</td><td class="num" data-label="销售额（元）">${fmt(r.sales)}</td><td class="num" data-label="奖池（元）">${fmt(r.poolmoney)}</td>
      <td class="num" data-label="一等奖（注）">${fmt(r.prize1_num)}</td><td class="num" data-label="一等单注（元）">${fmt(r.prize1_money)}</td></tr>`).join("")
      : `<tr><td colspan="8" class="c-wide"><div class="empty"><svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/></svg><h3>没有符合条件的开奖</h3><p class="small">当前条件：${esc(filters.map(([k, v]) => `${({ code: "期号", from: "起", to: "止", reds: "红球", blue: "蓝球" })[k]} ${v}`).join("，"))}</p><button class="btn btn-secondary" type="button" id="clear-history">清除筛选</button></div></td></tr>`;
    const c = $("#clear-history"); if (c) c.onclick = () => { $("#history-form").reset(); };
    $("#history-pager").innerHTML = `<span class="muted small pg-info">第 ${d.page} / ${d.pages} 页</span>
      <button class="btn btn-secondary" data-p="1" ${d.page <= 1 ? "disabled" : ""}>首页</button>
      <button class="btn btn-secondary" data-p="${d.page - 1}" ${d.page <= 1 ? "disabled" : ""}>上一页</button>
      <button class="btn btn-secondary" data-p="${d.page + 1}" ${d.page >= d.pages ? "disabled" : ""}>下一页</button>
      <button class="btn btn-secondary" data-p="${d.pages}" ${d.page >= d.pages ? "disabled" : ""}>末页</button>`;
  } catch (e) {
    $("#history-total").textContent = "";
    tb.innerHTML = `<tr><td colspan="8" class="c-wide"><div class="empty"><h3>查询条件有误</h3><p class="small">${esc(e.message)}</p><button class="btn btn-secondary" type="button" id="clear-history">清除筛选</button></div></td></tr>`;
    $("#clear-history").onclick = () => { $("#history-form").reset(); };
    $("#history-pager").innerHTML = "";
  }
}
$("#history-form").addEventListener("submit", (e) => { e.preventDefault(); state.historyPage = 1; loadHistory(); if (document.activeElement) document.activeElement.blur(); });
$("#history-form").addEventListener("reset", () => setTimeout(() => { state.historyPage = 1; loadHistory(); }));
$("#history-pager").addEventListener("click", (e) => {
  const b = e.target.closest("[data-p]"); if (!b) return;
  state.historyPage = +b.dataset.p; loadHistory();
  const card = $("#history-table").closest(".card"); if (mqMobile.matches) card.scrollIntoView({ block: "start" });
});

/* ---------- 2 冷热与遗漏 ---------- */
function loadStats() {
  $$("#stats-seg button").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.n === state.statsN)));
  try { state.stats = state.statsCache[state.statsN] || (state.statsCache[state.statsN] = S.drawStats(state.rows, state.statsN)); renderStats(); }
  catch (e) { $("#stats-chips").innerHTML = `<span class="err">统计失败：${esc(e.message)}</span>`; }
}
$("#stats-seg").addEventListener("click", (e) => { const b = e.target.closest("[data-n]"); if (b) { state.statsN = b.dataset.n; loadStats(); } });
function barChart(el, { values, ticks = null, cls, expected = null, highlight = [] }) {
  const W = Math.max(280, el.clientWidth || 800);
  const H = parseInt(getComputedStyle(el).getPropertyValue("--chart-height"), 10) || 200, L = 28, R = 8, T = 16, B = 22;
  const n = values.length, max = Math.max(1, ...values, ...(ticks || []), expected || 0);
  const step = (W - L - R) / n, bw = Math.max(4, step * 0.62);
  const y = (v) => T + (H - T - B) * (1 - v / max);
  const nice = Math.max(1, Math.ceil(max / 4));
  const showLabel = (i) => step >= 16 || i === 0 || i === n - 1 || (i + 1) % 5 === 0;
  let s = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(el.dataset.label || "")}">`;
  for (let v = 0; v <= max; v += nice) s += `<line class="axis" x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" opacity="${v ? .4 : 1}"/><text x="${L - 6}" y="${y(v) + 3}" text-anchor="end">${v}</text>`;
  values.forEach((v, i) => {
    const x = L + i * step + (step - bw) / 2;
    const hl = highlight.length ? (highlight.includes(i) ? " bar-hot" : " bar-dim") : "";
    s += `<rect class="${cls}${hl}" x="${x.toFixed(1)}" y="${y(v).toFixed(1)}" width="${bw.toFixed(1)}" height="${(H - B - y(v)).toFixed(1)}" rx="2"><title>${pad(i + 1)} 号：${v}${ticks ? `，最大 ${ticks[i]}` : ""}</title></rect>`;
    if (ticks) s += `<line class="tick" x1="${(x - 1).toFixed(1)}" x2="${(x + bw + 1).toFixed(1)}" y1="${y(ticks[i]).toFixed(1)}" y2="${y(ticks[i]).toFixed(1)}"/>`;
    if (step >= 18) s += `<text class="val" x="${(x + bw / 2).toFixed(1)}" y="${(y(v) - 4).toFixed(1)}" text-anchor="middle">${v}</text>`;
    if (showLabel(i)) s += `<text x="${(x + bw / 2).toFixed(1)}" y="${H - 6}" text-anchor="middle">${pad(i + 1)}</text>`;
  });
  if (expected) s += `<line class="exp" x1="${L}" x2="${W - R}" y1="${y(expected)}" y2="${y(expected)}"/>`;
  el.innerHTML = s + "</svg>";
}
const topIdx = (arr, k, desc = true) => arr.map((v, i) => [v, i]).sort((a, b) => (desc ? b[0] - a[0] : a[0] - b[0]) || a[1] - b[1]).slice(0, k).map((x) => x[1]);
function renderStats() {
  const s = state.stats; if (!s) return;
  $("#stats-range").textContent = `统计范围：${s.range[0]} – ${s.range[1]}，共 ${s.red.periods} 期`;
  const hotR = topIdx(s.red.count, 6), coldR = topIdx(s.red.count, 6, false), missR = topIdx(s.red.current, 6);
  const hotB = topIdx(s.blue.count, 3), coldB = topIdx(s.blue.count, 3, false), missB = topIdx(s.blue.current, 3);
  const list = (idx, blue) => `<span class="balls">${idx.map((i) => `<span class="ball ${blue ? "blue " : ""}soft">${pad(i + 1)}</span>`).join("")}</span>`;
  $("#stats-chips").innerHTML = `
    <div class="chip-group"><span>红球热号</span>${list(hotR)}</div><div class="chip-group"><span>红球冷号</span>${list(coldR)}</div>
    <div class="chip-group"><span>红球当前遗漏最久</span>${list(missR)}</div>
    <div class="chip-group"><span>蓝球热号</span>${list(hotB, true)}</div><div class="chip-group"><span>蓝球冷号</span>${list(coldB, true)}</div>
    <div class="chip-group"><span>蓝球遗漏最久</span>${list(missB, true)}</div>`;
  const p = s.red.periods;
  barChart($("#chart-red-count"), { values: s.red.count, cls: "bar-red", expected: (p * 6) / 33, highlight: [...hotR, ...coldR] });
  barChart($("#chart-red-miss"), { values: s.red.current, ticks: s.red.max, cls: "bar-accent" });
  barChart($("#chart-blue-count"), { values: s.blue.count, cls: "bar-blue", expected: p / 16, highlight: [...hotB, ...coldB] });
  barChart($("#chart-blue-miss"), { values: s.blue.current, ticks: s.blue.max, cls: "bar-accent" });
  ["stats-hot", "stats-miss"].forEach((k) => { const b = document.getElementById("help-" + k); if (b && HELP_OPEN.has(k)) b.innerHTML = helpHTML(k); });
}
let rz, lastW = window.innerWidth;
window.addEventListener("resize", () => { clearTimeout(rz); rz = setTimeout(() => { if (window.innerWidth === lastW) return; lastW = window.innerWidth; if (state.tab === "stats" && state.rows) renderStats(); }, 150); });

/* ---------- 3 规则过滤 ---------- */
const RANGE_RULES = [
  { key: "sum", name: "和值", lo: 21, hi: 183, hint: "6 个红球之和，理论范围 21–183，均值 102" },
  { key: "span", name: "跨度", lo: 5, hi: 32, hint: "最大红球 − 最小红球" },
  { key: "ac", name: "AC 值", lo: 0, hi: 10, hint: "15 个两两差值中不同值的个数 − 5，衡量号码离散度" },
  { key: "run", name: "连号", lo: 1, hi: 6, hint: "最长连号长度：1 = 无连号，2 = 有二连号，3 = 三连号…", detail: "连号" },
  { key: "repeat", name: "与上期重号", lo: 0, hi: 6, hint: "与最新一期红球相同的个数", detail: "上期重号" },
];
function renderFilter() {
  const r = state.rules;
  const tog = (key, labels) => `<div class="toggles" data-key="${key}">${labels.map((l, i) => `<button type="button" class="toggle" data-v="${i}" aria-pressed="${!!(r[key] && r[key].includes(i))}">${l}</button>`).join("")}</div>`;
  const ratio = (fn) => [0, 1, 2, 3, 4, 5, 6].map(fn);
  const red = Array.from({ length: 33 }, (_, i) => i + 1).map((n) => `<button type="button" class="pick-ball red" data-n="${n}" data-state="${r.dan_red.includes(n) ? "dan" : r.kill_red.includes(n) ? "kill" : "off"}" aria-label="红球 ${n}">${pad(n)}</button>`).join("");
  const blue = Array.from({ length: 16 }, (_, i) => i + 1).map((n) => `<button type="button" class="pick-ball blue" data-n="${n}" data-state="${r.kill_blue.includes(n) ? "kill" : "off"}" aria-label="蓝球 ${n}">${pad(n)}</button>`).join("");
  const val = (x, i) => (r[x.key] && r[x.key][i] != null ? r[x.key][i] : "");
  const head = (title, key, countId = "") => `<div class="rule-head"><div class="rule-title"><h3>${title}</h3>${helpBtn(key)}</div><span class="rule-count"${countId ? ` id="${countId}"` : ""}></span></div>${helpBox(key)}`;
  $("#filter-rules").innerHTML = `
    <div class="card rule" data-rule="奇偶比">${head("奇偶比（奇:偶）", "odd")}${tog("odd", ratio((i) => `${i}:${6 - i}`))}<p class="rule-hint">不选 = 不限；可多选</p></div>
    <div class="card rule" data-rule="大小比">${head("大小比（大:小）", "big")}${tog("big", ratio((i) => `${i}:${6 - i}`))}<p class="rule-hint">大号 17–33，小号 1–16</p></div>
    ${RANGE_RULES.map((x) => `<div class="card rule" data-rule="${x.detail || x.name}">${head(x.name, x.key)}
      <div class="range" data-key="${x.key}"><input type="number" inputmode="numeric" min="${x.lo}" max="${x.hi}" placeholder="${x.lo}" value="${val(x, 0)}" aria-label="${x.name}最小"><span class="muted">至</span><input type="number" inputmode="numeric" min="${x.lo}" max="${x.hi}" placeholder="${x.hi}" value="${val(x, 1)}" aria-label="${x.name}最大"></div>
      <p class="rule-hint">${x.hint}</p></div>`).join("")}
    <div class="card rule" data-rule="排除历史组合">${head("排除历史组合", "hist")}
      <label class="range"><input type="checkbox" id="ex-hist" ${r.exclude_history ? "checked" : ""}> 排除历史上开出过的 6 红组合</label><p class="rule-hint">历史上已开出约 2 千个不同组合，排除对总数影响极小</p></div>
    <div class="card rule span-2" data-rule="胆红">${head("红球胆 / 杀", "red", "rc-red")}
      <div class="ball-grid" id="f-reds">${red}</div>
      <div class="legend-row"><span>点按切换：普通 → 胆（必含）→ 杀（排除）→ 普通</span><span>胆 ${r.dan_red.length} 个 · 杀 ${r.kill_red.length} 个</span></div></div>
    <div class="card rule span-2" data-rule="杀蓝">${head("杀蓝球", "blue", "rc-blue")}
      <div class="ball-grid" id="f-blues">${blue}</div><div class="legend-row"><span>点按切换：保留 ↔ 杀</span></div></div>`;
  runFilter();
}
$("#filter-rules").addEventListener("click", (e) => {
  const r = state.rules;
  const t = e.target.closest(".toggle");
  if (t) {
    const key = t.parentElement.dataset.key, v = +t.dataset.v;
    const set = new Set(r[key] || []); set.has(v) ? set.delete(v) : set.add(v);
    r[key] = set.size ? [...set].sort() : null; t.setAttribute("aria-pressed", String(set.has(v)));
    return changed();
  }
  const b = e.target.closest(".pick-ball");
  if (b) {
    const n = +b.dataset.n;
    if (b.classList.contains("red")) {
      const st = b.dataset.state, next = st === "off" ? "dan" : st === "dan" ? "kill" : "off";
      if (next === "dan" && r.dan_red.length >= 5) { b.dataset.state = "kill"; r.kill_red.push(n); toast("胆红最多 5 个，已直接切换为杀号"); }
      else {
        r.dan_red = r.dan_red.filter((x) => x !== n); r.kill_red = r.kill_red.filter((x) => x !== n);
        if (next === "dan") r.dan_red.push(n); if (next === "kill") r.kill_red.push(n);
        b.dataset.state = next;
      }
      $(".legend-row span:last-child", b.closest(".rule")).textContent = `胆 ${r.dan_red.length} 个 · 杀 ${r.kill_red.length} 个`;
    } else {
      const kill = b.dataset.state !== "kill";
      if (kill && r.kill_blue.length >= 15) return toast("至少保留 1 个蓝球", { error: true });
      r.kill_blue = kill ? [...r.kill_blue, n] : r.kill_blue.filter((x) => x !== n); b.dataset.state = kill ? "kill" : "off";
    }
    return changed();
  }
});
$("#filter-rules").addEventListener("input", (e) => {
  const rg = e.target.closest(".range[data-key]");
  if (rg) { const [a, b] = $$("input", rg).map((i) => i.value.trim()); state.rules[rg.dataset.key] = a || b ? [a === "" ? null : +a, b === "" ? null : +b] : null; return changed(); }
  if (e.target.id === "ex-hist") { state.rules.exclude_history = e.target.checked; changed(); }
});
let ft, filterSeq = 0;
function changed() { saveRules(); clearTimeout(ft); ft = setTimeout(runFilter, 200); }
const resetRules = () => { state.rules = { ...DEFAULT_RULES, kill_red: [], dan_red: [], kill_blue: [] }; saveRules(); renderFilter(); };
async function runFilter() {
  const box = $("#filter-result"), bar = $("#filter-bar"), my = ++filterSeq;
  if (!engine.info) {
    box.innerHTML = `<h2>过滤结果</h2><div class="skel"></div><p class="small">正在本机生成 ${fmt(S.RED_COMBOS)} 个红球组合的特征表（只需一次）…</p>`;
    bar.innerHTML = `<div class="fb-text"><b>准备中…</b><span>正在生成组合表</span></div>`;
  }
  try {
    const d = await engine.call("filter", { rules: state.rules });
    if (my !== filterSeq) return;
    const pct = (d.red_count / d.red_total) * 100, pctTxt = pct < 0.01 && pct > 0 ? "<0.01" : pct.toFixed(2);
    $$(".rule").forEach((el) => { const hit = d.detail.find((x) => x.name === el.dataset.rule || (el.dataset.rule === "胆红" && x.name === "杀红"));
      el.classList.toggle("is-active", !!hit); });
    $$(".rule").forEach((el) => { const c = $(".rule-count", el); if (!c) return;
      const names = el.dataset.rule === "胆红" ? ["胆红", "杀红"] : [el.dataset.rule];
      const parts = d.detail.filter((x) => names.includes(x.name));
      c.textContent = parts.length ? parts.map((x) => `${names.length > 1 ? x.name + " " : "单独剩余 "}${fmt(x.count)}`).join(" · ") : "不限"; });
    $("#rc-blue").textContent = d.blue_count < 16 ? `保留 ${d.blue_count} / 16` : "不限";
    box.innerHTML = `<div class="rule-title"><h2>过滤结果</h2>${helpBtn("result")}</div>${helpBox("result")}
      <div><div class="small">剩余注数（红球组合 × 蓝球）</div><div class="big-num" id="filter-bets">${fmt(d.bets)}</div></div>
      <div class="bar-track" aria-hidden="true"><div class="bar-fill" id="pct-bar"></div></div>
      <div class="kv"><span>红球组合</span><b>${fmt(d.red_count)} / ${fmt(d.red_total)}</b></div>
      <div class="kv"><span>保留比例</span><b>${pctTxt}%</b></div>
      <div class="kv"><span>蓝球</span><b>${d.blue_count} / 16</b></div>
      <div class="kv"><span>全部买下需</span><b>${fmt(d.bets * 2)} 元</b></div>
      <div class="kv"><span>生效规则</span><b>${d.detail.length} 条</b></div>
      <p class="small">过滤只是缩小选择范围；剩余每一注的中奖概率与被排除的注完全相同。本机计算耗时 ${d.ms} ms${engine.info && engine.info.mode === "main" ? "（主线程）" : ""}。</p>
      <div class="toolbar-actions"><button class="btn btn-ghost" type="button" id="rules-reset">重置规则</button><button class="btn btn-primary" type="button" data-goto="pick">去机选</button></div>`;
    $("#pct-bar").style.width = Math.max(pct, 0.5) + "%";
    $("#rules-reset").onclick = resetRules;
    bar.innerHTML = `<div class="fb-text"><b>剩余 ${fmt(d.bets)} 注</b><span>红 ${fmt(d.red_count)} · 蓝 ${d.blue_count}/16 · ${pctTxt}%</span></div><button class="btn btn-primary" type="button" data-goto="pick">去机选</button>`;
  } catch (e) {
    if (my !== filterSeq) return;
    box.innerHTML = `<h2>过滤结果</h2><p class="err">${esc(e.message)}</p><button class="btn btn-secondary" type="button" id="rules-reset">重置规则</button>`;
    $("#rules-reset").onclick = resetRules;
    bar.innerHTML = `<div class="fb-text"><b class="err">规则有误</b><span>${esc(e.message)}</span></div>`;
  }
}
function ruleChips(r) {
  const out = [], rt = (a) => a.map((i) => `${i}:${6 - i}`).join(" / ");
  if (r.odd) out.push(`奇偶比 ${rt(r.odd)}`); if (r.big) out.push(`大小比 ${rt(r.big)}`);
  RANGE_RULES.forEach((x) => { const v = r[x.key]; if (v) out.push(`${x.name} ${v[0] ?? x.lo}–${v[1] ?? x.hi}`); });
  if (r.dan_red.length) out.push(`胆红 ${r.dan_red.map(pad).join(" ")}`); if (r.kill_red.length) out.push(`杀红 ${r.kill_red.map(pad).join(" ")}`);
  if (r.kill_blue.length) out.push(`杀蓝 ${r.kill_blue.map(pad).join(" ")}`); if (r.exclude_history) out.push("排除历史组合");
  return out.length ? out.map((s) => `<span class="pill">${esc(s)}</span>`).join("") : `<span class="muted small">未设置规则：在全部 ${fmt(S.RED_COMBOS * 16)} 注中随机</span>`;
}

/* ---------- 4 机选 ---------- */
function renderPick() {
  $("#pick-rules").innerHTML = ruleChips(state.rules);
  const tgt = $("#pick-form [name=target]"); if (!tgt.value && state.meta) tgt.value = state.meta.next_code;
  renderPickList();
}
function renderPickList() {
  const el = $("#pick-list");
  $("#pick-save").disabled = !state.picked.length;
  el.innerHTML = state.picked.length ? `<div class="row-between"><h2>本次机选 ${state.picked.length} 注</h2><span class="small">满足规则的红球组合 ${fmt(state.pickPool)} 个中等概率抽取，蓝球在保留的 ${state.pickBlues} 个中随机</span></div>` +
    state.picked.map((p, i) => `<div class="pick-row"><span class="pick-idx">${i + 1}</span>${balls(p.reds, p.blue, { size: "lg" })}
      <span class="pick-meta"><span>和值 ${p.sum}</span><span>跨度 ${p.span}</span><span>AC ${p.ac}</span><span>奇偶 ${p.odd}:${6 - p.odd}</span><span>大小 ${p.big}:${6 - p.big}</span><span>${p.run > 1 ? p.run + " 连号" : "无连号"}</span></span></div>`).join("")
    : `<div class="empty"><svg viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="4"/><circle cx="12" cy="12" r="1.2"/></svg><h3>还没有生成号码</h3><p class="small">设置注数后点「生成」，在当前规则下随机抽取。</p></div>`;
}
async function doPick() {
  const n = +$("#pick-form [name=n]").value || 5;
  const btn = $("#pick-form [type=submit]"); btn.disabled = true; btn.classList.add("is-busy");
  try {
    const d = await engine.call("pick", { rules: state.rules, n });
    state.picked = d.picks; state.pickPool = d.red_count; state.pickBlues = d.blue_count;
    if (!d.picks.length) toast("当前规则下没有任何组合，请放宽规则", { error: true });
    renderPickList();
  } catch (e) { toast("机选失败：" + e.message, { error: true }); }
  finally { btn.disabled = false; btn.classList.remove("is-busy"); }
}
$("#pick-form").addEventListener("submit", (e) => { e.preventDefault(); if (document.activeElement) document.activeElement.blur(); doPick(); });
$("#pick-save").addEventListener("click", () => {
  const target = $("#pick-form [name=target]").value.trim();
  try {
    const ids = store.add(state.picked.map((p) => ({ play: "single", reds: p.reds, blues: [p.blue], target_code: target, multiple: 1, source: "machine" })));
    renderPanelPicks();
    toast(`已存入 ${ids.length} 注到第 ${target} 期买号记录`, { action: { label: "查看", run: () => go("picks") } });
  } catch (e) { toast("保存失败：" + e.message, { error: true }); }
});

/* ---------- 5 买号与对奖 ---------- */
const STATUS = { pending: ["queued", "待开奖"], lost: ["failed", "未中奖"], won: ["done", "已中奖"] };
function loadPicks() {
  renderEntry();
  const tb = $("#picks-table tbody");
  try {
    const { items, summary: s } = computePicks();
    $("#nav-picks-count").textContent = s.records || "";
    const net = s.net;
    $("#picks-summary").innerHTML = [
      ["记录", `${s.records} 条`], ["总注数", fmt(s.bets)], ["总投入", `${fmt(s.cost)} 元`],
      ["已开奖投入", `${fmt(s.drawn_cost)} 元`], ["中奖回报", `${fmt(s.prize)} 元${s.prize_unknown ? "+" : ""}`],
      ["净收益（已开奖）", `<b class="${net > 0 ? "pos" : net < 0 ? "neg" : ""}">${net > 0 ? "+" : ""}${fmt(net)} 元</b>`],
    ].map(([k, v]) => `<div class="card stat"><span>${k}</span>${v.startsWith("<b") ? v : `<b>${v}</b>`}</div>`).join("");
    $("#picks-export").disabled = !items.length;
    tb.innerHTML = items.length ? items.map((it) => {
      const [st, label] = STATUS[it.status];
      const tiers = it.tiers ? Object.entries(it.tiers).map(([k, v]) => `${S.TIER_NAMES[k]}×${v}`).join("，") : "";
      return `<tr data-id="${it.id}"><td class="nowrap c-s4"><span class="code">${it.target_code}</span><div class="small muted">${it.play_name}${it.source === "machine" ? " · 机选" : ""}</div></td>
        <td class="c-wide">${balls(it.reds, it.blues, { wrap: true, dan: it.dan, hitReds: it.draw ? it.draw.reds : null, hitBlue: it.draw ? it.draw.blue : null })}${it.note ? `<div class="small">${esc(it.note)}</div>` : ""}</td>
        <td class="num nowrap" data-label="注数 · 投入">${fmt(it.bets)} 注${it.multiple > 1 ? ` ×${it.multiple}` : ""}<div class="small muted">${fmt(it.cost)} 元</div></td>
        <td class="nowrap c-top-end"><span class="pill" data-status="${st}">${label}</span></td>
        <td class="tiers" data-label="中奖明细">${it.status === "pending" ? "等待开奖数据" : tiers || "—"}</td>
        <td class="num nowrap c-s1 prize" data-label="奖金">${it.status === "pending" ? "—" : fmt(it.prize) + (it.prize_unknown ? "+" : "")}</td>
        <td class="c-s1 c-end"><button class="btn btn-icon" data-del="${it.id}" aria-label="删除记录" title="删除记录"><svg viewBox="0 0 24 24"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg></button></td></tr>`;
    }).join("") : `<tr><td colspan="7" class="c-wide"><div class="empty"><svg viewBox="0 0 24 24"><path d="M5 3h14v18l-3-2-2 2-2-2-2 2-2-2-3 2z"/></svg><h3>还没有买号记录</h3><p class="small">在上方录入单式 / 复式 / 胆拖，或到「机选」生成后一键保存；也可以导入之前导出的 JSON。开奖数据更新后会自动对奖。</p><button class="btn btn-secondary" type="button" data-goto="pick">去机选</button></div></td></tr>`;
    renderPanelPicks();
  } catch (e) {
    tb.innerHTML = `<tr><td colspan="7" class="c-wide"><div class="empty"><h3>读取买号记录失败</h3><p class="small">${esc(e.message)}</p></div></td></tr>`;
  }
}
$("#picks-table").addEventListener("click", async (e) => {
  const b = e.target.closest("[data-del]"); if (!b) return;
  const it = state.picks.items.find((x) => x.id === +b.dataset.del); if (!it) return;
  const ok = await confirmDialog({ title: "删除这条买号记录？", body: `第 ${it.target_code} 期 ${it.play_name} ${it.bets} 注（${it.cost} 元）将从本浏览器的本地存储中删除，无法撤销。需要留底请先「导出」。`, confirmLabel: "删除", danger: true });
  if (!ok) return;
  try { store.remove(it.id); toast("已删除"); loadPicks(); } catch (err) { toast("删除失败：" + err.message, { error: true }); }
});
/* 导出 / 导入 */
$("#picks-export").addEventListener("click", () => {
  let d; try { d = store.read(); } catch (e) { return toast(e.message, { error: true }); }
  if (!d.items.length) return toast("还没有可导出的记录", { error: true });
  const now = new Date();
  const payload = { app: "ssq-pages", kind: "picks", version: 1, exported_at: now.toISOString(), count: d.items.length, items: d.items };
  const blob = new Blob([JSON.stringify(payload, null, 2) + "\n"], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `ssq-picks-${now.getFullYear()}${two(now.getMonth() + 1)}${two(now.getDate())}.json`;
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 30000);
  toast(`已导出 ${d.items.length} 条记录`);
});
$("#picks-import").addEventListener("click", () => $("#picks-file").click());
$("#picks-file").addEventListener("change", async (e) => {
  const file = e.target.files && e.target.files[0]; e.target.value = "";
  if (file) await importPicks(file);
});
const recKey = (x) => JSON.stringify([x.target_code, x.play, x.dan, x.reds, x.blues, x.multiple, x.source, x.note, x.created_at]);
async function importPicks(file) {
  try {
    if (file.size > 5 * 1024 * 1024) throw new Error("文件超过 5 MB，不像是买号记录导出文件");
    let data;
    try { data = JSON.parse(await file.text()); } catch { throw new Error("不是有效的 JSON 文件"); }
    const arr = Array.isArray(data) ? data : data && Array.isArray(data.items) ? data.items : null;
    if (!arr) throw new Error("文件里没有买号记录（缺少 items 列表）");
    const valid = [], bad = [];
    arr.forEach((x, i) => {
      try {
        const n = S.normalizeTicket(x);
        const ca = typeof (x && x.created_at) === "string" && /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?$/.test(x.created_at) ? x.created_at.replace("T", " ") : nowStr();
        valid.push({ ...n, created_at: ca });
      } catch (err) { bad.push(`第 ${i + 1} 条：${err.message}`); }
    });
    if (!valid.length) throw new Error(arr.length ? `没有可导入的有效记录（${bad[0]}）` : "文件里的记录是空的");
    const cur = store.read(), have = new Set(cur.items.map((x) => recKey({ ...x, target_code: String(x.target_code) })));
    const fresh = valid.filter((x) => !have.has(recKey(x))), dup = valid.length - fresh.length;
    const badTxt = bad.length ? `另有 ${bad.length} 条无效将跳过（${bad[0]}${bad.length > 1 ? " 等" : ""}）。` : "";
    let mode;
    if (!cur.items.length) {
      mode = await choiceDialog({ title: `导入 ${valid.length} 条买号记录？`, body: `来自文件「${file.name}」。${badTxt}`, actions: [{ value: "merge", label: "导入", kind: "primary" }] });
    } else {
      mode = await choiceDialog({ title: `导入 ${valid.length} 条买号记录？`,
        body: `来自文件「${file.name}」。${badTxt}本机现有 ${cur.items.length} 条：「合并」会追加 ${fresh.length} 条${dup ? `、跳过 ${dup} 条重复` : ""}；「替换」会先清空本机记录再导入全部 ${valid.length} 条。`,
        actions: [{ value: "replace", label: "替换", kind: "danger" }, { value: "merge", label: "合并", kind: "primary" }] });
    }
    if (!mode) return;
    const list = mode === "replace" ? valid : fresh;
    let ids;
    if (mode === "replace") {   // 一次写入，写失败时原记录不受影响
      const items = list.map((x, i) => ({ id: i + 1, ...x }));
      store.write({ version: 1, next_id: items.length + 1, items }); ids = items.map((x) => x.id);
    } else ids = list.length ? store.add(list, { createdAt: list.map((x) => x.created_at) }) : [];
    toast(mode === "replace" ? `已替换为导入的 ${ids.length} 条记录` : `已导入 ${ids.length} 条记录${dup ? `，跳过 ${dup} 条重复` : ""}`);
    loadPicks();
  } catch (err) { toast("导入失败：" + err.message, { error: true }); }
}
const HINTS = { single: "单式：选 6 个红球 + 1 个蓝球，1 注 2 元。", multiple: "复式：选 6–20 个红球 + 1–16 个蓝球，注数 = C(红,6) × 蓝球数。", dantuo: "胆拖：胆码 1–5 个 + 拖码，胆 + 拖 ≥ 7；注数 = C(拖, 6−胆) × 蓝球数。先选「选胆码」再选「选拖码」。" };
function renderEntry() {
  const en = state.entry;
  $$("#play-seg button").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.play === en.play)));
  $("#dt-seg").hidden = en.play !== "dantuo";
  $$("#dt-seg button").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.dt === en.dt)));
  $("#entry-hint").textContent = HINTS[en.play];
  const tgt = $("#entry-target"); if (!tgt.value && state.meta) tgt.value = state.meta.next_code;
  $("#entry-reds").innerHTML = Array.from({ length: 33 }, (_, i) => i + 1).map((n) => `<button type="button" class="pick-ball red" data-n="${n}" data-state="${en.dan.includes(n) ? "dan" : en.reds.includes(n) ? "on" : "off"}" aria-label="红球 ${n}">${pad(n)}</button>`).join("");
  $("#entry-blues").innerHTML = Array.from({ length: 16 }, (_, i) => i + 1).map((n) => `<button type="button" class="pick-ball blue" data-n="${n}" data-state="${en.blues.includes(n) ? "on" : "off"}" aria-label="蓝球 ${n}">${pad(n)}</button>`).join("");
  calcEntry();
}
function calcEntry() {
  const en = state.entry, mult = Math.max(1, +$("#entry-mult").value || 1);
  const bets = en.blues.length ? S.comb(en.reds.length, 6 - en.dan.length) * en.blues.length : 0;
  const tag = en.play === "dantuo" ? `胆 ${en.dan.length} · 拖 ${en.reds.length}` : `红 ${en.reds.length}`;
  $("#entry-calc").innerHTML = `${tag} · 蓝 ${en.blues.length} → <b>${fmt(bets)}</b> 注 × ${mult} 倍 = <b>${fmt(bets * 2 * mult)}</b> 元`;
}
$("#play-seg").addEventListener("click", (e) => { const b = e.target.closest("[data-play]"); if (!b) return; state.entry.play = b.dataset.play; if (b.dataset.play !== "dantuo") { state.entry.reds = [...new Set([...state.entry.reds])]; state.entry.dan = []; } renderEntry(); });
$("#dt-seg").addEventListener("click", (e) => { const b = e.target.closest("[data-dt]"); if (b) { state.entry.dt = b.dataset.dt; renderEntry(); } });
$("#entry-reds").addEventListener("click", (e) => {
  const b = e.target.closest(".pick-ball"); if (!b) return; const n = +b.dataset.n, en = state.entry;
  const inDan = en.dan.includes(n), inRed = en.reds.includes(n);
  en.dan = en.dan.filter((x) => x !== n); en.reds = en.reds.filter((x) => x !== n);
  if (en.play === "dantuo") { if (en.dt === "dan" && !inDan) { if (en.dan.length >= 5) { toast("胆码最多 5 个", { error: true }); if (inRed) en.reds.push(n); } else en.dan.push(n); } else if (en.dt === "tuo" && !inRed) en.reds.push(n); }
  else if (!inRed) { if (en.play === "single" && en.reds.length >= 6) { toast("单式只能选 6 个红球；要多选请切到复式", { error: true }); } else en.reds.push(n); }
  en.dan.sort((a, b) => a - b); en.reds.sort((a, b) => a - b); renderEntry();
});
$("#entry-blues").addEventListener("click", (e) => {
  const b = e.target.closest(".pick-ball"); if (!b) return; const n = +b.dataset.n, en = state.entry;
  if (en.blues.includes(n)) en.blues = en.blues.filter((x) => x !== n);
  else if (en.play === "single") en.blues = [n]; else en.blues.push(n);
  en.blues.sort((a, b) => a - b); renderEntry();
});
$("#entry-mult").addEventListener("input", calcEntry);
$("#entry-clear").addEventListener("click", () => { Object.assign(state.entry, { dan: [], reds: [], blues: [] }); renderEntry(); });
$("#entry-save").addEventListener("click", () => {
  const en = state.entry;
  try {
    store.add([{ play: en.play, dan: en.dan, reds: en.reds, blues: en.blues, target_code: $("#entry-target").value.trim(), multiple: +$("#entry-mult").value || 1, note: $("#entry-note").value, source: "manual" }]);
    toast("已保存买号记录"); Object.assign(en, { dan: [], reds: [], blues: [] }); $("#entry-note").value = ""; loadPicks();
  } catch (e) { toast("保存失败：" + e.message, { error: true }); }
});

/* ---------- 启动 ---------- */
$$("#theme-seg button").forEach((b) => b.addEventListener("click", () => setThemePref(b.dataset.themePref)));
$("#theme-btn").addEventListener("click", () => {
  const order = ["system", "light", "dark"], cur = document.documentElement.dataset.themePref || "system";
  const next = order[(order.indexOf(cur) + 1) % order.length];
  setThemePref(next); toast(`主题：${THEME_NAMES[next]}`);
});
setThemePref(document.documentElement.dataset.themePref || "system");
syncNavOrientation();
(async function boot() {
  go(params.get("tab") || "history", { push: false });
  try { await loadData(); }
  catch (e) {
    const pill = $("#data-pill"); pill.dataset.status = "failed"; pill.textContent = "数据加载失败";
    const box = `<div class="card"><div class="empty"><h3>无法读取开奖数据</h3><p class="small">${esc(e.message)}。如果是直接双击打开的 index.html，请改用网址访问（GitHub Pages 或本地 http 服务）。</p><button class="btn btn-secondary" type="button" id="retry-data">重试</button></div></div>`;
    $("#latest-mobile").innerHTML = box; $("#panel").innerHTML = box;
    $$("#retry-data").forEach((b) => (b.onclick = () => location.reload()));
    return;
  }
  renderMeta();
  engine.init({ latest: state.meta.latest.reds, history: state.rows.map((r) => r.reds) });
  go(state.tab, { push: false });
  if (state.tab === "pick" && +params.get("autogen")) { $("#pick-form [name=n]").value = +params.get("autogen"); doPick(); }
})();
