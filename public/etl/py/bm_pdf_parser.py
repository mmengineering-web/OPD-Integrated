"""
bm_pdf_parser.py
----------------
Reads the PT Bosowa Mining (Site Langgikima) Daily Report PDF (one A3 page exported from Excel)
into the same kind of parsed dict the WKM transforms use.

Why a separate parser from dr_pdf_parser (WKM)?
  * The BM page is exported with overlapping cells: a long barge/vessel name is printed on top of the
    CONTRACTOR cell, header words run together ("PT.ABEBPT.SLS", "GRADERCOMPACDTWTFTLV").
    pdfplumber's word grouping merges those. Here the text is rebuilt from the character STREAM
    (each cell is written as one text object), so overlapping cells come out as separate runs.
  * Numbers use three conventions on the same page:
        "1,261" / "224,000"   English thousands       (TargetORE, TARGET SALE)
        "2.379" / "12.971,53" Indonesian thousands     (production, tonnage, barges, fuel)
        "1,82"  / "2379,41"   decimal comma            (grades, chart labels)
    bm_num() decides from the pattern (a group of exactly three digits after the only separator
    is a thousands group); grades and pit-chart labels are read as decimals.
Layout is found from anchor texts (section titles, row labels, column headers), not from fixed
coordinates, so a few points of shift between reports does not matter. The few things that are
fixed (pit chart categories, column order) are in config_bm.json and are checked against the page.
"""
from __future__ import annotations

import datetime as dt
import re
from collections import defaultdict

import pdfplumber

from dr_pdf_parser import norm, parse_report_date, parse_short_date

PARSER_VERSION = "bm-1.0"
NA = {"", "-", "–", "—", "#N/A", "#DIV/0!", "#VALUE!", "#REF!", "`"}


class ParseError(Exception):
    pass


# ----------------------------------------------------------------------------- numbers
def bm_num(s, decimal=False):
    """'2.379' -> 2379, '11.299,61' -> 11299.61, '1,261' -> 1261, '1,82' -> 1.82, '92%' -> 92, '-' -> None.
    decimal=True: a single separator is always the decimal mark (grades, chart labels)."""
    if s is None:
        return None
    if isinstance(s, (int, float)):
        return float(s)
    t = str(s).strip().replace(" ", "").rstrip("%")
    if t in NA:
        return None
    neg = t.startswith("(") and t.endswith(")") or t.startswith("-")
    t = t.strip("()").lstrip("-")
    if not re.fullmatch(r"[\d.,]+", t) or not re.search(r"\d", t):
        return None
    if "." in t and "," in t:
        dec = "." if t.rfind(".") > t.rfind(",") else ","
        tho = "," if dec == "." else "."
        t = t.replace(tho, "").replace(dec, ".")
    elif "," in t or "." in t:
        sep = "," if "," in t else "."
        if not decimal and re.fullmatch(rf"\d{{1,3}}(\{sep}\d{{3}})+", t):
            t = t.replace(sep, "")
        elif t.count(sep) == 1:
            t = t.replace(sep, ".")
        else:
            return None
    try:
        v = float(t)
    except ValueError:
        return None
    return -v if neg else v


def is_num(s):
    return bm_num(s, decimal=True) is not None or str(s).strip() in ("-", "0")


