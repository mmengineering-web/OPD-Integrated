// HPM (Harga Patokan Mineral) for nickel ore. Ported from the old portal's kalkulator-hpm-nikel-2026.html.
// Rules: Kepmen ESDM No.363.K/MB.01/MEM.B/2026 (second amendment of 268/2025, with 144/2026), Lampiran, Bijih Nikel, points 6 and 8.
// Pure functions only, so they can be unit tested without a browser.

// Ni grade that splits the two corrective-factor segments.
export const NI_TIER = 1.2;
export const FE_MAX = 35;      // iron is counted only up to 35 % Fe
export const CO_MIN = 0.05;    // cobalt is counted only from 0.05 % Co

// Used when the live sheet cannot be read (offline, blocked). No rows for Aug 2026 and Sep 2026 period 1: the data was never provided.
export const FALLBACK_HMA = [
  ['Mei 2025', 'Periode Pertama', 15049.23, 33274.62, 1.43], ['Mei 2025', 'Periode Kedua', 15415.00, 33260.77, 1.44],
  ['Juni 2025', 'Periode Pertama', 15405.00, 33256.79, 1.45], ['Juni 2025', 'Periode Kedua', 15221.00, 33235.33, 1.42],
  ['Juli 2025', 'Periode Pertama', 14942.67, 32944.00, 1.36], ['Juli 2025', 'Periode Kedua', 14926.00, 32896.00, 1.35],
  ['Agustus 2025', 'Periode Pertama', 15028.33, 32894.33, 1.44], ['Agustus 2025', 'Periode Kedua', 15012.67, 32893.33, 1.48],
  ['September 2025', 'Periode Pertama', 14899.64, 32894.29, 1.47], ['September 2025', 'Periode Kedua', 15000.33, 32897.67, 1.49],
  ['Oktober 2025', 'Periode Pertama', 15101.67, 33307.67, 1.55], ['Oktober 2025', 'Periode Kedua', 15142.00, 35151.00, 1.54],
  ['November 2025', 'Periode Pertama', 15075.33, 42283.33, 1.55], ['November 2025', 'Periode Kedua', 14998.67, 47571.00, 1.54],
  ['Desember 2025', 'Periode Pertama', 14666.67, 48139.00, 1.52], ['Desember 2025', 'Periode Kedua', 14599.33, 49112.67, 1.55],
  ['Januari 2026', 'Periode Pertama', 14630.00, 52145.71, 1.56], ['Januari 2026', 'Periode Kedua', 16426.54, 53440.00, 1.58],
  ['Februari 2026', 'Periode Pertama', 17774.00, 55537.00, 1.56], ['Februari 2026', 'Periode Kedua', 17670.31, 55838.13, 1.50],
  ['Maret 2026', 'Periode Pertama', 17103.67, 55859.00, 1.45], ['Maret 2026', 'Periode Kedua', 17329.23, 55857.69, 1.44],
  ['April 2026', 'Periode Pertama', 17092.67, 55848.00, 1.55], ['April 2026', 'Periode Kedua', 16933.57, 55852.86, 1.58],
  ['Juli 2026', 'Periode Pertama', 17593.33, 55854, 1.51], ['September 2026', 'Periode Kedua', 16698.00, 52704.33, 1.47],
].map(([month, period, nikel, kobalt, besi]) => ({ month, period, nikel, kobalt, besi, krom: 6.37 }));

/** Corrective factor for nickel ore, in percent. Two separate segments; there is a jump at Ni = 1.2 %. */
export function cfNickel(ni) {
  if (ni > NI_TIER) return 30 + (ni - 1.6) * 10;            // 30 % at 1.6 % Ni, +/-1 % per 0.1 % Ni
  return Math.max(14 - (NI_TIER - ni) * 10, 0);             // 14 % at 1.2 % Ni, falling 1 % per 0.1 % Ni; clamped at 0 (calculator assumption, not in the regulation)
}
/** Associated cobalt CF in percent: 30 above 1.2 % Ni, 17 at or below. */
export const cfCobalt = ni => (ni > NI_TIER ? 30 : 17);

