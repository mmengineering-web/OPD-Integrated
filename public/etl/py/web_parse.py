"""web_parse.py - entry points of the Upload page (One Portal Data). Runs in the browser through Pyodide, inside a web worker.

  peek(kind, pdf_path)                                  -> JSON {report_date}                  (cheap, to choose the history window)
  parse(kind, pdf_path, cfg_json, schema_json, history_json)
                                                        -> JSON {report_date, site, actual[], raw{}, log[], summary{}}

kind is "wkm" or "bm". history_json is {table: [row, ...]} read from etl_history_read. Nothing leaves the browser from here.
Every row of `actual` is {date, site, pit, contractor, shift, category, metric_group, metric, value, text_value} (the fact table shape)."""
from __future__ import annotations

import datetime as dt
import json
import warnings
from collections import Counter

warnings.filterwarnings("ignore")


def _g15(rows):
    """The desktop ETL stores 15 significant digits; the browser's floats have 16-17 (183568.54 vs 183568.54000000004). Same digits here."""
    for r in rows:
        v = r.get("value")
        if isinstance(v, float) and v == v:
            r["value"] = float("%.15g" % v)
    return rows


def _json_default(o):
    if isinstance(o, (dt.datetime, dt.date)):
        return o.isoformat()
    if hasattr(o, "item"):
        return o.item()
    return str(o)


def _report_date(kind, pdf_path):
    if kind == "bm":
        import bm_to_master as B
        return B.report_date(pdf_path)["report_date"]
    import pdfplumber
    from dr_pdf_parser import Layout, parse_header
    with pdfplumber.open(pdf_path) as p:
        return parse_header(Layout(p.pages[0]))["report_date"]


def _tms_identify(path, name, cfg_json):
    """TMS files are Excel / Word, not PDF. Returns {kind, report_date, note}. Taken today: the Daily Production Report ("dpr"), the Realisasi Barging ("barge") the stock dome register ("stock") and the inspection report ("hazard")."""
    import tms_adapter as T
    cfg = json.loads(cfg_json)
    is_barge = False
    if not str(name or "").lower().endswith(".docx"):      # a Word inspection report is not a workbook
        import openpyxl
        import tms_barge
        wb = openpyxl.load_workbook(path, data_only=True, read_only=True)
        try:
            is_barge = tms_barge.is_barging(wb)
        finally:
            wb.close()
    if is_barge:       # a problem inside the file (a copied trip block...) is a log entry on the page, not a refusal: the reader skips that block
        b = tms_barge.parse(path, cfg=cfg)
        if b.report_date is None:
            raise ValueError("; ".join(m for s, c, m in b.issues if s == "ERROR") or "no report date found in the barging file")
        return {"kind": "barge", "report_date": b.report_date.isoformat(), "note": None}
    info = T.identify(path, name or path, cfg)
    if info.get("error"):
        raise ValueError(info["error"])
    if info.get("kind") not in ("dpr", "stock", "hazard"):
        raise ValueError("Not a TMS report")
    return info


def peek(kind, pdf_path, cfg_json=None, name=""):
    if kind == "tms":
        info = _tms_identify(pdf_path, name, cfg_json)
        return json.dumps({"report_date": info["report_date"], "note": info.get("note")})
    d = _report_date(kind, pdf_path)
    return json.dumps({"report_date": d.isoformat()})


# ---------------------------------------------------------------------------- stock register: same workflow as the barge list
_STOCK_ID = ("DATE", "SITE", "CONTRACTOR", "SHIFT", "INPUT DATE")


def _d10(v):
    return None if v is None else str(v)[:10]


def _stock_eq(col, a, b):
    """History and file agree on one stock column. Tonnage columns are stored to 2 decimals, grades to 3."""
    if a is None and b is None:
        return True
    if a is None or b is None:
        return (b if a is None else a) in (0, 0.0)
    try:
        return abs(float(a) - float(b)) <= (0.006 if col.endswith("TONAGE") else 0.0006)
    except (TypeError, ValueError):
        return a == b


def _stock_total(row):
    return round(sum(v for k, v in row.items() if k.endswith("-TONAGE") and not k.endswith("-WS-TONAGE") and isinstance(v, (int, float))), 2)


