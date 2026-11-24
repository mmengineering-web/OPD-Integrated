"""
master_export.py
----------------
Master workbook (tblRAW* tables, as saved by Excel)  ->  rows for the site Supabase project:

    prod_v2.fact_production_actual   long layout: date, site, pit, contractor, category,
                                     metric_group, metric, value, text_value, shift
    prod_v2.fact_barge               one row per SI (tblRAWBARGE)

The unpivot rules are a straight port of mining_etl_automation2\\build_actual.py and the barge part
of build_plan_barge.py, which replaced qry_EXPORT_LOOKER / qry_BARGEALL and fed prod_v2 until
2026-09. Same column names, same METRIC_GROUP/METRIC splitting, same null handling, so the rows
match the history that is already in Supabase.

Why read the master and not the staged rows of the load:
  WKM and BM are "stored totals" sites. DTOT..YTOT, DALL..YALL and WTD/MTD/YTD are Excel formula
  columns. They only exist after Excel has recalculated and saved the master, so the export
  reads the master *after* a verified load (cached values, openpyxl data_only).

Differences from build_actual.py (deliberate, documented):
  * Rows are filtered to one site (the site of the master) and to a date window.
  * HAZARD and CONS ("direct" shapes) keep every source row, as in build_actual. PIT stays blank
    (1.11.0; 1.7.1 to 1.10.0 put HAZARD LOCATION / AREA into pit). The location, area, item and
    remarks are in text_value, as in build_actual. CONS metric = CONSTRUCTION ITEM (build_actual:
    the constant 'PROGRESS'), value = PROGRESS. The site key must include text_value
    (sql/site_key_text_value.sql); rows equal on all of it get "(2)", "(3)" at the end of text_value.
  * "derive" sites (TMS): the stored DTOT..YTOT / DALL..YALL columns are not uploaded, because the
    site view fact_production_actual_period and the hub add them from the DAY rows (they would
    be counted twice).
  * Numbers keep full precision. stage_raw's CSV cut them to 10 significant digits, so a re-upload
    of old dates can show small "changed" counts in the 5th-6th decimal of large cumulative values.
  * A DATE with a time part (the app 1.0 UTC+7 shift) counts as the nearest day, like the app's reader.
"""
from __future__ import annotations

import datetime as dt
import logging

import numpy as np
import pandas as pd

log = logging.getLogger("master_export")

OUT_COLS = ["date", "site", "pit", "contractor", "category",
            "metric_group", "metric", "value", "text_value", "shift"]
ID_COLS = ["DATE", "SITE", "PIT", "CONTRACTOR", "CATEGORY", "SHIFT"]
COMMON_DROP = ["INPUT DATE", "YEAR", "WEEK", "MONTH"]
KEY7 = ["date", "site", "pit", "contractor", "category", "metric_group", "metric", "shift"]
KEY8 = KEY7 + ["text_value"]

BARGE_COLS = ["si", "month_name", "vessel_barge", "capacity", "contractor", "start_date", "finish_date",
              "plan_capacity", "actual_capacity", "wtd", "mtd", "ytd", "grade_plan", "grade_actual",
              "status", "input_date", "year_month", "month_week", "week", "site"]


# ==========================================================================
# cell -> text, exactly like stage_raw.fmt() (build_actual parsed these strings)
# ==========================================================================
def fmt(v) -> str:
    if v is None:
        return ""
    if isinstance(v, bool):
        return "TRUE" if v else "FALSE"
    if isinstance(v, dt.datetime):
        if v.hour == v.minute == v.second == 0:
            return v.date().isoformat()
        return v.isoformat(sep=" ")
    if isinstance(v, dt.date):
        return v.isoformat()
    if isinstance(v, float):
        if v != v or v in (float("inf"), float("-inf")):
            return ""
        if v == int(v) and abs(v) < 1e15:
            return str(int(v))
        return repr(v)          # full precision (stage_raw cut to 10 significant digits)
    return str(v)


