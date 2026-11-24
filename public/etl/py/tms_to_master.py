"""Transform + checks: TMS Daily Production Report -> Master Data Site TMS tblRAW* input columns.

Usage
-----
python tms_to_master.py --master "Master Data Site TMS.xlsm" --dpr a.xlsx b.xlsx ... --out staging.xlsx
       [--backfill]            also stage every date after the master's last date up to the earliest report
                               (production-derived tables only: MNG, HAUL, SHIP, WEWH)
       [--dates 2026-08-24:2026-09-30]   stage exactly these dates from the latest DPR (production tables only)

Only input columns are written (columns without a calculatedColumnFormula).
The master is read, never written. Loading is done by the VBA importer or the local app.
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import sys
from collections import defaultdict

import openpyxl
import pandas as pd
from openpyxl.styles import Font, PatternFill
from openpyxl.utils import range_boundaries

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from tms_dpr_parser import DPR, Issue, PARSER_VERSION, parse  # noqa: E402
from tms_hazard_parser import parse_hazard  # noqa: E402
from tms_hazard_stage import stage_hazards  # noqa: E402

GENERATOR = "tms_to_master 1.2.0"
HERE = os.path.dirname(os.path.abspath(__file__))


# ----------------------------------------------------------------------------
# master reader
# ----------------------------------------------------------------------------
class Master:
    def __init__(self, path):
        self.path = path
        self.file_name = os.path.basename(path)
        wbf = openpyxl.load_workbook(path, data_only=False, read_only=False, keep_links=False)
        wbv = openpyxl.load_workbook(path, data_only=True, read_only=False, keep_links=False)
        self.tables, self.inputs, self.columns = {}, {}, {}
        for ws in wbf.worksheets:
            for t in ws.tables.values():
                c1, r1, c2, r2 = range_boundaries(t.ref)
                cols = [c.name for c in t.tableColumns]
                calc = {c.name for c in t.tableColumns if c.calculatedColumnFormula is not None}
                wv = wbv[ws.title]
                rows = [[wv.cell(r, c).value for c in range(c1, c2 + 1)] for r in range(r1 + 1, r2 + 1)]
                df = pd.DataFrame(rows, columns=cols)
                if "DATE" in df.columns:
                    df["_D"] = df["DATE"].map(_day)
                self.tables[t.name] = df
                self.columns[t.name] = cols
                self.inputs[t.name] = [c for c in cols if c not in calc]

    @classmethod
    def from_app_master(cls, am):
        """Build the TMS view from the local app's dr_to_master.Master (no second read of the workbook)."""
        self = cls.__new__(cls)
        self.path = am.path
        self.file_name = os.path.basename(am.path)
        self.tables, self.inputs, self.columns = {}, {}, {}
        for name, t in am.tables.items():
            if name not in am.data:
                continue
            df = pd.DataFrame(am.data[name], columns=t["cols"])
            if "DATE" in df.columns:
                df["_D"] = df["DATE"].map(_day)
            self.tables[name] = df
            self.columns[name] = list(t["cols"])
            self.inputs[name] = list(t["input"])
        return self

    def lookup(self, name):
        df = self.tables.get(name)
        return set() if df is None else {str(v).strip() for v in df.iloc[:, 0].dropna()}

    def site_rows(self, table, site):
        df = self.tables[table]
        return df[(df.get("SITE") == site) & df["_D"].notna()] if "SITE" in df else df

    def dates(self, table, site):
        return set(self.site_rows(table, site)["_D"])


def _day(v):
    """Excel date -> date; a time part (e.g. 17:00 from a tz shift) rounds to the nearest day."""
    if isinstance(v, dt.datetime):
        return (v + dt.timedelta(hours=12)).date()
    if isinstance(v, dt.date):
        return v
    if isinstance(v, (int, float)) and 20000 < v < 80000:
        return (dt.datetime(1899, 12, 30) + dt.timedelta(days=float(v) + 0.5)).date()
    return None


def _between(x, a, b):
    if x is None or pd.isna(x):
        return False
    if isinstance(x, dt.datetime):
        x = x.date()
    return a <= x <= b


def _num_cell(v):
    try:
        return float(str(v).replace(",", "")) if v not in (None, "") else 0.0
    except ValueError:
        return 0.0


def _r(v, n):
    return None if v is None else round(float(v), n)


