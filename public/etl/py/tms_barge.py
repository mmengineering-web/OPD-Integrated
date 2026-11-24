"""tms_barge.py
-------------
TMS "Realisasi Barging (DOME)" workbook -> tblRAWBARGE (barge list, latest state by SI).

Why this exists: the TMS Daily Production Report only carries completed-barge tonnage (truck count),
no SI, vessel or dates, so the barge list could only be keyed by hand. The site's Realisasi Barging
workbook has one block per trip ("Ke-n") with tug/barge, load date, finish date, the domes loaded
(tonnage + Ni/Fe/SiO2/MgO/S/M) and the final draught survey tonnage.

From 4 Nov 2026 the workbook has one sheet per contractor ("Realisasi Barging VMM" -> PT VMM,
"Realisasi Barging FMI" -> PT FMI; config barge_sheets). Each sheet has its own Ke-1, Ke-2 ... sequence,
so each contractor has its own SI format. The older one-sheet file ("Realisasi Barging OK") still works
and uses barge_contractor / barge_si_format.

Mapping (one tblRAWBARGE row per trip):
  SI               master SI when the same vessel + start date is already in the master, else
                   the sheet's si_format (VMM "{n:03d}-TMS" continues the existing 001-022, FMI "{n:03d}-FMI")
  VESSEL/BARGE     column KAPAL, spacing normalised ("TB. X / BG. Y")
  CONTRACTOR       from the sheet (barge_sheets); one-sheet file: config barge_contractor
  STARTDATE        LOAD      FINISHDATE   FINISH
  ACTUAL CAPACITY  Final Draught (draught survey). If blank, the sum of the dome tonnages is used (WARN).
  STATUS           finish + tonnage -> Completed, load only -> Loading, nothing yet -> TBI
  PLAN CAPACITY / GRADE PLAN  not in the workbook, left blank (master value kept)
Dome tonnage and grades are NOT loaded (no master column). They are shown in REVIEW_BARGE_DOMES.

Date handling: the workbook mixes text dates (dd/mm/yyyy) with real dates, and Excel swapped day and
month on the ones typed as dd/mm with day <= 12 (2 Oct 2026 shows as 2026-02-10). A date is read as
swapped only when the as-written date breaks the sequence (before the previous trip, before its own
load date, or after the reference date) and the swapped one fits. Every swap is a WARN.
"""
from __future__ import annotations

import datetime as dt
import re

SHEET_NAME = "Realisasi Barging OK"
TRIP_RE = re.compile(r"^\s*ke\s*-?\s*(\d+)\s*$", re.I)
DOME_RE = re.compile(r"^\s*(EFO|ETO|TOS)\s*[-_]?\s*0*(\d+)\s*$", re.I)
GRADE_COLS = ("Ni", "Fe", "SiO2", "MgO", "S/M")


# ---------------------------------------------------------------------------- identify
def is_barging(wb):
    """True when the workbook is a Realisasi Barging file (sheet name or title cell)."""
    if SHEET_NAME in wb.sheetnames:
        return True
    for ws in wb.worksheets[:3]:
        for row in ws.iter_rows(min_row=1, max_row=4, max_col=4, values_only=True):
            for v in row:
                if isinstance(v, str) and "REALISASI BARGING" in v.upper():
                    return True
    return False


def _sheet(wb):
    if SHEET_NAME in wb.sheetnames:
        return wb[SHEET_NAME]
    for ws in wb.worksheets:
        for row in ws.iter_rows(min_row=1, max_row=4, max_col=4, values_only=True):
            if any(isinstance(v, str) and "REALISASI BARGING" in v.upper() for v in row):
                return ws
    return None


# ---------------------------------------------------------------------------- dates
def _as_date(v):
    """(date | None, as_text). Text is read day-first."""
    if isinstance(v, dt.datetime):
        return v.date(), False
    if isinstance(v, dt.date):
        return v, False
    if isinstance(v, str):
        s = v.strip()
        m = re.match(r"^(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{2,4})$", s)
        if m:
            y = int(m[3]) + (2000 if int(m[3]) < 100 else 0)
            try:
                return dt.date(y, int(m[2]), int(m[1])), True
            except ValueError:
                return None, True
    return None, False


