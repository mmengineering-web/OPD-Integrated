"""
dr_to_master.py
---------------
WKM Daily Report PDF  ->  staging workbook shaped exactly like the INPUT columns of
the tblRAW* tables in Master_Data_Site_WKM.xlsm.

Why staging and not a direct write?
  The master is an .xlsm with VBA forms, a Power Pivot model, charts, slicers and
  calculated (LET/XLOOKUP) table columns. Python libraries cannot save that file
  without damaging parts of it. So Python does parsing + mapping + QA, and the
  Excel-side macro (ImportDailyReport.bas) appends the staged rows with
  ListRows.Add, letting Excel fill the calculated columns itself.

Usage
  python dr_to_master.py --pdf "Daily_Report_WKM_01_September_2026.pdf" \
                         --master "Master_Data_Site_WKM.xlsm" \
                         --out staging_WKM_2026-09-01.xlsx
  # several days at once (processed in date order, each day sees the previous ones)
  python dr_to_master.py --pdf reports_folder/ --master Master.xlsm --out staging_backfill.xlsx
"""
from __future__ import annotations

import argparse
import datetime as dt
import difflib
import glob
import hashlib
import json
import os
import re
import sys
import zipfile
from collections import defaultdict
from xml.etree import ElementTree as ET

import openpyxl
from openpyxl.styles import Alignment, Font, PatternFill
from openpyxl.utils import get_column_letter, range_boundaries

from dr_pdf_parser import PARSER_VERSION, norm, parse_daily_report

NS = {"m": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}
RNS = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id"
VOCAB = {"tblIDSITE": "SITE NAME", "tblIDCONTRACTOR": "LIST OF CONTRACTOR", "tblIDPIT": "LIST OF PIT",
         "tblIDSHIFT": "SHIFT", "tblREPAIRSTATUS": "REPAIR STATUS", "tblRISKLEVEL": "RISK LEVEL",
         "tblHAZARDCATEGORY": "HAZARD CATEGORY", "tblBARGESTATUS": "BARGE STATUS",
         "tblCONSCATEGORY": "CONSTRUCTION CATEGORY"}
EXTRA_DATA = {"tblCALENDAR"}  # read for checks only (plan), never written
STAGE_ORDER = ["tblRAWHSE", "tblRAWHAZARD", "tblRAWMNG", "tblRAWSTOCK", "tblRAWHAUL", "tblRAWSHIP",
               "tblRAWBARGE", "tblRAWEQ", "tblRAWUP", "tblRAWWEWH", "tblRAWFUEL", "tblRAWMP",
               "tblRAWLAB", "tblRAWCONS"]


# ==========================================================================
# master workbook (read-only)
# ==========================================================================
class Master:
    def __init__(self, path):
        self.path = path
        self.tables = self._table_defs(path)
        wb = openpyxl.load_workbook(path, read_only=True, data_only=True)
        self.data = {}
        self.headers = {}   # header cells actually found at each table's ref (used by the Supabase export check)
        for name, t in self.tables.items():
            if not (name.startswith("tblRAW") or name in VOCAB or name in EXTRA_DATA):
                continue
            ws = wb[t["sheet"]]
            c1, r1, c2, r2 = range_boundaries(t["ref"])
            rows = []
            first = True
            for vals in ws.iter_rows(min_row=r1, max_row=r2, min_col=c1, max_col=c2, values_only=True):
                if first:
                    self.headers[name] = list(vals)
                    first = False
                    continue
                if all(v in (None, "") for v in vals):
                    continue
                rows.append(dict(zip(t["cols"], vals)))
            self.data[name] = rows
        wb.close()
        self.vocab = {k: {str(r[c]).strip() for r in self.data.get(k, []) if r.get(c) not in (None, "")}
                      for k, c in VOCAB.items()}

    @staticmethod
    def _table_defs(path):
        z = zipfile.ZipFile(path)
        wbx = ET.fromstring(z.read("xl/workbook.xml"))
        rels = ET.fromstring(z.read("xl/_rels/workbook.xml.rels"))
        rmap = {r.get("Id"): r.get("Target") for r in rels}
        out = {}
        for s in wbx.find("m:sheets", NS):
            target = rmap[s.get(RNS)]
            sheetfile = target.lstrip("/") if target.startswith("/") else "xl/" + target
            relf = os.path.dirname(sheetfile) + "/_rels/" + os.path.basename(sheetfile) + ".rels"
            if relf not in z.namelist():
                continue
            for r in ET.fromstring(z.read(relf)):
                if not r.get("Type").endswith("/table"):
                    continue
                tf = os.path.normpath(os.path.join(os.path.dirname(sheetfile), r.get("Target"))).replace("\\", "/")
                t = ET.fromstring(z.read(tf))
                cols, inp = [], []
                for c in t.find("m:tableColumns", NS):
                    cols.append(c.get("name"))
                    if c.find("m:calculatedColumnFormula", NS) is None:
                        inp.append(c.get("name"))
                out[t.get("name")] = {"sheet": s.get("name"), "ref": t.get("ref"), "cols": cols, "input": inp}
        return out

    # ---- history helpers -------------------------------------------------
    def rows(self, tn):
        return self.data.get(tn, [])

    def contractors(self, tn):
        return {r.get("CONTRACTOR") for r in self.rows(tn) if r.get("CONTRACTOR")}

    def rows_on(self, tn, d, datecol="DATE"):
        return [r for r in self.rows(tn) if as_date(r.get(datecol)) == d]

    def sum_between(self, tn, col, d0, d1, **flt):
        """sum(col) for d0 <= DATE < d1 with equality filters."""
        tot = 0.0
        for r in self.rows(tn):
            d = as_date(r.get("DATE"))
            if d is None or not (d0 <= d < d1):
                continue
            if any(r.get(k) != v for k, v in flt.items()):
                continue
            tot += fnum(r.get(col))
        return tot


def as_date(v):
    """Date of a cell value. A date-time is rounded to the NEAREST day, so a date written
    shifted by the time zone (e.g. 17-Sep 17:00 instead of 18-Sep 00:00) still counts as its real day."""
    if isinstance(v, dt.datetime):
        if v.tzinfo is not None:
            v = v.replace(tzinfo=None)
        if (v.hour, v.minute, v.second) == (0, 0, 0):
            return v.date()
        return (v + dt.timedelta(hours=12)).date()
    if isinstance(v, dt.date):
        return v
    return None


def fnum(v):
    if v in (None, "", "-"):
        return 0.0
    try:
        return float(v)
    except (TypeError, ValueError):
        return 0.0


def clean_num(v):
    """float -> int when integral (keeps the master tidy)."""
    if v is None:
        return None
    if abs(v - round(v)) < 1e-9:
        return int(round(v))
    return round(v, 6)


# ==========================================================================
# run context: log + staged rows
# ==========================================================================
class Run:
    def __init__(self, cfg, master: Master):
        self.cfg = cfg
        self.m = master
        self.log = []
        self.stage = defaultdict(list)       # table -> rows
        self.review = defaultdict(list)      # REVIEW_ sheets (not imported)
        self.barge_diff = []
        self.plan_changes = []   # plan in the PDF changed since the previous report of the run
        self.plan_cal = []       # PDF plan differs from tblCALENDAR (listed when the set of differences changes)
        self.unmapped = defaultdict(list)
        self.meta = []
        self.preexisting = set()     # (table, date) already present in the master before this run
        self.hazard_updates = []     # TMS: closures / ID tags for rows already in tblRAWHAZARD (applied after loading)
        self.ship_updates = []       # WKM / BM: SHIP DAY of earlier days that changed because the barge list changed (applied after loading)
        self.barge_touched = []      # every barge SI written by t_barge (old row, new row) - input of t_ship_sync
        self._ship_seen = 0          # barge_touched entries already handled by t_ship_sync
        self._ship_checked = set()   # (date, contractor) pairs t_ship_sync has compared in this run

    def L(self, sev, d, table, check, msg, pdf=None, master=None):
        diff = None
        if isinstance(pdf, (int, float)) and isinstance(master, (int, float)):
            diff = round(pdf - master, 4)
        self.log.append({"severity": sev, "date": d, "table": table, "check": check, "message": msg,
                         "pdf_value": pdf, "master_value": master, "diff": diff})

    def tol(self, v):
        return max(self.cfg["tolerance_abs"], abs(v or 0) * self.cfg["tolerance_rel"])

    def recon(self, d, table, label, pdf_val, expected, note=""):
        if pdf_val is None:
            return
        ok = abs(pdf_val - expected) <= self.tol(pdf_val)
        if not ok:
            self.L("RECON", d, table, "reconcile", f"{label}: PDF {pdf_val:,.2f} vs master+today {expected:,.2f}"
                   + (f" ({note})" if note else ""), pdf_val, round(expected, 4))
        return ok

    def add(self, table, row, d):
        """Stage a row and make it visible as history for later days in the same batch
        (unless the master already holds that date - then the master rows stay the history)."""
        self.stage[table].append(row)
        if (table, d) in self.preexisting:
            return
        self.m.data.setdefault(table, []).append({**row, "DATE": dt.datetime.combine(d, dt.time()) if "DATE" in row else row.get("DATE")})

    def cmap(self, label):
        c = self.cfg["contractor_map"].get(label) or self.cfg["contractor_map"].get(label.upper())
        return c

    def vocab_ok(self, d, table, field, value, vocab_table, level="ERROR"):
        voc = self.m.vocab.get(vocab_table) or set()
        if value is None or not voc:
            return True
        if str(value) not in voc:
            self.L(level, d, table, "vocab", f"{field} '{value}' not in {vocab_table} {sorted(voc)}", value)
            return False
        return True


