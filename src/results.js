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

// A blank, "null" or otherwise unusable value counts as missing.
const resultNumber = (s) => {
  const v = s === undefined || s.trim() === '' ? NaN : +s;
  return Number.isFinite(v) ? v : NaN;
};

// CFX values on a surface: one or more [Name], [Data] (nodes, each with any number of results) and
// [Faces] (three or more node numbers) sections. Gives { maps: [{ name, points (metres, x, y, z, ...),
// indices (triangles, as rows of points), results: [{ name, unit, metric, values }], faces,
// skippedFaces, missing }] }. A node without a position loses its faces (skippedFaces), and a
// value it lacks is NaN (missing: how many nodes lack any).
function parseCfdMap(text) {
  if (!/^\[Faces\]\s*$/m.test(text)) return null;
  const maps = [];
  let section = null, cur = null, cols = null, scale = 1;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    if (line[0] === '[') {
      section = line.toLowerCase();
      if (section === '[name]') cur = null;
      if (section === '[data]') cols = null;
      continue;
    }
    if (section === '[name]') {
      cur = { name: line, row: new Map(), xyz: [], tris: [], results: [], faces: 0, skippedFaces: 0, missing: 0 };
      maps.push(cur);
    } else if (!cur) return null;
    else if (section === '[data]' && !cols) {
      const heads = line.split(',').map(resultColumn), at = (n) => heads.findIndex((h) => h.name === n);
      cols = { node: at('node number'), x: at('x'), y: at('y'), z: at('z'), rest: [] };
      if ([cols.node, cols.x, cols.y, cols.z].includes(-1)) return null;
      const units = heads[cols.x].unit;
      scale = units === null ? 1 : LENGTH_IN_METRES[units.toLowerCase()];
      if (!scale || heads[cols.y].unit !== units || heads[cols.z].unit !== units) return null;
      heads.forEach((h, k) => {
        if (![cols.node, cols.x, cols.y, cols.z].includes(k)) {
          cols.rest.push(k);
          const name = line.split(',')[k].trim().replace(/\s*\[.*\]$/, '');
          cur.results.push({ name, unit: h.unit, metric: ColourScales.metricOf(name, h.unit), values: [] });
        }
      });
      if (!cols.rest.length) return null;
    } else if (section === '[data]') {
      const r = line.split(',');
      cur.row.set(+r[cols.node], cur.xyz.length / 3);
      cur.xyz.push(resultNumber(r[cols.x]) * scale, resultNumber(r[cols.y]) * scale, resultNumber(r[cols.z]) * scale);
      let lacks = false;
      cols.rest.forEach((k, i) => {
        const v = resultNumber(r[k]);
        if (Number.isNaN(v)) lacks = true;
        cur.results[i].values.push(v);
      });
      if (lacks) cur.missing++;
    } else if (section === '[faces]') {
      cur.faces++;
      const ids = line.split(',').map((s) => cur.row.get(+s));
      if (ids.length < 3 || ids.some((k) => k === undefined || Number.isNaN(cur.xyz[k * 3] + cur.xyz[k * 3 + 1] + cur.xyz[k * 3 + 2]))) { cur.skippedFaces++; continue; }
      for (let i = 1; i + 1 < ids.length; i++) cur.tris.push(ids[0], ids[i], ids[i + 1]);
    }
  }
  const usable = maps.filter((m) => m.tris.length);
  if (!usable.length) return null;
  return { maps: usable.map(({ name, xyz, tris, results, faces, skippedFaces, missing }) => ({ name, faces, skippedFaces, missing,
    points: Float64Array.from(xyz), indices: Uint32Array.from(tris),
    results: results.map((r) => ({ ...r, values: Float32Array.from(r.values) })) })) };
}

// A map's positions for the GPU, in the model's units relative to its origin.
function cfdMapVertices(map, metresPerUnit, origin) {
  const pos = new Float32Array(map.points.length);
  for (let i = 0; i < pos.length; i++) pos[i] = map.points[i] / metresPerUnit - origin[i % 3];
  return pos;
}

// A result's values for the GPU: missing ones become a huge number, which hides the faces around them.
const CFD_MAP_MISSING = 1e30;
function cfdMapValues(result) {
  return result.values.map((v) => (Number.isNaN(v) ? CFD_MAP_MISSING : v));
}

