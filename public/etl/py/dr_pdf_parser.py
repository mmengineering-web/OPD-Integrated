"""
dr_pdf_parser.py
----------------
Layout-aware extractor for the WKM "DAILY REPORT 日报表" PDF (single A3 page,
exported from Excel). Returns the report in *PDF semantics* (PDF labels, PDF
periods). Mapping to the Master Data tblRAW* structure is done in
dr_to_master.py.

Design notes
- Every block is located by anchor text (section titles, row labels, column
  headers), never by fixed coordinates, so moderate layout shifts (extra hazard
  rows, more barges, longer notes) are tolerated.
- Numeric cells: words are assigned to the nearest row label (y) and nearest
  column header (x). Split glyphs ("2" "7" -> "27") are merged first.
- Text cells (hazards, barge names, projects): rebuilt from characters, using
  the explicit space glyphs in the PDF, because Excel's justified alignment
  breaks normal word detection.
- If an anchor is missing the section raises SectionError; the caller records
  it in the log and skips only that section.
"""
from __future__ import annotations

import datetime as dt
import re
from collections import defaultdict

import pdfplumber

PARSER_VERSION = "1.3.0"

MONTHS = {
    "jan": 1, "january": 1, "januari": 1,
    "feb": 2, "february": 2, "februari": 2,
    "mar": 3, "march": 3, "maret": 3,
    "apr": 4, "april": 4,
    "may": 5, "mei": 5,
    "jun": 6, "june": 6, "juni": 6,
    "jul": 7, "july": 7, "juli": 7,
    "aug": 8, "august": 8, "agustus": 8, "agu": 8, "ags": 8, "augs": 8,
    "sep": 9, "sept": 9, "september": 9,
    "oct": 10, "october": 10, "oktober": 10, "okt": 10,
    "nov": 11, "november": 11, "nopember": 11,
    "dec": 12, "december": 12, "desember": 12, "des": 12,
}

NUMERIC_CHARS = set("0123456789,.%-()")


class SectionError(Exception):
    """Raised when a block's anchors cannot be found or are inconsistent."""


# --------------------------------------------------------------------------
# small helpers
# --------------------------------------------------------------------------
def norm(s: str) -> str:
    """Upper-case ASCII alnum only - used for label matching."""
    return re.sub(r"[^A-Z0-9]", "", (s or "").upper())


def num(s):
    """Parse a PDF number cell. '-', '' -> None. '13%' -> 13.0. '(5)' -> -5."""
    if s is None:
        return None
    t = str(s).strip().replace(" ", "")
    if t in ("", "-", "–", "—", "#N/A", "#DIV/0!", "#VALUE!", "#REF!"):
        return None
    neg = t.startswith("(") and t.endswith(")")
    t = t.strip("()").replace(",", "").rstrip("%")
    if t.startswith("-") and t[1:].replace(".", "", 1).isdigit():
        return -float(t[1:])
    try:
        v = float(t)
    except ValueError:
        return None
    return -v if neg else v


def is_numeric_token(t: str) -> bool:
    t = t.strip()
    return bool(t) and all(c in NUMERIC_CHARS for c in t) and any(c.isdigit() for c in t)


def parse_short_date(s: str, ref: dt.date):
    """'22-Aug' / '1-Sep' / '22-Aug-26' / '22/08/2026' -> date. '0-Jan' -> None."""
    if not s:
        return None
    s = s.strip()
    m = re.match(r"^(\d{1,2})[-/ ]([A-Za-z]{3,9})(?:[-/ ](\d{2,4}))?$", s)
    if m:
        d, mon, yr = int(m.group(1)), MONTHS.get(m.group(2).lower()), m.group(3)
        if d == 0 or mon is None:
            return None
        if yr:
            y = int(yr) + (2000 if len(yr) == 2 else 0)
        else:
            # infer year: a month far *after* the report month belongs to last year
            y = ref.year - 1 if mon - ref.month > 6 else ref.year
            if ref.month - mon > 6:  # e.g. Jan date in a Dec report -> next year
                y = ref.year + 1
        try:
            return dt.date(y, mon, d)
        except ValueError:
            return None
    m = re.match(r"^(\d{1,2})/(\d{1,2})/(\d{2,4})$", s)
    if m:
        d, mo, y = map(int, m.groups())
        y += 2000 if y < 100 else 0
        try:
            return dt.date(y, mo, d)
        except ValueError:
            return None
    return None