# ----------------------------------------------------------------------------- page text
class Page:
    """Text of one page as stream-order runs (one per PDF text object, so overlapping cells stay apart)
    and as tokens (runs split at spaces and at wide gaps between characters)."""

    def __init__(self, page):
        self.page = page
        self.width, self.height = page.width, page.height
        self.runs = self._runs(page.chars)
        self.tokens = [t for r in self.runs for t in self._split(r)]

    @staticmethod
    def _runs(chars):
        out, cur = [], None
        for c in chars:
            if cur and abs(c["top"] - cur["top"]) <= 0.3 and -0.8 <= c["x0"] - cur["x1"] <= 2.5 * c["size"]:
                cur["chars"].append(c)
                cur["x1"] = c["x1"]
            else:
                if cur:
                    out.append(cur)
                cur = {"chars": [c], "x0": c["x0"], "x1": c["x1"], "top": c["top"], "bottom": c["bottom"], "size": c["size"]}
        if cur:
            out.append(cur)
        for r in out:
            r["text"] = "".join(c["text"] for c in r["chars"])
            r["cx"] = (r["x0"] + r["x1"]) / 2
            r["cy"] = (r["top"] + r["bottom"]) / 2
        return [r for r in out if r["text"].strip()]

    @staticmethod
    def _mk(chars):
        txt = "".join(c["text"] for c in chars).strip()
        x0, x1 = chars[0]["x0"], chars[-1]["x1"]
        top = min(c["top"] for c in chars)
        bottom = max(c["bottom"] for c in chars)
        return {"text": txt, "x0": x0, "x1": x1, "top": top, "bottom": bottom,
                "cx": (x0 + x1) / 2, "cy": (top + bottom) / 2, "chars": chars}

    def _split(self, r):
        """Split a run at spaces and at gaps wider than 0.9 x font size (numbers of adjacent columns
        written as one text object, e.g. '34135' = DT 34, WT 1, FT 3, LV 5)."""
        parts, cur = [], []
        prev = None
        for c in r["chars"]:
            if c["text"].isspace():
                if cur:
                    parts.append(cur)
                cur, prev = [], None
                continue
            if prev is not None and c["x0"] - prev["x1"] > 0.9 * c["size"]:
                parts.append(cur)
                cur = []
            cur.append(c)
            prev = c
        if cur:
            parts.append(cur)
        return [self._mk(p) for p in parts if "".join(c["text"] for c in p).strip()]

    # -- queries
    @staticmethod
    def _in(t, region):
        x0, y0, x1, y1 = region
        return x0 <= t["cx"] <= x1 and y0 <= t["cy"] <= y1

    def runs_in(self, region):
        return [r for r in self.runs if self._in(r, region)]

    def tokens_in(self, region):
        return [t for t in self.tokens if self._in(t, region)]

    def find(self, pattern, region=None, required=True, what=None):
        """First run (top to bottom) whose normalised text contains the normalised pattern."""
        key = norm(pattern)
        hits = [r for r in (self.runs_in(region) if region else self.runs) if key in norm(r["text"])]
        if not hits:
            if required:
                raise ParseError(f"'{what or pattern}' not found on the page")
            return None
        return min(hits, key=lambda r: (r["top"], r["x0"]))

    def find_all(self, pattern, region=None):
        key = norm(pattern)
        return sorted([r for r in (self.runs_in(region) if region else self.runs) if key in norm(r["text"])],
                      key=lambda r: (r["top"], r["x0"]))


def sub_tokens(run, pattern, flags=re.I):
    """Pieces of a run matching a regex, with x positions from the characters
    ('PT. SHESPT. ABEP' -> 'PT. SHES', 'PT. ABEP')."""
    out = []
    chars = run["chars"]
    text = "".join(c["text"] for c in chars)
    for m in re.finditer(pattern, text, flags):
        cs = chars[m.start():m.end()]
        cs = [c for c in cs if not c["text"].isspace()] or cs
        out.append(Page._mk(cs) | {"text": m.group(0).strip()})
    return out


def nearest(v, centres, maxd):
    """Index of the nearest centre within maxd, else None."""
    best, bd = None, maxd
    for i, c in enumerate(centres):
        if c is None:
            continue
        d = abs(v - c)
        if d <= bd:
            best, bd = i, d
    return best


def merge_fragments(tokens, gap=1.0):
    """Join number pieces printed as two text objects side by side ('377' + '000')."""
    toks = sorted(tokens, key=lambda t: (round(t["cy"]), t["x0"]))
    out = []
    for t in toks:
        if out and abs(out[-1]["cy"] - t["cy"]) < 1.5 and 0 <= t["x0"] - out[-1]["x1"] <= gap \
                and re.fullmatch(r"[\d.,]+", out[-1]["text"]) and re.fullmatch(r"[\d.,]+", t["text"]):
            p = out[-1]
            out[-1] = Page._mk(p["chars"] + t["chars"])
            continue
        out.append(t)
    return out


# ----------------------------------------------------------------------------- sections
SECTION_KEYS = [("hse", "1. HEALTH"), ("mining", "2. MINING"), ("stock", "3. ORE STOCK"),
                ("shipment", "4. SHIPMENT"), ("equipment", "5. EQUIPMENT"), ("manpower", "6. MAN POWER"),
                ("weather", "7. WEATHER"), ("note", "8. NOTE")]


def locate_sections(pg):
    tops = {}
    for k, title in SECTION_KEYS:
        r = pg.find(title, required=False)
        if r is not None:
            tops[k] = r["top"]
    missing = [t for k, t in SECTION_KEYS if k not in tops]
    keys = [k for k, _ in SECTION_KEYS if k in tops]
    regions = {}
    for i, k in enumerate(keys):
        y0 = tops[k]
        y1 = tops[keys[i + 1]] if i + 1 < len(keys) else pg.height
        regions[k] = (0, y0, pg.width, y1)
    # 6. MAN POWER and 7. WEATHER share one band (side by side)
    if "manpower" in regions and "weather" in regions:
        y0 = min(tops["manpower"], tops["weather"])
        y1 = tops.get("note", pg.height)
        wx = pg.find("7. WEATHER")["x0"]
        regions["manpower"] = (0, y0, wx - 2, y1)
        regions["weather"] = (wx - 10, y0, pg.width, y1)
    return regions, missing