def _s(x) -> pd.Series:
    return x.fillna("").astype(str)


_EXCEL_EPOCH = pd.Timestamp("1899-12-30")


def parse_dates(col: pd.Series) -> pd.Series:
    """ISO text first, then Excel serial numbers (build_actual.parse_dates)."""
    s = _s(col).str.strip()
    out = pd.to_datetime(s, errors="coerce", format="mixed")
    bad = out.isna() & (s != "")
    if bad.any():
        num = pd.to_numeric(s[bad], errors="coerce")
        ok = num.between(20000, 60000)
        if ok.any():
            out.loc[num[ok].index] = _EXCEL_EPOCH + pd.to_timedelta(num[ok].round(0), unit="D")
    # a date with a time part (app 1.0 shift) counts as that day, like the app's own reader
    out = out.dt.normalize() + pd.to_timedelta((out.dt.hour >= 12).astype("float"), unit="D")
    return out.dt.date


# ==========================================================================
# METRIC_GROUP / METRIC rules (build_actual.py)
# ==========================================================================
def split_first(raw):
    s = _s(raw)
    has = s.str.contains("-", regex=False)
    p = s.str.split("-", n=1, expand=True)
    before = p[0] if p.shape[1] > 0 else s
    after = p[1] if p.shape[1] > 1 else pd.Series("", index=s.index)
    return s, has, before.fillna(""), after.fillna("")


def split_last(raw):
    s = _s(raw)
    has = s.str.contains("-", regex=False)
    p = s.str.rsplit("-", n=1, expand=True)
    before = p[0] if p.shape[1] > 0 else s
    after = p[1] if p.shape[1] > 1 else pd.Series("", index=s.index)
    return s, has, before.fillna(""), after.fillna("")


def mk_hse(raw):
    s, has, b, a = split_first(raw)
    g = pd.Series(np.where(has, b, s), index=s.index)
    m = pd.Series(np.where(has, a, "DAY"), index=s.index)
    for key, (gg, mm) in {"LTI-MA": ("LTI-MA", "DAY"), "FATALITY": ("FT", "DAY")}.items():
        hit = s == key
        g[hit], m[hit] = gg, mm
    return g, m


def mk_mng(raw):
    s, has, b, a = split_first(raw)
    return (pd.Series(np.where(has, b, s), index=s.index),
            pd.Series(np.where(has, a, "VALUE"), index=s.index))


def mk_stock(raw):
    s, has, b, a = split_last(raw)
    return (pd.Series(np.where(has, b, s), index=s.index),
            pd.Series(np.where(has, a, "VALUE"), index=s.index))


def mk_eq(raw):
    s, has, b, a = split_first(raw)
    nospace = s.str.replace(" ", "", regex=False).str.upper()
    return (pd.Series(np.where(has, b, "POP"), index=s.index),
            pd.Series(np.where(has, a, nospace), index=s.index))


def mk_up(raw):
    s, has, b, a = split_first(raw)
    return b, a


def mk_ship(raw):
    s = _s(raw)
    return pd.Series("SHIP", index=s.index), s.str.upper()


def mk_haul(raw):
    s = _s(raw)
    return pd.Series("HAUL", index=s.index), s.str.upper()


def mk_fuel(raw):
    k = _s(raw).str.strip().str.upper()
    g = np.select([k.isin(["DAY", "WTD", "MTD"]), k.isin(["STOCK ADD", "STOCK"]), k == "FR"],
                  ["FUEL", "STOCK", "RATIO"], default="FUEL")
    return pd.Series(g, index=k.index), k


def mk_mp(raw):
    k = _s(raw).str.strip().str.upper()
    g = np.where(k.isin(["ADD", "RESIGN", "TOTAL"]), "FLOW", "ROLE")
    return pd.Series(g, index=k.index), k


