// Daily Report pages (Phase 4.6): sections A-H of the printed Daily Report, drawn on canvas, one image per page (browser only).
// Page order: key points + A activity | B HSE | C shipment | D production | D yearly production | E weather + F ore stock | G fuel and manpower + H construction.
import { shortDate, longDate, fmt, verdict, MONTH_ABBR, STATIC_ACTIVITY } from "./daily-report.js";

const W = 1500, H = 1060, PAD = 36;
const INK = "#0f172a", MUTED = "#64748b", LINE = "#cbd5e1", HEAD = "#1e3a5f", ACCENT = "#1d4ed8", BAND = "#e8eef6";
const TONE = { good: "#15803d", pace: ACCENT, warn: "#b45309", bad: "#b91c1c", info: ACCENT, none: "#94a3b8" };
const TINT = { good: "#dcfce7", pace: "#dbeafe", warn: "#fef3c7", bad: "#fee2e2", info: "#dbeafe", none: null };
const dash = { t: "-", c: "#94a3b8" };
const pc2 = (p) => (p == null ? "-" : `${p.toFixed(2)}%`);

function wrapLines(g, text, maxW) {
  const out = []; let line = "";
  String(text).split(" ").forEach((w) => { const t = line ? `${line} ${w}` : w; if (g.measureText(t).width > maxW && line) { out.push(line); line = w; } else line = t; });
  if (line) out.push(line); return out;
}

function newPage(rep, title, section) {
  const c = document.createElement("canvas"); c.width = W * 2; c.height = H * 2;
  const g = c.getContext("2d"); g.scale(2, 2); g.textBaseline = "middle";
  g.fillStyle = "#fff"; g.fillRect(0, 0, W, H); g.fillStyle = ACCENT; g.fillRect(0, 0, W, 6);
  g.textAlign = "left"; g.fillStyle = ACCENT; g.font = "bold 12px sans-serif"; g.fillText("DAILY REPORT · CENTRAL ABADI NUSANTARA MINING PROJECT", PAD, 30);
  g.fillStyle = INK; g.font = "bold 26px sans-serif"; g.fillText(section ? `${section}  ${title}` : title, PAD, 62);
  g.textAlign = "right"; g.fillStyle = MUTED; g.font = "13px sans-serif"; g.fillText(longDate(rep.report_date), W - PAD, 62);
  return { c, g, y: 92 };
}
const toBlob = (c) => new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error("The page image could not be created."))), "image/jpeg", 0.92));

/** Generic table. cols [{label, w, a}], groups [{label, span}], rows [{cells, bg, bold}], cell = string | {t, c, b, bg, bar}. Returns the y below it. */
function table(g, o) {
  const { x, w, cols, groups, rows, rowH = 26, fs = 12 } = o;
  let y = o.y;
  const tw = cols.reduce((a, c) => a + c.w, 0), xs = [x];
  cols.forEach((c) => xs.push(xs[xs.length - 1] + (c.w / tw) * w));
  const hh = o.hh || 26;
  const put = (t, i, yy, align, color, bold, size = fs) => {
    g.font = `${bold ? "bold " : ""}${size}px sans-serif`; g.fillStyle = color; g.textAlign = align === "r" ? "right" : align === "c" ? "center" : "left";
    g.fillText(String(t), align === "r" ? xs[i + 1] - 8 : align === "c" ? (xs[i] + xs[i + 1]) / 2 : xs[i] + 8, yy);
  };
  if (groups) {
    g.fillStyle = HEAD; g.fillRect(x, y, w, hh);
    let ci = 0;
    groups.forEach((gr) => {
      g.fillStyle = "#fff"; g.font = "bold 12px sans-serif"; g.textAlign = "center"; g.fillText(gr.label || "", (xs[ci] + xs[ci + gr.span]) / 2, y + hh / 2 + 1);
      if (ci) { g.strokeStyle = "rgba(255,255,255,.35)"; g.beginPath(); g.moveTo(xs[ci], y + 3); g.lineTo(xs[ci], y + hh * 2 - 3); g.stroke(); }
      ci += gr.span;
    });
    y += hh;
  }
  g.fillStyle = HEAD; g.fillRect(x, y, w, hh);
  cols.forEach((c, i) => put(c.label, i, y + hh / 2 + 1, c.a || "r", "#e2e8f0", true, 11.5));
  y += hh;
  rows.forEach((r, ri) => {
    g.fillStyle = r.bg || (ri % 2 ? "#f8fafc" : "#fff"); g.fillRect(x, y, w, rowH);
    r.cells.forEach((raw, i) => {
      const cell = typeof raw === "object" && raw !== null ? raw : { t: raw };
      if (cell.bg) { g.fillStyle = cell.bg; g.fillRect(xs[i], y, xs[i + 1] - xs[i], rowH); }
      if (cell.bar != null) {
        const bx = xs[i] + 8, bw = xs[i + 1] - xs[i] - 16 - 52, f = Math.max(0, Math.min(cell.bar, 100)) / 100;
        g.fillStyle = "#e2e8f0"; g.fillRect(bx, y + rowH / 2 - 5, bw, 10);
        g.fillStyle = cell.bar >= 100 ? TONE.good : cell.bar >= 50 ? ACCENT : "#d97706"; g.fillRect(bx, y + rowH / 2 - 5, bw * f, 10);
        put(`${cell.bar.toFixed(1)}%`, i, y + rowH / 2 + 1, "r", INK, true);
      } else put(cell.t ?? "", i, y + rowH / 2 + 1, cols[i].a || "r", cell.c || INK, cell.b || r.bold);
    });
    g.strokeStyle = "#e2e8f0"; g.lineWidth = 1; g.beginPath(); g.moveTo(x, y + rowH); g.lineTo(x + w, y + rowH); g.stroke();
    y += rowH;
  });
  return y;
}

