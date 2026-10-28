// Checks src/utci.js against ladybug-comfort's universal_thermal_climate_index:  node tools/test-utci.js
// The reference values below were computed with ladybug-comfort (Python), which clamps wind
// speed to 0.5-17 m/s the same way; two cases sit outside that range on purpose.

const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'utci.js'), 'utf8');
const { utci, utciMany, utciInRange, utciCategory, solarMrtDelta } = new Function(`${src}\nreturn { utci, utciMany, utciInRange, utciCategory, solarMrtDelta };`)();

// [air temperature °C, mean radiant temperature °C, wind speed m/s, relative humidity %, UTCI °C]
const REFERENCE = [
  [20, 20, 0.5, 50, 19.8476494539],
  [25, 25, 1, 50, 24.6121262603],
  [30, 50, 1, 40, 34.7316547654],
  [35, 60, 0.5, 30, 40.8267907315],
  [-10, -10, 5, 80, -27.4730134944],
  [-40, -45, 10, 90, -67.2165299551],
  [45, 70, 0.2, 20, 51.2568486247],
  [10, 10, 20, 70, -20.2484541741],
  [28, 28, 3, 95, 30.6258918634],
  [0, 30, 4, 60, -0.6827034006],
  [-17.6, -32.5, 11.2, 7, -51.1920663829],
  [3.6, 10.2, 1.5, 51, 4.0335146822],
  [-46.3, -32.9, 1.7, 9, -48.4603185654],
  [-7.5, 45.2, 2.5, 22, 4.1282673622],
  [12.7, 77.5, 10.0, 40, 16.7965774984],
  [47.6, 22.3, 14.7, 29, 51.2357520615],
  [-35.6, -53.8, 5.6, 82, -55.0039433347],
  [-31.9, -3.7, 11.0, 37, -58.2624333055],
  [4.8, -18.9, 1.5, 21, -6.2326087088],
  [18.0, 30.8, 5.7, 59, 13.5873153744],
  [-4.7, -4.7, 13.6, 70, -39.7343673857],
  [-25.6, 1.8, 9.2, 88, -49.6636723533],
  [22.9, 21.7, 16.7, 12, 4.9416527395],
  [-8.2, 37.5, 3.0, 49, -1.5976081368],
];

let failures = 0;
const check = (ok, msg) => { if (!ok) { failures++; console.log(`  FAIL ${msg}`); } };

for (const [ta, tr, va, rh, want] of REFERENCE) {
  const got = utci(ta, tr, va, rh);
  check(Math.abs(got - want) < 1e-6, `utci(${ta}, ${tr}, ${va}, ${rh}) = ${got}, expected ${want}`);
}

const many = utciMany(REFERENCE.map((r) => r[0]), REFERENCE.map((r) => r[1]), 3, 50, new Float32Array(REFERENCE.length));
check(many.length === REFERENCE.length && REFERENCE.every((r, i) => Math.abs(many[i] - utci(r[0], r[1], 3, 50)) < 1e-4), 'utciMany with shared wind and humidity');

check(utciInRange(20, 20, 2, 50) && !utciInRange(55, 55, 2, 50) && !utciInRange(20, 100, 2, 50) && !utciInRange(20, 20, 0.2, 50), 'utciInRange');

for (const [v, name] of [[-41, 'Extreme cold stress'], [-40, 'Very strong cold stress'], [8.9, 'Slight cold stress'], [9, 'No thermal stress'],
  [25.9, 'No thermal stress'], [26, 'Moderate heat stress'], [46, 'Extreme heat stress']]) {
  check(utciCategory(v).name === name, `category of ${v} is ${utciCategory(v).name}, expected ${name}`);
}

// Direct-sun MRT rise against ladybug-comfort's solarcal (get_projection_factor_simple):
// [direct normal W/m², altitude °, SHARP °, MRT rise °C]
for (const [dnr, alt, sharp, want] of [[800, 60, 135, 17.04033], [800, 30, 135, 26.507179], [500, 45, 90, 11.072833],
  [300, 15, 10, 12.678817], [650, 7.5, 170, 27.470769], [900, 90, 135, 8.976602]]) {
  const got = solarMrtDelta(dnr, alt, sharp);
  check(Math.abs(got - want) < 1e-5, `solarMrtDelta(${dnr}, ${alt}, ${sharp}) = ${got}, expected ${want}`);
}
check(solarMrtDelta(800, -2) === 0 && solarMrtDelta(0, 40) === 0, 'no sun, no rise');

const t0 = performance.now();
let sink = 0;
for (let i = 0; i < 1e5; i++) sink += utci(20 + (i % 20), 35, 2, 50);
console.log(`100,000 evaluations in ${(performance.now() - t0).toFixed(0)} ms`);
console.log(failures ? `\n${failures} check(s) failed` : `\nAll ${REFERENCE.length} reference cases and checks passed`);
process.exit(failures ? 1 : 0);
