# 双色球选号 · SSQ Lab（静态版）

一个纯静态的双色球小工具：开奖历史查询、冷热号与遗漏统计、规则过滤（剩余注数）、机选、买号记录与自动对奖。
没有后端，所有计算都在浏览器里完成，手机竖屏优先，桌面也能用。

**网址：<https://wygao29.github.io/ssq/>**

> 每期开奖独立随机，统计与过滤不提高中奖概率。本工具只用于查询、记录与娱乐，不提供购彩服务。

## 功能

| 页面 | 说明 |
| --- | --- |
| 历史查询 | 按期号前缀、日期范围、包含的红球、蓝球筛选，分页浏览；顶部是最新一期 |
| 冷热与遗漏 | 最近 30 / 50 / 100 期或全部：红蓝球出现次数、当前遗漏、范围内最大遗漏 |
| 规则过滤 | 奇偶比、大小比、和值、跨度、AC 值、连号、与上期重号、胆红 / 杀红、杀蓝、排除历史组合，实时算出 1,107,568 个红球组合里还剩多少注 |
| 机选 | 在当前规则下等概率随机抽 1–100 注（`crypto.getRandomValues`），可一键存入买号记录 |
| 买号与对奖 | 录入单式 / 复式 / 胆拖和倍数，按目标期号自动对奖，汇总投入与回报；记录可导出 / 导入 JSON |

每条过滤规则、冷热号、遗漏、奖级、复式 / 胆拖注数旁边都有「说明」按钮，点开是白话解释：是什么、一个具体例子、历史上最常见的取值。例子用最新一期，历史占比由 `data/draws.json` 在浏览器里现算，更新数据后自动跟着变。

## 数据与隐私

- 开奖数据在 `data/draws.json`，由仓库里的 `export_json.py` 从本地 `ssq.sqlite` 导出（期号、日期、星期、红蓝球、销售额、奖池、一到六等奖注数与单注奖金）。
- 网页**不会自动同步**开奖数据，页面右上角显示「数据更新到第 X 期」，需要按下面的步骤手动更新后推送。
- 买号记录只存在当前浏览器的 localStorage（键名 `ssq-picks`），不会上传到任何地方。换手机、换浏览器或清除网站数据前，请在「买号与对奖」里点「导出」保存 JSON，之后可以「导入」（合并或替换）。

## 更新开奖数据

```bash
cd ~/Documents/双色球
python3 fetch_ssq.py                 # 从中国福利彩票官网拉取开奖公告，写入 ssq.sqlite

cd ssq-pages
python3 export_json.py               # 只读 ssq.sqlite，生成 data/draws.json（数据没变化时不改写）
# 数据库不在默认位置时：python3 export_json.py --db /path/to/ssq.sqlite

git add data/draws.json
git commit -m "数据更新到第 XXXXXXX 期"
git push                             # GitHub Pages 一两分钟后生效
```

## 本地预览

页面用 `fetch` 读 JSON、用 Web Worker 计算，直接双击 `index.html`（file://）打不开数据，需要起一个本地服务：

```bash
cd ~/Documents/双色球/ssq-pages
python3 -m http.server 8000 --bind 127.0.0.1
# 打开 http://127.0.0.1:8000/
```

所有资源都用相对路径，放在 `/ssq/` 子路径下也能正常工作。

## 目录结构

```
index.html          页面结构
assets/app.css      样式（亮 / 暗主题、手机底部标签栏、桌面侧栏）
assets/app.js       界面逻辑
assets/core.js      核心计算：规则过滤、对奖、统计、查询（纯函数）
assets/help.js      各页「说明」的白话解释（例子和历史常见取值由 draws.json 现算）
assets/worker.js    Web Worker：后台生成 110 万组合特征表、过滤与机选
assets/boot.js      首帧前设置主题，避免闪烁
assets/fonts/       Inter、Space Grotesk 字体（仓库内自带）
data/draws.json     开奖数据
export_json.py      ssq.sqlite → data/draws.json
```

## 说明

- 「预计下一期」按最新期号 + 1 推算，跨年时（新年第一期是 XXXX001）会不准，不影响对奖：对奖按你填的目标期号匹配开奖数据。
- 一二等奖为浮动奖金，按该期公告的单注奖金计算；个别早期开奖缺少奖金数据时，奖金显示为「+」表示另有未知金额。三到六等奖固定 3000 / 200 / 10 / 5 元。
- 主题可在亮色、暗色、跟随系统之间切换（手机点右上角图标，桌面在左下角）。
