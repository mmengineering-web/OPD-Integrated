// Daily Report output (Phase 4.6): summary image (canvas, PNG or JPEG for the PDF) and the full report PDF (jsPDF, vendored). Browser only.
import { reportPages } from "./daily-report-pages.js";
import { shortDate, fmt, fmtPct, fileStem, headline, status } from "./daily-report.js";

const INK = "#0f172a", MUTED = "#64748b", LINE = "#cbd5e1", WARN = "#b45309";
const ACCENT = "#1d4ed8";
const COL = { good: "#15803d", warn: "#d97706", bad: "#b91c1c", none: "#94a3b8" };


function wrap(g, text, maxW) {
  const out = []; let line = "";
  text.split(" ").forEach((w) => { const t = line ? `${line} ${w}` : w; if (g.measureText(t).width > maxW && line) { out.push(line); line = w; } else line = t; });
  if (line) out.push(line); return out;
}
function card(g, x, y, w, h, label, big, unit, pctV, plan) {
  g.fillStyle = "#f8fafc"; g.fillRect(x, y, w, h);
  g.fillStyle = COL[status(pctV)]; g.fillRect(x, y, 5, h);
  g.textAlign = "left"; g.fillStyle = MUTED; g.font = "600 12px sans-serif"; g.fillText(label.toUpperCase(), x + 18, y + 20);
  g.fillStyle = INK; g.font = "bold 28px sans-serif"; g.fillText(fmt(big, 0), x + 18, y + 54);
  const bw = g.measureText(fmt(big, 0)).width; g.fillStyle = MUTED; g.font = "13px sans-serif"; g.fillText(unit, x + 24 + bw, y + 54);
  g.fillStyle = COL[status(pctV)]; g.font = "bold 15px sans-serif"; g.fillText(pctV == null ? "no plan" : `${pctV.toFixed(0)}% of plan`, x + 18, y + 80);
  g.fillStyle = MUTED; g.font = "12px sans-serif"; g.fillText(`plan ${fmt(plan, 0)}`, x + 18, y + 98);
}
function bars(g, rep, key, title, unit, x, y, w) {
  g.textAlign = "left"; g.fillStyle = INK; g.font = "bold 15px sans-serif"; g.fillText(title, x, y);
  const yr = rep.total[key].year;   // annual plan next to the title
  g.textAlign = "right"; g.fillStyle = MUTED; g.font = "12px sans-serif";
  g.fillText(yr.plan > 0 ? `Year Plan ${fmt(yr.plan, 0)} ${unit} \u00b7 YTD ${fmtPct(yr.pct)}` : "Year Plan not loaded", x + w, y);
  const rows = rep.rows.filter((r) => r.data), labelW = 70, track = w - labelW - 60, cap = 150;
  const x0 = x + labelW, x100 = x0 + (100 / cap) * track;
  let yy = y + 22;
  rows.forEach((r) => {
    g.fillStyle = INK; g.font = "bold 13px sans-serif"; g.textAlign = "left"; g.fillText(r.company, x, yy + 38);
    [["Day", r.data[key].day, 14], ["Week", r.data[key].week, 9], ["Month", r.data[key].month, 9], ["Year", r.data[key].year, 9]].forEach(([lab, b, h], i) => {
      const by = yy + i * 20 + 4, pv = b.pct;
      g.fillStyle = "#e2e8f0"; g.fillRect(x0, by, track, h);
      if (pv != null) { g.fillStyle = COL[status(pv)]; g.fillRect(x0, by, Math.min(pv, cap) / cap * track, h); }
      g.fillStyle = pv == null ? MUTED : COL[status(pv)]; g.font = `${i ? "" : "bold "}12px sans-serif`; g.textAlign = "left";
      g.fillText(pv == null ? "no plan" : `${pv.toFixed(0)}%`, x0 + track + 8, by + h / 2 + 1);
      g.fillStyle = MUTED; g.font = "10px sans-serif"; g.textAlign = "right"; g.fillText(lab, x0 - 6, by + h / 2 + 1);
    });
    yy += 96;
  });
  g.strokeStyle = INK; g.setLineDash([3, 3]); g.lineWidth = 1; g.beginPath(); g.moveTo(x100, y + 16); g.lineTo(x100, yy - 8); g.stroke(); g.setLineDash([]);
  g.fillStyle = INK; g.font = "10px sans-serif"; g.textAlign = "center"; g.fillText("plan", x100, yy + 2);
  return yy;
}