const pctCell = (b, per, iso) => { if (!b || b.pct == null) return dash; const v = verdict(b, per, iso); return { t: pc2(b.pct), c: TONE[v.tone], b: true, bg: TINT[v.tone] }; };
const num = (v, loaded = true) => (loaded ? fmt(v) : dash);
const PER = ["day", "week", "month", "year"];
const sectionTitle = (g, y, t, note) => { g.textAlign = "left"; g.fillStyle = INK; g.font = "bold 15px sans-serif"; g.fillText(t, PAD, y + 8); if (note) { g.fillStyle = MUTED; g.font = "12px sans-serif"; g.textAlign = "right"; g.fillText(note, W - PAD, y + 8); } return y + 22; };
const foot = (g, text) => { g.textAlign = "left"; g.fillStyle = MUTED; g.font = "11px sans-serif"; g.fillText(text, PAD, H - 22); };
const cutText = (r) => (r.data ? `Cut Off: ${shortDate(r.data.cut_off)}` : "");

function pageKey(rep) {
  const { c, g } = newPage(rep, "Key points", "");
  let y = 100;
  const chip = rep.rows.map((r) => ({ k: r.company, v: r.data ? shortDate(r.data.cut_off) : "-", stale: r.data && r.data.cut_off !== rep.report_date }));
  const cw = (W - PAD * 2) / chip.length;
  chip.forEach((k, i) => {
    g.fillStyle = k.stale ? TINT.bad : "#f1f5f9"; g.fillRect(PAD + i * cw + 2, y, cw - 4, 54);
    g.textAlign = "center"; g.fillStyle = MUTED; g.font = "bold 12px sans-serif"; g.fillText(`${k.k} CUT OFF`, PAD + i * cw + cw / 2, y + 17);
    g.fillStyle = k.stale ? TONE.bad : INK; g.font = "bold 19px sans-serif"; g.fillText(k.v, PAD + i * cw + cw / 2, y + 39);
  });
  y += 84;
  y = sectionTitle(g, y, "WHAT MATTERS TODAY", "Red = act now, amber = check, blue = information, green = on target") + 8;
  rep.highlights.forEach((h) => {
    g.font = "17px sans-serif";
    const lines = wrapLines(g, h.text, W - PAD * 2 - 210), rh = Math.max(50, lines.length * 24 + 22);
    g.fillStyle = TINT[h.tone] || "#f1f5f9"; g.fillRect(PAD, y, W - PAD * 2, rh); g.fillStyle = TONE[h.tone]; g.fillRect(PAD, y, 8, rh);
    g.beginPath(); g.roundRect(PAD + 24, y + rh / 2 - 12, 132, 24, 12); g.fill();
    g.fillStyle = "#fff"; g.font = "bold 11px sans-serif"; g.textAlign = "center"; g.fillText(h.tag || "", PAD + 24 + 66, y + rh / 2 + 1);
    g.fillStyle = INK; g.font = "17px sans-serif"; g.textAlign = "left";
    lines.forEach((l, i) => g.fillText(l, PAD + 180, y + rh / 2 - ((lines.length - 1) * 24) / 2 + i * 24));
    y += rh + 8;
  });
  foot(g, "Highlights are computed from the loaded data of each site. A site behind the newest cut-off day is flagged first.");
  return toBlob(c);
}