# ==========================================================================
# transforms (one per target table)
# ==========================================================================
def base_row(run, table, d, contractor=None, shift=True):
    cols = run.m.tables[table]["input"]
    r = {c: None for c in cols}
    if "DATE" in r:
        r["DATE"] = dt.datetime.combine(d, dt.time())
    if "SITE" in r:
        r["SITE"] = run.cfg["site"]
    if contractor is not None and "CONTRACTOR" in r:
        r["CONTRACTOR"] = contractor
    if shift and "SHIFT" in r:
        r["SHIFT"] = run.cfg["shift"]
    return r


def period_starts(d):
    return d.replace(day=1), d.replace(month=1, day=1)


def t_hse(run, p, d):
    T = "tblRAWHSE"
    if "hse" not in p:
        return
    cats = run.cfg["hse_categories"]
    daily = p["hse"]["by_period"].get("DAILY", {})
    hist = run.m.contractors(T)
    m0, y0 = period_starts(d)
    for label, vals in daily.items():
        c = run.cmap(label)
        if not c:
            run.L("ERROR", d, T, "contractor", f"HSE header '{label}' not in contractor_map")
            continue
        nonzero = any((v or 0) != 0 for v in vals.values())
        if c not in hist and not nonzero:
            run.L("INFO", d, T, "skip", f"{label} -> {c}: all zero and no history in {T}; row not staged")
        else:
            if not run.vocab_ok(d, T, "CONTRACTOR", c, "tblIDCONTRACTOR"):
                continue
            r = base_row(run, T, d, c)
            for lab, v in vals.items():
                r[cats[lab]] = clean_num(v if v is not None else 0)
            if "Fatality" not in vals:
                r["FATALITY"] = None
            run.add(T, r, d)
        # reconciliation MONTH / YEAR
        for per, start in (("MONTHLY", m0), ("YEARLY", y0)):
            pv = p["hse"]["by_period"].get(per, {}).get(label, {})
            for lab, v in pv.items():
                col = cats[lab]
                prior = run.m.sum_between(T, col, start, d, CONTRACTOR=c)
                run.recon(d, T, f"{c} {col} {per}", v, prior + (vals.get(lab) or 0))
    if not any("Fatality" in v for v in daily.values()):
        run.L("INFO", d, T, "missing", "PDF has no Fatality row - FATALITY left blank")


def _map_vocab(run, mapping, raw):
    if raw is None:
        return None
    return mapping.get(raw.strip().upper(), raw.strip())


def t_hazard(run, p, d):
    T = "tblRAWHAZARD"
    if "hazards" not in p:
        return
    for h in p["hazards"]:
        r = base_row(run, T, d)
        loc = h["location"]
        for pat, rep in run.cfg.get("text_replacements", []):
            loc = re.sub(pat, rep, loc)
        for k in ("status", "risk", "category"):
            if (h.get(k) or "").strip() in ("0", "-", ""):
                if (h.get(k) or "").strip() in ("0", "-"):
                    run.L("WARN", d, T, "blank", f"hazard '{loc}': {k.upper()} is empty in the PDF ('{h[k]}') - staged blank, fill it in step 3 if known")
                h = {**h, k: None}
        r.update({
            "HAZARD LOCATION": loc or "-",
            "IDENTIFIED HAZARD": h["identified"] or "-",
            "CORRECTIVE ACTION": h["corrective"] or "-",
            "REPAIR STATUS": _map_vocab(run, run.cfg["repair_status_map"], h["status"]),
            "RISK LEVEL": _map_vocab(run, run.cfg["risk_level_map"], h["risk"]),
            "HAZARD CATEGORY": _map_vocab(run, run.cfg["hazard_category_map"], h["category"]),
            "REMARKS": "-",
        })
        for f, vt in (("REPAIR STATUS", "tblREPAIRSTATUS"), ("RISK LEVEL", "tblRISKLEVEL"), ("HAZARD CATEGORY", "tblHAZARDCATEGORY")):
            voc = run.m.vocab.get(vt) or set()
            if r[f] is not None and voc and str(r[f]) not in voc:
                run.L("WARN", d, T, "vocab", f"hazard '{loc}': {f} '{r[f]}' is not in the {vt} list {sorted(voc)} - staged as written; "
                      "fix it in step 3 or add a translation to config", r[f])
        run.add(T, r, d)
    run.L("INFO", d, T, "count", f"{len(p['hazards'])} hazard row(s) staged")


def _pit_contractors(run):
    T = "tblRAWMNG"
    last = {}
    for r in sorted(run.m.rows(T), key=lambda r: as_date(r.get("DATE")) or dt.date.min):
        if r.get("PIT") not in (None, run.cfg["mng_all_pit_label"]) and fnum(r.get("H-DAY")) > 0:
            last[r["PIT"]] = r.get("CONTRACTOR")
    last.update(run.cfg.get("pit_contractor_override", {}))
    return last


def _check_pit_order_ocr(run, d, order, ocr):
    if not ocr:
        run.L("INFO", d, "tblRAWMNG", "pit-ocr", "OCR cross-check of pit chart labels not available (pytesseract/tesseract missing) - relying on config order")
        return True
    voc = sorted(run.m.vocab.get("tblIDPIT", set()) | set(order))
    matched = []
    for tok in ocr:
        best = difflib.get_close_matches(tok.upper(), voc, n=1, cutoff=0.6)
        if best:
            matched.append(best[0])
    if len(matched) != len(order):
        run.L("WARN", d, "tblRAWMNG", "pit-ocr", f"OCR read {len(matched)} pit labels vs {len(order)} in config - order not verified. OCR: {matched}")
        return True
    bad = [(i, a, b) for i, (a, b) in enumerate(zip(order, matched)) if a != b]
    if bad:
        run.L("ERROR", d, "tblRAWMNG", "pit-ocr", f"Pit chart order differs from config at {bad}. Update config pit_chart.order to: {matched}")
        return False
    run.L("INFO", d, "tblRAWMNG", "pit-ocr", "Pit chart labels verified by OCR against config order")
    return True


def t_mng(run, p, d):
    T = "tblRAWMNG"
    if "mining" not in p:
        return
    mrows = run.cfg["mining_rows"]
    m0, y0 = period_starts(d)
    mining = p["mining"]
    # TOTAL = FSI + TJA
    for lab, per in mining.items():
        for prd, v in per.items():
            s = sum((v.get(c) or 0) for c in run.cfg["mining_contractors"])
            if v.get("TOTAL") is not None and abs(s - v["TOTAL"]) > run.tol(v["TOTAL"]):
                run.L("WARN", d, T, "total", f"{lab} {prd}: FSI+TJA {s:,.2f} <> TOTAL {v['TOTAL']:,.2f}", s, v["TOTAL"])
    # All-pit rows (S, OB, L, M, Q)
    for hdr, c in run.cfg["mining_contractors"].items():
        r = base_row(run, T, d, c)
        r["PIT"] = run.cfg["mng_all_pit_label"]
        for lab, code in mrows.items():
            if code == "H" or lab not in mining:
                continue
            r[f"{code}-DAY"] = clean_num(mining[lab]["DAY"].get(hdr) or 0)
        if run.vocab_ok(d, T, "CONTRACTOR", c, "tblIDCONTRACTOR"):
            run.add(T, r, d)
    # HGO by pit
    h_ok = False
    pc = p.get("pit_chart")
    orders = run.cfg["pit_chart"].get("orders") or [run.cfg["pit_chart"]["order"]]
    order = None
    if pc:
        fits = [o for o in orders if len(o) == len(pc["values"])]
        order = fits[-1] if fits else None
    if not pc:
        run.L("ERROR", d, T, "pit-chart", "pit chart not parsed - HGO (H-DAY) NOT staged; key it manually")
    elif order is None:
        run.L("ERROR", d, T, "pit-chart", f"pit chart has {len(pc['values'])} bars but no layout with that many pits in config "
              f"pit_chart.orders - H-DAY NOT staged. Add this order (from OCR): {pc.get('ocr_names')}")
    elif _check_pit_order_ocr(run, d, order, pc.get("ocr_names")):
        hgo = {c: (mining.get("HGO", {}).get("DAY", {}).get(hdr) or 0) for hdr, c in run.cfg["mining_contractors"].items()}
        owner = _pit_contractors(run)
        infer = set(run.cfg.get("pit_infer_owner", []))
        vals = [(pit, v) for pit, v in zip(order, pc["values"]) if v]
        fixed = [(pit, v) for pit, v in vals if pit in owner and pit not in infer]
        loose = [(pit, v) for pit, v in vals if pit not in owner or pit in infer]
        base_sum = defaultdict(float)
        for pit, v in fixed:
            base_sum[owner[pit]] += v
        assign = {pit: owner[pit] for pit, _ in fixed}
        ok_assign = None
        ctrs = list(hgo)
        if loose and len(loose) <= 5:
            import itertools
            sols = []
            for combo in itertools.product(ctrs, repeat=len(loose)):
                sm = dict(base_sum)
                for (pit, v), c in zip(loose, combo):
                    sm[c] = sm.get(c, 0) + v
                if all(abs(sm.get(c, 0) - hgo[c]) <= run.tol(hgo[c]) for c in ctrs):
                    sols.append(combo)
            if len(sols) == 1:
                ok_assign = dict(zip([pit for pit, _ in loose], sols[0]))
                run.L("WARN" if any(p_ not in infer for p_ in ok_assign) else "INFO", d, T, "pit-owner",
                      "contractor of " + ", ".join(f"{p_} = {c}" for p_, c in ok_assign.items())
                      + " worked out from the HGO totals (no fixed owner in history/config)")
            elif not sols:
                run.L("ERROR", d, T, "pit-owner", f"no contractor assignment of {loose} makes the pits add up to the HGO row - H-DAY NOT staged")
            else:
                run.L("ERROR", d, T, "pit-owner", f"pits {loose} could belong to more than one contractor; set config pit_contractor_override - H-DAY NOT staged")
        elif loose:
            run.L("ERROR", d, T, "pit-owner", f"too many pits without a known contractor {loose} - H-DAY NOT staged")
        if not loose or ok_assign:
            assign.update(ok_assign or {})
            sums = defaultdict(float)
            pit_rows = []
            for pit, v in vals:
                c = assign[pit]
                r = base_row(run, T, d, c)
                r["PIT"] = pit
                r["H-DAY"] = clean_num(v)
                pit_rows.append(r)
                sums[c] += v
            bad = [f"{c}: pits {sums[c]:,.2f} vs HGO {hgo[c]:,.2f}" for c in ctrs if abs(sums[c] - hgo[c]) > run.tol(hgo[c])]
            if bad:
                run.L("ERROR", d, T, "pit-sum", "pit chart does not reconcile to HGO row - H-DAY NOT staged: " + "; ".join(bad))
            else:
                for r in pit_rows:
                    if not run.vocab_ok(d, T, "PIT", r["PIT"], "tblIDPIT", level="WARN"):
                        run.L("WARN", d, T, "vocab", f"pit '{r['PIT']}' staged anyway so the contractor HGO total stays right - "
                              "add it to LIST OF PIT on DOCUMENT CONTROL")
                    run.add(T, r, d)
                h_ok = True
                run.L("INFO", d, T, "pit-sum", f"{len(pit_rows)} pit HGO rows staged; per-contractor sums match HGO row")
    # reconciliation MONTH / YEAR, recomputed from DAY columns (cached cumulative columns are not trusted)
    for hdr, c in run.cfg["mining_contractors"].items():
        for lab, code in mrows.items():
            if lab not in mining or (code == "H" and not h_ok):
                continue
            today = mining[lab]["DAY"].get(hdr) or 0
            for per, start in (("MONTH", m0), ("YEAR", y0)):
                prior_excl = run.m.sum_between(T, f"{code}-DAY", start, d, CONTRACTOR=c)  # DATE < d only
                run.recon(d, T, f"{c} {lab} {per}", mining[lab][per].get(hdr), prior_excl + today)