# ----------------------------------------------------------------------------
# transform
# ----------------------------------------------------------------------------
class Run:
    def __init__(self, cfg, master: Master):
        self.cfg, self.m = cfg, master
        self.rows = defaultdict(list)          # table -> list of dict
        self.review = defaultdict(list)        # sheet -> list of dict
        self.issues: list[Issue] = []
        self.meta = []
        self.plan_rows = []
        self.recon_rows = []
        self.input_time = dt.datetime.now().replace(microsecond=0)

    def add(self, sev, date, table, check, msg, **kw):
        if check in ("vocab", "new-item"):
            key = (table, check, msg)
            if key in getattr(self, "_once", set()):
                return
            self._once = getattr(self, "_once", set()) | {key}
        self.issues.append(Issue(sev, date, table, check, msg, **kw))

    # ---------------- per-date production-derived tables ----------------
    def stage_production_day(self, dpr: DPR, d: dt.date, source_note: str):
        cfg = self.cfg
        pc = cfg["production_columns"]
        p = dpr.production
        day = p[p["DATE"] == d]
        if day.empty:
            self.add("ERROR", d, "tblRAWMNG", "missing-day", f"{dpr.file_name}: no Production rows for {d}")
            return
        vals = {}
        for key, col in pc.items():
            if col not in day.columns:
                vals[key] = None
                continue
            s = pd.to_numeric(day[col], errors="coerce")
            vals[key] = None if s.isna().all() else float(s.fillna(0).sum())
        if all(vals[k] is None for k in ("OB_BCM", "LIM_MINED_T", "TOPSOIL_BCM")):
            self.add("ERROR", d, "tblRAWMNG", "no-cached-values",
                     "Production cells for this date are empty - workbook not recalculated/saved, or day not filled")
            return
        nd = cfg["round_decimals"]
        base = {"DATE": d, "SITE": cfg["site"], "SHIFT": cfg["shift"], "INPUT DATE": self.input_time}

        # --- MNG
        if self._mng_ok(dpr):
            row = dict(base, PIT=cfg["pit_map"].get(cfg["source_pit"], cfg["source_pit"]),
                       CONTRACTOR=cfg["contractor_mining"])
            # 1.1.0 (Site DB -> HO DB workflow, 4 Nov 2026): a map entry is a Production key, or
            # {"src": key, "factor": name} with the factor taken from cfg["factors"] (BCM -> t)
            for tcol, spec in cfg["mng_map"].items():
                if isinstance(spec, dict):
                    row[tcol] = _r((vals.get(spec["src"]) or 0) * cfg["factors"][spec["factor"]], nd)
                elif spec:
                    row[tcol] = _r(vals.get(spec) or 0, nd)
                elif tcol in cfg["mng_zero_fill"]:
                    row[tcol] = 0
            self.rows["tblRAWMNG"].append(row)
            # the site's own tonnage columns should equal BCM x factor; a difference means the site changed its factor
            for bcm_key, t_key, fac in (("LIM_MINED_BCM", "LIM_MINED_T", "limonite"), ("SAP_MINED_BCM", "SAP_MINED_T", "saprolite")):
                b, t = vals.get(bcm_key) or 0, vals.get(t_key) or 0
                f = cfg["factors"][fac]
                if abs(b * f - t) > max(cfg["tolerance_abs"], abs(t) * cfg["tolerance_rel"]):
                    self.add("WARN", d, "tblRAWMNG", "tonnage-factor",
                             f"{fac}: {b:,.2f} BCM x {f} = {b * f:,.2f} t, but the Production sheet shows {t:,.2f} t; "
                             f"the master gets BCM x {f}", src_value=t, master_value=_r(b * f, nd))
            ob, obt = vals.get("OB_BCM") or 0, vals.get("OB_TOTAL_BCM") or 0
            if abs(ob - obt) > cfg["tolerance_abs"]:
                self.add("WARN", d, "tblRAWMNG", "ob-routes",
                         f"OB to waste dump {ob:,.2f} BCM differs from total overburden {obt:,.2f} BCM (another OB route?); "
                         "OB-DAY = waste dump", src_value=ob, master_value=obt)
            ic = vals.get("IRONCAP_BCM") or 0
            if ic:
                self.add("INFO", d, "tblRAWMNG", "ironcap-not-loaded",
                         f"iron cap {ic:,.1f} BCM is not part of OB-DAY (master convention); see REVIEW_PRODUCTION",
                         src_value=ic)

        # --- HAUL / SHIP
        haul = sum(vals.get(k) or 0 for k in cfg["haul_sources"])
        self.rows["tblRAWHAUL"].append(dict(base, CONTRACTOR=cfg["contractor_site"], DAY=_r(haul, nd)))
        ship = sum(vals.get(k) or 0 for k in cfg["ship_sources"])
        self.rows["tblRAWSHIP"].append(dict(base, CONTRACTOR=cfg["contractor_site"], DAY=_r(ship, nd)))

        self.review["REVIEW_PRODUCTION"].append({
            "DATE": d, "SOURCE": source_note,
            "TOPSOIL BCM (S-DAY)": _r(vals.get("TOPSOIL_BCM"), nd), "OB BCM (OB-DAY)": _r(vals.get("OB_BCM"), nd),
            "IRON CAP BCM (not loaded)": _r(vals.get("IRONCAP_BCM"), nd),
            "QUARRY BCM": _r(vals.get("QUARRY_BCM"), nd), "QUARRY T (Q-DAY = BCM x 2.5)": _r((vals.get("QUARRY_BCM") or 0) * cfg["factors"]["quarry"], nd),
            "SOIL BANK->RECLAMATION BCM (not loaded)": _r(vals.get("SOIL_RECLAIM_BCM"), nd),
            "LIMONITE MINED BCM": _r(vals.get("LIM_MINED_BCM"), nd), "SAPROLITE MINED BCM": _r(vals.get("SAP_MINED_BCM"), nd),
            "L-DAY T (BCM x 1.6)": _r((vals.get("LIM_MINED_BCM") or 0) * cfg["factors"]["limonite"], nd),
            "H-DAY T (BCM x 1.55)": _r((vals.get("SAP_MINED_BCM") or 0) * cfg["factors"]["saprolite"], nd),
            "ORE HAULED T (HAUL)": _r(haul, nd), "ORE BARGED T (SHIP)": _r(ship, nd),
            "BARGES COMPLETED": _r(vals.get("BARGE_COMPLETED_N"), 0),
            "BARGE COMPLETED T": _r(vals.get("BARGE_COMPLETED_T"), nd)})
        if vals.get("BARGE_COMPLETED_T"):
            self.review["REVIEW_BARGE"].append({
                "DATE (completed)": d, "BARGES": _r(vals.get("BARGE_COMPLETED_N"), 0),
                "TONNAGE (truck count)": _r(vals.get("BARGE_COMPLETED_T"), nd),
                "NOTE": "No SI / vessel / start date in DPR - key tblRAWBARGE by hand from the shipping list"})
            self.add("INFO", d, "tblRAWBARGE", "barge-completed",
                     f"{int(vals.get('BARGE_COMPLETED_N') or 0)} barge(s) completed, {vals['BARGE_COMPLETED_T']:,.2f} t; "
                     "not staged (no SI/vessel in DPR)")

        # --- WEWH
        self.stage_wewh(dpr, d, base)
        # --- EQ (1.1.0)
        self.stage_eq(dpr, d, base)

    def stage_eq(self, dpr, d, base):
        """tblRAWEQ from the Unit sheet: OP-* = the TE CHECK / support columns in cfg["eq_columns"], MAX of the
        DAY and NIGHT rows (a unit working both shifts is one unit). S-* / B-* are not tracked at site -> 0."""
        cfg = self.cfg
        ec = cfg.get("eq_columns")
        if not ec or dpr.unit is None:
            return
        # each entry: {"col": letter, "expect": {letter: [words that must be in that column's header]}}
        drift = [f"{t}={c['col']} (expected {l}: {ws!r}, found {dpr.unit_headers.get(l, '')!r})"
                 for t, c in ec.items() for l, ws in c["expect"].items()
                 if not all(w.lower() in dpr.unit_headers.get(l, "").lower() for w in ws)]
        if drift:
            if d == dpr.report_date or not getattr(self, "_eq_drift_said", False):
                self.add("ERROR", d, "tblRAWEQ", "header-drift",
                         "Unit sheet columns moved, equipment not staged: " + "; ".join(drift))
                self._eq_drift_said = True
            return
        day = dpr.unit[dpr.unit["DATE"] == d]
        if day.empty:
            self.add("ERROR", d, "tblRAWEQ", "missing-day", "no Unit rows for this date")
            return
        mx = lambda col: float(pd.to_numeric(day[col], errors="coerce").fillna(0).max())
        row = dict(base, CONTRACTOR=cfg["contractor_mining"])
        for tcol, c in ec.items():
            row[tcol] = _r(mx(c["col"]), 3)
        for tcol in cfg.get("eq_zero_fill", []):
            row.setdefault(tcol, 0)
        self.rows["tblRAWEQ"].append(row)
        # TE CHECK is typed by hand at site: compare it with its own breakdown, per shift
        for name, chk in cfg.get("eq_te_checks", {}).items():
            for _, r in day.iterrows():
                te = _num_cell(r.get(chk["te"]))
                parts = sum(_num_cell(r.get(c)) for c in chk["parts"])
                if abs(te - parts) > 0.01:
                    self.add("WARN", d, "tblRAWEQ", "te-check",
                             f"{name} {r['SHIFT']}: TE CHECK {te:g} but {'+'.join(chk['parts'])} = {parts:g} "
                             "(typed by hand at site)", src_value=te, master_value=parts)

    def _mng_ok(self, dpr):
        return not any(i.severity == "ERROR" and i.table == "tblRAWMNG" and i.check == "header-drift"
                       for i in dpr.issues)

    def stage_wewh(self, dpr, d, base):
        cfg = self.cfg
        f = dpr.fleets.get(cfg["sheets"]["wewh_fleet"])
        for name, fl in dpr.fleets.items():
            day = fl[fl["DATE"] == d]
            num = lambda c: float(pd.to_numeric(day[c], errors="coerce").fillna(0).sum()) if c in day else None
            self.review["REVIEW_FLEETS"].append({
                "DATE": d, "FLEET": name.replace("SPO (", "").rstrip(")"),
                "EWH": _r(num("Total EWH"), 3), "MOHH": _r(num("MOHH"), 3), "BREAKDOWN": _r(num("BREAKDOWN / Total"), 3),
                "SPO DELAY": _r(num("SPO DELAY / Total"), 3), "NON-SPO DELAY": _r(num("NON-SPO DELAY / Total"), 3),
                "USED FOR tblRAWWEWH": "yes" if name == cfg["sheets"]["wewh_fleet"] else ""})
        if f is None:
            return
        day = f[f["DATE"] == d]
        if day.empty:
            self.add("ERROR", d, "tblRAWWEWH", "missing-day", "no SPO rows for this date")
            return
        missing = sorted({c for cols in cfg["wewh_map"].values() for c in cols if c not in day.columns})
        if missing:
            self.add("ERROR", d, "tblRAWWEWH", "header-drift", f"SPO columns not found: {missing}; WEWH not staged")
            return
        s = lambda c: float(pd.to_numeric(day[c], errors="coerce").fillna(0).sum())
        row = dict(base, CONTRACTOR=cfg["contractor_site"])
        for tcol, srcs in cfg["wewh_map"].items():
            row[tcol] = _r(sum(s(c) for c in srcs), 3)
        self.rows["tblRAWWEWH"].append(row)
        mohh, bd = s("MOHH"), s("BREAKDOWN / Total")
        delays = sum(v for k, v in row.items() if k in cfg["wewh_map"] and k != "EWH")
        gap = mohh - bd - delays - row["EWH"]
        if abs(gap) > cfg["wewh_balance_tolerance_h"]:
            self.add("WARN", d, "tblRAWWEWH", "hour-balance",
                     f"MOHH {mohh:.2f} - breakdown {bd:.2f} - delays {delays:.2f} - EWH {row['EWH']:.2f} = {gap:+.2f} h "
                     "(site sheet does not balance; values staged as reported)", diff=round(gap, 3))
        if row["EWH"] > 24 or row["EWH"] < 0:
            self.add("WARN", d, "tblRAWWEWH", "ewh-range", f"EWH {row['EWH']} outside 0-24 h", src_value=row["EWH"])

    # ---------------- snapshot tables (report date only) ----------------
    def stage_snapshot(self, dpr: DPR):
        cfg, d, s = self.cfg, dpr.report_date, dpr.summary
        base = {"DATE": d, "SITE": cfg["site"], "SHIFT": cfg["shift"], "INPUT DATE": self.input_time}

        # FUEL
        fu = s.get("FUEL")
        if fu:
            day = fu["DAY_CONSUMED"]
            if day is None:
                self.add("WARN", d, "tblRAWFUEL", "fuel-blank", "daily diesel consumed is blank; staged as 0")
            add = fu["DAY_RECEIVED"] or 0
            self.rows["tblRAWFUEL"].append(dict(base, CONTRACTOR=cfg["contractor_site"], DAY=day or 0, **{"STOCK ADD": add}))
            if fu["REMAINING"] is None:
                self.add("INFO", d, "tblRAWFUEL", "no-remaining-stock",
                         "DPR gives no remaining fuel stock, so STOCK ADD = received (blank -> 0). "
                         "The master STOCK column stays unreconciled (it is already negative)")

        # STOCK
        st = s.get("STOCK") or {}
        if st and not cfg.get("stock_from_dpr", True):
            # 1.2.0 (10 Nov 2026): tblRAWSTOCK comes from the stock dome register (tms_stock.py), per contractor
            # and Ni class. The DPR stockpile block stays as a cross-check only.
            for name, rec in st.items():
                self.review["REVIEW_STOCK"].append({"DATE": d, "STOCKPILE": name, "LIMONITE T": rec["LIM_T"],
                                                    "LIMONITE Ni %": _r(rec["LIM_NI"], 3), "SAPROLITE T": rec["SAP_T"],
                                                    "SAPROLITE Ni %": _r(rec["SAP_NI"], 3),
                                                    "NOTE": "DPR cross-check only; tblRAWSTOCK comes from the stock register"})
            st = {}
        if st:
            row = dict(base, CONTRACTOR=cfg["contractor_site"])
            for name, rec in st.items():
                tgt = cfg["stock_map"].get(name, "UNMAPPED")
                if tgt is None or tgt == "UNMAPPED":
                    self.review["REVIEW_STOCK"].append({"DATE": d, "STOCKPILE": name, "LIMONITE T": rec["LIM_T"],
                                                        "LIMONITE Ni %": _r(rec["LIM_NI"], 3), "SAPROLITE T": rec["SAP_T"],
                                                        "SAPROLITE Ni %": _r(rec["SAP_NI"], 3),
                                                        "NOTE": "no column in tblRAWSTOCK" if tgt is None else "unmapped label"})
                    if tgt == "UNMAPPED":
                        self.add("WARN", d, "tblRAWSTOCK", "unmapped", f"stockpile '{name}' not in stock_map")
                    continue
                row[tgt["tonnage"]] = _r(rec["LIM_T"] or 0, 2)
                row[tgt["ni"]] = _r(rec["LIM_NI"], 3)
                if rec["SAP_T"]:
                    self.add("WARN", d, "tblRAWSTOCK", "saprolite-stock",
                             f"{name} saprolite {rec['SAP_T']} t has no agreed column; not staged")
            self.rows["tblRAWSTOCK"].append(row)

        # CONS
        hist = self.m.site_rows("tblRAWCONS", cfg["site"]).sort_values("_D")
        cats = self.m.lookup("tblCONSCATEGORY")
        for c in s.get("CONS") or []:
            h = hist[hist["CONSTRUCTION ITEM"].astype(str).str.strip().str.lower() == c["ITEM"].lower()]
            area = cat = None
            if len(h):
                last = h.iloc[-1]
                area, cat = last["AREA"], last["CONSCATEGORY"]
                if c["PROGRESS"] is not None and pd.notna(last["PROGRESS"]) and \
                        c["PROGRESS"] * cfg["cons_progress_scale"] + 0.005 < float(last["PROGRESS"]):
                    self.add("WARN", d, "tblRAWCONS", "progress-drop",
                             f"{c['ITEM']}: progress {c['PROGRESS'] * 100:.2f} < last master {float(last['PROGRESS']):.2f}",
                             src_value=c["PROGRESS"] * 100, master_value=float(last["PROGRESS"]))
            else:
                fb = cfg["cons_category_fallback"].get(c["ITEM"])
                area, cat = (fb or {}).get("AREA"), (fb or {}).get("CONSCATEGORY")
                self.add("WARN", d, "tblRAWCONS", "new-item",
                         f"'{c['ITEM']}' has no history: AREA/CONSCATEGORY staged blank (add to cons_category_fallback)")
            if cat and cat not in cats:
                self.add("WARN", d, "tblRAWCONS", "vocab",
                         f"'{c['ITEM']}': category '{cat}' (from history) is not in tblCONSCATEGORY {sorted(cats)}")
            rem = c["KETERANGAN"]
            self.rows["tblRAWCONS"].append({
                "DATE": d, "SITE": cfg["site"], "AREA": area, "CONSTRUCTION ITEM": c["ITEM"],
                "PROGRESS": _r((c["PROGRESS"] or 0) * cfg["cons_progress_scale"], 2),
                "REMARK": str(rem).strip() if rem not in (None, "") else "-",
                "CONSCATEGORY": cat, "INPUT DATE": self.input_time, "MONTH": f"{d:%Y-%m}"})

        for u in s.get("UNITS") or []:
            self.review["REVIEW_UNITS"].append({"DATE": d, **u})
        for k in ("EWH Mining", "EWH Hauling", "EWH Barging", "Rain", "Slippery"):
            pass

    # ---------------- checks ----------------
    def check_after_report_date(self, dpr):
        p = dpr.production
        later = p[p["DATE"] > dpr.report_date]
        cols = [c for c in self.cfg["production_columns"].values() if c in p.columns]
        nz = later[pd.to_numeric(later[cols].stack(), errors="coerce").groupby(level=0).sum() != 0] if len(later) else later
        if len(nz):
            ds = sorted(set(nz["DATE"]))
            self.add("INFO", dpr.report_date, "file", "after-report-date",
                     f"{dpr.file_name}: Production already holds data for {', '.join(map(str, ds))} (after the report date) - ignored here")

    def recon(self, dpr):
        """PDF-style 'totals differ': DPR month/year totals vs master history + this run."""
        cfg, d, s = self.cfg, dpr.report_date, dpr.summary
        tol = lambda a, b: abs(a - b) <= max(cfg["tolerance_abs"], cfg["tolerance_rel"] * abs(b))
        staged = pd.DataFrame(self.rows["tblRAWMNG"])
        hist = self.m.site_rows("tblRAWMNG", cfg["site"])
        staged_dates = set(staged["DATE"]) if len(staged) else set()
        hist = hist[~hist["_D"].isin(staged_dates)]
        checks = [("OB", "OB-DAY", "OB"), ("SOIL", "S-DAY", "TOPSOIL"), ("LIM", "L-DAY", "LIMONITE")]
        # also the DPR's own Production sheet (internal consistency)
        p = dpr.production
        for key, col, label in checks:
            blk = s.get(key)
            if not blk:
                continue
            for per, v in (("MTD", blk["MTD"]), ("YTD", blk["YTD"])):
                if v is None:
                    continue
                start = d.replace(day=1) if per == "MTD" else d.replace(month=1, day=1)
                in_per = lambda x: _between(x, start, d)
                m_sum = float(pd.to_numeric(hist.loc[hist["_D"].map(in_per), col], errors="coerce").fillna(0).sum())
                st_sum = float(staged.loc[staged["DATE"].map(in_per), col].fillna(0).sum()) if len(staged) else 0
                pcol = {"OB": cfg["production_columns"]["OB_BCM"], "SOIL": cfg["production_columns"]["TOPSOIL_BCM"],
                        "LIM": cfg["production_columns"]["LIM_MINED_T"]}[key]
                file_sum = float(pd.to_numeric(p.loc[p["DATE"].map(in_per), pcol], errors="coerce").fillna(0).sum())
                have = set(hist["_D"]) | staged_dates
                prod_days = p.loc[p["DATE"].map(in_per)].copy()
                prod_days["_v"] = pd.to_numeric(prod_days[pcol], errors="coerce").fillna(0)
                active = set(prod_days.groupby("DATE")["_v"].sum().loc[lambda x: x != 0].index)
                miss = sorted(x for x in active if x not in have)
                self.recon_rows.append({"REPORT DATE": d, "ITEM": label, "PERIOD": per, "DPR SUMMARY": round(v, 2),
                                        "DPR PRODUCTION SHEET (to report date)": round(file_sum, 2),
                                        "MASTER HISTORY + STAGED": round(m_sum + st_sum, 2),
                                        "DIFF (DPR - MASTER)": round(v - m_sum - st_sum, 2),
                                        "ACTIVE DAYS MISSING IN MASTER": len(miss)})
                if not tol(v, file_sum):
                    self.add("RECON", d, "tblRAWMNG", f"{label}-{per}-internal",
                             f"DPR summary {per} {label} {v:,.1f} != its own Production sheet up to {d} {file_sum:,.1f} "
                             "(summary likely includes days after the report date)", src_value=v, master_value=file_sum,
                             diff=round(v - file_sum, 2))
                if not tol(v, m_sum + st_sum):
                    extra = (f"; {len(miss)} day(s) with {label.lower()} in the DPR are not in the master "
                             f"(first {miss[0]}, last {miss[-1]})") if miss else ""
                    self.add("RECON", d, "tblRAWMNG", f"{label}-{per}",
                             f"DPR {per} {label} {v:,.1f} vs master history + today {m_sum + st_sum:,.1f}{extra}",
                             src_value=v, master_value=round(m_sum + st_sum, 2), diff=round(v - m_sum - st_sum, 2))
        fu = s.get("FUEL")
        if fu and fu.get("MONTH_CONSUMED") is not None:
            fh = self.m.site_rows("tblRAWFUEL", cfg["site"])
            fs = pd.DataFrame(self.rows["tblRAWFUEL"])
            start = d.replace(day=1)
            fh = fh[~fh["_D"].isin(set(fs["DATE"]) if len(fs) else set())]
            tot = float(pd.to_numeric(fh.loc[fh["_D"].map(lambda x: _between(x, start, d)), "DAY"], errors="coerce").fillna(0).sum())
            tot += float(fs.loc[fs["DATE"].map(lambda x: _between(x, start, d)), "DAY"].sum()) if len(fs) else 0
            v = fu["MONTH_CONSUMED"]
            self.recon_rows.append({"REPORT DATE": d, "ITEM": "FUEL CONSUMED", "PERIOD": "MTD", "DPR SUMMARY": v,
                                    "MASTER HISTORY + STAGED": round(tot, 1), "DIFF (DPR - MASTER)": round(v - tot, 1)})
            if not tol(v, tot):
                self.add("RECON", d, "tblRAWFUEL", "fuel-MTD",
                         f"DPR 'Monthly' fuel consumed {v:,.0f} L vs master October total {tot:,.0f} L "
                         "(the DPR monthly figure does not reset on day 1)", src_value=v, master_value=tot, diff=round(v - tot, 1))

    def plan_check(self, dpr):
        cfg, d = self.cfg, dpr.report_date
        cal = self.m.tables.get("tblCALENDAR")
        if cal is None or dpr.plan_daily is None or dpr.plan_daily.empty:
            self.add("WARN", d, "plan", "plan-read", "plan or tblCALENDAR not readable; plan check skipped")
            return
        c = cal[(cal["_D"] == d) & (cal["SITE"] == cfg["site"])]
        pdy = dpr.plan_daily[dpr.plan_daily["DATE"] == d]
        pm = dpr.plan_monthly[dpr.plan_monthly["MONTH"] == d.replace(day=1)] if dpr.plan_monthly is not None else pd.DataFrame()
        if c.empty or pdy.empty:
            self.add("WARN", d, "plan", "plan-read", "no plan row for the report date in DPR or tblCALENDAR")
            return
        f = cfg["factor_t_per_bcm"]
        c, pdy = c.iloc[0], pdy.iloc[0]
        g = lambda rec, k: 0.0 if rec.get(k) is None or pd.isna(rec.get(k)) else float(rec.get(k))
        pairs = [("OB plan day (BCM)", g(pdy, "OB"), "OB-DAY"), ("Topsoil plan day (BCM)", g(pdy, "TS"), "S-DAY"),
                 ("Limonite plan day (t = BCM x1.6)", g(pdy, "Lim") * f, "L-DAY")]
        if not pm.empty:
            pm = pm.iloc[0]
            pairs += [("OB plan month (BCM)", g(pm, "OB"), "OB-MTD"), ("Topsoil plan month (BCM)", g(pm, "TS"), "S-MTD"),
                      ("Limonite plan month (t)", g(pm, "Lim") * f, "L-MTD"),
                      ("Saprolite plan month (t, mapping unconfirmed)", g(pm, "Sap") * f, "H-MTD")]
        diffs = []
        for label, v, col in pairs:
            cv = c.get(col)
            dif = None if v is None or cv is None else round(float(v) - float(cv), 2)
            same = dif is not None and abs(dif) <= max(cfg["tolerance_abs"], 0.0005 * abs(float(cv or 0)))
            self.plan_rows.append({"REPORT DATE": d, "PLAN ITEM (DPR)": label, "DPR": _r(v, 2), "tblCALENDAR COLUMN": col,
                                   "tblCALENDAR": _r(cv, 2), "DIFF": dif, "SAME": "yes" if same else "NO"})
            if not same:
                diffs.append(f"{col}: DPR {v:,.2f} vs calendar {float(cv or 0):,.2f}")
        if diffs:
            prev = getattr(self, "_last_plan_diff", None)
            sev = "WARN" if prev != tuple(diffs) else "INFO"
            self.add(sev, d, "tblCALENDAR", "plan-calendar", "plan differs from tblCALENDAR: " + "; ".join(diffs))
            self._last_plan_diff = tuple(diffs)

    def check_existing_and_vocab(self):
        cfg = self.cfg
        lists = {"SITE": self.m.lookup("tblIDSITE"), "PIT": self.m.lookup("tblIDPIT"),
                 "CONTRACTOR": self.m.lookup("tblIDCONTRACTOR"), "SHIFT": self.m.lookup("tblIDSHIFT")}
        for t, rows in self.rows.items():
            if not rows:
                continue
            have = self.m.dates(t, cfg["site"])
            for d in sorted({r["DATE"] for r in rows} & have):
                self.add("WARN", d, t, "already-in-master", "date already in the master (Skip leaves it, Replace reloads it)")
            for col, ok in lists.items():
                vals = {r.get(col) for r in rows if r.get(col) is not None}
                for v in vals - ok:
                    self.add("WARN", None, t, "vocab", f"{col} '{v}' is not in DOCUMENT CONTROL list {sorted(ok)}")

    # ---------------- staging workbook ----------------
    def write_staging(self, out, mode_note):
        wb = openpyxl.Workbook()
        bold = Font(bold=True)
        fill = PatternFill("solid", fgColor="DDEBF7")
        ws = wb.active
        ws.title = "_README"
        readme = [
            "TMS Daily Production Report -> Master Data Site TMS: staging workbook",
            f"Generated {self.input_time} by {GENERATOR} (parser {PARSER_VERSION}). {mode_note}",
            "Sheets named tblRAW... hold rows for the master table of the same name, INPUT COLUMNS ONLY, in table column order.",
            "Formula columns (WTD/MTD/YTD, YEAR/MONTH/WEEK, STOCK, FR ...) are left to Excel.",
            "Load with TMS_ImportStaging.bas (inside the master) or by pasting rows under the matching table.",
            "Skip mode = dates already in a table are left alone; Replace mode = rows of those dates are deleted first.",
            "_LOG lists every check. ERROR = that part was not staged. WARN = staged, look at it. RECON = totals differ. INFO = derived/skipped.",
            "REVIEW_... sheets are read from the DPR but NOT imported (no agreed master column).",
            "_PLAN_VS_CALENDAR compares the DPR plan with tblCALENDAR (tblCALENDAR is never written).",
        ]
        for line in readme:
            ws.append([line])
        ws["A1"].font = Font(bold=True, size=13)
        ws.column_dimensions["A"].width = 140

        wm = wb.create_sheet("_META")
        wm.append(["REPORT DATE", "FILE", "SHA256 (12)", "ERRORS", "NOTE"])
        for r in self.meta:
            wm.append(r)
        wm.append([])
        for k, v in [("site", self.cfg["site"]), ("parser", PARSER_VERSION), ("generator", GENERATOR),
                     ("master_file", self.m.file_name), ("generated", self.input_time), ("mode", mode_note)]:
            wm.append([k, v])

        wl = wb.create_sheet("_LOG")
        wl.append(["SEVERITY", "DATE", "TABLE", "CHECK", "MESSAGE", "DPR VALUE", "MASTER VALUE", "DIFF"])
        order = {"ERROR": 0, "WARN": 1, "RECON": 2, "INFO": 3}
        for i in sorted(self.issues, key=lambda i: (order.get(i.severity, 9), str(i.date), i.table)):
            wl.append([i.severity, i.date, i.table, i.check, i.message, i.src_value, i.master_value, i.diff])

        for t in self.cfg["tables_staged"]:
            rows = self.rows.get(t, [])
            w = wb.create_sheet(t)
            cols = self.m.inputs[t]
            w.append(cols)
            for r in sorted(rows, key=lambda r: (r["DATE"], str(r.get("CONSTRUCTION ITEM", "")))):
                w.append([r.get(c) for c in cols])
            for cell in w[1]:
                cell.font, cell.fill = bold, fill
            for row in w.iter_rows(min_row=2):
                for cell in row:
                    hdr = w.cell(1, cell.column).value
                    if hdr == "DATE":
                        cell.number_format = "yyyy-mm-dd"
                    elif hdr == "INPUT DATE":
                        cell.number_format = "yyyy-mm-dd hh:mm:ss"
            w.freeze_panes = "A2"

        for name in ("REVIEW_PRODUCTION", "REVIEW_FLEETS", "REVIEW_BARGE", "REVIEW_UNITS", "REVIEW_STOCK",
                     "REVIEW_HAZARD", "REVIEW_HAZARD_OPEN", "_HAZARD_UPDATES"):
            rows = self.review.get(name, [])
            w = wb.create_sheet(name)
            if rows:
                cols = list(rows[0].keys())
                w.append(cols)
                for r in rows:
                    w.append([r.get(c) for c in cols])
                for cell in w[1]:
                    cell.font = bold
            else:
                w.append(["(nothing)"])
        for name, rows in (("_PLAN_VS_CALENDAR", self.plan_rows), ("_RECON", self.recon_rows)):
            w = wb.create_sheet(name)
            if rows:
                cols = list(rows[0].keys())
                for r in rows:
                    for k in r:
                        if k not in cols:
                            cols.append(k)
                w.append(cols)
                for r in rows:
                    w.append([r.get(c) for c in cols])
                for cell in w[1]:
                    cell.font = bold
        wn = wb.create_sheet("_NOT_STAGED")
        wn.append(["TABLE", "REASON"])
        for k, v in self.cfg["tables_not_staged"].items():
            wn.append([k, v])
        for w in wb.worksheets:
            if w.title.startswith(("REVIEW", "_LOG", "_PLAN", "_RECON", "_META", "_NOT")) or w.title.startswith("tblRAW"):
                for col in w.columns:
                    width = max(len(str(c.value)) if c.value is not None else 0 for c in col[:60])
                    w.column_dimensions[col[0].column_letter].width = min(max(10, width + 2), 70)
        wb.save(out)