function pageHse(rep) {
  const { c, g } = newPage(rep, "Health, Safety and Environment", "B");
  let y = 100;
  const cols = [{ label: "NO", w: 0.4, a: "l" }, { label: "COMPANY", w: 3, a: "l" }, ...["NEARMISS", "FATALITY", "MEDICAL TREATMENT", "LOST TIME INJURY", "FIRST AID", "PROPERTY DAMAGE", "FIRE CASE", "ENVIRO CASE"].map((l) => ({ label: l, w: 1.25, a: "c" })), { label: "HAZARDS", w: 0.9, a: "c" }];
  const keys = [["NM", "info"], ["FATALITY", "bad"], ["MTI", "bad"], ["LTI", "bad"], ["FAI", "warn"], ["PD", "warn"], ["FC", "warn"], ["EC", "warn"]];
  const rows = rep.rows.map((r, i) => ({
    cells: [String(i + 1), r.name, ...keys.map(([k, t]) => (r.data?.hse ? (r.data.hse[k] > 0 ? { t: String(r.data.hse[k]), c: TONE[t], b: true, bg: TINT[t] } : { t: "0", c: MUTED }) : dash)), r.data ? { t: String(r.data.hazards.length), b: r.data.hazards.length > 0, c: r.data.hazards.length ? TONE.warn : MUTED } : dash],
  }));
  y = table(g, { x: PAD, y, w: W - PAD * 2, cols, rows, rowH: 40, fs: 15 }) + 36;
  y = sectionTitle(g, y, "IDENTIFIED HAZARDS AND CORRECTIVE ACTION");
  const items = rep.rows.flatMap((r) => (r.data?.hazards || []).map((h) => ({ co: r.company, ...h })));
  g.font = "15px sans-serif";
  if (!items.length) { g.fillStyle = MUTED; g.textAlign = "left"; g.fillText("No hazard reported on the cut-off day.", PAD, y + 10); }
  items.slice(0, 9).forEach((h) => {
    const l1 = wrapLines(g, `${h.hazard || "-"}`, 620), l2 = wrapLines(g, `${h.action || "-"}`, 430), n = Math.max(l1.length, l2.length), rh = n * 21 + 14;
    g.fillStyle = TINT.warn; g.fillRect(PAD, y, W - PAD * 2, rh); g.fillStyle = TONE.warn; g.fillRect(PAD, y, 6, rh);
    g.fillStyle = INK; g.font = "bold 15px sans-serif"; g.textAlign = "left"; g.fillText(h.co, PAD + 18, y + 18);
    g.font = "15px sans-serif"; l1.forEach((l, i) => g.fillText(l, PAD + 80, y + 18 + i * 21));
    g.fillStyle = MUTED; g.fillText("ACTION", PAD + 720, y + 18); g.fillStyle = INK; l2.forEach((l, i) => g.fillText(l, PAD + 790, y + 18 + i * 21));
    g.fillStyle = MUTED; g.textAlign = "right"; g.fillText([h.category, h.risk].filter(Boolean).join(" · "), W - PAD - 10, y + 18);
    y += rh + 7;
  });
  if (items.length > 9) { g.fillStyle = MUTED; g.textAlign = "left"; g.fillText(`+ ${items.length - 9} more hazards in the master`, PAD, y + 10); }
  foot(g, "Red = fatality, medical treatment or lost time injury. Amber = first aid, property damage, fire or environmental case. Blue = near miss reported.");
  return toBlob(c);
}