def t_stock(run, p, d):
    T = "tblRAWSTOCK"
    if "stock" not in p:
        return
    pre = p["stock"]["type"]
    for c, rows in p["stock"]["by_contractor"].items():
        r = base_row(run, T, d, c)
        tot = 0.0
        for lab, code in run.cfg["stock_rows"].items():
            v = rows.get(lab)
            if not v:
                run.L("WARN", d, T, "missing", f"{c}: stock row '{lab}' not found")
                continue
            if code in ("WS", "WA"):
                r[f"{pre}-{code}-TONAGE"] = clean_num(v["TONNAGE"])
                if code == "WA":
                    tot += v["TONNAGE"] or 0
                continue
            r[f"{pre}-{code}-Ni"] = clean_num(v["NI"])
            r[f"{pre}-{code}-Si/MgO"] = clean_num(v["SIMGO"])
            r[f"{pre}-{code}-TONAGE"] = clean_num(v["TONNAGE"])
            tot += v["TONNAGE"] or 0
        if rows.get("TOTAL") and rows["TOTAL"]["TONNAGE"] is not None:
            tv = rows["TOTAL"]["TONNAGE"]
            if abs(tv - tot) > run.tol(tv):
                run.L("WARN", d, T, "total", f"{c}: HGO+MGO+LGO A+LGO B+WAITING ASSAY {tot:,.2f} <> TOTAL {tv:,.2f}", tot, tv)
        if run.vocab_ok(d, T, "CONTRACTOR", c, "tblIDCONTRACTOR"):
            run.add(T, r, d)
    run.L("INFO", d, T, "note", f"{pre} stock staged; Fe/Co/MgO/SiO2/MC not in PDF (left blank). WAITING SURVEY is a DOME count, stored in {pre}-WS-TONAGE as in history")


def t_haul(run, p, d):
    T = "tblRAWHAUL"
    if "hauling" not in p:
        return
    c = run.cfg["hauling_contractor"]
    h = p["hauling"]
    r = base_row(run, T, d, c)
    r["DAY"] = clean_num(h.get("DAY") or 0)
    run.add(T, r, d)
    m0, y0 = period_starts(d)
    for per, start in (("MONTH", m0), ("YEAR", y0)):
        run.recon(d, T, f"hauling {per}", h.get(per), run.m.sum_between(T, "DAY", start, d, CONTRACTOR=c) + (h.get("DAY") or 0))


def _si_key(v):
    if v is None or v == "":
        return ""
    if isinstance(v, float) and v.is_integer():
        v = int(v)
    return str(v).strip()


BARGE_CLEARABLE = ("STARTDATE", "FINISHDATE", "ACTUAL CAPACITY")   # a blank in the latest PDF clears these


def _real_barges(p):
    """PDF barge rows without the template's empty placeholder lines (SI number, vessel '0', no contractor)."""
    out = []
    for b in p.get("barges", []):
        if (b.get("contractor") or "").strip() in ("", "0") and (b.get("vessel") or "").strip() in ("", "0"):
            continue
        out.append(b)
    return out


def _finished_today(run, p, d):
    """PDF barges whose FINISH date equals the report date (manual-workflow rule)."""
    return [b for b in _real_barges(p) if b.get("finish") == d]


def t_ship(run, p, d):
    """Manual rule: DAY per contractor = sum of ACTUAL CAPACITY of the PDF barges
    whose FINISH date is the report date. Contractors without a finished barge get 0."""
    T = "tblRAWSHIP"
    if "barges" not in p:
        run.L("ERROR", d, T, "missing", "barge list not parsed - shipment NOT staged")
        return
    ctrs = list(run.cfg.get("ship_contractors", ["PT FSI", "PT TJA"]))
    days = {c: 0.0 for c in ctrs}
    sis = defaultdict(list)
    for b in _finished_today(run, p, d):
        c = run.cmap(b["contractor"]) or b["contractor"]
        if b.get("actual_cap") is None:
            run.L("WARN", d, T, "no-actual", f"SI {b['si']} ({c}) finished today but ACTUAL CAPACITY is blank/0 in the PDF - counted as 0")
        days[c] = days.get(c, 0.0) + (b.get("actual_cap") or 0.0)
        sis[c].append(b["si"])
    for c, v in days.items():
        if not run.vocab_ok(d, T, "CONTRACTOR", c, "tblIDCONTRACTOR"):
            continue
        r = base_row(run, T, d, c)
        r["DAY"] = clean_num(round(v, 4))
        run.add(T, r, d)
    run.L("INFO", d, T, "rule", "DAY = sum ACTUAL CAPACITY of SIs finished on report date: "
          + "; ".join(f"{c} {days[c]:,.2f} {sis.get(c) or ''}" for c in days))
    # cross-checks against the site's own shipment chart (often wrong - informational only)
    st = p.get("shipment_total") or {}
    tot = sum(days.values())
    if st.get("DAY") is not None and abs(st["DAY"] - tot) > run.tol(st["DAY"]):
        run.L("RECON", d, T, "vs-chart", f"barge-based DAY {tot:,.2f} vs the PDF's TOTAL SHIPMENT chart DAY {st['DAY']:,.2f} "
              "(the chart is not reliable in Sep-2026 reports; the barge list is used)", tot, st["DAY"])
    m0, y0 = period_starts(d)
    act = {per: (p.get("sales", {}).get(per) or {}).get("ACTUAL SALE (WMT)", {}) for per in ("MONTH", "YEAR")}
    for per, start in (("MONTH", m0), ("YEAR", y0)):
        for hdr, v in act[per].items():
            c = run.cmap(hdr)
            run.recon(d, T, f"{c} ship {per}", v if v is not None else 0.0,
                      run.m.sum_between(T, "DAY", start, d, CONTRACTOR=c) + days.get(c, 0.0))
    run.recon(d, T, "TOTAL SHIPMENT YTD", st.get("YTD"), run.m.sum_between(T, "DAY", y0, d) + tot)


BARGE_FIELDS = [("vessel", "VESSEL/BARGE"), ("contractor", "CONTRACTOR"), ("start", "STARTDATE"),
                ("finish", "FINISHDATE"), ("plan_cap", "PLAN CAPACITY"), ("actual_cap", "ACTUAL CAPACITY"),
                ("grade_plan", "GRADE PLAN"), ("status", "STATUS")]


def _barge_row(run, b):
    T = "tblRAWBARGE"
    r = {c: None for c in run.m.tables[T]["input"]}
    r["SI"] = b["si"]
    for k, col in BARGE_FIELDS:
        v = b.get(k)
        if k == "status" and v:
            v = run.cfg.get("barge_status_map", {}).get(v.strip().upper(), v.strip())
        if k in ("start", "finish") and v:
            v = dt.datetime.combine(v, dt.time())
        if k == "contractor" and v:
            v = run.cmap(v) or v
        if isinstance(v, float):
            v = clean_num(v)
        r[col] = v if v not in ("", "0") else None
    return r


def _blank(v):
    return v in (None, "", "-") or (isinstance(v, (int, float)) and not isinstance(v, bool) and v == 0)


def _show(v):
    if _blank(v):
        return "(blank)"
    if isinstance(v, dt.datetime):
        return v.strftime("%d-%b-%Y") + ("" if (v.hour, v.minute) == (0, 0) else v.strftime(" %H:%M"))
    if isinstance(v, float):
        return f"{v:,.2f}"
    return str(v)


