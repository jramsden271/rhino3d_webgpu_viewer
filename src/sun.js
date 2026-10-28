// Solar position (NOAA general solar position equations; accurate to well under a degree,
// which is ample for visual sun studies) and conversion to a direction in model space.

const DEG = Math.PI / 180;

const isLeap = (y) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
const daysInYear = (y) => (isLeap(y) ? 366 : 365);

function dayOfYear(year, month, day) {
  return Math.round((Date.UTC(year, month - 1, day) - Date.UTC(year, 0, 1)) / 86400000) + 1;
}
function dateFromDayOfYear(year, doy) {
  const d = new Date(Date.UTC(year, 0, doy));
  return { month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

// opts: { lat, lon (degrees, east positive), utcOffset (hours), year, doy, hour (local clock) }
// Returns azimuth (degrees clockwise from north), altitude (degrees), and sunrise / sunset /
// solar noon in local clock hours (null when the sun does not rise or set that day).
function solarPosition({ lat, lon, utcOffset, year, doy, hour }) {
  const g = ((2 * Math.PI) / daysInYear(year)) * (doy - 1 + (hour - utcOffset - 12) / 24);
  const eqTime = 229.18 * (0.000075 + 0.001868 * Math.cos(g) - 0.032077 * Math.sin(g) - 0.014615 * Math.cos(2 * g) - 0.040849 * Math.sin(2 * g));
  const decl = 0.006918 - 0.399912 * Math.cos(g) + 0.070257 * Math.sin(g) - 0.006758 * Math.cos(2 * g)
    + 0.000907 * Math.sin(2 * g) - 0.002697 * Math.cos(3 * g) + 0.00148 * Math.sin(3 * g);
  const phi = lat * DEG;

  const trueSolarMin = hour * 60 + eqTime + 4 * lon - 60 * utcOffset;
  const ha = (trueSolarMin / 4 - 180) * DEG;
  const cosZen = Math.sin(phi) * Math.sin(decl) + Math.cos(phi) * Math.cos(decl) * Math.cos(ha);
  const zen = Math.acos(Math.max(-1, Math.min(1, cosZen)));
  let altitude = 90 - zen / DEG;
  // Atmospheric refraction lifts the apparent sun slightly near the horizon.
  if (altitude > -0.575) {
    const t = Math.tan(altitude * DEG);
    altitude += (altitude > 5 ? 58.1 / t - 0.07 / t ** 3 + 0.000086 / t ** 5 : 1735 + altitude * (-518.2 + altitude * (103.4 + altitude * (-12.79 + altitude * 0.711)))) / 3600;
  }
  const azimuth = (Math.atan2(Math.sin(ha), Math.cos(ha) * Math.sin(phi) - Math.tan(decl) * Math.cos(phi)) / DEG + 540) % 360;

  const noon = (720 - 4 * lon - eqTime) / 60 + utcOffset;
  const cosH = Math.cos(90.833 * DEG) / (Math.cos(phi) * Math.cos(decl)) - Math.tan(phi) * Math.tan(decl);
  let sunrise = null, sunset = null, polar = null;
  if (cosH > 1) polar = 'night';
  else if (cosH < -1) polar = 'day';
  else {
    const h = Math.acos(cosH) / DEG;
    sunrise = noon - (4 * h) / 60;
    sunset = noon + (4 * h) / 60;
  }
  return { azimuth, altitude, sunrise, sunset, noon, polar };
}

// Unit vector towards the sun in model coordinates. northAngle follows Rhino: degrees
// anticlockwise from the model +X axis to north (90 = +Y is north).
function sunVector(azimuth, altitude, northAngle) {
  const n = northAngle * DEG, north = [Math.cos(n), Math.sin(n), 0], east = [Math.sin(n), -Math.cos(n), 0];
  const a = azimuth * DEG, h = altitude * DEG, c = Math.cos(h);
  return [
    c * (Math.cos(a) * north[0] + Math.sin(a) * east[0]),
    c * (Math.cos(a) * north[1] + Math.sin(a) * east[1]),
    Math.sin(h),
  ];
}

// Sky colours (sRGB) by sun altitude in degrees: overhead, at the horizon, and the extra glow
// added along the horizon towards the sun around sunset and through twilight.
const SKY_KEYS = [
  [90, [0.42, 0.6, 0.86], [0.8, 0.86, 0.92], [0, 0, 0]],
  [20, [0.55, 0.69, 0.86], [0.87, 0.9, 0.93], [0, 0, 0]],
  [8, [0.52, 0.66, 0.85], [0.88, 0.87, 0.86], [0.1, 0.04, 0]],
  [3, [0.43, 0.55, 0.76], [0.84, 0.74, 0.66], [0.2, 0.08, 0]],
  [0, [0.31, 0.39, 0.6], [0.66, 0.54, 0.54], [0.34, 0.12, 0]],
  [-3, [0.19, 0.25, 0.43], [0.44, 0.36, 0.44], [0.38, 0.13, 0.02]],
  [-6, [0.09, 0.12, 0.25], [0.2, 0.18, 0.29], [0.24, 0.08, 0.04]],
  [-10, [0.035, 0.05, 0.11], [0.07, 0.08, 0.14], [0.06, 0.02, 0.02]],
  [-18, [0.01, 0.016, 0.035], [0.022, 0.03, 0.055], [0, 0, 0]],
];

// Approximate daylight colour (linear RGB, scaled by intensity), sky brightness, sky colours and
// how dark it is (night: 0 by day, 1 once the stars are fully out).
function sunLight(altitude) {
  const s = Math.sin(altitude * DEG);
  const up = smooth(-0.02, 0.06, s);           // fades in around sunrise
  const warm = smooth(0.0, 0.4, s);            // low sun is warmer
  const rgb = [1.0, 0.58 + 0.38 * warm, 0.32 + 0.56 * warm].map((v) => v * 1.45 * up);
  const sky = (0.32 + 0.68 * smooth(-0.15, 0.35, s)) * (0.5 + 0.5 * smooth(-0.21, -0.03, s));
  const night = smooth(-4, -13, altitude);
  const a = Math.max(-18, Math.min(90, altitude));
  let i = 1;
  while (i < SKY_KEYS.length - 1 && a < SKY_KEYS[i][0]) i++;
  const [a0, ...c0] = SKY_KEYS[i - 1], [a1, ...c1] = SKY_KEYS[i], t = (a0 - a) / (a0 - a1);
  const [top, horizon, glow] = c0.map((c, k) => c.map((v, j) => v + (c1[k][j] - v) * t));
  return { rgb, sky, up, top, horizon, glow, night };
}

// Days since J2000.0 (noon UT, 1 January 2000) for a local date and clock time.
function j2000Days({ utcOffset, year, doy, hour }) {
  return (Date.UTC(year, 0, 1) - Date.UTC(2000, 0, 1)) / 86400000 + doy - 1 + (hour - utcOffset) / 24 - 0.5;
}

// Local sidereal time (radians): turns the star field with the time of day and year.
function siderealTime(opts) {
  const deg = 280.46061837 + 360.98564736629 * j2000Days(opts) + opts.lon;
  return (((deg % 360) + 360) % 360) * DEG;
}

// Moon position and phase. A short lunar theory (the main periodic terms, good to ~0.3 deg)
// with the parallax from the observer's place on Earth (up to ~1 deg near the horizon).
// opts as solarPosition. Returns azimuth, altitude (degrees), lit (illuminated fraction 0..1),
// waxing (true while the lit fraction is growing) and phase (a name).
function moonPosition(opts) {
  const d = j2000Days(opts), T = d / 36525;
  const sd = (a) => Math.sin(a * DEG), cd = (a) => Math.cos(a * DEG);
  const M = 134.9 + 477198.85 * T, D2 = 259.2 - 413335.38 * T, F2 = 235.7 + 890534.23 * T;
  const lam = 218.32 + 481267.881 * T + 6.29 * sd(M) - 1.27 * sd(D2) + 0.66 * sd(F2)
    + 0.21 * sd(269.9 + 954397.7 * T) - 0.19 * sd(357.5 + 35999.05 * T) - 0.11 * sd(186.6 + 966404.05 * T);
  const beta = 5.13 * sd(93.3 + 483202.03 * T) + 0.28 * sd(228.2 + 960400.87 * T)
    - 0.28 * sd(318.3 + 6003.18 * T) - 0.17 * sd(217.6 - 407332.2 * T);
  const parallax = 0.9508 + 0.0518 * cd(M) + 0.0095 * cd(D2) + 0.0078 * cd(F2) + 0.0028 * cd(269.9 + 954397.7 * T);
  // Ecliptic to equatorial, then to the observer's sky.
  const eps = 23.439 - 0.0000004 * d;
  const x = cd(beta) * cd(lam), y = cd(eps) * cd(beta) * sd(lam) - sd(eps) * sd(beta);
  const z = sd(eps) * cd(beta) * sd(lam) + cd(eps) * sd(beta);
  const ra = Math.atan2(y, x), decl = Math.asin(z), phi = opts.lat * DEG;
  const ha = siderealTime(opts) - ra;
  let altitude = Math.asin(Math.sin(phi) * Math.sin(decl) + Math.cos(phi) * Math.cos(decl) * Math.cos(ha)) / DEG;
  altitude -= parallax * Math.cos(altitude * DEG);
  const azimuth = (Math.atan2(Math.sin(ha), Math.cos(ha) * Math.sin(phi) - Math.tan(decl) * Math.cos(phi)) / DEG + 540) % 360;
  // Phase from the angle between the moon and the sun (the sun's ecliptic longitude).
  const g = 357.528 + 35999.05 * T;
  const sunLam = 280.46 + 36000.771 * T + 1.915 * sd(g) + 0.02 * sd(2 * g);
  const elong = (((lam - sunLam) % 360) + 360) % 360;
  const lit = (1 - cd(beta) * cd(elong)) / 2, waxing = elong < 180;
  const phase = lit < 0.03 ? 'New moon' : lit > 0.97 ? 'Full moon'
    : Math.abs(lit - 0.5) < 0.07 ? (waxing ? 'First quarter' : 'Last quarter')
    : `${waxing ? 'Waxing' : 'Waning'} ${lit < 0.5 ? 'crescent' : 'gibbous'}`;
  return { azimuth, altitude, lit, waxing, phase };
}

// Moonlight (linear RGB): bluish, brightest at full moon, only once the sky is dark.
function moonLight(moonAltitude, lit, night) {
  const k = 0.32 * Math.pow(lit, 1.5) * night * smooth(-1, 6, moonAltitude);
  return [0.62, 0.72, 1.0].map((v) => v * k);
}

function smooth(a, b, x) { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); }

const fmtHour = (h) => {
  if (h == null) return '—';
  const m = Math.round((((h % 24) + 24) % 24) * 60);
  return `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
};
