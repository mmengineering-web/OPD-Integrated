"""opd_plan.py - replace the plan in tblCALENDAR with the plan printed in the report (One Portal Data, step 4.3b). No Excel, no database.

The calendar holds one row per contractor and day for the whole year. Its plan columns (S/OB/L/M/H/Q/ST x DAY/WTD/MTD/YTD) are constant between
revisions. The report prints the approved plan of its own day; that value holds from the report date until the next change appears:
  for each (contractor, column) where the report differs from the calendar on the report date, the run of equal calendar values that
  contains the report date is rewritten from the report date to the end of the run (MTD columns: not beyond the end of the month).
  ST-WTD also rewrites ST-DAY = ST-WTD / 7 on the same days (that is how the master computes it).
Dates before the report date are never touched. The report prints whole numbers, so the new values are whole numbers."""
from __future__ import annotations

import datetime as dt
import re

ISO = re.compile(r"^\d{4}-\d{2}-\d{2}")
GROUPS = ("S", "OB", "L", "M", "H", "Q", "ST")


def _day(v):
    if isinstance(v, dt.datetime):
        return v.date()
    if isinstance(v, dt.date):
        return v
    if isinstance(v, str) and ISO.match(v):
        return dt.date.fromisoformat(v[:10])
    return None


def _eq(a, b):
    if a is None or b is None:
        return a is None and b is None
    try:
        return abs(float(a) - float(b)) < 1e-6
    except (TypeError, ValueError):
        return a == b


def propose(calendar_rows, plan_cal, report_date):
    """calendar_rows: history tblCALENDAR rows (ISO dates). plan_cal: run.plan_cal entries {contractor, column, pdf, calendar}.
    Returns {"changes": [...], "rows": [...]}  rows = every calendar row (all contractors) of each day that changed, new values included."""
    by_con = {}
    for r in calendar_rows:
        d = _day(r.get("DATE"))
        if d:
            by_con.setdefault(str(r.get("CONTRACTOR") or "").strip().upper(), []).append((d, r))
    for v in by_con.values():
        v.sort(key=lambda x: x[0])
    new = {}                     # (contractor, date) -> row copy
    changes = []
    for e in plan_cal:
        if e.get("pdf") is None:
            continue
        con = str(e["contractor"]).strip().upper()
        col, val = e["column"], float(e["pdf"])
        seq = by_con.get(con) or []
        i = next((k for k, (d, _) in enumerate(seq) if d == report_date), None)
        if i is None:
            continue
        old = seq[i][1].get(col)
        j = i
        month_end = None
        while j < len(seq) and _eq(seq[j][1].get(col), old):
            if col.endswith("-MTD") and seq[j][0].month != report_date.month:
                break
            j += 1
        span = [seq[k] for k in range(i, j)]
        for d, r in span:
            row = new.setdefault((con, d), dict(r))
            row[col] = val
            if col == "ST-WTD":
                row["ST-DAY"] = val / 7
        changes.append({"contractor": e["contractor"], "column": col, "old": old, "new": val,
                        "from": span[0][0].isoformat(), "to": span[-1][0].isoformat(), "days": len(span)})
    days = sorted({d for (_, d) in new})
    rows = []
    for d in days:
        for con, seq in by_con.items():
            for dd, r in seq:
                if dd == d:
                    rows.append(new.get((con, d)) or dict(r))
    return {"changes": changes, "rows": rows, "groups": sorted({c["column"].split("-")[0] for c in changes}),
            "days": [d.isoformat() for d in days]}
