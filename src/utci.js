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

export const UTCI_WIND_MIN = 0.5, UTCI_WIND_MAX = 17;

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
export function utci(ta, tr, va, rh) {
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
export function utciMany(ta, tr, va, rh, out) {
  const n = [ta, tr, va, rh].reduce((m, a) => (typeof a === 'number' ? m : Math.max(m, a.length)), 1);
  const at = (a, i) => (typeof a === 'number' ? a : a[i]);
  out ??= new Float64Array(n);
  for (let i = 0; i < n; i++) out[i] = utci(at(ta, i), at(tr, i), at(va, i), at(rh, i));
  return out;
}

// Whether the inputs are inside the ranges the polynomial was fitted over.
export function utciInRange(ta, tr, va, rh) {
  const d = tr - ta, pa = utciSaturatedVapourPressure(ta) * rh / 1000;
  return ta >= -50 && ta <= 50 && d >= -30 && d <= 70 && va >= UTCI_WIND_MIN && va <= UTCI_WIND_MAX && pa <= 5;
}

// The ten assessment bands of thermal stress, each up to (not including) `below` °C. 9-26 °C is
// "no thermal stress", the usual comfort band. colourscales.js has their colours.
export const UTCI_CATEGORIES = [
  { name: 'Extreme cold stress', below: -40, stress: -4 },
  { name: 'Very strong cold stress', below: -27, stress: -3 },
  { name: 'Strong cold stress', below: -13, stress: -2 },
  { name: 'Moderate cold stress', below: 0, stress: -1 },
  { name: 'Slight cold stress', below: 9, stress: -1 },
  { name: 'No thermal stress', below: 26, stress: 0 },
  { name: 'Moderate heat stress', below: 32, stress: 1 },
  { name: 'Strong heat stress', below: 38, stress: 2 },
  { name: 'Very strong heat stress', below: 46, stress: 3 },
  { name: 'Extreme heat stress', below: Infinity, stress: 4 },
];

export function utciCategory(value) {
  return UTCI_CATEGORIES.find((c) => value < c.below);
}

// Sun on a person outdoors (SolarCal: Arens et al. 2015, ASHRAE 55 Appendix C), as the rise in
// mean radiant temperature, °C, in three parts:
//   direct     the sun's beam on the body, only when the person is in sunlight
//   diffuse    light from the sky, in sun or shade
//   reflected  sunlight and skylight off the ground (and walls), in sun or shade
// The formulas are ASHRAE 55's, as in jsthermalcomfort's solar_gain (and pythermalcomfort's), which
// tools/test-utci.js checks this against. That version is for indoors behind glazing and takes the
// diffuse light to be a fifth of the direct beam; outdoors the weather file's measured diffuse
// horizontal radiation is used instead, as ladybug-comfort's outdoor_sky_heat_exch does.
//   altitude   sun altitude, degrees
//   beam       direct normal radiation on the person, W/m² (between or under simulated clouds, or the hour's)
//   diffuse    diffuse horizontal radiation, W/m²
//   options    lit (the person is in sunlight), groundBeam (direct normal radiation on the ground
//              round about, W/m²: the hour's average, as the ground does not change as a cloud
//              passes; default beam), posture ('standing' or 'sitting'), sharp (sun angle from the
//              person's front, degrees: 0 in the face, 180 on the back; 135, side-on and turned away
//              from the glare, is SolarCal's default), skyView (fraction of the sky the person sees, 1
//              in the open), groundReflectance (0.25, ladybug-comfort's default for outdoors; ASHRAE's
//              indoor floor default is 0.6), absorptivity (short-wave, 0.7), reflectedFlux (W/m²: the
//              light the surfaces round the person reflect onto them, as surroundingsGains works it out
//              from what they see; it replaces the formula's open, sunlit ground and the sky view)
export const SOLARCAL_POSTURES = ['standing', 'sitting'];
export function solarCal(altitude, beam, diffuse, { lit = true, groundBeam = beam, posture = 'standing', sharp = 135, skyView = 1, groundReflectance = 0.25, absorptivity = 0.7, reflectedFlux = null } = {}) {
  const sitting = posture === 'sitting', fEff = sitting ? 0.696 : 0.725; // fraction of the body that exchanges radiation
  const up = altitude > 0 ? Math.min(altitude, 90) : 0;
  const iDiff = diffuse > 0 ? diffuse : 0, iDir = up > 0 && beam > 0 ? beam : 0, iGround = up > 0 && groundBeam > 0 ? groundBeam : 0;
  // Each part's flux on the body (W/m² of body surface), and the radiant temperature rise it makes:
  // absorbed short-wave over long-wave emissivity (0.95), over the radiative heat transfer coefficient (6 W/m²K).
  const rise = (flux) => (flux * absorptivity) / 0.95 / (6 * fEff);
  const direct = lit && iDir ? rise(fEff * solarProjectionFactor(up, sharp, sitting) * iDir) : 0;
  const sky = rise(fEff * skyView * 0.5 * iDiff);
  const reflected = rise(fEff * (reflectedFlux ?? skyView * 0.5 * (iGround * Math.sin((up * Math.PI) / 180) + iDiff) * groundReflectance));
  return { direct, diffuse: sky, reflected, total: direct + sky + reflected };
}

// Fraction of the body's surface that faces the sun (fp, the projected area factor), interpolated by
// sun altitude (0, 15 ... 90°, across) and SHARP (0, 15 ... 180°, down): ASHRAE 55's tables, as in
// jsthermalcomfort's solar_gain (MIT licence, Federico Tartarini).
const SOLARCAL_FP = {
  standing: [
    [0.35, 0.35, 0.314, 0.258, 0.206, 0.144, 0.082], [0.342, 0.342, 0.31, 0.252, 0.2, 0.14, 0.082],
    [0.33, 0.33, 0.3, 0.244, 0.19, 0.132, 0.082], [0.31, 0.31, 0.275, 0.228, 0.175, 0.124, 0.082],
    [0.283, 0.283, 0.251, 0.208, 0.16, 0.114, 0.082], [0.252, 0.252, 0.228, 0.188, 0.15, 0.108, 0.082],
    [0.23, 0.23, 0.214, 0.18, 0.148, 0.108, 0.082], [0.242, 0.242, 0.222, 0.18, 0.153, 0.112, 0.082],
    [0.274, 0.274, 0.245, 0.203, 0.165, 0.116, 0.082], [0.304, 0.304, 0.27, 0.22, 0.174, 0.121, 0.082],
    [0.328, 0.328, 0.29, 0.234, 0.183, 0.125, 0.082], [0.344, 0.344, 0.304, 0.244, 0.19, 0.128, 0.082],
    [0.347, 0.347, 0.308, 0.246, 0.191, 0.128, 0.082],
  ],
  sitting: [
    [0.29, 0.324, 0.305, 0.303, 0.262, 0.224, 0.177], [0.292, 0.328, 0.294, 0.288, 0.268, 0.227, 0.177],
    [0.288, 0.332, 0.298, 0.29, 0.264, 0.222, 0.177], [0.274, 0.326, 0.294, 0.289, 0.252, 0.214, 0.177],
    [0.254, 0.308, 0.28, 0.276, 0.241, 0.202, 0.177], [0.23, 0.282, 0.262, 0.26, 0.233, 0.193, 0.177],
    [0.216, 0.26, 0.248, 0.244, 0.22, 0.186, 0.177], [0.234, 0.258, 0.236, 0.227, 0.208, 0.18, 0.177],
    [0.262, 0.26, 0.224, 0.208, 0.196, 0.176, 0.177], [0.28, 0.26, 0.21, 0.192, 0.184, 0.17, 0.177],
    [0.298, 0.256, 0.194, 0.174, 0.168, 0.168, 0.177], [0.306, 0.25, 0.18, 0.156, 0.156, 0.166, 0.177],
    [0.3, 0.24, 0.168, 0.152, 0.152, 0.164, 0.177],
  ],
};
function solarProjectionFactor(altitude, sharp, sitting) {
  const a = Math.min(Math.max(altitude, 0), 90) / 15, s = Math.min(Math.max(sharp, 0), 180) / 15;
  const i = Math.min(Math.floor(s), 11), j = Math.min(Math.floor(a), 5), fs = s - i, fa = a - j;
  const T = sitting ? SOLARCAL_FP.sitting : SOLARCAL_FP.standing;
  return (T[i][j] * (1 - fa) + T[i][j + 1] * fa) * (1 - fs) + (T[i + 1][j] * (1 - fa) + T[i + 1][j + 1] * fa) * fs;
}

// Long-wave exchange with the sky: the sky is colder than the air (much colder when clear), so a
// person who sees it loses heat to it, lowering the mean radiant temperature, °C (a negative number).
// As ladybug-comfort's outdoor_sky_heat_exch (longwave_mrt_delta_from_horiz_ir): half the body faces
// the sky, so the rise is half the sky's temperature less the surroundings', with the sky temperature
// from the weather file's horizontal infrared radiation (ladybug's calc_sky_temperature, with the
// body's emissivity, 0.95). The surroundings (ground and walls) are taken to be at the air temperature.
//   horizIr   horizontal infrared radiation from the sky, W/m²
//   surroundingsTemp   °C
//   skyView   fraction of the sky the person sees, 1 in the open
export function skyLongwaveMrtDelta(horizIr, surroundingsTemp, skyView = 1) {
  if (!(horizIr > 0)) return 0;
  return 0.5 * skyView * (skyTemperature(horizIr) - surroundingsTemp);
}
export function skyTemperature(horizIr, emissivity = 0.95) {
  return (horizIr / (emissivity * 5.6697e-8)) ** 0.25 - 273.15;
}

// The surfaces round a person (ground, walls and anything else, above and below the horizon) as the
// sun and sky light them, from what the person sees of them: view { direct, diffuse }, the shares of
// the whole sphere of directions round the person, weighted as skyview.js's surroundingsView gives
// them (direct by how square each surface faces the sun where it is in sun, diffuse by how much sky
// it faces). dnr and diffuse: the direct normal and diffuse horizontal radiation, W/m². Gives:
//  - reflectedFlux: the light they reflect onto the person (W/m², for solarCal), reflectance 0.25;
//  - warmth: the rise in mean radiant temperature, °C, from their being warmed by the sun. Each
//    surface in sun is taken to be warmer than the air by the sun it absorbs (1 - reflectance) over
//    a heat transfer coefficient of 24 W/m²K (convection and radiation together), so sunlit paving
//    in summer comes out 20-30 °C above the air, as measured; surfaces in shade are taken to be at
//    the air temperature. Each counts in the radiant temperature by its share of the view.
// Open level ground in the sun all round (view { direct: sin(altitude) / 2, diffuse: 1/2 }) reflects
// what solarCal's formula gives in the open, and adds dnr × sin(altitude) / 64 of warmth: about
// 9 °C for 600 W/m² of direct sun on the ground. It ignores how long surfaces take to heat up and
// cool down, and what they are made of.
export const SURFACE_REFLECTANCE = 0.25, SURFACE_H = 24;
export function surroundingsGains({ direct, diffuse: dif }, dnr, diffuse) {
  const iDir = dnr > 0 ? dnr : 0, iDiff = diffuse > 0 ? diffuse : 0;
  return {
    reflectedFlux: SURFACE_REFLECTANCE * (iDir * direct + iDiff * dif),
    warmth: ((1 - SURFACE_REFLECTANCE) * iDir * direct) / SURFACE_H,
  };
}

// The view of open level ground in the sun all round, for surroundingsGains: what is assumed with
// no model to look at. altitude: the sun's, degrees.
export function openGroundView(altitude) {
  return { direct: altitude > 0 ? Math.sin((Math.min(altitude, 90) * Math.PI) / 180) / 2 : 0, diffuse: 0.5, surfaces: 0.5, sunlit: altitude > 0 ? 1 : 0 };
}
