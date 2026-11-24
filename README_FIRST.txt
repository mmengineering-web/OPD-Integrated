
UPDATE 24 Nov 14:00 (v3): added scripts/etl/opd_formulas.py (Excel formula columns rebuilt in Python),
scripts/etl/validate_formulas.py (checks them against every saved value of the master) and docs/formula_differences_WKM.csv.
Check on your PC (read-only, touches no database):
    set ETL_APP_DIR=C:\Users\HUAYOU GROUP\Downloads\About Data\ETL\CAN_Daily_Report_ETL\app
    set DIFF_CSV=differences.csv
    py scripts\etl\validate_formulas.py "<path of the current master>"
