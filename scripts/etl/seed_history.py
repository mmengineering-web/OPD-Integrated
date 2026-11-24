r"""Seed etl_history from a site master (.xlsm). Part of OPD Phase 4 (Excel-free daily report).

  set ETL_APP_DIR=C:\path\to\CAN_Daily_Report_ETL\app        (the folder that has dr_to_master.py; Linux/mac: export)
  python scripts/etl/seed_history.py "Master Data Site WKM.xlsm" wkm.ndjson            -> dump only, touches no database
  set OPD_DB_URL=<Supabase session pooler connection string of THIS site project>
  python scripts/etl/seed_history.py "Master Data Site WKM.xlsm" wkm.ndjson --load    -> dump + load into etl_history

The site value is the company name the master itself reports (same text as the `site` column in prod_v2, e.g. PT WANA KENCANA MINERAL).
etl_config.site in the database must be exactly that text, otherwise nothing is loaded.
The connection string is read from OPD_DB_URL only. It is never printed, never written to a file. Read-only on the master.
Each NDJSON line: {"tbl","site","row_date","data"}. Dates are ISO strings.
"""
import sys, os, json, datetime as dt, warnings
warnings.filterwarnings("ignore")
sys.path.insert(0, os.environ.get("ETL_APP_DIR", "."))
import dr_to_master as D
import master_export as X

def _j(v):
    if isinstance(v, dt.datetime): return v.date().isoformat()
    if isinstance(v, dt.date): return v.isoformat()
    return v

def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    if len(args) != 2: sys.exit(__doc__)
    path, out = args
    m = D.Master(path)
    site = X.site_name_of(m)
    n = {}
    with open(out, "w", encoding="utf-8") as f:
        for tbl, rows in m.data.items():
            for r in rows:
                dcol = "FINISHDATE" if tbl == "tblRAWBARGE" else "DATE"
                d = r.get(dcol) if (tbl.startswith("tblRAW") or tbl == "tblCALENDAR") else None
                rd = _j(d) if isinstance(d, (dt.datetime, dt.date)) else None
                f.write(json.dumps({"tbl": tbl, "site": site, "row_date": rd,
                                    "data": {k: _j(v) for k, v in r.items()}}, ensure_ascii=False, default=str) + "\n")
                n[tbl] = n.get(tbl, 0) + 1
    print("site:", site)
    for k in sorted(n): print(f"{k:24s} {n[k]:7d}")
    if "--load" in sys.argv:
        url = os.environ.get("OPD_DB_URL")
        if not url: sys.exit("OPD_DB_URL is not set")
        import psycopg
        with psycopg.connect(url) as c, c.cursor() as cur:
            cur.execute("select site from public.etl_config")
            cfg = cur.fetchone()
            if not cfg or cfg[0] != site: sys.exit("etl_config.site does not match the master's site: " + site)
            cur.execute("select count(*) from public.etl_history where site=%s and batch_id is null", (site,))
            if cur.fetchone()[0]: sys.exit("seed already present; clear it deliberately first")
            with cur.copy("copy public.etl_history (tbl, site, row_date, data) from stdin") as cp:
                for line in open(out, encoding="utf-8"):
                    o = json.loads(line)
                    cp.write_row((o["tbl"], o["site"], o["row_date"], json.dumps(o["data"], ensure_ascii=False)))
        print("loaded (connection string not shown)")

main()
