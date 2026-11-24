"""
bm_to_master.py
---------------
PT Bosowa Mining (Site Langgikima) Daily Report PDF  ->  staged rows for Master_Data_Site_BM.xlsm.

Same workflow and the same Run / staging / loader as WKM (dr_to_master): the BM parser
(bm_pdf_parser) reads the page, this module turns it into tblRAW* rows. Where the BM report
has the same meaning as WKM the WKM transform is reused (HSE, shipment finish-date rule,
barge latest-state rule, equipment, unit performance, weather/EWH, fuel stock chain, manpower,
plan check); BM-only rules are here:

  tblRAWMNG    one 'All' row per contractor with S/OB/Q (table DAY block) + one row per pit with
               H (SAP) or L (LIM) from the PRODUCTION PIT chart. Pit owner: history, else the
               contractor whose OreSap/Ore Lim DAY is not yet explained by known pits.
  tblRAWSTOCK  ETO and EFO, Saprolit -> H, Limonit -> L, Ni/Fe/Co/MgO/SiO2 + TONAGE.
  tblRAWHAUL   one row per contractor from the HAULING TO EFO chart.
  tblRAWHAZARD one '-' row per day (the BM report has no hazard list; matches the manual entries).
  tblRAWBARGE  SI matched ignoring leading zeros (022-ABEP = 22-ABEP), master spelling kept;
               a vessel name keyed truncated/upper-case in the master is kept.

CLI
  python bm_to_master.py --pdf "Daily_Report_BM_27_September.pdf" --master "Master_Data_Site_BM.xlsm"
  python bm_to_master.py --pdf reports_folder/ --master Master_Data_Site_BM.xlsm --out staging_BM.xlsx
"""
from __future__ import annotations

import argparse
import copy
import difflib
import datetime as dt
import hashlib
import json
import os
import re
import sys
from collections import defaultdict

import dr_to_master as DT
from bm_pdf_parser import PARSER_VERSION, parse_daily_report, parse_header, Page
from dr_to_master import Run, as_date, base_row, clean_num, fnum, period_starts
from dr_pdf_parser import norm

HERE = os.path.dirname(os.path.abspath(__file__))
MNG_CODES = ["S", "OB", "L", "M", "H", "Q"]


# ----------------------------------------------------------------------------- helpers
def _map_keys(run, d):
    """{pdf label: value} -> {contractor: value} (labels that do not map are kept as they are)."""
    return {(run.cmap(k) or k): v for k, v in (d or {}).items()}


def _si_norm(si):
    m = re.fullmatch(r"0*(\d+)\s*-\s*([A-Z]+)", str(si or "").strip().upper())
    return f"{int(m[1])}-{m[2]}" if m else str(si or "").strip().upper()