def parse_header(pg):
    date_, site = None, None
    for r in sorted(pg.runs_in((0, 0, pg.width, 95)), key=lambda r: r["top"]):
        if date_ is None:
            date_ = parse_report_date(r["text"])
        if site is None and ("BOSOWA" in r["text"].upper() or "SITE" in r["text"].upper()):
            site = r["text"].strip()
    if date_ is None:
        raise ParseError("report date not found in the page header")
    return {"report_date": date_, "site_text": site}


def _row_labels(pg, region, labels, max_x):
    """{label: cy} for the row labels (matched by normalised prefix) left of max_x."""
    out = {}
    for r in pg.runs_in(region):
        if r["x0"] > max_x:
            continue
        n = norm(r["text"])
        for lab in labels:
            if lab not in out and n.startswith(norm(lab)):
                out[lab] = r["cy"]
    return out


def _grid(pg, region, row_cy, col_cx, max_dy=5.0, max_dx=9.0, decimal=False, x_min=None):
    """Numeric tokens -> {row: {col_index: value}} ('-' gives None and is recorded as present)."""
    rows = list(row_cy)
    ys = [row_cy[r] for r in rows]
    out = {r: {} for r in rows}
    for t in pg.tokens_in(region):
        if x_min is not None and t["x0"] < x_min:
            continue
        if not is_num(t["text"]):
            continue
        ri = nearest(t["cy"], ys, max_dy)
        ci = nearest(t["cx"], col_cx, max_dx)
        if ri is None or ci is None:
            continue
        out[rows[ri]][ci] = bm_num(t["text"], decimal=decimal)
    return out


# ----------------------------------------------------------------------------- 1. HSE
def parse_hse(pg, region, cfg):
    cats = list(cfg["hse_categories"])
    labels = _row_labels(pg, region, cats, max_x=95)
    miss = [c for c in cats if c not in labels]
    if len(labels) < 3:
        raise ParseError(f"HSE rows not found (missing {miss})")
    # column centres = the 16 cells of the first category row (always filled with numbers)
    first = min(labels.values())
    cells = sorted([t for t in pg.tokens_in((95, first - 4, region[2], first + 4)) if is_num(t["text"])],
                   key=lambda t: t["cx"])
    per_names = dict(cfg["hse_periods"])
    heads = cfg["hse_contractor_headers"]
    need = len(per_names) * len(heads)
    if len(cells) != need:
        raise ParseError(f"HSE: {len(cells)} cells in the '{min(labels, key=labels.get)}' row, expected {need}")
    cx = [t["cx"] for t in cells]
    grid = _grid(pg, region, labels, cx, max_dx=8)
    by_period = {}
    for pi, (pname, pkey) in enumerate(per_names.items()):
        blk = {}
        for hi, h in enumerate(heads):
            ci = pi * len(heads) + hi
            blk[h] = {cat: (grid[cat].get(ci) or 0.0) for cat in labels}
        by_period[pkey] = blk
    return {"by_period": by_period, "missing_rows": miss}


# ----------------------------------------------------------------------------- 2. MINING
def parse_mining(pg, region, cfg):
    mc = cfg["mining_table"]
    rows = list(mc["rows"])
    x1 = pg.find(mc.get("right_of_table", "DAILY PRODUCTION"), region, required=False)
    xr = (x1["x0"] - 120) if x1 else mc.get("max_x", 510)
    reg = (0, region[1], min(xr, mc.get("max_x", 510)), region[3])
    labels = _row_labels(pg, reg, rows, max_x=70)
    if mc["plan_row"] not in labels:
        raise ParseError(f"mining table: row '{mc['plan_row']}' not found")
    y = labels[mc["plan_row"]]
    cells = sorted([t for t in merge_fragments(pg.tokens_in((70, y - 4, reg[2], y + 4))) if is_num(t["text"])],
                   key=lambda t: t["cx"])
    periods, heads = mc["periods"], mc["contractor_headers"]
    if len(cells) != len(periods) * len(heads):
        raise ParseError(f"mining table: {len(cells)} cells in the {mc['plan_row']} row, expected {len(periods) * len(heads)}")
    cx = [t["cx"] for t in cells]
    grid = _grid(pg, reg, labels, cx, max_dx=9, x_min=70)
    out = {}
    for r in rows:
        if r not in labels:
            continue
        out[r] = {}
        for pi, per in enumerate(periods):
            out[r][per] = {h: grid[r].get(pi * len(heads) + hi) for hi, h in enumerate(heads)}
    return {"table": out, "missing_rows": [r for r in rows if r not in labels]}