def _swap(d):
    try:
        return dt.date(d.year, d.day, d.month)
    except ValueError:
        return None


def _resolve(value, floor, ceil, number_format=""):
    """Return (date, note). floor = earliest sensible date, ceil = latest sensible date.
    A real date shown in a month-first format (mm-dd-yy, m/d/yyyy) is one Excel converted from typed dd/mm
    text: day and month are swapped back when that gives a date that fits (1.12.1)."""
    d, is_text = _as_date(value)
    if d is None:
        return None, (f"date '{value}' not readable" if value not in (None, "") else None)
    if is_text:                      # typed text, day-first, taken as written
        return d, None
    fmt = str(number_format or "").lower()
    month_first = fmt.startswith(("mm-dd", "m/d", "mm/dd", "m-d")) and d.day <= 12
    ok0 = lambda x: x is not None and (floor is None or x >= floor) and (ceil is None or x <= ceil)
    if month_first:
        s = _swap(d)
        if s and s != d and ok0(s):
            return s, f"{d:%d-%b-%Y} read as {s:%d-%b-%Y} (typed day-first, Excel stored it month-first)"
    ok = lambda x: x is not None and (floor is None or x >= floor) and (ceil is None or x <= ceil)
    if ok(d):
        return d, None
    s = _swap(d)
    if ok(s) and s != d:
        return s, f"{d:%d-%b-%Y} read as {s:%d-%b-%Y} (Excel swapped day and month)"
    return d, f"{d:%d-%b-%Y} breaks the date sequence and no day/month swap fits; kept as written"


# ---------------------------------------------------------------------------- dome / numbers
def _num(v):
    if isinstance(v, bool) or v is None or v == "":
        return None
    if isinstance(v, (int, float)):
        return float(v)
    try:
        return float(str(v).replace(",", "").strip())
    except ValueError:
        return None


def norm_dome(name):
    s = re.sub(r"\s+", " ", str(name or "")).strip()
    m = DOME_RE.match(s)
    return (f"{m[1].upper()} {int(m[2]):02d}", True) if m else (s.upper(), False)


def norm_vessel(text):
    s = re.sub(r"\s+", " ", str(text or "")).strip()
    s = re.sub(r"\s*/\s*", " / ", s)
    return s


def vessel_key(text):
    return re.sub(r"[^A-Z0-9]", "", str(text or "").upper())


# ---------------------------------------------------------------------------- parse
class Barging:
    def __init__(self, path):
        self.path = path
        self.trips = []        # dicts
        self.issues = []       # (severity, check, message)
        self.report_date = None

    def add(self, sev, check, msg):
        self.issues.append((sev, check, msg))


def _sheets(wb, cfg):
    """[(worksheet, contractor | None, si_format | None, label)]. A sheet whose name or title cell names a
    contractor key of cfg barge_sheets (e.g. VMM, FMI) gets that contractor; else the one-sheet layout."""
    conf = (cfg or {}).get("barge_sheets", {})
    out = []
    for ws in wb.worksheets:
        title = ""
        for row in ws.iter_rows(min_row=1, max_row=4, max_col=4, values_only=True):
            for v in row:
                if isinstance(v, str) and "REALISASI BARGING" in v.upper():
                    title = v.upper()
        if not (title or ws.title == SHEET_NAME or "REALISASI BARGING" in ws.title.upper()):
            continue
        hay = f"{ws.title.upper()} {title}"
        hit = [k for k in conf if re.search(rf"\b{re.escape(k.upper())}\b", hay)]
        if len(hit) == 1:
            c = conf[hit[0]]
            out.append((ws, c["contractor"], c.get("si_format"), hit[0]))
        else:
            out.append((ws, None, None, ws.title))
    return out


