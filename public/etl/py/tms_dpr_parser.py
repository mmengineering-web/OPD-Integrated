"""Extract step: read a TMS 'Daily Production Report' workbook (.xlsx).

The DPR is a cumulative workbook: the Production and SPO sheets hold every
shift from first mining up to (and sometimes past) the report date, while the
'Daily Report Huayou ' sheet is a one-day snapshot (stock, fuel, units,
infrastructure) for the report date only.

Everything is read from cached values (data_only=True). If the workbook was
saved without recalculation the cached values are missing -> ERROR.
"""
from __future__ import annotations

import datetime as dt
import hashlib
import os
import re
from dataclasses import dataclass, field

import openpyxl
import pandas as pd

PARSER_VERSION = "1.1.0"


@dataclass
class Issue:
    severity: str          # ERROR / WARN / RECON / INFO
    date: object
    table: str
    check: str
    message: str
    src_value: object = None
    master_value: object = None
    diff: object = None


@dataclass
class DPR:
    path: str
    file_name: str
    sha: str
    report_date: dt.date | None = None
    production: pd.DataFrame | None = None        # one row per DATE x SHIFT
    fleets: dict = field(default_factory=dict)     # sheet -> DataFrame per DATE x SHIFT
    summary: dict = field(default_factory=dict)    # Huayou snapshot
    plan_daily: pd.DataFrame | None = None
    plan_monthly: pd.DataFrame | None = None
    unit: pd.DataFrame | None = None               # Unit sheet, one row per DATE x SHIFT, columns by letter (1.1.0)
    unit_headers: dict = field(default_factory=dict)   # column letter -> header words of rows 2-5
    issues: list = field(default_factory=list)

    def add(self, sev, table, check, msg, **kw):
        self.issues.append(Issue(sev, kw.pop("date", self.report_date), table, check, msg, **kw))