def parse_pit_chart(pg, region, cfg):
    pc = cfg["pit_chart"]
    title = pg.find(pc["title"], region)
    cats = pc["categories"]
    # category label line(s): the first run below the title that starts with 'PIT'
    lab_runs = [r for r in pg.runs_in((0, title["bottom"], pc.get("max_x", 410), region[3]))
                if norm(r["text"]).startswith("PIT")]
    if not lab_runs:
        raise ParseError("pit chart: category labels not found")
    ly = min(r["top"] for r in lab_runs)
    sig_runs = sorted([r for r in pg.runs_in((0, ly - 1, pc.get("max_x", 410), ly + 9))], key=lambda r: (round(r["top"]), r["x0"]))
    sig = norm("".join(r["text"] for r in sig_runs))
    if sig != norm(pc["label_signature"]):
        raise ParseError("pit chart categories differ from config pit_chart.label_signature - the site changed the chart. "
                         f"Read: '{''.join(r['text'] for r in sig_runs)}'")
    vals = sorted([t for t in pg.tokens_in((0, title["bottom"], pc.get("max_x", 410), ly - 2)) if bm_num(t["text"], True) is not None],
                  key=lambda t: t["cx"])
    if len(vals) == len(cats):
        centres = [t["cx"] for t in vals]
        how = "one value label per bar"
    else:
        zeros = [t for t in vals if bm_num(t["text"], True) == 0]
        x0, step = pc["first_centre"], pc["pitch"]
        if len(zeros) >= 2:   # refit the axis from the zero labels (they sit exactly under their bars)
            ks = [round((t["cx"] - x0) / step) for t in zeros]
            n = len(ks)
            mk, mx = sum(ks) / n, sum(t["cx"] for t in zeros) / n
            var = sum((k - mk) ** 2 for k in ks)
            if var > 0:
                step = sum((k - mk) * (t["cx"] - mx) for k, t in zip(ks, zeros)) / var
                x0 = mx - step * mk
        centres = [x0 + step * k for k in range(len(cats))]
        how = f"{len(vals)} value labels for {len(cats)} bars - centres from the axis"
    out = {}
    for t in vals:
        i = nearest(t["cx"], centres, pc.get("max_dx", 9))
        if i is None:
            continue
        v = bm_num(t["text"], decimal=True)
        if v:
            out[cats[i]["label"]] = v
    return {"values": out, "how": how}


# ----------------------------------------------------------------------------- 3. ORE STOCK
def parse_stock(pg, region, cfg):
    sc = cfg["stock"]
    blocks = []
    for lab in sc["blocks"]:
        r = pg.find(lab, region, required=False)
        if r is None:
            raise ParseError(f"stock block '{lab}' not found")
        blocks.append((lab, r))
    blocks.sort(key=lambda b: b[1]["top"])
    out = {}
    for i, (lab, br) in enumerate(blocks):
        y1 = blocks[i + 1][1]["top"] - 2 if i + 1 < len(blocks) else region[3]
        reg = (0, br["bottom"], sc.get("max_x", 368), y1)
        # ETO / EFO sub-header: 2 tonnage + 2 per grade, in page order
        sub = []
        for r in pg.runs_in(reg):
            sub += sub_tokens(r, r"ET0|ETO|EFO")
        if not sub:
            raise ParseError(f"{lab}: ETO/EFO sub-header not found")
        sy = min(t["cy"] for t in sub)
        sub = sorted([t for t in sub if abs(t["cy"] - sy) < 3], key=lambda t: t["cx"])
        cols = [("TONNAGE", s) for s in ("ETO", "EFO")] + [(g, s) for g in sc["grades"] for s in ("ETO", "EFO")]
        if len(sub) != len(cols) or [t["text"].upper().replace("0", "O") for t in sub] != [c[1] for c in cols]:
            raise ParseError(f"{lab}: sub-header reads {[t['text'] for t in sub]}, expected {len(cols)} ETO/EFO columns")
        labels = _row_labels(pg, (0, sy + 2, 70, y1), list(sc["rows"]) + ["TOTAL"], max_x=70)
        grid = {}
        for t in pg.tokens_in((60, sy + 3, reg[2], y1)):
            if t["text"].upper() in ("WMT", "%") or not is_num(t["text"]):
                continue
            ri = nearest(t["cy"], [labels[k] for k in labels], 5)
            ci = nearest(t["cx"], [s["cx"] for s in sub], 10)
            if ri is None or ci is None:
                continue
            row = list(labels)[ri]
            col = cols[ci]
            grid.setdefault(row, {})[col] = bm_num(t["text"], decimal=(col[0] != "TONNAGE"))
        out[lab] = {"rows": grid, "missing_rows": [r for r in sc["rows"] if r not in labels]}
    return out


