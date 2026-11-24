"""
parity_check.py  (OPD Phase 4, Excel-free proof)

Question it answers: if we take ONLY the daily report (PDF) and the history rules, without Excel recalculating
anything, do we get the same fact rows as the Excel master already holds for that day?

How: run the existing CAN Daily Report ETL parsers on the report(s), turn the staged tblRAW rows into the long
(EAV) layout with master_export's own rules, and compare with what master_export produces from the saved master.

Set ETL_APP_DIR to the app folder of CAN_Daily_Report_ETL (the folder with dr_to_master.py), or run it from there. Read-only on the master:

    python parity_check.py WKM "Master Data Site WKM.xlsm" config_wkm.json "Daily Report WKM 19 November 2026.pdf"
    python parity_check.py BM  "Master Data Site BM.xlsm"  config_bm.json  "Daily Report BM 18 NOVEMBER.pdf"

The master must already contain the report date(s) (it is the ground truth). Nothing is written anywhere.
"""
import sys, json, warnings
warnings.filterwarnings("ignore")
import os
sys.path.insert(0, os.environ.get("ETL_APP_DIR", "."))
import pandas as pd
import dr_to_master as D
import master_export as X

DERIVED = set(X.STORED_TOTALS) | {"WTD", "MTD", "YTD"}


def main(code, master_path, cfg_path, pdfs):
    cfg = json.load(open(cfg_path, encoding="utf-8"))
    m = D.Master(master_path)
    site = X.site_name_of(m)
    run = D.Run(cfg, m)
    for f in pdfs:
        if code == "BM":
            import bm_to_master as B
            B.process_pdf(run, f)
        else:
            D.process_pdf(run, f, ocr=False)
    dates = sorted({D.as_date(r.get("DATE")) for t in run.stage.values() for r in t if D.as_date(r.get("DATE"))})
    print(f"site {site} | report dates {dates[0]} to {dates[-1]} | issues:",
          {s: sum(1 for x in run.log if x["severity"] == s) for s in ("ERROR", "WARN", "RECON", "INFO")})

    class Staged:                      # a "master" that holds only the staged rows (no Excel formulas)
        tables, headers, vocab = m.tables, {}, m.vocab
        data = dict(run.stage)

    ours, _ = X.build_actual(Staged, site, dates[0], dates[-1])
    theirs, _ = X.build_actual(m, site, dates[0], dates[-1])
    for d in (ours, theirs):
        d["date"] = pd.to_datetime(d["date"]).dt.date
    mm = ours.merge(theirs, on=X.KEY8, how="outer", suffixes=("_ours", "_master"), indicator=True)
    both = mm[mm["_merge"] == "both"]
    bad = both[(both["value_ours"].fillna(-9e9) - both["value_master"].fillna(-9e9)).abs() > 1e-6]
    only_ours = mm[mm["_merge"] == "left_only"]
    only_m = mm[mm["_merge"] == "right_only"]
    derived = only_m[only_m["metric"].astype(str).str.upper().isin(DERIVED)]
    other = only_m.drop(derived.index)
    print(f"rows from the report alone: {len(ours)} | rows in the master export: {len(theirs)}")
    print(f"  same key, same value : {len(both) - len(bad)}")
    print(f"  same key, other value: {len(bad)}")
    print(f"  only in our rows     : {len(only_ours)}")
    print(f"  only in master, cumulative (DTOT..YALL, WTD/MTD/YTD): {len(derived)}")
    print(f"  only in master, other formula columns: {len(other)}")
    if len(other):
        print(other.groupby(["category", "metric_group"]).size().to_string())
    if len(bad):
        print(bad[["date", "category", "contractor", "pit", "metric_group", "metric", "value_ours", "value_master"]].head(30).to_string())
    return len(bad) == 0 and len(only_ours) == 0


if __name__ == "__main__":
    if len(sys.argv) < 5:
        sys.exit(__doc__)
    ok = main(sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4:])
    print("PARITY OK (every report value matches the master)" if ok else "PARITY FAILED: see the differences above")