def _barge_same(a, b):
    if _blank(a) and _blank(b):
        return True
    if _blank(a) or _blank(b):
        return False
    if isinstance(a, dt.datetime) and isinstance(b, dt.datetime):
        return a.replace(tzinfo=None) == b.replace(tzinfo=None)   # exact: a date stored 7 h early must be rewritten
    return _same(a, b)


def t_barge(run, p, d):
    """Barge list = latest state. Every SI in the PDF is written to tblRAWBARGE: a new SI is added,
    an existing SI is updated with the PDF values (WARN lists what changed). Blank PDF values clear
    STARTDATE/FINISHDATE/ACTUAL CAPACITY; other fields keep the master value when the PDF cell is blank/0.
    config barge_stage_mode = finished_on_report_date restores the older rule (only SIs finished that day)."""
    T = "tblRAWBARGE"
    if "barges" not in p:
        return
    mode = run.cfg.get("barge_stage_mode", "update_all")
    if not hasattr(run, "barge_state"):
        run.barge_state = {}
        for r in run.m.rows(T):              # later rows win
            k = _si_key(r.get("SI"))
            if k:
                run.barge_state[k] = dict(r)
    staged_at = {_si_key(r.get("SI")): i for i, r in enumerate(run.stage.get(T, []))}
    n_new = n_upd = n_same = 0
    for b in _real_barges(p):
        if mode == "finished_on_report_date" and b.get("finish") != d:
            continue
        pdf = _barge_row(run, b)
        run.vocab_ok(d, T, "STATUS", pdf["STATUS"], "tblBARGESTATUS", level="WARN")
        cur = run.barge_state.get(b["si"])
        # late-reported completion: the shipment of that finish day may already be loaded without it
        fin_before = as_date(cur.get("FINISHDATE")) if cur else None
        if run.cfg.get("barge_late_finish_warn", True) and b.get("finish") and b["finish"] < d and fin_before is None:
            tail = ("tblRAWSHIP for that day is brought in line in the Ship updates tab." if (run.cfg.get("ship_sync") or {}).get("enabled")
                    else f"tblRAWSHIP for {b['finish']} only counts it if that day is (re)loaded with this barge list.")
            run.L("WARN", d, T, "late-finish", f"SI {b['si']} first shows FINISH {b['finish']} (actual {_show(b.get('actual_cap'))}) in the "
                  f"{d} report. {tail}")
        rank = {"TBI": 0, "STANDBY": 1, "LOADING": 1, "CONTINUE": 1, "SAILING": 2, "UNLOADING": 2, "COMPLETED": 3}
        r_pdf = rank.get(str(pdf.get("STATUS") or "").upper())
        r_cur = rank.get(str((cur or {}).get("STATUS") or "").upper())
        if cur is not None and r_pdf is not None and r_cur is not None and r_pdf < r_cur:
            run.L("WARN", d, T, "barge-older", f"SI {b['si']}: the {d:%d-%b} report shows {pdf['STATUS']} but the master already has "
                  f"{cur.get('STATUS')} (from a newer report) - master kept. Edit the staged row if the site really reversed it.")
            n_same += 1
            continue
        if cur is None:
            target = dict(pdf)
            changes = [("(new SI)", None, pdf["VESSEL/BARGE"])]
            n_new += 1
            run.barge_diff.append({"date": d, "SI": b["si"], "field": "*", "master": None, "pdf": pdf["VESSEL/BARGE"], "action": "NEW SI - will be added"})
            run.L("INFO", d, T, "barge-new", f"SI {b['si']} {pdf['CONTRACTOR']} {pdf['VESSEL/BARGE']} ({pdf['STATUS']}) is new - will be added")
        else:
            target = dict(cur)
            changes = []
            for _, col in BARGE_FIELDS:
                pv, mv = pdf.get(col), cur.get(col)
                new = pv if (not _blank(pv) or col in BARGE_CLEARABLE) else mv
                if not _barge_same(mv, new):
                    changes.append((col, mv, new))
                    target[col] = new
                    run.barge_diff.append({"date": d, "SI": b["si"], "field": col, "master": mv, "pdf": new,
                                           "action": "update - cleared" if _blank(new) else "update"})
            if changes:
                n_upd += 1
                run.L("WARN", d, T, "barge-update", f"SI {b['si']} ({pdf['CONTRACTOR'] or cur.get('CONTRACTOR')}) will be overwritten by the "
                      f"{d:%d-%b} report: " + "; ".join(f"{c} {_show(o)} -> {_show(n)}" for c, o, n in changes))
            else:
                n_same += 1
        if cur is not None and not changes:
            continue
        run.barge_touched.append({"si": b["si"], "report": d, "old": dict(cur) if cur is not None else None, "new": dict(target)})
        row = {c: target.get(c) for c in run.m.tables[T]["input"]}
        row["SI"] = b["si"]
        row["INPUT DATE"] = None
        for col in BARGE_CLEARABLE:          # carry explicit blanks so the loader clears them
            if _blank(row.get(col)):
                row[col] = None
        if b["si"] in staged_at:
            run.stage[T][staged_at[b["si"]]] = row
        else:
            staged_at[b["si"]] = len(run.stage[T])
            run.stage[T].append(row)
        run.barge_state[b["si"]] = {**target, "SI": b["si"]}
    run.L("INFO", d, T, "rule", f"barge list {d:%d-%b}: {n_new} new SI, {n_upd} updated, {n_same} unchanged (latest report wins)")


def _same(a, b):
    if isinstance(a, dt.datetime) and isinstance(b, dt.datetime):
        return a.date() == b.date()
    if isinstance(a, (int, float)) and isinstance(b, (int, float)):
        return abs(a - b) < 0.005
    return norm(str(a)) == norm(str(b))


# ==========================================================================
# SHIP follows BARGE (1.13)
# ==========================================================================
SHIP_UPDATE_COLS = ["DECISION", "KIND", "DATE", "SITE", "CONTRACTOR", "OLD DAY", "NEW DAY", "DIFF", "CAUSED BY", "NOTE"]
KIND_BARGE, KIND_STALE = "Barge change", "Old mismatch"
SHIP_TOL = 0.005


def is_apply(decision):
    """DECISION cell -> True when the new value should overwrite the master (Apply / Overwrite / Yes)."""
    return str(decision or "").strip().lower() in ("apply", "overwrite", "yes", "y", "ya")


def _barge_ship_total(run, dd, c):
    """Sum of ACTUAL CAPACITY of the SIs in the latest barge state whose FINISHDATE is dd, for contractor c."""
    tot = 0.0
    for r in run.barge_state.values():
        if as_date(r.get("FINISHDATE")) != dd:
            continue
        lab = str(r.get("CONTRACTOR") or "").strip()
        if (run.cmap(lab) or lab) != c:
            continue
        tot += fnum(r.get("ACTUAL CAPACITY"))
    return round(tot, 4)


def _ship_master_rows(run, dd, c):
    """Rows of tblRAWSHIP that are really in the master for (date, contractor). Rows this run staged are
    copied into run.m by run.add, so a date staged by this run counts only when the master had it before."""
    T = "tblRAWSHIP"
    staged_dates = {as_date(r.get("DATE")) for r in run.stage.get(T, [])}
    if dd in staged_dates and (T, dd) not in run.preexisting:
        return []
    return [r for r in run.m.rows(T) if as_date(r.get("DATE")) == dd and r.get("CONTRACTOR") == c
            and (not r.get("SITE") or str(r.get("SITE")).strip() == str(run.cfg["site"]).strip())]


def _ship_entry(run, dd, c):
    for e in run.ship_updates:
        if e["DATE"] == dd and e["CONTRACTOR"] == c:
            return e
    return None


def _touch_cause(t):
    old, new = t["old"] or {}, t["new"]
    bits = []
    if t["old"] is None:
        bits.append(f"new SI, FINISH {_show(new.get('FINISHDATE'))}, ACTUAL {_show(new.get('ACTUAL CAPACITY'))}")
    else:
        for col in ("FINISHDATE", "ACTUAL CAPACITY", "CONTRACTOR"):
            if not _barge_same(old.get(col), new.get(col)):
                bits.append(f"{col} {_show(old.get(col))} -> {_show(new.get(col))}")
    return f"SI {t['si']} ({t['report']:%d-%b} report): " + ", ".join(bits)