def _stock(history, res, d):
    """The stock register against what the database holds, per contractor and date:
         new      no row for that contractor and date  -> insert
         changed  a row exists and differs              -> update (the columns that differ are listed)
         same     identical                             -> nothing to do
       The last stock date in the database is reported per contractor. A date whose rows are all identical is dropped from the upload.
       A date with any new or changed row keeps ALL its rows (a load replaces a whole day of a table), including the rows of
       contractors that are not in the file, copied unchanged from the database."""
    T = "tblRAWSTOCK"
    staged = res["rows"].get(T) or []
    if not staged:
        return None
    hist = history.get(T) or []
    by_h, last = {}, {}
    for r in hist:
        dd, c = _d10(r.get("DATE")), r.get("CONTRACTOR")
        if dd is None:
            continue
        by_h[(dd, c)] = r
        if c not in last or dd > last[c]:
            last[c] = dd
    items = []
    for row in staged:
        dd, c = _d10(row.get("DATE")), row.get("CONTRACTOR")
        old = by_h.get((dd, c))
        item = {"contractor": c, "date": dd, "last_db_date": last.get(c), "status": "new", "changes": [],
                "total": _stock_total(row), "old_total": None, "gap_days": None}
        if old is not None:
            cols = [k for k in row if k not in _STOCK_ID]
            ch = [{"col": k, "old": old.get(k), "new": row.get(k)} for k in cols if not _stock_eq(k, old.get(k), row.get(k))]
            item["status"], item["changes"], item["old_total"] = ("changed" if ch else "same"), ch, _stock_total(old)
        elif last.get(c) and last[c] < dd:
            item["gap_days"] = (dt.date.fromisoformat(dd) - dt.date.fromisoformat(last[c])).days - 1
        items.append(item)
    changed_dates = {i["date"] for i in items if i["status"] != "same"}
    kept, preserved = [], []
    for row in staged:
        if _d10(row.get("DATE")) in changed_dates:
            kept.append(row)
    in_file = {(i["date"], i["contractor"]) for i in items}
    for dd in sorted(changed_dates):
        for (hd, hc), hr in by_h.items():
            if hd == dd and (hd, hc) not in in_file:
                kept.append(dict(hr))
                preserved.append(f"{hc} {dd}")
    if kept:
        res["rows"][T] = kept
    else:
        res["rows"].pop(T, None)
    for i in items:
        i["loaded"] = i["date"] in changed_dates
    # the generic "already in the master" warning is replaced by the status above
    res["log"] = [x for x in res["log"] if x.get("check") != "stock-already-in-master"]
    for i in items:
        sev, who = "INFO", f"{i['contractor']} {i['date']}"
        if i["status"] == "new":
            msg = (f"{who}: new in the database (last stock date there: {i['last_db_date'] or 'none'}"
                   + (f"; {i['gap_days']} day(s) in between have no stock row, a register shows one day only" if i["gap_days"] else "") + ")")
        elif i["status"] == "changed":
            msg = f"{who}: already in the database, {len(i['changes'])} value(s) differ and will be updated"
        else:
            msg = f"{who}: identical to the database, nothing to update"
        if i["last_db_date"] and i["date"] < i["last_db_date"]:
            sev, msg = "WARN", msg + f". This is older than the last stock date in the database ({i['last_db_date']})"
        res["log"].append({"severity": sev, "date": i["date"], "table": T, "check": "stock-status", "message": msg})
    if preserved:
        res["log"].append({"severity": "INFO", "date": d.isoformat(), "table": T, "check": "stock-kept",
                           "message": "Rows of other contractors on the same day are copied unchanged (a load replaces the whole day): " + ", ".join(preserved)})
    if not changed_dates:
        res["log"].append({"severity": "INFO", "date": d.isoformat(), "table": T, "check": "stock-nothing",
                           "message": "Everything in the stock register is already in the database: nothing to load."})
    return items


def _barge(cfg, schema, history, res, d, site, X):
    """The barge list after this report: merged by SI in the history list, calculated columns rebuilt. Returns the changed rows only,
    each {si, hist (history row), fact (fact_barge row), old (history row before or None)}."""
    import opd_barge as B
    staged = res["rows"].get("tblRAWBARGE") or []
    if not staged:
        return []
    w = cfg.get("barge_week")
    rows, changed = B.merge(history.get("tblRAWBARGE") or [], staged, site, d, (w["start"], w["sign"]) if w else None)
    if not changed:
        return []

    class Staged:
        pass
    Staged.tables, Staged.headers, Staged.vocab = (schema.get("tables") or {}), {}, {}
    Staged.data = {"tblRAWBARGE": rows}
    X_tn = Staged.tables.get("tblRAWBARGE")
    out = []
    df, _ = X.build_barge(Staged, site)
    by_si = {B._si(r.get("SI")): i for i, r in enumerate(rows)}
    facts = {}
    for i, rec in enumerate(df.to_dict("records")):
        facts[str(rec.get("si")).strip().upper()] = {k: (None if X._py(v) is None else (v.isoformat()[:10] if hasattr(v, "isoformat") else X._py(v))) for k, v in rec.items()}
    for c in changed:
        out.append({"si": c["si"], "hist": c["new"], "old": c["old"], "fact": facts.get(c["si"])})
    return out