def parse(path, today=None, cfg=None):
    import openpyxl
    out = Barging(path)
    today = today or dt.date.today()
    wb = openpyxl.load_workbook(path, data_only=True, read_only=False)
    sheets = _sheets(wb, cfg)
    if not sheets:
        out.add("ERROR", "not-barging", "no Realisasi Barging sheet found")
        return out
    named = [s for s in sheets if s[1]]
    if named and len(named) < len(sheets):
        for ws, _, _, label in sheets:
            if ws not in [n[0] for n in named]:
                out.add("ERROR", "sheet-contractor", f"sheet '{ws.title}' does not name a known contractor "
                        f"({', '.join((cfg or {}).get('barge_sheets', {}))}); it is skipped")
        sheets = named
    for ws, contractor, si_format, label in sheets:
        _parse_sheet(out, ws, today, contractor, si_format, label if contractor else "")
    dates = [d for t in out.trips for d in (t["load"], t["finish"]) if d]
    out.report_date = max(dates) if dates else None
    if out.report_date is None:
        out.add("ERROR", "no-dates", "no load or finish date in the workbook")
    return out


def _parse_sheet(out, ws, today, contractor, si_format, sheet_label):
    pre = f"{sheet_label} " if sheet_label else ""

    # header columns by label (rows 3-4)
    col = {}
    for r in (3, 4):
        for c in range(1, ws.max_column + 1):
            v = ws.cell(r, c).value
            if isinstance(v, str):
                col.setdefault(re.sub(r"\s+", " ", v.strip()).upper(), c)
    need = {"KAPAL": "vessel", "LOAD": "load", "FINISH": "finish", "BARGING": "trip", "DOME": "dome",
            "TONNAGE": "ton", "FINAL DRAUGHT": "draught"}
    pos = {}
    for label, key in need.items():
        if label not in col:
            out.add("ERROR", "header", f"column '{label}' not found in rows 3-4; sheet layout changed")
        else:
            pos[key] = col[label]
    gpos = {g: col[g.upper()] for g in GRADE_COLS if g.upper() in col}
    if len(pos) < len(need):
        return

    # trip blocks
    starts = []
    for r in range(5, ws.max_row + 1):
        m = TRIP_RE.match(str(ws.cell(r, pos["trip"]).value or ""))
        if m:
            starts.append((r, int(m[1])))
    if not starts:
        out.add("ERROR", "no-trips", f"{pre}no 'Ke-n' rows found in sheet '{ws.title}'")
        return
    # vessels listed without a trip number (planned / just started): not staged, but said
    for r in range(5, ws.max_row + 1):
        v = ws.cell(r, pos["vessel"]).value
        if v not in (None, "") and not TRIP_RE.match(str(ws.cell(r, pos["trip"]).value or "")):
            ld, _ = _as_date(ws.cell(r, pos["load"]).value)
            out.add("WARN" if ld else "INFO", "no-trip-number",
                    f"{pre}{norm_vessel(v)} (row {r}) has no 'Ke-n' trip number"
                    + (" but a load date; it is not staged until the site gives it a number" if ld else "; not staged (planned)"))
    seen = set()
    prev_load = None
    for i, (r0, n) in enumerate(starts):
        r1 = (starts[i + 1][0] if i + 1 < len(starts) else ws.max_row + 1)
        if n in seen:
            out.add("ERROR", "duplicate-trip", f"{pre}Ke-{n} appears twice (row {r0}); the second block is skipped")
            continue
        seen.add(n)
        vessel = norm_vessel(ws.cell(r0, pos["vessel"]).value)
        if not vessel:
            has_ton = _num(ws.cell(r0, pos["draught"]).value) is not None or any(
                _num(ws.cell(r, pos["ton"]).value) for r in range(r0, r1))
            if has_ton:
                out.add("ERROR", "no-vessel", f"{pre}Ke-{n} (row {r0}) has tonnage but no tug/barge name; trip skipped")
            else:
                out.add("WARN", "no-vessel", f"{pre}Ke-{n} (row {r0}) has no tug/barge name and no tonnage "
                        "(looks like a copied block); skipped")
            continue
        cl, cf = ws.cell(r0, pos["load"]), ws.cell(r0, pos["finish"])
        load, nl = _resolve(cl.value, prev_load, today + dt.timedelta(days=1), cl.number_format)
        fin, nf = _resolve(cf.value, load or prev_load, today + dt.timedelta(days=1), cf.number_format)
        for note in (nl, nf):
            if note:
                out.add("WARN", "date-fix", f"{pre}Ke-{n} {vessel}: {note}")
        if load and fin and fin < load:
            out.add("WARN", "finish-before-load", f"{pre}Ke-{n}: finish {fin:%d-%b-%Y} is before load {load:%d-%b-%Y}")
        if load:
            prev_load = load
        draught = _num(ws.cell(r0, pos["draught"]).value)
        domes = []
        for r in range(r0, r1):
            raw = ws.cell(r, pos["dome"]).value
            if raw in (None, ""):
                continue
            name, ok = norm_dome(raw)
            if not ok:
                out.add("WARN", "dome-name", f"Ke-{n}: dome '{raw}' (row {r}) does not look like EFO/ETO/TOS nn; kept as '{name}'")
            elif name.replace(" ", "") != re.sub(r"\s+", "", str(raw).upper()) and re.sub(r"\s+", " ", str(raw).upper()).strip() != name:
                out.add("INFO", "dome-name", f"Ke-{n}: dome '{raw}' (row {r}) written as '{name}'")
            rec = {"dome": name, "tonnage": _num(ws.cell(r, pos["ton"]).value), "row": r}
            for g, c in gpos.items():
                rec[g] = _num(ws.cell(r, c).value)
            domes.append(rec)
        tons = [d["tonnage"] for d in domes if d["tonnage"] is not None]
        dsum = round(sum(tons), 2) if tons else None
        if draught is not None and dsum is not None and abs(draught - dsum) > max(1.0, 0.0005 * draught):
            out.add("WARN", "draught-vs-domes",
                    f"Ke-{n}: final draught {draught:,.2f} t vs sum of dome tonnage {dsum:,.2f} t (diff {draught - dsum:+,.2f}); draught used")
        if draught is None and dsum:
            out.add("WARN", "no-draught", f"Ke-{n}: no final draught; sum of dome tonnage {dsum:,.2f} t used as ACTUAL CAPACITY")
        actual = draught if draught is not None else dsum
        if fin and not actual:
            out.add("WARN", "finish-no-tonnage", f"Ke-{n}: finish date {fin:%d-%b-%Y} but no tonnage")
        if fin and not load:
            out.add("WARN", "finish-no-load", f"Ke-{n}: finish date without load date")
        status = "Completed" if (fin and actual) else ("Loading" if load else "TBI")
        out.trips.append({"n": n, "row": r0, "vessel": vessel, "load": load, "finish": fin, "actual": actual,
                          "dome_sum": dsum, "status": status, "domes": domes,
                          "contractor": contractor, "si_format": si_format, "sheet": ws.title, "label": sheet_label})


