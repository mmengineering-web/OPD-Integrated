r"""opd_parse.py  (OPD Phase 4) - daily report -> completed master rows, with NO Excel.

    parse_report(kind, pdf_path, cfg, schema, history, site_name) -> dict
      kind      "wkm" | "bm"
      cfg       the site's config_<site>.json (dict)
      schema    {"tables": {tblName: {"cols": [...], "input": [...]}}}   (made once by tools/make_schema.py)
      history   {tblName: [row dict, ...]}  rows as stored in etl_history (dates are ISO strings)
    Returns {"report_date", "rows": {tbl: [completed rows]}, "log": [...], "meta": [...]}

It reuses the desktop ETL parsers unchanged (dr_to_master / bm_to_master) by giving them a history-backed object
in place of the Excel master, then fills the formula columns with opd_formulas.
"""
from __future__ import annotations

import datetime as dt
import re

import dr_to_master as D
import opd_formulas as F

ISO = re.compile(r"^\d{4}-\d{2}-\d{2}")


def _revive(v, col):
    if isinstance(v, str) and ISO.match(v) and "DATE" in col.upper():
        try:
            return dt.datetime.fromisoformat(v[:19])
        except ValueError:
            return v
    return v


class HistoryMaster(D.Master):
    """Same interface as the Excel-backed Master, filled from history rows."""

    def __init__(self, schema, history):
        self.path = "history-store"
        self.tables = schema["tables"]
        self.headers = {}
        self.data = {}
        for tn, rows in history.items():
            self.data[tn] = [{k: _revive(v, k) for k, v in r.items()} for r in rows]
        self.vocab = {k: {str(r[c]).strip() for r in self.data.get(k, []) if r.get(c) not in (None, "")} for k, c in D.VOCAB.items()}


def parse_report(kind, pdf_path, cfg, schema, history, site_name=None):
    hm = HistoryMaster(schema, history)
    run = D.Run(cfg, hm)
    if kind == "tms":      # TMS: Excel / Word files, read by the desktop TMS reader unchanged (files = [{path, name, kind}])
        import tms_adapter as T
        T.process(run, pdf_path)
    elif kind == "bm":
        import bm_to_master as B
        B.process_pdf(run, pdf_path)
    else:
        D.process_pdf(run, pdf_path, ocr=False)
    dates = sorted({D.as_date(r.get("DATE")) for rows in run.stage.values() for r in rows if D.as_date(r.get("DATE"))})
    if not dates and kind == "tms" and run.stage.get("tblRAWBARGE") and isinstance(pdf_path, list) and pdf_path[0].get("report_date"):
        dates = [dt.date.fromisoformat(pdf_path[0]["report_date"])]      # a barging file alone: only the barge list changes
    if not dates:
        raise ValueError("no rows were read from the report")
    cal = {}
    for r in hm.rows("tblCALENDAR"):
        d = F.day_of(r.get("DATE"))
        cal[(r.get("CONTRACTOR"), d)] = {"YEAR": r.get("YEAR"), "MONTH": r.get("MONTH"), "WEEK": r.get("WEEK")}
    out, done = {}, {}
    order = ["tblRAWMNG"] + [t for t in D.STAGE_ORDER if t not in ("tblRAWMNG", "tblRAWBARGE")]
    for tn in order:
        staged = run.stage.get(tn) or []
        if not staged:
            continue
        rows_out = []
        for d in dates:
            day = [dict(r) for r in staged if D.as_date(r.get("DATE")) == d]
            if not day:
                continue
            if tn == "tblRAWFUEL":     # the stock stated in the report wins (parser keeps it as _STOCK on the history copy)
                stk = {(x.get("CONTRACTOR"), D.as_date(x.get("DATE"))): x.get("_STOCK") for x in hm.rows(tn) if x.get("_STOCK") is not None}
                for r in day:
                    r["_STOCK"] = stk.get((r.get("CONTRACTOR"), d))
            hist = [r for r in history.get(tn, []) if (F.day_of(r.get("DATE")) or d) < d]
            extra = {"tblRAWMNG": done.get(d, []), "_inputs": set(((schema.get("tables") or {}).get(tn) or {}).get("input") or [])}
            full = F.complete_day(tn, hist, day, cal, extra)
            rows_out.extend(full)
            if tn == "tblRAWMNG":
                done.setdefault(d, []).extend(full)
        out[tn] = rows_out
    out["tblRAWBARGE"] = run.stage.get("tblRAWBARGE") or []
    return {"report_date": dates[0].isoformat(), "dates": [d.isoformat() for d in dates], "rows": out,
            "log": run.log, "meta": run.meta, "barge_touched": len(run.barge_touched), "plan_cal": list(run.plan_cal), "ship_updates": list(run.ship_updates), "hazard_updates": list(getattr(run, "hazard_updates", []) or [])}
