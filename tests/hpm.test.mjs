import assert from 'node:assert/strict';
import { cfNickel, cfCobalt, computeHpm, parseSheet, defaultPick, FALLBACK_HMA } from '../src/lib/core/hpm.js';
const close = (a, b, e = 1e-6) => assert.ok(Math.abs(a - b) < e, `${a} vs ${b}`);
const H = { nikel: 16698.00, kobalt: 52704.33, besi: 1.47, krom: 6.37 };

// corrective factor: two segments with a jump at 1.2 % Ni
close(cfNickel(1.6), 30); close(cfNickel(1.8), 32); close(cfNickel(1.2 + 1e-9), 30 + (1.2 - 1.6) * 10, 1e-6);
close(cfNickel(1.2), 14); close(cfNickel(0.9), 11); close(cfNickel(0), 2);
assert.equal(cfCobalt(1.3), 30); assert.equal(cfCobalt(1.2), 17); assert.equal(cfCobalt(0.9), 17);

// saprolite default case, worked by hand: Ni 96.18048 + Fe 6.174 + Co 7.9056.. + Cr 0.637, times 0.7
const r = computeHpm({ ni: 1.8, fe: 14, co: 0.05, cr: 1, mc: 30 }, H);
close(r.ni, 0.018 * 0.32 * 16698); close(r.fe, 6.174); close(r.co, 0.0005 * 0.30 * 52704.33); close(r.cr, 0.637);
close(r.hpm, (r.ni + r.fe + r.co + r.cr) * 0.7); close(r.hpm, 77.6279, 1e-3);

// limonite: low-Ni segment, cobalt tier 17 %
const l = computeHpm({ ni: 0.9, fe: 35, co: 0.08, cr: 0.5, mc: 35 }, H);
assert.ok(l.low); close(l.cfNi, 11); close(l.cfCo, 17); close(l.co, 0.0008 * 0.17 * 52704.33);

// exclusions: Fe above 35 %, Co below 0.05 %
const x = computeHpm({ ni: 1.8, fe: 35.1, co: 0.049, cr: 1, mc: 30 }, H);
assert.equal(x.fe, 0); assert.equal(x.co, 0); assert.equal(x.feOn, false); assert.equal(x.coOn, false);

// bad input
assert.ok(computeHpm({ ni: NaN, fe: 1, co: 1, cr: 1, mc: 1 }, H).error);
assert.ok(computeHpm({ ni: 1, fe: 1, co: 1, cr: 1, mc: 100 }, H).error);
assert.ok(computeHpm({ ni: -1, fe: 1, co: 1, cr: 1, mc: 1 }, H).error);

// sheet parsing
const sheet = `/*O_o*/\ngoogle.visualization.Query.setResponse({"table":{"rows":[
 {"c":[{"v":"Mei 2025 (Periode Pertama)"},{"v":15049.23},{"v":33274.62},{"v":1.43},{"v":6.37}]},
 {"c":[{"v":"Juni 2025 - Periode Kedua"},{"v":"15.221,00"},{"v":"33.235,33"},{"v":"1,42"},{"v":"6,37"}]},
 {"c":[{"v":"bad row"},{"v":1},{"v":2},{"v":3},{"v":4}]},
 {"c":[{"v":"Juli 2025 (Periode Pertama)"},{"v":null},{"v":2},{"v":3},{"v":4}]}]}});`;
const p = parseSheet(sheet);
assert.equal(p.length, 2); assert.equal(p[1].month, 'Juni 2025'); close(p[1].nikel, 15221); close(p[1].besi, 1.42);
assert.deepEqual(parseSheet('nothing'), []);

// default selection
assert.deepEqual(defaultPick(FALLBACK_HMA), { month: 'September 2026', period: 'Periode Kedua' });
assert.deepEqual(defaultPick([{ month: 'A', period: 'B' }]), { month: 'A', period: 'B' });
console.log('hpm tests passed');
