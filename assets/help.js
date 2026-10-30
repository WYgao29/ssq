"use strict";
/* 白话「说明」：每条规则 / 每个统计旁的可展开说明。
   例子取自最新一期，「历史上最常见」从 data/draws.json 现算，数据更新后自动跟着变。
   依赖 app.js 里的 state / fmt / pad / S（调用时才用到，所以本文件可先于 app.js 加载）。 */
const HELP_OPEN = new Set((new URLSearchParams(location.search).get("help") || "").split(",").filter(Boolean));
const HELP_ICON = `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M9.6 9.3a2.5 2.5 0 1 1 3.4 2.3c-.6.3-1 .8-1 1.5v.4"/><path d="M12 16.8h.01"/></svg>`;
const helpBtn = (key, label = "说明") =>
  `<button type="button" class="help-btn" data-help="${key}" aria-expanded="${HELP_OPEN.has(key)}" aria-controls="help-${key}">` +
  `${HELP_ICON}${label}</button>`;
const helpBox = (key) => `<div class="explain" id="help-${key}"${HELP_OPEN.has(key) ? "" : " hidden"}>${HELP_OPEN.has(key) ? helpHTML(key) : ""}</div>`;
function syncHelp(root = document) {
  root.querySelectorAll(".help-btn[data-help]").forEach((b) => { b.setAttribute("aria-expanded", String(HELP_OPEN.has(b.dataset.help)));
    if (!b.querySelector("svg")) b.insertAdjacentHTML("afterbegin", HELP_ICON); });   // index.html 里写死的按钮补上图标
  root.querySelectorAll(".explain[id^='help-']").forEach((box) => {
    const key = box.id.slice(5), open = HELP_OPEN.has(key);
    if (open && !box.childElementCount) box.innerHTML = helpHTML(key);
    box.hidden = !open;
  });
}
document.addEventListener("click", (e) => {
  const b = e.target.closest(".help-btn[data-help]"); if (!b) return;
  const key = b.dataset.help, box = document.getElementById("help-" + key), open = !HELP_OPEN.has(key);
  open ? HELP_OPEN.add(key) : HELP_OPEN.delete(key);
  b.setAttribute("aria-expanded", String(open));
  if (box) { if (open) box.innerHTML = helpHTML(key); box.hidden = !open; }
});

/* ---------- 历史分布（按开奖数据现算，缓存到数据变化为止） ---------- */
const C = (n, k) => { if (k < 0 || k > n) return 0; let r = 1; for (let i = 1; i <= k; i++) r = (r * (n - k + i)) / i; return r; };
const featOf = (reds) => {
  const r = [...reds].sort((a, b) => a - b), diffs = new Set();
  for (let i = 0; i < 6; i++) for (let j = i + 1; j < 6; j++) diffs.add(r[j] - r[i]);
  let run = 1, best = 1; for (let i = 1; i < 6; i++) { run = r[i] === r[i - 1] + 1 ? run + 1 : 1; best = Math.max(best, run); }
  return { r, odd: r.filter((x) => x & 1).length, big: r.filter((x) => x >= 17).length, sum: r.reduce((a, b) => a + b, 0),
    span: r[5] - r[0], ac: diffs.size - 5, diffs: diffs.size, run: best };
};
let factsCache = null;
function facts() {
  const rows = state.rows;
  if (factsCache && factsCache.rows === rows) return factsCache;
  const tally = () => new Map(), inc = (m, k) => m.set(k, (m.get(k) || 0) + 1);
  const t = { odd: tally(), big: tally(), span: tally(), ac: tally(), run: tally(), repeat: tally(), sumBand: tally() };
  const sums = [], spans = [], seen = new Map();
  rows.forEach((row, i) => {
    const f = featOf(row.reds);
    inc(t.odd, f.odd); inc(t.big, f.big); inc(t.span, f.span); inc(t.ac, f.ac); inc(t.run, f.run); inc(t.sumBand, Math.floor(f.sum / 10) * 10);
    sums.push(f.sum); spans.push(f.span); inc(seen, f.r.join(","));
    if (i > 0) inc(t.repeat, row.reds.filter((x) => rows[i - 1].reds.includes(x)).length);
  });
  const q = (arr, p) => { const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
  factsCache = { rows, N: rows.length, t, sumMean: sums.reduce((a, b) => a + b, 0) / sums.length, sumP10: q(sums, 0.1), sumP90: q(sums, 0.9),
    spanP10: q(spans, 0.1), spanP90: q(spans, 0.9), distinct: seen.size, dupGroups: [...seen.values()].filter((v) => v > 1).length };
  return factsCache;
}
const pct = (c, n) => `${((c / n) * 100).toFixed(1)}%`;
/** 取前 k 个最常见的值："3:3（33.1%）、4:2（24.5%）…"，并给出合计。 */
function topText(map, n, k, label = (v) => v) {
  const top = [...map.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]).slice(0, k);
  const sum = top.reduce((a, [, c]) => a + c, 0);
  return `${top.map(([v, c]) => `<b>${label(v)}</b>（${pct(c, n)}）`).join("、")}${k > 1 ? `，这 ${top.length} 种合计 ${pct(sum, n)}` : ""}`;
}
const ballsTxt = (reds) => reds.map(pad).join(" ");
const block = (what, example, common, extra = "") =>
  `<dl class="explain-list"><dt>是什么</dt><dd>${what}</dd><dt>举个例子</dt><dd>${example}</dd>${common ? `<dt>历史上最常见</dt><dd>${common}</dd>` : ""}</dl>${extra}`;