# --------------------------------------------------------------------------
# layout primitives
# --------------------------------------------------------------------------
class Layout:
    def __init__(self, page):
        self.page = page
        self.width, self.height = page.width, page.height
        self.chars = [c for c in page.chars if c.get("upright", True)]
        self.words = page.extract_words(x_tolerance=1.5, y_tolerance=2, keep_blank_chars=False)
        for w in self.words:
            w["cx"] = (w["x0"] + w["x1"]) / 2
            w["cy"] = (w["top"] + w["bottom"]) / 2
        self.rects = page.rects
        self.lines = self._group_lines(self.words)

    # ---- lines / phrases --------------------------------------------------
    @staticmethod
    def _group_lines(words, tol=1.2):
        lines = []
        for w in sorted(words, key=lambda w: (w["top"], w["x0"])):
            if lines and abs(lines[-1]["top"] - w["top"]) <= tol:
                lines[-1]["words"].append(w)
            else:
                lines.append({"top": w["top"], "words": [w]})
        for ln in lines:
            ln["words"].sort(key=lambda w: w["x0"])
            ln["bottom"] = max(w["bottom"] for w in ln["words"])
            ln["cy"] = (ln["top"] + ln["bottom"]) / 2
        return lines

    def words_in(self, region):
        x0, y0, x1, y1 = region
        return [w for w in self.words if w["cx"] >= x0 and w["cx"] <= x1 and w["cy"] >= y0 and w["cy"] <= y1]

    def lines_in(self, region):
        return self._group_lines(self.words_in(region))

    def find_all(self, phrase, region=None):
        """All occurrences of a (multi-word) phrase. Matching ignores case/punct."""
        target = norm(phrase)
        out = []
        lines = self.lines_in(region) if region else self.lines
        for ln in lines:
            ws = ln["words"]
            for i in range(len(ws)):
                if not norm(ws[i]["text"]):
                    continue
                acc = ""
                for j in range(i, len(ws)):
                    acc += norm(ws[j]["text"])
                    if acc == target:
                        grp = ws[i:j + 1]
                        out.append({
                            "x0": min(w["x0"] for w in grp), "x1": max(w["x1"] for w in grp),
                            "top": min(w["top"] for w in grp), "bottom": max(w["bottom"] for w in grp),
                            "text": " ".join(w["text"] for w in grp),
                        })
                        break
                    if not target.startswith(acc):
                        break
        for o in out:
            o["cx"] = (o["x0"] + o["x1"]) / 2
            o["cy"] = (o["top"] + o["bottom"]) / 2
        return sorted(out, key=lambda o: (o["top"], o["x0"]))

    def find(self, phrase, region=None, required=True, first=True):
        hits = self.find_all(phrase, region)
        if not hits:
            if required:
                raise SectionError(f"anchor '{phrase}' not found")
            return None
        return hits[0] if first else hits

    # ---- text rebuilt from characters ------------------------------------
    def text_in_bbox(self, x0, top, x1, bottom):
        cs = [c for c in self.chars
              if c["x0"] >= x0 - 0.6 and c["x1"] <= x1 + 0.6
              and (c["top"] + c["bottom"]) / 2 >= top - 0.3 and (c["top"] + c["bottom"]) / 2 <= bottom + 0.3]
        # group into visual lines, then left-to-right
        cs.sort(key=lambda c: (round(c["top"], 0), c["x0"]))
        lines, cur, cur_top = [], [], None
        for c in sorted(cs, key=lambda c: c["top"]):
            if cur_top is None or abs(c["top"] - cur_top) <= 1.2:
                cur.append(c)
                cur_top = c["top"] if cur_top is None else cur_top
            else:
                lines.append(cur)
                cur, cur_top = [c], c["top"]
        if cur:
            lines.append(cur)
        txt = []
        for ln in lines:
            ln.sort(key=lambda c: c["x0"])
            txt.append(re.sub(r"\s+", " ", "".join(c["text"] for c in ln)).strip())
        return join_wrapped(txt)

    def vcuts(self, y, x0, x1):
        """x positions of vertical cell borders crossing height y (Excel table grid lines)."""
        xs = sorted(e["x0"] for e in self.page.edges
                    if e["orientation"] == "v" and e["top"] - 0.5 <= y <= e["bottom"] + 0.5 and x0 < e["x0"] < x1)
        out = []
        for x in xs:
            if not out or x - out[-1] > 1.5:
                out.append(x)
        return out

    def segments(self, region, gap=6.0, cuts=None):
        """Runs of words on one line separated by > gap pt or by a cell border in `cuts`;
        text rebuilt from chars."""
        cuts = cuts or []
        segs = []
        for ln in self.lines_in(region):
            run = [ln["words"][0]]
            for w in ln["words"][1:]:
                border = any(run[-1]["cx"] < c < w["cx"] for c in cuts)
                if border or w["x0"] - run[-1]["x1"] > gap:
                    segs.append(run)
                    run = [w]
                else:
                    run.append(w)
            segs.append(run)
        out = []
        for run in segs:
            x0, x1 = min(w["x0"] for w in run), max(w["x1"] for w in run)
            top, bottom = min(w["top"] for w in run), max(w["bottom"] for w in run)
            out.append({"x0": x0, "x1": x1, "top": top, "bottom": bottom,
                        "cx": (x0 + x1) / 2, "cy": (top + bottom) / 2,
                        "text": self.text_in_bbox(x0, top, x1, bottom)})
        return out

    # ---- numeric grid ----------------------------------------------------
    def merged_words(self, region):
        """Words in region with split numeric glyphs merged ('4' ',457' -> '4,457')."""
        out = []
        for ln in self.lines_in(region):
            cur = None
            for w in ln["words"]:
                if (cur is not None and w["x0"] - cur["x1"] < 1.3
                        and is_numeric_token(cur["text"]) and all(c in NUMERIC_CHARS for c in w["text"])):
                    cur = dict(cur)
                    cur["text"] += w["text"]
                    cur["x1"] = w["x1"]
                    cur["bottom"] = max(cur["bottom"], w["bottom"])
                    cur["cx"] = (cur["x0"] + cur["x1"]) / 2
                else:
                    if cur is not None:
                        out.append(cur)
                    cur = dict(w)
            if cur is not None:
                out.append(cur)
        return out

    def grid(self, region, rows, cols, max_dy=4.0, max_dx=14.0, numeric_only=True):
        """rows: {key: y_center}; cols: {key: x_center}. Returns {(row, col): text}."""
        cells = defaultdict(list)
        for w in self.merged_words(region):
            if numeric_only and not (is_numeric_token(w["text"]) or w["text"].strip() in ("-", "–")):
                continue
            rk, dy = min(((k, abs(w["cy"] - y)) for k, y in rows.items()), key=lambda t: t[1])
            ck, dx = min(((k, abs(w["cx"] - x)) for k, x in cols.items()), key=lambda t: t[1])
            if dy <= max_dy and dx <= max_dx:
                cells[(rk, ck)].append(w)
        return {k: " ".join(w["text"] for w in sorted(v, key=lambda w: w["x0"])) for k, v in cells.items()}

    def rect_containing(self, x, y, min_w=80, min_h=40):
        cands = [r for r in self.rects
                 if r["x0"] <= x <= r["x1"] and r["top"] <= y <= r["bottom"]
                 and r["width"] >= min_w and r["height"] >= min_h]
        return min(cands, key=lambda r: r["width"] * r["height"]) if cands else None


def join_wrapped(parts):
    out = ""
    for p in parts:
        if not p:
            continue
        if not out:
            out = p
        elif out.endswith("-"):
            out += p
        else:
            out += " " + p
    return out.strip()


def label_rows(lay, region, labels, max_x=None):
    """Find row-label y centres. labels: list of label strings (exact phrase, at line start)."""
    res = {}
    for lab in labels:
        for ln in lay.lines_in(region):
            ws = [w for w in ln["words"] if max_x is None or w["x0"] <= max_x]
            acc, grp = "", []
            for w in ws:
                acc += norm(w["text"])
                grp.append(w)
                if acc == norm(lab):
                    res[lab] = sum(g["cy"] for g in grp) / len(grp)
                    break
                if not norm(lab).startswith(acc):
                    break
            if lab in res:
                break
    return res


def repeated_headers(lay, line_region, names):
    """Header labels that repeat once per period block (e.g. 5 contractors x 4 periods).
    Returns list of blocks, each {name: cx}, in left-to-right order."""
    hits = []
    for n in names:
        for h in lay.find_all(n, line_region):
            hits.append((h["cx"], n))
    hits.sort()
    blocks, cur = [], {}
    for cx, n in hits:
        if n in cur:
            blocks.append(cur)
            cur = {}
        cur[n] = cx
    if cur:
        blocks.append(cur)
    return blocks


