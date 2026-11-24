"""tms_stock.py
-------------
TMS stock dome register ("STOCK_<contractor>_<date>.xlsx") -> tblRAWSTOCK, one row per contractor per date.

Source layout (one sheet per contractor, sheet name -> contractor via config stock_register.sheets):
  title     "Stock Dome TOS-ETO-EFO" / "Stock Dome ETO-EFO"
  header    NO | DATE | ID DOME | TONNAGE (WMT) | Ni | Fe | SiO2 | MgO | Al2O3 | CaO | Co | Cr2O3 | MnO | SM | Status
            FMI: two header rows, TONNAGE split into TC (truck count) and SURVEY, no MnO
  blocks    "STOCK TOS", "STOCK ETO", "STOCK EFO", each followed by one row per dome; "TOTAL" closes the list
  summary   "TOTAL STOCK ORE WMT, BERDASARKAN STOCKPILE\n<d> <MONTH> <YYYY>" (report date) with one
            sumproduct line per stockpile (TOS / ETO / EFO, tonnage in the "TONAGE WMT" column)
The table moves (column B in one file, column C in the next), so every anchor is found by its label.

Mapping (Master Data Site TMS, DAILY REPORT section 4 "ORE STOCK", ore class by dome Ni):
  HGO  Ni >= 1.90         -> <P>-H-*        P = ETO or EFO
  MGO  1.70 <= Ni < 1.90  -> <P>-M-*
  LGO A 1.50 <= Ni < 1.70 -> <P>-L-*
  LGO B Ni < 1.50         -> <P>-LB-*
  WAITING SURVEY          -> <P>-WS-TONAGE = number of domes with that status (the Daily Report shows it as DOME)
  WAITING ASSAY           -> <P>-WA-TONAGE = tonnage of domes that have tonnage but no Ni assay (any status)
  per class: TONAGE = sum of dome tonnage; Ni/Fe/Co/MgO/SiO2 = tonnage-weighted over the domes that have the
             analyte; Si/MgO = sum(t x SiO2) / sum(t x MgO) (not the mean of the dome ratios); MC not in the file.
  So TONAGE(H+M+L+LB) + WA = all dome tonnage of the stockpile = the register's own total.
  Cut-offs live in config (stock_register.classes) - change them there, not in code.
  TOS has no tblRAWSTOCK column: shown in REVIEW (STOCK_SUMMARY), not loaded.
  FMI tonnage: SURVEY when filled (the site's own summary uses it), else TC (WARN).

Assay checks (per dome; a failed analyte is left out of the weighted grade, the dome tonnage still counts):
  text that is not a number ("1,4`1", "1,24,")          -> WARN, analyte blank
  outside the plausible laterite range (config ranges) -> WARN, analyte blank
  reported S/M differs from SiO2/MgO by more than 5 %   -> WARN "columns shifted", SiO2/MgO/Co dropped (Ni, Fe kept)
"""
from __future__ import annotations

import datetime as dt
import os
import re
from collections import Counter, defaultdict

PARSER_VERSION = "tms_stock 1.0.0"
PRODUCTS = ("TOS", "ETO", "EFO")
BLOCK_RE = re.compile(r"^\s*STOCK\s+(TOS|ETO|EFO)\s*$", re.I)
TITLE_RE = re.compile(r"^\s*STOCK\s+DOME\b", re.I)
SUMMARY_RE = re.compile(r"TOTAL\s+STOCK\s+ORE\s+WMT\s*,\s*BERDASARKAN\s+STOCKPILE", re.I)
MONTHS = {"JAN": 1, "JANUARI": 1, "JANUARY": 1, "FEB": 2, "FEBRUARI": 2, "FEBRUARY": 2, "MAR": 3, "MARET": 3,
          "MARCH": 3, "APR": 4, "APRIL": 4, "MEI": 5, "MAY": 5, "JUN": 6, "JUNI": 6, "JUNE": 6, "JUL": 7, "JULI": 7,
          "JULY": 7, "AGU": 8, "AGT": 8, "AGS": 8, "AGUSTUS": 8, "AUG": 8, "AUGUST": 8, "SEP": 9, "SEPT": 9,
          "SEPTEMBER": 9, "OKT": 10, "OKTOBER": 10, "OCT": 10, "OCTOBER": 10, "NOV": 11, "NOPEMBER": 11,
          "NOVEMBER": 11, "DES": 12, "DESEMBER": 12, "DEC": 12, "DECEMBER": 12}