def mk_wewh(raw):
    s = _s(raw)
    up = s.str.upper()
    is_plan = up.str.startswith("PLAN ")
    is_ewh = up == "EWH"
    g = np.select([is_plan, is_ewh], ["PLAN", "EWH"], default="ACTUAL")
    after_plan = s.str.split("PLAN ", n=1, expand=True)
    tail = (after_plan[1] if after_plan.shape[1] > 1 else pd.Series("", index=s.index)).fillna("").str.strip()
    m = np.select([is_plan, is_ewh], [tail, "VALUE"], default=s)
    return pd.Series(g, index=s.index), pd.Series(m, index=s.index)


RULES: dict[str, dict] = {
    "HSE":    dict(table="tblRAWHSE",    shape="unpivot", null_cols=["PIT"], fn=mk_hse),
    "MNG":    dict(table="tblRAWMNG",    shape="unpivot", null_cols=[], fn=mk_mng,
                   keep_groups=["S", "OB", "L", "M", "H", "Q"]),
    "STOCK":  dict(table="tblRAWSTOCK",  shape="unpivot", null_cols=["PIT"], fn=mk_stock),
    "SHIP":   dict(table="tblRAWSHIP",   shape="unpivot", null_cols=["PIT"], fn=mk_ship),
    "HAUL":   dict(table="tblRAWHAUL",   shape="unpivot", null_cols=["PIT"], fn=mk_haul),
    "FUEL":   dict(table="tblRAWFUEL",   shape="unpivot", null_cols=["PIT"], fn=mk_fuel),
    "EQ":     dict(table="tblRAWEQ",     shape="unpivot", null_cols=["PIT"], fn=mk_eq),
    "UP":     dict(table="tblRAWUP",     shape="unpivot", null_cols=["PIT"], fn=mk_up),
    "WEWH":   dict(table="tblRAWWEWH",   shape="unpivot", null_cols=["PIT"], fn=mk_wewh),
    "MP":     dict(table="tblRAWMP",     shape="unpivot", null_cols=["PIT"], fn=mk_mp),
    "LAB":    dict(table="tblRAWLAB",    shape="unpivot", null_cols=["PIT"], const_contractor="INTERNAL", fn=mk_mng),
    "HAZARD": dict(table="tblRAWHAZARD", shape="direct", null_cols=["PIT"], const_contractor="INTERNAL",
                   group_col="HAZARD CATEGORY", metric_col="REPAIR STATUS", value_const=1,
                   text_parts=[("LOCATION: ", "HAZARD LOCATION"), (" | HAZARD: ", "IDENTIFIED HAZARD"),
                               (" | ACTION: ", "CORRECTIVE ACTION"), (" | RISK: ", "RISK LEVEL"),
                               (" | REMARKS: ", "REMARKS")]),
    "CONS":   dict(table="tblRAWCONS",   shape="direct", null_cols=["PIT"], const_contractor="INTERNAL",
                   group_col="CONSCATEGORY", metric_col="CONSTRUCTION ITEM", value_col="PROGRESS",
                   text_parts=[("AREA: ", "AREA"), (" | ITEM: ", "CONSTRUCTION ITEM"), (" | REMARK: ", "REMARK")]),
}
CATEGORIES = sorted(RULES)          # what this export owns in fact_production_actual
METRIC_BLANK_FILL = "-"             # mining_etl_automation2 config.METRIC_BLANK_FILL
STORED_TOTALS = {"DTOT", "WTOT", "MTOT", "YTOT", "DALL", "WALL", "MALL", "YALL"}


class ExportError(Exception):
    pass


# ==========================================================================
# master -> DataFrames
# ==========================================================================
def _norm(h):
    return "" if h is None else str(h).strip()


def check_alignment(master, table):
    """The header cells at the table's ref must be the table's declared column names. A stale ref
    (seen on the 2026-09 template) would shift every value into the wrong column."""
    hdr = getattr(master, "headers", {}).get(table)
    if hdr is None:
        return None
    want = [_norm(c) for c in master.tables[table]["cols"]]
    got = [_norm(c) for c in hdr]
    if got != want:
        bad = [f"{w!r}≠{g!r}" for w, g in zip(want, got) if w != g][:4]
        return f"{table}: the header row at {master.tables[table]['ref']} does not match the table columns ({', '.join(bad)})"
    return None


