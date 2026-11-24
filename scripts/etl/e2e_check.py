r"""e2e_check.py - end-to-end proof, no Excel in the loop.

  py e2e_check.py WKM "Master Data Site WKM.xlsm" config_wkm.json schema_wkm.json wkm.ndjson "Daily Report 19 Nov.pdf"

History = the NDJSON seed, cut to dates BEFORE the report date (so the day is really new). The report is parsed, formula
columns are rebuilt, the long (EAV) rows are produced and compared with what the Excel master itself exports for that date."""
import sys, os, json, warnings, datetime as dt, collections
warnings.filterwarnings("ignore")
sys.path.insert(0, os.environ.get("ETL_APP_DIR", "."))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import pandas as pd
import dr_to_master as D, master_export as X
import opd_parse as P, opd_formulas as F


def main(code, master_path, cfg_path, schema_path, nd_path, pdf):
    cfg = json.load(open(cfg_path, encoding="utf-8")); schema = json.load(open(schema_path))
    # report date from the PDF itself
    if code == "BM":
        import bm_to_master as B
        d = B.report_date(pdf)["report_date"]
    else:
        import pdfplumber
        from dr_pdf_parser import Layout, parse_header
        with pdfplumber.open(pdf) as p:
            d = parse_header(Layout(p.pages[0]))["report_date"]
    hist = collections.defaultdict(list)
    for line in open(nd_path, encoding="utf-8"):
        o = json.loads(line)
        rd = o["row_date"]
        if o["tbl"].startswith("tblRAW") and o["tbl"] != "tblRAWBARGE" and rd and rd >= d.isoformat():
            continue                       # the report day (and later) is NOT in the history we give the parser
        if o["tbl"] == "tblRAWBARGE" and rd and rd > d.isoformat():
            continue
        hist[o["tbl"]].append(o["data"])
    res = P.parse_report("bm" if code == "BM" else "wkm", pdf, cfg, schema, hist)
    print("report date", res["report_date"], "| issues:", dict(collections.Counter(x["severity"] for x in res["log"])))
    m = D.Master(master_path); site = X.site_name_of(m)
    tables = {k: v for k, v in m.tables.items()}
    ours_data = {tn: [r for r in rows] for tn, rows in P.HistoryMaster(schema, hist).data.items()}
    for tn, rows in res["rows"].items():
        if tn == "tblRAWBARGE":
            continue
        ours_data[tn] = [r for r in ours_data.get(tn, []) if D.as_date(r.get("DATE")) != d] + [{k: P._revive(v, k) for k, v in r.items()} for r in rows]
    ours_data["tblRAWBARGE"] = m.data.get("tblRAWBARGE", [])    # barge list merge is step 4.3: same rows on both sides

    class Staged:
        pass
    Staged.tables, Staged.headers, Staged.vocab, Staged.data = tables, {}, m.vocab, ours_data
    ours, _ = X.build_actual(Staged, site, d, d)
    theirs, _ = X.build_actual(m, site, d, d)
    for x in (ours, theirs):
        x["date"] = pd.to_datetime(x["date"]).dt.date
    mm = ours.merge(theirs, on=X.KEY8, how="outer", suffixes=("_ours", "_master"), indicator=True)
    both = mm[mm["_merge"] == "both"]
    bad = both[(both["value_ours"].fillna(-9e9) - both["value_master"].fillna(-9e9)).abs() > 1e-4]
    print(f"rows ours {len(ours)} | master export {len(theirs)} | same {len(both) - len(bad)} | different value {len(bad)} | only ours {(mm._merge=='left_only').sum()} | only master {(mm._merge=='right_only').sum()}")
    if len(bad):
        print(bad[["category", "contractor", "pit", "metric_group", "metric", "value_ours", "value_master"]].head(25).to_string())
    for lab, sel in (("only ours", mm[mm._merge == "left_only"]), ("only master", mm[mm._merge == "right_only"])):
        if len(sel):
            print(lab, "by group:\n", sel.groupby(["category", "metric_group"]).size().to_string())
    return len(bad) == 0 and (mm._merge != "both").sum() == 0

if __name__ == "__main__":
    if len(sys.argv) < 7: sys.exit(__doc__)
    print("E2E OK: identical to the Excel master" if main(*sys.argv[1:7]) else "E2E: differences above")
