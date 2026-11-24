r"""make_schema.py - writes the table layout of a site master (column names, which are input) to a small JSON file.
  set ETL_APP_DIR=...\CAN_Daily_Report_ETL\app
  py make_schema.py "Master Data Site WKM.xlsm" schema_wkm.json
No data is written, only column names."""
import sys, os, json, warnings
warnings.filterwarnings("ignore")
sys.path.insert(0, os.environ.get("ETL_APP_DIR", "."))
import dr_to_master as D
m = D.Master(sys.argv[1])
keep = {n: {"cols": t["cols"], "input": t["input"]} for n, t in m.tables.items() if n.startswith("tblRAW") or n in D.VOCAB or n in D.EXTRA_DATA}
json.dump({"tables": keep}, open(sys.argv[2], "w"), ensure_ascii=False, indent=0)
print(len(keep), "tables ->", sys.argv[2])
