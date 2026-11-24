"""
tms_adapter.py
--------------
TMS (PT Tambang Matarape Sejahtera) inside the local Daily Report ETL app.

Sources (step 2):
  * Daily Production Report  .xlsx   -> tblRAWMNG / HAUL / SHIP / WEWH / FUEL / STOCK / CONS
  * Laporan Inspeksi Harian  .docx   -> tblRAWHAZARD (+ automatic closures, sheet _HAZARD_UPDATES)
  * Realisasi Barging        .xlsx   -> tblRAWBARGE (tms_barge)
  * Stock dome register      .xlsx   -> tblRAWSTOCK per contractor and Ni class (tms_stock, from 10 Nov 2026;
                                        the DPR stockpile block becomes a cross-check when stock_from_dpr is false)

The TMS parsing / mapping / checks live in tms_dpr_parser, tms_hazard_parser, tms_hazard_stage and
tms_to_master (also usable alone from the command line). This module only
  - identifies an uploaded file (kind + report date) for the file list,
  - runs tms_to_master.build() against the app's master (read once by the app),
  - converts the result into the app's Run (stage rows, log, meta, review, plan, hazard updates),
so steps 3 and 4 (review, edit, staging file, Excel load, verify) are the same as for WKM.
"""
from __future__ import annotations

import datetime as dt
import os
import re

KINDS = {".xlsx": "dpr", ".xlsm": "dpr", ".docx": "hazard"}   # an .xlsx can also be "barge" or "stock" (by content)
KIND_LABEL = {"dpr": "Production", "hazard": "Hazard", "barge": "Barging", "stock": "Stock"}


def _date(v):
    if isinstance(v, dt.datetime):
        return v.date()
    if isinstance(v, dt.date):
        return v
    return None


def identify(path, name, cfg):
    """Quick look at an uploaded file: {kind, report_date, header_date, name_date, note} or {error}."""
    ext = os.path.splitext(name)[1].lower()
    kind = KINDS.get(ext)
    if not kind:
        return {"error": "TMS takes the Daily Production Report (.xlsx), the Realisasi Barging (.xlsx), "
                         "the stock dome register (.xlsx) and the inspection report (.docx)"}
    if kind == "dpr":
        import openpyxl
        from tms_dpr_parser import DATE_IN_NAME
        wb = openpyxl.load_workbook(path, data_only=True, read_only=True)
        import tms_barge
        import tms_stock
        if tms_stock.is_stock_register(wb):
            wb.close()
            reg = tms_stock.parse(path, cfg=cfg)
            errs = [m for s, c, m in reg.issues if s == "ERROR"]
            if not reg.sheets:
                return {"kind": "stock", "error": "; ".join(errs) or "no Stock Dome sheet"}
            rec = {"kind": "stock", "report_date": reg.report_date.isoformat(),
                   "domes": sum(len(s["domes"]) for s in reg.sheets),
                   "contractors": ", ".join(s["contractor"] for s in reg.sheets)}
            warns = sum(s == "WARN" for s, c, m in reg.issues)
            if errs or warns:
                rec["note"] = "; ".join(errs[:2] + ([f"{warns} warning(s), see the Issues tab"] if warns else []))
            return rec
        if tms_barge.is_barging(wb):
            wb.close()
            b = tms_barge.parse(path, cfg=cfg)
            errs = [m for s, c, m in b.issues if s == "ERROR"]
            if errs:
                return {"kind": "barge", "error": "; ".join(errs)}
            rec = {"kind": "barge", "report_date": b.report_date.isoformat(), "trips": len(b.trips),
                   "completed": sum(t["status"] == "Completed" for t in b.trips)}
            fixed = sum(c == "date-fix" for s, c, m in b.issues)
            if fixed:
                rec["note"] = f"{fixed} date(s) had day and month swapped by Excel and were corrected (see the Issues tab)"
            return rec
        sh = cfg["sheets"]
        missing = [s for s in (sh["production"], sh["summary"]) if s not in wb.sheetnames]
        if missing:
            wb.close()
            return {"kind": kind, "error": f"not a TMS Daily Production Report (sheet(s) {missing} missing)"}
        d = _date(wb[sh["summary"]]["C3"].value)
        if d is None and sh.get("daily_report") in wb.sheetnames:
            d = _date(wb[sh["daily_report"]]["C6"].value)
        wb.close()
        if d is None:
            return {"kind": kind, "error": "report date not found ('Daily Report Huayou '!C3)"}
        rec = {"kind": kind, "report_date": d.isoformat()}
        m = DATE_IN_NAME.search(name)
        if m:
            try:
                nd = dt.date(int(m[1]), int(m[2]), int(m[3]))
                if nd != d:
                    rec["note"] = f"file name says {nd:%d %b %Y}; the date inside the file is used"
            except ValueError:
                pass
        return rec
    # hazard report
    from tms_hazard_parser import parse_hazard
    h = parse_hazard(path)
    errs = [i.message for i in h.issues if i.severity == "ERROR"]
    if errs:
        return {"kind": kind, "error": "; ".join(errs)}
    rec = {"kind": kind, "report_date": h.report_date.isoformat(),
           "header_date": h.header_date.isoformat() if h.header_date else None,
           "name_date": h.name_date.isoformat() if h.name_date else None,
           "findings": len(h.new), "closed": len(h.closed), "open": len(h.open)}
    return rec


