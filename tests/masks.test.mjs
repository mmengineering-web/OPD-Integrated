// Unit tests for the input masks (src/lib/opd/masks.js).
import assert from "node:assert/strict";
import {
  maskEmail, maskName, maskInt, maskZone, maskDecimal, maskPercent, maskLat, maskLon,
  maskEasting, maskNorthing, maskHoleId, passwordProgress, caretAfter,
} from "../src/lib/opd/masks.js";

let n = 0;
const t = (name, fn) => { fn(); n++; console.log("PASS", name); };

t("email: no spaces, lower case", () => {
  assert.equal(maskEmail("  Ana.Lee @ CAN.co "), "ana.lee@can.co");
  assert.equal(maskEmail(""), "");
  assert.equal(maskEmail(null), "");
});

t("name: letters, space, dot, apostrophe, hyphen only", () => {
  assert.equal(maskName("Ana  Maria 3"), "Ana Maria ");
  assert.equal(maskName("  O'Neil-Smith Jr."), "O'Neil-Smith Jr.");
  assert.equal(maskName("Dewi Sartika <b>"), "Dewi Sartika b");
  assert.equal(maskName("é ü ñ"), "é ü ñ");
});

t("int: digits only, length and value caps", () => {
  assert.equal(maskInt("12ab3"), "123");
  assert.equal(maskInt("0007"), "7");
  assert.equal(maskInt("123456", { maxDigits: 4 }), "1234");
  assert.equal(maskInt("99", { max: 60 }), "9");
});

t("zone: 1 to 60, a digit that breaks the cap is dropped", () => {
  assert.equal(maskZone("5"), "5");
  assert.equal(maskZone("51"), "51");
  assert.equal(maskZone("60"), "60");
  assert.equal(maskZone("61"), "6");
  assert.equal(maskZone("99"), "9");
  assert.equal(maskZone("a5b1"), "51");
  assert.equal(maskZone(""), "");
});

t("decimal: comma becomes dot, one dot, decimals cut", () => {
  assert.equal(maskDecimal("1,25"), "1.25");
  assert.equal(maskDecimal("1.2.3"), "1.23");
  assert.equal(maskDecimal("1.123456789", { dec: 3 }), "1.123");
  assert.equal(maskDecimal("abc"), "");
  assert.equal(maskDecimal(".5"), "0.5");
  assert.equal(maskDecimal("007.5"), "7.5");
  assert.equal(maskDecimal("-5"), "5");
  assert.equal(maskDecimal("-5", { neg: true }), "-5");
  assert.equal(maskDecimal("--5", { neg: true }), "-5");
  assert.equal(maskDecimal("1.", {}), "1.");
  assert.equal(maskDecimal("", {}), "");
  assert.equal(maskDecimal("-", { neg: true }), "-");
});

t("percent: 0 to 100", () => {
  assert.equal(maskPercent("30"), "30");
  assert.equal(maskPercent("100"), "100");
  assert.equal(maskPercent("101"), "10");
  assert.equal(maskPercent("55,555"), "55.55");
  assert.equal(maskPercent("1.8"), "1.8");
});

t("latitude and longitude ranges", () => {
  assert.equal(maskLat("-3,512345"), "-3.512345");
  assert.equal(maskLat("91"), "9");
  assert.equal(maskLat("-90"), "-90");
  assert.equal(maskLat("-91"), "-9");
  assert.equal(maskLon("122.123456"), "122.123456");
  assert.equal(maskLon("181"), "18");
  assert.equal(maskLon("-180"), "-180");
});

t("easting and northing: metres with 2 decimals", () => {
  assert.equal(maskEasting("412500,555"), "412500.55");
  assert.equal(maskNorthing("9650000.5"), "9650000.5");
  assert.equal(maskEasting("123456789"), "1234567");
  assert.equal(maskEasting("-5"), "5");
});

t("hole id: capitals, digits, hyphen", () => {
  assert.equal(maskHoleId("wkm dd 0004"), "WKM-DD-0004");
  assert.equal(maskHoleId("wkm_dd--0004!"), "WKM-DD-0004");
  assert.equal(maskHoleId("a".repeat(40)).length, 30);
  assert.equal(maskHoleId(""), "");
});

t("password progress", () => {
  assert.deepEqual(passwordProgress("abc"), { n: 3, ok: false, left: 7 });
  assert.deepEqual(passwordProgress("abcdefghij"), { n: 10, ok: true, left: 0 });
  assert.deepEqual(passwordProgress(undefined), { n: 0, ok: false, left: 10 });
});

t("masks keep an empty field empty", () => {
  for (const f of [maskEmail, maskName, maskInt, maskZone, maskDecimal, maskPercent, maskLat, maskLon, maskEasting, maskNorthing, maskHoleId]) assert.equal(f(""), "");
});

t("masks are idempotent (running twice changes nothing)", () => {
  const cases = [[maskEmail, " A B@c.CO "], [maskName, "  x  y3"], [maskZone, "61"], [maskDecimal, "1,2,3"], [maskPercent, "100.999"], [maskLat, "-91.5"], [maskHoleId, "ab cd_12"]];
  for (const [f, s] of cases) assert.equal(f(f(s)), f(s));
});

t("caret stays after the same typed characters", () => {
  assert.equal(caretAfter("WKM dd", 6, maskHoleId), 6);
  assert.equal(caretAfter("12a", 3, maskInt), 2);
  assert.equal(caretAfter("1a2", 2, maskInt), 1);
  assert.equal(caretAfter("1x00", 2, maskInt), 1);
  assert.equal(caretAfter("abc", null, v => v), 3);
});

console.log(`\n${n} tests passed`);
