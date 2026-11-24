"""Self-check of opd_plan.py and opd_ship.py (no database, no Excel).  python scripts/etl/test_plan_ship.py   (needs opd_formulas.py next to it)"""
import datetime as dt, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import opd_plan as P, opd_ship as S

# ---- plan: the report's value holds from its day to the end of the stretch that had the old value; MTD stops at the month end
cal = []
for i in range(0, 80):
    d = dt.date(2026, 11, 1) + dt.timedelta(days=i)
    cal.append({"CONTRACTOR": "A", "DATE": d.isoformat(), "H-DAY": 100.0 if d < dt.date(2026, 12, 10) else 150.0,
                "H-MTD": 3000.0, "ST-WTD": 700.0, "ST-DAY": 100.0})
rep = dt.date(2026, 11, 19)
out = P.propose(cal, [{"contractor": "A", "column": "H-DAY", "pdf": 120.0}, {"contractor": "A", "column": "H-MTD", "pdf": 3300.0},
                      {"contractor": "A", "column": "ST-WTD", "pdf": 1400.0}], rep)
ch = {c["column"]: c for c in out["changes"]}
assert ch["H-DAY"]["from"] == "2026-11-19" and ch["H-DAY"]["to"] == "2026-12-09", ch["H-DAY"]       # stops where the old plan already changed
assert ch["H-MTD"]["to"] == "2026-11-30", ch["H-MTD"]                                              # a month plan never runs into the next month
rows = {r["DATE"]: r for r in out["rows"]}
assert rows["2026-11-18"] if "2026-11-18" in rows else True
assert "2026-11-18" not in rows, "days before the report day stay as they are"
assert rows["2026-11-19"]["H-DAY"] == 120.0 and rows["2026-12-10"]["H-DAY"] == 150.0
assert rows["2026-11-19"]["ST-DAY"] == 200.0, "ST-DAY follows ST-WTD / 7"
assert P.propose(cal, [], rep)["changes"] == []

# ---- ship: DAY of an earlier day changes; later running totals move by the same amount, ROWID stays
def row(d, c, day, wtd, mtd, ytd, rid):
    return {"DATE": d, "SITE": "S", "SHIFT": None, "CONTRACTOR": c, "DAY": day, "WTD": wtd, "MTD": mtd, "YTD": ytd, "YEAR": 2026, "MONTH": "November",
            "WEEK": "W46" if d <= "2026-11-15" else "W47", "ROWID": rid, "DALL": 0, "WALL": 0, "MALL": 0, "YALL": 0, "INPUT DATE": "2026-11-01"}
h = {"tblRAWSHIP": [row("2026-11-10", "A", 10, 10, 10, 110, 1), row("2026-11-10", "B", 5, 5, 5, 5, 2),
                    row("2026-11-17", "A", 20, 20, 30, 130, 3), row("2026-11-17", "B", 0, 0, 5, 5, 4)]}
schema = {"tables": {"tblRAWSHIP": {"input": ["DATE", "SITE", "SHIFT", "CONTRACTOR", "DAY", "INPUT DATE"]}}}
r = S.apply(schema, h, [{"DATE": "2026-11-10", "CONTRACTOR": "A", "NEW DAY": 15}], "2026-11-24")
g = {(x["DATE"], x["CONTRACTOR"]): x for x in r["rows"]}
assert g[("2026-11-10", "A")]["DAY"] == 15 and g[("2026-11-10", "A")]["INPUT DATE"] == "2026-11-24"
assert g[("2026-11-10", "A")]["WTD"] == 15 and g[("2026-11-17", "A")]["WTD"] == 20, "next week's WTD does not move"
assert g[("2026-11-17", "A")]["MTD"] == 35 and g[("2026-11-17", "A")]["YTD"] == 135
assert g[("2026-11-10", "B")]["ROWID"] == 2 and ("2026-11-17", "B") in g and g[("2026-11-17", "B")]["MTD"] == 5
assert g[("2026-11-10", "A")]["DALL"] == 20 and g[("2026-11-10", "B")]["DALL"] == 0
assert S.apply(schema, h, [{"DATE": "2026-11-11", "CONTRACTOR": "A", "NEW DAY": 1}], "x")["skipped"][0]["reason"] == "no matching row"
print("opd_plan / opd_ship: all checks passed")
