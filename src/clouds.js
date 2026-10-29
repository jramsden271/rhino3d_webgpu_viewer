// Clouds and daylight from the weather file.
//
// Cloud amount comes from the file's total sky cover (tenths), which nearly every EPW has, day
// and night. Where it is missing or does not look like observations (not whole tenths, or a
// constant), it is estimated by day from the share of diffuse light (diffuse / global
// horizontal) and filled in between. Radiation is a poor guide to how much of the sky is cloudy
// (scattered cloud barely dims the sun), so it is only the fallback.
//
// The light itself comes from the radiation, which needs no inferring: the sun's strength from the
// direct normal irradiance against a clear sky's, the sky's from the diffuse horizontal.

const CLOUD_SPEED_MAX = 100; // the Weather panel's cloud speed multiplier: 0 .. this
const CLOUD_KM = 1.5;        // height of the cloud layer the sky shader draws

// Clear-sky irradiance (W/m²) for a sun altitude in degrees: Haurwitz for global horizontal,
// Meinel with the Kasten & Young air mass for direct normal.
function clearSky(altitude) {
  const s = Math.sin(altitude * DEG);
  if (s <= 0) return { ghi: 0, dni: 0 };
  const am = 1 / (s + 0.50572 * Math.pow(altitude + 6.07995, -1.6364));
  return { ghi: 1098 * s * Math.exp(-0.057 / s), dni: 1353 * Math.pow(0.7, Math.pow(am, 0.678)) };
}

// Hourly cloud cover (0-1) for a weather file, worked out once and kept on it as
// epw.data.cloudCover. source: 'observed', 'radiation' or 'none'.
function cloudSeries(epw) {
  if (epw.cloudSource) return epw.cloudSource;
  const n = epw.length, tsc = epw.data.totalSkyCover, cover = new Float32Array(n).fill(NaN);
  let have = 0, whole = 0;
  const seen = new Set();
  for (const v of tsc) if (!Number.isNaN(v)) { have++; if (Number.isInteger(v)) whole++; seen.add(v); }
  let source = 'none';
  if (have > 0.9 * n && whole > 0.98 * have && seen.size > 2) {
    source = 'observed';
    for (let i = 0; i < n; i++) cover[i] = tsc[i] / 10;
  } else {
    const ghi = epw.data.globalHorizontal, dhi = epw.data.diffuseHorizontal;
    for (let i = 0; i < n; i++) {
      // Only with the sun well up: low down, even a clear sky's light is mostly diffuse.
      if (ghi[i] > 120 && dhi[i] >= 0) { cover[i] = Math.min(1, Math.max(0, (dhi[i] / ghi[i] - 0.15) / 0.75)); source = 'radiation'; }
    }
  }
  if (source !== 'none') fillGaps(cover, epw.wraps);
  else cover.fill(0);
  epw.data.cloudCover = cover;
  return (epw.cloudSource = source);
}

// Fills missing values (NaN) linearly between their neighbours, round the end of the year when
// the file wraps.
function fillGaps(a, wraps) {
  const n = a.length, known = [];
  for (let i = 0; i < n; i++) if (!Number.isNaN(a[i])) known.push(i);
  if (!known.length) return;
  for (let k = 0; k < known.length; k++) {
    const i = known[k], last = k === known.length - 1;
    if (last && !wraps) { for (let j = i + 1; j < n; j++) a[j] = a[i]; break; }
    const j = last ? known[0] + n : known[k + 1];
    for (let m = i + 1; m < j; m++) a[m % n] = a[i] + ((a[j % n] - a[i]) * (m - i)) / (j - i);
  }
  if (!wraps) for (let j = 0; j < known[0]; j++) a[j] = a[known[0]];
}