def _ship_list(res):
    return [{"decision": e.get("DECISION"), "kind": e.get("KIND"), "date": e["DATE"], "contractor": e.get("CONTRACTOR"), "old": e.get("OLD DAY"),
             "new": e.get("NEW DAY"), "diff": e.get("DIFF"), "caused_by": e.get("CAUSED BY"), "note": e.get("NOTE")} for e in res.get("ship_updates") or []]


def ship(kind, cfg_json, schema_json, history_json, entries_json, stamp):
    """Apply ship updates. entries: [{date, contractor, new}] the person ticked. history: {tblRAWSHIP: rows} as stored NOW.
    Returns {rows (fact rows of every changed day), raw {tblRAWSHIP: rows}, changes, skipped, days}."""
    import master_export as X
    import opd_ship as S
    cfg, schema, history = json.loads(cfg_json), json.loads(schema_json), json.loads(history_json)
    entries = [{"DATE": e["date"], "CONTRACTOR": e["contractor"], "NEW DAY": e["new"]} for e in json.loads(entries_json)]
    out = S.apply(schema, history, entries, stamp)
    site = cfg["site"]
    rows = []
    if out["rows"]:
        import opd_parse as P

        class Staged:
            pass
        Staged.tables, Staged.headers, Staged.vocab = (schema.get("tables") or {}), {}, {}
        Staged.data = {"tblRAWSHIP": [{k: P._revive(v, k) for k, v in r.items()} for r in out["rows"]]}
        days = sorted({r["DATE"] for r in out["rows"]})
        df, _ = X.build_actual(Staged, site, dt.date.fromisoformat(days[0]), dt.date.fromisoformat(days[-1]))
        df = df[X.OUT_COLS].copy()
        df["date"] = df["date"].astype(str).str.slice(0, 10)
        rows = _g15([dict(zip(X.OUT_COLS, [X._py(v) for v in r])) for r in df.itertuples(index=False, name=None)])
    return json.dumps({"rows": rows, "raw": {"tblRAWSHIP": out["rows"]} if out["rows"] else {}, "changes": out["changes"],
                       "skipped": out["skipped"], "days": sorted({r["DATE"] for r in out["rows"]})}, default=_json_default)


def _plan(schema, history, res, d, site, X):
    """The plan printed in the report versus tblCALENDAR. Returns None when they agree, else
    {changes[], days[], groups[], raw{tblCALENDAR: rows}, rows: plan rows (fact_production_plan shape) for the changed days and groups}."""
    import opd_plan as PL
    cal = history.get("tblCALENDAR") or []
    p = PL.propose(cal, res.get("plan_cal") or [], d)
    if not p["changes"]:
        return None

    class Staged:
        pass
    Staged.tables, Staged.headers, Staged.vocab = (schema.get("tables") or {}), {}, {}
    Staged.data = {"tblCALENDAR": p["rows"]}
    df, _ = X.build_plan(Staged, site)
    df = df[(df["category"] == "PLAN") & (df["metric_group"].isin(p["groups"]))].copy()
    df["date"] = df["date"].astype(str).str.slice(0, 10)
    cols = ["date", "site", "pit", "contractor", "category", "metric_group", "metric", "value", "text_value"]
    rows = _g15([dict(zip(cols, [X._py(v) for v in r])) for r in df[cols].itertuples(index=False, name=None)])
    return {"changes": p["changes"], "days": p["days"], "groups": p["groups"], "raw": {"tblCALENDAR": p["rows"]}, "rows": rows}


