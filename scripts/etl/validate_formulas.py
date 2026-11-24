r"""validate_formulas.py - checks opd_formulas.py against EVERY row of a site master's saved Excel values.

  set ETL_APP_DIR=C:\...\CAN_Daily_Report_ETL\app
  py validate_formulas.py "Master Data Site WKM.xlsm" [tableName ...]

For each date, the rows of earlier dates are taken as stored (so one wrong value cannot spread), the day's rows are
recomputed from their input columns, and every formula column is compared with what Excel saved. Read-only.
"""
import sys, os, warnings, collections
warnings.filterwarnings("ignore")
sys.path.insert(0, os.environ.get("ETL_APP_DIR", "."))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import dr_to_master as D
import opd_formulas as F

TABLES = ["tblRAWMNG", "tblRAWHSE", "tblRAWHAUL", "tblRAWSHIP", "tblRAWFUEL", "tblRAWEQ", "tblRAWMP", "tblRAWLAB"]


def main(path, only):
    m = D.Master(path)
    cal = {}
    for r in m.rows("tblCALENDAR"):
        d = F.day_of(r.get("DATE"))
        cal[(r.get("CONTRACTOR"), d)] = {"YEAR": r.get("YEAR"), "MONTH": r.get("MONTH"), "WEEK": r.get("WEEK")}
    mng_cache = {}
    tot_bad = 0
    allrows = []
    for tn in (only or TABLES):
        rows = m.rows(tn)
        formula_cols = [c for c in m.tables[tn]["cols"] if c not in m.tables[tn]["input"]]
        by_date = collections.OrderedDict()
        for r in rows:
            by_date.setdefault(F.day_of(r.get("DATE")), []).append(r)
        bad = collections.Counter(); ex = {}; checked = 0; bymonth = collections.Counter(); bad_days = set()
        for d, day in sorted(by_date.items(), key=lambda x: (x[0] is None, x[0])):
            if d is None: continue
            hist = [r for r in rows if (F.day_of(r.get("DATE")) or d) < d]
            extra = {"tblRAWMNG": [r for r in m.rows("tblRAWMNG") if F.day_of(r.get("DATE")) == d]}
            out = F.complete_day(tn, hist, day, cal, extra)
            for o, orig in zip(out, day):
                for c in formula_cols:
                    if c not in o or c == "ROWID": continue
                    a, b = o[c], orig.get(c)
                    checked += 1
                    na = isinstance(a, (int, float)) and not isinstance(a, bool); nb = isinstance(b, (int, float)) and not isinstance(b, bool)
                    ok = (abs(a - b) <= 1e-6 + 1e-9 * abs(b)) if (na and nb) else (a == b or (a in ("", None) and b in ("", None)))
                    if not ok:
                        allrows.append((tn, d.isoformat(), c, a, b)); bad[c] += 1; bymonth[d.strftime('%Y-%m')] += 1; bad_days.add(d)
                        ex.setdefault(c, []).append((d, a, b))
        produced = sum(1 for c in formula_cols)
        print(f"{tn:12s} rows {len(rows):5d} | values checked {checked:7d} | mismatches {sum(bad.values()):5d}")
        for c, k in bad.most_common(8):
            e = ex[c][:2]
            print(f"    {c:12s} {k:4d}   e.g. " + "; ".join(f"{x[0]}: ours {x[1]!r} vs excel {x[2]!r}" for x in e))
        print('    by month:', dict(sorted(bymonth.items())), '| days with a difference:', len(bad_days), '| last:', max(bad_days) if bad_days else '-')
        tot_bad += sum(bad.values())
    import csv
    csvp = os.environ.get("DIFF_CSV")
    if csvp:
        with open(csvp, "w", newline="", encoding="utf-8") as f:
            w = csv.writer(f); w.writerow(["table", "date", "column", "portal_calc", "excel_saved"]); w.writerows(allrows)
    print("ALL MATCH" if tot_bad == 0 else f"{tot_bad} differences")

if __name__ == "__main__":
    if len(sys.argv) < 2: sys.exit(__doc__)
    main(sys.argv[1], sys.argv[2:])
