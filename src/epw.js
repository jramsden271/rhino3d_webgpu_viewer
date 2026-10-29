// EnergyPlus weather (.epw) files: the header (location, ground temperatures, typical and
// extreme periods) and the hourly records, with lookups by date and local clock time.
// Columns and missing-value markers follow the EnergyPlus Auxiliary Programs reference.
//
// Times: each day's records are stamped hours 1-24, and each stands for the weather across its
// hour, so it is attributed to the half hour: hour 1 is 00:30, hour 2 is 01:30 ... hour 24 is
// 23:30. Lookups at other times interpolate between those half hours; for display, rounding
// down to the whole hour (00:00, 01:00 ...) is fine.
//
// Years: a typical year is stitched together from months of different real years, so the year
// column is not meaningful and is ignored. Where a year is needed, the convention is 2017.

const EPW_YEAR = 2017;

// [key, column, unit, missing marker (values at or above it are missing)]
const EPW_FIELDS = [
  ['dryBulb', 6, '°C', 99.9],
  ['dewPoint', 7, '°C', 99.9],
  ['relativeHumidity', 8, '%', 999],
  ['pressure', 9, 'Pa', 999999],
  ['extraterrestrialHorizontal', 10, 'Wh/m²', 9999],
  ['extraterrestrialDirectNormal', 11, 'Wh/m²', 9999],
  ['horizontalInfrared', 12, 'Wh/m²', 9999],
  ['globalHorizontal', 13, 'Wh/m²', 9999],
  ['directNormal', 14, 'Wh/m²', 9999],
  ['diffuseHorizontal', 15, 'Wh/m²', 9999],
  ['globalHorizontalIlluminance', 16, 'lux', 999999],
  ['directNormalIlluminance', 17, 'lux', 999999],
  ['diffuseHorizontalIlluminance', 18, 'lux', 999999],
  ['zenithLuminance', 19, 'cd/m²', 9999],
  ['windDirection', 20, '°', 999],
  ['windSpeed', 21, 'm/s', 999],
  ['totalSkyCover', 22, 'tenths', 99],
  ['opaqueSkyCover', 23, 'tenths', 99],
  ['visibility', 24, 'km', 9999],
  ['ceilingHeight', 25, 'm', 99999],
  ['precipitableWater', 28, 'mm', 999],
  ['aerosolOpticalDepth', 29, 'thousandths', 0.999],
  ['snowDepth', 30, 'cm', 999],
  ['daysSinceSnow', 31, 'days', 99],
  ['albedo', 32, '', 999],
  ['liquidPrecipitation', 33, 'mm', 999],
  ['liquidPrecipitationHours', 34, 'h', 99],
];

class EPW {
  // bytes: ArrayBuffer or Uint8Array. Most files are UTF-8 or plain ASCII; older ones with
  // accented place names are Windows-1252.
  static fromBytes(bytes, fileName) {
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch { text = new TextDecoder('windows-1252').decode(bytes); }
    return EPW.parse(text, fileName);
  }

  static parse(text, fileName = '') {
    const lines = text.replace(/^﻿/, '').split(/\r?\n/);
    const epw = new EPW();
    epw.fileName = fileName;
    epw.header = {};
    let first = 0;
    while (first < lines.length && !/^\s*-?\d/.test(lines[first])) {
      const line = lines[first++], comma = line.indexOf(',');
      if (comma > 0) epw.header[line.slice(0, comma).replace(/\s+/g, '').toUpperCase()] = line.slice(comma + 1);
    }
    if (!epw.header.LOCATION) throw new Error('Not an EPW weather file: there is no LOCATION line.');
    epw.location = parseLocation(epw.header.LOCATION);

    const period = (epw.header.DATAPERIODS || '').split(',');
    epw.perHour = Math.max(1, parseInt(period[1], 10) || 1);
    epw.groundTemperatures = parseGround(epw.header.GROUNDTEMPERATURES);
    epw.periods = parsePeriods(epw.header['TYPICAL/EXTREMEPERIODS']);
    epw.comments = [epw.header.COMMENTS1, epw.header.COMMENTS2].map((c) => (c || '').trim().replace(/^"|"$/g, '')).filter(Boolean);

    const rows = [];
    for (let i = first; i < lines.length; i++) if (lines[i].trim()) rows.push(lines[i].split(','));
    const n = rows.length;
    if (!n) throw new Error('This EPW file has no hourly records.');
    epw.length = n;
    epw.sourceYear = new Int16Array(n); // as written in the file; see the note at the top
    epw.month = new Uint8Array(n);
    epw.day = new Uint8Array(n);
    epw.hour = new Uint8Array(n); // 1-24; the minute column varies between sources and is ignored
    epw.data = {};
    for (const [key] of EPW_FIELDS) epw.data[key] = new Float32Array(n);
    epw.dayStart = new Map(); // month * 32 + day -> index of that day's first record
    for (let i = 0; i < n; i++) {
      const r = rows[i];
      epw.sourceYear[i] = +r[0]; epw.month[i] = +r[1]; epw.day[i] = +r[2]; epw.hour[i] = +r[3];
      const k = epw.month[i] * 32 + epw.day[i];
      if (!epw.dayStart.has(k)) epw.dayStart.set(k, i);
      for (const [key, col, , missing] of EPW_FIELDS) {
        const s = r[col], v = s === undefined || s.trim() === '' ? NaN : +s;
        epw.data[key][i] = v >= missing ? NaN : v;
      }
    }
    // A whole year wraps round (midnight on 1 January lies between 23:30 on 31 December and
    // 00:30 on 1 January); anything
    // shorter holds its first and last records.
    epw.wraps = n === 8760 * epw.perHour || n === 8784 * epw.perHour;
    return epw;
  }