DATE_TEXT_RE = re.compile(r"(\d{1,2})[\s_\-.]+([A-Za-z]{3,9})[\s_\-.]+(\d{4})")
NUM_RE = re.compile(r"^-?\d+(?:[.,]\d+)?$")

# header label -> field
HEADER_ALIASES = {
    "NO": "NO", "DATE": "DATE", "TANGGAL": "DATE", "ID DOME": "DOME", "DOME": "DOME", "ID": "DOME",
    "TONNAGE (WMT)": "TON", "TONNAGE": "TON", "TONAGE": "TON", "TONAGE (WMT)": "TON",
    "TC": "TC", "SURVEY": "SURVEY",
    "NI": "Ni", "FE": "Fe", "SIO2": "SiO2", "MGO": "MgO", "MG0": "MgO", "AL2O3": "Al2O3", "CAO": "CaO",
    "CO": "Co", "CR2O3": "Cr2O3", "MNO": "MnO", "SM": "SM", "S/M": "SM", "SI/MGO": "SM", "STATUS": "STATUS",
}
ANALYTES = ("Ni", "Fe", "SiO2", "MgO", "Al2O3", "CaO", "Co", "Cr2O3", "MnO", "SM")
MASTER_GRADES = ("Ni", "Fe", "Co", "MgO", "SiO2")          # weighted into tblRAWSTOCK (+ Si/MgO, MC blank)

DEFAULT_CFG = {
    "sheets": {"VMM": "PT VMM", "FMI": "PT FMI"},
    "classes": [{"code": "H", "label": "HGO", "min": 1.90}, {"code": "M", "label": "MGO", "min": 1.70},
                {"code": "L", "label": "LGO A", "min": 1.50}, {"code": "LB", "label": "LGO B", "min": None}],
    "products": {"ETO": "ETO", "EFO": "EFO", "TOS": None},
    "tonnage_preference": ["SURVEY", "TON", "TC"],
    "waiting_survey_status": ["WAITING SURVEY"],
    "ranges": {"Ni": [0.3, 4.0], "Fe": [3, 65], "SiO2": [0.3, 70], "MgO": [0.05, 45], "Co": [0.005, 0.6],
               "Al2O3": [0.1, 30], "CaO": [0, 5], "Cr2O3": [0.1, 10], "MnO": [0, 5], "SM": [0.01, 300]},
    "sm_tolerance_rel": 0.05,
    "shift_drop": ["SiO2", "MgO", "Co", "SM", "Al2O3", "CaO", "Cr2O3", "MnO"],
    "total_tolerance_t": 1.0,
}


def scfg(cfg):
    out = dict(DEFAULT_CFG)
    out.update((cfg or {}).get("stock_register") or {})
    return out


def _norm(s):
    return re.sub(r"\s+", " ", str(s or "")).strip().upper()


def _label(v):
    s = _norm(v)
    s = re.sub(r"\s*\(%\)\s*$", "", s)          # "Ni (%)" -> "NI"
    return HEADER_ALIASES.get(s)


def num(v):
    """Strict number: real numbers pass; text only when it is a plain decimal ("1.25" or "1,25").
    Returns (value | None, bad_text | None)."""
    if v is None or isinstance(v, bool):
        return None, None
    if isinstance(v, (int, float)):
        return float(v), None
    s = str(v).strip()
    if s in ("", "-"):
        return None, None
    if s.startswith("#"):                         # #REF!, #DIV/0!, #VALUE!
        return None, s
    if NUM_RE.match(s):
        return float(s.replace(",", ".")), None
    return None, s


def date_from_text(s):
    m = DATE_TEXT_RE.search(str(s or ""))
    if not m:
        return None
    mon = MONTHS.get(m[2].upper())
    if not mon:
        return None
    try:
        return dt.date(int(m[3]), mon, int(m[1]))
    except ValueError:
        return None


# ---------------------------------------------------------------------------- identify
def _title_cell(ws, rows=8, cols=8):
    for row in ws.iter_rows(min_row=1, max_row=rows, max_col=cols):
        for c in row:
            if isinstance(c.value, str) and TITLE_RE.match(c.value):
                return c
    return None