function ytdBars(g, items, x, y, w, iso, note) {
  const rowH = 44, labelW = 130, valW = 400, track = w - labelW - valW;
  g.textAlign = "left"; g.fillStyle = INK; g.font = "bold 15px sans-serif"; g.fillText("Year to date against the Year Plan", x, y + 8);
  if (note) { g.fillStyle = MUTED; g.font = "12px sans-serif"; g.textAlign = "right"; g.fillText(note, x + w, y + 8); }
  y += 30;
  const pace = verdict({ plan: 1, pct: 0 }, "year", iso).pace;
  const x0 = x + labelW;
  items.forEach((it) => {
    const v = verdict({ plan: it.plan, pct: it.pct }, "year", iso);
    g.fillStyle = INK; g.font = "bold 13px sans-serif"; g.textAlign = "left"; g.fillText(it.name, x, y + rowH / 2);
    g.fillStyle = "#e2e8f0"; g.fillRect(x0, y + 10, track, 24);
    if (it.pct != null) { g.fillStyle = TONE[v.tone === "pace" ? "pace" : v.tone]; g.fillRect(x0, y + 8, Math.min(it.pct, 130) / 130 * track, 24); }
    g.fillStyle = INK; g.fillRect(x0 + (100 / 130) * track - 1, y + 5, 2, 34);
    g.fillRect(x0 + Math.min(pace, 130) / 130 * track - 1, y + 5, 1, 34);
    g.textAlign = "left"; g.fillStyle = it.pct == null ? MUTED : TONE[v.tone]; g.font = "bold 13px sans-serif";
    g.fillText(it.plan > 0 ? `${fmt(it.actual, 0)} of ${fmt(it.plan, 0)}  ·  ${it.pct.toFixed(1)}%  ${v.label}` : `${fmt(it.actual, 0)}  ·  no annual plan`, x0 + track + 14, y + rowH / 2);
    y += rowH;
  });
  g.fillStyle = MUTED; g.font = "11px sans-serif"; g.textAlign = "left";
  g.fillText(`Solid line = 100% of the plan. Thin line = share of the year passed (${pace.toFixed(0)}%).`, x, y + 12);
  return y + 24;
}

function pageShipment(rep) {
  const { c, g } = newPage(rep, "Shipment (MT)", "C");
  const iso = rep.report_date;
  const grp = [{ label: "", span: 2 }, ...["DAY", "WEEK", "MONTH", "YEAR"].map((l) => ({ label: l, span: 3 })), { label: "", span: 2 }];
  const cols = [{ label: "NO", w: 0.4, a: "l" }, { label: "COMPANY", w: 3.3, a: "l" }, ...PER.flatMap(() => [{ label: "PLAN", w: 1.15 }, { label: "ACTUAL", w: 1.15 }, { label: "%", w: 0.95 }]), { label: "AVG NI %", w: 1 }, { label: "REMARK", w: 1.9, a: "c" }];
  const rowOf = (r, i) => {
    const d = r.data;
    if (!d) return { cells: [String(i + 1), r.name, ...Array(12).fill(dash), dash, dash] };
    const iso2 = d.cut_off;
    return { cells: [String(i + 1), r.name, ...PER.flatMap((p) => [num(d.shipment[p].plan > 0 ? d.shipment[p].plan : 0, d.shipment[p].plan > 0), num(d.shipment[p].actual, d.shipment[p].actual > 0 || d.shipment[p].plan > 0), pctCell(d.shipment[p], p, iso2)]), { t: "n/a", c: "#94a3b8" }, { t: cutText(r), c: d.cut_off !== iso ? TONE.bad : MUTED, b: d.cut_off !== iso }] };
  };
  const rows = rep.rows.map(rowOf);
  const t = rep.total.shipment;
  rows.push({ bg: BAND, bold: true, cells: ["", "TOTAL SHIPMENT", ...PER.flatMap((p) => [fmt(t[p].plan), fmt(t[p].actual), pctCell(t[p], p, iso)]), "", ""] });
  let y = table(g, { x: PAD, y: 100, w: W - PAD * 2, cols, groups: grp, rows, rowH: 40, fs: 13.5 }) + 40;
  const items = [...rep.rows.filter((r) => r.data).map((r) => ({ name: r.company, actual: r.data.shipment.year.actual, plan: r.data.shipment.year.plan, pct: r.data.shipment.year.pct })), { name: "TOTAL", actual: t.year.actual, plan: t.year.plan, pct: t.year.pct }];
  ytdBars(g, items, PAD, y, W - PAD * 2, iso, "Year Plan = calendar year plan of each site");
  foot(g, "Plans of week, month and year are full-period targets. Average grade is not stored in the portal history. Companies without a site project are not included.");
  return toBlob(c);
}

