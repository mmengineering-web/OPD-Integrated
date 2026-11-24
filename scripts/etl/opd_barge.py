"""opd_barge.py - the barge list without Excel (One Portal Data, step 4.3).

recompute(rows, site, week_start, week_sign) rebuilds the calculated columns of tblRAWBARGE exactly like the master's formulas:
  MONTH = month name of FINISHDATE            YEAR = year of FINISHDATE            WEEK = "W" + number (week start from the master's setting)
  WTD / MTD / YTD = running ACTUAL CAPACITY per site + contractor and week / month / year, in order of FINISHDATE (same day: row order)
  a row without FINISHDATE: WTD = MTD = YTD = ACTUAL CAPACITY, YEAR and WEEK blank
rows are in master row order (history order); the new SIs go to the end.  Nothing here touches a database."""
from __future__ import annotations

import datetime as dt
import re

ISO = re.compile(r"^\d{4}-\d{2}-\d{2}")
MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"]
DERIVED = ("MONTH", "YEAR", "WEEK", "SITE", "WTD", "MTD", "YTD")


def day(v):
    if v in (None, ""):
        return None
    if isinstance(v, dt.datetime):
        return v.date()
    if isinstance(v, dt.date):
        return v
    if isinstance(v, str) and ISO.match(v):
        return dt.date.fromisoformat(v[:10])
    if isinstance(v, (int, float)) and not isinstance(v, bool) and 20000 < v < 80000:      # a date the master holds as an Excel serial number
        return dt.date(1899, 12, 30) + dt.timedelta(days=int(v))
    return None


def num(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return 0.0


def week_label(d, start_idx, sign):
    """start_idx 1..7 = Monday..Sunday (the master's week-start setting); sign +1 (WKM master) or -1 (BM master)."""
    jan1 = dt.date(d.year, 1, 1)
    off = (jan1.isoweekday() - start_idx) % 7
    return "W%02d" % (int(((d - jan1).days + sign * off) / 7) + 1)      # INT of a positive number: floor


def recompute(rows, site, week_start, week_sign):
    out = [dict(r) for r in rows]
    for r in out:
        r["SITE"] = site
        d = day(r.get("FINISHDATE"))
        r["MONTH"] = MONTHS[d.month - 1] if d else "January"          # TEXT(blank,"mmmm") = January in the master
        r["YEAR"] = d.year if d else None
        r["WEEK"] = week_label(d, week_start, week_sign) if d else None
    order = sorted((i for i, r in enumerate(out) if day(r.get("FINISHDATE"))), key=lambda i: (day(out[i]["FINISHDATE"]), i))
    for i, r in enumerate(out):
        if not day(r.get("FINISHDATE")):
            r["WTD"] = r["MTD"] = r["YTD"] = num(r.get("ACTUAL CAPACITY"))
    for col, key in (("WTD", "WEEK"), ("MTD", "MONTH"), ("YTD", "YEAR")):
        best = {}            # (contractor, period) -> {date: value of the last row of that date}
        for i in order:
            r = out[i]; d = day(r["FINISHDATE"]); k = (r.get("CONTRACTOR"), r[key])
            seen = best.setdefault(k, {})
            prev = max([v for dd, v in seen.items() if dd < d], default=0.0)
            same = sum(num(out[j].get("ACTUAL CAPACITY")) for j in order
                       if j <= i and out[j].get("CONTRACTOR") == r.get("CONTRACTOR") and out[j][key] == r[key] and day(out[j]["FINISHDATE"]) == d)
            r[col] = prev + same
            seen[d] = max(seen.get(d, 0.0), r[col])
    return out


def fit_week(rows):
    """Which (start day, sign) of the week formula reproduces the stored WEEK column best. Returns (start_idx, sign, matches, total)."""
    best = None
    tot = sum(1 for r in rows if day(r.get("FINISHDATE")))
    for sign in (1, -1):
        for st in range(1, 8):
            ok = sum(1 for r in rows if day(r.get("FINISHDATE")) and week_label(day(r["FINISHDATE"]), st, sign) == r.get("WEEK"))
            if best is None or ok > best[2]:
                best = (st, sign, ok, tot)
    return best


# ---------------------------------------------------------------------------------------------------------------------
# merge: history list + the rows the report staged  ->  full list with calculated columns, and the rows that changed
# ---------------------------------------------------------------------------------------------------------------------
def _si(v):
    if v in (None, ""):
        return None
    if isinstance(v, float) and v == int(v):
        v = int(v)
    return str(v).strip().upper()


def _jv(v):
    if isinstance(v, dt.datetime):
        return v.date().isoformat()
    if isinstance(v, dt.date):
        return v.isoformat()
    return v


def _same(a, b):
    a, b = _jv(a), _jv(b)
    if a in (None, "") and b in (None, ""):
        return True
    try:
        return abs(float(a) - float(b)) < 1e-6
    except (TypeError, ValueError):
        da, db = day(a), day(b)
        if da and db:
            return da == db
        return str(a).strip() == str(b).strip()


def merge(history_rows, staged_rows, site, report_date, week=None):
    """history_rows: the list as stored (history order). staged_rows: input columns of the SIs the report adds or updates.
    Returns (rows, changed): rows = whole list, calculated columns rebuilt; changed = [{si, new, old}] (old None for a new SI).
    INPUT DATE of an added or updated SI is the report date. week = (start_idx, sign), or None to fit it to the stored WEEK column."""
    hist = [dict(r) for r in history_rows]
    if week is None:
        w = fit_week(hist)
        week = (w[0], w[1]) if w[3] and w[2] >= 0.9 * w[3] else (1, -1)
    key = {}
    for i, r in enumerate(hist):
        k = _si(r.get("SI"))
        if k is not None:
            key[k] = i
    rows = [dict(r) for r in hist]
    touched = []
    for s in staged_rows:
        k = _si(s.get("SI"))
        if k is None:
            continue
        if k in key:
            i = key[k]
            for c, v in s.items():
                if c not in DERIVED and c != "SI":
                    rows[i][c] = _jv(v)
        else:
            rows.append({c: _jv(v) for c, v in s.items() if c not in DERIVED})
            key[k] = len(rows) - 1
        i = key[k]
        rows[i]["INPUT DATE"] = report_date.isoformat() if isinstance(report_date, (dt.date, dt.datetime)) else report_date
        if k not in touched:
            touched.append(k)
    rows = recompute(rows, site, *week)
    changed = []
    for k, i in key.items():
        old = hist[i] if i < len(hist) else None
        new = {c: _jv(v) for c, v in rows[i].items()}
        if old is None or k in touched or any(not _same(old.get(c), new.get(c)) for c in set(old) | set(new)):
            if old is not None and k not in touched and all(_same(old.get(c), new.get(c)) for c in set(old) | set(new)):
                continue
            changed.append({"si": k, "new": new, "old": old})
    return [{c: _jv(v) for c, v in r.items()} for r in rows], changed