def resolve_display_dates(recs):
    """Same rule as the run (tms_hazard_stage): a hazard report whose header date is used by another
    hazard report while its file-name date is free had its header not updated -> show the file-name date."""
    hz = [r for r in recs if r.get("kind") == "hazard" and r.get("header_date") and not r.get("error")]
    by = {}
    for r in hz:
        r["report_date"] = r["header_date"]
        r.pop("note", None)
        by.setdefault(r["header_date"], []).append(r)
    used = set(by)
    for hd, group in by.items():
        if len(group) < 2:
            continue
        for r in group:
            nd = r.get("name_date")
            if nd and nd != hd and nd not in used:
                r["report_date"] = nd
                used.add(nd)
                r["note"] = f"header says {dt.date.fromisoformat(hd):%d %b %Y} (not updated by site); file-name date used"
    for r in hz:
        if "note" not in r and r.get("name_date") and r["name_date"] != r["report_date"]:
            r["note"] = (f"file name says {dt.date.fromisoformat(r['name_date']):%d %b %Y}; "
                         "the run decides (header, unless that date is already loaded)")


def duplicate_dates(recs):
    """Same report date twice for the same kind of report (a DPR and a hazard report on one day is normal)."""
    seen, dup = {}, set()
    for r in recs:
        if r.get("error") or not r.get("report_date"):
            continue
        k = (r.get("kind") or "pdf", r["report_date"]) + ((r.get("contractors"),) if r.get("kind") == "stock" else ())
        if k in seen:
            dup.add(r["report_date"])
        seen[k] = True
    return sorted(dup)


# ---------------------------------------------------------------------------- run
def process(run, files, progress=lambda m: None):
    """files: [{"path", "name", "kind"}]. Fills the app's dr_to_master.Run in place."""
    from tms_to_master import Master as TMaster, build

    cfg = run.cfg
    names = {os.path.basename(f["path"]): f["name"] for f in files}
    dprs = [f["path"] for f in files if f.get("kind") == "dpr"]
    hzs = [f["path"] for f in files if f.get("kind") == "hazard"]
    bgs = [f for f in files if f.get("kind") == "barge"]
    sts = [f for f in files if f.get("kind") == "stock"]
    progress("Preparing the master history for the TMS checks ...")
    tm = TMaster.from_app_master(run.m)
    r, note = build(cfg, tm, dprs, hazard_paths=hzs, progress=progress)

    # staged rows -> app rows (input columns only, DATE as datetime, INPUT DATE stamped at load)
    for tn, rows in r.rows.items():
        if not rows or tn not in run.m.tables:
            continue
        inputs = run.m.tables[tn]["input"]
        out = []
        for row in rows:
            new = {c: row.get(c) for c in inputs}
            d = _date(new.get("DATE"))
            if d is not None:
                new["DATE"] = dt.datetime.combine(d, dt.time())
            if "INPUT DATE" in new:
                new["INPUT DATE"] = None
            out.append(new)
        run.stage[tn] = out

    def nm(text):
        s = str(text or "")
        for k, v in names.items():
            s = s.replace(k, v)
        return s

    for i in r.issues:
        run.log.append({"severity": i.severity, "date": _date(i.date), "table": i.table, "check": i.check,
                        "message": nm(i.message), "pdf_value": _plain(i.src_value),
                        "master_value": _plain(i.master_value), "diff": _plain(i.diff)})
    for m in r.meta:
        d = _date(m[0])
        if d is None:
            continue
        run.meta.append({"report_date": d, "pdf": names.get(m[1], m[1]), "sha256_16": m[2],
                         "parse_errors": m[3], "note": nm(m[4])})

    for k, rows in r.review.items():
        if not rows:
            continue
        if k == "_HAZARD_UPDATES":
            run.hazard_updates = [dict(x) for x in rows]
            continue
        key = k[len("REVIEW_"):] if k.startswith("REVIEW_") else k.lstrip("_")
        run.review[key] = [{c: nm(v) if isinstance(v, str) else v for c, v in x.items()} for x in rows]
    if r.recon_rows:
        run.review["RECON"] = r.recon_rows
    run.review["NOT_STAGED"] = [{"TABLE": t, "REASON": why} for t, why in cfg.get("tables_not_staged", {}).items()]
    for p in r.plan_rows:
        dif = p.get("DIFF")
        cal = p.get("tblCALENDAR")
        run.plan_cal.append({"date": _date(p["REPORT DATE"]), "contractor": cfg.get("contractor_site", ""),
                             "item": p["PLAN ITEM (DPR)"], "period": "", "column": p["tblCALENDAR COLUMN"],
                             "pdf": p["DPR"], "calendar": cal, "diff": dif,
                             "pct": round(100 * dif / cal, 1) if dif is not None and cal else None})
    if bgs:
        import tms_barge
        run.review.pop("NOT_STAGED", None)
        run.review["NOT_STAGED"] = [{"TABLE": t, "REASON": why} for t, why in cfg.get("tables_not_staged", {}).items()
                                    if t != "tblRAWBARGE"]
        for f in sorted(bgs, key=lambda x: x["name"]):
            progress(f"Reading {f['name']} ...")
            tms_barge.stage(run, tms_barge.parse(f["path"], cfg=cfg), f["name"])
            note = (note + "; " if note else "") + f"Realisasi Barging {f['name']}"
    if sts:
        note = _stage_stock(run, sts, note, progress)
    elif dprs and not cfg.get("stock_from_dpr", True):
        run.L("INFO", None, "tblRAWSTOCK", "stock-source",
              "tblRAWSTOCK not staged: it comes from the stock dome register (STOCK_... .xlsx). Add it in step 2 "
              "to load stock for these dates")
    run.source = {"kind": "tms", "note": note}
    progress(f"TMS checks finished: {sum(len(v) for v in run.stage.values())} row(s) staged.")
    return run