def is_stock_register(wb):
    return any(_title_cell(ws) is not None for ws in wb.worksheets[:6])


# ---------------------------------------------------------------------------- parse
class Register:
    def __init__(self, path):
        self.path = path
        self.file_name = os.path.basename(path)
        self.report_date = None
        self.sheets = []            # [{contractor, sheet, date, domes: [...], site_totals: {P: t}, tonnage_cols}]
        self.issues = []            # (severity, check, message)

    def add(self, sev, check, msg):
        self.issues.append((sev, check, msg))


def parse(path, cfg=None):
    import openpyxl
    sc = scfg(cfg)
    reg = Register(path)
    wb = openpyxl.load_workbook(path, data_only=True, read_only=False)
    name_date = date_from_text(os.path.splitext(reg.file_name)[0].replace("_", " "))
    sheet_map = {_norm(k): v for k, v in sc["sheets"].items()}
    for ws in wb.worksheets:
        title = _title_cell(ws)
        if title is None:
            continue
        contractor = sheet_map.get(_norm(ws.title))
        if contractor is None:
            reg.add("ERROR", "sheet-contractor",
                    f"sheet '{ws.title}' does not name a known contractor ({', '.join(sc['sheets'])}); skipped. "
                    "Add it to stock_register.sheets in config_tms.json")
            continue
        sh = _parse_sheet(reg, ws, title, contractor, sc)
        if sh is None:
            continue
        if sh["date"] is None:
            sh["date"] = name_date
            if name_date:
                reg.add("WARN", "report-date", f"{ws.title}: no date in the 'TOTAL STOCK ORE ... STOCKPILE' title; "
                        f"file-name date {name_date:%d %b %Y} used")
            else:
                reg.add("ERROR", "report-date", f"{ws.title}: report date not found (summary title or file name); "
                        "sheet not staged")
                continue
        elif name_date and name_date != sh["date"]:
            reg.add("WARN", "report-date", f"{ws.title}: file name says {name_date:%d %b %Y}, the sheet title says "
                    f"{sh['date']:%d %b %Y}; the sheet title is used")
        reg.sheets.append(sh)
    wb.close()
    if not reg.sheets:
        if not any(s == "ERROR" for s, _, _ in reg.issues):
            reg.add("ERROR", "not-stock", "no 'Stock Dome' sheet found")
        return reg
    dates = sorted({s["date"] for s in reg.sheets})
    if len(dates) > 1:
        reg.add("WARN", "report-date", "sheets carry different dates: " +
                ", ".join(f"{s['sheet']} {s['date']:%d %b %Y}" for s in reg.sheets) + "; each sheet keeps its own date")
    reg.report_date = dates[-1]
    return reg


