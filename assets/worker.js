/* 组合表 Worker：在后台线程构建 110 万红球组合特征表，执行规则过滤与机选，避免卡住页面。
   协议：{id, type: init|filter|pick, payload} → {id, ok, result | error}。 */
"use strict";
importScripts("core.js");
const engine = SSQ.createEngine();
self.onmessage = (e) => {
  const { id, type, payload } = e.data || {};
  try {
    if (!["init", "filter", "pick"].includes(type)) throw new Error("未知请求：" + type);
    self.postMessage({ id, ok: true, result: engine[type](payload || {}) });
  } catch (err) {
    self.postMessage({ id, ok: false, error: err && err.message ? err.message : String(err) });
  }
};