function pageProduction(rep) {
  const { c, g } = newPage(rep, "Production (WMT)", "D");
  const iso = rep.report_date;
  const grp = [{ label: "", span: 3 }, ...["DAY", "WEEK", "MONTH", "YEAR"].map((l) => ({ label: l, span: 3 })), { label: "", span: 2 }];
  const cols = [{ label: "NO", w: 0.35, a: "l" }, { label: "COMPANY", w: 3.2, a: "l" }, { label: "MATERIALS", w: 1.5, a: "l" }, ...PER.flatMap(() => [{ label: "PLAN", w: 1.1 }, { label: "ACTUAL", w: 1.1 }, { label: "%", w: 0.9 }]), { label: "AVG NI %", w: 0.9 }, { label: "REMARK", w: 1.2, a: "c" }];
  const mats = [["LGO (Limonit)", "lgo"], ["MGO", "mgo"], ["HGO (Saprolit)", "hgo"]];
  const rows = [];
  rep.rows.forEach((r, i) => {
    const d = r.data;
    if (!d) { rows.push({ cells: [String(i + 1), r.name, "-", ...Array(12).fill(dash), dash, dash] }); return; }
    const mk = (label, b, first, sub) => ({ bg: sub ? BAND : undefined, bold: sub, cells: [first ? String(i + 1) : "", first ? r.name : "", label, ...PER.flatMap((p) => [num(b[p].plan), num(b[p].actual), pctCell(b[p], p, d.cut_off)]), { t: "n/a", c: "#94a3b8" }, sub ? { t: cutText(r), c: d.cut_off !== iso ? TONE.bad : MUTED, b: d.cut_off !== iso } : ""] });
    mats.forEach(([l, k], mi) => rows.push(mk(l, d.materials[k], mi === 0, false)));
    rows.push(mk("SUB TOTAL", d.production, false, true));
  });
  const gm = (label, b, bg) => ({ bg, bold: true, cells: ["", "", label, ...PER.flatMap((p) => [fmt(b[p].plan), fmt(b[p].actual), pctCell(b[p], p, iso)]), "", ""] });
  rows.push({ ...gm("LGO (Limonit)", rep.materials.lgo, "#fde8d4"), cells: ["", "GRAND TOTALS", ...gm("LGO (Limonit)", rep.materials.lgo).cells.slice(2)] });
  rows.push(gm("MGO", rep.materials.mgo, "#fde8d4"));
  rows.push(gm("HGO (Saprolit)", rep.materials.hgo, "#fde8d4"));
  rows.push(gm("TOTAL", rep.total.production, "#fbd5b0"));
  table(g, { x: PAD, y: 100, w: W - PAD * 2, cols, groups: grp, rows, rowH: 31, fs: 12.5 });
  foot(g, "Production = LGO + MGO + HGO. Plans of week, month and year are full-period targets. Average Ni grade is not stored in the portal history.");
  return toBlob(c);
}

function barChart(g, x, y, w, h, months) {
  const max = Math.max(1, ...months.map((m) => Math.max(m.actual, m.target)));
  const cw = w / 12;
  g.strokeStyle = "#e2e8f0"; g.beginPath(); g.moveTo(x, y + h); g.lineTo(x + w, y + h); g.stroke();
  months.forEach((m, i) => {
    const bx = x + i * cw + cw * 0.18, bw = cw * 0.32;
    g.fillStyle = "#cbd5e1"; if (m.target > 0) g.fillRect(bx, y + h - (m.target / max) * h, bw, (m.target / max) * h);
    const tone = m.target > 0 ? (m.pct >= 100 ? "good" : m.pct >= 80 ? "warn" : "bad") : "pace";
    g.fillStyle = m.loaded ? TONE[tone === "warn" ? "warn" : tone] : "#e2e8f0"; if (m.actual > 0) g.fillRect(bx + bw + 2, y + h - (m.actual / max) * h, bw, (m.actual / max) * h);
  });
}

