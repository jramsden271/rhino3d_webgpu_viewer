// Results files, bound to a model and read-only. Each kind of file has a parser in RESULT_PARSERS:
//
//   { id, name, extensions, parse(text) -> data, or null if the file isn't this kind (throws if it
//     is but can't be read), describe(data) -> a short summary for the Results files dialog }
//
// parseResultsFile tries each parser in turn until one recognises the file. A parser's extensions
// and an early check in its parse keep that cheap for files meant for another parser.

const LENGTH_IN_METRES = { m: 1, mm: 0.001, cm: 0.01, km: 1000, ft: 0.3048, in: 0.0254 };

// "X [ m ]" -> { name: 'x', unit: 'm' }
function resultColumn(heading) {
  const m = heading.trim().match(/^(.*?)\s*(?:\[\s*(.*?)\s*\])?$/);
  return { name: m[1].toLowerCase(), unit: m[2] ?? null };
}

// CFX streamlines: one or more [Name], [Data] (nodes) and [Lines] (pairs of node numbers) sections.
// Gives { streamlines: [{ name, segments, polylines: [{ points, velocity }] }] }: points (metres, x,
// y, z, ...) with the velocity (m/s) of each, so the node numbers are not kept.
function parseCfdStreamlines(text) {
  if (!/^\[Lines\]\s*$/m.test(text)) return null;
  const streamlines = [];
  let section = null, cur = null, cols = null, scale = 1;
  const finish = () => {
    if (!cur) return true;
    if (!cur.starts.length) return false;
    streamlines.push({ name: cur.name, segments: cur.starts.length, polylines: streamlinePolylines(cur) });
    return true;
  };
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    if (line[0] === '[') {
      section = line.toLowerCase();
      if (section === '[name]' && !finish()) return null;
      if (section === '[name]') cur = null;
      if (section === '[data]') cols = null;
      continue;
    }
    if (section === '[name]') cur = { name: line, row: new Map(), xyz: [], velocity: [], starts: [], ends: [] };
    else if (!cur) return null;
    else if (section === '[data]' && !cols) {
      const heads = line.split(',').map(resultColumn), at = (n) => heads.findIndex((h) => h.name === n);
      cols = { node: at('node number'), x: at('x'), y: at('y'), z: at('z'), v: at('velocity') };
      if (Object.values(cols).includes(-1)) return null;
      const units = heads[cols.x].unit;
      scale = units === null ? 1 : LENGTH_IN_METRES[units.toLowerCase()];
      const speed = heads[cols.v].unit;
      if (!scale || heads[cols.y].unit !== units || heads[cols.z].unit !== units || !(speed === null || speed === 'm s^-1' || speed === 'm/s')) return null;
    } else if (section === '[data]') {
      const r = line.split(',');
      cur.row.set(+r[cols.node], cur.velocity.length);
      cur.xyz.push(+r[cols.x] * scale, +r[cols.y] * scale, +r[cols.z] * scale);
      cur.velocity.push(+r[cols.v]);
    } else if (section === '[lines]') {
      const r = line.split(','), a = cur.row.get(+r[0]), b = cur.row.get(+r[1]);
      if (a === undefined || b === undefined) throw new Error(`[Lines] of ${cur.name} uses a node that isn't in its [Data]: ${line}`);
      cur.starts.push(a);
      cur.ends.push(b);
    }
  }
  return finish() && streamlines.length ? { streamlines } : null;
}