# --------------------------------------------------------------------------
# section location
# --------------------------------------------------------------------------
SECTION_KEYS = {
    "NOTE": "NOTE", "HEALTH": "HSE", "MINING": "MINING", "FORECAST": "FORECAST",
    "ORESTOCK": "STOCK", "SHIPMENT": "SHIPMENT", "EQUIPMENT": "EQUIPMENT",
    "LABORATORIUM": "LAB", "WEATHER": "WEATHER", "EXPLORATION": "EXPLORATION",
    "ENVIRONMENT": "ENVIRONMENT", "PROJECT": "PROJECT", "MANPOWER": "MANPOWER",
}


def locate_sections(lay):
    titles = []
    for ln in lay.lines:
        ws = ln["words"]
        for i, w in enumerate(ws):
            if re.fullmatch(r"\d{1,2}\.", w["text"]) and i + 1 < len(ws):
                rest = norm(" ".join(x["text"] for x in ws[i + 1:i + 4]))
                for k, key in SECTION_KEYS.items():
                    if rest.startswith(k):
                        titles.append({"key": key, "x0": w["x0"], "top": w["top"], "bottom": w["bottom"]})
                        break
    if not titles:
        raise SectionError("no section titles found - not a WKM daily report layout?")
    secs = {}
    for t in titles:
        later = [o for o in titles if o["top"] > t["top"] + 3]
        y1 = min((o["top"] for o in later), default=lay.height)
        same_row = [o for o in titles if abs(o["top"] - t["top"]) <= 3 and o["x0"] > t["x0"] + 5]
        x1 = min((o["x0"] for o in same_row), default=lay.width) - 1
        secs[t["key"]] = (t["x0"] - 2, t["top"] - 1, x1, y1 - 0.5)
    return secs


# --------------------------------------------------------------------------
# section parsers
# --------------------------------------------------------------------------
WEEKDAYS = r"(?:mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun)[a-z]*|senin|selasa|rabu|kamis|jumat|jum'at|sabtu|minggu"


def parse_report_date(txt):
    """Report date in any of the formats the site template has used, e.g.
       '18 September 2026' | 'Saturday, September 19, 2026' | 'Sabtu, 19 September 2026'
       '19-Sep-2026' | '19/09/2026' | '2026-09-19'.  Returns date or None."""
    t = " ".join(str(txt or "").replace(",", " , ").split())
    t = re.sub(rf"^\s*(?:{WEEKDAYS})\b\s*,?\s*", "", t, flags=re.I)
    pats = [
        (r"\b(\d{1,2})(?:st|nd|rd|th)?\s*[-/ ]?\s*([A-Za-z]{3,9})\.?\s*[-/ ,]?\s*(\d{4})\b", "dmy"),   # 18 September 2026 / 19-Sep-2026
        (r"\b([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?\s*,?\s*(\d{4})\b", "mdy"),               # September 19, 2026
        (r"\b(\d{4})-(\d{1,2})-(\d{1,2})\b", "iso"),                                                     # 2026-09-19
        (r"\b(\d{1,2})[/.](\d{1,2})[/.](\d{4})\b", "dmy_num"),                                            # 19/09/2026 (day first)
    ]
    for pat, kind in pats:
        for m in re.finditer(pat, t):
            try:
                if kind == "dmy":
                    mon = MONTHS.get(m.group(2).lower())
                    if mon:
                        return dt.date(int(m.group(3)), mon, int(m.group(1)))
                elif kind == "mdy":
                    mon = MONTHS.get(m.group(1).lower())
                    if mon:
                        return dt.date(int(m.group(3)), mon, int(m.group(2)))
                elif kind == "iso":
                    return dt.date(int(m.group(1)), int(m.group(2)), int(m.group(3)))
                else:
                    return dt.date(int(m.group(3)), int(m.group(2)), int(m.group(1)))
            except ValueError:
                continue
    return None


def parse_header(lay):
    head = (0, 0, lay.width, 45)
    date_ = None
    site = None
    lines = [" ".join(w["text"] for w in ln["words"]) for ln in lay.lines_in(head)]
    for txt in lines:
        if date_ is None:
            date_ = parse_report_date(txt)
        if site is None and ("SITE" in txt.upper() or "MINERAL" in txt.upper()):
            site = txt
    if date_ is None:
        raise SectionError("report date not found in header (lines read: " + " | ".join(lines[:4]) + ")")
    return {"report_date": date_, "site_text": site}


def parse_note(lay, region):
    txt = []
    for s in lay.segments((region[0], region[1] + 8, region[2], region[3])):
        if s["text"] and s["text"] not in ("x",):
            txt.append(s["text"])
    return " | ".join(txt)


def parse_hse(lay, region, cfg):
    names = cfg["hse_contractor_headers"]
    periods = ["DAILY", "WEEKLY", "MONTHLY", "YEARLY"]
    haz_hdr = lay.find("HAZARD LOCATION", region)
    tab = (region[0], region[1], region[2], haz_hdr["top"] - 1)
    ptitles = sorted([(lay.find(p, tab)["cx"], p) for p in periods])
    hdr_line = lay.find(names[0], tab)
    blocks = repeated_headers(lay, (tab[0], hdr_line["top"] - 2, tab[2], hdr_line["bottom"] + 2), names)
    if len(blocks) != len(ptitles):
        raise SectionError(f"HSE: {len(blocks)} contractor header blocks vs {len(ptitles)} periods")
    rows = label_rows(lay, tab, list(cfg["hse_categories"].keys()), max_x=95)
    if not rows:
        raise SectionError("HSE: no category rows")
    out = {}
    for (pcx, period), block in zip(ptitles, blocks):
        g = lay.grid(tab, rows, block, max_dy=3.0, max_dx=10)
        out[period] = {c: {r: num(g.get((r, c))) for r in rows} for c in block}
    return {"by_period": out, "categories_found": list(rows)}


