// Universal Thermal Climate Index (UTCI): the "feels like" temperature outdoors, in °C, from air
// temperature, mean radiant temperature, wind speed and humidity. This is the 6th-order
// polynomial approximation (UTCI_approx, version a 0.002, October 2009, www.utci.org; Bröde et
// al. 2009), as used by ladybug-comfort and the BHoM LadybugTools Toolkit
// (external_comfort/utci.py), whose coefficients the table below is generated from.
//
// Inputs and the ranges the polynomial was fitted over (outside them it is an extrapolation):
//   ta   air temperature, °C                      -50 to 50
//   tr   mean radiant temperature, °C             ta - 30 to ta + 70
//   va   wind speed 10 m above ground, m/s        0.5 to 17 (clamped, as ladybug-comfort does;
//        the speed felt at about 1.1 m is roughly two thirds of this)
//   rh   relative humidity, %                     0 to 100 (vapour pressure up to 5 kPa)

const UTCI_WIND_MIN = 0.5, UTCI_WIND_MAX = 17;

// The polynomial in ta, va, dTr = tr - ta and pa (vapour pressure, kPa), besides a leading ta:
// 210 terms, each [coefficient, power of ta, va, dTr, pa], flattened.
const UTCI_TERMS = new Float64Array([
  0.607562052, 0, 0, 0, 0,  -0.0227712343, 1, 0, 0, 0,  0.000806470249, 2, 0, 0, 0,
  -0.000154271372, 3, 0, 0, 0,  -0.00000324651735, 4, 0, 0, 0,  7.32602852e-8, 5, 0, 0, 0,
  1.35959073e-9, 6, 0, 0, 0,  -2.2583652, 0, 1, 0, 0,  0.0880326035, 1, 1, 0, 0,
  0.00216844454, 2, 1, 0, 0,  -0.0000153347087, 3, 1, 0, 0,  -5.72983704e-7, 4, 1, 0, 0,
  -2.55090145e-9, 5, 1, 0, 0,  -0.751269505, 0, 2, 0, 0,  -0.00408350271, 1, 2, 0, 0,
  -0.0000521670675, 2, 2, 0, 0,  0.00000194544667, 3, 2, 0, 0,  1.14099531e-8, 4, 2, 0, 0,
  0.158137256, 0, 3, 0, 0,  -0.0000657263143, 1, 3, 0, 0,  2.22697524e-7, 2, 3, 0, 0,
  -4.16117031e-8, 3, 3, 0, 0,  -0.0127762753, 0, 4, 0, 0,  0.00000966891875, 1, 4, 0, 0,
  2.52785852e-9, 2, 4, 0, 0,  0.000456306672, 0, 5, 0, 0,  -1.74202546e-7, 1, 5, 0, 0,
  -0.00000591491269, 0, 6, 0, 0,  0.398374029, 0, 0, 1, 0,  0.000183945314, 1, 0, 1, 0,
  -0.00017375451, 2, 0, 1, 0,  -7.60781159e-7, 3, 0, 1, 0,  3.77830287e-8, 4, 0, 1, 0,
  5.43079673e-10, 5, 0, 1, 0,  -0.0200518269, 0, 1, 1, 0,  0.000892859837, 1, 1, 1, 0,
  0.00000345433048, 2, 1, 1, 0,  -3.77925774e-7, 3, 1, 1, 0,  -1.69699377e-9, 4, 1, 1, 0,
  0.000169992415, 0, 2, 1, 0,  -0.0000499204314, 1, 2, 1, 0,  2.47417178e-7, 2, 2, 1, 0,
  1.07596466e-8, 3, 2, 1, 0,  0.0000849242932, 0, 3, 1, 0,  0.00000135191328, 1, 3, 1, 0,
  -6.21531254e-9, 2, 3, 1, 0,  -0.00000499410301, 0, 4, 1, 0,  -1.89489258e-8, 1, 4, 1, 0,
  8.15300114e-8, 0, 5, 1, 0,  0.00075504309, 0, 0, 2, 0,  -0.0000565095215, 1, 0, 2, 0,
  -4.52166564e-7, 2, 0, 2, 0,  2.46688878e-8, 3, 0, 2, 0,  2.42674348e-10, 4, 0, 2, 0,
  0.00015454725, 0, 1, 2, 0,  0.0000052411097, 1, 1, 2, 0,  -8.75874982e-8, 2, 1, 2, 0,
  -1.50743064e-9, 3, 1, 2, 0,  -0.0000156236307, 0, 2, 2, 0,  -1.33895614e-7, 1, 2, 2, 0,
  2.49709824e-9, 2, 2, 2, 0,  6.51711721e-7, 0, 3, 2, 0,  1.94960053e-9, 1, 3, 2, 0,
  -1.00361113e-8, 0, 4, 2, 0,  -0.0000121206673, 0, 0, 3, 0,  -2.1820366e-7, 1, 0, 3, 0,
  7.51269482e-9, 2, 0, 3, 0,  9.79063848e-11, 3, 0, 3, 0,  0.00000125006734, 0, 1, 3, 0,
  -1.81584736e-9, 1, 1, 3, 0,  -3.52197671e-10, 2, 1, 3, 0,  -3.3651463e-8, 0, 2, 3, 0,
  1.35908359e-10, 1, 2, 3, 0,  4.1703262e-10, 0, 3, 3, 0,  -1.30369025e-9, 0, 0, 4, 0,
  4.13908461e-10, 1, 0, 4, 0,  9.22652254e-12, 2, 0, 4, 0,  -5.08220384e-9, 0, 1, 4, 0,
  -2.24730961e-11, 1, 1, 4, 0,  1.17139133e-10, 0, 2, 4, 0,  6.62154879e-10, 0, 0, 5, 0,
  4.0386326e-13, 1, 0, 5, 0,  1.95087203e-12, 0, 1, 5, 0,  -4.73602469e-12, 0, 0, 6, 0,
  5.12733497, 0, 0, 0, 1,  -0.312788561, 1, 0, 0, 1,  -0.0196701861, 2, 0, 0, 1,
  0.00099969087, 3, 0, 0, 1,  0.00000951738512, 4, 0, 0, 1,  -4.66426341e-7, 5, 0, 0, 1,
  0.548050612, 0, 1, 0, 1,  -0.00330552823, 1, 1, 0, 1,  -0.0016411944, 2, 1, 0, 1,
  -0.00000516670694, 3, 1, 0, 1,  9.52692432e-7, 4, 1, 0, 1,  -0.0429223622, 0, 2, 0, 1,
  0.00500845667, 1, 2, 0, 1,  0.00000100601257, 2, 2, 0, 1,  -0.00000181748644, 3, 2, 0, 1,
  -0.00125813502, 0, 3, 0, 1,  -0.000179330391, 1, 3, 0, 1,  0.00000234994441, 2, 3, 0, 1,
  0.000129735808, 0, 4, 0, 1,  0.0000012906487, 1, 4, 0, 1,  -0.00000228558686, 0, 5, 0, 1,
  -0.0369476348, 0, 0, 1, 1,  0.00162325322, 1, 0, 1, 1,  -0.000031427968, 2, 0, 1, 1,
  0.00000259835559, 3, 0, 1, 1,  -4.77136523e-8, 4, 0, 1, 1,  0.0086420339, 0, 1, 1, 1,
  -0.000687405181, 1, 1, 1, 1,  -0.00000913863872, 2, 1, 1, 1,  5.15916806e-7, 3, 1, 1, 1,
  -0.0000359217476, 0, 2, 1, 1,  0.0000328696511, 1, 2, 1, 1,  -7.10542454e-7, 2, 2, 1, 1,
  -0.00001243823, 0, 3, 1, 1,  -7.385844e-9, 1, 3, 1, 1,  2.20609296e-7, 0, 4, 1, 1,
  -0.00073246918, 0, 0, 2, 1,  -0.0000187381964, 1, 0, 2, 1,  0.00000480925239, 2, 0, 2, 1,
  -8.7549204e-8, 3, 0, 2, 1,  0.000027786293, 0, 1, 2, 1,  -0.00000506004592, 1, 1, 2, 1,
  1.14325367e-7, 2, 1, 2, 1,  0.00000253016723, 0, 2, 2, 1,  -1.72857035e-8, 1, 2, 2, 1,
  -3.95079398e-8, 0, 3, 2, 1,  -3.59413173e-7, 0, 0, 3, 1,  7.04388046e-7, 1, 0, 3, 1,
  -1.89309167e-8, 2, 0, 3, 1,  -4.79768731e-7, 0, 1, 3, 1,  7.96079978e-9, 1, 1, 3, 1,
  1.62897058e-9, 0, 2, 3, 1,  3.94367674e-8, 0, 0, 4, 1,  -1.18566247e-9, 1, 0, 4, 1,
  3.34678041e-10, 0, 1, 4, 1,  -1.15606447e-10, 0, 0, 5, 1,  -2.80626406, 0, 0, 0, 2,
  0.548712484, 1, 0, 0, 2,  -0.0039942841, 2, 0, 0, 2,  -0.000954009191, 3, 0, 0, 2,
  0.0000193090978, 4, 0, 0, 2,  -0.308806365, 0, 1, 0, 2,  0.0116952364, 1, 1, 0, 2,
  0.000495271903, 2, 1, 0, 2,  -0.0000190710882, 3, 1, 0, 2,  0.00210787756, 0, 2, 0, 2,
  -0.000698445738, 1, 2, 0, 2,  0.0000230109073, 2, 2, 0, 2,  0.00041785659, 0, 3, 0, 2,
  -0.0000127043871, 1, 3, 0, 2,  -0.00000304620472, 0, 4, 0, 2,  0.0514507424, 0, 0, 1, 2,
  -0.00432510997, 1, 0, 1, 2,  0.0000899281156, 2, 0, 1, 2,  -7.14663943e-7, 3, 0, 1, 2,
  -0.000266016305, 0, 1, 1, 2,  0.000263789586, 1, 1, 1, 2,  -0.00000701199003, 2, 1, 1, 2,
  -0.000106823306, 0, 2, 1, 2,  0.00000361341136, 1, 2, 1, 2,  2.29748967e-7, 0, 3, 1, 2,
  0.000304788893, 0, 0, 2, 2,  -0.0000642070836, 1, 0, 2, 2,  0.00000116257971, 2, 0, 2, 2,
  0.00000768023384, 0, 1, 2, 2,  -5.47446896e-7, 1, 1, 2, 2,  -3.5993791e-8, 0, 2, 2, 2,
  -0.00000436497725, 0, 0, 3, 2,  1.68737969e-7, 1, 0, 3, 2,  2.67489271e-8, 0, 1, 3, 2,
  3.23926897e-9, 0, 0, 4, 2,  -0.0353874123, 0, 0, 0, 3,  -0.22120119, 1, 0, 0, 3,
  0.0155126038, 2, 0, 0, 3,  -0.000263917279, 3, 0, 0, 3,  0.0453433455, 0, 1, 0, 3,
  -0.00432943862, 1, 1, 0, 3,  0.000145389826, 2, 1, 0, 3,  0.00021750861, 0, 2, 0, 3,
  -0.0000666724702, 1, 2, 0, 3,  0.000033321714, 0, 3, 0, 3,  -0.00226921615, 0, 0, 1, 3,
  0.000380261982, 1, 0, 1, 3,  -5.45314314e-9, 2, 0, 1, 3,  -0.000796355448, 0, 1, 1, 3,
  0.0000253458034, 1, 1, 1, 3,  -0.00000631223658, 0, 2, 1, 3,  0.000302122035, 0, 0, 2, 3,
  -0.00000477403547, 1, 0, 2, 3,  0.00000173825715, 0, 1, 2, 3,  -4.09087898e-7, 0, 0, 3, 3,
  0.614155345, 0, 0, 0, 4,  -0.0616755931, 1, 0, 0, 4,  0.00133374846, 2, 0, 0, 4,
  0.00355375387, 0, 1, 0, 4,  -0.000513027851, 1, 1, 0, 4,  0.000102449757, 0, 2, 0, 4,
  -0.00148526421, 0, 0, 1, 4,  -0.0000411469183, 1, 0, 1, 4,  -0.00000680434415, 0, 1, 1, 4,
  -0.00000977675906, 0, 0, 2, 4,  0.0882773108, 0, 0, 0, 5,  -0.00301859306, 1, 0, 0, 5,
  0.00104452989, 0, 1, 0, 5,  0.000247090539, 0, 0, 1, 5,  0.00148348065, 0, 0, 0, 6,
]);