def prepare(run, p, d):
    """BM parsed dict -> the shape the WKM transforms read (keys mapped to contractors where the
    WKM code looks values up by contractor)."""
    q = dict(p)
    cfg = run.cfg
    # sales: keyed by contractor (t_ship recon and t_plan both look up by contractor)
    if "sales" in p:
        q["sales"] = {per: {row: _map_keys(run, vals) for row, vals in rows.items()} for per, rows in p["sales"].items()}
    if "shipment_total" in p:
        st = dict(p["shipment_total"])
        st["YTD"] = st.get("YEAR")
        if st.get("DAY") is None:
            st["DAY"] = 0.0          # no label above the DAY bar = nothing shipped
        q["shipment_total"] = st
    # plan: TargetORE row of the production table
    mt = (p.get("mining") or {}).get("table") or {}
    plan = mt.get(cfg["mining_table"]["plan_row"])
    if plan:
        q["mining_plan"] = {"PLAN ORE": {per: {c: v for c, v in vals.items() if c != "TOTAL"} for per, vals in plan.items()}}
    # barges: master SI spelling, master vessel name when it is the same name keyed shorter
    if "barges" in p:
        T = "tblRAWBARGE"
        known = {}
        for r in run.m.rows(T):
            if r.get("SI"):
                known[_si_norm(r["SI"])] = r
        for r in run.stage.get(T, []):
            known[_si_norm(r["SI"])] = r
        out = []
        for b in p["barges"]:
            b = dict(b)
            cur = known.get(_si_norm(b["si"]))
            if cur is not None:
                if str(cur["SI"]) != b["si"]:
                    b["_pdf_si"] = b["si"]
                    b["si"] = DT._si_key(cur["SI"])
                mv, pv = cur.get("VESSEL/BARGE"), b.get("vessel")
                if mv and pv and norm(pv) != norm(mv):
                    if norm(pv).startswith(norm(mv)):          # keyed shorter in the master
                        b["vessel"] = mv
                    elif difflib.SequenceMatcher(None, norm(pv), norm(mv)).ratio() >= 0.9:   # one-letter typo
                        run.L("INFO", d, T, "vessel", f"SI {cur['SI']}: vessel '{pv}' in the PDF vs '{mv}' in the master - "
                              "almost the same, master spelling kept")
                        b["vessel"] = mv
                elif mv and pv:
                    b["vessel"] = mv
            out.append(b)
        q["barges"] = out
    # equipment / unit performance / fuel / manpower keep their PDF labels (the WKM code maps them)
    if "fuel" in p:
        q["fuel"] = {k: {kk: vv for kk, vv in v.items()} for k, v in p["fuel"].items()}
    if "manpower" in p:
        q["manpower"] = copy.deepcopy(p["manpower"])
    return q


# ----------------------------------------------------------------------------- transforms
def t_hse(run, p, d):
    T = "tblRAWHSE"
    n0 = len(run.stage.get(T, []))
    DT.t_hse(run, p, d)
    for r in run.stage.get(T, [])[n0:]:
        for col, v in (run.cfg.get("hse_fixed") or {}).items():
            if col in r and r[col] is None:
                r[col] = v
    if "hse" in p and p["hse"].get("missing_rows"):
        run.L("WARN", d, T, "missing", f"HSE rows not found in the PDF: {p['hse']['missing_rows']} - staged as 0")


def t_hazard(run, p, d):
    T = "tblRAWHAZARD"
    if not run.cfg.get("hazard_placeholder"):
        return
    r = base_row(run, T, d)
    for c in ("HAZARD LOCATION", "IDENTIFIED HAZARD", "CORRECTIVE ACTION", "REPAIR STATUS", "RISK LEVEL", "HAZARD CATEGORY", "REMARKS"):
        if c in r:
            r[c] = "-"
    run.add(T, r, d)
    run.L("INFO", d, T, "placeholder", "the BM report has no hazard list - one '-' row staged (as keyed by hand)")


def _pit_owners(run):
    """pit (as text) -> contractor of its latest tblRAWMNG row with H or L > 0."""
    T = "tblRAWMNG"
    last = {}
    for r in sorted(run.m.rows(T), key=lambda r: as_date(r.get("DATE")) or dt.date.min):
        pit = r.get("PIT")
        if pit in (None, "", run.cfg["mng_all_pit_label"]):
            continue
        if fnum(r.get("H-DAY")) > 0 or fnum(r.get("L-DAY")) > 0 or fnum(r.get("M-DAY")) > 0:
            last[str(pit).strip()] = r.get("CONTRACTOR")
    last.update({str(k): v for k, v in (run.cfg.get("pit_contractor_override") or {}).items()})
    return last