def t_ship_sync(run, p, d):
    """SHIP follows BARGE. DAY per contractor = sum of ACTUAL CAPACITY of the SIs whose FINISHDATE is that day
    (the same rule as t_ship), but worked out from the LATEST barge state, so a barge that changes for an earlier
    day (late finish, finish date moved, actual capacity corrected) also corrects the SHIP row of that day.

      * the day is staged in this run   -> the staged row is corrected (WARN)
      * the day is already in the master -> a Ship update is listed (WARN); DECISION defaults to Apply = overwrite
      * the day has no SHIP row          -> skipped (INFO), never created
    Also lists, as 'Old mismatch' (DECISION defaults to Leave, config ship_sync.stale_default), days of the last
    ship_sync.scan_months_back months where SHIP differs from the barge list although no barge changed today."""
    cfg = run.cfg.get("ship_sync") or {}
    T = "tblRAWSHIP"
    if not cfg.get("enabled") or T not in run.m.tables or not hasattr(run, "barge_state"):
        return
    ctrs = list(run.cfg.get("ship_contractors", []))
    site = run.cfg["site"]
    touched = run.barge_touched[run._ship_seen:]
    run._ship_seen = len(run.barge_touched)
    affected = {}        # date -> [cause, ...]
    for t in touched:
        old, new = t["old"] or {}, t["new"]
        if t["old"] is not None and all(_barge_same(old.get(c), new.get(c)) for c in ("FINISHDATE", "ACTUAL CAPACITY", "CONTRACTOR")):
            continue          # status, vessel or grade only: SHIP does not change
        cause = _touch_cause(t)
        for col in ("FINISHDATE",):
            for src in (old, new):
                dd = as_date(src.get(col))
                if dd and cause not in affected.setdefault(dd, []):
                    affected[dd].append(cause)
        lab = str(new.get("CONTRACTOR") or "").strip()
        if lab and (run.cmap(lab) or lab) not in ctrs:
            run.L("INFO", d, T, "ship-sync", f"SI {t['si']}: contractor '{lab}' has no SHIP rows in this master - ignored")
    staged = run.stage.get(T, [])
    n_stage = n_upd = n_same = n_skip = 0
    for dd in sorted(affected):
        causes = "; ".join(affected[dd][:3]) + (f"; +{len(affected[dd]) - 3} more" if len(affected[dd]) > 3 else "")
        for c in ctrs:
            run._ship_checked.add((dd, c))
            new = clean_num(_barge_ship_total(run, dd, c))
            srows = [r for r in staged if as_date(r.get("DATE")) == dd and r.get("CONTRACTOR") == c]
            mrows = _ship_master_rows(run, dd, c)
            ent = _ship_entry(run, dd, c)
            if not srows and not mrows:
                if ent is not None:
                    run.ship_updates.remove(ent)
                n_skip += 1
                if new:
                    run.L("INFO", dd, T, "ship-sync", f"SHIP {dd:%d-%b} {c}: barge list gives {new:,.2f} but the master has no SHIP row for "
                          f"that day - skipped, not created. ({causes})", new, None)
                continue
            for r in srows:
                if abs(fnum(r.get("DAY")) - fnum(new)) > SHIP_TOL:
                    run.L("WARN", dd, T, "ship-sync", f"SHIP {dd:%d-%b} {c}: row staged in this run changed {fnum(r.get('DAY')):,.2f} -> "
                          f"{fnum(new):,.2f} to match the barge list. ({causes})", fnum(new), fnum(r.get("DAY")))
                    r["DAY"] = new
                    n_stage += 1
            if len(mrows) > 1:
                run.L("WARN", dd, T, "ship-sync", f"SHIP {dd:%d-%b} {c}: {len(mrows)} rows in the master - ambiguous, not changed. ({causes})")
                continue
            if not mrows:
                continue
            old = mrows[0].get("DAY")
            if abs(fnum(old) - fnum(new)) <= SHIP_TOL:
                if ent is not None:
                    run.ship_updates.remove(ent)
                n_same += 1
                continue
            if ent is None:
                ent = {"DECISION": "Apply", "KIND": KIND_BARGE, "DATE": dd, "SITE": site, "CONTRACTOR": c,
                       "OLD DAY": clean_num(fnum(old)), "CAUSED BY": ""}
                run.ship_updates.append(ent)
            ent.update({"KIND": KIND_BARGE, "DECISION": "Apply", "NEW DAY": new})
            ent["DIFF"] = clean_num(round(fnum(new) - fnum(ent["OLD DAY"]), 4))
            ent["CAUSED BY"] = causes
            ent["NOTE"] = "overwrites the master value (default); set DECISION to Leave to keep it"
            n_upd += 1
            run.L("WARN", dd, T, "ship-sync", f"SHIP {dd:%d-%b} {c}: master {fnum(ent['OLD DAY']):,.2f} will be overwritten with "
                  f"{fnum(new):,.2f} (barge list). ({causes}) Set Leave in the Ship updates tab to keep the master value.",
                  fnum(new), fnum(ent["OLD DAY"]))
    if touched:
        run.L("INFO", d, T, "ship-sync", f"SHIP follows BARGE ({d:%d-%b}): {len(touched)} barge SI written, {len(affected)} day(s) affected - "
              f"{n_upd} master value(s) to overwrite, {n_stage} staged row(s) corrected, {n_same} already equal, {n_skip} without a SHIP row")
    _ship_stale_scan(run, d, ctrs, site, cfg)


def _ship_stale_scan(run, d, ctrs, site, cfg):
    """Old mismatches: master SHIP differs from the barge list on days no barge change touched in this run."""
    T = "tblRAWSHIP"
    run.ship_updates[:] = [e for e in run.ship_updates if e["KIND"] != KIND_STALE]
    months = int(cfg.get("scan_months_back", 1))
    if months < 0:
        return
    y, m = d.year, d.month - months
    while m < 1:
        m, y = m + 12, y - 1
    start = dt.date(y, m, 1)
    staged_dates = {as_date(r.get("DATE")) for r in run.stage.get(T, [])}
    default = "Apply" if is_apply(cfg.get("stale_default", "Leave")) else "Leave"
    seen = {}
    for r in run.m.rows(T):
        dd = as_date(r.get("DATE"))
        if dd is None or not (start <= dd <= d) or r.get("CONTRACTOR") not in ctrs:
            continue
        if r.get("SITE") and str(r.get("SITE")).strip() != str(site).strip():
            continue
        if (dd in staged_dates and (T, dd) not in run.preexisting) or (dd, r["CONTRACTOR"]) in run._ship_checked:
            continue
        seen.setdefault((dd, r["CONTRACTOR"]), []).append(r)
    for (dd, c), rows in sorted(seen.items()):
        if len(rows) != 1:
            continue
        old, new = rows[0].get("DAY"), clean_num(_barge_ship_total(run, dd, c))
        if abs(fnum(old) - fnum(new)) <= SHIP_TOL:
            continue
        run.ship_updates.append({"DECISION": default, "KIND": KIND_STALE, "DATE": dd, "SITE": site, "CONTRACTOR": c,
                                 "OLD DAY": clean_num(fnum(old)), "NEW DAY": new,
                                 "DIFF": clean_num(round(fnum(new) - fnum(old), 4)),
                                 "CAUSED BY": "no barge changed in this run",
                                 "NOTE": "master SHIP already differed from the barge list; default " + default})
    n = sum(1 for e in run.ship_updates if e["KIND"] == KIND_STALE)
    if n != getattr(run, "_ship_stale_n", None):
        run._ship_stale_n = n
        if n:
            run.L("WARN", d, T, "ship-sync", f"{n} older day(s) since {start:%d-%b-%Y}: master SHIP differs from the barge list although no "
                  f"barge changed in this run. Listed as 'Old mismatch' in the Ship updates tab, default {default}.")



def t_eq(run, p, d):
    T = "tblRAWEQ"
    if "equipment" not in p:
        return
    hist = run.m.contractors(T)
    for label, acts in p["equipment"].items():
        c = run.cmap(label)
        if not c:
            run.L("ERROR", d, T, "contractor", f"equipment block '{label}' not in contractor_map")
            continue
        all_dash = all(a.get("_dash") for a in acts.values())
        if all_dash and c not in hist:
            run.L("INFO", d, T, "skip", f"{c}: all '-' and no history - row not staged")
            continue
        r = base_row(run, T, d, c)
        for code, vals in acts.items():
            if code == "P":
                continue
            for k, v in vals.items():
                if k.startswith("_"):
                    continue
                col = f"{code}-{k}"
                if col in r:
                    r[col] = clean_num(v)
        # population check
        pop = acts.get("P", {})
        for k, pv in pop.items():
            if k.startswith("_") or pv is None:
                continue
            s = sum((acts.get(a, {}).get(k) or 0) for a in ("OP", "S", "B"))
            if abs(s - pv) > 0.01:
                run.L("WARN", d, T, "population", f"{c} {k}: OP+S+B {s:g} <> POPULATION {pv:g}", s, pv)
        if run.vocab_ok(d, T, "CONTRACTOR", c, "tblIDCONTRACTOR"):
            run.add(T, r, d)


def t_up(run, p, d):
    T = "tblRAWUP"
    if "unit_perf" not in p:
        return
    for hdr, rec in p["unit_perf"].items():
        c = run.cmap(hdr)
        r = base_row(run, T, d, c)
        for unit, vals in rec["units"].items():
            if all((v or 0) == 0 for v in vals.values()):
                continue  # no unit of this class -> leave blank (0 would drag averages down)
            for k, v in vals.items():
                r[f"{unit}-{k}"] = clean_num(v)
                if v is not None and not (0 <= v <= 100):
                    run.L("WARN", d, T, "range", f"{c} {unit}-{k} = {v:g}% is outside 0-100 (typo in the site report?) - "
                          "staged as printed: correct it in the staging sheet before import", v, None)
        run.add(T, r, d)


def t_wewh(run, p, d):
    T = "tblRAWWEWH"
    w = p.get("weather")
    up = p.get("unit_perf", {})
    labels = set()
    if w:
        labels |= set(w.get("EWH", {})) | set(w.get("RAIN", {}))
    for hdr in up:
        labels.add(hdr.replace("PT ", ""))
    for lab in sorted(labels):
        c = run.cmap(lab)
        ewh = (w or {}).get("EWH", {}).get(lab, {}).get(d)
        rain = (w or {}).get("RAIN", {}).get(lab, {}).get(d)
        ewh_up = up.get(c, {}).get("EWH")
        if ewh is None:
            ewh = ewh_up
        elif ewh_up is not None and abs(ewh - ewh_up) > 0.01:
            run.L("WARN", d, T, "ewh", f"{c}: EWH weather block {ewh} vs unit performance {ewh_up}", ewh, ewh_up)
        if ewh is None and rain is None:
            continue
        r = base_row(run, T, d, c)
        r["EWH"] = clean_num(ewh)
        r["RAIN HOUR"] = clean_num(rain)
        run.add(T, r, d)
        # earlier days shown in the weather window vs master
        for key, col in (("EWH", "EWH"), ("RAIN", "RAIN HOUR")):
            for dd, v in (w or {}).get(key, {}).get(lab, {}).items():
                if dd >= d or v is None:
                    continue
                mrows = [x for x in run.m.rows_on(T, dd) if x.get("CONTRACTOR") == c]
                if not mrows:
                    run.L("WARN", d, T, "window", f"{c} {dd}: PDF {col} {v} but master has no row for that date", v, None)
                    continue
                mv = sum(fnum(x.get(col)) for x in mrows)
                if abs(mv - v) > 0.01:
                    run.L("WARN", d, T, "window", f"{c} {dd}: PDF {col} {v} vs master {mv}", v, mv)
    run.L("INFO", d, T, "note", "Delay columns (SLIPPERY ... OTHERS) are not in the PDF - left blank")