  // Weather at a local (standard-time) clock hour, 0-24 with fractions, interpolated between
  // the records' half hours; with interpolate: false, the record whose hour contains it.
  // Missing values are null. 29 February falls back to the 28th in a 365-day file.
  at(month, day, hour, { interpolate = true } = {}) {
    const f = this.index(month, day, hour);
    if (f === null) return null;
    const out = { month, day, hour };
    for (const [key] of EPW_FIELDS) out[key] = interpolate ? this.sample(key, f) : this.value(key, Math.round(f));
    return out;
  }

  // The fractional record index for a local clock hour (whole at the half hours), for sample();
  // null when the file has no records for that day.
  index(month, day, hour) {
    let start = this.dayStart.get(month * 32 + day);
    if (start === undefined && month === 2 && day === 29) start = this.dayStart.get(2 * 32 + 28);
    return start === undefined ? null : start + hour * this.perHour - 0.5;
  }

  // Same, from a day of the year (1-366). The year only decides whether there is a 29 February.
  atDayOfYear(doy, hour, opts, year = EPW_YEAR) {
    const { month, day } = dateFromDayOfYear(year, doy);
    return this.at(month, day, hour, opts);
  }

  // Every record of a day as plain objects, each with the EPW's own hour stamp (1-24) and the
  // time it stands for (0.5, 1.5 ... 23.5).
  records(month, day) {
    const start = this.dayStart.get(month * 32 + day), out = [];
    if (start === undefined) return out;
    for (let i = start; i < this.length && this.month[i] === month && this.day[i] === day; i++) out.push(this.record(i));
    return out;
  }

  record(i) {
    const day0 = this.dayStart.get(this.month[i] * 32 + this.day[i]);
    const out = { month: this.month[i], day: this.day[i], hour: this.hour[i], time: (i - day0 + 0.5) / this.perHour };
    for (const [key] of EPW_FIELDS) out[key] = this.value(key, i);
    return out;
  }

  value(key, i) {
    const v = this.data[key][this.wrap(i)];
    return Number.isNaN(v) ? null : v;
  }

  // Linear interpolation at a fractional record index. Wind direction takes the shorter way
  // round; if one neighbour is missing, the other is used.
  sample(key, f) {
    const i = Math.floor(f), t = f - i;
    const a = this.value(key, i), b = this.value(key, i + 1);
    if (a === null || b === null) return a ?? b;
    if (key === 'windDirection') return (a + (((b - a + 540) % 360) - 180) * t + 360) % 360;
    return a + (b - a) * t;
  }

  wrap(i) {
    const n = this.length;
    return this.wraps ? ((i % n) + n) % n : Math.max(0, Math.min(n - 1, i));
  }

  static get fields() {
    return EPW_FIELDS.map(([key, , unit]) => ({ key, unit }));
  }
}

// Location only, from the first line, for when the hourly data is not needed.
function epwLocation(text) {
  const m = /^﻿?\s*LOCATION\s*,([^\r\n]*)/i.exec(text);
  if (!m) throw new Error('Not an EPW weather file: there is no LOCATION line.');
  return parseLocation(m[1]);
}

// LOCATION,city,state/province,country,source,WMO,latitude,longitude,UTC offset,elevation
function parseLocation(rest) {
  const f = rest.split(',').map((s) => s.trim());
  const num = (s) => (s === undefined || s === '' || Number.isNaN(+s) ? null : +s);
  const loc = {
    station: f[0] || '', state: f[1] === '-' ? '' : f[1] || '', countryCode: f[2] || '', source: f[3] || '', wmo: f[4] || '',
    lat: num(f[5]), lon: num(f[6]), utcOffset: num(f[7]), elevation: num(f[8]),
  };
  loc.city = epwPlaceName(loc.station);
  loc.country = countryName(loc.countryCode);
  loc.name = [loc.city, loc.country].filter(Boolean).join(', ') || null;
  // Template files carry 0, 0 as a placeholder.
  loc.known = loc.lat !== null && loc.lon !== null && Math.abs(loc.lat) <= 90 && Math.abs(loc.lon) <= 180 && !(loc.lat === 0 && loc.lon === 0);
  return loc;
}