def parse_bar_chart(pg, region, title, cats, max_x=None, decimal=False):
    """Value labels of a small bar chart -> {category: value}. Categories are text under the bars."""
    t = pg.find(title, region)
    x_lo = t["x0"] - 80
    x_hi = max_x or (t["x1"] + 120)
    below = [r for r in pg.runs_in((x_lo, t["bottom"], x_hi, region[3]))]
    cat_tok = {}
    for r in below:
        for c in cats:
            for st in sub_tokens(r, re.escape(c)):
                if c not in cat_tok or st["top"] < cat_tok[c]["top"]:
                    cat_tok[c] = st
    if len(cat_tok) != len(cats):
        raise ParseError(f"chart '{title}': categories {sorted(set(cats) - set(cat_tok))} not found")
    cy = max(v["top"] for v in cat_tok.values())
    centres = [cat_tok[c]["cx"] for c in cats]
    out = {}
    for tok in pg.tokens_in((x_lo, t["bottom"], x_hi, cy - 1)):
        v = bm_num(tok["text"], decimal=decimal)
        if v is None:
            continue
        i = nearest(tok["cx"], centres, 15)
        if i is not None:
            out[cats[i]] = v
    return out


# ----------------------------------------------------------------------------- 4. SHIPMENT
def parse_sales(pg, region, cfg):
    sc = cfg["sales"]
    head = pg.find(sc["first_row"], region)
    top = region[1]
    reg = (0, top, sc.get("max_x", 370), region[3])
    per_tok = {}
    for r in pg.runs_in((0, top, reg[2], head["top"])):
        for p in sc["periods"]:
            if norm(r["text"]) == norm(p):
                per_tok[p] = r
    if len(per_tok) != len(sc["periods"]):
        raise ParseError(f"sales table: period headers {sorted(set(sc['periods']) - set(per_tok))} not found")
    cols = []
    for r in pg.runs_in((70, top, reg[2], head["top"] - 1)):
        cols += sub_tokens(r, r"PT\.?\s?(?:(?!PT)[A-Z]){2,5}")
    cols.sort(key=lambda c: c["cx"])
    colinfo = []
    for c in cols:
        p = min(per_tok, key=lambda k: abs(per_tok[k]["cx"] - c["cx"]))
        colinfo.append((p, c["text"]))
    rows = _row_labels(pg, (0, head["top"] - 2, reg[2], region[3]), sc["rows"], max_x=60)
    out = {p: {r: {} for r in rows} for p in sc["periods"]}
    toks = merge_fragments(pg.tokens_in((75, head["top"] - 3, reg[2], region[3])))
    for t in toks:
        if not is_num(t["text"]):
            continue
        ri = nearest(t["cy"], [rows[k] for k in rows], 4.5)
        ci = nearest(t["cx"], [c["cx"] for c in cols], 12)
        if ri is None or ci is None:
            continue
        p, h = colinfo[ci]
        out[p][list(rows)[ri]][h] = bm_num(t["text"])
    return out


def parse_barges(pg, region, report_date, cfg):
    bc = cfg["barges"]
    hdr = pg.find(bc["header_anchor"], region)
    bands = bc["bands"]                      # field -> [x0_from, x0_to] relative to the 'NO SI' header x0
    base = hdr["x0"]
    y0 = hdr["bottom"] + 1
    reg = (0, y0, bc.get("max_x", 500), region[3])
    rs = pg.runs_in(reg)
    si_runs = sorted([r for r in rs if r["x0"] - base < bands["si"][1] and re.fullmatch(r"\d{1,4}\s*-\s*[A-Z]{2,6}", r["text"].strip())],
                     key=lambda r: r["cy"])
    rows = [{"_cy": r["cy"], "si": re.sub(r"\s+", "", r["text"].strip())} for r in si_runs]
    ys = [r["_cy"] for r in rows]
    parts = defaultdict(list)
    for r in rs:
        if r in si_runs:
            continue
        ri = nearest(r["cy"], ys, 4.5)
        if ri is None:
            continue
        rel = r["x0"] - base
        for f, (a, b) in bands.items():
            if a <= rel < b:
                parts[(ri, f)].append(r)
                break
    out = []
    for i, row in enumerate(rows):
        def txt(f):
            ps = sorted(parts.get((i, f), []), key=lambda r: (r["top"], r["x0"]))
            s = " ".join(p["text"].strip() for p in ps).strip()
            return None if s in NA else s
        b = {"si": row["si"], "vessel": txt("vessel"), "contractor": txt("contractor"),
             "start": parse_short_date(txt("start"), report_date) if txt("start") else None,
             "finish": parse_short_date(txt("finish"), report_date) if txt("finish") else None,
             "plan_cap": bm_num(txt("plan_cap")), "actual_cap": bm_num(txt("actual_cap")),
             "grade_plan": bm_num(txt("grade_plan"), decimal=True), "grade_act": bm_num(txt("grade_act"), decimal=True),
             "status": txt("status"), "material": txt("material"), "destination": txt("destination")}
        if not b["actual_cap"]:
            b["actual_cap"] = None
        if not b["grade_plan"]:
            b["grade_plan"] = None
        out.append(b)
    return out