def _stage_stock(run, files, note, progress):
    """Stock dome registers -> tblRAWSTOCK, plus the DPR stockpile cross-check for the same dates."""
    import hashlib
    import tms_stock

    seen = {}
    for f in sorted(files, key=lambda x: x["name"]):
        progress(f"Reading {f['name']} ...")
        reg = tms_stock.parse(f["path"], cfg=run.cfg)
        keep = []
        for sh in reg.sheets:                       # the same contractor + date twice: the later file wins
            k = (sh["date"], sh["contractor"])
            if k in seen:
                run.L("WARN", sh["date"], "tblRAWSTOCK", "stock-duplicate",
                      f"{sh['contractor']} {sh['date']:%d %b %Y} is in {seen[k]} and {f['name']}; {f['name']} is used")
                run.stage["tblRAWSTOCK"] = [r for r in run.stage.get("tblRAWSTOCK", [])
                                            if not (_date(r.get("DATE")) == sh["date"] and r.get("CONTRACTOR") == sh["contractor"])]
                run.review["STOCK_DOMES"] = [r for r in run.review.get("STOCK_DOMES", [])
                                             if not (r["DATE"] == sh["date"] and r["CONTRACTOR"] == sh["contractor"])]
                run.review["STOCK_SUMMARY"] = [r for r in run.review.get("STOCK_SUMMARY", [])
                                               if not (r["DATE"] == sh["date"] and r["CONTRACTOR"] == sh["contractor"])]
            seen[k] = f["name"]
            keep.append(sh)
        reg.sheets = keep
        tms_stock.stage(run, reg, f["name"])
        if reg.report_date:
            sha = hashlib.sha256(open(f["path"], "rb").read()).hexdigest()[:16]
            run.meta.append({"report_date": reg.report_date, "pdf": f["name"], "sha256_16": sha,
                             "parse_errors": sum(s == "ERROR" for s, _, _ in reg.issues),
                             "note": "stock register: " + ", ".join(s["contractor"] for s in reg.sheets)})
        note = (note + "; " if note else "") + f"Stock register {f['name']}"
    # DPR stockpile block (contractor_site) vs the register, same date
    dpr = {}
    for r in run.review.get("STOCK", []):
        d = _date(r.get("DATE"))
        if d is not None and r.get("STOCKPILE") in ("ETO", "EFO"):
            dpr[(d, r["STOCKPILE"])] = r.get("LIMONITE T") or 0
    reg_tot = {}
    for r in run.review.get("STOCK_SUMMARY", []):
        if r["CLASS"] == "TOTAL (dome rows)" and r["STOCKPILE"] in ("ETO", "EFO"):
            reg_tot.setdefault((r["DATE"], r["STOCKPILE"]), {})[r["CONTRACTOR"]] = r["TONAGE"]
    for (d, p), byc in sorted(reg_tot.items()):
        if (d, p) not in dpr:
            continue
        v = dpr[(d, p)]
        run.review["STOCK_DPR_CHECK"].append({"DATE": d, "STOCKPILE": p, "DPR T": v, **{f"REGISTER {c} T": t for c, t in byc.items()},
                                             "REGISTER ALL T": round(sum(byc.values()), 2),
                                             "DIFF DPR - ALL": round(v - sum(byc.values()), 2)})
        if abs(v - sum(byc.values())) > max(1.0, 0.0005 * abs(v)):
            run.L("RECON", d, "tblRAWSTOCK", "stock-dpr", f"{p}: DPR stockpile {v:,.2f} t vs register "
                  + " + ".join(f"{c} {t:,.2f}" for c, t in byc.items()) + f" = {sum(byc.values()):,.2f} t "
                  "(the DPR may cover one contractor only, or another day)", v, round(sum(byc.values()), 2))
    return note


def _plain(v):
    if v is None:
        return None
    if hasattr(v, "item") and not isinstance(v, (str, bytes)):
        try:
            return v.item()
        except Exception:
            return v
    return v