def t_fuel(run, p, d):
    T = "tblRAWFUEL"
    if "fuel" not in p:
        return
    m0, _ = period_starts(d)
    up = p.get("unit_perf", {})
    for lab, rec in p["fuel"].items():
        c = run.cmap(lab)
        day = rec.get("DAY") or 0
        prev = [x for x in run.m.rows(T) if x.get("CONTRACTOR") == c and as_date(x.get("DATE")) and as_date(x.get("DATE")) < d]
        prev_stock = 0.0
        if prev:
            last = max(prev, key=lambda x: as_date(x["DATE"]))
            prev_stock = fnum(last.get("_STOCK", last.get("STOCK")))
        r = base_row(run, T, d, c)
        r["DAY"] = clean_num(day)
        if rec.get("STOCK") is not None:
            add = rec["STOCK"] - (prev_stock - day)
            add = 0 if abs(add) <= run.tol(rec["STOCK"]) else add
            r["STOCK ADD"] = clean_num(add)
            if add < 0:
                run.L("WARN", d, T, "stock-add", f"{c}: derived STOCK ADD is negative ({add:,.2f}) = PDF stock {rec['STOCK']:,.0f} - (master prev stock {prev_stock:,.0f} - DAY {day:,.0f}). Check master stock chain / physical count adjustment", add, 0)
            elif add > 0 and abs(rec["STOCK"]) < 1e-9:
                run.L("WARN", d, T, "stock-add", f"{c}: PDF stock is exactly 0, derived STOCK ADD {add:,.2f} only covers the shortfall "
                      f"(prev {prev_stock:,.0f} - DAY {day:,.0f}). This may be the site report flooring stock at 0 rather than a real "
                      "receipt - confirm, or blank it in staging", add, 0)
            elif add > 0:
                run.L("INFO", d, T, "stock-add", f"{c}: STOCK ADD {add:,.2f} derived from stock movement (prev {prev_stock:,.0f}, DAY {day:,.0f}, PDF stock {rec['STOCK']:,.0f})")
        run.add(T, r, d)
        if (T, d) not in run.preexisting:
            run.m.data[T][-1]["_STOCK"] = rec.get("STOCK")
        # cross-checks
        ufuel = up.get(c, {}).get("FUEL")
        if ufuel is not None and abs(ufuel - day) > 0.5:
            run.L("WARN", d, T, "fuel-vs-up", f"{c}: fuel table DAY {day} vs unit performance FUEL {ufuel}", day, ufuel)
        run.recon(d, T, f"{c} fuel MONTH", rec.get("MONTH"), run.m.sum_between(T, "DAY", m0, d, CONTRACTOR=c) + day,
                  note="calendar-month sum; master/PDF MTD may not reset on day 1")


def t_mp(run, p, d):
    T = "tblRAWMP"
    if "manpower" not in p:
        return
    hist = run.m.contractors(T)
    for lab, rec in p["manpower"].items():
        c = run.cmap(lab)
        if not c:
            run.L("ERROR", d, T, "contractor", f"manpower company '{lab}' not in contractor_map")
            continue
        if c not in hist and not any((v or 0) for v in rec.values()):
            run.L("INFO", d, T, "skip", f"{c}: all zero and no history - row not staged")
            continue
        r = base_row(run, T, d, c, shift=False)
        for k in ("ADD", "RESIGN", "MANAGER", "SPT", "SPV", "DRIVER", "OPERATOR", "ETC"):
            r[k] = clean_num(rec.get(k) or 0)
        tot = sum((rec.get(k) or 0) for k in ("MANAGER", "SPT", "SPV", "DRIVER", "OPERATOR", "ETC"))
        if rec.get("TOTAL") is not None and abs(tot - rec["TOTAL"]) > 0.01:
            run.L("WARN", d, T, "total", f"{c}: MANAGER..ETC {tot:g} <> TOTAL {rec['TOTAL']:g}", tot, rec["TOTAL"])
        if run.vocab_ok(d, T, "CONTRACTOR", c, "tblIDCONTRACTOR"):
            run.add(T, r, d)


def t_lab(run, p, d):
    T = "tblRAWLAB"
    if "lab" not in p:
        return
    lab = p["lab"]
    c = run.cfg["lab_contractor"]
    r = base_row(run, T, d, c, shift=False)
    day = lab["by_period"].get("DAY", {})
    for rl, pre in run.cfg["lab_rows"].items():
        for cl, suf in run.cfg["lab_cols"].items():
            v = day.get(rl, {}).get(cl)
            if f"{pre}-{suf}" in r:
                r[f"{pre}-{suf}"] = clean_num(v if v is not None else 0)
    eq = lab.get("equipment", {})
    for cl, suf in run.cfg["lab_equipment_cols"].items():
        rdy = eq.get("READY", {}).get(cl)
        bd = eq.get("BREAKDOWN", {}).get(cl)
        r[f"R-{suf}"] = clean_num(rdy)
        r[f"B-{suf}"] = clean_num(bd)
        src = run.cfg.get("lab_act_source", "READY").upper()
        r[f"ACT-{suf}"] = clean_num(rdy) if src == "READY" else (clean_num(eq.get("POPULATION", {}).get(cl)) if src == "POPULATION" else None)
    run.add(T, r, d)
    # TOTAL row check
    for cl in run.cfg["lab_cols"]:
        s = sum((day.get(rl, {}).get(cl) or 0) for rl in run.cfg["lab_rows"])
        tv = day.get("TOTAL", {}).get(cl)
        if tv is not None and abs(s - tv) > 0.01:
            run.L("WARN", d, T, "total", f"lab DAY {cl}: rows sum {s:g} <> TOTAL {tv:g}", s, tv)
    # month / year reconciliation (master IM/IY... are formulas -> recompute from daily inputs)
    m0, y0 = period_starts(d)
    for per, start in (("MONTH", m0), ("YEAR", y0)):
        pv = lab["by_period"].get(per, {})
        for rl, pre in run.cfg["lab_rows"].items():
            for cl, suf in run.cfg["lab_cols"].items():
                col = f"{pre}-{suf}"
                run.recon(d, T, f"lab {rl} {cl} {per}", pv.get(rl, {}).get(cl),
                          run.m.sum_between(T, col, start, d) + (day.get(rl, {}).get(cl) or 0))
    if "AY-QC" in run.m.tables[T]["input"]:
        run.L("WARN", d, T, "table-defect", "AY-QC is an INPUT column in tblRAWLAB (its formula is missing), so yearly QC assay will not compute - not filled by this tool")
    run.L("INFO", d, T, "note", f"ACT-* filled from {run.cfg.get('lab_act_source')} (PDF has no ACT row). P-* = ACT+B+R in the master.")


def t_cons(run, p, d):
    T = "tblRAWCONS"
    if "construction" not in p:
        return
    hist = {}
    for r in sorted(run.m.rows(T), key=lambda r: as_date(r.get("DATE")) or dt.date.min):
        if (as_date(r.get("DATE")) or dt.date.min) >= d:
            continue
        if r.get("CONSTRUCTION ITEM"):
            hist[norm(r["CONSTRUCTION ITEM"])] = r
    auto = {x.upper() for x in run.cfg["cons_auto_remarks"]}
    seen = set()
    for it in p["construction"]:
        key = norm(it["project"])
        h = hist.get(key)
        if h is None:
            close = difflib.get_close_matches(key, list(hist), n=1, cutoff=0.85)
            h = hist.get(close[0]) if close else None
        r = base_row(run, T, d)
        ov = {norm(k): v for k, v in run.cfg.get("cons_item_overrides", {}).items()}.get(key)
        if ov and not h:
            h = {"CONSTRUCTION ITEM": it["project"], **ov}
        if h:
            seen.add(norm(h["CONSTRUCTION ITEM"]))
            r["CONSTRUCTION ITEM"] = h["CONSTRUCTION ITEM"]
            r["AREA"] = h.get("AREA")
            r["CONSCATEGORY"] = h.get("CONSCATEGORY")
            if fnum(it["progress"]) + 1e-9 < fnum(h.get("PROGRESS")):
                run.L("WARN", d, T, "progress", f"'{h['CONSTRUCTION ITEM']}' progress went down {h.get('PROGRESS')} -> {it['progress']}", it["progress"], h.get("PROGRESS"))
        else:
            r["CONSTRUCTION ITEM"] = it["project"]
            r["AREA"] = it["project"]
            run.L("WARN", d, T, "new-item", f"'{it['project']}' not in history - AREA set to item name, CONSCATEGORY blank: fill in staging before import")
        r["PROGRESS"] = clean_num(it["progress"])
        rem = (it.get("remark") or "").strip()
        if run.cfg.get("cons_remark_mode", "pdf") == "dash" or not rem or rem.upper() in auto:
            r["REMARK"] = "-"
        else:
            r["REMARK"] = rem
        if not r.get("CONSCATEGORY"):
            run.L("WARN", d, T, "category", f"'{r['CONSTRUCTION ITEM']}' staged with blank CONSCATEGORY (and AREA '{r['AREA']}') - "
                  "fill in staging, or add it to config cons_item_overrides")
        run.vocab_ok(d, T, "CONSCATEGORY", r["CONSCATEGORY"], "tblCONSCATEGORY")
        run.add(T, r, d)


