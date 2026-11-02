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

// The months' arcs of a sun path diagram. The 21st of each pair of months has nearly the same path.
const SUN_PATH_MONTHS = [[12, 'Dec'], [1, 'Jan, Nov'], [2, 'Feb, Oct'], [3, 'Mar, Sep'], [4, 'Apr, Aug'], [5, 'May, Jul'], [6, 'Jun']];
const SUN_PATH_LOW = Math.sin(4 * DEG); // labels stay this high, clear of the horizon

// A sun path diagram, as directions in model coordinates. opts: { lat, lon, utcOffset, year, north,
// doy, dayName }: doy is a day to pick out, called dayName. Returns segments: [{ a, b, kind }], cut off
// at the horizon, and labels: [{ dir, text, kind }]. kind: 'month', 'hour', 'horizon' or 'day'.
function sunPathDiagram({ lat, lon, utcOffset, year, north, doy, dayName }) {
  const at = (d, hour) => {
    const p = solarPosition({ lat, lon, utcOffset, year, doy: d, hour });
    return sunVector(p.azimuth, p.altitude, north);
  };
  const segments = [], labels = [];
  const add = (points, kind) => {
    for (let i = 0; i + 1 < points.length; i++) {
      let a = points[i], b = points[i + 1];
      if (a[2] <= 0 && b[2] <= 0) continue;
      if (a[2] < 0 || b[2] < 0) {
        const t = a[2] / (a[2] - b[2]), q = a.map((v, k) => v + (b[k] - v) * t), n = Math.hypot(q[0], q[1]);
        const edge = [q[0] / n, q[1] / n, 0];
        if (a[2] < 0) a = edge; else b = edge;
      }
      segments.push({ a, b, kind });
    }
  };
  const arc = (d) => Array.from({ length: 97 }, (_, i) => at(d, i / 4));

  for (const [month, text] of SUN_PATH_MONTHS) {
    const points = arc(dayOfYear(year, month, 21)), ends = [];
    // Named where it comes up and where it goes down, or, if it does neither, at its lowest.
    for (let i = 0; i < 96; i++) {
      const a = points[i], b = points[i + 1];
      if ((a[2] >= SUN_PATH_LOW) !== (b[2] >= SUN_PATH_LOW)) ends.push(a[2] >= SUN_PATH_LOW ? a : b);
    }
    add(points, 'month');
    const lowest = points.reduce((m, p) => (p[2] < m[2] ? p : m));
    for (const dir of ends.length ? ends : lowest[2] > 0 ? [lowest] : []) labels.push({ dir, text, kind: 'month' });
  }

  // Each clock hour through the year, named at its lowest point clear of the horizon.
  for (let hour = 0; hour < 24; hour++) {
    const points = [];
    for (let d = 1; d <= 365; d += 7) points.push(at(d, hour));
    points.push(points[0]);
    add(points, 'hour');
    const clear = points.filter((p) => p[2] >= SUN_PATH_LOW);
    const dir = clear.length ? clear.reduce((m, p) => (p[2] < m[2] ? p : m)) : points.reduce((m, p) => (p[2] > m[2] ? p : m));
    if (dir[2] > 0) labels.push({ dir, text: `${String(hour).padStart(2, '0')}:00`, kind: 'hour' });
  }

  const ring = [];
  for (let az = 0; az <= 360; az += 3) ring.push(sunVector(az, 0, north));
  for (let i = 0; i + 1 < ring.length; i++) segments.push({ a: ring[i], b: ring[i + 1], kind: 'horizon' });
  ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'].forEach((text, i) => {
    const dir = sunVector(i * 45, 0, north);
    labels.push({ dir, text, kind: 'horizon' });
    segments.push({ a: dir, b: sunVector(i * 45, i % 2 ? 1 : 2, north), kind: 'horizon' });
  });

  const day = arc(doy), top = day.reduce((m, p) => (p[2] > m[2] ? p : m));
  add(day, 'day');
  if (top[2] > 0) labels.push({ dir: top, text: dayName, kind: 'day' });
  return { segments, labels };
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