/** WhatsApp image, story first: headline, four KPI cards, target bars per company (day, week, month, year), then a light table. */
export function summaryPng(rep, scale = 2, type = "image/png") {
  const W = 1100, pad = 32, have = rep.rows.filter((r) => r.data), missing = rep.rows.filter((r) => !r.data).map((r) => r.company);
  const barsH = 40 + have.length * 96, tblRows = have.length + 1;
  const H = 40 + 96 + 120 + barsH + 74 + tblRows * 30 + 60 + (rep.stale.length ? 24 : 0);
  const c = document.createElement("canvas"); c.width = W * scale; c.height = H * scale;
  const g = c.getContext("2d"); g.scale(scale, scale); g.textBaseline = "middle";
  g.fillStyle = "#fff"; g.fillRect(0, 0, W, H);
  g.fillStyle = ACCENT; g.fillRect(0, 0, W, 6);
  const hl = headline(rep);
  g.textAlign = "left"; g.fillStyle = ACCENT; g.font = "bold 12px sans-serif"; g.fillText("DAILY REPORT", pad, 34);
  g.fillStyle = INK; g.font = "bold 26px sans-serif";
  const lines = wrap(g, hl.title, W - pad * 2).slice(0, 2);
  lines.forEach((l, i) => g.fillText(l, pad, 66 + i * 32));
  g.fillStyle = MUTED; g.font = "13px sans-serif"; g.fillText(hl.sub, pad, 66 + lines.length * 32 + 4);
  let y = 150;
  const cw = (W - pad * 2 - 3 * 14) / 4, S = rep.total.shipment, P = rep.total.production;
  [["Shipment today", S.day, "MT"], ["Shipment month", S.month, "MT"], ["Production today", P.day, "WMT"], ["Production month", P.month, "WMT"]]
    .forEach(([l, b, u], i) => card(g, pad + i * (cw + 14), y, cw, 112, l, b.actual, u, b.pct, b.plan));
  y += 148;
  const half = (W - pad * 2 - 40) / 2;
  const e1 = bars(g, rep, "shipment", "Shipment vs plan", "MT", pad, y, half);
  bars(g, rep, "production", "Production vs plan", "WMT", pad + half + 40, y, half);
  y = e1 + 26;
  g.fillStyle = INK; g.font = "bold 13px sans-serif"; g.textAlign = "left"; g.fillText("The numbers behind it", pad, y); y += 18;
  const heads = ["", "Shipment day", "Shipment month", "Shipment year", "Year Plan", "Production day", "Production month", "Production year", "Year Plan", "Cut off"];
  const rx = (i) => 120 + i * 105;        // right edge of column i (i = 1..9)
  g.font = "600 11px sans-serif";
  heads.forEach((h, i) => { g.textAlign = i ? "right" : "left"; g.fillStyle = h.startsWith("Year Plan") ? ACCENT : MUTED; g.fillText(h, i ? rx(i) : pad, y); });
  y += 14; g.strokeStyle = LINE; g.lineWidth = 1; g.beginPath(); g.moveTo(pad, y); g.lineTo(W - pad, y); g.stroke(); y += 16;
  const line = (name, sh, pr, cut, bold) => {
    g.fillStyle = INK; g.font = `${bold ? "bold " : ""}13px sans-serif`; g.textAlign = "left"; g.fillText(name, pad, y);
    [[sh.day.actual, 1], [sh.month.actual, 2], [sh.year.actual, 3], [sh.year.plan, 4, true], [pr.day.actual, 5], [pr.month.actual, 6], [pr.year.actual, 7], [pr.year.plan, 8, true]].forEach(([v, i, plan]) => {
      g.textAlign = "right"; g.fillStyle = plan ? ACCENT : INK; g.font = `${bold || plan ? "bold " : ""}13px sans-serif`; g.fillText(plan && !(v > 0) ? "-" : fmt(v, 0), rx(i), y);
    });
    g.textAlign = "right"; g.fillStyle = MUTED; g.font = "12px sans-serif"; g.fillText(cut, rx(9), y);
    y += 30;
  };
  have.forEach((r) => line(r.company, r.data.shipment, r.data.production, shortDate(r.data.cut_off), false));
  g.strokeStyle = LINE; g.beginPath(); g.moveTo(pad, y - 16); g.lineTo(W - pad, y - 16); g.stroke();
  line("TOTAL", S, P, "", true);
  g.textAlign = "left"; g.fillStyle = MUTED; g.font = "11px sans-serif";
  g.fillText(`Shipment in MT, production in WMT (LGO + MGO + HGO). Green = at or above plan, amber = 80-100%, red = below 80%. No site data yet: ${missing.join(", ")}.`, pad, y + 4);
  if (rep.stale.length) { g.fillStyle = WARN; g.font = "bold 12px sans-serif"; g.fillText(`Not yet updated to ${shortDate(rep.report_date)}: ${rep.stale.map((s) => `${s.company} (${shortDate(s.cut_off)})`).join(", ")}`, pad, y + 26); }
  return new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error("The image could not be created."))), type, 0.92));
}

async function addPage(doc, blob) {
  const url = await new Promise((ok) => { const f = new FileReader(); f.onload = () => ok(f.result); f.readAsDataURL(blob); });
  const img = await new Promise((ok) => { const i = new Image(); i.onload = () => ok(i); i.src = url; });
  const r = Math.min(285 / img.width, 198 / img.height);
  doc.addImage(url, "JPEG", (297 - img.width * r) / 2, 6, img.width * r, img.height * r);
}

/** @returns {Promise<Blob>} summary page; with full = true also the pages of sections A-H (key points, activity, HSE, shipment, production, yearly production, weather, ore stock, fuel, manpower, construction). */
export async function reportPdf(jsPDF, rep, full = true) {
  const doc = new jsPDF({ orientation: "landscape", unit: "mm", format: "a4" });
  await addPage(doc, await summaryPng(rep, 2, "image/jpeg"));
  if (full) for (const blob of await reportPages(rep)) { doc.addPage(); await addPage(doc, blob); }
  return doc.output("blob");
}

export function saveBlob(blob, name) {
  const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1500);
}
export { fileStem };