def parse_hazards(lay, region, cfg):
    hdr = lay.find("HAZARD LOCATION", region)
    y0 = hdr["bottom"] + 1
    pic = lay.find("Picture of Hazard", (region[0], y0, region[2], region[3]), required=False)
    y1 = region[3]
    colnames = [("HAZARD LOCATION", "location"), ("IDENTIFIED HAZARDS", "identified"),
                ("CORRECTIVE ACTION", "corrective"), ("REPAIR STATUS", "status"),
                ("RISK LEVEL", "risk"), ("HAZARD CATEGORY", "category")]
    hline = (region[0], hdr["top"] - 2, region[2], hdr["bottom"] + 2)
    cols = {}
    for phrase, key in colnames:
        h = lay.find(phrase, hline)
        cols[key] = h["cx"]
    doc = lay.find("HAZARD DOCUMENTATION", hline, required=False)
    x_right = ((cols["category"] + doc["cx"]) / 2) if doc else region[2]
    # photos (and their captions) live in the documentation column: cut at the first image edge
    imgs = [im for im in lay.page.images if im["top"] >= y0 - 2 and im["bottom"] <= y1 + 2 and im["x0"] > cols["category"]]
    if imgs:
        x_right = min(x_right, min(im["x0"] for im in imgs) - 1)
    body = (region[0], y0, x_right, y1)
    cuts = lay.vcuts(hdr["cy"], region[0], x_right)
    segs = [s for s in lay.segments(body, cuts=cuts) if s["text"] and not re.match(r"(?i)^picture of hazard", s["text"])]
    for s in segs:
        s["col"] = min(cols, key=lambda k: abs(cols[k] - s["cx"]))
    anchors = sorted(s["cy"] for s in segs if s["col"] in ("location", "status", "risk", "category"))
    clusters = []
    for y in anchors:
        if clusters and y - clusters[-1][-1] <= 5:
            clusters[-1].append(y)
        else:
            clusters.append([y])
    centers = [sum(c) / len(c) for c in clusters]
    rows = [defaultdict(list) for _ in centers]
    for s in segs:
        if not centers:
            break
        i = min(range(len(centers)), key=lambda i: abs(centers[i] - s["cy"]))
        if abs(centers[i] - s["cy"]) <= 12:
            rows[i][s["col"]].append(s)
    out = []
    for r in rows:
        rec = {k: join_wrapped([s["text"] for s in sorted(r.get(k, []), key=lambda s: (s["top"], s["x0"]))])
               for _, k in colnames}
        vals = [v for v in rec.values() if v not in ("", "0", "-")]
        if not vals:
            continue  # empty template row ("0 0 0 0 0 0")
        out.append(rec)
    return out


def _mining_table(lay, region, cfg):
    """Shared layout of the PRODUCTION table: (table box, period titles, column blocks, actual rows, plan rows)."""
    periods = ["DAY", "WEEK", "MONTH", "YEAR"]
    hdr = lay.find("PRODUCTION", (region[0], region[1], region[0] + 80, region[3]))
    tab_right = None
    dp = lay.find("DAILY PRODUCTION", region, required=False)
    tab_right = (dp["x0"] - 2) if dp else region[2]
    tab = (region[0], region[1], tab_right, region[3])
    ptitles = sorted((lay.find(p, (tab[0], region[1], tab[2], hdr["bottom"] + 2))["cx"], p) for p in periods)
    hline_hit = lay.find("PT FSI", tab)
    hline = (tab[0], hline_hit["top"] - 2, tab[2], hline_hit["bottom"] + 2)
    blocks = repeated_headers(lay, hline, ["PT FSI", "PT TJA", "TOTAL"])
    if len(blocks) != 4:
        raise SectionError(f"MINING: expected 4 period blocks, got {len(blocks)}")
    labels = list(cfg["mining_rows"].keys())
    rows = label_rows(lay, tab, labels, max_x=60)
    # exclude PLAN rows (label starts with PLAN); label_rows already requires exact line-start match
    missing = [l for l in ("SOIL", "OB", "LGO", "HGO", "QUARRY") if l not in rows]
    if missing:
        raise SectionError(f"MINING: rows not found {missing}")
    plan_rows = label_rows(lay, tab, ["PLAN " + l for l in labels] + ["PLAN LIMONIT"], max_x=60)
    return tab, ptitles, blocks, rows, plan_rows


def _mining_values(lay, cfg, tab, ptitles, blocks, rows, plan_rows, which):
    allrows = dict(rows)
    allrows.update(plan_rows)  # plan rows are always in the grid, so their numbers never land on an actual row
    out = {}
    for (_, period), block in zip(ptitles, blocks):
        g = lay.grid(tab, allrows, block, max_dy=2.8, max_dx=13)
        for r in which:
            out.setdefault(r, {})[period] = {c: num(g.get((r, c))) for c in block}
    return out


def parse_mining(lay, region, cfg):
    tab, ptitles, blocks, rows, plan_rows = _mining_table(lay, region, cfg)
    return _mining_values(lay, cfg, tab, ptitles, blocks, rows, plan_rows, rows)


def parse_mining_plan(lay, region, cfg):
    """PLAN rows of the PRODUCTION table: {'PLAN HGO': {'DAY': {'PT FSI': .., 'PT TJA': .., 'TOTAL': ..}, ...}}."""
    tab, ptitles, blocks, rows, plan_rows = _mining_table(lay, region, cfg)
    if not plan_rows:
        raise SectionError("MINING: no PLAN rows found")
    return _mining_values(lay, cfg, tab, ptitles, blocks, rows, plan_rows, plan_rows)


def parse_pit_chart(lay, cfg, ocr=True):
    pc = cfg["pit_chart"]
    t = lay.find(pc["title"])
    box = lay.rect_containing(t["cx"], t["cy"])
    if box is None:
        raise SectionError("pit chart frame not found")
    region = (box["x0"] + 1, t["bottom"] + 1, box["x1"] - 1, box["bottom"] - 1)
    vals = [w for w in lay.merged_words(region) if is_numeric_token(w["text"])]
    vals.sort(key=lambda w: w["cx"])
    values = [num(w["text"]) for w in vals]
    res = {"values": values, "x": [round(w["cx"], 1) for w in vals], "ocr_names": None,
           "box": (box["x0"], box["top"], box["x1"], box["bottom"])}
    if ocr and pc.get("ocr_check", True):
        res["ocr_names"] = _ocr_pit_labels(lay, region, vals)
    return res


def _ocr_pit_labels(lay, region, vals):
    """Best-effort OCR of the rotated (vector-outlined) category labels."""
    try:
        import pytesseract  # noqa
    except Exception:
        return None
    try:
        base_y = max(w["bottom"] for w in vals) if vals else region[1]
        crop = (region[0], base_y + 1, region[2], region[3])
        im = lay.page.crop(crop).to_image(resolution=600).original.convert("L")
        best = None
        for ang in (-45, -40, -50):
            r = im.rotate(ang, expand=True, fillcolor=255)
            toks = [x for x in pytesseract.image_to_string(r, config="--psm 11").split() if len(x) > 2]
            if best is None or len(toks) > len(best):
                best = toks
        return best
    except Exception:
        return None


