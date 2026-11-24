"""Transform + checks for tblRAWHAZARD from 'Laporan Inspeksi Harian' reports.

Rules (from the TMS master's hand-keyed history, 21 Jun - 23 Aug 2026):
* one row per NEW finding (report table 0) on the report date;
* a day with no new finding gets one '-' row (all text columns '-');
* REPAIR STATUS = latest state in this run: 'Closed' if the finding ID appears in any
  'Closing Temuan' table of this run, otherwise 'Open';
* RISK LEVEL and HAZARD CATEGORY are NOT in the report -> staged blank + WARN.
  A suggestion from the most similar past finding is given on REVIEW_HAZARD
  (filled in only if config hazard_fill_suggestions = true);
* REMARKS = finding ID (e.g. 'SF-75'), plus closure date/verifier when closed,
  so later reports can be matched to the row (the master has no ID column).
"""
from __future__ import annotations

import datetime as dt
import difflib
import re

import pandas as pd


def _sim(a, b):
    a = re.sub(r"\W+", " ", str(a).lower()).strip()
    b = re.sub(r"\W+", " ", str(b).lower()).strip()
    return difflib.SequenceMatcher(None, a, b).ratio()


ID_TAG = re.compile(r"^\s*\[([A-Z]+-\d+)\]")


def remark_id(remark):
    """finding ID stored at the start of REMARKS as '[SF-75] ...'"""
    m = ID_TAG.match(str(remark or ""))
    return m[1] if m else None


def make_remark(fid, closed_on=None, verified=None, old=None):
    txt = f"[{fid}]" if fid else ""
    if old and str(old).strip() not in ("", "-") and not remark_id(old):
        txt += f" {str(old).strip()}"
    if closed_on:
        txt += f" closed {closed_on:%d-%m-%Y}" + (f", verified by {verified}" if verified else "")
    return txt.strip() or "-"


def _contain(a, b):
    """share of the shorter text's words found in the longer one (for differently worded long entries)"""
    wa = set(re.sub(r"\W+", " ", str(a).lower()).split())
    wb = set(re.sub(r"\W+", " ", str(b).lower()).split())
    if not wa or not wb:
        return 0.0
    small, big = (wa, wb) if len(wa) <= len(wb) else (wb, wa)
    return len(small & big) / len(small)