const NOTE = `<p class="explain-note">历史常见只说明过去开得多，下一期仍然完全随机；规则只用来缩小范围，不会让中奖更容易。</p>`;

function helpHTML(key) {
  if (!state.rows) return `<p class="muted small">数据加载中…</p>`;
  const F = facts(), N = F.N, rows = state.rows, L = rows[N - 1], P = rows[N - 2], lf = featOf(L.reds);
  const lt = `最新一期（第 ${L.code} 期）红球 <b>${ballsTxt(L.reds)}</b>`;
  const ratio = (v) => `${v}:${6 - v}`;
  const theory = (k, odd = true) => pct(C(17, k) * C(16, 6 - k), S.RED_COMBOS);
  switch (key) {
    case "odd": return block(
      "6 个红球里单号（奇数）和双号（偶数）各几个。写成「单:双」，3:3 就是 3 个单号、3 个双号。可以多选，不选就是不限。",
      `${lt}：单号 ${lf.r.filter((x) => x & 1).map(pad).join("、") || "无"}，共 ${lf.odd} 个 → 奇偶比 <b>${ratio(lf.odd)}</b>。`,
      `全部 ${fmt(N)} 期里：${topText(F.t.odd, N, 3, ratio)}。纯随机的理论占比：3:3 ${theory(3)}、4:2 ${theory(4)}、2:4 ${theory(2)}，和历史很接近。`) + NOTE;
    case "big": return block(
      "17–33 算大号（17 个），1–16 算小号（16 个），看 6 个红球里大号、小号各几个，写成「大:小」。",
      `${lt}：大号 ${lf.r.filter((x) => x >= 17).map(pad).join("、") || "无"}，共 ${lf.big} 个 → 大小比 <b>${ratio(lf.big)}</b>。`,
      `全部 ${fmt(N)} 期里：${topText(F.t.big, N, 3, ratio)}。理论占比：3:3 ${theory(3)}、4:2 ${theory(4)}、2:4 ${theory(2)}。`) + NOTE;
    case "sum": return block(
      "6 个红球加起来的总数。最小 21（01+02+03+04+05+06），最大 183（28+29+30+31+32+33），理论平均 102。填一个范围，比如 80 至 130。",
      `${lt}：${L.reds.join(" + ")} = <b>${lf.sum}</b>。`,
      `历史平均 ${F.sumMean.toFixed(1)}；最常见的区间是 ${topText(F.t.sumBand, N, 3, (v) => `${v}–${v + 9}`)}；约 80% 的期数落在 ${F.sumP10}–${F.sumP90} 之间。`) + NOTE;
    case "span": return block(
      "最大的红球减最小的红球，看号码铺得多开。最小 5（如 01–06），最大 32（01 和 33 同时出现）。",
      `${lt}：${pad(lf.r[5])} − ${pad(lf.r[0])} = 跨度 <b>${lf.span}</b>。`,
      `${topText(F.t.span, N, 3)}；约 80% 的期数跨度在 ${F.spanP10}–${F.spanP90} 之间。`) + NOTE;
    case "ac": return block(
      "号码的分散程度。6 个号两两相减共 15 个差，数一下有几种不同的差，再减 5。范围 0–10，越大越分散；01 02 03 04 05 06 的差只有 1–5 五种，AC 值是 0。",
      `${lt}：15 个差里有 ${lf.diffs} 种不同的值，${lf.diffs} − 5 = AC 值 <b>${lf.ac}</b>。`,
      `${topText(F.t.ac, N, 3)}。AC 值 0–3 的组合非常少见。`) + NOTE;
    case "run": return block(
      "最长有几个号连在一起。1 = 没有连号；2 = 有两个连着（如 11 12）；3 = 三个连着（如 11 12 13），以此类推。填范围，比如 1 至 2 表示「没有连号或最多两连」。",
      `${lt}：${lf.run > 1 ? `最长连号 ${lf.run} 个` : "没有相邻的号"} → 连号 <b>${lf.run}</b>。`,
      `${topText(F.t.run, N, 3, (v) => (v === 1 ? "1（无连号）" : v))}。`) + NOTE;
    case "repeat": return block(
      `下一期的红球和最新一期（第 ${L.code} 期：${ballsTxt(L.reds)}）有几个一样。0 = 一个都不重复。`,
      `第 ${P.code} 期 ${ballsTxt(P.reds)} → 第 ${L.code} 期 ${ballsTxt(L.reds)}，重复了 ${L.reds.filter((x) => P.reds.includes(x)).map(pad).join("、") || "0 个"}，重号 <b>${L.reds.filter((x) => P.reds.includes(x)).length}</b>。`,
      `相邻两期比较（共 ${fmt(N - 1)} 次）：${topText(F.t.repeat, N - 1, 3)}。`) + NOTE;
    case "hist": return block(
      "历史上开出过的 6 个红球组合不再选（只看红球，不看蓝球）。",
      `勾上后，${lt} 这个组合会被排除。`,
      `${fmt(N)} 期里出现过 ${fmt(F.distinct)} 种不同的红球组合${F.dupGroups ? `（有 ${F.dupGroups} 个组合开出过不止一次）` : ""}，只占全部 ${fmt(S.RED_COMBOS)} 种的 ${pct(F.distinct, S.RED_COMBOS)}，所以对剩余注数几乎没影响。`);
    case "red": return block(
      "给每个红球指定：<b>胆</b> = 选出的号码必须包含它；<b>杀</b> = 一定不要它。点一下是胆，再点一下是杀，第三下还原。胆最多 5 个。",
      "把 07 设为胆、01 和 33 设为杀：剩下的组合都含 07，并且都不含 01、33。",
      `每个红球在一期里被开出的机会都是 6/33 ≈ 18.2%。全部 ${fmt(N)} 期里，单个红球出现次数在 ${(() => { const c = state.statsCache.all || S.drawStats(rows, "all"); state.statsCache.all = c; return `${Math.min(...c.red.count)}–${Math.max(...c.red.count)}`; })()} 次之间，差别属于正常的随机波动。`);
    case "blue": return block(
      "点一下某个蓝球，它就不选（杀掉）；再点一下恢复。至少保留 1 个。",
      "杀掉 16 号：剩余注数 = 红球组合数 × 15。",
      `每个蓝球每期被开出的机会都是 1/16 = 6.25%。`);
    case "result": return block(
      "按当前设置还剩多少注可以选：剩余注数 = 剩下的红球组合数 × 保留的蓝球个数。每注 2 元。每条规则右上角的「单独剩余」是只开这一条规则时剩多少红球组合。",
      `全不限时是 ${fmt(S.RED_COMBOS)} × 16 = <b>${fmt(S.RED_COMBOS * 16)}</b> 注（全买下要 ${fmt(S.RED_COMBOS * 32)} 元）。设成示例规则后剩 65,045 个红球组合、15 个蓝球，就是 65,045 × 15 = 975,675 注。`,
      "", `<p class="explain-note">不管剩多少注，每一注中一等奖的机会都是 1/${fmt(S.RED_COMBOS * 16)}。过滤只是帮你缩小挑选范围。</p>`);
    case "pick": return block(
      "在当前规则剩下的红球组合里等概率随机抽，蓝球在保留的蓝球里随机抽。用浏览器的安全随机数（crypto.getRandomValues），每注互相独立。",
      "设好规则后填注数（1–100）点「生成」，满意的话点「全部存入买号记录」，以后开奖了会自动对奖。", "");
    case "stats-hot": {
      const s = state.stats || S.drawStats(rows, state.statsN), p = s.red.periods;
      const iMax = s.red.count.indexOf(Math.max(...s.red.count)), iMin = s.red.count.indexOf(Math.min(...s.red.count));
      return block(
        "在所选范围（近 30 / 50 / 100 期或全部）里数每个号开出了几次：开得最多的 6 个红球、3 个蓝球叫<b>热号</b>，最少的叫<b>冷号</b>。图里的虚线是理论期望：红球每期开出概率 6/33，蓝球 1/16。",
        `当前范围共 ${p} 期，红球理论上每个号约出现 ${((p * 6) / 33).toFixed(1)} 次；实际 ${pad(iMax + 1)} 号出现 ${s.red.count[iMax]} 次最多，${pad(iMin + 1)} 号 ${s.red.count[iMin]} 次最少。蓝球理论约 ${(p / 16).toFixed(1)} 次。`,
        "", `<p class="explain-note">热号不会因为「手热」更容易出，冷号也不会因为「该出了」更容易出。期数越少，冷热差别越大，这是正常的随机波动。</p>`);
    }
    case "stats-miss": {
      const s = state.stats || S.drawStats(rows, state.statsN);
      const iR = s.red.current.indexOf(Math.max(...s.red.current)), iB = s.blue.current.indexOf(Math.max(...s.blue.current));
      return block(
        "<b>当前遗漏</b>：一个号从上次开出到现在，已经连续多少期没开（按全部历史算）；最新一期刚开出的号是 0。<br><b>最大遗漏</b>：在所选范围里，这个号最长连续多少期没开（图中短横线）。",
        `红球 ${pad(iR + 1)} 号当前遗漏 ${s.red.current[iR]} 期，是现在最久没开的红球；蓝球 ${pad(iB + 1)} 号当前遗漏 ${s.blue.current[iB]} 期。`,
        `红球平均大约每 5.5 期开一次（33÷6），蓝球大约每 16 期开一次，所以红球遗漏 10 期以上、蓝球遗漏 30 期以上都不稀奇。`,
        `<p class="explain-note">遗漏再久，下一期开出的概率也不变（红球 18.2%，蓝球 6.25%）。</p>`);
    }
    case "prize": return prizeHelp(L);
    case "plays": return playsHelp(L);
    default: return "";
  }
}
function prizeHelp(L) {
  // 各奖级理论中奖注数（在 17,721,088 注里）：中 m 个红球 = C(6,m)·C(27,6−m)，蓝球中 1 种 / 不中 15 种
  const ways = (m, blue) => C(6, m) * C(27, 6 - m) * (blue ? 1 : 15), total = S.RED_COMBOS * 16;
  const tiers = [
    ["一等奖", "6 红 + 1 蓝", [[6, 1]], `浮动，最新一期 ${fmt(L.prize1_money)} 元`],
    ["二等奖", "6 红 + 0 蓝", [[6, 0]], `浮动，最新一期 ${fmt(L.prize2_money)} 元`],
    ["三等奖", "5 红 + 1 蓝", [[5, 1]], "3,000 元"],
    ["四等奖", "5 红 + 0 蓝，或 4 红 + 1 蓝", [[5, 0], [4, 1]], "200 元"],
    ["五等奖", "4 红 + 0 蓝，或 3 红 + 1 蓝", [[4, 0], [3, 1]], "10 元"],
    ["六等奖", "2 红 + 1 蓝、1 红 + 1 蓝、0 红 + 1 蓝", [[2, 1], [1, 1], [0, 1]], "5 元"],
  ];
  const anyWin = tiers.reduce((a, t) => a + t[2].reduce((b, [m, bl]) => b + ways(m, bl), 0), 0);
  const odds = (w) => (w === 1 ? fmt(total) : fmt(Math.round(total / w)));
  return `<p>开奖号是 6 个红球 + 1 个蓝球。你的号码和开奖号比：中了几个红球（不管顺序）、蓝球中没中，按下表算奖级。一注只算最高的那一个奖级。</p>
    <div class="explain-table-wrap"><table class="explain-table"><thead><tr><th>奖级</th><th>中奖条件</th><th class="num">单注奖金</th><th class="num">约几注中 1 注</th></tr></thead><tbody>
    ${tiers.map(([n, cond, ws, money]) => `<tr><td>${n}</td><td>${cond}</td><td class="num">${money}</td><td class="num">${odds(ws.reduce((b, [m, bl]) => b + ways(m, bl), 0))}</td></tr>`).join("")}
    </tbody></table></div>
    <dl class="explain-list"><dt>举个例子</dt><dd>第 ${L.code} 期开 <b>${ballsTxt(L.reds)} + ${pad(L.blue)}</b>。你买 ${ballsTxt(L.reds.slice(0, 3))} ${ballsTxt([1, 2, 4, 5, 6, 7, 8].filter((x) => !L.reds.includes(x)).slice(0, 3))} + ${pad(L.blue)}：中 3 红 + 1 蓝 → 五等奖 10 元；同样的红球配别的蓝球就只中 3 红，没有奖。</dd></dl>
    <p class="explain-note">任意一注中任何奖的机会约 ${pct(anyWin, total)}（其中绝大多数是 5 元的六等奖）；中一等奖是 ${fmt(total)} 分之一。一二等奖金额每期不同，这里按该期公告计算；倍投时奖金乘以倍数。</p>`;
}
function playsHelp(L) {
  const ex1 = S.checkTicket([], [1, 2, 3, 4, 11, 17, 22], [9, 10], 1, L.reds, L.blue, L.prize1_money, L.prize2_money);
  const tierTxt = (r) => Object.keys(r.tiers).length ? Object.entries(r.tiers).map(([k, v]) => `${"一二三四五六"[k - 1]}等奖 ${v} 注`).join("、") + `，共 ${fmt(r.prize)} 元` : "没有中奖";
  return `<dl class="explain-list">
    <dt>单式</dt><dd>选 6 个红球 + 1 个蓝球，就是 1 注，2 元。</dd>
    <dt>复式</dt><dd>多选几个号，系统把它们所有的「6 红 + 1 蓝」搭配都买下。注数 = 从选的红球里挑 6 个的组合数 × 蓝球个数。<br>
      例：7 个红球 + 2 个蓝球 = C(7,6) × 2 = 7 × 2 = <b>14 注，28 元</b>；8 个红球 + 1 个蓝球 = C(8,6) = 28 注，56 元。</dd>
    <dt>胆拖</dt><dd><b>胆码</b>（1–5 个）是每一注都带的号，<b>拖码</b>用来补齐剩下的位置。注数 = 从拖码里挑 (6 − 胆码数) 个的组合数 × 蓝球个数。<br>
      例：胆 03 11，拖 01 02 04 17 22，蓝 09 → C(5,4) × 1 = <b>5 注，10 元</b>；倍数选 2 就是 20 元。</dd>
    <dt>倍数</dt><dd>同样的号码买几份，投入和奖金都乘以倍数。</dd>
    <dt>怎么对奖</dt><dd>复式、胆拖都拆成一注一注分别对奖，再加起来。比如复式 01 02 03 04 11 17 22 + 09 10 对第 ${L.code} 期：${tierTxt(ex1)}。</dd>
  </dl>`;
}