def t_mng(run, p, d):
    T = "tblRAWMNG"
    cfg = run.cfg
    if "mining" not in p:
        run.L("ERROR", d, T, "missing", "production table not parsed - tblRAWMNG NOT staged")
        return
    tab = p["mining"]["table"]
    rows = cfg["mining_table"]["rows"]           # label -> code
    ctrs = cfg["contractors"]
    day = {c: {} for c in ctrs}                  # contractor -> code -> table DAY value
    for lab, code in rows.items():
        if code == "PLAN" or lab not in tab:
            continue
        for c in ctrs:
            day[c][code] = (tab[lab].get("DAY") or {}).get(c)
    # 1. 'All' rows
    for c in ctrs:
        r = base_row(run, T, d, c)
        r["PIT"] = cfg["mng_all_pit_label"]
        for code in MNG_CODES:
            r[f"{code}-DAY"] = 0
        for code in cfg["mng_all_row_cols"]:
            r[f"{code}-DAY"] = clean_num(day[c].get(code) or 0)
        if run.vocab_ok(d, T, "CONTRACTOR", c, "tblIDCONTRACTOR"):
            run.add(T, r, d)
    # 2. pit rows from the chart
    pc = p.get("pit_chart")
    if pc is None:
        if any(day[c].get(k) for c in ctrs for k in ("H", "L")):
            run.L("ERROR", d, T, "pit-chart", "PRODUCTION PIT chart not read but the table shows ore today - pit rows NOT staged")
        return
    cats = {c["label"]: c for c in cfg["pit_chart"]["categories"]}
    owners = _pit_owners(run)
    known, unknown = [], []
    for lab, v in pc["values"].items():
        cat = cats[lab]
        own = owners.get(str(cat["pit"]))
        (known if own else unknown).append((cat, v, own))
    resid = {(c, k): (day[c].get(k) or 0.0) for c in ctrs for k in ("H", "L")}
    for cat, v, own in known:
        if own in ctrs:
            resid[(own, cat["class"])] -= v
    placed = list(known)
    for cat, v, _ in unknown:
        tol = max(run.cfg["tolerance_abs"] + 1.0, 0.005 * v)
        cand = [c for c in ctrs if abs(resid[(c, cat["class"])] - v) <= tol]
        if len(cand) == 1:
            own = cand[0]
            resid[(own, cat["class"])] -= v
            run.L("WARN", d, T, "pit-owner", f"pit {cat['pit']} has no history - assigned to {own} because its "
                  f"{'OreSap' if cat['class'] == 'H' else 'Ore Lim'} DAY matches the bar ({v:,.2f}). "
                  "Add it to config pit_contractor_override if this is permanent", v)
            placed.append((cat, v, own))
        else:
            run.L("ERROR", d, T, "pit-owner", f"pit {cat['pit']} ({cat['label']} {v:,.2f}) has no history and the contractor "
                  f"cannot be worked out from the table (candidates {cand or 'none'}) - pit row NOT staged. "
                  "Set config pit_contractor_override or add the row in step 3", v)
    by_key = {}
    for cat, v, own in placed:
        k = (str(cat["pit"]), own)
        if k not in by_key:
            r = base_row(run, T, d, own)
            r["PIT"] = cat["pit"]
            for code in MNG_CODES:
                r[f"{code}-DAY"] = 0
            by_key[k] = r
        by_key[k][f"{cat['class']}-DAY"] = clean_num(round(by_key[k][f"{cat['class']}-DAY"] + v, 4))
    for (pit, own), r in by_key.items():
        run.vocab_ok(d, T, "PIT", str(r["PIT"]), "tblIDPIT", level="WARN")
        if run.vocab_ok(d, T, "CONTRACTOR", own, "tblIDCONTRACTOR"):
            run.add(T, r, d)
    # 3. chart vs table (the table prints whole tonnes)
    for c in ctrs:
        for k, lab in (("H", "OreSap"), ("L", "Ore Lim")):
            tv = day[c].get(k) or 0.0
            cv = sum(v for cat, v, own in placed if own == c and cat["class"] == k)
            if abs(tv - cv) > max(1.0, 0.005 * max(tv, cv)):
                run.L("WARN", d, T, "pit-vs-table", f"{c}: {lab} DAY in the table {tv:,.0f} vs sum of pit bars {cv:,.2f} "
                      "(pit rows follow the chart)", cv, tv)
    if "axis" in pc.get("how", ""):
        run.L("INFO", d, T, "pit-chart", pc["how"])
    # 4. month / year against master history + today
    m0, y0 = period_starts(d)
    for lab, code in rows.items():
        if code == "PLAN" or lab not in tab:
            continue
        for per, start in (("MONTH", m0), ("YEAR", y0)):
            for c in ctrs:
                pv = (tab[lab].get(per) or {}).get(c)
                today = sum(fnum(r.get(f"{code}-DAY")) for r in run.stage.get(T, [])
                            if r.get("CONTRACTOR") == c and as_date(r.get("DATE")) == d)
                prior = run.m.sum_between(T, f"{code}-DAY", start, d, CONTRACTOR=c)
                run.recon(d, T, f"{c} {lab} {per}", pv if pv is not None else 0.0, prior + today,
                          note="report prints whole tonnes")