def table_frame(master, table) -> pd.DataFrame:
    rows = master.data.get(table) or []
    cols = [_norm(c) for c in master.tables[table]["cols"]]
    if not rows:
        return pd.DataFrame(columns=cols)
    data = [[fmt(r.get(c)) for c in master.tables[table]["cols"]] for r in rows]
    df = pd.DataFrame(data, columns=cols, dtype=object)
    df = df.replace("", np.nan)
    if df.columns.duplicated().any():
        df = df.loc[:, ~df.columns.duplicated()]
    return df


def _prep(df, name, rule, notes):
    if "DATE" in df.columns and "SITE" in df.columns:
        blank = df["DATE"].isna() | df["SITE"].isna()
        if blank.any():
            notes.append(f"{name}: {int(blank.sum())} row(s) without DATE or SITE skipped")
            df = df[~blank]
    df = df.drop(columns=[c for c in COMMON_DROP if c in df.columns], errors="ignore").copy()
    for c in rule.get("null_cols", []):
        df[c] = pd.NA
    if rule.get("const_contractor"):
        df["CONTRACTOR"] = rule["const_contractor"]
    df["CATEGORY"] = name
    for c in ID_COLS:
        if c not in df.columns:
            df[c] = pd.NA
    return df


def _unpivot(df, name, rule):
    value_cols = [c for c in df.columns if c not in ID_COLS]
    long = df.melt(id_vars=ID_COLS, value_vars=value_cols, var_name="METRIC_RAW", value_name="VALUE")
    long = long[long["VALUE"].notna() & (_s(long["VALUE"]) != "")]
    if long.empty:
        return pd.DataFrame(columns=OUT_COLS)
    g, m = rule["fn"](long["METRIC_RAW"])
    long["METRIC_GROUP"], long["METRIC"] = g, m
    if rule.get("keep_groups"):
        long = long[long["METRIC_GROUP"].isin(rule["keep_groups"])]
    long["VALUE"] = pd.to_numeric(_s(long["VALUE"]).str.replace(",", "", regex=False), errors="coerce")
    long["TEXT_VALUE"] = pd.NA
    out = long.rename(columns=str.lower)
    out["date"] = parse_dates(out["date"])
    return out[OUT_COLS].drop_duplicates(subset=KEY7, keep="first")


def _direct(df, name, rule):
    """HAZARD / CONS: one row per source row (no unpivot). Every finding / construction item is kept.
    PIT stays blank (1.11.0): the location / area is in TEXT_VALUE, as in mining_etl_automation2 build_actual."""
    df = df.copy()
    df["METRIC_GROUP"] = df[rule["group_col"]] if rule["group_col"] in df.columns else pd.NA
    if "metric_const" in rule:
        df["METRIC"] = rule["metric_const"]
    else:
        df["METRIC"] = df[rule["metric_col"]] if rule["metric_col"] in df.columns else pd.NA
    if rule.get("pit_col") in df.columns:
        df["PIT"] = df[rule["pit_col"]].map(lambda v: v.strip() if isinstance(v, str) else v)
    if "value_const" in rule:
        df["VALUE"] = float(rule["value_const"])
    else:
        src = df[rule["value_col"]] if rule["value_col"] in df.columns else pd.Series(pd.NA, index=df.index)
        df["VALUE"] = pd.to_numeric(_s(src).str.replace(",", "", regex=False), errors="coerce")
    txt = pd.Series("", index=df.index)
    for prefix, col in rule["text_parts"]:
        txt = txt + prefix + _s(df[col]) if col in df.columns else txt + prefix
    df["TEXT_VALUE"] = txt
    out = df.rename(columns=str.lower)
    out["date"] = parse_dates(out["date"])
    out = out[OUT_COLS].reset_index(drop=True)
    out["metric"] = out["metric"].map(lambda v: v.strip() if isinstance(v, str) else v)
    out.loc[out["metric"].isna() | (_s(out["metric"]).str.strip() == ""), "metric"] = METRIC_BLANK_FILL
    # The site key includes text_value since 1.11.0 (fact_actual_natural_key_uq_v2, sql/site_key_text_value.sql).
    # Rows still identical on all of it (same day, category, status/item AND same description) are numbered
    # "(2)", "(3)" at the end of text_value, so nothing is merged or dropped.
    key = out[KEY8].astype(object).where(out[KEY8].notna(), "\x00").astype(str).agg("\x01".join, axis=1)
    n = key.groupby(key).cumcount()
    renamed = int((n > 0).sum())
    if renamed:
        base = out["text_value"].astype(object).where(out["text_value"].notna(), "")
        out.loc[n > 0, "text_value"] = [f"{b} ({k + 1})".strip() for b, k in zip(base[n > 0], n[n > 0])]
    return out[OUT_COLS], renamed