def parse(kind, pdf_path, cfg_json, schema_json, history_json, name=""):
    import dr_to_master as D
    import master_export as X
    import opd_parse as P

    cfg, schema, history = json.loads(cfg_json), json.loads(schema_json), json.loads(history_json)
    if kind == "tms":
        info = _tms_identify(pdf_path, name, cfg_json)
        res = P.parse_report(kind, [{"path": pdf_path, "name": name or pdf_path, "kind": info["kind"], "report_date": info["report_date"]}], cfg, schema, history)
    else:
        res = P.parse_report(kind, pdf_path, cfg, schema, history)
    d = dt.date.fromisoformat(res["report_date"])
    site = cfg["site"]
    stock = _stock(history, res, d) if kind == "tms" else None

    # the long (EAV) rows the fact table holds: the same function the Excel master export uses
    base = P.HistoryMaster(schema, history)
    data = {tn: list(rows) for tn, rows in base.data.items()}
    for tn, rows in res["rows"].items():
        if tn == "tblRAWBARGE":
            continue
        data[tn] = [r for r in data.get(tn, []) if D.as_date(r.get("DATE")) != d] + [{k: P._revive(v, k) for k, v in r.items()} for r in rows]

    class Staged:
        pass
    Staged.tables, Staged.headers, Staged.vocab, Staged.data = base.tables, {}, base.vocab, data
    df, rep = X.build_actual(Staged, site, d, d)
    df = df[X.OUT_COLS].copy()
    df["date"] = df["date"].astype(str).str.slice(0, 10)
    actual = _g15([dict(zip(X.OUT_COLS, [X._py(v) for v in row])) for row in df.itertuples(index=False, name=None)])
    for r in actual:      # a hazard finding whose HAZARD CATEGORY is not in the report (site fills it by hand later): the fact table needs a group, "-" is the master's own blank
        if r["category"] == "HAZARD" and not r.get("metric_group"):
            r["metric_group"] = "-"
    blank = [r["metric"] for r in actual if r["category"] == "CONS" and not r.get("metric_group")]
    for r in actual:      # a construction item that is not in the history yet has no CONSTRUCTION CATEGORY: the fact table needs a group, "-" is the master's own blank (set the category in the master later)
        if r["category"] == "CONS" and not r.get("metric_group"):
            r["metric_group"] = "-"
    choices = sorted({str(x.get("CONSCATEGORY")).strip() for x in history.get("tblRAWCONS", []) if x.get("CONSCATEGORY")}
                     | {str(x.get("CONSTRUCTION CATEGORY")).strip() for x in history.get("tblCONSCATEGORY", []) if x.get("CONSTRUCTION CATEGORY")}
                     | {r["metric_group"] for r in actual if r["category"] == "CONS" and r["metric_group"] != "-"})
    cons_choices = choices or ["Bridge", "Building", "Infrastructure", "Jetty", "Road", "Other"]
    cons_new = list(dict.fromkeys(blank))
    if blank:
        res["log"].append({"severity": "WARN", "date": d.isoformat(), "table": "tblRAWCONS", "check": "cons-category-blank",
                           "message": f"{len(blank)} new construction item(s) have no category yet and are loaded with '-': " + ", ".join(blank[:6])})
    only = {tn for tn, rows in res["rows"].items() if rows and tn != "tblRAWBARGE"}
    if kind == "tms" and only <= {"tblRAWSTOCK", "tblRAWHAZARD"}:     # a stock-only or hazard-only file: do not re-stage the other categories of that day from the history
        actual = [r for r in actual if r["category"] in {"STOCK" if t == "tblRAWSTOCK" else "HAZARD" for t in only}]
    skip = set(cfg.get("fact_skip_metrics") or [])      # TMS: helper columns the site's fact table never held
    if skip:
        actual = [r for r in actual if r["metric"] not in skip]

    raw = {tn: rows for tn, rows in res["rows"].items() if tn != "tblRAWBARGE" and rows}
    barge = _barge(cfg, schema, history, res, d, site, X)
    plan = None if kind == "tms" else _plan(schema, history, res, d, site, X)     # TMS plan: compared in the log only (step 4.4 later)
    if res.get("hazard_updates"):      # closures of findings loaded earlier change old rows: not done by the browser yet (4.4b later)
        res["log"].append({"severity": "WARN", "date": d.isoformat(), "table": "tblRAWHAZARD", "check": "hazard-updates-not-applied",
                           "message": f"{len(res['hazard_updates'])} earlier finding(s) are closed or tagged by this report; the browser does not change earlier rows yet. They are NOT applied: "
                                      + ", ".join(str(u.get("ID")) for u in res["hazard_updates"][:8])})
    counts = Counter(r["category"] for r in actual)
    return json.dumps({
        "report_date": d.isoformat(), "site": site, "actual": actual, "raw": raw, "cons_new": cons_new, "cons_choices": cons_choices,
        "barge": barge, "stock": stock, "plan": plan, "ship_updates": _ship_list(res), "log": res["log"], "summary": {"rows": len(actual), "by_category": dict(counts), "raw_rows": {k: len(v) for k, v in raw.items()},
                                       "build_notes": rep.get("notes", [])},
    }, default=_json_default)