def t_stock(run, p, d):
    T = "tblRAWSTOCK"
    if "stock" not in p:
        return
    sc = run.cfg["stock"]
    for blk, c in sc["blocks"].items():
        b = p["stock"].get(blk)
        if not b:
            run.L("ERROR", d, T, "missing", f"{blk} not parsed - {c} stock NOT staged")
            continue
        r = base_row(run, T, d, c)
        for lab, cls in sc["rows"].items():
            vals = b["rows"].get(lab)
            if vals is None:
                run.L("WARN", d, T, "missing", f"{c}: stock row '{lab}' not found")
                continue
            for (g, side), v in vals.items():
                col = f"{side}-{cls}-{'TONAGE' if g == 'TONNAGE' else g}"
                if col not in r:
                    continue
                r[col] = clean_num(v)
                if v is not None and g != "TONNAGE" and not (0 <= v <= 100):
                    run.L("WARN", d, T, "range", f"{c} {col} = {v:g} is not a % grade (number format?) - check", v)
                if v is not None and g == "Ni" and v > 5:
                    run.L("WARN", d, T, "range", f"{c} {col} = {v:g}% Ni is unusual for laterite - check the decimal mark", v)
        if run.vocab_ok(d, T, "CONTRACTOR", c, "tblIDCONTRACTOR"):
            run.add(T, r, d)
    run.L("INFO", d, T, "note", "ETO/EFO stock staged (Saprolit -> H, Limonit -> L); MC and M/LB/WS/WA columns are not in the BM report")


def t_haul(run, p, d):
    T = "tblRAWHAUL"
    h = p.get("hauling")
    if h is None:
        run.L("ERROR", d, T, "missing", "HAULING TO EFO chart not parsed - hauling NOT staged")
        return
    got = _map_keys(run, h)
    for c in run.cfg["contractors"]:
        if c not in got:
            run.L("WARN", d, T, "missing", f"{c}: no bar in HAULING TO EFO - staged as 0")
        r = base_row(run, T, d, c)
        r["DAY"] = clean_num(got.get(c) or 0)
        run.add(T, r, d)


def t_ship(run, p, d):
    DT.t_ship(run, p, d)


def t_barge(run, p, d):
    for b in p.get("barges", []):
        if b.get("_pdf_si"):
            run.L("INFO", d, "tblRAWBARGE", "si", f"PDF SI {b['_pdf_si']} = master SI {b['si']} (leading zero) - master spelling kept")
    DT.t_barge(run, p, d)


def t_ship_sync(run, p, d):
    DT.t_ship_sync(run, p, d)       # SHIP follows the latest barge list; BM contractors (AJB, SLS, SHES) come from ship_contractors


def t_eq(run, p, d):
    T = "tblRAWEQ"
    n0 = len(run.stage.get(T, []))
    DT.t_eq(run, p, d)
    fill = run.cfg.get("eq_zero_fill") or []
    for r in run.stage.get(T, [])[n0:]:
        for pre in ("OP", "S", "B"):
            for col in fill:
                k = f"{pre}-{col}"
                if k in r and r[k] is None:
                    r[k] = 0