function pageYearly(rep) {
  const { c, g } = newPage(rep, "Yearly production, HGO (Saprolit) in WMT", "D");
  let y = 96;
  const blocks = [{ name: "ALL COMPANIES", monthly: rep.monthly, yearly: rep.yearly }, ...rep.rows.filter((r) => r.data).map((r) => ({ name: r.name, monthly: r.data.monthly, yearly: r.data.yearly }))];
  const cols = [{ label: "YEARLY PRODUCTION", w: 2.2, a: "l" }, ...MONTH_ABBR.map((m) => ({ label: m, w: 1.1 })), { label: "Total", w: 1.4 }];
  const blockH = Math.floor((H - 96 - 70) / blocks.length);
  blocks.forEach((b) => {
    g.textAlign = "left"; g.fillStyle = INK; g.font = "bold 14px sans-serif"; g.fillText(b.name, PAD, y + 8);
    const v = b.yearly.pct == null ? null : b.yearly.pct >= 100 ? "good" : b.yearly.pct >= 80 ? "warn" : "bad";
    g.textAlign = "right"; g.fillStyle = v ? TONE[v] : MUTED; g.font = "bold 13px sans-serif";
    g.fillText(b.yearly.target > 0 ? `${fmt(b.yearly.actual, 0)} of ${fmt(b.yearly.target, 0)}  ·  ${b.yearly.pct.toFixed(1)}% of the year target` : `${fmt(b.yearly.actual, 0)} · no year target`, W - PAD, y + 8);
    const chartH = Math.max(40, blockH - 24 - 4 * 24 - 40);
    const tw = cols.reduce((a, k) => a + k.w, 0), lw = (cols[0].w / tw) * (W - PAD * 2);
    barChart(g, PAD + lw, y + 22, ((W - PAD * 2) - lw) * (12 / (12 + 1.4 / 1.1)), chartH, b.monthly);
    const ach = (m) => (m.target > 0 && m.loaded ? { t: pc2(m.pct), c: TONE[m.pct >= 100 ? "good" : m.pct >= 80 ? "warn" : "bad"], b: true, bg: TINT[m.pct >= 100 ? "good" : m.pct >= 80 ? "warn" : "bad"] } : dash);
    const rows = [
      { cells: ["Actual", ...b.monthly.map((m) => (m.loaded ? fmt(m.actual) : dash)), { t: fmt(b.yearly.actual), b: true }] },
      { cells: ["Target", ...b.monthly.map((m) => (m.target > 0 ? fmt(m.target) : dash)), { t: b.yearly.target > 0 ? fmt(b.yearly.target) : "-", b: true }] },
      { cells: ["Achievement (%)", ...b.monthly.map(ach), b.yearly.pct == null ? dash : { t: pc2(b.yearly.pct), c: TONE[v], b: true, bg: TINT[v] }] },
    ];
    table(g, { x: PAD, y: y + 26 + chartH, w: W - PAD * 2, cols, rows, rowH: 25, fs: 12 });
    y += blockH;
  });
  foot(g, "Actual = last loaded day of each month (MTD). Target = calendar target of that month. Bars: grey = target, colour = actual (green at or above target, amber 80-100%, red below 80%). Total target = annual HGO plan.");
  return toBlob(c);
}

const YARD = [["hgo", "HGO Saprolit", "#1d4ed8"], ["mgo", "MGO", "#64748b"], ["lgoa", "LGO A Limonit", "#d97706"], ["lgob", "LGO B Limonit", "#fbbf24"], ["wa", "Waiting Assay", "#7c3aed"]];