def _parse_sheet(reg, ws, title, contractor, sc):
    pre = f"{ws.title}: "
    max_c = min(ws.max_column, 40)
    # ---- header: first row below the title that has ID DOME, plus the row under it when it holds labels
    hdr_row = None
    for r in range(title.row + 1, title.row + 6):
        if any(_label(ws.cell(r, c).value) == "DOME" for c in range(1, max_c + 1)):
            hdr_row = r
            break
    if hdr_row is None:
        reg.add("ERROR", "header", pre + "header row with 'ID DOME' not found below the title; sheet not staged")
        return None
    col = {}
    for r in (hdr_row, hdr_row + 1):
        for c in range(1, max_c + 1):
            f = _label(ws.cell(r, c).value)
            if f and f not in col:
                col[f] = c
    if "TON" in col and col["TON"] in (col.get("TC"), col.get("SURVEY")):
        col.pop("TON")          # FMI: "TONNAGE (WMT)" is a group label over TC | SURVEY
    need = [f for f in ("DOME", "Ni") if f not in col]
    ton_cols = [f for f in ("TON", "TC", "SURVEY") if f in col]
    if need or not ton_cols:
        reg.add("ERROR", "header", pre + f"columns not found: {need + ([] if ton_cols else ['TONNAGE'])}; sheet not staged")
        return None
    missing = [a for a in ANALYTES if a not in col and a not in ("MnO",)]
    if missing:
        reg.add("INFO", "header", pre + f"no column for {', '.join(missing)} (left blank)")
    sm_c = col.get("SM")

    # ---- dome rows
    first_col = min(col.values())
    block, domes, seen = None, [], Counter()
    total_row = None
    r = hdr_row + 1
    while r <= ws.max_row:
        lead = [ws.cell(r, c).value for c in range(1, first_col + 2)]
        texts = [_norm(v) for v in lead if isinstance(v, str)]
        bm = next((BLOCK_RE.match(t) for t in texts if BLOCK_RE.match(t)), None)
        if bm:
            block = bm[1].upper()
            r += 1
            continue
        if "TOTAL" in texts:
            total_row = r
            break
        dome = ws.cell(r, col["DOME"]).value
        if block and dome not in (None, "") and str(dome).strip():
            domes.append(_dome(reg, ws, r, block, str(dome).strip(), col, sc, pre, contractor))
            seen[(block, _norm(dome).replace(" ", ""))] += 1
        r += 1
    for (b, d), n in seen.items():
        if n > 1:
            reg.add("WARN", "duplicate-dome", pre + f"{b} dome {d} appears {n} times; all rows counted")
    if not domes:
        reg.add("WARN", "no-domes", pre + "no dome rows found")

    # ---- site summary (sumproduct per stockpile) and its date
    site_totals, date = {}, None
    start = (total_row or hdr_row) + 1
    ton_col = None
    for rr in range(start, min(ws.max_row, start + 60) + 1):
        for c in range(1, max_c + 1):
            v = ws.cell(rr, c).value
            if isinstance(v, str) and SUMMARY_RE.search(v) and date is None:
                date = date_from_text(v.split("\n", 1)[-1]) or date_from_text(v)
            if isinstance(v, str) and _norm(v) in ("TONAGE WMT", "TONNAGE WMT", "TONAGE (WMT)") and ton_col is None:
                ton_col = c
            if isinstance(v, str) and _norm(v) in PRODUCTS and ton_col:
                val, bad = num(ws.cell(rr, ton_col).value)
                site_totals[_norm(v)] = val if bad is None else bad
    return {"contractor": contractor, "sheet": ws.title, "date": date, "domes": domes, "site_totals": site_totals,
            "tonnage_cols": ton_cols, "has_sm": sm_c is not None}


def _dome(reg, ws, r, block, dome, col, sc, pre, contractor):
    tag = f"{pre}{block} {dome} (row {r})"
    rec = {"contractor": contractor, "sheet": ws.title, "row": r, "block": block, "dome": dome,
           "status": _norm(ws.cell(r, col["STATUS"]).value) if "STATUS" in col else "", "flags": []}
    for f in ("TON", "TC", "SURVEY"):
        if f in col:
            v, bad = num(ws.cell(r, col[f]).value)
            rec[f] = v
            if bad:
                reg.add("WARN", "not-a-number", f"{tag}: {f} '{bad}' is not a number; left blank")
    # tonnage choice
    ton, src = None, None
    for f in sc["tonnage_preference"]:
        if rec.get(f) not in (None, 0):
            ton, src = rec[f], f
            break
    if ton is None:
        for f in ("TON", "SURVEY", "TC"):
            if rec.get(f) == 0:
                ton, src = 0.0, f
                break
    if src == "TC" and "SURVEY" in col:
        reg.add("WARN", "tonnage-tc", f"{tag}: no SURVEY tonnage, truck count (TC) {ton:,.2f} t used")
        rec["flags"].append("TC used")
    if ton is not None and ton < 0:
        reg.add("WARN", "tonnage-negative", f"{tag}: tonnage {ton} is negative; dome left out")
        ton = None
    rec["ton"], rec["ton_src"] = ton, src

    # assays: read, then the S/M consistency check (catches values pasted one or two columns off), then ranges
    a, bad_txt = {}, {}
    for g in ANALYTES:
        if g not in col:
            continue
        v, bad = num(ws.cell(r, col[g]).value)
        if bad:
            bad_txt[g] = bad
        elif v is not None:
            a[g] = v
    for g, bad in bad_txt.items():
        reg.add("WARN", "not-a-number", f"{tag}: {g} '{bad}' is not a number; left out of the grade")
        rec["flags"].append(f"{g} not a number")
    if all(a.get(g) is not None for g in ("SiO2", "MgO", "SM")) and a["MgO"] > 0:
        calc = a["SiO2"] / a["MgO"]
        if abs(a["SM"] - calc) > max(0.05, sc["sm_tolerance_rel"] * calc):
            dropped = [g for g in sc["shift_drop"] if g in a]
            reg.add("WARN", "assay-shift", f"{tag}: S/M {a['SM']:g} but SiO2/MgO = {a['SiO2']:g}/{a['MgO']:g} = "
                    f"{calc:.2f}; assay columns look shifted - {', '.join(dropped)} left out "
                    f"(Ni {a.get('Ni', '-')}, Fe {a.get('Fe', '-')} kept). Ask site to fix the row")
            for g in dropped:
                a.pop(g, None)
            rec["flags"].append("assay columns shifted")
    for g in list(a):
        lo, hi = sc["ranges"].get(g, (None, None))
        v = a[g]
        if (lo is not None and v < lo) or (hi is not None and v > hi):
            reg.add("WARN", "assay-range", f"{tag}: {g} {v:g} outside {lo}-{hi}; left out of the grade")
            rec["flags"].append(f"{g} out of range")
            a.pop(g)
    rec["assay"] = a
    if ton and "Ni" not in a:
        rec["flags"].append("no Ni -> WAITING ASSAY tonnage")
    st = rec["status"]
    if "Ni" in a and "WAITING ASSAY" in st:
        reg.add("INFO", "status", f"{tag}: status WAITING ASSAY but Ni {a['Ni']:g} is filled; classed by Ni")
    return rec


