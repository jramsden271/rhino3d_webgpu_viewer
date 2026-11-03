// Checks the analysis meshes and sun exposure periods (src/mesh.js, src/exposure.js):  node tools/test-exposure.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', 'src', f), 'utf8');
const mulRM = (a, b) => {
  const o = new Float64Array(16);
  for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) { let s = 0; for (let k = 0; k < 4; k++) s += a[r * 4 + k] * b[k * 4 + c]; o[r * 4 + c] = s; }
  return o;
};
const { Meshes, exposureTimes, exposureSunDirs, exposureSurface, exposureLayerMeshes, exposurePointEstimate, exposureSummary, dayOfYear } = new Function('mulRM',
  `${read('sun.js')}\n${read('mesh.js')}\n${read('exposure.js')}\nreturn { Meshes, exposureTimes, exposureSunDirs, exposureSurface, exposureLayerMeshes, exposurePointEstimate, exposureSummary, dayOfYear };`)(mulRM);

const near = (a, b, tol = 1e-9) => Math.abs(a - b) <= tol;
// Each edge of a mesh, with how many triangles use it.
const edges = ({ idx }) => {
  const e = new Map();
  for (let t = 0; t < idx.length; t += 3) for (let k = 0; k < 3; k++) {
    const a = idx[t + k], b = idx[t + (k + 1) % 3], key = Math.min(a, b) + ',' + Math.max(a, b);
    e.set(key, (e.get(key) || 0) + 1);
  }
  return e;
};
const longest = ({ pos, idx }) => {
  let m = 0;
  for (let t = 0; t < idx.length; t++) {
    const a = idx[t] * 3, b = idx[t - (t % 3) + ((t % 3) + 1) % 3] * 3;
    m = Math.max(m, Math.hypot(pos[a] - pos[b], pos[a + 1] - pos[b + 1], pos[a + 2] - pos[b + 2]));
  }
  return m;
};
const boundary = (m) => [...edges(m).values()].filter((n) => n === 1).length;
// The length of the outline: the edges used by one triangle only.
const outline = (m) => [...edges(m)].filter(([, n]) => n === 1).reduce((s, [k]) => {
  const [a, b] = k.split(',').map((v) => v * 3), p = m.pos;
  return s + Math.hypot(p[a] - p[b], p[a + 1] - p[b + 1], p[a + 2] - p[b + 2]);
}, 0);

// A 10 x 1 sliver as two triangles, the way Rhino meshes a long strip.
const strip = { pos: [0, 0, 0, 10, 0, 0, 10, 1, 0, 0, 1, 0], idx: [0, 1, 2, 0, 2, 3] };
const r = Meshes.refine(strip, 0.5);
assert.ok(longest(r) <= 0.5 + 1e-12, 'no edge longer than asked');
assert.ok(near(Meshes.area(r), 10), 'the same area');
assert.ok([...edges(r).values()].every((n) => n <= 2), 'every edge between at most two triangles');
assert.ok(near(outline(r), 22), `no cracks inside: the outline is the strip's (${outline(r)})`);
assert.ok(Meshes.areaNormal(r)[2] > 0, 'still facing up');
// The estimate is for well-shaped faces; a strip this thin gets about three times as many.
const sq = Meshes.refine({ pos: [0, 0, 0, 10, 0, 0, 10, 10, 0, 0, 10, 0], idx: [0, 1, 2, 0, 2, 3] }, 0.5);
assert.ok(Math.abs(sq.pos.length / 3 / exposurePointEstimate(100, 0.5) - 1) < 0.2, 'the estimate is about right');
assert.ok(r.pos.length / 3 < exposurePointEstimate(10, 0.5) * 4);
assert.strictEqual(Meshes.refine(strip, 0.01, 1000), null, 'too many points');
assert.strictEqual(Meshes.refine(strip, 20).idx.length, 6, 'short edges stay');

// Sorting the vertices changes their order, not the mesh.
const sorted = Meshes.sortVertices({ ...Meshes.splitNormals(r) });
assert.ok(near(Meshes.area(sorted), 10) && near(outline(sorted), 22), 'the same mesh, sorted');
assert.strictEqual(sorted.nrm.length, sorted.pos.length);

// Welding joins faces that meet, so their normals are shared.
const two = Meshes.join([{ pos: [0, 0, 0, 1, 0, 0, 0, 1, 0], idx: [0, 1, 2] }, { pos: [1, 0, 0, 1, 1, 0, 0, 1, 0], idx: [0, 1, 2] }]);
const w = Meshes.weld(two, 1e-6);
assert.strictEqual(w.pos.length / 3, 4);
assert.strictEqual(boundary(w), 4);
const sn = Meshes.splitNormals(w);
assert.strictEqual(sn.pos.length / 3, 4, 'a flat mesh keeps its vertices');
for (let v = 0; v < sn.nrm.length; v += 3) assert.ok(near(sn.nrm[v + 2], 1, 1e-6), 'normals up');