// Saturated vapour pressure over water, hPa (the formula specific to the UTCI model).
function utciSaturatedVapourPressure(ta) {
  const g = [-2836.5744, -6028.076559, 19.54263612, -0.02737830188, 0.000016261698, 7.0229056e-10, -1.8680009e-13];
  const tk = ta + 273.15;
  let es = 2.7150305 * Math.log(tk);
  for (let i = 0; i < g.length; i++) es += g[i] * tk ** (i - 2);
  return Math.exp(es) * 0.01;
}

const _utciPow = [new Float64Array(7), new Float64Array(7), new Float64Array(7), new Float64Array(7)];

// UTCI in °C for one set of conditions.
function utci(ta, tr, va, rh) {
  va = Math.min(Math.max(va, UTCI_WIND_MIN), UTCI_WIND_MAX);
  const pa = utciSaturatedVapourPressure(ta) * rh / 1000; // hPa × rh/100, in kPa
  const x = [ta, va, tr - ta, pa];
  for (let k = 0; k < 4; k++) {
    const p = _utciPow[k];
    p[0] = 1;
    for (let e = 1; e < 7; e++) p[e] = p[e - 1] * x[k];
  }
  const [pt, pv, pd, pp] = _utciPow, T = UTCI_TERMS;
  let sum = ta;
  for (let i = 0; i < T.length; i += 5) sum += T[i] * pt[T[i + 1]] * pv[T[i + 2]] * pd[T[i + 3]] * pp[T[i + 4]];
  return sum;
}