def site_name_of(master):
    """The site of this master: the one name in tblIDSITE, else the most common SITE in tblRAWMNG."""
    names = sorted(master.vocab.get("tblIDSITE", set())) if hasattr(master, "vocab") else []
    if len(names) == 1:
        return names[0]
    counts = {}
    for r in master.data.get("tblRAWMNG", []):
        s = r.get("SITE")
        if s not in (None, ""):
            counts[str(s).strip()] = counts.get(str(s).strip(), 0) + 1
    if not counts:
        raise ExportError("Cannot tell the site name: tblIDSITE has no single entry and tblRAWMNG has no SITE values.")
    return max(counts, key=counts.get)


def latest_date(master, site):
    """Latest DATE of this site over all tblRAW* tables (barge excluded)."""
    best = None
    for rule in RULES.values():
        for r in master.data.get(rule["table"], []):
            if site and str(r.get("SITE") or "").strip() != site:
                continue
            d = r.get("DATE")
            if isinstance(d, dt.datetime):
                d = d.date()
            if isinstance(d, dt.date) and (best is None or d > best):
                best = d
    return best


def first_date(master, site):
    best = None
    for rule in RULES.values():
        for r in master.data.get(rule["table"], []):
            if site and str(r.get("SITE") or "").strip() != site:
                continue
            d = r.get("DATE")
            if isinstance(d, dt.datetime):
                d = d.date()
            if isinstance(d, dt.date) and (best is None or d < best):
                best = d
    return best


def build_actual(master, site, d0, d1, totals_mode="stored"):
    """Rows for fact_production_actual of `site`, d0 <= date <= d1. Returns (DataFrame, report).
    totals_mode "derive": the stored *TOT/*ALL metrics are left out (the site and hub views derive them)."""
    notes, errors, per_cat, merged = [], [], {}, {}
    dropped_totals = 0
    frames = []
    for name in CATEGORIES:
        rule = RULES[name]
        tn = rule["table"]
        if tn not in master.tables:
            notes.append(f"{name}: {tn} is not in this master")
            continue
        err = check_alignment(master, tn)
        if err:
            errors.append(err)
            continue
        df = table_frame(master, tn)
        if df.empty:
            per_cat[name] = 0
            continue
        df = _prep(df, name, rule, notes)
        if rule["shape"] == "direct":
            out, n_numbered = _direct(df, name, rule)
            if n_numbered:
                merged[name] = n_numbered
        else:
            out = _unpivot(df, name, rule)
            if totals_mode == "derive":
                tot = out["metric"].astype(str).str.upper().isin(STORED_TOTALS)
                dropped_totals += int(tot.sum())
                out = out[~tot]
        other = out["site"].notna() & (out["site"].astype(str).str.strip() != site)
        if other.any():
            notes.append(f"{name}: {int(other.sum())} row(s) of another site ({', '.join(sorted(set(out.loc[other, 'site'].astype(str))))[:80]}) not uploaded")
        out = out[~other]
        nodate = out["date"].isna()
        if nodate.any():
            notes.append(f"{name}: {int(nodate.sum())} row(s) with an unreadable DATE not uploaded")
            out = out[~nodate]
        out = out[(out["date"] >= d0) & (out["date"] <= d1)]
        per_cat[name] = len(out)
        if not out.empty:
            frames.append(out)
    df = pd.concat(frames, ignore_index=True) if frames else pd.DataFrame(columns=OUT_COLS)
    df["site"] = site
    if errors:
        raise ExportError("; ".join(errors))
    dup = df.duplicated(subset=KEY8)
    if dup.any():
        raise ExportError(f"{int(dup.sum())} duplicate row key(s) after the export - not uploaded")
    if dropped_totals:
        notes.append(f"totals mode 'derive': {dropped_totals:,} stored DTOT..YTOT / DALL..YALL value(s) not uploaded "
                     f"(the site and hub views calculate them from the DAY rows)")
    report = {"site": site, "date_from": d0, "date_to": d1, "rows": len(df), "per_category": per_cat,
              "numbered_rows": merged, "totals_mode": totals_mode, "notes": notes,
              "dates": int(df["date"].nunique()) if len(df) else 0,
              "warnings": stored_total_warnings(df)}
    return df, report