# ---------------------------------------------------------------------------- classify + aggregate
def ore_class(ni, classes):
    if ni is None:
        return None
    for k in classes:
        if k.get("min") is None or ni >= k["min"]:
            return k["code"]
    return classes[-1]["code"]


def _wavg(domes, g):
    w = [(d["ton"], d["assay"][g]) for d in domes if d["ton"] and g in d["assay"]]
    tw = sum(t for t, _ in w)
    return (sum(t * v for t, v in w) / tw if tw else None), tw


def _si_mg(domes):
    w = [(d["ton"], d["assay"]["SiO2"], d["assay"]["MgO"]) for d in domes
         if d["ton"] and "SiO2" in d["assay"] and "MgO" in d["assay"]]
    mg = sum(t * m for t, _, m in w)
    return sum(t * s for t, s, _ in w) / mg if mg else None


def aggregate(sheet, sc):
    """-> {product: {"classes": {code: {...}}, "ws": n, "wa": t, "total": t, "domes": n}}"""
    out = {}
    classes = sc["classes"]
    ws_status = {_norm(s) for s in sc["waiting_survey_status"]}
    by = defaultdict(list)
    for d in sheet["domes"]:
        by[d["block"]].append(d)
    for p, domes in by.items():
        res = {"classes": {}, "ws": 0, "wa": 0.0, "total": 0.0, "domes": len(domes), "no_ton": 0}
        groups = defaultdict(list)
        for d in domes:
            if d["status"] in ws_status:
                res["ws"] += 1
            if not d["ton"]:
                res["no_ton"] += 1
                d["class"] = None
                continue
            res["total"] += d["ton"]
            c = ore_class(d["assay"].get("Ni"), classes)
            d["class"] = c or "WA"
            if c is None:
                res["wa"] += d["ton"]
            else:
                groups[c].append(d)
        for k in classes:
            g = groups.get(k["code"], [])
            ton = sum(d["ton"] for d in g)
            row = {"label": k["label"], "TONAGE": ton, "domes": len(g), "coverage": {}}
            for a in MASTER_GRADES:
                v, tw = _wavg(g, a)
                row[a] = v
                row["coverage"][a] = (tw / ton) if ton else None
            row["Si/MgO"] = _si_mg(g)
            res["classes"][k["code"]] = row
        out[p] = res
    return out


