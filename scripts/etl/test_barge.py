"""Self-check of opd_barge.py (no database, no Excel). Run:  python scripts/etl/test_barge.py"""
import datetime as dt, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import opd_barge as B

def row(si, con, fin, cap, status="Completed", **k):
    r = {"SI": si, "CONTRACTOR": con, "FINISHDATE": fin, "ACTUAL CAPACITY": cap, "STATUS": status, "VESSEL/BARGE": f"TB {si}"}
    r.update(k); return r

hist = B.recompute([row(1, "A", "2026-11-02", 100), row(2, "A", "2026-11-09", 50), row(3, "B", None, 10, "Loading")], "PT X", 1, -1)
rows, ch = B.merge(hist, [row(3, "B", "2026-11-10", 30), row(4, "A", "2026-11-09", 25)], "PT X", dt.date(2026, 11, 10), (1, -1))
by = {str(r["SI"]): r for r in rows}
assert by["3"]["MTD"] == 30 and by["3"]["YTD"] == 30 and by["3"]["MONTH"] == "November" and by["3"]["WEEK"].startswith("W")
a = [by[k]["MTD"] for k in ("1", "2", "4")]
assert a == [100, 150, 175], a                 # same-day rows add up in list order: SI 2 then SI 4 on 9 Nov
assert by["3"]["INPUT DATE"] == "2026-11-10" and by["4"]["SITE"] == "PT X"
assert {c["si"] for c in ch} == {"3", "4"} and [c for c in ch if c["si"] == "4"][0]["old"] is None, ch
# nothing staged -> nothing changes
_, ch0 = B.merge(rows, [], "PT X", dt.date(2026, 11, 11), (1, -1)); assert ch0 == []
# a blank FINISHDATE shows January in MONTH and takes ACTUAL CAPACITY for the totals (the master's formulas)
r = B.recompute([row(9, "A", None, 7, "Loading")], "S", 1, -1)[0]; assert r["MONTH"] == "January" and r["WTD"] == 7 and r["YEAR"] is None
print("opd_barge: all checks passed")
