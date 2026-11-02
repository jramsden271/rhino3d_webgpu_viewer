// Colour scales for data, so the same kind of data looks the same across the app. Each metric
// (a kind of data) has one or more scales, the first its default; ColourScales.preferred gives the
// one in use, which the user can change. Scales have fixed values and never stretch to a dataset,
// except for data of no known metric (ColourScales.fromData).
//
// A scale is grouped ({ bands: [{ below, color, label }], start }), each band up to (not including)
// `below`, or smooth ({ stops: [[value, color], ...] }), clamped at both ends. A smooth scale's
// labels: bands whose labels still apply to its values.

const scaleRgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));

const UTCI_COLOURS = ['#0D104B', '#262972', '#3452A4', '#3C65AF', '#37BCED', '#2EB349', '#F38322', '#C31F25', '#7F1416', '#580002'];
const OFF_WHITE = '#F4F1E8', DARKER_OFF_WHITE = '#DDD8C8';
// recolour: band name -> colour, for the variants of the banded scheme.
const utciBands = (recolour = {}) => UTCI_CATEGORIES.map((c, i) => ({ below: c.below, label: c.name, color: recolour[c.name] || UTCI_COLOURS[i] }));
// The continuous version runs through each band's colour at its middle (the open-ended bands: as
// far past their limit as the band next to them is wide).
const utciStops = () => {
  const b = UTCI_CATEGORIES.map((c) => c.below);
  const mids = b.map((v, i) => (i === 0 ? v - (b[1] - b[0]) / 2 : i === b.length - 1 ? b[i - 1] + (b[i - 1] - b[i - 2]) / 2 : (b[i - 1] + v) / 2));
  return mids.map((v, i) => [v, UTCI_COLOURS[i]]);
};

// As for UTCI, a continuous version runs through each band's colour at its middle.
const LAWSON_STOPS = [[1, '#0061F9'], [3, '#00ECF9'], [5, '#03F9A1'], [7, '#47F800'], [9, '#D4FC01'], [11, '#FCA902'], [13, '#FD2E03']];
const LAWSON_BANDS = [
  { below: 2, color: '#0061F9', label: 'Sitting, entrances' },
  { below: 4, color: '#00ECF9', label: 'Sitting, entrances' },
  { below: 6, color: '#03F9A1', label: 'Standing' },
  { below: 8, color: '#47F800', label: 'Walking' },
  { below: 10, color: '#D4FC01', label: 'Walking fast' },
  { below: 12, color: '#FCA902', label: 'Uncomfortable' },
  { below: Infinity, color: '#FD2E03', label: 'Uncomfortable' },
];

