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

// Approximate daylight colour (linear RGB, scaled by intensity) and sky brightness.
function sunLight(altitude) {
  const s = Math.sin(altitude * DEG);
  const up = smooth(-0.02, 0.06, s);           // fades in around sunrise
  const warm = smooth(0.0, 0.4, s);            // low sun is warmer
  const rgb = [1.0, 0.58 + 0.38 * warm, 0.32 + 0.56 * warm].map((v) => v * 1.45 * up);
  const sky = 0.32 + 0.68 * smooth(-0.15, 0.35, s);
  return { rgb, sky, up };
}

function smooth(a, b, x) { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); }

const fmtHour = (h) => {
  if (h == null) return '—';
  const m = Math.round((((h % 24) + 24) % 24) * 60);
  return `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
};