// Joins segments end to end. Usually each starts where the last ended, but nothing relies on that:
// a line starts at a node nothing leads into, and anything left over (a closed loop, the second
// branch of a fork) starts where it can.
function streamlinePolylines({ xyz, velocity, starts, ends }) {
  const n = velocity.length, incoming = new Uint32Array(n), first = new Int32Array(n).fill(-1), next = new Int32Array(starts.length).fill(-1);
  for (let i = starts.length - 1; i >= 0; i--) { incoming[ends[i]]++; next[i] = first[starts[i]]; first[starts[i]] = i; }
  const used = new Uint8Array(starts.length), polylines = [];
  const walk = (seg) => {
    const nodes = [starts[seg]];
    for (let i = seg; i >= 0;) {
      used[i] = 1;
      nodes.push(ends[i]);
      i = first[ends[i]];
      while (i >= 0 && used[i]) i = next[i];
    }
    const points = new Float64Array(nodes.length * 3), speed = new Float32Array(nodes.length);
    nodes.forEach((k, j) => { points[j * 3] = xyz[k * 3]; points[j * 3 + 1] = xyz[k * 3 + 1]; points[j * 3 + 2] = xyz[k * 3 + 2]; speed[j] = velocity[k]; });
    polylines.push({ points, velocity: speed });
  };
  for (let i = 0; i < starts.length; i++) if (!used[i] && !incoming[starts[i]]) walk(i);
  for (let i = 0; i < starts.length; i++) if (!used[i]) walk(i);
  return polylines;
}

const RESULT_PARSERS = [
  { id: 'cfdStreamlines', name: 'CFD streamlines', extensions: ['.csv'], parse: parseCfdStreamlines,
    describe({ streamlines }) {
      const count = (n, what) => `${n.toLocaleString()} ${what}${n === 1 ? '' : 's'}`;
      return [count(streamlines.length, 'streamline'), count(streamlines.reduce((s, l) => s + l.polylines.length, 0), 'polyline'),
        count(streamlines.reduce((s, l) => s + l.segments, 0), 'segment')].join(' · ');
    } },
];

const resultParsersFor = (fileName) => RESULT_PARSERS.filter((p) => p.extensions.some((x) => fileName.toLowerCase().endsWith(x)));

// -> { parser, data }, or null if no parser recognises the file.
function parseResultsFile(bytes, fileName) {
  const parsers = resultParsersFor(fileName);
  if (!parsers.length) return null;
  const text = new TextDecoder().decode(bytes);
  for (const parser of parsers) {
    const data = parser.parse(text);
    if (data) return { parser, data };
  }
  return null;
}

// Display colours along the velocity scale, from 0 to STREAMLINE_MAX_SPEED m/s.
const STREAMLINE_MAX_SPEED = 10;
const STREAMLINE_COLOURS = [[30, 90, 255], [30, 190, 70], [255, 150, 0], [230, 25, 25]];
function velocityColour(v) {
  const f = Math.min(Math.max(v / STREAMLINE_MAX_SPEED, 0), 1) * (STREAMLINE_COLOURS.length - 1);
  const i = Math.min(Math.floor(f), STREAMLINE_COLOURS.length - 2), t = f - i;
  return STREAMLINE_COLOURS[i].map((c, k) => Math.round(c + (STREAMLINE_COLOURS[i + 1][k] - c) * t));
}

// Line-list vertices for streamlines, in the model's units relative to its origin, with each
// segment the colour of its start node. ranges: for each streamline, a { first, count } in vertices
// for each of its polylines.
function streamlineVertices(streamlines, metresPerUnit, origin) {
  const total = streamlines.reduce((s, l) => s + l.segments, 0);
  const pos = new Float32Array(total * 6), col = new Uint8Array(total * 8), ranges = [];
  let at = 0;
  for (const line of streamlines) {
    const parts = [];
    for (const { points, velocity } of line.polylines) {
      const first = at;
      for (let i = 0; i + 1 < velocity.length; i++, at += 2) {
        for (let k = 0; k < 3; k++) {
          pos[at * 3 + k] = points[i * 3 + k] / metresPerUnit - origin[k];
          pos[at * 3 + 3 + k] = points[i * 3 + 3 + k] / metresPerUnit - origin[k];
        }
        const c = velocityColour(velocity[i]);
        col.set(c, at * 4); col[at * 4 + 3] = 255;
        col.set(c, at * 4 + 4); col[at * 4 + 7] = 255;
      }
      parts.push({ first, count: at - first });
    }
    ranges.push(parts);
  }
  return { pos, col, ranges };
}