def stored_total_warnings(df):
    """Open risk #3/#4 of the migration doc: MTOT/MALL stored per pit AND on an 'All' row of the same
    contractor would double the forecast. Reported, not blocked."""
    out = []
    if df.empty:
        return out
    m = df[(df["category"] == "MNG") & (df["metric"].isin(["MTOT", "MALL"]))]
    if m.empty:
        return out
    last = m["date"].max()
    m = m[m["date"] == last]
    pit = m["pit"].astype(str).str.strip().str.upper()
    allrow = m[pit == "ALL"]
    perpit = m[(pit != "ALL") & m["pit"].notna()]
    both = set(zip(allrow["contractor"], allrow["metric_group"], allrow["metric"])) & \
        set(zip(perpit["contractor"], perpit["metric_group"], perpit["metric"]))
    both = {b for b in both if allrow[(allrow["contractor"] == b[0]) & (allrow["metric_group"] == b[1])
                                      & (allrow["metric"] == b[2])]["value"].fillna(0).abs().sum() > 0
            and perpit[(perpit["contractor"] == b[0]) & (perpit["metric_group"] == b[1])
                       & (perpit["metric"] == b[2])]["value"].fillna(0).abs().sum() > 0}
    if both:
        ex = ", ".join(f"{c} {g}-{k}" for c, g, k in sorted(both, key=str)[:4])
        out.append(f"MNG {last}: {len(both)} contractor/metric(s) carry a non-zero MTOT/MALL both on the 'All' row and "
                   f"per pit (e.g. {ex}). Check that the dashboard / forecast does not add them twice.")
    return out


# ==========================================================================
# plan (build_plan_barge.build_calendar / build_plan: tblCALENDAR -> PLAN + SPO rows)
# ==========================================================================
PLAN_COLS = ["date", "site", "pit", "contractor", "category", "metric_group", "metric", "value", "text_value"]
PLAN_EXCLUDE_GROUPS = {"YEAR", "MONTH", "WEEK"}
CALENDAR_PLAN_COLUMNS = [f"{g}-{p}" for g in ("S", "OB", "L", "M", "H", "Q", "ST") for p in ("DAY", "WTD", "MTD", "YTD")]
CALENDAR_SPO_COLUMNS = [
    "DAY OFF", "SHIFT/DAY", "HOURS/SHIFT", "MOHH", "BREAKDOWN", "AVAILABLE HOUR", "EFFECTIVE WORKING HOUR (EWH)",
    "RAIN HOUR", "SLIPPERY", "DAILY MEETING (P5M)", "GENERAL SAFETY TALK", "FRIDAY PRAY", "REST & MEAL",
    "REFUELLING & DAILY SERVICE (P2H)", "RELOCATIONS", "PREPARE LOADING/DUMPING POINT", "SHIFT CHANGE",
    "SURVEY & GC", "PREPARE TOWER LAMP", "BREAK FASTING", "OTHERS", "TOTAL DELAY", "PHYSICAL AVAILABILITY (PA)",
    "MECHANICAL AVAILABILITY (MA)", "UTILIZATION OF AVAILABILITY (UA)", "EFFECTIVE UTILIZATION (EU)",
]