// Finds the triangle under a point, using a grid over the map in plan.
// -> { a, b, c (rows of points), wa, wb, wc (weights) }, the one nearest z where several overlap.
function cfdMapFind(map, x, y, z) {
  const P = map.points, T = map.indices, n = T.length / 3;
  if (!map.grid) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let i = 0; i < T.length; i++) {
      const k = T[i] * 3;
      x0 = Math.min(x0, P[k]); x1 = Math.max(x1, P[k]); y0 = Math.min(y0, P[k + 1]); y1 = Math.max(y1, P[k + 1]);
    }
    const w = Math.max(x1 - x0, 1e-9), h = Math.max(y1 - y0, 1e-9), size = Math.sqrt((w * h) / Math.max(n, 1));
    const nx = Math.min(4096, Math.max(1, Math.ceil(w / size))), ny = Math.min(4096, Math.max(1, Math.ceil(h / size)));
    const ix = (v) => Math.min(nx - 1, Math.max(0, Math.floor(((v - x0) / w) * nx))), iy = (v) => Math.min(ny - 1, Math.max(0, Math.floor(((v - y0) / h) * ny)));
    const start = new Uint32Array(nx * ny + 1);
    const each = (t, fn) => {
      const a = T[t * 3] * 3, b = T[t * 3 + 1] * 3, c = T[t * 3 + 2] * 3;
      const i0 = ix(Math.min(P[a], P[b], P[c])), i1 = ix(Math.max(P[a], P[b], P[c])), j0 = iy(Math.min(P[a + 1], P[b + 1], P[c + 1])), j1 = iy(Math.max(P[a + 1], P[b + 1], P[c + 1]));
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) fn(i + j * nx);
    };
    for (let t = 0; t < n; t++) each(t, (c) => { start[c + 1]++; });
    for (let c = 0; c < nx * ny; c++) start[c + 1] += start[c];
    const fill = start.slice(), items = new Uint32Array(start[nx * ny]);
    for (let t = 0; t < n; t++) each(t, (c) => { items[fill[c]++] = t; });
    map.grid = { x0, y0, x1, y1, nx, ny, ix, iy, start, items };
  }
  const G = map.grid;
  if (x < G.x0 || x > G.x1 || y < G.y0 || y > G.y1) return null;
  const c = G.ix(x) + G.iy(y) * G.nx, E = 1e-4;
  let best = null, bestGap = Infinity;
  for (let i = G.start[c]; i < G.start[c + 1]; i++) {
    const t = G.items[i], a = T[t * 3], b = T[t * 3 + 1], d = T[t * 3 + 2];
    const ax = P[a * 3], ay = P[a * 3 + 1], bx = P[b * 3], by = P[b * 3 + 1], dx = P[d * 3], dy = P[d * 3 + 1];
    const det = (by - dy) * (ax - dx) + (dx - bx) * (ay - dy);
    if (!det) continue;
    const wa = ((by - dy) * (x - dx) + (dx - bx) * (y - dy)) / det, wb = ((dy - ay) * (x - dx) + (ax - dx) * (y - dy)) / det, wc = 1 - wa - wb;
    if (wa < -E || wb < -E || wc < -E) continue;
    const gap = Math.abs(wa * P[a * 3 + 2] + wb * P[b * 3 + 2] + wc * P[d * 3 + 2] - z);
    if (gap < bestGap) { bestGap = gap; best = { a, b, c: d, wa, wb, wc }; }
  }
  return best;
}

// A result's value at a place from cfdMapFind; NaN if a corner lacks it.
const cfdMapValueAt = (result, h) => result.values[h.a] * h.wa + result.values[h.b] * h.wb + result.values[h.c] * h.wc;

const RESULT_PARSERS = [
  { id: 'cfdStreamlines', name: 'CFD streamlines', extensions: ['.csv'], parse: parseCfdStreamlines,
    describe({ streamlines }) {
      const count = (n, what) => `${n.toLocaleString()} ${what}${n === 1 ? '' : 's'}`;
      return [count(streamlines.length, 'streamline'), count(streamlines.reduce((s, l) => s + l.polylines.length, 0), 'polyline'),
        count(streamlines.reduce((s, l) => s + l.segments, 0), 'segment')].join(' · ');
    } },
  { id: 'cfdMap', name: 'CFD map', extensions: ['.csv'], parse: parseCfdMap,
    describe({ maps }) {
      const count = (n, what) => `${n.toLocaleString()} ${what}${n === 1 ? '' : 's'}`, sum = (f) => maps.reduce((s, m) => s + f(m), 0);
      const missing = sum((m) => m.missing), skipped = sum((m) => m.skippedFaces);
      return [count(maps.length, 'map'), count(sum((m) => m.results.length), 'result'), count(sum((m) => m.faces), 'face'),
        ...(missing ? [`${count(missing, 'node')} without some results`] : []), ...(skipped ? [`${count(skipped, 'face')} not usable`] : [])].join(' · ');
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

// Line-list vertices for streamlines, in the model's units relative to its origin, with each
// segment the colour (colourOf, velocity -> [r, g, b]) of its start node. ranges: for each streamline, a { first, count } in vertices
// for each of its polylines.
function streamlineVertices(streamlines, metresPerUnit, origin, colourOf) {
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
        const c = colourOf(velocity[i]);
        col.set(c, at * 4); col[at * 4 + 3] = 255;
        col.set(c, at * 4 + 4); col[at * 4 + 7] = 255;
      }
      parts.push({ first, count: at - first });
    }
    ranges.push(parts);
  }
  return { pos, col, ranges };
}