# ----------------------------------------------------------------------------- 5. EQUIPMENT
def parse_equipment(pg, region, cfg):
    ec = cfg["equipment"]
    up = pg.find(ec["unit_perf_title"], region, required=False)
    x_max = (up["x0"] - 200) if up else ec.get("max_x", 305)
    x_max = min(x_max, ec.get("max_x", 305))
    reg = (0, region[1], x_max, region[3])
    # column headers: split the run-together header text into the known column names
    names = sorted(ec["columns"], key=len, reverse=True)
    pat = "|".join(re.escape(n).replace(r"\ ", r"\s?") for n in names)
    heads = []
    act = _row_labels(pg, reg, list(ec["rows"]), max_x=110)
    first_row = min(act.values()) if act else region[3]
    for r in pg.runs_in((105, region[1], x_max, first_row - 4)):
        heads += sub_tokens(r, pat)
    heads.sort(key=lambda h: h["cx"])
    hn = [norm(h["text"]) for h in heads]
    want = [norm(c) for c in ec["columns"]]
    if hn != want:
        raise ParseError(f"equipment header reads {[h['text'] for h in heads]}, expected {list(ec['columns'])}")
    # rows: every activity label, grouped in blocks; block names left of the labels
    lab_runs = sorted([r for r in pg.runs_in(reg) if r["x0"] < 110 and any(norm(r["text"]).startswith(norm(a)) for a in ec["rows"])],
                      key=lambda r: r["cy"])
    blk_runs = sorted([r for r in pg.runs_in((0, first_row - 8, 70, region[3])) if re.match(r"\s*(PT\.?|BOSOWA)", r["text"], re.I)],
                      key=lambda r: r["cy"])
    out = {}
    for r in lab_runs:
        blk = None
        # the block label sits in the middle of its 4 rows -> nearest block label by y
        if blk_runs:
            blk = min(blk_runs, key=lambda b: abs(b["cy"] - r["cy"]))["text"].strip()
        code = next(ec["rows"][a] for a in ec["rows"] if norm(r["text"]).startswith(norm(a)))
        rec = out.setdefault(blk, {}).setdefault(code, {"_dash": True, "_cy": r["cy"]})
    # each block's rows are the 4 label rows nearest to it - assign values by row y and column x
    rows = [(b, c, rec["_cy"]) for b, acts in out.items() for c, rec in acts.items()]
    ys = [y for _, _, y in rows]
    cx = [h["cx"] for h in heads]
    for t in pg.tokens_in((105, first_row - 5, x_max, region[3])):
        if not is_num(t["text"]):
            continue
        ri = nearest(t["cy"], ys, 4.5)
        ci = nearest(t["cx"], cx, 7.5)
        if ri is None or ci is None:
            continue
        b, c, _ = rows[ri]
        rec = out[b][c]
        v = bm_num(t["text"])
        rec[ec["columns"][list(ec["columns"])[ci]]] = v
        if v is not None:
            rec["_dash"] = False
    for b in out.values():
        for rec in b.values():
            rec.pop("_cy", None)
    return out