def parse_stock(lay, region, cfg):
    blocks = lay.find_all("The remaining dome", region)
    if not blocks:
        raise SectionError("ORE STOCK: 'The remaining dome ...' block titles not found")
    stock_type = "EFO"
    st = " ".join(w["text"] for ln in lay.lines_in((region[0], region[1], region[0] + 150, region[1] + 8)) for w in ln["words"])
    if "ETO" in st.upper():
        stock_type = "ETO"
    out = {}
    for i, b in enumerate(blocks):
        line_txt = " ".join(w["text"] for w in lay.lines_in((b["x0"], b["top"] - 1, b["x0"] + 200, b["bottom"] + 1))[0]["words"])
        m = re.search(r"\bPT\.?\s*([A-Z]{2,4})\b", line_txt)
        if not m:
            raise SectionError(f"ORE STOCK: contractor not readable in '{line_txt}'")
        contractor = "PT " + m.group(1)
        y1 = blocks[i + 1]["top"] - 1 if i + 1 < len(blocks) else region[3]
        hdr = lay.find("TONNAGE", (region[0], b["bottom"], region[2], y1))
        right = hdr["x1"] + 110
        tab = (region[0], b["bottom"] + 0.5, min(right, b["x0"] + 200), y1)
        hline = (tab[0], hdr["top"] - 2, tab[2], hdr["bottom"] + 2)
        ton = hdr["cx"]
        sat = lay.find("SATUAN", hline)["cx"]
        ni_hits = [h for h in lay.find_all("Ni", hline) if h["cx"] > sat]
        simgo = lay.find("Si/MgO", hline)["cx"]
        cat = lay.find("CATEGORI", hline, required=False)
        cols = {"TONNAGE": ton, "SATUAN": sat, "NI": ni_hits[0]["cx"], "SIMGO": simgo}
        if cat:
            cols["CATEGORY"] = cat["cx"] + 6
        labels = list(cfg["stock_rows"].keys()) + ["TOTAL"]
        rows = label_rows(lay, tab, labels, max_x=tab[0] + 60)
        g = lay.grid(tab, rows, cols, max_dy=3.2, max_dx=16, numeric_only=False)
        rec = {}
        for r in rows:
            rec[r] = {c: g.get((r, c)) for c in cols}
            for c in ("TONNAGE", "NI", "SIMGO"):
                rec[r][c] = num(rec[r][c])
        out[contractor] = rec
    return {"type": stock_type, "by_contractor": out}


def parse_bar_chart_labels(lay, title, cats, region=None):
    """Bar chart with data labels: returns {category: value} by x alignment."""
    t = lay.find(title, region)
    box = lay.rect_containing(t["cx"], t["cy"], min_w=60, min_h=30)
    if box is not None:
        reg = (box["x0"], t["bottom"], box["x1"], box["bottom"])
    else:
        reg = (t["x0"] - 60, t["bottom"], t["x1"] + 60, t["bottom"] + 60)
    catpos = {}
    for c in cats:
        hits = lay.find_all(c, reg)
        if hits:
            catpos[c] = max(hits, key=lambda h: h["top"])  # axis labels are lowest
    if len(catpos) != len(cats):
        raise SectionError(f"chart '{title}': categories {cats} not all found ({list(catpos)})")
    axis_y = min(h["top"] for h in catpos.values())
    vals = [w for w in lay.merged_words((reg[0], reg[1], reg[2], axis_y - 0.5)) if is_numeric_token(w["text"])]
    out = {}
    for c, h in catpos.items():
        cand = [w for w in vals if abs(w["cx"] - h["cx"]) <= 14]
        if not cand:
            out[c] = None
            continue
        out[c] = num(min(cand, key=lambda w: abs(w["cx"] - h["cx"]))["text"])
    return out


def parse_sales(lay, region):
    hdr = lay.find("BARGING", (region[0], region[1], region[0] + 120, region[3]))
    nosi = lay.find("NO SI", region)
    tot = lay.find("TOTAL SHIPMENT", region, required=False)
    right = (tot["x0"] - 20) if tot else region[0] + 300
    tab = (region[0], region[1], right, nosi["top"] - 1)
    periods = sorted((lay.find(p, tab)["cx"], p) for p in ("WEEK", "MONTH", "YEAR"))
    fsi = lay.find("PT FSI", tab)
    hline = (tab[0], fsi["top"] - 2, tab[2], fsi["bottom"] + 2)
    blocks = repeated_headers(lay, hline, ["PT FSI", "PT TJA"])
    if len(blocks) != 3:
        raise SectionError(f"SALES: expected 3 period blocks got {len(blocks)}")
    rows = label_rows(lay, tab, ["TARGET SALE (WMT)", "ACTUAL SALE (WMT)", "ACHIEVEMENT (%)"], max_x=tab[0] + 60)
    out = {}
    for (_, p), block in zip(periods, blocks):
        g = lay.grid(tab, rows, block, max_dy=3.5, max_dx=22)
        out[p] = {r: {c: num(g.get((r, c))) for c in block} for r in rows}
    return out


def parse_barges(lay, region, report_date, cfg):
    hdr = lay.find("NO SI", region)
    hline = (region[0], hdr["top"] - 2, region[0] + 450, hdr["bottom"] + 2)
    spec = [("NO SI", "si"), ("BARGE", "vessel"), ("CONTRACTOR", "contractor"), ("STAR", "start"),
            ("FINISH", "finish"), ("CAPACITY PLAN", "plan_cap"), ("CAPACITY ACTUAL", "actual_cap"),
            ("GRADE PLAN", "grade_plan"), ("STATUS", "status")]
    cols = {}
    for ph, k in spec:
        h = lay.find(ph, hline, required=(k not in ("start",)))
        if h is None and k == "start":
            h = lay.find("START", hline)
        cols[k] = h["cx"]
    right = max(cols.values()) + 25
    body = (region[0], hdr["bottom"] + 1, right, region[3])
    segs = [s for s in lay.segments(body, gap=5.0, cuts=lay.vcuts(hdr["cy"], body[0], body[2])) if s["text"]]
    for s in segs:
        if re.fullmatch(r"\d{1,5}", s["text"].strip()) and abs(s["cx"] - cols["si"]) <= 12:
            s["col"] = "si"
        else:  # text columns are left-aligned: never assign free text to the SI column
            s["col"] = min((k for k in cols if k != "si"), key=lambda k: abs(cols[k] - s["cx"]))
    si_segs = [s for s in segs if s["col"] == "si"]
    out = []
    for si in sorted(si_segs, key=lambda s: s["cy"]):
        rec = defaultdict(list)
        for s in segs:
            if abs(s["cy"] - si["cy"]) <= 2.6 and s is not si:
                rec[s["col"]].append(s)
        r = {"si": si["text"].strip()}
        for k in ("vessel", "contractor", "start", "finish", "plan_cap", "actual_cap", "grade_plan", "status"):
            r[k] = join_wrapped([s["text"] for s in sorted(rec.get(k, []), key=lambda s: s["x0"])])
        r["vessel"] = re.sub(r"\s*/\s*", " / ", r["vessel"]).strip()
        r["start"] = parse_short_date(r["start"], report_date)
        r["finish"] = parse_short_date(r["finish"], report_date)
        for k in ("plan_cap", "actual_cap", "grade_plan"):
            r[k] = num(r[k])
            if r[k] == 0:
                r[k] = None
        out.append(r)
    return out


