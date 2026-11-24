r"""opd_formulas.py  (OPD Phase 4)

Replaces the Excel formula columns of the site master (tblRAW* tables) so a report can be loaded without Excel.
Pure Python, no Excel, no pandas.  Runs in the browser (Pyodide) and on a PC.

Public API
    complete_day(tn, hist, day_rows, cal, extra=None) -> list of rows
        tn        table name, e.g. "tblRAWMNG"
        hist      every row of that table whose DATE is before the day (stored values, as in the master)
        day_rows  the rows of ONE date, input columns filled (formula columns missing or ignored), in table order
        cal       {(CONTRACTOR, date): {"YEAR":..,"MONTH":..,"WEEK":..}} from tblCALENDAR
        extra     {"tblRAWMNG": rows of this date, completed}  (needed by FUEL FR)
    Returns copies of the day rows with every formula column filled. Rows are plain dicts keyed by master column name.

Every rule below is a line-by-line translation of the Excel table formulas of Master Data Site WKM (checked by
tools/validate_formulas.py against every row of the master's saved values).
"""
from __future__ import annotations

import datetime as dt

MEAS_MNG = ["S", "OB", "L", "M", "H", "Q"]
MEAS_HSE = [("NM", "NM"), ("MTI", "MTI"), ("LTI", "LTI"), ("FAI", "FAI"), ("PD", "PD"), ("FC", "FC"), ("EC", "EC"), ("FT", "FATALITY")]
EQ_BASES = ["EXC1", "EXC2", "EXC3", "DT", "DOZER", "BREAKER", "GRADER", "COMPAC", "FT", "WT", "LV", "LT", "ADT"]
LAB_ZONES = ["FP", "QC", "SS", "SC", "FO", "DOME", "BARGE", "EXPLO"]
LAB_P = ["OVEN", "JAW CRUSH", "D.ROLL", "COMP", "PRESS", "PULV", "XRF"]
MP_ROLES = ["MANAGER", "SPT", "SPV", "DRIVER", "OPERATOR", "ETC"]


def day_of(v):
    if isinstance(v, dt.datetime):
        if (v.hour, v.minute, v.second) == (0, 0, 0):
            return v.date()
        return (v + dt.timedelta(hours=12)).date()
    if isinstance(v, dt.date):
        return v
    if isinstance(v, str) and len(v) >= 10:
        try:
            return dt.date.fromisoformat(v[:10])
        except ValueError:
            return None
    return None


def n(v):
    """Excel N(): numbers as they are, everything else (blank, '-', text) is 0."""
    if isinstance(v, bool):
        return 0.0
    if isinstance(v, (int, float)):
        return float(v)
    return 0.0


def _prev_max(rows, col, match, period_col, period_val, d):
    """IFERROR(MAXIFS(col, match..., period_col, period_val, DATE < d), 0)"""
    best = None
    for r in rows:
        rd = r["_d"]
        if rd is None or rd >= d or r.get(period_col) != period_val:
            continue
        if any(r.get(k) != v for k, v in match.items()):
            continue
        x = n(r.get(col))
        if best is None or x > best:
            best = x
    return best if best is not None else 0.0


def _calendar(rows, cal):
    for r in rows:
        c = cal.get((r.get("CONTRACTOR"), r["_d"]))
        if c:
            r["YEAR"], r["MONTH"], r["WEEK"] = c.get("YEAR"), c.get("MONTH"), c.get("WEEK")
        else:
            r["YEAR"], r["MONTH"], r["WEEK"] = "", "", ""


def _calendar_plain(rows, week_start="Saturday"):   # master setting CONTRACTOR CONTROL!AB18; WKM = Saturday
    for r in rows:
        d = r["_d"]
        r["YEAR"] = d.year if d else ""
        r["MONTH"] = d.strftime("%B") if d else ""
        if d:
            names = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]
            jan1 = dt.date(d.year, 1, 1)
            off = (jan1.isoweekday() - 1 - names.index(week_start)) % 7
            r["WEEK"] = "W" + format(int(((d - jan1).days + off) / 7) + 1, "02d")
        else:
            r["WEEK"] = ""


PERIODS = [("WTD", "WEEK"), ("MTD", "MONTH"), ("YTD", "YEAR")]


def _running(day, hist, meas_cols, keys):
    """X-WTD / X-MTD / X-YTD = previous period value (stored) + sum of the DAY column over the same-day rows up to this row."""
    for i, r in enumerate(day):
        for dcol, prefix in meas_cols:
            for suf, pcol in PERIODS:
                col = f"{prefix}-{suf}" if prefix else suf
                match = {k: r.get(k) for k in keys}
                prev = _prev_max(hist, col, match, pcol, r.get(pcol), r["_d"])
                same = 0.0
                for j in range(i + 1):
                    q = day[j]
                    if all(q.get(k) == r.get(k) for k in keys) and q.get(pcol) == r.get(pcol):
                        same += n(q.get(dcol))
                r[col] = prev + same