// Weather station names, tidied to the place: "Riyadh-Khalid.Intl.AP" -> "Riyadh Khalid",
// "LONDON-WEATHER-CENT" -> "London", "Leeds Wea Ctr" -> "Leeds". Numeric IDs and template
// placeholders give null.
const STATION_WORDS = new Set(['ap', 'airport', 'arpt', 'intl', 'int', 'international', 'ab', 'afb', 'exec', 'rgnl', 'regional',
  'muni', 'wea', 'weather', 'ctr', 'cent', 'centre', 'center', 'obs', 'observatory', 'aws', 'heliport', 'fixed']);
function epwPlaceName(station) {
  const s = (station || '').replace(/\[[^\]]*\]/g, '').replace(/_[A-Z0-9]+$/, '').trim();
  if (!s || s === '-' || /^[\d\s.-]+$/.test(s) || /^city\s*name$/i.test(s)) return null;
  const caps = s === s.toUpperCase();
  // Dotted (TMYx) and all-capitals (IWEC2) names use '-' and '.' between words; elsewhere a
  // hyphen may be part of the name.
  let words = s.split(caps || s.includes('.') ? /[\s._-]+/ : /[\s._]+/).filter(Boolean);
  if (caps) words = words.map((w) => w[0] + w.slice(1).toLowerCase());
  while (words.length > 1 && STATION_WORDS.has(words[words.length - 1].toLowerCase())) words.pop();
  return words.join(' ');
}

function countryName(code) {
  const c = (code || '').trim();
  if (!/[a-z]/i.test(c) || /^country$/i.test(c)) return null;
  const u = c.toUpperCase();
  return COUNTRIES.get(u) || (u === 'UK' ? 'United Kingdom' : c.length > 3 ? c : u);
}

// GROUND TEMPERATURES,n, then per depth: depth (m), conductivity, density, specific heat,
// and 12 monthly temperatures (°C).
function parseGround(rest) {
  const f = (rest || '').split(','), out = [];
  const n = parseInt(f[0], 10) || 0;
  for (let k = 0; k < n; k++) {
    const b = f.slice(1 + k * 16, 17 + k * 16);
    const months = b.slice(4, 16).map(Number);
    if (b.length === 16 && months.every(Number.isFinite)) out.push({ depth: +b[0], months });
  }
  return out;
}

// TYPICAL/EXTREME PERIODS,n, then per period: name, type, start "m/d", end "m/d".
function parsePeriods(rest) {
  const f = (rest || '').split(',').map((s) => s.trim()), out = [];
  const n = parseInt(f[0], 10) || 0;
  const md = (s) => { const [m, d] = (s || '').split('/').map((x) => parseInt(x, 10)); return m && d ? { month: m, day: d } : null; };
  for (let k = 0; k < n; k++) {
    const [name, type, a, b] = f.slice(1 + k * 4, 5 + k * 4);
    const start = md(a), end = md(b);
    if (name && start && end) out.push({ name, type: (type || '').toLowerCase(), start, end });
  }
  return out;
}