def t_explo(run, p, d):
    """Staged to REVIEW_tblRAWEXPLO only (not imported) until the mapping is confirmed."""
    T = "tblRAWEXPLO"
    ex = p.get("exploration")
    if not ex:
        return

    def owner(name):
        k = norm(name.replace("&", "AND"))
        for pre, c in run.cfg["explo_company_map"].items():
            if k.startswith(pre):
                return c
        return None
    recs = defaultdict(dict)
    for name, v in ex.get("survey", {}).items():
        recs[owner(name) or name].update({k: v.get(k) for k in ("SO-PLAN", "SO-ACTUAL", "PUH-PLAN", "PUH-ACTUAL", "REMARK2")})
        recs[owner(name) or name]["_company"] = name
    for name, v in ex.get("drilling", {}).items():
        recs[owner(name) or name].update({k: v.get(k) for k in ("P-DH", "P-SAMPLE", "P-DEPTH", "A-DH", "A-SAMPLE", "A-DEPTH")})
    for c, v in recs.items():
        r = base_row(run, T, d, c)
        for k, val in v.items():
            if k in r:
                r[k] = clean_num(val) if isinstance(val, float) else (val or None)
        r["_PDF COMPANY"] = v.get("_company")
        run.review[T].append(r)
    run.L("INFO", d, T, "review", "exploration staged on REVIEW_tblRAWEXPLO (not imported): confirm company->contractor mapping, then rename the sheet to tblRAWEXPLO")


def t_env(run, p, d):
    for e in p.get("environment", []):
        run.unmapped["ENVIRONMENT"].append({"DATE": dt.datetime.combine(d, dt.time()), **e})
    if p.get("environment"):
        run.L("INFO", d, "-", "unmapped", "Environment (SEDPOND TSS/PH/DEBIT) has no table in the master - kept on _UNMAPPED only")


# ---- plan check (tblCALENDAR is read, never written) ---------------------------------------
SOFT_SECTIONS = {"mining_plan"}


def _plan_num(v):
    if v is None or v == "":
        return None
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def _plan_fmt(v):
    return "(blank)" if v is None else f"{v:,.2f}"


def t_plan(run, p, d):
    """Compare the plan printed in the report with tblCALENDAR and with the previous report.
    PRODUCTION PLAN rows (DAY/WEEK/MONTH/YEAR)  ->  {S,OB,L,M,H,Q}-{DAY,WTD,MTD,YTD}
    SALES TARGET SALE (WEEK/MONTH/YEAR)         ->  ST-{WTD,MTD,YTD}   (ST-DAY in tblCALENDAR = ST-WTD/7)
    Only WARN / INFO items; nothing is staged."""
    pc = run.cfg.get("plan_check") or {}
    if not pc.get("enabled", True):
        return
    T = pc.get("calendar_table", "tblCALENDAR")
    tol = float(pc.get("tolerance_abs", 0.5))
    items = {}  # (contractor, item, period) -> (pdf value, calendar column)
    mp = p.get("mining_plan") or {}
    for row, code in pc.get("production_rows", {}).items():
        if row not in mp:
            continue
        for per, cper in pc.get("production_periods", {}).items():
            for con in pc.get("contractors", []):
                items[(con, row.replace("PLAN ", ""), per)] = (_plan_num((mp[row].get(per) or {}).get(con)), f"{code}-{cper}")
    sales = p.get("sales") or {}
    for per, cper in pc.get("sale_periods", {}).items():
        blk = (sales.get(per) or {}).get(pc.get("sale_row", "TARGET SALE (WMT)"))
        if blk is None:
            continue
        for con in pc.get("contractors", []):
            items[(con, "TARGET SALE", per)] = (_plan_num(blk.get(con)), f"{pc.get('sale_prefix', 'ST')}-{cper}")
    if not items:
        run.L("WARN", d, T, "plan", "no PLAN or TARGET SALE values read from the report - plan not checked")
        return

    def label(k):
        con, item, per = k
        return f"{item} {per.lower()} {con.replace('PT ', '')}"

    # 1. change in the report's own plan since the previous report of this run (reports run in date order)
    prev = getattr(run, "plan_prev", None)
    snap = {k: v for k, (v, _) in items.items()}
    if prev:
        pd_, pv = prev
        ch = [(k, pv[k], snap[k]) for k in snap if k in pv and
              not (pv[k] is None and snap[k] is None) and
              (pv[k] is None or snap[k] is None or abs(pv[k] - snap[k]) > tol)]
        for k, a, b in ch:
            run.plan_changes.append({"date": d, "previous_report": pd_, "contractor": k[0], "item": k[1], "period": k[2],
                                     "previous": a, "new": b, "diff": None if a is None or b is None else round(b - a, 2)})
        if ch:
            run.L("WARN", d, T, "plan-change", f"the plan in this report changed since the {pd_:%d-%b} report: "
                  + "; ".join(f"{label(k)} {_plan_fmt(a)} -> {_plan_fmt(b)}" for k, a, b in ch))
    run.plan_prev = (d, snap)

    # 2. difference from tblCALENDAR for the report date
    if not hasattr(run, "_cal_idx"):
        run._cal_idx = {(str(r.get("CONTRACTOR") or "").strip().upper(), as_date(r.get("DATE"))): r for r in run.m.rows(T)}
    diffs, missing, checked = [], set(), 0
    for k, (v, col) in sorted(items.items()):
        r = run._cal_idx.get((k[0].upper(), d))
        if r is None:
            missing.add(k[0])
            continue
        c = _plan_num(r.get(col))
        if v is None and c is None:
            continue
        checked += 1
        if v is None or c is None or abs(v - c) > tol:
            diffs.append((k, col, v, c))
    if missing:
        run.L("WARN", d, T, "plan-calendar", f"no {T} row for {', '.join(sorted(missing))} on {d:%d-%b-%Y} - plan not compared")
    sig = tuple((k, col, None if v is None else round(v, 2), None if c is None else round(c, 2)) for k, col, v, c in diffs)
    last = getattr(run, "plan_cal_last", None)
    if diffs and last and last[1] == sig:
        run.L("INFO", d, T, "plan-calendar", f"same {len(diffs)} plan difference(s) from {T} as the {last[0]:%d-%b} report")
    elif diffs:
        seen = set(last[1]) if last else set()
        for (k, col, v, c), sg in zip(diffs, sig):
            if sg in seen:  # same difference already listed for an earlier report
                continue
            run.plan_cal.append({"date": d, "contractor": k[0], "item": k[1], "period": k[2], "column": col, "pdf": v,
                                 "calendar": c, "diff": None if v is None or c is None else round(v - c, 2),
                                 "pct": None if v is None or not c else round((v - c) / c * 100, 1)})
        run.L("WARN", d, T, "plan-calendar", f"{len(diffs)} plan value(s) in the report differ from {T}: "
              + "; ".join(f"{label(k)} {_plan_fmt(v)} vs {col} {_plan_fmt(c)}" for k, col, v, c in diffs)
              + f". The app does not change {T} - update it by hand if the report's plan is the approved one")
    elif checked:
        run.L("INFO", d, T, "plan-calendar", f"plan in the report matches {T} ({checked} values)")
    run.plan_cal_last = (d, sig)


TRANSFORMS = [t_hse, t_hazard, t_mng, t_stock, t_haul, t_ship, t_barge, t_ship_sync, t_eq, t_up, t_wewh, t_fuel, t_mp, t_lab, t_cons, t_explo, t_env,
              t_plan]


def process_pdf(run, pdf_path, ocr=True):
    parsed, errors = parse_daily_report(pdf_path, run.cfg, ocr=ocr)
    d = parsed["meta"]["report_date"]
    for sec, msg in errors:
        # the plan is only checked, never loaded: a plan section the parser cannot read must not block the load
        run.L("WARN" if sec in SOFT_SECTIONS else "ERROR", d, sec, "parse", msg)
    if norm(run.cfg["site"]).replace("PT", "") not in norm(parsed["meta"].get("site_text") or "").replace("PT", ""):
        run.L("WARN", d, "-", "site", f"PDF header site '{parsed['meta'].get('site_text')}' does not look like {run.cfg['site']}")
    # existing data for this date
    have = []
    for tn in STAGE_ORDER:
        if tn == "tblRAWBARGE":
            continue
        n = len(run.m.rows_on(tn, d))
        if n:
            run.preexisting.add((tn, d))
            have.append(f"{tn.replace('tblRAW', '')} {n}")
    if have:
        run.L("WARN", d, "(all)", "exists", f"the master already has rows for {d} in {len(have)} table(s) ({', '.join(have)}). "
              "Skip mode leaves them as they are; Replace mode deletes and reloads them")
    for fn in TRANSFORMS:
        try:
            fn(run, parsed, d)
        except Exception as e:  # one table failing must not kill the others
            run.L("ERROR", d, fn.__name__, "transform", f"{type(e).__name__}: {e}")
    h = hashlib.sha256(open(pdf_path, "rb").read()).hexdigest()[:16]
    run.meta.append({"report_date": d, "pdf": os.path.basename(pdf_path), "sha256_16": h,
                     "parse_errors": len(errors), "note": parsed.get("note") or ""})
    return parsed


# ==========================================================================
# staging workbook
# ==========================================================================
HDR_FILL = PatternFill("solid", fgColor="0B3D91")
HDR_FONT = Font(color="FFFFFF", bold=True)
SEV_FILL = {"ERROR": PatternFill("solid", fgColor="F8D7DA"), "WARN": PatternFill("solid", fgColor="FFF3CD"),
            "RECON": PatternFill("solid", fgColor="EDEDED"), "INFO": PatternFill("solid", fgColor="E7F1FF")}