def weighted(domes, g):
    num = den = 0.0
    for d in domes:
        if d.get(g) is not None and d.get("tonnage"):
            num += d[g] * d["tonnage"]
            den += d["tonnage"]
    return round(num / den, 3) if den else None


# ---------------------------------------------------------------------------- stage
def stage(run, barging, source_name=""):
    """Turn the parsed trips into tblRAWBARGE staged rows through the same latest-state logic as WKM/BM
    (dr_to_master.t_barge): new SI added, existing SI overwritten with a WARN per field, status never backwards."""
    import dr_to_master as dm

    cfg = run.cfg
    T = "tblRAWBARGE"
    if T not in run.m.tables:
        run.L("ERROR", barging.report_date, T, "no-table", "tblRAWBARGE not found in the master; barge list not staged")
        return
    d = barging.report_date
    for sev, check, msg in barging.issues:
        run.L(sev, d, T, "barge-" + check, (f"{source_name}: " if source_name else "") + msg)
    if d is None:
        return

    fmt = cfg.get("barge_si_format", "{n:03d}-TMS")
    contractor = cfg.get("barge_contractor") or cfg.get("contractor_site") or ""
    status_map = cfg.get("barge_status_map", {})

    # master rows -> lookup by vessel + start date (adopt the master SI) and by SI (collision check)
    by_vessel, by_si = {}, {}
    for r in run.m.rows(T):
        k = dm._si_key(r.get("SI"))
        if not k:
            continue
        by_si[k] = r
        sd = dm.as_date(r.get("STARTDATE"))
        by_vessel[(vessel_key(r.get("VESSEL/BARGE")), sd)] = r.get("SI")

    barges, doms = [], []
    for t in barging.trips:
        adopted = by_vessel.get((vessel_key(t["vessel"]), t["load"])) if t["load"] else None
        t_fmt = t.get("si_format") or fmt
        t_con = t.get("contractor") or contractor
        tag = f"{t['label']} " if t.get("label") else ""
        si = str(adopted) if adopted else t_fmt.format(n=t["n"])
        if adopted:
            run.L("INFO", d, T, "barge-si", f"{tag}Ke-{t['n']} {t['vessel']}: matches master SI {si} (same vessel and start date)")
        else:
            cur = by_si.get(dm._si_key(si))
            if cur is not None:
                same_v = vessel_key(cur.get("VESSEL/BARGE")) == vessel_key(t["vessel"])
                if not same_v and t["load"] and dm.as_date(cur.get("STARTDATE")) != t["load"]:
                    run.L("ERROR", d, T, "barge-si-collision",
                          f"SI {si} ({tag}Ke-{t['n']} {t['vessel']}, load {t['load']}) already belongs to "
                          f"{cur.get('VESSEL/BARGE')} (start {_fmt_date(cur.get('STARTDATE'))}) in the master. Trip not staged. "
                          "Change the si_format in config_tms.json (barge_sheets) or rename the SI in the master.")
                    continue
            run.L("INFO", d, T, "barge-si", f"{tag}Ke-{t['n']} {t['vessel']}: SI {si} (format {t_fmt}; no matching vessel and start date in the master)")
        barges.append({"si": si, "vessel": t["vessel"], "contractor": t_con, "start": t["load"], "finish": t["finish"],
                       "plan_cap": None, "actual_cap": t["actual"], "grade_plan": None,
                       "status": status_map.get(t["status"].upper(), t["status"])})
        for dm_ in t["domes"]:
            row = {"SI": si, "CONTRACTOR": t_con, "TRIP": f"Ke-{t['n']}", "VESSEL/BARGE": t["vessel"], "DOME": dm_["dome"], "TONNAGE": dm_["tonnage"]}
            for g in GRADE_COLS:
                row[g] = dm_.get(g)
            doms.append(row)
        if t["domes"]:
            run.review["BARGE_TRIPS"].append({
                "SI": si, "CONTRACTOR": t_con, "TRIP": f"Ke-{t['n']}", "VESSEL/BARGE": t["vessel"], "LOAD": t["load"], "FINISH": t["finish"],
                "STATUS": t["status"], "FINAL DRAUGHT T": t["actual"], "SUM DOME T": t["dome_sum"],
                "Ni % (wtd)": weighted(t["domes"], "Ni"), "Fe % (wtd)": weighted(t["domes"], "Fe"),
                "SiO2 % (wtd)": weighted(t["domes"], "SiO2"), "MgO % (wtd)": weighted(t["domes"], "MgO"),
                "NOT LOADED": "grades and dome tonnage have no tblRAWBARGE column"})
        else:
            run.review["BARGE_TRIPS"].append({
                "SI": si, "CONTRACTOR": t_con, "TRIP": f"Ke-{t['n']}", "VESSEL/BARGE": t["vessel"], "LOAD": t["load"], "FINISH": t["finish"],
                "STATUS": t["status"], "FINAL DRAUGHT T": t["actual"], "SUM DOME T": None})
    run.review["BARGE_DOMES"] = doms
    dm.t_barge(run, {"barges": barges}, d)
    run.L("INFO", d, T, "barge-source",
          f"{source_name or 'Realisasi Barging'}: {len(barging.trips)} trip(s) "
          f"({', '.join(f'{c} {n}' for c, n in sorted(__import__('collections').Counter(t.get('contractor') or contractor for t in barging.trips).items()))}), "
          f"{len(barges)} staged as SI; "
          f"completed {sum(t['status'] == 'Completed' for t in barging.trips)}, "
          f"in progress {sum(t['status'] == 'Loading' for t in barging.trips)}, "
          f"not started {sum(t['status'] == 'TBI' for t in barging.trips)}. "
          "tblRAWSHIP is NOT changed by this file (TMS shipment stays the DPR truck count).")


def _fmt_date(v):
    d = v.date() if isinstance(v, dt.datetime) else v
    return f"{d:%d-%b-%Y}" if isinstance(d, dt.date) else str(v)