function pageWeatherStock(rep) {
  const { c, g } = newPage(rep, "Weather, effective working hours and ore stock", "E / F");
  let y = 96;
  y = sectionTitle(g, y, "E  WEATHER AND EFFECTIVE WORKING HOURS", "Monday to Sunday of the report week (hours)");
  const days = rep.rows.find((r) => r.data)?.data.weather.map((d) => d.date) || [];
  const dl = (d) => { const [, m, dd] = d.split("-").map(Number); return `${dd} ${MONTH_ABBR[m - 1]}`; };
  const cols = [{ label: "NO", w: 0.35, a: "l" }, { label: "COMPANY", w: 2.6, a: "l" }, ...days.map((d) => ({ label: dl(d), w: 0.9 })), ...days.map((d) => ({ label: dl(d), w: 0.9 })), { label: "REMARK", w: 1.4, a: "c" }];
  const rows = rep.rows.map((r, i) => ({ cells: [String(i + 1), r.name, ...(r.data ? r.data.weather.map((d) => (d.rain == null ? dash : d.rain > 0 ? { t: fmt(d.rain, 1), c: TONE.info, b: true, bg: TINT.info } : { t: "0", c: MUTED })) : days.map(() => dash)), ...(r.data ? r.data.weather.map((d) => (d.ewh == null ? dash : fmt(d.ewh, 2))) : days.map(() => dash)), { t: cutText(r), c: MUTED }] }));
  y = table(g, { x: PAD, y, w: W - PAD * 2, cols, groups: [{ label: "", span: 2 }, { label: "RAIN DURATION (h)", span: days.length }, { label: "EFFECTIVE WORKING HOURS (h)", span: days.length }, { label: "", span: 1 }], rows, rowH: 30, fs: 13 }) + 34;
  y = sectionTitle(g, y, "F  ORE STOCK (STOCKYARD)", "Latest stock on or before the cut-off day (tonnes)");
  const sc = [{ label: "NO", w: 0.35, a: "l" }, { label: "COMPANY", w: 2.6, a: "l" }, ...YARD.map(([, l]) => ({ label: l.toUpperCase(), w: 1 })), ...YARD.map(([, l]) => ({ label: l.toUpperCase(), w: 1 })), { label: "TOTAL", w: 1.1 }];
  const srows = rep.rows.map((r, i) => {
    const s = r.data?.stock;
    if (!s) return { cells: [String(i + 1), r.name, ...Array(10).fill(dash), dash] };
    const tot = YARD.reduce((a, [k]) => a + s.eto[k] + s.efo[k], 0);
    return { cells: [String(i + 1), r.name, ...YARD.map(([k]) => (s.eto[k] > 0 ? fmt(s.eto[k]) : { t: "0", c: MUTED })), ...YARD.map(([k]) => (s.efo[k] > 0 ? fmt(s.efo[k]) : { t: "0", c: MUTED })), { t: fmt(tot), b: true, bg: BAND }] };
  });
  y = table(g, { x: PAD, y, w: W - PAD * 2, cols: sc, groups: [{ label: "", span: 2 }, { label: "STOCKYARD ETO", span: 5 }, { label: "STOCKYARD EFO", span: 5 }, { label: "", span: 1 }], rows: srows, rowH: 26, fs: 12 }) + 28;
  // stacked bars: remain ore per company
  g.textAlign = "left"; g.fillStyle = INK; g.font = "bold 15px sans-serif"; g.fillText("Remain ore in stockyard (ETO + EFO)", PAD, y + 8); y += 26;
  let lx = PAD + 330;
  YARD.forEach(([, l, col]) => { g.fillStyle = col; g.fillRect(lx, y - 14, 12, 12); g.fillStyle = INK; g.font = "12px sans-serif"; g.fillText(l, lx + 18, y - 7); lx += 150; });
  const withStock = rep.rows.filter((r) => r.data?.stock);
  const mx = Math.max(1, ...withStock.map((r) => YARD.reduce((a, [k]) => a + r.data.stock.eto[k] + r.data.stock.efo[k], 0)));
  const track = W - PAD * 2 - 160 - 150;
  withStock.forEach((r) => {
    g.fillStyle = INK; g.font = "bold 13px sans-serif"; g.textAlign = "left"; g.fillText(r.company, PAD, y + 14);
    let bx = PAD + 120;
    YARD.forEach(([k, , col]) => { const v = r.data.stock.eto[k] + r.data.stock.efo[k], bw = (v / mx) * track; g.fillStyle = col; g.fillRect(bx, y + 3, bw, 22); bx += bw; });
    g.fillStyle = INK; g.font = "bold 13px sans-serif"; g.fillText(fmt(YARD.reduce((a, [k]) => a + r.data.stock.eto[k] + r.data.stock.efo[k], 0), 0), bx + 10, y + 14);
    y += 32;
  });
  foot(g, "Rain in blue. Effective working hours = average of the contractors that worked that day. A dash means no row was loaded for that day.");
  return toBlob(c);
}

