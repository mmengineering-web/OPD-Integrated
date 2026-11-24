"""opd_ship.py - apply 'Ship updates' without Excel (One Portal Data, step 4.3c).

When a barge list change moves tonnage between days, the SHIP DAY of an earlier day no longer equals the barge list. The report run lists those
days (ship_updates: DECISION, KIND, DATE, CONTRACTOR, OLD DAY, NEW DAY ...). Apply writes NEW DAY into the stored tblRAWSHIP row (DAY and INPUT DATE only,
like the desktop loader) and rebuilds WTD/MTD/YTD/DALL/WALL/MALL/YALL of that day and of every later day that is stored, in date order.
ROWID, DATE, SITE, SHIFT, CONTRACTOR of a stored row never change. Only days whose rebuilt row differs from the stored row are returned."""
from __future__ import annotations

import datetime as dt

import opd_formulas as F

TBL = "tblRAWSHIP"
SAME = 1e-6


def _iso(v):
    d = F.day_of(v)
    return d.isoformat() if d else v


def _differs(a, b):
    for c in set(a) | set(b):
        x, y = a.get(c), b.get(c)
        if x in (None, "") and y in (None, ""):
            continue
        try:
            if abs(float(x) - float(y)) <= SAME:
                continue
        except (TypeError, ValueError):
            if F.day_of(x) is not None and F.day_of(x) == F.day_of(y):
                continue
            if str(x) == str(y):
                continue
        return True
    return False


def apply(schema, history, entries, stamp):
    """history: {tblRAWSHIP: rows}. entries: [{DATE, CONTRACTOR, NEW DAY}] already filtered to the ones to apply.
    The DAY of each entry changes by delta = NEW DAY - stored DAY. The stored WTD / MTD / YTD of that row and of every later row of the same contractor in
    the same week / month / year move by the same delta (the master adds the day to the running value of the earlier days), then the ALL columns of the
    touched days are summed again. Values the master already holds elsewhere are not rebuilt, so an old inconsistency in the master is not 'fixed' by accident.
    Returns {"rows": [every row of each changed day], "changes": [...], "skipped": [...]}."""
    rows = [dict(r) for r in history.get(TBL) or [] if F.day_of(r.get("DATE"))]
    for r in rows:
        r["_d"] = F.day_of(r.get("DATE"))
    changes, skipped, touched = [], [], set()
    for e in entries:
        d, c = F.day_of(e.get("DATE")), e.get("CONTRACTOR")
        hits = [r for r in rows if r["_d"] == d and r.get("CONTRACTOR") == c]
        if len(hits) != 1:
            skipped.append({"DATE": _iso(e.get("DATE")), "CONTRACTOR": c, "reason": "no matching row" if not hits else f"{len(hits)} matching rows"})
            continue
        try:
            nv = float(e["NEW DAY"])
        except (TypeError, ValueError, KeyError):
            skipped.append({"DATE": _iso(e.get("DATE")), "CONTRACTOR": c, "reason": "NEW DAY is not a number"})
            continue
        row = hits[0]
        old = F.n(row.get("DAY"))
        delta = nv - old
        changes.append({"date": d.isoformat(), "contractor": c, "old": row.get("DAY"), "new": nv})
        if abs(delta) <= SAME:
            continue
        row["DAY"], row["INPUT DATE"] = nv, stamp
        pos = rows.index(row)
        for i, q in enumerate(rows):
            if q.get("SITE") != row.get("SITE") or q.get("CONTRACTOR") != c or not (q["_d"] > d or (q["_d"] == d and i >= pos)):
                continue
            for col, per in (("WTD", "WEEK"), ("MTD", "MONTH"), ("YTD", "YEAR")):
                if q.get(per) == row.get(per) and q.get(col) is not None:
                    q[col] = F.n(q.get(col)) + delta
                    touched.add(q["_d"])
        touched.add(d)
    out = []
    for d in sorted(touched):
        day = [r for r in rows if r["_d"] == d]
        for i, r in enumerate(day):
            for stem, col in (("D", "DAY"), ("W", "WTD"), ("M", "MTD"), ("Y", "YTD")):
                r[f"{stem}ALL"] = sum(F.n(q.get(col)) for q in day) if i == 0 else 0
        out.extend({k: (_iso(v) if k in ("DATE", "INPUT DATE") else v) for k, v in r.items() if k != "_d"} for r in day)
    return {"rows": out, "changes": changes, "skipped": skipped}