// The sky at a day of the year and local clock hour, for a sun altitude in degrees. null without
// records for that day. cover: 0-1; sun: how clear the sun is over the hour (1 = as a clear
// sky's, 0 = hidden); sky: the sky light against a clear sky's; wind (m/s) and windFrom (degrees,
// where it blows from).
//
// The drawn clouds' shadows take about 0.9 x cover of the sun on average, so of the dimming the
// hour's direct radiation shows, they account for that much and an even haze for the rest:
// haze (0-1) dims the sun in the gaps, where gapBeam (W/m²) is its direct normal irradiance.
function weatherSky(epw, doy, hour, altitude) {
  const { month, day } = dateFromDayOfYear(EPW_YEAR, doy);
  const f = epw.index(month, day, hour);
  if (f === null) return null;
  const source = cloudSeries(epw);
  const cover = epw.sample('cloudCover', f) ?? 0;
  const dni = epw.sample('directNormal', f), dhi = epw.sample('diffuseHorizontal', f);
  const cs = clearSky(altitude), high = smooth(2, 8, altitude), clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  // Low down the measured ratios mean little, so the cover decides.
  const byCover = 1 - 0.9 * cover * cover;
  const sun = dni !== null && cs.dni > 0 ? byCover + (clamp(dni / cs.dni, 0, 1) - byCover) * high : byCover;
  // A clear sky's diffuse light is roughly an eighth of its global; an overcast one is brighter.
  const skyRatio = dhi !== null && cs.ghi > 0 ? clamp(Math.sqrt(dhi / (0.12 * cs.ghi)), 0.7, 2.2) : 1;
  const sky = 1 + (skyRatio - 1) * high;
  const haze = Math.min(1, sun / Math.max(0.05, 1 - 0.9 * (cover < 0.01 ? 0 : cover)));
  return { cover, sun, sky, haze, gapBeam: cs.dni * haze, source,
    wind: epw.sample('windSpeed', f) ?? 0, windFrom: epw.sample('windDirection', f) ?? 0 };
}

// The cloud field, as renderer.js draws it (cloudHash, cloudValue, fbm, cloudLevel, cloudShade
// there); keep the two in step. The integer hash gives the same values in JavaScript as on the GPU.
function cloudHash(x, y) {
  let h = (Math.imul(x, 0x8da6b343) ^ Math.imul(y, 0xd8163841)) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d) >>> 0;
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39) >>> 0;
  h = (h ^ (h >>> 15)) >>> 0;
  return (h >>> 8) / 16777216;
}
function cloudValue(x, y) {
  const ix = Math.floor(x), iy = Math.floor(y), fx = x - ix, fy = y - iy;
  const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy);
  const a = cloudHash(ix, iy), b = cloudHash(ix + 1, iy), c = cloudHash(ix, iy + 1), d = cloudHash(ix + 1, iy + 1);
  const ab = a + (b - a) * ux, cd = c + (d - c) * ux;
  return ab + (cd - ab) * uy;
}
function cloudFbm(x, y, octaves) {
  let s = 0, a = 0.5;
  for (let i = 0; i < octaves; i++) { s += a * cloudValue(x, y); x = x * 2.03 + 17.1; y = y * 2.03 + 9.2; a *= 0.5; }
  return s / (1 - a * 2);
}
function cloudLevel(cover) {
  const dc = cover - 0.5;
  return 0.47 - 0.37 * dc - 0.45 * dc * dc * dc;
}

// Cloud shadow at a point p (model units from the origin): 1 in the open, down to 0.1 under a
// cloud. sunDir: towards the sun (model space); drift: how far the clouds have moved (m).
function cloudShadeAt(p, sunDir, cover, drift, metresPerUnit) {
  if (cover < 0.01) return 1;
  const k = metresPerUnit / 1000, up = Math.max(CLOUD_KM - p[2] * k, 0), lz = Math.max(sunDir[2], 0.08);
  const qx = p[0] * k + (sunDir[0] / lz) * up - drift[0] / 1000, qy = p[1] * k + (sunDir[1] / lz) * up - drift[1] / 1000;
  const t = cloudLevel(cover), n = cloudFbm(qx * 0.8, qy * 0.8, 4);
  const a = Math.max(smooth(t - 0.02, t + 0.1, n), smooth(0.85, 1, cover));
  return 1 - 0.9 * a;
}