def stage_hazards(run, reports):
    cfg, m = run.cfg, run.m
    site = cfg["site"]
    T = "tblRAWHAZARD"
    # date resolution: header first; when two reports share a header date and one file name
    # carries a different, unused date, the header was not updated -> use the file-name date
    by_hdr = {}
    for h in reports:
        if h.report_date:
            by_hdr.setdefault(h.report_date, []).append(h)
    used = set(by_hdr)
    for hd, group in by_hdr.items():
        if len(group) < 2:
            continue
        for h in group:
            if h.name_date and h.name_date != hd and h.name_date not in used:
                h.report_date = h.name_date
                used.add(h.name_date)
                h.add("WARN", "header-date-not-updated",
                      f"{h.file_name}: header says {hd} (same as another report) but the file name says {h.name_date}; "
                      f"{h.name_date} used - ask site to update the report header", date=h.name_date)
    # single-report case: header date already loaded in the master, file-name date not -> stale header
    loaded = m.dates(T, site)
    for h in reports:
        if h.report_date and h.name_date and h.name_date != h.report_date and \
                not any(i.check == "header-date-not-updated" for i in h.issues) and \
                h.report_date in loaded and h.name_date not in loaded and h.name_date not in used:
            hd = h.report_date
            h.report_date = h.name_date
            used.add(h.name_date)
            h.add("WARN", "header-date-not-updated",
                  f"{h.file_name}: header says {hd}, which is already in the master; the file name says {h.name_date} "
                  f"(not in the master yet) - {h.name_date} used. Ask site to update the report header",
                  date=h.name_date)
    for h in reports:
        if h.report_date and h.name_date and h.name_date != h.report_date and \
                not any(i.check == "header-date-not-updated" for i in h.issues):
            h.add("WARN", "file-name-date", f"file name says {h.name_date}, header says {h.report_date}; header used")
        # content sanity: nothing found/closed after the report date
        for c in h.closed + h.open:
            if c.get("FOUND") and h.report_date and c["FOUND"] > h.report_date:
                h.add("ERROR", "found-after-report", f"{c['ID']} found {c['FOUND']} is after the report date {h.report_date}")
    reps = sorted([h for h in reports if h.report_date and not any(i.severity == "ERROR" for i in h.issues)],
                  key=lambda h: h.report_date)
    seen = {}
    for h in reps:
        if h.report_date in seen:
            run.add("ERROR", h.report_date, T, "duplicate-date",
                    f"{h.file_name} and {seen[h.report_date].file_name} have the same date; the second is skipped")
        else:
            seen[h.report_date] = h
    reps = list(seen.values())
    for h in reports:
        run.issues.extend(h.issues)
        run.meta.append([h.report_date, h.file_name, h.sha, sum(i.severity == "ERROR" for i in h.issues),
                         f"hazard report; inspectors: {h.inspectors or '-'}"])

    hist = m.site_rows(T, site)
    hist = hist[hist["IDENTIFIED HAZARD"].astype(str).str.strip().ne("-")].copy()
    hist["_ID"] = hist["REMARKS"].map(remark_id)
    statuses = m.lookup("tblREPAIRSTATUS")

    # latest closure per ID in this run
    closed = {}
    for h in reps:
        for c in h.closed:
            if c["ID"]:
                closed[c["ID"]] = (h.report_date, c["VERIFIED BY"], c["FOUND"], c["HAZARD"])

    new_ids = {}
    for h in reps:
        d = h.report_date
        base = {"DATE": d, "SITE": site, "SHIFT": cfg["shift"], "INPUT DATE": run.input_time}
        if not h.new:
            run.rows[T].append(dict(base, **{k: "-" for k in ("HAZARD LOCATION", "IDENTIFIED HAZARD", "CORRECTIVE ACTION",
                                                               "REPAIR STATUS", "RISK LEVEL", "HAZARD CATEGORY", "REMARKS")}))
            run.add("INFO", d, T, "no-new-finding", "no new finding in the report; one '-' row staged (master convention)")
        for f in h.new:
            fid = f["ID"]
            if fid in new_ids:
                run.add("WARN", d, T, "duplicate-id", f"{fid} was already a new finding on {new_ids[fid]}")
            new_ids[fid] = d
            cl = closed.get(fid)
            status = "Closed" if cl and cl[0] >= d else "Open"
            remark = make_remark(fid, cl[0] if status == "Closed" else None, cl[1] if status == "Closed" else None)
            if not fid:
                run.add("WARN", d, T, "no-id", "finding without ID: closure cannot be matched automatically later")
            # suggestion from history
            best, score = None, 0.0
            for _, hr in hist.iterrows():
                s = _sim(f["HAZARD"], hr["IDENTIFIED HAZARD"])
                if s > score:
                    best, score = hr, s
            risk = cat = None
            if best is not None and cfg.get("hazard_fill_suggestions") and score >= cfg.get("hazard_suggest_min", 0.6):
                risk, cat = best["RISK LEVEL"], best["HAZARD CATEGORY"]
            run.rows[T].append(dict(base, **{
                "HAZARD LOCATION": f["LOCATION"] or None, "IDENTIFIED HAZARD": f["HAZARD"],
                "CORRECTIVE ACTION": f["ACTION"] or None, "REPAIR STATUS": status,
                "RISK LEVEL": risk, "HAZARD CATEGORY": cat, "REMARKS": remark}))
            run.review["REVIEW_HAZARD"].append({
                "DATE": d, "ID": fid, "LOCATION": f["LOCATION"], "IDENTIFIED HAZARD": f["HAZARD"], "STATUS STAGED": status,
                "SUGGESTED RISK LEVEL": None if best is None else best["RISK LEVEL"],
                "SUGGESTED CATEGORY": None if best is None else best["HAZARD CATEGORY"],
                "SIMILARITY": round(score, 2),
                "MOST SIMILAR PAST FINDING": None if best is None else f"{best['_D']}: {best['IDENTIFIED HAZARD']}",
                "FILLED": "yes" if risk else "no - fill in before loading"})
            if not risk:
                run.add("WARN", d, T, "risk-category-blank",
                        f"{fid}: RISK LEVEL / HAZARD CATEGORY are not in the report - staged blank "
                        f"(suggestion on REVIEW_HAZARD: {None if best is None else best['RISK LEVEL']} / "
                        f"{None if best is None else best['HAZARD CATEGORY']}, similarity {score:.2f})")
            if status not in statuses:
                run.add("WARN", d, T, "vocab", f"REPAIR STATUS '{status}' not in tblREPAIRSTATUS")

        # same-day consistency
        open_ids = {o["ID"] for o in h.open}
        for c in h.closed:
            if c["ID"] in open_ids:
                run.add("WARN", d, T, "closed-and-open", f"{c['ID']} is in both the open list and the closing list")

    # follow the open list day to day: an ID that leaves the open list must be closed
    for prev, cur in zip(reps, reps[1:]):
        carry = {o["ID"] for o in prev.open} | {f["ID"] for f in prev.new}
        carry -= {c["ID"] for c in prev.closed}
        now = {o["ID"] for o in cur.open} | {c["ID"] for c in cur.closed} | {f["ID"] for f in cur.new}
        for fid in sorted(carry - now):
            run.add("WARN", cur.report_date, T, "dropped-without-closing",
                    f"{fid} was open on {prev.report_date} but is neither open nor closed on {cur.report_date}")

    # closures and open items that refer to findings from before this run -> _HAZARD_UPDATES
    # (applied automatically by TMS_ImportStaging after the tables are loaded)
    run_new = set(new_ids)

    def match_master(fid, text, found):
        """1) by [ID] in REMARKS, 2) by finding date + text (rows keyed before IDs were stored)"""
        if fid:
            byid = hist[hist["_ID"] == fid]
            if len(byid) == 1:
                return byid.iloc[0], 1.0, "id"
            if len(byid) > 1:
                run.add("WARN", None, T, "id-not-unique", f"{fid} is in REMARKS of {len(byid)} master rows")
                return byid.iloc[-1], 1.0, "id"
        cand = hist if found is None else hist[hist["_D"] == found]
        best, score = None, 0.0
        for _, hr in cand.iterrows():
            sc = _sim(text, hr["IDENTIFIED HAZARD"])
            if found is not None:          # same finding date: also accept re-worded text
                sc = max(sc, _contain(text, hr["IDENTIFIED HAZARD"]))
            if sc > score:
                best, score = hr, sc
        return best, score, "text"

    def update_row(action, fid, best, how, status, remark, source):
        run.review["_HAZARD_UPDATES"].append({
            "ACTION": action, "ID": fid,
            "MASTER DATE": best["_D"] if best is not None else None,
            "MASTER IDENTIFIED HAZARD": best["IDENTIFIED HAZARD"] if best is not None else None,
            "MATCHED BY": how, "STATUS NOW": best["REPAIR STATUS"] if best is not None else None,
            "NEW REPAIR STATUS": status, "NEW REMARKS": remark, "SOURCE": source})

    handled = set()
    for fid, (cdate, who, found, text) in sorted(closed.items(), key=lambda x: x[1][0]):
        if fid in run_new:
            continue
        handled.add(fid)
        best, score, how = match_master(fid, text, found)
        ok = best is not None and (how == "id" or score >= 0.8 or (found is not None and score >= 0.45))
        if ok and str(best["REPAIR STATUS"]).strip() == "Closed" and remark_id(best["REMARKS"]) == fid:
            run.add("INFO", cdate, T, "already-closed", f"{fid}: master row of {best['_D']} is already Closed")
            continue
        remark = make_remark(fid, cdate, who, old=best["REMARKS"] if ok else None)
        update_row("CLOSE", fid, best if ok else None, how if ok else "ID only (not in this master copy)",
                   "Closed", remark, f"closing table {cdate}")
        run.add("INFO" if ok else "WARN", cdate, T, "close-earlier-finding",
                f"{fid} (found {found}) closed on {cdate}: " +
                (f"master row of {best['_D']} ('{best['REPAIR STATUS']}') will be set to Closed by the importer "
                 f"(matched by {how})" if ok else
                 "no matching row in this master copy; the importer will look for [" + fid + "] in REMARKS"))

    latest = reps[-1] if reps else None
    if latest:
        last_master = max(hist["_D"]) if len(hist) else None
        last_master = max(m.dates(T, site) or {last_master}) if last_master else None
        for o in latest.open:
            best, score, how = match_master(o["ID"], o["HAZARD"], o["FOUND"])
            # same finding date in the master -> a looser text match is enough
            ok = best is not None and (how == "id" or score >= 0.8 or (o["FOUND"] is not None and score >= 0.45))
            if ok and how == "text" and o["ID"] and o["ID"] not in handled:
                update_row("TAG", o["ID"], best, "text", None, make_remark(o["ID"], old=best["REMARKS"]),
                           f"open list {latest.report_date}")
            overdue = (latest.report_date - o["DUE"]).days if o["DUE"] else None
            run.review["REVIEW_HAZARD_OPEN"].append({
                "AS OF": latest.report_date, "ID": o["ID"], "FOUND": o["FOUND"], "DUE": o["DUE"],
                "DAYS OVERDUE": overdue if overdue and overdue > 0 else 0, "PIC": o["PIC"], "REASON OPEN": o["REASON"],
                "FINDING": o["HAZARD"], "IN MASTER": f"yes ({best['_D']}, {best['REPAIR STATUS']})" if ok else
                ("in this staging" if o["ID"] in run_new else "NO")})
            if overdue and overdue > 0:
                run.add("WARN", latest.report_date, T, "overdue",
                        f"{o['ID']} ({o['PIC']}) due {o['DUE']}, still open: {overdue} days overdue", diff=overdue)
            if not ok and o["ID"] not in run_new and o["FOUND"]:
                if last_master and o["FOUND"] > last_master:
                    run.add("INFO", latest.report_date, T, "open-in-master-gap",
                            f"{o['ID']} found {o['FOUND']} is after the master's last hazard date {last_master}; "
                            "its report is needed to key it")
                elif o["FOUND"] >= dt.date(2026, 6, 20):
                    run.add("WARN", latest.report_date, T, "open-not-in-master",
                            f"{o['ID']} found {o['FOUND']} is still open but has no matching row in the master")
    return reps