def t_up(run, p, d):
    """WKM rule: a unit class with every KPI 0% (no unit working) is left blank. config up_all_zero = "zero"
    writes the 0s instead (that is how the BM master was keyed by hand up to Sep-2026)."""
    T = "tblRAWUP"
    n0 = len(run.stage.get(T, []))
    DT.t_up(run, p, d)
    zero = run.cfg.get("up_all_zero", "blank") == "zero"
    staged = {r.get("CONTRACTOR"): r for r in run.stage.get(T, [])[n0:]}
    for hdr, rec in (p.get("unit_perf") or {}).items():
        c = run.cmap(hdr)
        empty = [u for u, vals in rec["units"].items() if all((v or 0) == 0 for v in vals.values())]
        if not empty:
            continue
        if zero and c in staged:
            for u in empty:
                for k in rec["units"][u]:
                    staged[c][f"{u}-{k}"] = 0
        elif len(empty) == len(rec["units"]):
            run.L("INFO", d, T, "zero", f"{c}: every PA/MA/UA/EU is 0% (no operation) - left blank so averages are not "
                  "pulled down (config up_all_zero = \"zero\" writes 0 as keyed by hand)")


def t_wewh(run, p, d):
    DT.t_wewh(run, p, d)


def t_fuel(run, p, d):
    T = "tblRAWFUEL"
    if "fuel" not in p:
        return
    hist = run.m.contractors(T)
    q = dict(p)
    q["fuel"] = {}
    for lab, rec in p["fuel"].items():
        c = run.cmap(lab)
        if not c:
            run.L("ERROR", d, T, "contractor", f"fuel company '{lab}' not in contractor_map")
            continue
        if c not in hist and not any(v for v in rec.values()):
            run.L("INFO", d, T, "skip", f"{lab} -> {c}: all '-' and no history in {T} - row not staged")
            continue
        q["fuel"][lab] = rec
    n0 = len(run.stage.get(T, []))
    DT.t_fuel(run, q, d)
    if run.cfg.get("fuel_zero_add_blank"):
        for r in run.stage.get(T, [])[n0:]:
            if r.get("STOCK ADD") == 0:
                r["STOCK ADD"] = None


def t_mp(run, p, d):
    T = "tblRAWMP"
    if "manpower" not in p:
        return
    q = dict(p)
    q["manpower"] = {}
    cats = ("MANAGER", "SPT", "SPV", "DRIVER", "OPERATOR", "ETC")
    for lab, rec in p["manpower"].items():
        rec = dict(rec)
        if run.cfg.get("mp_total_to_etc_when_blank") and all(rec.get(k) is None for k in cats) and (rec.get("TOTAL") or 0) > 0:
            rec["ETC"] = rec["TOTAL"]
            run.L("INFO", d, T, "etc", f"{lab}: only TOTAL {rec['TOTAL']:g} printed - written to ETC (as keyed by hand)")
        q["manpower"][lab] = rec
    DT.t_mp(run, q, d)


def t_plan(run, p, d):
    DT.t_plan(run, p, d)


TRANSFORMS = [t_hse, t_hazard, t_mng, t_stock, t_haul, t_ship, t_barge, t_ship_sync, t_eq, t_up, t_wewh, t_fuel, t_mp, t_plan]
SOFT_SECTIONS = {"note", "sales", "shipment_total"}


def _quiet_repeats(run, start):
    """A month/year gap between the report and the master that is the SAME as in the previous report of this
    run is an old gap, not a new problem: keep it once as RECON, then INFO. Same for repeated window checks."""
    seen = getattr(run, "_recon_gap", {})
    run._recon_gap = seen
    for x in run.log[start:]:
        if x["severity"] == "RECON":
            label = x["message"].split(":")[0]
            key = (x["table"], label)
            gap = x["diff"] if x["diff"] is not None else (x["pdf_value"] or 0) - (x["master_value"] or 0)
            prev = seen.get(key)
            seen[key] = gap
            if prev is not None and abs(prev - gap) <= run.tol(x["pdf_value"] or 0):
                x["severity"] = "INFO"
                x["check"] = "reconcile-same"
                x["message"] += " - same gap as the previous report (old difference in the master history)"
        elif x["severity"] == "WARN" and x["check"] in ("window", "population"):
            key = (x["table"], x["check"], x["message"].split(":")[0], x["pdf_value"], x["master_value"])
            if key in seen:
                x["severity"] = "INFO"
                x["message"] += " (repeated from the previous report)"
            seen[key] = True