def parse_equipment(lay, region, cfg):
    up = lay.find("UNIT PERFORMANCE", region, required=False)
    right = (up["x0"] - 150) if up else region[0] + 340
    act = lay.find("ACTIVITY", region)
    tab_right = None
    adt = lay.find("ADT", (region[0], act["top"] - 3, region[2], act["bottom"] + 3))
    tab_right = adt["x1"] + 12
    tab = (region[0], act["top"] - 6, tab_right, region[3])
    cols = {}
    for lab, key in cfg["equipment_columns"].items():
        h = lay.find(lab, tab, required=False)
        if h:
            cols[key] = h["cx"]
    if "DT" not in cols or "EXC1" not in cols:
        raise SectionError(f"EQUIPMENT: column headers incomplete {list(cols)}")
    acts = cfg["equipment_rows"]
    act_rows = []
    for ln in lay.lines_in(tab):
        for w in ln["words"]:
            if w["text"].upper() in acts and w["x0"] > act["x0"] - 10 and w["x0"] < act["x1"] + 30:
                act_rows.append((w["cy"], w["text"].upper()))
    clabels = []
    for lab in cfg["equipment_contractor_labels"]:
        for h in lay.find_all(lab, (region[0], act["bottom"], act["x0"] - 1, region[3])):
            clabels.append((h["cy"], lab))
    if not clabels:
        raise SectionError("EQUIPMENT: contractor labels not found")
    out = {}
    for cy, a in act_rows:
        c = min(clabels, key=lambda t: abs(t[0] - cy))[1]
        g = lay.grid((act["x1"] + 2, cy - 3, tab_right, cy + 3), {"r": cy}, cols, max_dy=3, max_dx=12)
        vals = {k: g.get(("r", k)) for k in cols}
        out.setdefault(c, {})[acts[a]] = {k: (None if v in (None, "-") else num(v)) for k, v in vals.items()}
        out[c][acts[a]]["_dash"] = all(v in (None, "-") for v in vals.values())
    return out


def parse_unit_performance(lay, region, cfg):
    up = lay.find("UNIT PERFORMANCE", region)
    fc = lay.find("FUEL CONSUMPTION", region)
    area = (up["x0"] - 230, up["bottom"], region[2], fc["top"] - 1)
    units = lay.find_all("UNIT", area)
    units = [u for u in units if u["text"].upper() == "UNIT"]
    if len(units) < 2:
        raise SectionError("UNIT PERFORMANCE: block headers not found")
    units.sort(key=lambda u: u["x0"])
    blocks = []
    for i, u in enumerate(units[:2]):
        x0 = u["x0"] - 4
        x1 = units[i + 1]["x0"] - 4 if i + 1 < len(units) else region[2]
        blocks.append((x0, x1))
    out = {}
    for x0, x1 in blocks:
        reg = (x0, area[1], x1, area[3])
        ctr = None
        for name in ("PT FSI", "PT TJA", "PT WKM"):
            if lay.find(name, reg, required=False):
                ctr = name
        if ctr is None:
            raise SectionError("UNIT PERFORMANCE: contractor title not found")
        fuel = lay.find("FUEL (LTR)", reg)
        fr = lay.find("FR", reg)
        ewh = lay.find("EWH", reg)
        hdr_y = fuel["cy"]
        vline = [w for w in lay.merged_words((x0, hdr_y + 2, x1, hdr_y + 12)) if is_numeric_token(w["text"])]
        def nearest(cx):
            c = [w for w in vline if abs(w["cx"] - cx) <= 15]
            return num(min(c, key=lambda w: abs(w["cx"] - cx))["text"]) if c else None
        rec = {"FUEL": nearest(fuel["cx"]), "FR": nearest(fr["cx"]), "EWH": nearest(ewh["cx"]), "units": {}}
        uh = lay.find("UNIT", reg)
        hl = (x0, uh["top"] - 2, x1, uh["bottom"] + 2)
        cols = {k: lay.find(k, hl)["cx"] for k in ("PA", "MA", "UA", "EU")}
        rows = {}
        for lab in cfg["unit_perf_rows"]:
            h = [w for w in lay.words_in((x0, uh["bottom"], uh["x1"] + 8, area[3])) if w["text"].upper() == lab]
            if h:
                rows[lab] = h[0]["cy"]
        g = lay.grid((uh["x1"] + 2, uh["bottom"], x1, area[3]), rows, cols, max_dy=3, max_dx=10)
        for r in rows:
            rec["units"][cfg["unit_perf_rows"][r]] = {c: num(g.get((r, c))) for c in cols}
        out[ctr] = rec
    return out


def parse_fuel(lay, region, cfg):
    fc = lay.find("FUEL CONSUMPTION", region)
    comp = lay.find("COMPANY", (fc["x0"] - 250, fc["bottom"], fc["x0"] + 10, region[3]))
    stock = lay.find("STOCK", (comp["x1"], comp["top"] - 2, comp["x1"] + 150, comp["bottom"] + 2))
    hl = (comp["x0"] - 2, comp["top"] - 2, stock["x1"] + 2, comp["bottom"] + 2)
    cols = {k: lay.find(k, hl)["cx"] for k in ("DAY", "WEEK", "MONTH", "STOCK")}
    tab = (comp["x0"] - 6, comp["bottom"], stock["x1"] + 12, region[3])
    rows = {}
    for w in lay.words_in((tab[0], tab[1], comp["x1"] + 8, tab[3])):
        if w["text"].upper() in cfg["fuel_company_labels"]:
            rows[w["text"].upper()] = w["cy"]
    g = lay.grid(tab, rows, cols, max_dy=3, max_dx=14)
    return {r: {c: num(g.get((r, c))) for c in cols} for r in rows}