// UTCI for many points at once: each input is an array or a single number shared by every
// point (say one air temperature and wind speed with a mean radiant temperature per point).
// Writes into `out` when given (a Float32Array suits a texture or vertex buffer).
function utciMany(ta, tr, va, rh, out) {
  const n = [ta, tr, va, rh].reduce((m, a) => (typeof a === 'number' ? m : Math.max(m, a.length)), 1);
  const at = (a, i) => (typeof a === 'number' ? a : a[i]);
  out ??= new Float64Array(n);
  for (let i = 0; i < n; i++) out[i] = utci(at(ta, i), at(tr, i), at(va, i), at(rh, i));
  return out;
}

// Whether the inputs are inside the ranges the polynomial was fitted over.
function utciInRange(ta, tr, va, rh) {
  const d = tr - ta, pa = utciSaturatedVapourPressure(ta) * rh / 1000;
  return ta >= -50 && ta <= 50 && d >= -30 && d <= 70 && va >= UTCI_WIND_MIN && va <= UTCI_WIND_MAX && pa <= 5;
}

// The ten assessment bands of thermal stress, each up to (not including) `below` °C, with the
// colours the LadybugTools Toolkit uses. 9-26 °C is "no thermal stress", the usual comfort band.
const UTCI_CATEGORIES = [
  { name: 'Extreme cold stress', below: -40, color: '#0D104B', stress: -4 },
  { name: 'Very strong cold stress', below: -27, color: '#262972', stress: -3 },
  { name: 'Strong cold stress', below: -13, color: '#3452A4', stress: -2 },
  { name: 'Moderate cold stress', below: 0, color: '#3C65AF', stress: -1 },
  { name: 'Slight cold stress', below: 9, color: '#37BCED', stress: -1 },
  { name: 'No thermal stress', below: 26, color: '#2EB349', stress: 0 },
  { name: 'Moderate heat stress', below: 32, color: '#F38322', stress: 1 },
  { name: 'Strong heat stress', below: 38, color: '#C31F25', stress: 2 },
  { name: 'Very strong heat stress', below: 46, color: '#7F1416', stress: 3 },
  { name: 'Extreme heat stress', below: Infinity, color: '#580002', stress: 4 },
];