// ISO 3166-1 alpha-3 codes, as EPW files use them, to short English names.
const COUNTRIES = new Map(('AFG Afghanistan|ALA Åland Islands|ALB Albania|DZA Algeria|ASM American Samoa|AND Andorra|AGO Angola|'
  + 'AIA Anguilla|ATA Antarctica|ATG Antigua and Barbuda|ARG Argentina|ARM Armenia|ABW Aruba|AUS Australia|AUT Austria|'
  + 'AZE Azerbaijan|BHS Bahamas|BHR Bahrain|BGD Bangladesh|BRB Barbados|BLR Belarus|BEL Belgium|BLZ Belize|BEN Benin|'
  + 'BMU Bermuda|BTN Bhutan|BOL Bolivia|BES Caribbean Netherlands|BIH Bosnia and Herzegovina|BWA Botswana|BRA Brazil|'
  + 'IOT British Indian Ocean Territory|BRN Brunei|BGR Bulgaria|BFA Burkina Faso|BDI Burundi|CPV Cabo Verde|KHM Cambodia|'
  + 'CMR Cameroon|CAN Canada|CYM Cayman Islands|CAF Central African Republic|TCD Chad|CHL Chile|CHN China|'
  + 'CXR Christmas Island|CCK Cocos (Keeling) Islands|COL Colombia|COM Comoros|COG Congo|COD DR Congo|COK Cook Islands|'
  + 'CRI Costa Rica|CIV Côte d’Ivoire|HRV Croatia|CUB Cuba|CUW Curaçao|CYP Cyprus|CZE Czechia|DNK Denmark|DJI Djibouti|'
  + 'DMA Dominica|DOM Dominican Republic|ECU Ecuador|EGY Egypt|SLV El Salvador|GNQ Equatorial Guinea|ERI Eritrea|'
  + 'EST Estonia|SWZ Eswatini|ETH Ethiopia|FLK Falkland Islands|FRO Faroe Islands|FJI Fiji|FIN Finland|FRA France|'
  + 'GUF French Guiana|PYF French Polynesia|GAB Gabon|GMB Gambia|GEO Georgia|DEU Germany|GHA Ghana|GIB Gibraltar|'
  + 'GRC Greece|GRL Greenland|GRD Grenada|GLP Guadeloupe|GUM Guam|GTM Guatemala|GGY Guernsey|GIN Guinea|'
  + 'GNB Guinea-Bissau|GUY Guyana|HTI Haiti|VAT Vatican City|HND Honduras|HKG Hong Kong|HUN Hungary|ISL Iceland|'
  + 'IND India|IDN Indonesia|IRN Iran|IRQ Iraq|IRL Ireland|IMN Isle of Man|ISR Israel|ITA Italy|JAM Jamaica|JPN Japan|'
  + 'JEY Jersey|JOR Jordan|KAZ Kazakhstan|KEN Kenya|KIR Kiribati|PRK North Korea|KOR South Korea|KWT Kuwait|'
  + 'KGZ Kyrgyzstan|LAO Laos|LVA Latvia|LBN Lebanon|LSO Lesotho|LBR Liberia|LBY Libya|LIE Liechtenstein|LTU Lithuania|'
  + 'LUX Luxembourg|MAC Macao|MDG Madagascar|MWI Malawi|MYS Malaysia|MDV Maldives|MLI Mali|MLT Malta|'
  + 'MHL Marshall Islands|MTQ Martinique|MRT Mauritania|MUS Mauritius|MYT Mayotte|MEX Mexico|FSM Micronesia|'
  + 'MDA Moldova|MCO Monaco|MNG Mongolia|MNE Montenegro|MSR Montserrat|MAR Morocco|MOZ Mozambique|MMR Myanmar|'
  + 'NAM Namibia|NRU Nauru|NPL Nepal|NLD Netherlands|NCL New Caledonia|NZL New Zealand|NIC Nicaragua|NER Niger|'
  + 'NGA Nigeria|NIU Niue|NFK Norfolk Island|MKD North Macedonia|MNP Northern Mariana Islands|NOR Norway|OMN Oman|'
  + 'PAK Pakistan|PLW Palau|PSE Palestine|PAN Panama|PNG Papua New Guinea|PRY Paraguay|PER Peru|PHL Philippines|'
  + 'PCN Pitcairn Islands|POL Poland|PRT Portugal|PRI Puerto Rico|QAT Qatar|REU Réunion|ROU Romania|RUS Russia|'
  + 'RWA Rwanda|BLM Saint Barthélemy|SHN Saint Helena|KNA Saint Kitts and Nevis|LCA Saint Lucia|MAF Saint Martin|'
  + 'SPM Saint Pierre and Miquelon|VCT Saint Vincent and the Grenadines|WSM Samoa|SMR San Marino|'
  + 'STP São Tomé and Príncipe|SAU Saudi Arabia|SEN Senegal|SRB Serbia|SYC Seychelles|SLE Sierra Leone|SGP Singapore|'
  + 'SXM Sint Maarten|SVK Slovakia|SVN Slovenia|SLB Solomon Islands|SOM Somalia|ZAF South Africa|SSD South Sudan|'
  + 'ESP Spain|LKA Sri Lanka|SDN Sudan|SUR Suriname|SJM Svalbard and Jan Mayen|SWE Sweden|CHE Switzerland|SYR Syria|'
  + 'TWN Taiwan|TJK Tajikistan|TZA Tanzania|THA Thailand|TLS Timor-Leste|TGO Togo|TKL Tokelau|TON Tonga|'
  + 'TTO Trinidad and Tobago|TUN Tunisia|TUR Türkiye|TKM Turkmenistan|TCA Turks and Caicos Islands|TUV Tuvalu|'
  + 'UGA Uganda|UKR Ukraine|ARE United Arab Emirates|GBR United Kingdom|USA United States|'
  + 'UMI US Minor Outlying Islands|URY Uruguay|UZB Uzbekistan|VUT Vanuatu|VEN Venezuela|VNM Vietnam|'
  + 'VGB British Virgin Islands|VIR US Virgin Islands|WLF Wallis and Futuna|ESH Western Sahara|YEM Yemen|ZMB Zambia|'
  + 'ZWE Zimbabwe|XKX Kosovo').split('|').map((s) => [s.slice(0, 3), s.slice(4)]));
