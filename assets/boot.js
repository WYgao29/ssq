// 首帧前设置主题，避免白闪。优先级：URL ?theme= > localStorage > 跟随系统
(function () {
  var store = null;
  try { store = window.localStorage; } catch (e) { store = null; }
  var p = new URLSearchParams(location.search).get("theme");
  if (p && ["light", "dark", "system"].indexOf(p) < 0) p = null;
  var saved = null;
  try { saved = store && store.getItem("ssq-theme"); } catch (e) { saved = null; }
  if (saved && ["light", "dark", "system"].indexOf(saved) < 0) saved = null;
  var pref = p || saved || "system";
  try { if (p && store) store.setItem("ssq-theme", p); } catch (e) { /* 忽略 */ }
  var dark = pref === "dark" || (pref === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  document.documentElement.dataset.themePref = pref;
  var m = document.querySelector('meta[name="theme-color"]');
  if (m) m.setAttribute("content", dark ? "#111214" : "#FFFFFF");
})();