function utciCategory(value) {
  return UTCI_CATEGORIES.find((c) => value < c.below);
}

// Direct sun on a person (SolarCal: Arens et al. 2015, ASHRAE 55 Appendix C, as in
// ladybug-comfort's solarcal module). Returns how much direct sunlight raises the mean radiant
// temperature, °C, for a standing person in full sun. dnr: direct normal irradiance, W/m²;
// altitude: sun altitude, degrees; sharp: sun angle from the person's front, degrees (0 in the
// face, 180 on the back; 135, side-on and turned away from the glare, is SolarCal's default).
// Shade, sky and ground reflections are left out: in shade the radiant temperature is taken to be
// the air temperature.
function solarMrtDelta(dnr, altitude, sharp = 135) {
  if (!(dnr > 0) || !(altitude > 0)) return 0;
  const absorptivity = 0.7, emissivity = 0.95, exposedFraction = 0.725, radiantCoeff = 6.012;
  const flux = solarProjectionFactor(Math.min(altitude, 90), sharp) * dnr;
  return (flux * absorptivity) / emissivity / (exposedFraction * radiantCoeff);
}

// Fraction of a standing body's surface that faces the sun (Ap/Ad), interpolated from SolarCal's
// table by sun altitude (0, 15 ... 90°) and SHARP (0, 15 ... 180°): ladybug-comfort's
// get_projection_factor_simple.
const SOLARCAL_STANDING = [
  [0.254, 0.254, 0.228, 0.187, 0.149, 0.104, 0.059], [0.248, 0.248, 0.225, 0.183, 0.145, 0.102, 0.059],
  [0.239, 0.239, 0.218, 0.177, 0.138, 0.096, 0.059], [0.225, 0.225, 0.199, 0.165, 0.127, 0.09, 0.059],
  [0.205, 0.205, 0.182, 0.151, 0.116, 0.083, 0.059], [0.183, 0.183, 0.165, 0.136, 0.109, 0.078, 0.059],
  [0.167, 0.167, 0.155, 0.131, 0.107, 0.078, 0.059], [0.175, 0.175, 0.161, 0.131, 0.111, 0.081, 0.059],
  [0.199, 0.199, 0.178, 0.147, 0.12, 0.084, 0.059], [0.22, 0.22, 0.196, 0.16, 0.126, 0.088, 0.059],
  [0.238, 0.238, 0.21, 0.17, 0.133, 0.091, 0.059], [0.249, 0.249, 0.22, 0.177, 0.138, 0.093, 0.059],
  [0.252, 0.252, 0.223, 0.178, 0.138, 0.093, 0.059],
];
function solarProjectionFactor(altitude, sharp = 135) {
  const a = Math.min(Math.max(altitude, 0), 90) / 15, s = Math.min(Math.max(sharp, 0), 180) / 15;
  const i = Math.min(Math.floor(s), 11), j = Math.min(Math.floor(a), 5), fs = s - i, fa = a - j, T = SOLARCAL_STANDING;
  return (T[i][j] * (1 - fa) + T[i][j + 1] * fa) * (1 - fs) + (T[i + 1][j] * (1 - fa) + T[i + 1][j + 1] * fa) * fs;
}