/**
 * in: { ni, fe, co, cr, mc } grades and moisture in percent; hma: { nikel, kobalt, besi, krom } reference prices.
 * Returns the components, subtotal and final HPM in USD per wet metric ton, or { error } for bad input.
 */
export function computeHpm(inp, hma) {
  const v = [inp.ni, inp.fe, inp.co, inp.cr, inp.mc, hma.nikel, hma.kobalt, hma.besi, hma.krom];
  if (v.some(x => !Number.isFinite(x) || x < 0)) return { error: 'Fill in every field with a valid number.' };
  if (inp.mc >= 100) return { error: 'Moisture must be below 100 %.' };
  const cfNi = cfNickel(inp.ni), cfCo = cfCobalt(inp.ni), low = inp.ni <= NI_TIER;
  const feOn = inp.fe <= FE_MAX, coOn = inp.co >= CO_MIN;
  const ni = (inp.ni / 100) * (cfNi / 100) * hma.nikel;
  const fe = feOn ? (inp.fe / 100) * 0.30 * hma.besi * 100 : 0;
  const co = coOn ? (inp.co / 100) * (cfCo / 100) * hma.kobalt : 0;
  const cr = (inp.cr / 100) * 0.10 * hma.krom * 100;
  const subtotal = ni + fe + co + cr, factor = 1 - inp.mc / 100;
  return { cfNi, cfCo, low, feOn, coOn, ni, fe, co, cr, subtotal, factor, hpm: subtotal * factor };
}

// ---- reference prices from the public HMA sheet --------------------------------------------------------
export const SHEET_ID = '1EybRtMlwmSb8vmDc3FHcIXggqCgqgjyF86xsEYePdFM';
export const SHEET_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:json`;

function splitLabel(raw) {
  const t = String(raw ?? '').trim().replace(/\s+/g, ' ');
  const m = t.match(/^(.+?)\s*\((.+?)\)$/);
  if (m) return { month: m[1].trim(), period: m[2].trim() };
  const p = t.split(' - ');
  return p.length >= 2 ? { month: p[0].trim(), period: p.slice(1).join(' - ').trim() } : null;
}
function num(cell) {
  if (cell == null) return NaN;
  if (typeof cell === 'number') return cell;
  const n = parseFloat(String(cell).replace(/\./g, '').replace(',', '.').replace(/[^\d.-]/g, ''));
  return Number.isFinite(n) ? n : NaN;
}
const val = c => (c && c.v != null ? c.v : c && c.f != null ? c.f : '');

/** Parses the gviz response text into HMA rows. Rows with a missing price are dropped. */
export function parseSheet(text) {
  const a = text.indexOf('{'), b = text.lastIndexOf('}');
  if (a < 0 || b < 0) return [];
  const rows = JSON.parse(text.slice(a, b + 1))?.table?.rows ?? [];
  return rows.map(r => {
    const c = r.c || [], lab = splitLabel(val(c[0]));
    if (!lab) return null;
    const row = { ...lab, nikel: num(val(c[1])), kobalt: num(val(c[2])), besi: num(val(c[3])), krom: num(val(c[4])) };
    return [row.nikel, row.kobalt, row.besi, row.krom].every(Number.isFinite) ? row : null;
  }).filter(Boolean);
}

/** The period to open on: Sep 2026 period 2, else Apr 2026 period 2, else the last row. */
export function defaultPick(rows) {
  for (const [m, p] of [['September 2026', 'Periode Kedua'], ['April 2026', 'Periode Kedua']]) if (rows.some(r => r.month === m && r.period === p)) return { month: m, period: p };
  const l = rows[rows.length - 1];
  return l ? { month: l.month, period: l.period } : { month: '', period: '' };
}