def _first_flags(day, hist_all_rows_max_rowid=None):
    """ROWID = ROW(); first row per (SITE, CONTRACTOR, DATE) and first row per DATE."""
    first_ctr, first_day, seen_ctr = {}, None, set()
    for i, r in enumerate(day):
        k = (r.get("SITE"), r.get("CONTRACTOR"))
        if k not in seen_ctr:
            seen_ctr.add(k)
            first_ctr[i] = True
        if first_day is None:
            first_day = i
    return first_ctr, first_day


def _totals(day, hist, prefix_dcols, keys_ctr=("SITE", "CONTRACTOR")):
    """X-DTOT / WTOT / MTOT / YTOT on the first row of a contractor-day, X-DALL.. on the first row of the day."""
    first_ctr, first_day = _first_flags(day)
    for prefix, dcol in prefix_dcols:
        # DTOT
        for i, r in enumerate(day):
            if first_ctr.get(i):
                r[f"{prefix}-DTOT"] = sum(n(q.get(dcol)) for q in day if (q.get("SITE"), q.get("CONTRACTOR")) == (r.get("SITE"), r.get("CONTRACTOR")))
            else:
                r[f"{prefix}-DTOT"] = 0
        for tot, pcol in (("WTOT", "WEEK"), ("MTOT", "MONTH"), ("YTOT", "YEAR")):
            for i, r in enumerate(day):
                if not first_ctr.get(i):
                    r[f"{prefix}-{tot}"] = 0
                    continue
                site, ctr = r.get("SITE"), r.get("CONTRACTOR")
                prev_dt = None
                for q in hist:
                    if q["_d"] is None or q["_d"] >= r["_d"]:
                        continue
                    if q.get("SITE") == site and q.get("CONTRACTOR") == ctr and q.get(pcol) == r.get(pcol):
                        if prev_dt is None or q["_d"] > prev_dt:
                            prev_dt = q["_d"]
                prev_tot = 0.0
                if prev_dt is not None:
                    for q in hist:    # XLOOKUP: first matching row
                        if q["_d"] == prev_dt and q.get("SITE") == site and q.get("CONTRACTOR") == ctr and q.get(pcol) == r.get(pcol):
                            prev_tot = n(q.get(f"{prefix}-{tot}"))
                            break
                r[f"{prefix}-{tot}"] = prev_tot + n(r.get(f"{prefix}-DTOT"))
        for stem in ("D", "W", "M", "Y"):
            for i, r in enumerate(day):
                r[f"{prefix}-{stem}ALL"] = sum(n(q.get(f"{prefix}-{stem}TOT")) for q in day) if i == first_day else 0