def report_date(pdf_path):
    import pdfplumber
    with pdfplumber.open(pdf_path) as pdf:
        return parse_header(Page(pdf.pages[0]))


def process_pdf(run, pdf_path, display_name=None):
    parsed, errors = parse_daily_report(pdf_path, run.cfg)
    d = parsed["meta"]["report_date"]
    for sec, msg in errors:
        run.L("WARN" if sec in SOFT_SECTIONS else "ERROR", d, sec, "parse", msg)
    must = (run.cfg.get("site_text_must_contain") or "").upper()
    if must and must not in (parsed["meta"].get("site_text") or "").upper():
        run.L("WARN", d, "-", "site", f"PDF header site '{parsed['meta'].get('site_text')}' does not look like {run.cfg['site']}")
    have = []
    for tn in DT.STAGE_ORDER:
        if tn == "tblRAWBARGE":
            continue
        n = len(run.m.rows_on(tn, d))
        if n:
            run.preexisting.add((tn, d))
            have.append(f"{tn.replace('tblRAW', '')} {n}")
    if have:
        run.L("WARN", d, "(all)", "exists", f"the master already has rows for {d} in {len(have)} table(s) ({', '.join(have)}). "
              "Skip mode leaves them as they are; Replace mode deletes and reloads them")
    q = prepare(run, parsed, d)
    n_log = len(run.log)
    for fn in TRANSFORMS:
        try:
            fn(run, q, d)
        except Exception as e:      # one table failing must not kill the others
            run.L("ERROR", d, fn.__name__, "transform", f"{type(e).__name__}: {e}")
    _quiet_repeats(run, n_log)
    h = hashlib.sha256(open(pdf_path, "rb").read()).hexdigest()[:16]
    run.meta.append({"report_date": d, "pdf": display_name or os.path.basename(pdf_path), "sha256_16": h,
                     "parse_errors": len(errors), "note": parsed.get("note") or ""})
    return parsed


# ----------------------------------------------------------------------------- CLI
def main(argv=None):
    ap = argparse.ArgumentParser(description="BM Daily Report PDF -> Master Data BM staging workbook")
    ap.add_argument("--pdf", nargs="+", required=True, help="PDF file(s), glob or folder")
    ap.add_argument("--master", required=True, help="Master_Data_Site_BM.xlsm (read-only)")
    ap.add_argument("--out", help="staging .xlsx (default: staging_BM_<date>.xlsx next to the first PDF)")
    ap.add_argument("--config", default=os.path.join(HERE, "config_bm.json"))
    a = ap.parse_args(argv)
    cfg = json.load(open(a.config, encoding="utf-8"))
    pdfs = DT.collect_pdfs(a.pdf)
    if not pdfs:
        sys.exit("no PDF found")
    print(f"reading master {a.master} ...")
    run = Run(cfg, DT.Master(a.master))
    dated = sorted((report_date(f)["report_date"], f) for f in pdfs)
    for d, f in dated:
        print(f"parsing {os.path.basename(f)}  ({d})")
        process_pdf(run, f)
    out = a.out or os.path.join(os.path.dirname(os.path.abspath(dated[0][1])),
                                f"staging_BM_{dated[0][0]}" + (f"_to_{dated[-1][0]}" if len(dated) > 1 else "") + ".xlsx")
    DT.write_staging(run, out, a.master, generator="bm_to_master.py")
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