const ColourScales = {
  metrics: {
    utci: { name: 'UTCI', unit: '°C' },
    windSpeed: { name: 'Wind speed', unit: 'm/s' },
    relativeHumidity: { name: 'Relative humidity', unit: '%' },
    temperature: { name: 'Temperature', unit: '°C' },
  },

  scales: [
    { id: 'utci', metric: 'utci', name: 'Blue, green, red', bands: utciBands() },
    { id: 'utciWhite', metric: 'utci', name: 'Off-white comfort band', bands: utciBands({ 'No thermal stress': OFF_WHITE }) },
    { id: 'utciWhiter', metric: 'utci', name: 'Off-white to 32 °C', bands: utciBands({ 'No thermal stress': OFF_WHITE, 'Moderate heat stress': DARKER_OFF_WHITE }) },
    { id: 'utciSmooth', metric: 'utci', name: 'Continuous', stops: utciStops(), labels: utciBands() },
    { id: 'lawson', metric: 'windSpeed', name: 'Lawson comfort criteria', start: 0, bands: LAWSON_BANDS },
    { id: 'lawsonSmooth', metric: 'windSpeed', name: 'Lawson, continuous', stops: LAWSON_STOPS, labels: LAWSON_BANDS },
    { id: 'humidity', metric: 'relativeHumidity', name: 'Off-white to blue', stops: [[0, OFF_WHITE], [100, '#3E8FC9']] },
    { id: 'temperature', metric: 'temperature', name: 'Blue, grey, red', stops: [[-20, '#2A63C8'], [10, '#D4D4D4'], [40, '#D0211C']] },
  ],

  choices: {}, // metric -> the id of the scale picked for it

  // Which metric a column of data is, from its name and unit, or null if it is none of them.
  metricOf(name, unit) {
    const n = name.toLowerCase(), u = unit === null ? null : unit.toLowerCase();
    const celsius = u === null || u === 'c' || u === '°c';
    if (n.startsWith('utci') && celsius) return 'utci';
    if (/temperature/.test(n) && celsius) return 'temperature';
    if (/humidity/.test(n) && (u === null || u === '%')) return 'relativeHumidity';
    if (/velocity|wind ?speed/.test(n) && (u === null || u === 'm s^-1' || u === 'm/s')) return 'windSpeed';
    return null;
  },

  forMetric(metric) { return this.scales.filter((s) => s.metric === metric); },
  preferred(metric) {
    const all = this.forMetric(metric);
    return all.find((s) => s.id === this.choices[metric]) || all[0];
  },

  // A blue to red scale for data of no known metric, across all but its extremes.
  fromData(values) {
    const v = Array.from(values).filter(Number.isFinite).sort((a, b) => a - b);
    const lo = v.length ? v[Math.floor(v.length * 0.02)] : 0, hi = v.length ? v[Math.floor(v.length * 0.98)] : 1;
    const top = hi > lo ? hi : lo + 1;
    return { id: 'data', metric: null, name: 'Range of the data', stops: [[lo, '#2A63C8'], [(lo + top) / 2, '#D4D4D4'], [top, '#D0211C']] };
  },

  // The colour of a value, as [r, g, b] 0-255.
  colour(scale, v) {
    if (scale.bands) return scaleRgb((scale.bands.find((b) => v < b.below) || scale.bands[scale.bands.length - 1]).color);
    const S = scale.stops;
    if (v <= S[0][0]) return scaleRgb(S[0][1]);
    for (let i = 1; i < S.length; i++) {
      if (v <= S[i][0]) {
        const t = (v - S[i - 1][0]) / (S[i][0] - S[i - 1][0]), a = scaleRgb(S[i - 1][1]), b = scaleRgb(S[i][1]);
        return a.map((c, k) => Math.round(c + (b[k] - c) * t));
      }
    }
    return scaleRgb(S[S.length - 1][1]);
  },
  css(scale, v) { return `rgb(${this.colour(scale, v).join(' ')})`; },

  // What a value means on this scale, if the scale says.
  label(scale, v) {
    const b = scale.bands || scale.labels;
    return b ? (b.find((x) => v < x.below) || b[b.length - 1]).label : null;
  },

  // The scale as a table of RGBA colours for the GPU: value v is at (v - lo) / (hi - lo) of the way along.
  ramp(scale, size = 2048) {
    const ends = scale.bands ? scale.bands.map((b) => b.below).filter(Number.isFinite) : scale.stops.map((s) => s[0]);
    const pad = scale.bands ? (ends[ends.length - 1] - ends[0]) / Math.max(1, ends.length - 1) : 0;
    const lo = ends[0] - pad, hi = ends[ends.length - 1] + pad, data = new Uint8Array(size * 4);
    for (let i = 0; i < size; i++) {
      data.set(this.colour(scale, lo + ((i + 0.5) / size) * (hi - lo)), i * 4);
      data[i * 4 + 3] = 255;
    }
    return { lo, hi, data };
  },

  // For a legend: cells: [{ color, label }] of equal width with ticks at their edges, or gradient: a
  // CSS gradient. ticks: [{ at (0-1), text }].
  legend(scale) {
    const num = (v) => String(+v.toFixed(1));
    if (scale.bands) {
      const n = scale.bands.length, ticks = scale.bands.slice(0, -1).map((b, i) => ({ at: (i + 1) / n, text: num(b.below) }));
      if (scale.start !== undefined) ticks.unshift({ at: 0, text: num(scale.start) });
      return { cells: scale.bands.map((b) => ({ color: b.color, label: b.label })), ticks };
    }
    const lo = scale.stops[0][0], span = scale.stops[scale.stops.length - 1][0] - lo;
    const at = (v) => (v - lo) / span;
    // Where a scale's values have bands, their edges are the numbers to read it by.
    const marks = scale.labels ? scale.labels.map((b) => b.below).filter((v) => Number.isFinite(v) && at(v) >= 0 && at(v) <= 1) : scale.stops.map(([v]) => v);
    return { gradient: `linear-gradient(to right, ${scale.stops.map(([v, c]) => `${c} ${(at(v) * 100).toFixed(1)}%`).join(', ')})`,
      ticks: marks.map((v) => ({ at: at(v), text: num(v) })) };
  },
};