def parse_unit_performance(pg, region, cfg):
    """Three blocks (one per contractor) of UNIT | PA% | MA% | UA% | EU%; rows EXCA, DT, DZ, GD, CP."""
    uc = cfg["unit_perf"]
    title = pg.find(uc["title"], region)
    fuel_t = pg.find(uc["stop_at"], region, required=False)
    y1 = fuel_t["top"] - 2 if fuel_t else region[3]
    x_lo = uc.get("min_x", 330)
    blocks = sorted([r for r in pg.runs_in((x_lo, title["bottom"], pg.width, title["bottom"] + 15))
                     if re.match(r"\s*PT\.?", r["text"])], key=lambda r: r["cx"])
    unit_h = sorted([r for r in pg.runs_in((x_lo, title["bottom"], pg.width, y1)) if norm(r["text"]) == "UNIT"],
                    key=lambda r: r["cx"])
    if not blocks or len(unit_h) != len(blocks):
        raise ParseError(f"unit performance: {len(blocks)} contractor headers, {len(unit_h)} UNIT columns")
    hy = max(u["cy"] for u in unit_h)
    kpis = uc["columns"]
    cols = []                                   # (block, kpi, cx)
    for r in pg.runs_in((x_lo, title["bottom"], pg.width, hy + 3)):
        for k in kpis:
            if norm(r["text"]) == norm(k):
                bi = max(i for i in range(len(unit_h)) if unit_h[i]["x0"] <= r["cx"])
                cols.append((bi, k, r["cx"]))
    if len(cols) != len(kpis) * len(blocks):
        raise ParseError(f"unit performance: {len(cols)} PA/MA/UA/EU headers, expected {len(kpis) * len(blocks)}")
    rows = list(uc["rows"])
    labels = []                                 # (block, code, cy)
    for r in pg.runs_in((x_lo, hy + 2, pg.width, y1)):
        n = norm(r["text"])
        for u in rows:
            if n == norm(u):
                bi = min(range(len(unit_h)), key=lambda i: abs(unit_h[i]["cx"] - r["cx"]))
                labels.append((bi, uc["rows"][u], r["cy"]))
    out = {b["text"].strip(): {"units": {}} for b in blocks}
    for t in pg.tokens_in((x_lo, hy + 2, pg.width, y1)):
        if not is_num(t["text"]):
            continue
        ci = nearest(t["cx"], [c[2] for c in cols], 8)
        if ci is None:
            continue
        bi, k, _ = cols[ci]
        cand = [(abs(cy - t["cy"]), code) for b, code, cy in labels if b == bi]
        if not cand or min(cand)[0] > 5:
            continue
        code = min(cand)[1]
        out[blocks[bi]["text"].strip()]["units"].setdefault(code, {})[k.rstrip("%")] = bm_num(t["text"])
    return out


def parse_fuel(pg, region, cfg):
    fc = cfg["fuel"]
    t = pg.find(fc["title"], region)
    heads = {}
    reg = (t["x0"] - 80, t["bottom"], t["x1"] + 80, region[3])
    for r in pg.runs_in(reg):
        for h in fc["columns"]:
            if norm(r["text"]) == norm(h) and h not in heads:
                heads[h] = r
    if len(heads) != len(fc["columns"]):
        raise ParseError(f"fuel table: columns {sorted(set(fc['columns']) - set(heads))} not found")
    hy = max(h["cy"] for h in heads.values())
    comp = {}
    for r in pg.runs_in((reg[0], hy + 2, reg[2], region[3])):
        if re.match(r"\s*(PT\.?|BOSOWA)", r["text"], re.I) and r["x0"] < min(h["x0"] for h in heads.values()):
            comp[r["text"].strip()] = r["cy"]
    order = list(fc["columns"])
    grid = _grid(pg, (reg[0], hy + 2, reg[2], region[3]), comp, [heads[h]["cx"] for h in order], max_dy=4, max_dx=14,
                 x_min=min(h["x0"] for h in heads.values()) - 12)
    return {c: {order[i]: v for i, v in grid[c].items()} for c in comp}


# ----------------------------------------------------------------------------- 6/7. MAN POWER, WEATHER
def parse_manpower(pg, region, cfg):
    mc = cfg["manpower"]
    cols = {}
    for r in pg.runs_in(region):
        for st in sub_tokens(r, "|".join(re.escape(c) for c in sorted(mc["columns"], key=len, reverse=True))):
            k = next(c for c in mc["columns"] if norm(c) == norm(st["text"]))
            if k not in cols:
                cols[k] = st
    if len(cols) != len(mc["columns"]):
        raise ParseError(f"manpower: columns {sorted(set(mc['columns']) - set(cols))} not found")
    hy = max(c["cy"] for c in cols.values())
    comp = {}
    for r in pg.runs_in((0, hy + 2, min(c["x0"] for c in cols.values()), region[3])):
        if r["text"].strip().upper().startswith(tuple(mc["company_prefixes"])):
            comp[r["text"].strip()] = r["cy"]
    order = list(mc["columns"])
    grid = _grid(pg, (0, hy + 2, region[2], region[3]), comp, [cols[c]["cx"] for c in order], max_dy=4, max_dx=8,
                 x_min=min(c["x0"] for c in cols.values()) - 6)
    return {c: {order[i]: v for i, v in grid[c].items()} for c in comp}


