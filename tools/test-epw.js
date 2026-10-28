// Checks src/epw.js against real weather files: node tools/test-epw.js <folder or .epw files…>
// Prints each file's location and a midsummer afternoon, and cross-checks lookups against the
// raw lines. Files are only read.

const fs = require('fs');
const path = require('path');

const src = ['sun.js', 'epw.js'].map((f) => fs.readFileSync(path.join(__dirname, '..', 'src', f), 'utf8')).join('\n');
const { EPW, epwLocation } = new Function(`${src}\nreturn { EPW, epwLocation };`)();

const files = process.argv.slice(2).flatMap((p) => (fs.statSync(p).isDirectory()
  ? fs.readdirSync(p).filter((f) => /\.epw$/i.test(f)).map((f) => path.join(p, f)) : [p]));
if (!files.length) { console.error('Usage: node tools/test-epw.js <folder or .epw files…>'); process.exit(1); }

let failures = 0;
const check = (ok, msg) => { if (!ok) { failures++; console.log(`  FAIL ${msg}`); } };
const near = (a, b, tol = 1e-4) => (a === null && b === null) || (a !== null && b !== null && Math.abs(a - b) <= tol);
const f1 = (v) => (v === null ? '—' : v.toFixed(1));

for (const file of files) {
  const bytes = fs.readFileSync(file), t0 = performance.now();
  const epw = EPW.fromBytes(bytes, path.basename(file));
  const ms = performance.now() - t0, L = epw.location;
  console.log(`${path.basename(file)}  (${ms.toFixed(0)} ms, ${epw.length} records)`);
  console.log(`  "${L.station}" -> ${L.name ?? '(no name)'}  ${L.lat}, ${L.lon}  UTC${L.utcOffset >= 0 ? '+' : ''}${L.utcOffset}  ${L.elevation} m${L.known ? '' : '  [placeholder location]'}`);

  const quick = epwLocation(bytes.toString('latin1'));
  check(quick.lat === L.lat && quick.lon === L.lon && quick.utcOffset === L.utcOffset, 'epwLocation differs from parse');

  // Whole-hour lookups without interpolation must return the raw record: 21 July, EPW hour 14.
  const lines = bytes.toString('latin1').split(/\r?\n/).filter((l) => /^\s*-?\d/.test(l));
  const raw = lines.find((l) => { const f = l.split(','); return +f[1] === 7 && +f[2] === 21 && +f[3] === 14; });
  if (raw) {
    const f = raw.split(','), w = epw.at(7, 21, 14, { interpolate: false });
    check(near(w.dryBulb, +f[6] >= 99.9 ? null : +f[6]), `dry bulb ${w.dryBulb} vs ${f[6]}`);
    check(near(w.windSpeed, +f[21] >= 999 ? null : +f[21]), `wind speed ${w.windSpeed} vs ${f[21]}`);
    // Radiation for 13:30 is the record ending 14:00.
    const r = epw.at(7, 21, 13.5);
    check(near(r.globalHorizontal, +f[13] >= 9999 ? null : +f[13]), `GHR ${r.globalHorizontal} vs ${f[13]}`);
  }
  // Interpolation sits between its neighbours; midnight on 1 January wraps to the last record.
  const a = epw.at(7, 21, 14), b = epw.at(7, 21, 15), m = epw.at(7, 21, 14.5);
  if (a.dryBulb !== null && b.dryBulb !== null) check(near(m.dryBulb, (a.dryBulb + b.dryBulb) / 2, 1e-3), 'dry bulb interpolation');
  if (epw.wraps) check(near(epw.at(1, 1, 0).dryBulb, epw.value('dryBulb', epw.length - 1)), 'midnight wrap');
  check(epw.atDayOfYear(2024, 60, 12) !== null, 'leap-day fallback');
  check(epw.records(3, 1).length === 24 * epw.perHour, 'records per day');

  const s = epw.at(7, 21, 14);
  console.log(`  21 Jul 14:00  ${f1(s.dryBulb)} °C  RH ${f1(s.relativeHumidity)}%  wind ${f1(s.windSpeed)} m/s from ${f1(s.windDirection)}°  GHR ${f1(s.globalHorizontal)} Wh/m²`);
  if (epw.groundTemperatures.length || epw.periods.length) console.log(`  ${epw.groundTemperatures.length} ground depths, ${epw.periods.length} typical/extreme periods`);
}
console.log(failures ? `\n${failures} check(s) failed` : `\nAll checks passed on ${files.length} file(s)`);
process.exit(failures ? 1 : 0);