def _write_sheet(ws, header, rows):
    ws.append(header)
    for c in ws[1]:
        c.fill, c.font = HDR_FILL, HDR_FONT
        c.alignment = Alignment(wrap_text=True, vertical="center")
    for r in rows:
        ws.append([r.get(h) for h in header])
    for i, h in enumerate(header, 1):
        L = get_column_letter(i)
        width = max([len(str(h))] + [len(str(r.get(h))) for r in rows[:200] if r.get(h) is not None])
        ws.column_dimensions[L].width = min(max(9, width + 2), 60)
        for cell in ws[L][1:]:
            if isinstance(cell.value, (dt.datetime, dt.date)):
                cell.number_format = "dd-mmm-yyyy" if h not in ("INPUT DATE",) else "dd-mmm-yyyy hh:mm"
    ws.freeze_panes = "A2"


HAZARD_UPDATE_COLS = ["ACTION", "ID", "MASTER DATE", "MASTER IDENTIFIED HAZARD", "MATCHED BY", "STATUS NOW",
                      "NEW REPAIR STATUS", "NEW REMARKS", "SOURCE"]


def review_columns(rows):
    cols = []
    for r in rows:
        for k in r:
            if k not in cols:
                cols.append(k)
    return cols


def write_staging(run, out_path, master_path, generator="local app"):
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = "_README"
    code = run.cfg.get("site_code", "WKM")
    lines = [
        f"{code} Daily Report -> Master Data staging file ({run.cfg.get('site', '')})",
        "",
        "1. Review _LOG (ERROR = not staged, WARN = staged but check, RECON = PDF month/year total differs from",
        "   master history + today (data gap or site-report difference, does not block import), INFO = note).",
        "2. Sheets named tblRAW... are imported by the macro ImportDailyReport in the master workbook.",
        "   Columns = the INPUT columns of that Excel table. Calculated columns are left to Excel.",
        "3. Sheets named REVIEW_... are NOT imported. Rename to the table name to include them.",
        "4. You may correct values directly in this file before importing.",
        "5. _BARGE_DIFF shows how each barge SI will be added or updated; _PLAN_* sheets show the plan check.",
        "   _SHIP_UPDATES lists SHIP days that follow a barge change (DECISION Apply = overwrite, Leave = keep the master value).",
        "6. To load: open the local Daily Report ETL app, step 2 -> Load a staging file, then step 4.",
        "",
        f"Generated {dt.datetime.now():%Y-%m-%d %H:%M} by dr_to_master.py (parser {PARSER_VERSION})",
        f"Master read: {os.path.basename(master_path)}",
    ]
    for ln in lines:
        ws.append([ln])
    ws.column_dimensions["A"].width = 110
    ws["A1"].font = Font(bold=True, size=13, color="0B3D91")

    meta = wb.create_sheet("_META")
    _write_sheet(meta, ["report_date", "pdf", "sha256_16", "parse_errors", "note"],
                 [{**m, "report_date": dt.datetime.combine(m["report_date"], dt.time())} for m in run.meta])
    meta.append([])
    meta.append(["site", run.cfg["site"]])
    meta.append(["parser", PARSER_VERSION])
    meta.append(["generator", generator])
    meta.append(["master_file", os.path.basename(master_path or "")])
    meta.append(["generated", dt.datetime.now().replace(microsecond=0)])

    lg = wb.create_sheet("_LOG")
    order = {"ERROR": 0, "WARN": 1, "RECON": 2, "INFO": 3}
    logs = sorted(run.log, key=lambda x: (x["date"] or dt.date.min, order[x["severity"]], x["table"]))
    _write_sheet(lg, ["severity", "date", "table", "check", "message", "pdf_value", "master_value", "diff"],
                 [{**x, "date": dt.datetime.combine(x["date"], dt.time()) if x["date"] else None} for x in logs])
    for row in lg.iter_rows(min_row=2):
        f = SEV_FILL.get(row[0].value)
        if f:
            for c in row:
                c.fill = f
    lg.column_dimensions["E"].width = 120

    stamp = dt.datetime.now().replace(microsecond=0)
    for tn in STAGE_ORDER:
        rows = run.stage.get(tn, [])
        if not rows:
            continue
        header = list(run.m.tables[tn]["input"])
        for r in rows:
            if "INPUT DATE" in r:
                r["INPUT DATE"] = stamp
        _write_sheet(wb.create_sheet(tn), header, rows)
        if tn == "tblRAWBARGE":
            sh = wb[tn]
            for c in sh["A"][1:]:
                c.number_format = "@"
    for tn, rows in run.review.items():
        if tn in run.m.tables:
            header = list(run.m.tables[tn]["input"]) + ["_PDF COMPANY"]
        else:   # free-form review block (TMS): columns in first-seen order
            header = review_columns(rows)
        _write_sheet(wb.create_sheet(("REVIEW_" + tn)[:31]), header, rows)
    if getattr(run, "hazard_updates", None):
        _write_sheet(wb.create_sheet("_HAZARD_UPDATES"), HAZARD_UPDATE_COLS, run.hazard_updates)
    if getattr(run, "ship_updates", None):
        _write_sheet(wb.create_sheet("_SHIP_UPDATES"), SHIP_UPDATE_COLS,
                     [{**x, "DATE": dt.datetime.combine(x["DATE"], dt.time())} for x in run.ship_updates])
    if run.plan_changes:
        _write_sheet(wb.create_sheet("_PLAN_CHANGES"),
                     ["date", "previous_report", "contractor", "item", "period", "previous", "new", "diff"],
                     [{**x, "date": dt.datetime.combine(x["date"], dt.time()),
                       "previous_report": dt.datetime.combine(x["previous_report"], dt.time())} for x in run.plan_changes])
    if run.plan_cal:
        _write_sheet(wb.create_sheet("_PLAN_VS_CALENDAR"),
                     ["date", "contractor", "item", "period", "column", "pdf", "calendar", "diff", "pct"],
                     [{**x, "date": dt.datetime.combine(x["date"], dt.time())} for x in run.plan_cal])
    if run.barge_diff:
        _write_sheet(wb.create_sheet("_BARGE_DIFF"), ["date", "SI", "field", "master", "pdf", "action"],
                     [{**x, "date": dt.datetime.combine(x["date"], dt.time())} for x in run.barge_diff])
    for k, rows in run.unmapped.items():
        hdr = list(rows[0].keys())
        _write_sheet(wb.create_sheet("_UNMAPPED_" + k[:20]), hdr, rows)
    wb.save(out_path)


# ==========================================================================
# CLI
# ==========================================================================
def collect_pdfs(args_pdf):
    out = []
    for a in args_pdf:
        if os.path.isdir(a):
            out += sorted(glob.glob(os.path.join(a, "*.pdf")))
        else:
            out += sorted(glob.glob(a)) or [a]
    return out


def main(argv=None):
    ap = argparse.ArgumentParser(description="WKM Daily Report PDF -> Master Data staging workbook")
    ap.add_argument("--pdf", nargs="+", required=True, help="PDF file(s), glob or folder")
    ap.add_argument("--master", required=True, help="Master_Data_Site_WKM.xlsm (read-only)")
    ap.add_argument("--out", help="staging .xlsx (default: staging_WKM_<date>.xlsx next to the first PDF)")
    ap.add_argument("--config", default=os.path.join(os.path.dirname(os.path.abspath(__file__)), "config_wkm.json"))
    ap.add_argument("--no-ocr", action="store_true", help="skip OCR cross-check of pit chart labels")
    ap.add_argument("--json", help="also dump the parsed PDF(s) to this JSON file")
    a = ap.parse_args(argv)

    cfg = json.load(open(a.config, encoding="utf-8"))
    pdfs = collect_pdfs(a.pdf)
    if not pdfs:
        sys.exit("no PDF found")
    print(f"reading master {a.master} ...")
    m = Master(a.master)
    run = Run(cfg, m)
    # process in report-date order so multi-day batches build on each other
    from dr_pdf_parser import Layout, parse_header
    import pdfplumber
    dated = []
    for f in pdfs:
        with pdfplumber.open(f) as pdf:
            dated.append((parse_header(Layout(pdf.pages[0]))["report_date"], f))
    dated.sort()
    dumps = {}
    for d, f in dated:
        print(f"parsing {os.path.basename(f)}  ({d})")
        dumps[str(d)] = process_pdf(run, f, ocr=not a.no_ocr)
    out = a.out or os.path.join(os.path.dirname(os.path.abspath(dated[0][1])),
                                f"staging_WKM_{dated[0][0]}" + (f"_to_{dated[-1][0]}" if len(dated) > 1 else "") + ".xlsx")
    write_staging(run, out, a.master)
    if a.json:
        def keys2str(o):
            if isinstance(o, dict):
                return {str(k): keys2str(v) for k, v in o.items()}
            if isinstance(o, (list, tuple)):
                return [keys2str(v) for v in o]
            return o
        with open(a.json, "w", encoding="utf-8") as fh:
            json.dump(keys2str(dumps), fh, default=str, indent=1, ensure_ascii=False)
    cnt = defaultdict(int)
    for x in run.log:
        cnt[x["severity"]] += 1
    print(f"staging written: {out}")
    print("rows staged: " + ", ".join(f"{k}={len(v)}" for k, v in run.stage.items()))
    print(f"log: ERROR={cnt['ERROR']} WARN={cnt['WARN']} RECON={cnt['RECON']} INFO={cnt['INFO']}")
    for x in run.log:
        if x["severity"] == "ERROR":
            print(f"  ERROR {x['date']} {x['table']}: {x['message']}")
    return run, out


if __name__ == "__main__":
    main()
