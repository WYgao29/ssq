#!/usr/bin/env python3
"""把 ssq.sqlite 的开奖数据导出成静态站用的 data/draws.json（只读数据库，只用标准库）。

用法：
    python3 export_json.py                       # 默认读 ~/Documents/双色球/ssq.sqlite
    python3 export_json.py --db /path/ssq.sqlite --out data/draws.json
"""
from __future__ import annotations

import argparse
import json
import sqlite3
import sys
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
DEFAULT_DB = Path.home() / "Documents" / "双色球" / "ssq.sqlite"
FIELDS = ["code", "date", "week", "reds", "blue", "sales", "pool", "prizes"]


def main() -> int:
    ap = argparse.ArgumentParser(description="导出 data/draws.json")
    ap.add_argument("--db", type=Path, default=DEFAULT_DB, help=f"ssq.sqlite 路径（默认 {DEFAULT_DB}）")
    ap.add_argument("--out", type=Path, default=HERE / "data" / "draws.json", help="输出文件（默认 data/draws.json）")
    args = ap.parse_args()
    if not args.db.exists():
        print(f"找不到数据库：{args.db}", file=sys.stderr)
        return 1
    con = sqlite3.connect(f"file:{args.db}?mode=ro", uri=True)  # 只读
    try:
        prize_cols = ", ".join(f"prize{i}_num, prize{i}_money" for i in range(1, 7))
        rows = con.execute(
            "SELECT code, draw_date, week, red1, red2, red3, red4, red5, red6, blue, sales, poolmoney, "
            f"{prize_cols} FROM draws ORDER BY code").fetchall()
    finally:
        con.close()
    out_rows, problems = [], []
    for r in rows:
        code, date, week, *rest = r
        reds, blue = sorted(rest[:6]), rest[6]
        sales, pool = rest[7], rest[8]
        p = rest[9:]
        prizes = [[p[2 * i], p[2 * i + 1]] for i in range(6)]  # 一到六等：[注数, 单注奖金]，缺失为 null
        if len(set(reds)) != 6 or not all(1 <= x <= 33 for x in reds) or not 1 <= blue <= 16:
            problems.append(code)
        out_rows.append([code, date, week, reds, blue, sales, pool, prizes])
    if problems:
        print(f"号码异常的期：{problems[:10]}", file=sys.stderr)
        return 1
    data = {
        "version": 1,
        "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "source": "中国福利彩票官网开奖公告（经 fetch_ssq.py 抓取）",
        "count": len(out_rows),
        "first": out_rows[0][0] if out_rows else None,
        "latest": out_rows[-1][0] if out_rows else None,
        "fields": FIELDS,
        "prize_fields": ["num", "money"],
        "rows": out_rows,
    }
    try:  # 数据没变就不重写，避免只因 generated_at 变化产生无意义的提交
        old = json.loads(args.out.read_text(encoding="utf-8"))
        if old.get("rows") == out_rows and old.get("fields") == FIELDS:
            print(f"数据无变化：仍为 {len(out_rows)} 期（至 {data['latest']}），未改写 {args.out}")
            return 0
    except (OSError, ValueError):
        pass
    args.out.parent.mkdir(parents=True, exist_ok=True)
    tmp = args.out.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    tmp.replace(args.out)
    print(f"已导出 {len(out_rows)} 期（{data['first']} – {data['latest']}）→ {args.out}（{args.out.stat().st_size / 1024:.0f} KB）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