def build_plan(master, site, d0=None, d1=None):
    """Rows for fact_production_plan of `site` from tblCALENDAR (read only by the app, never written).
    PLAN block: CONTRACTOR2/DATE2 + S/OB/L/M/H/Q/ST x DAY/WTD/MTD/YTD -> category PLAN.
    SPO block: CONTRACTOR/DATE + 26 SPO columns -> category SPO, metric_group SPO."""
    tn = "tblCALENDAR"
    notes = []
    if tn not in master.tables:
        return pd.DataFrame(columns=PLAN_COLS), {"rows": 0, "notes": ["tblCALENDAR is not in this master - no plan"]}
    err = check_alignment(master, tn)
    if err:
        raise ExportError(err)
    src = table_frame(master, tn)
    if src.empty:
        return pd.DataFrame(columns=PLAN_COLS), {"rows": 0, "notes": notes}
    for c in ("SITE", "PIT", "CONTRACTOR", "DATE", "CONTRACTOR2", "DATE2"):
        if c not in src.columns:
            src[c] = pd.NA
    base = ["SITE", "PIT"]
    plan_cols = [c for c in CALENDAR_PLAN_COLUMNS if c in src.columns]
    pl = src[base + ["CONTRACTOR2", "DATE2"] + plan_cols].melt(
        id_vars=base + ["CONTRACTOR2", "DATE2"], value_vars=plan_cols, var_name="METRIC", value_name="VALUE")
    pl["CATEGORY"] = "PLAN"
    sp = pl["METRIC"].str.split("-", n=1, expand=True)
    pl["METRIC_GROUP"], pl["METRIC"] = sp[0], sp[1]
    pl = pl.rename(columns={"CONTRACTOR2": "CONTRACTOR", "DATE2": "DATE"})
    spo_cols = [c for c in CALENDAR_SPO_COLUMNS if c in src.columns]
    so = src[base + ["CONTRACTOR", "DATE"] + spo_cols].melt(
        id_vars=base + ["CONTRACTOR", "DATE"], value_vars=spo_cols, var_name="METRIC", value_name="VALUE")
    so["CATEGORY"] = "SPO"
    so["METRIC_GROUP"] = "SPO"
    comb = pd.concat([pl, so], ignore_index=True, sort=False)
    comb = comb[comb["VALUE"].notna() & (comb["VALUE"].astype(str).str.strip() != "")]
    blank = comb["SITE"].isna() | (comb["SITE"].astype(str).str.strip() == "")
    if blank.any():
        notes.append(f"PLAN: {int(blank.sum())} value(s) in tblCALENDAR rows without SITE skipped")
        comb = comb[~blank]
    comb["DATE"] = parse_dates(comb["DATE"])
    num = pd.to_numeric(comb["VALUE"].astype(str).str.replace(",", "", regex=False), errors="coerce")
    comb["TEXT_VALUE"] = comb["VALUE"].where(num.isna())
    comb["VALUE"] = num
    out = comb.rename(columns=str.lower)
    out = out[~_s(out["metric_group"]).str.upper().isin(PLAN_EXCLUDE_GROUPS)]
    out = out[PLAN_COLS].copy()
    other = out["site"].astype(str).str.strip() != site
    if other.any():
        notes.append(f"PLAN: {int(other.sum())} value(s) of another site not uploaded")
        out = out[~other]
    nodate = out["date"].isna()
    if nodate.any():
        notes.append(f"PLAN: {int(nodate.sum())} value(s) without a readable DATE not uploaded")
        out = out[~nodate]
    if d0:
        out = out[out["date"] >= d0]
    if d1:
        out = out[out["date"] <= d1]
    out["site"] = site
    out.loc[out["metric"].isna() | (_s(out["metric"]).str.strip() == ""), "metric"] = METRIC_BLANK_FILL
    out = out.reset_index(drop=True)
    return out, {"rows": len(out), "notes": notes,
                 "date_min": out["date"].min() if len(out) else None, "date_max": out["date"].max() if len(out) else None}