def complete_day(tn, hist, day_rows, cal, extra=None):
    hist = [dict(r) for r in hist]
    for r in hist:
        r["_d"] = day_of(r.get("DATE"))
    day = [dict(r) for r in day_rows]
    for r in day:
        r["_d"] = day_of(r.get("DATE"))
    if not day:
        return []
    plain = tn in ("tblRAWHAZARD", "tblRAWCONS", "tblRAWEXPLO", "tblRAWGEOMAP", "tblRAWLAB")
    if plain:
        _calendar_plain(day)
    else:
        _calendar(day, cal)
    if tn in ("tblRAWMNG", "tblRAWSHIP"):      # ROWID = ROW(): next free row numbers after the highest stored one
        top = max([n(r.get("ROWID")) for r in hist] + [0.0])
        for i, r in enumerate(day):
            r["ROWID"] = int(top) + i + 1
    if tn == "tblRAWMNG":
        _running(day, hist, [(f"{m}-DAY", m) for m in MEAS_MNG], ("SITE", "PIT", "CONTRACTOR"))
        _totals(day, hist, [(m, f"{m}-DAY") for m in MEAS_MNG])
    elif tn == "tblRAWHSE":
        _running(day, hist, [(src, m) for m, src in MEAS_HSE], ("SITE", "CONTRACTOR"))
    elif tn in ("tblRAWHAUL", "tblRAWSHIP", "tblRAWFUEL"):
        if tn == "tblRAWFUEL":
            _running(day, hist, [("DAY", "")], ("SITE", "CONTRACTOR"))
            for r in day:
                r.pop("YTD", None)
        else:
            _running(day, hist, [("DAY", "")], ("SITE", "CONTRACTOR"))
        if tn == "tblRAWSHIP":
            first_day = 0
            for i, r in enumerate(day):
                for stem, col in (("D", "DAY"), ("W", "WTD"), ("M", "MTD"), ("Y", "YTD")):
                    r[f"{stem}ALL"] = sum(n(q.get(col)) for q in day) if i == first_day else 0
        if tn == "tblRAWFUEL":
            for r in day:
                prev_dt = None
                for q in hist:
                    if q["_d"] is not None and q["_d"] < r["_d"] and q.get("SITE") == r.get("SITE") and q.get("CONTRACTOR") == r.get("CONTRACTOR"):
                        if prev_dt is None or q["_d"] > prev_dt:
                            prev_dt = q["_d"]
                prev = 0.0
                if prev_dt is not None:
                    for q in reversed(hist):     # XLOOKUP search_mode -1: last match
                        if q["_d"] == prev_dt and q.get("SITE") == r.get("SITE") and q.get("CONTRACTOR") == r.get("CONTRACTOR"):
                            prev = n(q.get("STOCK"))
                            break
                add = 0.0 if r.get("STOCK ADD") == "-" else n(r.get("STOCK ADD"))
                r["STOCK"] = prev - n(r.get("DAY")) + add
                if r.get("_STOCK") is not None:      # decided by Gera: the stock stated in the DR wins (STOCK ADD = DR stock - (prev - DAY), signed)
                    r["STOCK"] = r["_STOCK"]
                r.pop("_STOCK", None)
                mng = (extra or {}).get("tblRAWMNG") or []
                tot, found = 0.0, False
                for col in ("H-DTOT", "M-DTOT", "L-DTOT"):
                    for q in mng:
                        if q.get("CONTRACTOR") == r.get("CONTRACTOR") and day_of(q.get("DATE")) == r["_d"]:
                            tot += n(q.get(col))
                            found = True
                            break
                r["FR"] = (n(r.get("DAY")) / tot) if (found and tot) else "-"
    elif tn == "tblRAWSTOCK":
        # BM master: <ETO|EFO>-<H|M|L>-Si/MgO = IFERROR(SiO2/MgO, 0). LB ratios are inputs. Only fill when the report did not state it.
        for r in day:
            for pre in ("ETO", "EFO"):
                for g in ("H", "M", "L"):
                    c = f"{pre}-{g}-Si/MgO"
                    if c not in ((extra or {}).get("_inputs") or ()) and r.get(c) is None and (f"{pre}-{g}-SiO2" in r or f"{pre}-{g}-MgO" in r):
                        try:
                            r[c] = float(r.get(f"{pre}-{g}-SiO2")) / float(r.get(f"{pre}-{g}-MgO"))
                        except (TypeError, ValueError, ZeroDivisionError):
                            r[c] = 0
    elif tn == "tblRAWEQ":
        for r in day:
            for b in EQ_BASES:
                r[f"P-{b}"] = n(r.get(f"OP-{b}")) + n(r.get(f"S-{b}")) + n(r.get(f"B-{b}"))
    elif tn == "tblRAWMP":
        for r in day:
            r["TOTAL"] = sum(n(r.get(c)) for c in MP_ROLES)
    elif tn == "tblRAWLAB":
        for r in day:
            for z in LAB_ZONES:
                for pref, src, per in (("IM", "ID", "MONTH"), ("IY", "ID", None), ("FM", "FD", "MONTH"), ("FY", "FD", None), ("AM", "AD", "MONTH"), ("AY", "AD", None)):
                    col, v = f"{pref}-{z}", n(r.get(f"{src}-{z}"))
                    prev_dt = None
                    def same(q):
                        return (q.get("SITE") == r.get("SITE") and q.get("CONTRACTOR") == r.get("CONTRACTOR") and q.get("YEAR") == r.get("YEAR")
                                and (per is None or q.get("MONTH") == r.get("MONTH")))
                    for q in hist:
                        if q["_d"] is not None and q["_d"] < r["_d"] and same(q):
                            if prev_dt is None or q["_d"] > prev_dt:
                                prev_dt = q["_d"]
                    prev = 0.0
                    if prev_dt is not None:
                        for q in reversed(hist):
                            if q["_d"] == prev_dt and same(q):
                                prev = n(q.get(col))
                                break
                    r[col] = prev + v
            for p in LAB_P:
                r[f"P-{p}"] = n(r.get(f"ACT-{p}")) + n(r.get(f"B-{p}")) + n(r.get(f"R-{p}"))
    for r in day:
        r.pop("_d", None)
    return day
