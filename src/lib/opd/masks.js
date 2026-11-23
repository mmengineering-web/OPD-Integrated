// Input masks. Pure functions: text in, cleaned text out. No DOM, no network.
// A mask runs on every keystroke and only removes or fixes what could never be valid, so the person
// sees the rule at work instead of a red message afterwards. A mask never rejects an empty field.

/** Email: no spaces, lower case. */
export const maskEmail = (v) => String(v ?? "").replace(/\s+/g, "").toLowerCase().slice(0, 120);

/** Person name: letters, spaces, dot, apostrophe, hyphen. One space at a time. */
export const maskName = (v) =>
  String(v ?? "").replace(/[^\p{L}\p{M} .'’-]/gu, "").replace(/ {2,}/g, " ").replace(/^ /, "").slice(0, 60);

/** Whole number, digits only. `maxDigits` caps the length, `max` caps the value (a digit that breaks the cap is dropped). */
export function maskInt(v, { maxDigits = 9, max = Infinity } = {}) {
  let s = String(v ?? "").replace(/\D+/g, "").slice(0, maxDigits);
  if (s.length > 1) s = s.replace(/^0+(?=\d)/, "");
  while (s.length > 1 && Number(s) > max) s = s.slice(0, -1);
  if (Number(s) > max) s = "";
  return s;
}

/** UTM zone: 1 to 60. */
export const maskZone = (v) => maskInt(v, { maxDigits: 2, max: 60 });

/**
 * Decimal number. A comma becomes a dot (Indonesian keyboards), a second dot is dropped, extra decimals are cut.
 * `neg` allows one leading minus. `max` caps the absolute value (a digit that breaks the cap is dropped).
 */
export function maskDecimal(v, { neg = false, int = 9, dec = 6, max = Infinity } = {}) {
  let s = String(v ?? "").replace(/,/g, ".").replace(/\s+/g, "");
  const minus = neg && s.startsWith("-") ? "-" : "";
  s = s.replace(/[^\d.]/g, "");
  const dot = s.indexOf(".");
  let a = dot < 0 ? s : s.slice(0, dot);
  let b = dot < 0 ? "" : s.slice(dot + 1).replace(/\./g, "").slice(0, dec);
  a = a.slice(0, int);
  if (a.length > 1) a = a.replace(/^0+(?=\d)/, "");
  if (dot >= 0 && a === "") a = "0";
  let out = minus + a + (dot >= 0 ? "." + b : "");
  while (out.length > 1 && Math.abs(Number(out)) > max) out = out.slice(0, -1);
  if (Math.abs(Number(out)) > max) out = minus;
  return out;
}

/** A percentage, 0 to 100, up to `dec` decimals. */
export const maskPercent = (v, dec = 2) => maskDecimal(v, { int: 3, dec, max: 100 });

/** Latitude, -90 to 90. */
export const maskLat = (v) => maskDecimal(v, { neg: true, int: 2, dec: 6, max: 90 });
/** Longitude, -180 to 180. */
export const maskLon = (v) => maskDecimal(v, { neg: true, int: 3, dec: 6, max: 180 });
/** UTM easting in metres, up to 7 digits and 2 decimals. */
export const maskEasting = (v) => maskDecimal(v, { int: 7, dec: 2 });
/** UTM northing in metres, up to 8 digits and 2 decimals. */
export const maskNorthing = (v) => maskDecimal(v, { int: 8, dec: 2 });

/** Hole ID: capitals, digits and hyphen. A space or underscore becomes a hyphen. Up to 30 characters. */
export const maskHoleId = (v) =>
  String(v ?? "").toUpperCase().replace(/[\s_]+/g, "-").replace(/[^A-Z0-9-]/g, "").replace(/-{2,}/g, "-").slice(0, 30);

/** Password length helper for the hint under the field: { n, ok, left }. */
export const passwordProgress = (pw, min = 10) => {
  const n = String(pw ?? "").length;
  return { n, ok: n >= min, left: Math.max(0, min - n) };
};

/**
 * Where the caret goes after a mask rewrote the text: right after whatever the mask keeps of the
 * characters that stood before the caret. Pass the caret as the browser reports it (null = end).
 */
export function caretAfter(raw, caret, mask) {
  if (caret == null) return mask(raw).length;
  return mask(raw.slice(0, caret)).length;
}