// Periods: both ends included, grips in either order.
const t = exposureTimes({ days: [80, 80], hours: [16, 14], step: 60 });
assert.deepStrictEqual(t.map((x) => x.hour), [14, 15, 16]);
assert.strictEqual(exposureTimes({ days: [81, 80], hours: [10, 12], step: 10 }).length, 2 * 13);
assert.strictEqual(exposureTimes({ days: [80, 80], hours: [12, 12], step: 5 }).length, 1, 'a single time');
const london = { lat: 51.5, lon: -0.13, utcOffset: 0, year: 2017, north: 90 };
const dirs = exposureSunDirs(exposureTimes({ days: [dayOfYear(2017, 3, 21)], hours: [0, 24], step: 60 }), london);
assert.ok(dirs.length >= 11 && dirs.length <= 13, `the sun is up about 12 hours at the equinox (${dirs.length})`);
assert.ok(dirs.every((d) => d[2] > 0));

// A layer's objects: a mesh upside down is turned up, flip turns everything down, and a block
// instance's geometry comes with its transform.
const I = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const down = { pos: Float32Array.from([0, 0, 0, 0, 4, 0, 4, 0, 0]), idx: Uint32Array.from([0, 1, 2]) };
const model = {
  defs: new Map([['blk', { entries: [{ k: 'mesh', parts: [down] }] }]]),
  objects: [
    { k: 'mesh', ai: { layer: 1 }, parts: [down], xf: null },
    { k: 'inst', ai: { layer: 1 }, idef: 'blk', xf: Float64Array.from([1, 0, 0, 10, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]) },
    { k: 'mesh', ai: { layer: 2 }, parts: [down], xf: null },
  ],
};
const objs = exposureLayerMeshes(model, 1, () => false);
assert.strictEqual(objs.length, 2);
const s = exposureSurface(objs, { spacing: 1, flip: false, lift: 0.1, weldTol: 1e-6 });
assert.ok(near(s.area, 16), 'both triangles');
assert.ok(Math.max(...s.pos.filter((_, i) => i % 3 === 0)) === 14, 'the block instance moved');
for (let v = 0; v < s.nrm.length; v += 3) assert.ok(near(s.nrm[v + 2], 1, 1e-6), 'turned to face up');
assert.ok(near(s.shown[2], 0.1, 1e-6), 'drawn in front');
const f = exposureSurface(objs, { spacing: 1, flip: true, lift: 0.1, weldTol: 1e-6 });
assert.ok(near(f.nrm[2], -1, 1e-6), 'flipped');
assert.strictEqual(exposureLayerMeshes(model, 1, (i) => i === 0).length, 1, 'hidden objects left out');
assert.strictEqual(exposureSurface([], { spacing: 1, flip: false, lift: 0, weldTol: 1e-6 }).error, 'empty');
assert.strictEqual(exposureSurface(objs, { spacing: 0.001, flip: false, lift: 0, weldTol: 1e-6 }).error, 'tooMany');

// A closed box keeps its sides (outwards), however its top and bottom add up.
const cube = { pos: Float32Array.from([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 0, 0, 1, 1, 0, 1, 1, 1, 1, 0, 1, 1]),
  idx: Uint32Array.from([0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7]) };
const c = exposureSurface([[cube]], { spacing: 2, flip: false, lift: 0, weldTol: 1e-6 });
// Each face keeps its own normal at the box's sharp edges: all six directions, each outwards.
const dirs6 = new Set();
for (let v = 0; v < c.nrm.length; v += 3) {
  const n3 = [c.nrm[v], c.nrm[v + 1], c.nrm[v + 2]], k = n3.findIndex((x) => Math.abs(x) > 0.999);
  assert.ok(k >= 0, 'face normals, not averaged at the edges');
  assert.ok((n3[k] > 0) === (c.pos[v + k] > 0.5), 'outwards');
  dirs6.add(k * 2 + (n3[k] > 0));
}
assert.strictEqual(dirs6.size, 6);

// Ground/roof only: the box's top, not its walls or bottom; with flip, the top seen from below.
const roof = exposureSurface([[cube]], { spacing: 2, flip: false, upOnly: true, lift: 0, weldTol: 1e-6 });
assert.ok(near(roof.area, 1) && [...roof.nrm].every((v, i) => i % 3 !== 2 || near(v, 1, 1e-6)), 'only the top, facing up');
const under = exposureSurface([[cube]], { spacing: 2, flip: true, upOnly: true, lift: 0, weldTol: 1e-6 });
assert.ok(near(under.area, 1) && near(under.nrm[2], -1, 1e-6), 'the top from below');
const wall = { pos: Float32Array.from([0, 0, 0, 1, 0, 0, 1, 0, 1]), idx: Uint32Array.from([0, 1, 2]) };
assert.strictEqual(exposureSurface([[wall]], { spacing: 2, flip: false, upOnly: true, lift: 0, weldTol: 1e-6 }).error, 'noneUp');

// Summary: weighted by area, from the points' percentages.
const fine = exposureSurface([[cube]], { spacing: 0.1, flip: false, upOnly: true, lift: 0, weldTol: 1e-6 });
const eastHalf = Float32Array.from({ length: fine.pos.length / 3 }, (_, i) => (fine.pos[i * 3] > 0.5 ? 100 : 0));
const half = exposureSummary(fine, eastHalf);
assert.ok(near(half.area, 1, 1e-6) && Math.abs(half.exposed - 0.5) < 0.05, `half in sun (${half.exposed})`);
assert.ok(near(exposureSummary(fine, new Float32Array(fine.pos.length / 3).fill(100)).exposed, 1, 1e-6), 'all in sun');

console.log('exposure: all checks passed');