# ==========================================================================
# barge (build_plan_barge.build_barge, new template headers)
# ==========================================================================
BARGE_RENAME = {
    "SI": "si", "MONTH2": "month_name", "VESSEL/BARGE": "vessel_barge", "CAPACITY": "capacity",
    "CONTRACTOR2": "contractor", "STARTDATE": "start_date", "FINISHDATE": "finish_date",
    "PLAN CAPACITY": "plan_capacity", "ACTUAL CAPACITY": "actual_capacity", "WTD2": "wtd", "MTD2": "mtd",
    "YTD2": "ytd", "GRADE PLAN": "grade_plan", "GRADE ACTUAL": "grade_actual", "STATUS": "status",
    "INPUT DATE2": "input_date", "YEAR2": "year_month", "MONTH3": "month_week", "WEEK2": "week", "SITE2": "site",
    "MONTH": "month_name", "CONTRACTOR": "contractor", "WTD": "wtd", "MTD": "mtd", "YTD": "ytd",
    "INPUT DATE": "input_date", "YEAR": "year_month", "WEEK": "week", "SITE": "site",
}
BARGE_DATES = ["start_date", "finish_date", "input_date"]
BARGE_NUMS = ["capacity", "plan_capacity", "actual_capacity", "wtd", "mtd", "ytd", "grade_plan", "grade_actual"]


def build_barge(master, site):
    """All tblRAWBARGE rows of this site (the barge list is a latest-state list, not dated)."""
    tn = "tblRAWBARGE"
    if tn not in master.tables:
        return pd.DataFrame(columns=BARGE_COLS), {"rows": 0, "notes": ["tblRAWBARGE is not in this master"]}
    err = check_alignment(master, tn)
    if err:
        raise ExportError(err)
    df = table_frame(master, tn)
    notes = []
    if df.empty:
        return pd.DataFrame(columns=BARGE_COLS), {"rows": 0, "notes": notes}
    df = df.rename(columns=BARGE_RENAME)
    df = df.loc[:, ~df.columns.duplicated()]
    for c in BARGE_COLS:
        if c not in df.columns:
            df[c] = pd.NA
    df = df[BARGE_COLS].copy()
    for c in BARGE_DATES:
        df[c] = parse_dates(df[c])
    for c in BARGE_NUMS:
        df[c] = pd.to_numeric(_s(df[c]).str.replace(",", "", regex=False), errors="coerce")
    # template placeholder rows (e.g. SI "1" with no vessel, contractor or dates) are not barges
    blank = df["vessel_barge"].isna() & df["contractor"].isna() & df["start_date"].isna() & df["finish_date"].isna()
    if blank.any():
        notes.append(f"BARGE: {int(blank.sum())} empty template row(s) skipped")
        df = df[~blank]
    s = df["site"].astype("string").str.strip()
    other = s.notna() & (s != site)
    if other.any():
        notes.append(f"BARGE: {int(other.sum())} row(s) of another site not uploaded")
    df = df[~other].copy()
    df["site"] = site
    return df, {"rows": len(df), "notes": notes}


# ==========================================================================
# DataFrame -> python rows for the database driver
# ==========================================================================
def _py(v):
    if v is None or v is pd.NA or v is pd.NaT:
        return None
    if isinstance(v, float) and v != v:
        return None
    if isinstance(v, np.generic):
        v = v.item()
        if isinstance(v, float) and v != v:
            return None
    return v


def records(df, cols):
    return [tuple(_py(v) for v in row) for row in df[cols].itertuples(index=False, name=None)]
