"""Extract step for TMS hazards: 'Laporan Inspeksi Harian' (安全巡查日报) .docx.

The report has three tables:
  0  new findings today         NO | Posisi | Deskripsi Bahaya | Tindak Lanjut | Foto
  1  still open (earlier)        NO | Deskripsi | Tanggung Jawab | Tanggal Temuan | Batas Waktu | Alasan belum diperbaiki
  2  closed today                NO | Tanggal Temuan | Deskripsi | Diverifikasi Oleh | Foto
Report date comes from the header paragraph '2026年Thn 09月Bln 01日Hari ...'.
"""
from __future__ import annotations

import datetime as dt
import hashlib
import os
import re
from dataclasses import dataclass, field

import docx

from tms_dpr_parser import Issue

HAZARD_PARSER_VERSION = "1.0.0"

BULAN = {"januari": 1, "februari": 2, "maret": 3, "april": 4, "mei": 5, "juni": 6, "juli": 7,
         "agustus": 8, "september": 9, "oktober": 10, "november": 11, "desember": 12,
         "january": 1, "february": 2, "march": 3, "may": 5, "june": 6, "july": 7, "august": 8,
         "october": 10, "december": 12}
HDR_DATE = re.compile(r"(20\d{2})\s*年.*?(\d{1,2})\s*月.*?(\d{1,2})\s*日")
ID_DATE = re.compile(r"(\d{1,2})\s+([A-Za-z]+)\s+(20\d{2})")
NAME_DATE = re.compile(r"(\d{2})(\d{2})(20\d{2})")
INSPECTOR = re.compile(r"Inspeksi Oleh\s*:\s*(.+)$", re.I)


@dataclass
class HazardReport:
    path: str
    file_name: str
    sha: str
    report_date: dt.date | None = None
    header_date: dt.date | None = None
    name_date: dt.date | None = None
    shift_text: str | None = None
    inspectors: str | None = None
    new: list = field(default_factory=list)
    open: list = field(default_factory=list)
    closed: list = field(default_factory=list)
    issues: list = field(default_factory=list)

    def add(self, sev, check, msg, **kw):
        self.issues.append(Issue(sev, kw.pop("date", self.report_date), "tblRAWHAZARD", check, msg, **kw))


def norm_id(s):
    return re.sub(r"\s+", "", str(s or "")).upper()


def id_date(s):
    m = ID_DATE.search(str(s or ""))
    if not m:
        return None
    mon = BULAN.get(m[2].lower())
    return dt.date(int(m[3]), mon, int(m[1])) if mon else None


def _clean(s):
    s = re.sub(r"[ \t]+", " ", str(s or "")).strip()
    s = re.sub(r"\s*\n\s*", " / ", s)
    return s


def _rows(table):
    out = []
    for r in table.rows[1:]:
        cells, prev = [], None
        for c in r.cells:
            if c._tc is prev:
                continue
            prev = c._tc
            cells.append(_clean(c.text))
        if any(cells):
            out.append(cells)
    return out


def _header_kind(table):
    h = _clean(" ".join(c.text for c in table.rows[0].cells)).lower()
    if "posisi" in h and "tindak lanjut" in h:
        return "new"
    if "batas waktu" in h or "alasan" in h:
        return "open"
    if "verifikasi" in h:
        return "closed"
    return None


def parse_hazard(path) -> HazardReport:
    h = hashlib.sha256(open(path, "rb").read()).hexdigest()[:12]
    rep = HazardReport(path=path, file_name=os.path.basename(path), sha=h)
    try:
        d = docx.Document(path)
    except Exception as e:  # noqa
        rep.add("ERROR", "open", f"cannot open {rep.file_name}: {e}")
        return rep
    for p in d.paragraphs[:8]:
        t = p.text
        m = HDR_DATE.search(t)
        if m and not rep.report_date:
            try:
                rep.report_date = dt.date(int(m[1]), int(m[2]), int(m[3]))
            except ValueError:
                pass
        ms = re.search(r"(\d+\s*\(\w+\))\s*班\s*shift", t, re.I)
        if ms and not rep.shift_text:
            rep.shift_text = ms[1]
        mi = INSPECTOR.search(t)
        if mi:
            rep.inspectors = mi[1].strip()
    rep.header_date = rep.report_date
    m = NAME_DATE.search(rep.file_name)
    if m:
        try:
            rep.name_date = dt.date(int(m[3]), int(m[2]), int(m[1]))
        except ValueError:
            pass
    if not rep.report_date:
        if rep.name_date:
            rep.report_date = rep.name_date
            rep.add("WARN", "report-date", f"{rep.file_name}: no date in header, file-name date {rep.name_date} used")
        else:
            rep.add("ERROR", "report-date", f"{rep.file_name}: report date not found in header or file name")
            return rep

    kinds = {}
    for t in d.tables:
        k = _header_kind(t)
        if k and k not in kinds:
            kinds[k] = t
    for k in ("new", "open", "closed"):
        if k not in kinds:
            rep.add("ERROR", "layout", f"{rep.file_name}: '{k}' table not found (layout changed?)")
    if "new" in kinds:
        for c in _rows(kinds["new"]):
            c += [""] * (5 - len(c))
            if not (c[0] or c[2]):
                continue
            rep.new.append({"ID": norm_id(c[0]), "LOCATION": c[1], "HAZARD": c[2], "ACTION": c[3]})
            if not c[0]:
                rep.add("WARN", "no-id", f"new finding without NO: '{c[2][:60]}'")
            if not c[1] or not c[3]:
                rep.add("WARN", "blank-cell", f"{norm_id(c[0])}: location or corrective action blank")
    if "open" in kinds:
        for c in _rows(kinds["open"]):
            c += [""] * (6 - len(c))
            rep.open.append({"ID": norm_id(c[0]), "HAZARD": c[1], "PIC": c[2], "FOUND": id_date(c[3]),
                             "DUE": id_date(c[4]), "REASON": c[5]})
    if "closed" in kinds:
        for c in _rows(kinds["closed"]):
            c += [""] * (5 - len(c))
            rep.closed.append({"ID": norm_id(c[0]), "FOUND": id_date(c[1]), "HAZARD": c[2], "VERIFIED BY": c[3]})
    return rep