def parse_lab(lay, region, cfg):
    day = lay.find("DAY", region)
    qc = lay.find("QC", region)
    hline = (region[0], qc["top"] - 2, region[2], qc["bottom"] + 2)
    names = list(cfg["lab_cols"].keys())
    blocks = repeated_headers(lay, hline, [n for n in names if lay.find(n, hline, required=False)])
    ptitles = sorted((lay.find(p, (region[0], day["top"] - 2, region[2], day["bottom"] + 2))["cx"], p)
                     for p in ("DAY", "MONTH", "YEAR"))
    if len(blocks) < 3:
        raise SectionError(f"LAB: expected 3 header blocks got {len(blocks)}")
    rows = label_rows(lay, region, list(cfg["lab_rows"].keys()) + ["TOTAL"], max_x=region[0] + 50)
    out = {}
    for (_, p), block in zip(ptitles, blocks[:3]):
        g = lay.grid(region, rows, block, max_dy=2.6, max_dx=10)
        out[p] = {r: {c: num(g.get((r, c))) for c in block} for r in rows}
    eq = {}
    eqh = lay.find("EQUIPMENT", region, required=False)
    if eqh:
        eqcols = {}
        for lab in cfg["lab_equipment_cols"]:
            h = lay.find(lab, (eqh["x0"] - 80, hline[1], region[2], hline[3]), required=False)
            if h:
                eqcols[lab] = h["cx"]
        eqrows = {}
        for lab in cfg["lab_equipment_rows"]:
            hs = lay.find_all(lab, (eqh["x0"] - 80, hline[3], region[2], region[3]))
            if hs:
                eqrows[lab] = hs[0]["cy"]
        g = lay.grid((eqh["x0"] - 80, hline[3], region[2], region[3]), eqrows, eqcols, max_dy=2.6, max_dx=10)
        eq = {r: {c: num(g.get((r, c))) for c in eqcols} for r in eqrows}
    return {"by_period": out, "equipment": eq}


def parse_weather(lay, region, report_date, cfg):
    rd = lay.find("RAIN DURATION", region)
    ew = lay.find("EFFECTIVE WORKING HOURS", (region[0], rd["top"] - 2, region[2], rd["bottom"] + 2))
    split = (rd["x1"] + ew["x0"]) / 2
    out = {}
    for key, (x0, x1) in (("RAIN", (region[0], split)), ("EWH", (split, region[2]))):
        reg = (x0, region[1], x1, region[3])
        dhs = lay.find_all("DATE", reg)
        if not dhs:
            raise SectionError("WEATHER: DATE header missing")
        dh = dhs[0]
        hl = [w for w in lay.words_in((dh["x1"], dh["top"] - 2, x1, dh["bottom"] + 2))]
        dates = {}
        for w in hl:
            d = parse_short_date(w["text"], report_date)
            if d:
                dates[d] = w["cx"]
        rows = {}
        for w in lay.words_in((x0, dh["bottom"], dh["x1"] + 5, region[3])):
            if w["text"].upper() in cfg["weather_contractor_labels"]:
                rows[w["text"].upper()] = w["cy"]
        g = lay.grid((dh["x1"], dh["bottom"], x1, region[3]), rows, dates, max_dy=3, max_dx=12)
        out[key] = {r: {d: num(g.get((r, d))) for d in dates} for r in rows}
    return out


def parse_exploration(lay, region, cfg):
    res = {"drilling": {}, "survey": {}}
    # ---- drilling table: use the 'Total' row
    dh = lay.find("DRILLING", (region[0], region[1], region[0] + 60, region[3]))
    hdr = [h for h in lay.find_all("DH", region) if h["top"] < dh["bottom"] + 15]
    if hdr:
        hy = hdr[0]["cy"]
        hl = (region[0], hy - 2, region[0] + 470, hy + 2)
        heads = sorted([w for w in lay.words_in(hl)], key=lambda w: w["cx"])
        # header order: Drillholes Depth | DH Samp Depth DH Samp Depth % | DH Samp Depth DH Samp Depth %
        keys = [w["text"] for w in heads]
        total = label_rows(lay, (region[0], hy, region[0] + 470, region[3]), ["Total"], max_x=region[0] + 40)
        if "Total" in total and len(heads) >= 16:
            cols = {i: w["cx"] for i, w in enumerate(heads)}
            g = lay.grid((region[0] + 40, hy + 2, region[0] + 470, region[3]), {"T": total["Total"]}, cols, max_dy=2.5, max_dx=12)
            vals = [num(g.get(("T", i))) for i in range(len(heads))]
            comp_titles = [h for h in lay.find_all("PT", (region[0] + 120, dh["top"] - 10, region[0] + 470, dh["top"]))]
            names = []
            for h in sorted(comp_titles, key=lambda h: h["x0"]):
                ln = lay.lines_in((h["x0"] - 1, h["top"] - 1, h["x0"] + 160, h["bottom"] + 1))
                names.append(" ".join(w["text"] for w in ln[0]["words"]) if ln else "?")
            for bi, name in enumerate(names[:2]):
                o = 2 + bi * 7
                v = vals[o:o + 7]
                res["drilling"][name] = {"P-DH": v[0], "P-SAMPLE": v[1], "P-DEPTH": v[2],
                                         "A-DH": v[3], "A-SAMPLE": v[4], "A-DEPTH": v[5], "PCT": v[6]}
            res["drilling_recap"] = {"FINISHED_DH": vals[0], "FINISHED_DEPTH": vals[1]}
            res["drilling_headers"] = keys
    # ---- survey table
    so = lay.find("STAKEOUT", region, required=False)
    if so:
        pu = lay.find("PICKUP", region)
        plans = sorted(lay.find_all("PLAN", (region[0], so["bottom"], pu["x1"] + 40, so["bottom"] + 14)), key=lambda h: h["cx"])
        acts = sorted(lay.find_all("ACTUAL", (region[0], so["bottom"], pu["x1"] + 40, so["bottom"] + 14)), key=lambda h: h["cx"])
        rem = lay.find("REMARKS", (pu["x1"], so["top"], region[0] + 480, so["bottom"] + 14), required=False)
        if len(plans) >= 2 and len(acts) >= 2:
            cols = {"SO-PLAN": plans[0]["cx"], "SO-ACTUAL": acts[0]["cx"], "PUH-PLAN": plans[1]["cx"], "PUH-ACTUAL": acts[1]["cx"]}
            if rem:  # remark column: from the last % column to the next table's COMPANY header
                pct = [h for h in lay.find_all("%", (pu["x0"], so["bottom"], rem["x0"], so["bottom"] + 14))]
                rem_x0 = (max(h["x1"] for h in pct) + 8) if pct else acts[1]["x1"] + 30
                nxt = [h for h in lay.find_all("COMPANY", (rem["x1"], so["top"] - 2, region[2], so["bottom"] + 14))]
                rem_x1 = (min(h["x0"] for h in nxt) - 4) if nxt else region[2]
            y0 = plans[0]["bottom"] + 1
            body = (region[0], y0, (rem["x0"] - 20) if rem else region[0] + 270, region[3])
            numrows = sorted({round(w["cy"], 0) for w in lay.merged_words((plans[0]["x0"] - 10, y0, body[2], region[3]))
                              if is_numeric_token(w["text"])})
            comp_segs = [s for s in lay.segments((region[0], y0, plans[0]["x0"] - 12, region[3])) if s["text"]]
            for y in numrows:
                g = lay.grid(body, {"r": y}, cols, max_dy=2.5, max_dx=10)
                near = sorted([s for s in comp_segs if abs(s["cy"] - y) <= 9], key=lambda s: s["top"])
                name = join_wrapped([s["text"] for s in near])
                rec = {k: num(g.get(("r", k))) for k in cols}
                if rem:
                    rsegs = [s for s in lay.segments((rem_x0, y - 8, rem_x1, y + 8))
                             if s["text"] not in ("0", "") and not is_numeric_token(s["text"])
                             and abs(s["cx"] - rem["cx"]) <= 60]  # remark cells are centred under REMARKS
                    rec["REMARK2"] = join_wrapped([s["text"] for s in sorted(rsegs, key=lambda s: s["top"])])
                res["survey"][name] = rec
    return res