def _date_table(pg, region, title, report_date, cfg):
    """EFFEKTIVE WORKING HOURS / RAIN DURATION: rows = contractors, columns = the last 7 dates + TOTAL."""
    t = pg.find(title, region)
    # the table spans from the DATE header left of the title to the TOTAL header right of it
    hdr_y = None
    dates = []
    # the table ends at the first TOTAL header right of the title (the next table starts after it)
    tots = [r for r in pg.runs_in((t["x1"], t["top"] - 2, pg.width, t["bottom"] + 20)) if norm(r["text"]) == "TOTAL"]
    x_end = min(r["x1"] for r in tots) + 1 if tots else t["x1"] + 100
    for tok in pg.tokens_in((t["x0"] - 90, t["bottom"], x_end, t["bottom"] + 20)):
        d = parse_short_date(tok["text"], report_date)
        if d:
            dates.append((d, tok))
            hdr_y = tok["cy"]
    if not dates:
        raise ParseError(f"'{title}': date header not found")
    dates.sort(key=lambda x: x[1]["cx"])
    x0 = min(x[1]["x0"] for x in dates) - 45
    x1 = max(x[1]["x1"] for x in dates) + 12
    comp = {}
    for r in pg.runs_in((x0 - 5, hdr_y + 2, dates[0][1]["x0"] - 1, region[3])):
        if re.match(r"\s*PT\.?\s?[A-Z]+|BOSOWA", r["text"].strip(), re.I):
            comp[r["text"].strip()] = r["cy"]
    grid = _grid(pg, (dates[0][1]["x0"] - 5, hdr_y + 2, x1, region[3]), comp, [x[1]["cx"] for x in dates], max_dy=4, max_dx=9)
    return {c: {dates[i][0]: v for i, v in grid[c].items()} for c in comp}


def parse_weather(pg, region, report_date, cfg):
    wc = cfg["weather"]
    return {"EWH": _date_table(pg, region, wc["ewh_title"], report_date, cfg),
            "RAIN": _date_table(pg, region, wc["rain_title"], report_date, cfg)}


def parse_note(pg, region):
    rs = sorted(pg.runs_in((80, region[1] + 1, pg.width, region[3])), key=lambda r: (r["top"], r["x0"]))
    lines = [r["text"].strip() for r in rs if re.search(r"[A-Za-z]{3}", r["text"])]
    return " | ".join(lines)


# ----------------------------------------------------------------------------- whole page
def parse_daily_report(pdf_path, cfg):
    """-> (parsed, errors). parsed keys: meta, hse, mining, pit_chart, stock, hauling, sales,
    shipment_total, barges, equipment, unit_perf, fuel, manpower, weather, note."""
    errors = []
    with pdfplumber.open(pdf_path) as pdf:
        if len(pdf.pages) != 1:
            errors.append(("page", f"{len(pdf.pages)} pages - only page 1 is read"))
        pg = Page(pdf.pages[0])
    hdr = parse_header(pg)
    d = hdr["report_date"]
    parsed = {"meta": {"report_date": d, "site_text": hdr["site_text"], "parser": PARSER_VERSION}}
    regions, missing = locate_sections(pg)
    for m in missing:
        errors.append(("layout", f"section '{m}' not found"))

    def run(key, fn, *a):
        try:
            parsed[key] = fn(*a)
        except ParseError as e:
            errors.append((key, str(e)))
        except Exception as e:     # a broken section must not stop the others
            errors.append((key, f"{type(e).__name__}: {e}"))

    R = regions
    if "hse" in R:
        run("hse", parse_hse, pg, R["hse"], cfg)
    if "mining" in R:
        run("mining", parse_mining, pg, R["mining"], cfg)
        run("pit_chart", parse_pit_chart, pg, R["mining"], cfg)
    if "stock" in R:
        run("stock", parse_stock, pg, R["stock"], cfg)
        hc = cfg["hauling_chart"]
        run("hauling", parse_bar_chart, pg, R["stock"], hc["title"], hc["categories"], None, False)
    if "shipment" in R:
        run("sales", parse_sales, pg, R["shipment"], cfg)
        run("barges", parse_barges, pg, R["shipment"], d, cfg)
        sc = cfg["shipment_chart"]
        run("shipment_total", parse_bar_chart, pg, R["shipment"], sc["title"], sc["categories"], sc.get("max_x"), False)
    if "equipment" in R:
        run("equipment", parse_equipment, pg, R["equipment"], cfg)
        run("unit_perf", parse_unit_performance, pg, R["equipment"], cfg)
        run("fuel", parse_fuel, pg, R["equipment"], cfg)
    if "manpower" in R:
        run("manpower", parse_manpower, pg, R["manpower"], cfg)
    if "weather" in R:
        run("weather", parse_weather, pg, R["weather"], d, cfg)
    if "note" in R:
        run("note", parse_note, pg, R["note"])
    return parsed, errors