def _sha(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()[:12]


def _as_date(v):
    if isinstance(v, dt.datetime):
        return v.date()
    if isinstance(v, dt.date):
        return v
    return None


def _num(v):
    if v is None or v == "":
        return None
    if isinstance(v, (int, float)):
        return float(v)
    try:
        return float(str(v).replace(",", ""))
    except ValueError:
        return None


# ----------------------------------------------------------------------------
# Production sheet: 4-level merged header (rows 2-5), data from row 7
# ----------------------------------------------------------------------------
def read_production(ws):
    rows = list(ws.iter_rows(min_row=2, max_row=ws.max_row, values_only=True))
    hdr, data = rows[:4], rows[5:]
    ncol = max(len(r) for r in hdr)
    get = lambda i, j: hdr[i][j] if j < len(hdr[i]) else None
    lv = [[None] * ncol for _ in range(4)]
    for i in range(4):
        last = None
        for j in range(ncol):
            v = get(i, j)
            if v not in (None, ""):
                last = str(v).strip()
            elif i > 0 and any(get(k, j) not in (None, "") for k in range(i)):
                last = None              # a new parent starts here -> reset child level
            lv[i][j] = last
    cols = []
    for j in range(ncol):
        if j < 5:
            cols.append(["IDX", "DATE", "SHIFT", "FROM", "TO"][j])
        else:
            cols.append(" / ".join(x for x in (lv[0][j], lv[1][j], lv[2][j], lv[3][j]) if x))
    df = pd.DataFrame([list(r[:ncol]) + [None] * (ncol - len(r)) for r in data], columns=cols)
    df = df[df["DATE"].map(lambda v: _as_date(v) is not None)].copy()
    df["DATE"] = df["DATE"].map(_as_date)
    df["SHIFT"] = df["SHIFT"].astype(str).str.strip().str.upper()
    return df


# ----------------------------------------------------------------------------
# SPO fleet sheets: header rows 2-3, data from row 5
# ----------------------------------------------------------------------------
GROUPED = ("BREAKDOWN", "SPO DELAY", "NON-SPO DELAY", "EWH")


def read_spo(ws):
    rows = list(ws.iter_rows(min_row=1, max_row=ws.max_row, values_only=True))
    h2, h3 = rows[1], rows[2]
    n = max(len(h2), len(h3))
    cols, grp = [], None
    for j in range(n):
        a = h2[j] if j < len(h2) else None
        b = h3[j] if j < len(h3) else None
        if a not in (None, ""):
            grp = str(a).strip()
        if b not in (None, ""):
            b = re.sub(r"\s+", " ", str(b).strip())
            cols.append(f"{grp} / {b}" if grp in GROUPED else b)
        else:
            cols.append(grp if a not in (None, "") else f"c{j}")
    cols[0] = "IDX"
    df = pd.DataFrame([list(r[:n]) + [None] * (n - len(r)) for r in rows[4:]], columns=cols)
    df = df[df["DATE"].map(lambda v: _as_date(v) is not None)].copy()
    df["DATE"] = df["DATE"].map(_as_date)
    df["SHIFT"] = df["SHIFT"].astype(str).str.strip().str.upper()
    return df


# ----------------------------------------------------------------------------
# 'Daily Report Huayou ' snapshot, found by labels in column B
# ----------------------------------------------------------------------------
def _find_rows(ws, label, col="B"):
    lab = label.strip().lower()
    return [c.row for c in ws[col] if isinstance(c.value, str) and c.value.strip().lower() == lab]


def read_summary(ws, dpr: DPR):
    s = {}
    s["date"] = _as_date(ws["C3"].value)
    hdr = {"I3": "EWH Mining", "I4": "EWH Hauling", "I5": "EWH Barging", "F3": "Rain", "F4": "Slippery"}
    for k, name in hdr.items():
        v = ws[k].value
        m = re.search(r"[-\d.]+", str(v or ""))
        s[name] = float(m.group()) if m else None

    def block(label, nth=0):
        rows = _find_rows(ws, label)
        if len(rows) <= nth:
            dpr.add("ERROR", "summary", "anchor", f"label '{label}' not found in '{ws.title}'")
            return None
        r = rows[nth]
        return {k: _num(ws[f"{c}{r}"].value) for k, c in
                zip(["DAY_PLAN", "DAY", "WTD_PLAN", "WTD", "MTD_PLAN", "MTD", "YTD_PLAN", "YTD"], "CDEFGHIJ")}

    s["OB_SOIL"] = block("OB & Soil Removal")
    s["OB"] = block("OB Removal")
    s["SOIL"] = block("Soil Removal")
    s["LIM"] = block("Ore Getting", 0)
    s["SAP"] = block("Ore Getting", 1)

    # stockpile block: rows between 'Stockpile' and 'Unit Type'
    st = {}
    r0 = _find_rows(ws, "Stockpile")
    r1 = _find_rows(ws, "Unit Type")
    if r0 and r1:
        for r in range(r0[0] + 1, r1[0]):
            lab = ws[f"B{r}"].value
            if isinstance(lab, str) and lab.strip():
                st[lab.strip()] = {"LIM_T": _num(ws[f"C{r}"].value), "LIM_NI": _num(ws[f"D{r}"].value),
                                   "SAP_T": _num(ws[f"E{r}"].value), "SAP_NI": _num(ws[f"F{r}"].value)}
    else:
        dpr.add("ERROR", "tblRAWSTOCK", "anchor", "Stockpile block not found")
    s["STOCK"] = st

    # units
    units = []
    if r1:
        r = r1[0] + 1
        while r < ws.max_row and ws[f"B{r}"].value not in ("Material",):
            if ws[f"B{r}"].value:
                units.append({"UNIT TYPE": ws[f"B{r}"].value, "TYPE": ws[f"C{r}"].value,
                              "POPULATION": _num(ws[f"D{r}"].value), "ACTIVE": _num(ws[f"E{r}"].value),
                              "WH PLAN": _num(ws[f"F{r}"].value), "WH ACTUAL": _num(ws[f"G{r}"].value)})
            r += 1
    s["UNITS"] = units

    # fuel
    fr = _find_rows(ws, "Diesel Fuel")
    if fr:
        r = fr[0]
        s["FUEL"] = {"DAY_RECEIVED": _num(ws[f"C{r}"].value), "DAY_CONSUMED": _num(ws[f"D{r}"].value),
                     "REMAINING": _num(ws[f"E{r}"].value), "MONTH_RECEIVED": _num(ws[f"F{r}"].value),
                     "MONTH_CONSUMED": _num(ws[f"G{r}"].value), "YEAR_RECEIVED": _num(ws[f"H{r}"].value),
                     "YEAR_CONSUMED": _num(ws[f"I{r}"].value)}
    else:
        s["FUEL"] = None
        dpr.add("ERROR", "tblRAWFUEL", "anchor", "'Diesel Fuel' row not found")

    # infrastructure
    cons = []
    ir = _find_rows(ws, "Infrastructure")
    if ir:
        r = ir[0] + 1
        while r <= ws.max_row:
            item = ws[f"B{r}"].value
            if not (isinstance(item, str) and item.strip()):
                break
            cons.append({"ITEM": item.strip(), "EST COMPLETION": _as_date(ws[f"C{r}"].value),
                         "PROGRESS": _num(ws[f"D{r}"].value), "KETERANGAN": ws[f"E{r}"].value})
            r += 1
    else:
        dpr.add("ERROR", "tblRAWCONS", "anchor", "'Infrastructure' block not found")
    s["CONS"] = cons
    return s


def read_plan(ws):
    """Plan sheet: monthly block C..V, daily block X..AP (BCM)."""
    rows = list(ws.iter_rows(min_row=1, max_row=ws.max_row, values_only=True))
    hdr = rows[2]
    month, daily = [], []
    for r in rows[4:]:
        if len(r) > 21 and _as_date(r[2]):
            month.append({"MONTH": _as_date(r[2]), **{str(hdr[j]).strip(): _num(r[j]) for j in range(3, 22) if hdr[j]}})
        if len(r) > 41 and _as_date(r[23]):
            daily.append({"DATE": _as_date(r[23]), **{str(hdr[j]).strip(): _num(r[j]) for j in range(25, 42) if hdr[j]}})
    return pd.DataFrame(month), pd.DataFrame(daily)


def read_unit(ws):
    """Unit sheet (1.1.0): header rows 2-5, data from row 7, B = DATE, C = SHIFT. Columns are kept by letter;
    the header words of each letter are returned too, so the caller can check that a column still holds
    what the config expects (the site may insert columns)."""
    from openpyxl.utils import get_column_letter
    rows = list(ws.iter_rows(min_row=2, max_row=ws.max_row, values_only=True))
    hdr, data = rows[:4], rows[5:]
    ncol = max(len(r) for r in rows[:4] + rows[5:6]) if rows else 0
    letters = [get_column_letter(j + 1) for j in range(ncol)]
    words = {}
    for j, l in enumerate(letters):
        words[l] = " / ".join(str(h[j]).strip() for h in hdr if j < len(h) and h[j] not in (None, "") and str(h[j]).strip())
    df = pd.DataFrame([list(r[:ncol]) + [None] * (ncol - len(r)) for r in data], columns=letters)
    df = df[df["B"].map(lambda v: _as_date(v) is not None)].copy()
    df["DATE"] = df["B"].map(_as_date)
    df["SHIFT"] = df["C"].astype(str).str.strip().str.upper()
    return df, words


DATE_IN_NAME = re.compile(r"(20\d{2})(\d{2})(\d{2})")


def parse(path, cfg) -> DPR:
    dpr = DPR(path=path, file_name=os.path.basename(path), sha=_sha(path))
    try:
        wb = openpyxl.load_workbook(path, data_only=True, read_only=False)
    except Exception as e:  # noqa
        dpr.add("ERROR", "file", "open", f"cannot open workbook: {e}")
        return dpr
    sh = cfg["sheets"]
    missing = [s for s in [sh["production"], sh["summary"], sh["wewh_fleet"]] if s not in wb.sheetnames]
    if missing:
        dpr.add("ERROR", "file", "sheets", f"missing sheets: {missing}")
        return dpr

    summ = wb[sh["summary"]]
    d1 = _as_date(summ["C3"].value)
    d2 = _as_date(wb[sh["daily_report"]]["C6"].value) if sh["daily_report"] in wb.sheetnames else None
    dpr.report_date = d1 or d2
    if not dpr.report_date:
        dpr.add("ERROR", "file", "report-date", "report date not found ('Daily Report Huayou '!C3 / 'Daily Report'!C6)")
        return dpr
    if d1 and d2 and d1 != d2:
        dpr.add("ERROR", "file", "report-date", f"Huayou C3 {d1} != Daily Report C6 {d2}")
    m = DATE_IN_NAME.search(dpr.file_name)
    if m:
        nd = dt.date(int(m[1]), int(m[2]), int(m[3]))
        if nd != dpr.report_date:
            dpr.add("WARN", "file", "file-name-date",
                    f"file name says {nd}, report date inside the file is {dpr.report_date}; the date inside the file is used")

    # production
    prod = read_production(wb[sh["production"]])
    want = cfg["production_columns"]
    lost = [k for k, c in want.items() if c not in prod.columns]
    if lost:
        dpr.add("ERROR", "tblRAWMNG", "header-drift",
                "Production header changed, columns not found: " + ", ".join(f"{k}={want[k]!r}" for k in lost))
    dpr.production = prod

    for s in [sh["wewh_fleet"]] + sh["other_fleets"]:
        if s in wb.sheetnames:
            dpr.fleets[s] = read_spo(wb[s])
        else:
            dpr.add("WARN" if s != sh["wewh_fleet"] else "ERROR", "tblRAWWEWH", "sheets", f"fleet sheet '{s}' missing")

    if sh.get("unit") and sh["unit"] in wb.sheetnames:
        try:
            dpr.unit, dpr.unit_headers = read_unit(wb[sh["unit"]])
        except Exception as e:  # noqa
            dpr.add("ERROR", "tblRAWEQ", "unit-read", f"Unit sheet unreadable: {e}")
    elif sh.get("unit"):
        dpr.add("ERROR", "tblRAWEQ", "sheets", f"sheet '{sh['unit']}' missing; equipment not staged")

    dpr.summary = read_summary(summ, dpr)
    if sh["plan"] in wb.sheetnames:
        try:
            dpr.plan_monthly, dpr.plan_daily = read_plan(wb[sh["plan"]])
        except Exception as e:  # noqa
            dpr.add("WARN", "plan", "plan-read", f"Plan sheet unreadable: {e}")
    return dpr