def parse_construction(lay, region, cfg):
    hdr = lay.find("PROJECT", (region[0], region[1] + 6, region[2], region[3]))
    hl = (region[0], hdr["top"] - 2, region[2], hdr["bottom"] + 2)
    cols = {"project": hdr["cx"], "progress": lay.find("PROGRESS", hl)["cx"], "remark": lay.find("REMARK", hl)["cx"]}
    segs = [s for s in lay.segments((region[0], hdr["bottom"] + 1, region[2], region[3]), gap=6,
                                    cuts=lay.vcuts(hdr["cy"], region[0], region[2])) if s["text"]]
    for s in segs:
        s["col"] = min(cols, key=lambda k: abs(cols[k] - s["cx"]))
    prog = sorted([s for s in segs if s["col"] == "progress"], key=lambda s: s["cy"])
    out = []
    for p in prog:
        r = {"progress": num(p["text"])}
        for k in ("project", "remark"):
            r[k] = join_wrapped([s["text"] for s in segs if s["col"] == k and abs(s["cy"] - p["cy"]) <= 2.5])
        out.append(r)
    return out


def parse_manpower(lay, region, cfg):
    comp = lay.find("COMPANY", region)
    hl = (region[0], comp["top"] - 2, region[2], comp["bottom"] + 2)
    keys = ["ADD", "RESIGN", "TOTAL", "MANAGER", "SPT", "SPV", "DRIVER", "OPERATOR", "ETC"]
    cols = {k: lay.find(k, hl)["cx"] for k in keys}
    rows = label_rows(lay, (region[0], comp["bottom"], region[2], region[3]), cfg["manpower_company_labels"], max_x=comp["x1"] + 5)
    g = lay.grid((comp["x1"] + 2, comp["bottom"], region[2], region[3]), rows, cols, max_dy=2.6, max_dx=12)
    return {r: {c: num(g.get((r, c))) for c in cols} for r in rows}


def parse_environment(lay, region):
    loc = lay.find("SEDPOND", region)
    hl = (region[0], loc["top"] - 2, region[2], loc["bottom"] + 2)
    cols = {k: lay.find(k, hl)["cx"] for k in ("TSS", "PH", "DEBIT")}
    out = []
    for ln in lay.lines_in((region[0], loc["bottom"] + 1, region[2], region[3])):
        nm = [w for w in ln["words"] if w["cx"] < cols["TSS"] - 12]
        name = " ".join(w["text"] for w in nm)
        g = lay.grid((region[0], ln["top"] - 1, region[2], ln["bottom"] + 1), {"r": ln["cy"]}, cols, max_dy=3, max_dx=10)
        if name:
            out.append({"location": name, **{k: num(g.get(("r", k))) for k in cols}})
    return out


# --------------------------------------------------------------------------
# entry point
# --------------------------------------------------------------------------
def parse_daily_report(pdf_path, cfg, ocr=True):
    """Parse the PDF. Returns (parsed: dict, errors: list[(section, message)])."""
    errors = []
    with pdfplumber.open(pdf_path) as pdf:
        if len(pdf.pages) != 1:
            errors.append(("FILE", f"expected 1 page, found {len(pdf.pages)} - only page 1 parsed"))
        lay = Layout(pdf.pages[0])
        out = {"parser_version": PARSER_VERSION}
        out["meta"] = parse_header(lay)
        rdate = out["meta"]["report_date"]
        secs = locate_sections(lay)
        out["sections_found"] = sorted(secs)

        def run(key, fn, *args):
            try:
                out[key] = fn(*args)
            except SectionError as e:
                errors.append((key, str(e)))
            except Exception as e:  # keep other sections alive
                errors.append((key, f"{type(e).__name__}: {e}"))

        S = secs.get
        if S("NOTE"):
            run("note", parse_note, lay, S("NOTE"))
        if S("HSE"):
            run("hse", parse_hse, lay, S("HSE"), cfg)
            run("hazards", parse_hazards, lay, S("HSE"), cfg)
        if S("MINING"):
            run("mining", parse_mining, lay, S("MINING"), cfg)
            run("mining_plan", parse_mining_plan, lay, S("MINING"), cfg)
            run("pit_chart", parse_pit_chart, lay, cfg, ocr)
        if S("STOCK"):
            run("stock", parse_stock, lay, S("STOCK"), cfg)
            run("hauling", parse_bar_chart_labels, lay, "TOTAL HAULING TO", ["DAY", "WEEK", "MONTH", "YEAR"], S("STOCK"))
        if S("SHIPMENT"):
            run("shipment_total", parse_bar_chart_labels, lay, "TOTAL SHIPMENT", ["DAY", "WTD", "MTD", "YTD"], S("SHIPMENT"))
            run("sales", parse_sales, lay, S("SHIPMENT"))
            run("barges", parse_barges, lay, S("SHIPMENT"), rdate, cfg)
        if S("EQUIPMENT"):
            run("equipment", parse_equipment, lay, S("EQUIPMENT"), cfg)
            run("unit_perf", parse_unit_performance, lay, S("EQUIPMENT"), cfg)
            run("fuel", parse_fuel, lay, S("EQUIPMENT"), cfg)
        if S("LAB"):
            run("lab", parse_lab, lay, S("LAB"), cfg)
        if S("WEATHER"):
            run("weather", parse_weather, lay, S("WEATHER"), rdate, cfg)
        if S("EXPLORATION"):
            run("exploration", parse_exploration, lay, S("EXPLORATION"), cfg)
        if S("PROJECT"):
            run("construction", parse_construction, lay, S("PROJECT"), cfg)
        if S("MANPOWER"):
            run("manpower", parse_manpower, lay, S("MANPOWER"), cfg)
        if S("ENVIRONMENT"):
            run("environment", parse_environment, lay, S("ENVIRONMENT"))
    return out, errors