def run(master_path, dpr_paths, out, backfill=False, dates=None, cfg_path=None, snapshot=True, hazard_paths=None):
    """CLI entry: read the master, build the run, write the standalone staging workbook."""
    cfg = json.load(open(cfg_path or os.path.join(HERE, "config_tms.json"), encoding="utf-8"))
    m = Master(master_path)
    r, note = build(cfg, m, dpr_paths, backfill=backfill, dates=dates, snapshot=snapshot, hazard_paths=hazard_paths)
    r.write_staging(out, note)
    return r


def build(cfg, m, dpr_paths, backfill=False, dates=None, snapshot=True, hazard_paths=None, progress=None):
    """Parse + transform + check. Returns (Run, note). Used by the CLI and by the local app (tms_adapter)."""
    say = progress or (lambda msg: None)
    r = Run(cfg, m)
    dprs = []
    for p in dpr_paths:
        say(f"Reading {os.path.basename(p)} ...")
        d = parse(p, cfg)
        r.issues.extend(d.issues)
        dprs.append(d)
    ok = [d for d in dprs if d.report_date and not any(i.severity == "ERROR" and i.table == "file" for i in d.issues)]
    ok.sort(key=lambda d: d.report_date)
    seen = {}
    for d in ok:
        if d.report_date in seen:
            r.add("ERROR", d.report_date, "file", "duplicate-date",
                  f"{d.file_name} and {seen[d.report_date].file_name} have the same report date; the second is skipped")
        else:
            seen[d.report_date] = d
    ok = list(seen.values())
    note_parts = []
    if dates and ok:
        latest = ok[-1]
        for dd in dates:
            if dd > latest.report_date:
                r.add("ERROR", dd, "file", "after-report-date", f"{dd} is after the latest report date {latest.report_date}")
                continue
            r.stage_production_day(latest, dd, f"{latest.file_name} (report {latest.report_date})")
        note_parts.append(f"Backfill of {dates[0]}..{dates[-1]} from {latest.file_name}; production tables only")
        for dpr in ok:
            r.meta.append([dpr.report_date, dpr.file_name, dpr.sha, sum(i.severity == "ERROR" for i in dpr.issues),
                           "source of backfill" if dpr is latest else "not used"])
    else:
        if backfill and ok:
            last = max((max(m.dates(t, cfg["site"]) or {dt.date(2000, 1, 1)}) for t in ("tblRAWMNG",)))
            first = ok[0]
            gap = [x.date() for x in pd.date_range(last + dt.timedelta(days=1), first.report_date - dt.timedelta(days=1))]
            src = ok[-1]
            for gd in gap:
                r.stage_production_day(src, gd, f"backfill from {src.file_name}")
            if gap:
                note_parts.append(f"Backfill {gap[0]}..{gap[-1]} from {src.file_name}")
        for dpr in ok:
            r.check_after_report_date(dpr)
            r.stage_production_day(dpr, dpr.report_date, f"{dpr.file_name}")
            if snapshot:
                r.stage_snapshot(dpr)
            r.meta.append([dpr.report_date, dpr.file_name, dpr.sha, sum(i.severity == "ERROR" for i in dpr.issues), ""])
        for dpr in ok:
            r.recon(dpr)
            r.plan_check(dpr)
        if ok:
            note_parts.append("Report dates " + ", ".join(str(d.report_date) for d in ok))
    if hazard_paths:
        say(f"Reading {len(hazard_paths)} hazard report(s) ...")
        hz = stage_hazards(r, [parse_hazard(p) for p in hazard_paths])
        note_parts.append("Hazard reports " + ", ".join(str(h.report_date) for h in hz))
    r.check_existing_and_vocab()
    return r, "; ".join(note_parts)


def _parse_dates(s):
    a, b = s.split(":")
    return [x.date() for x in pd.date_range(a, b)]


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--master", required=True)
    ap.add_argument("--dpr", nargs="+", default=[])
    ap.add_argument("--hazard", nargs="+", default=[], help="Laporan Inspeksi Harian .docx files")
    ap.add_argument("--out", required=True)
    ap.add_argument("--backfill", action="store_true")
    ap.add_argument("--dates")
    ap.add_argument("--config")
    a = ap.parse_args()
    res = run(a.master, a.dpr, a.out, backfill=a.backfill, dates=_parse_dates(a.dates) if a.dates else None, cfg_path=a.config,
              hazard_paths=a.hazard)
    cnt = defaultdict(int)
    for i in res.issues:
        cnt[i.severity] += 1
    print("staged:", {t: len(v) for t, v in res.rows.items()}, "issues:", dict(cnt), "->", a.out)