function pageFuelBuild(rep) {
  const { c, g } = newPage(rep, "Fuel, manpower and physical construction progress", "G / H");
  let y = 96;
  y = sectionTitle(g, y, "G  FUEL CONSUMPTION AND MAN POWER", "Fuel in litres. Latest values on or before the cut-off day");
  const cols = [{ label: "NO", w: 0.35, a: "l" }, { label: "COMPANY", w: 2.6, a: "l" }, ...["DAY", "WEEK", "MONTH", "STOCK"].map((l) => ({ label: l, w: 1.2 })), ...["TOTAL", "MANAGER", "SPT", "SPV", "DRIVER", "OPRT", "ETC"].map((l) => ({ label: l, w: 0.9 }))];
  const rows = rep.rows.map((r, i) => {
    const f = r.data?.fuel, m = r.data?.manpower;
    return { cells: [String(i + 1), r.name,
      ...(f ? [fmt(f.day, 1), fmt(f.week, 1), fmt(f.month, 1), f.stock < 0 ? { t: fmt(f.stock, 1), c: TONE.bad, b: true, bg: TINT.bad } : fmt(f.stock, 1)] : Array(4).fill(dash)),
      ...(m ? [{ t: String(m.total), b: true, bg: BAND }, String(m.manager), String(m.spt), String(m.spv), String(m.driver), String(m.oprt), String(m.etc)] : Array(7).fill(dash))] };
  });
  y = table(g, { x: PAD, y, w: W - PAD * 2, cols, groups: [{ label: "", span: 2 }, { label: "FUEL CONSUMPTION", span: 4 }, { label: "MAN POWER", span: 7 }], rows, rowH: 30, fs: 13 }) + 34;
  y = sectionTitle(g, y, "H  PHYSICAL CONSTRUCTION PROGRESS", "Latest progress of each item on or before the cut-off day");
  const hc = [{ label: "COMPANY", w: 2.4, a: "l" }, { label: "CATEGORY", w: 1.4, a: "l" }, { label: "ITEM", w: 3.6, a: "l" }, { label: "PROGRESS", w: 3, a: "l" }, { label: "REMARK", w: 2.2, a: "l" }];
  const hrows = []; let more = 0;
  const room = Math.floor((H - 50 - y - 24 - 26) / 24);
  rep.rows.filter((r) => r.data?.construction?.length).forEach((r) => {
    [...r.data.construction].sort((a, b) => a.category.localeCompare(b.category)).forEach((it, i) => {
      if (hrows.length >= room) { more += 1; return; }
      hrows.push({ cells: [i === 0 ? { t: r.name, b: true } : "", it.category, it.item, { bar: it.progress }, it.remark || (r.data.cut_off !== rep.report_date ? `Cut Off: ${shortDate(r.data.cut_off)}` : "")] });
    });
  });
  if (hrows.length) { y = table(g, { x: PAD, y, w: W - PAD * 2, cols: hc, rows: hrows, rowH: 27, fs: 13 }) + 6; }
  else { g.fillStyle = MUTED; g.font = "13px sans-serif"; g.textAlign = "left"; g.fillText("No construction item loaded.", PAD, y + 10); }
  if (more) { g.fillStyle = MUTED; g.font = "12px sans-serif"; g.textAlign = "left"; g.fillText(`+ ${more} more items in the master`, PAD, y + 10); }
  foot(g, "Negative fuel stock is flagged red: check the stock entry. Progress bars: green = 100%, blue = 50% or more, amber = below 50%.");
  return toBlob(c);
}

/** All detail pages of the Daily Report as JPEG blobs, in print order. */
export async function reportPages(rep) {
  return [await pageKey(rep), await pageHse(rep), await pageShipment(rep), await pageProduction(rep), await pageYearly(rep), await pageWeatherStock(rep), await pageFuelBuild(rep)];
}