# ---------------------------------------------------------------------------- stage into the app's Run
def stage(run, reg, source_name=""):
    """Add tblRAWSTOCK rows (one per contractor and date) + review sheets to the app's dr_to_master.Run."""
    cfg = run.cfg
    sc = scfg(cfg)
    T = "tblRAWSTOCK"
    src = source_name or reg.file_name
    d0 = reg.report_date
    for sev, check, msg in reg.issues:
        run.L(sev, d0, T, "stock-" + check, f"{src}: {msg}")
    if T not in run.m.tables:
        run.L("ERROR", d0, T, "no-table", "tblRAWSTOCK not found in the master; stock register not staged")
        return
    inputs = run.m.tables[T]["input"]
    prod_map = sc["products"]
    nd = cfg.get("round_decimals", 2)
    hist = run.m.rows(T)

    for sh in reg.sheets:
        d, con = sh["date"], sh["contractor"]
        agg = aggregate(sh, sc)
        row = {"DATE": dt.datetime.combine(d, dt.time()), "SITE": cfg["site"], "CONTRACTOR": con,
               "SHIFT": cfg.get("shift", "ALL"), "INPUT DATE": None}
        wanted = []
        for p, res in agg.items():
            pre = prod_map.get(p)
            site_t = sh["site_totals"].get(p)
            # register's own sumproduct total vs the dome rows
            if isinstance(site_t, (int, float)):
                if abs(site_t - res["total"]) > sc["total_tolerance_t"]:
                    run.L("RECON", d, T, "stock-total", f"{con} {p}: dome rows sum to {res['total']:,.2f} t but the "
                          f"register's own summary says {site_t:,.2f} t", round(res["total"], 2), round(site_t, 2))
            elif isinstance(site_t, str):
                run.L("INFO", d, T, "stock-total", f"{con} {p}: the register's summary cell shows {site_t} "
                      "(broken formula at site); totals taken from the dome rows")
            _review_summary(run, d, con, p, res, site_t, loaded=bool(pre))
            if not pre:
                run.L("INFO", d, T, "stock-not-loaded",
                      f"{con} {p}: {res['total']:,.2f} t in {res['domes']} dome(s) - tblRAWSTOCK has no {p} column; "
                      "shown in STOCK_SUMMARY only")
                continue
            for k in sc["classes"]:
                c = res["classes"][k["code"]]
                base = f"{pre}-{k['code']}-"
                row[base + "TONAGE"] = round(c["TONAGE"], nd)
                for a in MASTER_GRADES:
                    row[base + a] = None if c[a] is None else round(c[a], 3)
                row[base + "Si/MgO"] = None if c["Si/MgO"] is None else round(c["Si/MgO"], 3)
                wanted += [base + x for x in ("TONAGE",) + MASTER_GRADES + ("Si/MgO",)]
                part = [a for a, cov in c["coverage"].items() if cov is not None and cov < 0.999]
                if c["TONAGE"] and part:
                    run.L("INFO", d, T, "stock-coverage", f"{con} {p} {k['label']}: " + ", ".join(
                        f"{a} on {c['coverage'][a] * 100:.0f}% of the tonnage" for a in part) +
                        " (weighted over the domes that have it)")
            row[f"{pre}-WS-TONAGE"] = res["ws"]
            row[f"{pre}-WA-TONAGE"] = round(res["wa"], nd)
            wanted += [f"{pre}-WS-TONAGE", f"{pre}-WA-TONAGE"]
            if res["wa"]:
                run.L("INFO", d, T, "stock-waiting-assay",
                      f"{con} {p}: {res['wa']:,.2f} t in dome(s) without Ni -> {pre}-WA-TONAGE")
        drift = [c for c in wanted if c not in inputs]
        if drift:
            run.L("ERROR", d, T, "header-drift", f"{con}: tblRAWSTOCK has no column(s) {drift}; row not staged. "
                  "Check the stock_register mapping in config_tms.json against the master")
            continue
        run.stage[T].append({c: row.get(c) for c in inputs if c in row})
        _check_master(run, d, con, hist, row, sc)
        for dm_ in sh["domes"]:
            run.review["STOCK_DOMES"].append({
                "DATE": d, "CONTRACTOR": con, "STOCKPILE": dm_["block"], "DOME": dm_["dome"], "STATUS": dm_["status"],
                "TONNAGE": dm_["ton"], "TONNAGE FROM": dm_["ton_src"], "TC": dm_.get("TC"), "SURVEY": dm_.get("SURVEY"),
                **{a: dm_["assay"].get(a) for a in ANALYTES}, "CLASS": dm_.get("class"),
                "FLAGS": "; ".join(dm_["flags"]), "SHEET ROW": dm_["row"]})
    if reg.sheets:
        run.L("INFO", d0, T, "stock-source",
              f"{src}: " + ", ".join(f"{s['contractor']} {s['date']:%d %b} ({len(s['domes'])} domes)" for s in reg.sheets) +
              ". Ore class by dome Ni: " + ", ".join(
                  f"{k['label']} {'>= ' + format(k['min'], '.2f') if k.get('min') is not None else 'below'}"
                  for k in sc["classes"]))


