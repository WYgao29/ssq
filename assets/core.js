/* 双色球核心逻辑（纯函数，无 DOM）：web/lottery.py 与 server.py 计算部分的 JS 移植。
   页面用 <script> 加载，Web Worker 用 importScripts 加载，Node 自测用 require。 */
(function (root) {
  "use strict";
  const RED_MAX = 33, BLUE_MAX = 16, RED_COMBOS = 1107568, PRICE_PER_BET = 2;
  const FIXED_PRIZE = { 3: 3000, 4: 200, 5: 10, 6: 5 };
  const TIER_NAMES = { 1: "一等奖", 2: "二等奖", 3: "三等奖", 4: "四等奖", 5: "五等奖", 6: "六等奖" };
  const PLAYS = { single: "单式", multiple: "复式", dantuo: "胆拖" };

  class RuleError extends Error { constructor(msg) { super(msg); this.name = "RuleError"; } }

  /** 组合数 C(n,k)，n ≤ 33 时结果在安全整数内，逐步相乘相除始终为整数。 */
  function comb(n, k) {
    if (k < 0 || k > n) return 0;
    let r = 1;
    for (let i = 1; i <= k; i++) r = (r * (n - k + i)) / i;
    return r;
  }
  function popcount32(x) {
    x = x - ((x >>> 1) & 0x55555555);
    x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
    return (((x + (x >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
  }
  /** 等价于 Python int(x)：整数、整数字符串（可带空白）；其余报错。 */
  function toInt(x, what = "数值") {
    if (typeof x === "boolean") return x ? 1 : 0;
    if (typeof x === "number" && Number.isFinite(x)) return Math.trunc(x);
    if (typeof x === "string" && /^\s*[+-]?\d+\s*$/.test(x)) return parseInt(x, 10);
    throw new RuleError(`${what}格式不正确：${String(x).slice(0, 20)}`);
  }
  const isNone = (v) => v === null || v === undefined;

  /* ---------------------------------------------------------------- 组合特征表 */
  /** 全部 C(33,6) 红球组合（字典序，与 itertools.combinations 顺序一致）及特征。 */
  function buildComboTable() {
    const N = RED_COMBOS;
    const reds = new Uint8Array(N * 6), odd = new Uint8Array(N), big = new Uint8Array(N), total = new Uint8Array(N),
      span = new Uint8Array(N), run = new Uint8Array(N), ac = new Uint8Array(N),
      lo = new Int32Array(N), hi = new Uint8Array(N);       // 位掩码：lo 第 n−1 位 = 红球 n（1–32），hi = 是否含 33
    const c = [0, 0, 0, 0, 0, 0];
    let i = 0;
    for (c[0] = 1; c[0] <= 28; c[0]++) for (c[1] = c[0] + 1; c[1] <= 29; c[1]++) for (c[2] = c[1] + 1; c[2] <= 30; c[2]++)
      for (c[3] = c[2] + 1; c[3] <= 31; c[3]++) for (c[4] = c[3] + 1; c[4] <= 32; c[4]++) for (c[5] = c[4] + 1; c[5] <= 33; c[5]++) {
        let o = 0, b = 0, s = 0, m = 0, h = 0, longest = 1, cur = 1, dm = 0;
        for (let k = 0; k < 6; k++) {
          const v = c[k];
          reds[i * 6 + k] = v; o += v & 1; if (v >= 17) b++; s += v;
          if (v === 33) h = 1; else m |= 1 << (v - 1);
          if (k) { if (v - c[k - 1] === 1) { cur++; if (cur > longest) longest = cur; } else cur = 1; }
          for (let j = 0; j < k; j++) dm |= 1 << (v - c[j] - 1);
        }
        odd[i] = o; big[i] = b; total[i] = s; span[i] = c[5] - c[0]; run[i] = longest;
        ac[i] = popcount32(dm) - 5; lo[i] = m; hi[i] = h; i++;
      }
    return { reds, odd, big, total, span, run, ac, lo, hi, size: N };
  }
  /** 6 个升序红球在字典序中的下标（与组合表行号一致）。 */
  function comboRank(rs) {
    let r = 0, prev = 0;
    for (let i = 0; i < 6; i++) {
      for (let v = prev + 1; v < rs[i]; v++) r += comb(RED_MAX - v, 5 - i);
      prev = rs[i];
    }
    return r;
  }
  function maskOf(nums) {
    let lo = 0, hi = 0;
    for (const n of nums) { if (n === 33) hi = 1; else lo |= 1 << (n - 1); }
    return { lo, hi };
  }

  /* ---------------------------------------------------------------- 规则 */
  function intList(v, lo, hi, name) {
    if (isNone(v) || v === "") return null;
    if (!Array.isArray(v)) throw new RuleError(`${name}格式不正确`);
    const out = [...new Set(v.map((x) => toInt(x, name)))].sort((a, b) => a - b);
    if (out.some((x) => x < lo || x > hi)) throw new RuleError(`${name}超出范围 ${lo}–${hi}`);
    return out;
  }
  function range(v, lo, hi, name) {
    if (isNone(v)) return null;
    if (!Array.isArray(v) || v.length !== 2) throw new RuleError(`${name}格式不正确`);
    const a = isNone(v[0]) || v[0] === "" ? lo : toInt(v[0], name);
    const b = isNone(v[1]) || v[1] === "" ? hi : toInt(v[1], name);
    if (a > b) throw new RuleError(`${name}最小值不能大于最大值`);
    if (a <= lo && b >= hi) return null; // 不限
    return [Math.max(a, lo), Math.min(b, hi)];
  }
  function parseRules(raw) {
    raw = raw || {};
    const r = {
      odd: intList(raw.odd, 0, 6, "奇数个数"),
      big: intList(raw.big, 0, 6, "大号个数"),
      sum: range(raw.sum, 21, 183, "和值"),
      span: range(raw.span, 5, 32, "跨度"),
      ac: range(raw.ac, 0, 10, "AC 值"),
      run: range(raw.run, 1, 6, "最长连号"),
      repeat: range(raw.repeat, 0, 6, "上期重号"),
      kill_red: intList(raw.kill_red, 1, RED_MAX, "杀红"),
      dan_red: intList(raw.dan_red, 1, RED_MAX, "胆红"),
      kill_blue: intList(raw.kill_blue, 1, BLUE_MAX, "杀蓝"),
      exclude_history: !!raw.exclude_history,
    };
    if (r.odd && r.odd.length === 0) throw new RuleError("奇偶比至少选一项");
    if (r.big && r.big.length === 0) throw new RuleError("大小比至少选一项");
    if (r.dan_red && r.dan_red.length > 5) throw new RuleError("胆红最多 5 个");
    if (r.dan_red && r.dan_red.length && r.kill_red && r.dan_red.some((x) => r.kill_red.includes(x)))
      throw new RuleError("同一个号码不能既是胆又被杀");
    if (r.kill_red && r.kill_red.length > RED_MAX - 6) throw new RuleError("杀红过多，至少要保留 6 个红球");
    if (r.kill_blue && r.kill_blue.length >= BLUE_MAX) throw new RuleError("至少要保留 1 个蓝球");
    return r;
  }
  function allowedBlues(r) {
    const killed = new Set(r.kill_blue || []);
    const out = [];
    for (let b = 1; b <= BLUE_MAX; b++) if (!killed.has(b)) out.push(b);
    return out;
  }
  /**
   * 规则过滤。ctx: { last: 最新一期红球, histFlag: Uint8Array(行号→是否开出过) }。
   * 返回 { count, detail: [[规则名, 单独剩余数]], indices?: Int32Array }，与 lottery.apply_rules 同序同义。
   */
  function applyRules(t, r, ctx, { collect = false } = {}) {
    const parts = [];
    const lut = (arr) => { const u = new Uint8Array(8); arr.forEach((x) => (u[x] = 1)); return u; };
    if (r.odd) { const u = lut(r.odd), a = t.odd; parts.push(["奇偶比", (i) => u[a[i]] === 1]); }
    if (r.big) { const u = lut(r.big), a = t.big; parts.push(["大小比", (i) => u[a[i]] === 1]); }
    for (const [name, a, rng] of [["和值", t.total, r.sum], ["跨度", t.span, r.span], ["AC 值", t.ac, r.ac], ["连号", t.run, r.run]]) {
      if (rng) { const [x, y] = rng; parts.push([name, (i) => a[i] >= x && a[i] <= y]); }
    }
    const { lo, hi } = t;
    if (r.repeat) {
      const m = maskOf(ctx.last || []), [x, y] = r.repeat;
      parts.push(["上期重号", (i) => { const k = popcount32(lo[i] & m.lo) + (hi[i] & m.hi); return k >= x && k <= y; }]);
    }
    if (r.kill_red && r.kill_red.length) { const m = maskOf(r.kill_red); parts.push(["杀红", (i) => (lo[i] & m.lo) === 0 && (hi[i] & m.hi) === 0]); }
    if (r.dan_red && r.dan_red.length) { const m = maskOf(r.dan_red); parts.push(["胆红", (i) => (lo[i] & m.lo) === m.lo && (hi[i] & m.hi) === m.hi]); }
    if (r.exclude_history && ctx.histCount) { const f = ctx.histFlag; parts.push(["排除历史组合", (i) => f[i] === 0]); }
    const P = parts.length, tests = parts.map((p) => p[1]), counts = new Float64Array(P);
    const idx = collect ? new Int32Array(t.size) : null;
    let total = 0;
    for (let i = 0; i < t.size; i++) {
      let ok = true;
      for (let p = 0; p < P; p++) { if (tests[p](i)) counts[p]++; else ok = false; }
      if (ok) { if (idx) idx[total] = i; total++; }
    }
    return { count: total, detail: parts.map((p, k) => [p[0], counts[k]]), indices: idx ? idx.subarray(0, total) : null };
  }
  function makeContext(t, latestReds, historyReds) {
    const histFlag = new Uint8Array(t.size);
    let histCount = 0;
    for (const rs of historyReds) { const k = comboRank(rs); if (!histFlag[k]) { histFlag[k] = 1; histCount++; } }
    return { last: latestReds || [], histFlag, histCount };
  }
  /** 均匀随机整数 [0, n)；有 crypto 用 crypto，拒绝采样避免取模偏差。 */
  function randInt(n) {
    const c = root.crypto;
    if (c && c.getRandomValues) {
      const buf = new Uint32Array(1), lim = Math.floor(0x100000000 / n) * n;
      do c.getRandomValues(buf); while (buf[0] >= lim);
      return buf[0] % n;
    }
    return Math.floor(Math.random() * n);
  }
  function randomPicks(t, indices, blues, n) {
    const L = indices.length;
    if (!L) return [];
    const k = Math.min(n, L), chosen = [], seen = new Set();
    while (chosen.length < k) { const j = randInt(L); if (!seen.has(j)) { seen.add(j); chosen.push(indices[j]); } }
    return chosen.map((i) => ({
      reds: Array.from(t.reds.subarray(i * 6, i * 6 + 6)), blue: blues[randInt(blues.length)],
      sum: t.total[i], span: t.span[i], ac: t.ac[i], odd: t.odd[i], big: t.big[i], run: t.run[i],
    }));
  }

  /* ---------------------------------------------------------------- 投注与对奖 */
  function normalizeTicket(raw) {
    raw = raw || {};
    const play = raw.play;
    if (!Object.prototype.hasOwnProperty.call(PLAYS, play)) throw new RuleError("玩法只能是单式、复式或胆拖");
    const nums = (key, lo, hi) => {
      let v = raw[key] || [];
      if (typeof v === "string") v = v.replace(/，/g, ",").replace(/ /g, ",").split(",").filter((x) => x.trim());
      if (!Array.isArray(v)) throw new RuleError("号码格式不正确");
      const out = v.map((x) => toInt(x, "号码"));
      if (new Set(out).size !== out.length) throw new RuleError("号码有重复");
      if (out.some((x) => x < lo || x > hi)) throw new RuleError(`号码超出范围 ${lo}–${hi}`);
      return out.sort((a, b) => a - b);
    };
    const dan = nums("dan", 1, RED_MAX), reds = nums("reds", 1, RED_MAX), blues = nums("blues", 1, BLUE_MAX);
    if (!blues.length) throw new RuleError("至少选 1 个蓝球");
    if (play === "single") {
      if (dan.length || reds.length !== 6 || blues.length !== 1) throw new RuleError("单式需要 6 个红球 + 1 个蓝球");
    } else if (play === "multiple") {
      if (dan.length) throw new RuleError("复式不含胆码");
      if (reds.length < 6 || reds.length > 20) throw new RuleError("复式红球需 6–20 个");
      if (reds.length === 6 && blues.length === 1) throw new RuleError("6 红 + 1 蓝 只有 1 注，请选单式");
    } else {
      if (dan.length < 1 || dan.length > 5) throw new RuleError("胆拖的胆码需 1–5 个");
      if (dan.some((x) => reds.includes(x))) throw new RuleError("胆码与拖码不能重复");
      if (dan.length + reds.length < 7) throw new RuleError("胆码 + 拖码至少 7 个");
    }
    const code = String(raw.target_code || "").trim();
    if (!/^\d{7}$/.test(code)) throw new RuleError("目标期号应为 7 位数字，如 2026125");
    const mult = toInt(raw.multiple || 1, "倍数");
    if (mult < 1 || mult > 99) throw new RuleError("倍数需 1–99");
    return { play, dan, reds, blues, target_code: code, multiple: mult,
      source: ["manual", "machine"].includes(raw.source) ? raw.source : "manual",
      note: Array.from(String(raw.note || "")).slice(0, 200).join("") };
  }
  const betCount = (dan, reds, blues) => comb(reds.length, 6 - dan.length) * blues.length;
  function tierOf(redHits, blueHit) {
    if (redHits === 6) return blueHit ? 1 : 2;
    if (redHits === 5) return blueHit ? 3 : 4;
    if (redHits === 4) return blueHit ? 4 : 5;
    if (redHits === 3) return blueHit ? 5 : 0;
    return blueHit ? 6 : 0;
  }
  /** 组合计数法对奖：复式 / 胆拖不展开也能算出每个等级的中奖注数。 */
  function checkTicket(dan, reds, blues, multiple, winReds, winBlue, prize1Money, prize2Money) {
    const W = new Set(winReds);
    const hd = dan.filter((x) => W.has(x)).length, ht = reds.filter((x) => W.has(x)).length;
    const need = 6 - dan.length, T = reds.length;
    const blueHit = blues.includes(winBlue) ? 1 : 0, blueMiss = blues.length - blueHit;
    const tiers = {};
    for (let j = 0; j <= need; j++) {
      const cnt = comb(ht, j) * comb(T - ht, need - j);
      if (!cnt) continue;
      const k = hd + j;
      for (const [hit, bn] of [[true, blueHit], [false, blueMiss]]) {
        const tier = tierOf(k, hit);
        if (tier && bn) tiers[tier] = (tiers[tier] || 0) + cnt * bn * multiple;
      }
    }
    let money = 0, unknown = false;
    const floating = { 1: prize1Money, 2: prize2Money };
    const out = {};
    for (const tier of Object.keys(tiers).map(Number).sort((a, b) => a - b)) {
      out[String(tier)] = tiers[tier];
      const unit = tier in FIXED_PRIZE ? FIXED_PRIZE[tier] : floating[tier];
      if (isNone(unit)) { unknown = true; continue; }
      money += unit * tiers[tier];
    }
    return { tiers: out, prize: money, prize_unknown: unknown };
  }
  /** 等价于 data.list_picks：records 为本地记录，byCode 为 期号→开奖。 */
  function listPicks(records, byCode) {
    const rows = [...records].sort((a, b) => (a.target_code < b.target_code ? 1 : a.target_code > b.target_code ? -1 : b.id - a.id));
    const summary = { records: 0, bets: 0, cost: 0, drawn_cost: 0, prize: 0, won_records: 0, pending_records: 0, prize_unknown: false };
    const items = rows.map((r) => {
      const bets = betCount(r.dan, r.reds, r.blues), cost = bets * PRICE_PER_BET * r.multiple;
      const item = { ...r, play_name: PLAYS[r.play], bets, cost };
      const d = byCode.get(r.target_code);
      summary.records += 1; summary.bets += bets * r.multiple; summary.cost += cost;
      if (!d) { item.status = "pending"; summary.pending_records += 1; }
      else {
        const res = checkTicket(r.dan, r.reds, r.blues, r.multiple, d.reds, d.blue, d.prize1_money, d.prize2_money);
        Object.assign(item, res);
        item.draw = { reds: d.reds, blue: d.blue, date: d.draw_date };
        const won = Object.keys(res.tiers).length > 0;
        item.status = won ? "won" : "lost";
        summary.drawn_cost += cost; summary.prize += res.prize;
        summary.prize_unknown = summary.prize_unknown || res.prize_unknown;
        summary.won_records += won ? 1 : 0;
      }
      return item;
    });
    summary.net = summary.prize - summary.drawn_cost;
    return { items, summary };
  }

  /* ---------------------------------------------------------------- 开奖数据 */
  function parseDraws(json) {
    if (!json || !Array.isArray(json.rows) || !Array.isArray(json.fields)) throw new Error("draws.json 格式不正确");
    const f = Object.fromEntries(json.fields.map((k, i) => [k, i]));
    return json.rows.map((x) => {
      const reds = [...x[f.reds]].sort((a, b) => a - b), p = x[f.prizes] || [];
      const d = { code: x[f.code], draw_date: x[f.date], week: x[f.week], reds, blue: x[f.blue],
        sales: x[f.sales], poolmoney: x[f.pool], sum: reds.reduce((a, b) => a + b, 0) };
      for (let i = 0; i < 6; i++) { d[`prize${i + 1}_num`] = p[i] ? p[i][0] : null; d[`prize${i + 1}_money`] = p[i] ? p[i][1] : null; }
      return d;
    });
  }
  function parseNums(s, lo, hi) {
    if (!s) return [];
    const out = [];
    for (const part of String(s).replace(/，/g, ",").replace(/ /g, ",").split(",")) {
      if (!part.trim()) continue;
      const n = toInt(part, "号码");
      if (n < lo || n > hi) throw new RuleError(`号码 ${n} 超出范围 ${lo}–${hi}`);
      out.push(n);
    }
    return out;
  }
  /** 等价于 server.api_draws：rows 按期号升序。 */
  function queryDraws(rows, q) {
    const code = String(q.code || "").trim(), from = q.from || "", to = q.to || "";
    const reds = new Set(parseNums(q.reds, 1, 33)), blue = parseNums(q.blue, 1, 16);
    let page = Math.max(1, toInt(q.page || 1, "页码"));
    const size = Math.min(100, Math.max(5, toInt(q.size || 20, "每页条数")));
    const out = [];
    for (let i = rows.length - 1; i >= 0; i--) {
      const r = rows[i];
      if (code && !r.code.startsWith(code)) continue;
      if (from && r.draw_date < from) continue;
      if (to && r.draw_date > to) continue;
      if (reds.size && ![...reds].every((x) => r.reds.includes(x))) continue;
      if (blue.length && !blue.includes(r.blue)) continue;
      out.push(r);
    }
    const total = out.length, pages = Math.max(1, Math.ceil(total / size));
    page = Math.min(page, pages);
    return { total, page, pages, size, items: out.slice((page - 1) * size, page * size) };
  }
  /** 等价于 server.omission_stats。 */
  function omissionStats(seqHit, nWindow) {
    const nums = seqHit.length ? seqHit[0].length : 0, total = seqHit.length;
    const win = nWindow ? seqHit.slice(-nWindow) : seqHit;
    const counts = new Array(nums).fill(0), current = new Array(nums).fill(0), maxgap = new Array(nums).fill(0);
    for (let i = 0; i < nums; i++) {
      let g = 0;
      for (let k = seqHit.length - 1; k >= 0; k--) { if (seqHit[k][i]) break; g++; }
      current[i] = g;
      let run = 0, best = 0, c = 0;
      for (const row of win) { if (row[i]) { c++; run = 0; } else { run++; if (run > best) best = run; } }
      counts[i] = c; maxgap[i] = best;
    }
    return { count: counts, current, max: maxgap, periods: win.length, total };
  }
  function drawStats(rows, n) {
    n = n || "50";
    const nWindow = n === "all" ? 0 : Math.max(1, toInt(n, "期数"));
    const redHits = rows.map((r) => Array.from({ length: 33 }, (_, k) => r.reds.includes(k + 1)));
    const blueHits = rows.map((r) => Array.from({ length: 16 }, (_, k) => r.blue === k + 1));
    const w = nWindow ? rows.slice(-nWindow) : rows;
    return { n, range: w.length ? [w[0].code, w[w.length - 1].code] : null,
      red: omissionStats(redHits, nWindow), blue: omissionStats(blueHits, nWindow) };
  }

  /** 过滤 / 机选引擎：Worker 里用；Worker 不可用时页面主线程直接用同一份代码。
      init / filter / pick 的返回结构与 web/ 的 /api/filter、/api/pick 一致。 */
  function createEngine() {
    let T = null, ctx = null;
    const now = () => (root.performance ? root.performance.now() : Date.now());
    function run(rawRules, collect) {
      const t0 = now();
      const rules = parseRules(rawRules);
      const res = applyRules(T, rules, ctx, { collect });
      return { res, blues: allowedBlues(rules), ms: Math.round((now() - t0) * 10) / 10 };
    }
    const ready = () => { if (!T) throw new Error("组合表尚未就绪"); };
    return {
      init({ latest, history }) {
        const t0 = now();
        if (!T) T = buildComboTable();
        ctx = makeContext(T, latest, history);
        return { build_ms: Math.round(now() - t0), history_distinct: ctx.histCount };
      },
      filter({ rules }) {
        ready();
        const { res, blues, ms } = run(rules, false);
        return { red_count: res.count, red_total: RED_COMBOS, blue_count: blues.length, blues,
          bets: res.count * blues.length, bets_total: RED_COMBOS * 16,
          detail: res.detail.map(([name, count]) => ({ name, count })), ms };
      },
      pick({ rules, n }) {
        ready();
        n = Number(n) || 5;
        if (!(n >= 1 && n <= 100) || !Number.isInteger(n)) throw new RuleError("注数需 1–100");
        const { res, blues } = run(rules, true);
        return { picks: randomPicks(T, res.indices, blues, n), red_count: res.count, blue_count: blues.length };
      },
    };
  }

  const SSQ = { RED_MAX, BLUE_MAX, RED_COMBOS, PRICE_PER_BET, FIXED_PRIZE, TIER_NAMES, PLAYS, RuleError,
    comb, popcount32, buildComboTable, comboRank, parseRules, allowedBlues, applyRules, makeContext, randomPicks,
    normalizeTicket, betCount, tierOf, checkTicket, listPicks, parseDraws, parseNums, queryDraws, omissionStats, drawStats, createEngine };
  root.SSQ = SSQ;
  if (typeof module === "object" && module.exports) module.exports = SSQ;
})(typeof self !== "undefined" ? self : globalThis);