def _review_summary(run, d, con, p, res, site_t, loaded):
    for code, c in (res.get("classes") or {}).items():
        run.review["STOCK_SUMMARY"].append({
            "DATE": d, "CONTRACTOR": con, "STOCKPILE": p, "CLASS": c["label"], "DOMES": c["domes"],
            "TONAGE": round(c["TONAGE"], 2), **{a: None if c[a] is None else round(c[a], 3) for a in MASTER_GRADES},
            "Si/MgO": None if c["Si/MgO"] is None else round(c["Si/MgO"], 3),
            "LOADED": "yes" if loaded else "no (no column)"})
    run.review["STOCK_SUMMARY"].append({
        "DATE": d, "CONTRACTOR": con, "STOCKPILE": p, "CLASS": "WAITING ASSAY (t) / WAITING SURVEY (domes)",
        "DOMES": res["ws"], "TONAGE": round(res["wa"], 2), "LOADED": "yes" if loaded else "no (no column)"})
    run.review["STOCK_SUMMARY"].append({
        "DATE": d, "CONTRACTOR": con, "STOCKPILE": p, "CLASS": "TOTAL (dome rows)", "DOMES": res["domes"],
        "TONAGE": round(res["total"], 2), "Ni": None,
        "SITE SUMMARY T": site_t if not isinstance(site_t, float) else round(site_t, 2),
        "LOADED": "yes" if loaded else "no (no column)"})


def _check_master(run, d, con, hist, row, sc):
    """Same date + contractor already loaded; and the old DPR row (contractor_site) on or just before that date."""
    import dr_to_master as dm
    T = "tblRAWSTOCK"
    same = [r for r in hist if dm.as_date(r.get("DATE")) == d and _norm(r.get("CONTRACTOR")) == _norm(con)]
    if same:
        run.L("WARN", d, T, "already-in-master", f"{con}: stock row for this date already in the master "
              "(Skip leaves it, Replace reloads it - only this contractor's row)")
    site_con = run.cfg.get("contractor_site")
    if not site_con or _norm(site_con) == _norm(con):
        return
    old = [r for r in hist if dm.as_date(r.get("DATE")) == d and _norm(r.get("CONTRACTOR")) == _norm(site_con)]
    if old:
        run.L("WARN", d, T, "stock-double-count",
              f"the master also has a {site_con} stock row for this date (old DPR mapping, all tonnage in ETO-L/EFO-L). "
              f"Contractor = ALL on the RAW_STOCK dashboard would add it to {con}. Delete that row after loading")
    # tell the user which DPR day carried the same VMM/FMI stock (helps settle the date convention)
    tot = lambda r, pre: sum(dm.fnum(r.get(f"{pre}-{k['code']}-TONAGE")) for k in sc["classes"]) + dm.fnum(r.get(f"{pre}-WA-TONAGE"))
    mine = tot(row, "ETO")
    if not mine:
        return
    for back in (0, 1, 2):
        dd = d - dt.timedelta(days=back)
        for r in hist:
            if dm.as_date(r.get("DATE")) == dd and _norm(r.get("CONTRACTOR")) == _norm(site_con):
                theirs = tot(r, "ETO")
                if theirs and abs(theirs - mine) <= max(1.0, 0.0005 * mine):
                    run.L("INFO", d, T, "stock-date",
                          f"{con} ETO {mine:,.2f} t equals the master's DPR stock of {dd:%d %b %Y}"
                          + (" (same day)" if back == 0 else f" ({back} day(s) earlier): the register title date may be "
                             "the morning after the stock day - check the date convention with site"))
                    return
