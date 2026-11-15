// Wind (CFD-lite): the wind round the model, from the lattice Boltzmann solver in lbm.js, shown as a
// map of the wind near the ground (PEDESTRIAN m above whatever is below: the ground, or a roof).
//
// The grid is a box lined up with the wind, round what is shown, with room upwind, downwind, to the
// sides and above in proportion to the tallest thing in the model. The model goes in as cells
// (windVoxels): those its surfaces pass through, and those inside its closed objects, so canopies
// and arcades stay open underneath. Vegetation is left out (it is porous, which the solver does not
// model yet). "Show what the wind sees" draws the solid cells.
//
// The wind blowing in rises with height as over a suburb or town (a power law). The solver works in
// its own units, so the results are the speed as a share of the wind at the same height and place
// along the grid over the empty grid, worked out alongside (the speed ratio: below 1 sheltered,
// above 1 where buildings speed it up), and
// the speed in m/s comes from the wind's speed at 10 m: from the weather file at the Date and Time
// widgets' date and time, or set by hand. Changing the speed needs no new run; changing the direction
// or the model does.

import { WindSolver } from './lbm.js';
import { sunVector } from './sun.js';
import { ColourScales } from './colourscales.js';

export const WIND_PEDESTRIAN = 1.5;   // m above the surface, where the results are read
// The site's terrain: how fast the wind rises with height (power law exponent alpha) and the height it
// is free of the ground (delta, m), as ASHRAE Fundamentals gives them. The wind blows in over this.
export const WIND_TERRAINS = [
  { id: 'open', label: 'Open country', alpha: 0.14, delta: 270, title: 'Open, flat ground with few obstructions: fields, airports, the coast' },
  { id: 'suburban', label: 'Suburban', alpha: 0.22, delta: 370, title: 'Towns, suburbs and wooded country: obstructions the size of houses, close together' },
  { id: 'urban', label: 'City centre', alpha: 0.33, delta: 460, title: 'Large city centres: many tall buildings close together' },
];
// Where the weather file's wind is measured: 10 m up in open country (as at an airport).
const WIND_MET = { z: 10, alpha: 0.14, delta: 270 };
const terrainOf = (id) => WIND_TERRAINS.find((t) => t.id === id) || WIND_TERRAINS[1];
const U_TOP = 0.1;                    // the inlet's speed at the top of the grid, in cells per step
const NICE_CELLS = [0.5, 0.75, 1, 1.25, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10, 12, 15, 20, 25, 30, 40, 50];
export const WIND_RESOLUTIONS = [
  { id: 'coarse', label: 'Coarse', cells: 500e3, title: 'About half a million cells: quick, for a first look' },
  { id: 'medium', label: 'Medium', cells: 1.5e6, title: 'About 1.5 million cells' },
  { id: 'fine', label: 'Fine', cells: 4e6, title: 'About 4 million cells: slower, and needs a capable graphics card' },
];
const COMPASS16 = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
export const compass16 = (deg) => COMPASS16[Math.round((((deg % 360) + 360) % 360) / 22.5) % 16];

// The grid for the wind from `from` (compass degrees: where it blows from) round the box mn, mx
// (model units; mpu metres per unit), of about `cells` cells (fewer if maxCells says so). x runs
// downwind, y to its left, z up from the bottom of the box. Gives { nx, ny, nz, dx (m), cell (model
// units), dir, left (unit model xy), s0, t0 (where the grid starts along dir and left, model units),
// floor (model z of the grid's bottom), zTop (m), height (m, of the box) }.
export function windGrid({ mn, mx, from, north, mpu, cells, maxCells = Infinity }) {
  const d = sunVector((from + 180) % 360, 0, north), dir = [d[0], d[1]], left = [-dir[1], dir[0]];
  const along = [], across = [];
  for (const x of [mn[0], mx[0]]) for (const y of [mn[1], mx[1]]) { along.push(x * dir[0] + y * dir[1]); across.push(x * left[0] + y * left[1]); }
  const a0 = Math.min(...along), a1 = Math.max(...along), b0 = Math.min(...across), b1 = Math.max(...across);
  const height = Math.max(5, (mx[2] - mn[2]) * mpu);
  // Room round the model: 3 heights upwind, 6 downwind, 2 to each side, and the top 2 heights above
  // it (at least 20 m, 40 m downwind, 30 m above), as is usual for wind round buildings, kept
  // smaller where the model is much larger than its height.
  const up = Math.max(3 * height, 20), down = Math.max(6 * height, 40), side = Math.max(2 * height, 20), zTop = height + Math.max(2 * height, 30);
  const Lx = (a1 - a0) * mpu + up + down, Ly = (b1 - b0) * mpu + 2 * side;
  const want = Math.min(cells, maxCells);
  let dx = Math.cbrt((Lx * Ly * zTop) / want);
  dx = NICE_CELLS.find((c) => c >= dx) || Math.ceil(dx);
  let nx, ny, nz;
  for (;;) {
    nx = Math.ceil(Lx / dx); ny = Math.ceil(Ly / dx); nz = Math.max(12, Math.ceil(zTop / dx));
    if (nx * ny * nz <= maxCells) break;
    dx = NICE_CELLS.find((c) => c > dx) || dx * 1.25;
  }
  const cell = dx / mpu;
  return { nx, ny, nz, dx, cell, dir, left, s0: a0 - up / mpu, t0: b0 - side / mpu, floor: mn[2], zTop: nz * dx, height };
}

// The inlet's speed at each cell's height (cells per step) over the terrain (an id of WIND_TERRAINS),
// at 10 m, and at WIND_PEDESTRIAN.
export function windInlet(nz, dx, terrain) {
  const { alpha } = terrainOf(terrain);
  const top = nz * dx, inlet = new Float32Array(nz), at = (z) => U_TOP * Math.pow(Math.max(z, 1) / top, alpha);
  for (let k = 0; k < nz; k++) inlet[k] = at((k + 0.5) * dx);
  return { inlet, u10: at(10), uRef: at(WIND_PEDESTRIAN) };
}
// The wind in the open on the site at WIND_PEDESTRIAN, as a share of the weather file's (10 m up in
// open country): up from the weather station to where the ground no longer slows it, and back down
// over the site's terrain (ASHRAE Fundamentals, chapter 24).
export function windOpen(terrain) {
  const t = terrainOf(terrain);
  return Math.pow(WIND_MET.delta / WIND_MET.z, WIND_MET.alpha) * Math.pow(WIND_PEDESTRIAN / t.delta, t.alpha);
}

// The model in the grid: which cells are solid, from its meshes ([{ pos, idx, xf (row-major 4 × 4,
// or null) }], model units). Two passes:
//  - every cell a triangle passes through is solid (sampled at most half a cell apart), so a thin
//    roof or a canopy is a slab a cell thick, open underneath;
//  - closed volumes are filled: up each column (through its middle), from where it enters an object
//    (a face turned down) to where it leaves (a face turned up). Faces that do not pair up (an open
//    surface, a ground plane) add nothing more.
// Each column's results are read WIND_PEDESTRIAN above where one would stand: the top of the lowest
// stack of solid cells (the ground, or a roof), at the height of the surface found there.
// Gives { solid (bits, one per cell, x fastest, then y, then z), level (Float32Array per column:
// cells above the floor to read at), stand (model z of that surface per column, NaN where nothing is
// solid), count (solid cells) }. tick: called now and then (await it to let the page breathe).
export async function windVoxels(G, meshes, mpu, tick = null) {
  const { nx, ny, nz, cell, dir, left, s0, t0, floor } = G, nxy = nx * ny, n = nxy * nz;
  const solid = new Uint32Array(Math.ceil(n / 32)), cols = new Array(nxy);
  const set = (i, j, k) => { if (i >= 0 && j >= 0 && k >= 0 && i < nx && j < ny && k < nz) { const c = i + nx * j + nxy * k; solid[c >>> 5] |= 1 << (c & 31); } };
  // Column middles, nudged off the exact half so that a ray seldom runs along a shared edge.
  const E1 = 0.5 + 1.7e-5, E2 = 0.5 + 3.1e-5;
  let done = 0;
  for (const m of meshes) {
    const P = m.pos, X = m.xf, nv = P.length / 3, gx = new Float32Array(nv), gy = new Float32Array(nv), gz = new Float32Array(nv);
    for (let v = 0; v < nv; v++) {
      let x = P[v * 3], y = P[v * 3 + 1], z = P[v * 3 + 2];
      if (X) {
        const w = X[12] * x + X[13] * y + X[14] * z + X[15] || 1;
        [x, y, z] = [(X[0] * x + X[1] * y + X[2] * z + X[3]) / w, (X[4] * x + X[5] * y + X[6] * z + X[7]) / w, (X[8] * x + X[9] * y + X[10] * z + X[11]) / w];
      }
      gx[v] = (x * dir[0] + y * dir[1] - s0) / cell; gy[v] = (x * left[0] + y * left[1] - t0) / cell; gz[v] = (z - floor) / cell;
    }
    const I = m.idx;
    for (let t = 0; t < I.length; t += 3) {
      const a = I[t], b = I[t + 1], c = I[t + 2];
      const ax = gx[a], ay = gy[a], az = gz[a], bx = gx[b], by = gy[b], bz = gz[b], cx = gx[c], cy = gy[c], cz = gz[c];
      // Surface cells.
      const len = Math.max(Math.hypot(bx - ax, by - ay, bz - az), Math.hypot(cx - ax, cy - ay, cz - az), Math.hypot(cx - bx, cy - by, cz - bz));
      const k = Math.min(4096, Math.max(1, Math.ceil(len * 2)));
      for (let u = 0; u <= k; u++) for (let v = 0; v <= k - u; v++) {
        const p = u / k, q = v / k;
        set(Math.floor(ax + (bx - ax) * p + (cx - ax) * q), Math.floor(ay + (by - ay) * p + (cy - ay) * q), Math.floor(az + (bz - az) * p + (cz - az) * q));
      }
      // Where columns cross it: its height there, and whether it faces up.
      const area = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
      if (Math.abs(area) > 1e-12) {
        const i0 = Math.max(0, Math.ceil(Math.min(ax, bx, cx) - E1)), i1 = Math.min(nx - 1, Math.floor(Math.max(ax, bx, cx) - E1));
        const j0 = Math.max(0, Math.ceil(Math.min(ay, by, cy) - E2)), j1 = Math.min(ny - 1, Math.floor(Math.max(ay, by, cy) - E2));
        for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
          const px = i + E1, py = j + E2;
          const w0 = ((bx - px) * (cy - py) - (by - py) * (cx - px)) / area, w1 = ((cx - px) * (ay - py) - (cy - py) * (ax - px)) / area, w2 = 1 - w0 - w1;
          if (w0 < 0 || w1 < 0 || w2 < 0) continue;
          (cols[i + nx * j] ||= []).push(w0 * az + w1 * bz + w2 * cz, area > 0 ? 1 : -1);
        }
      }
      if (tick && ++done % 20000 === 0) await tick();
    }
  }
  // Closed volumes, then where each column's results are read.
  const level = new Float32Array(nxy), stand = new Float32Array(nxy).fill(NaN), stack = new Int32Array(nxy * 2).fill(-1);
  const isSolid = (c) => (solid[c >>> 5] >>> (c & 31)) & 1;
  for (let col = 0; col < nxy; col++) {
    const L = cols[col], i = col % nx, j = (col - i) / nx;
    let hits = [];
    if (L) {
      for (let h = 0; h < L.length; h += 2) hits.push([L[h], L[h + 1]]);
      // Upwards; where two meet (an object standing on another), leaving before entering.
      hits.sort((p, q) => (Math.abs(p[0] - q[0]) > 1e-4 ? p[0] - q[0] : q[1] - p[1]));
      let enter = null;
      for (const [z, up] of hits) {
        if (up < 0 && enter === null) enter = z;
        else if (up > 0 && enter !== null) {
          for (let kk = Math.max(0, Math.ceil(enter - 0.5)); kk < nz && kk + 0.5 < z; kk++) set(i, j, kk);
          enter = null;
        }
      }
    }
    // The lowest stack of solid cells, and the surface at its top.
    let k0 = 0;
    while (k0 < nz && !isSolid(col + nxy * k0)) k0++;
    if (k0 === nz) { level[col] = WIND_PEDESTRIAN / G.dx; continue; }
    let k1 = k0;
    while (k1 < nz && isSolid(col + nxy * k1)) k1++;
    let top = NaN;
    for (let h = hits.length - 1; h >= 0; h--) if (hits[h][0] >= k0 - 0.01 && hits[h][0] <= k1 + 0.01) { top = hits[h][0]; break; }
    stack[col * 2] = k0; stack[col * 2 + 1] = k1;
    stand[col] = top;
  }
  // A column whose middle misses the surface though the surface passes through its cells (along an
  // edge) takes the surface's height from the columns beside it that meet it within its cells, or,
  // with none, the top of its cells.
  const exact = Float32Array.from(stand);
  for (let col = 0; col < nxy; col++) {
    if (stack[col * 2] < 0) continue;
    const k0 = stack[col * 2], k1 = stack[col * 2 + 1], i = col % nx, j = (col - i) / nx;
    let top = exact[col];
    if (!Number.isFinite(top)) {
      // The highest, since the cells stand up to the top surface: beside a wall, the roof's.
      top = -Infinity;
      for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
        const ii = i + di, jj = j + dj, v = exact[ii + nx * jj];
        if (ii >= 0 && ii < nx && jj >= 0 && jj < ny && v >= k0 - 0.01 && v <= k1 + 0.01) top = Math.max(top, v);
      }
      if (top === -Infinity) top = k1;
    }
    stand[col] = floor + top * cell;
    level[col] = top + WIND_PEDESTRIAN / G.dx;
  }
  let count = 0;
  for (let w = 0; w < solid.length; w++) { let x = solid[w]; while (x) { x &= x - 1; count++; } }
  return { solid, level, stand, count };
}

// The outside of the solid cells, for showing what the solver sees: a square for each face between a
// solid cell and air (inside the grid), in model space, translucent, the tops paler than the sides.
// Gives { pos (Float32Array), col (Uint8Array rgba), idx (Uint32Array), faces }, or null for more
// than maxFaces faces.
export function windVoxelShell(G, solid, maxFaces = 3e6) {
  const { nx, ny, nz, cell, dir, left, s0, t0, floor } = G, nxy = nx * ny;
  const at = (i, j, k) => i >= 0 && j >= 0 && k >= 0 && i < nx && j < ny && k < nz && ((solid[(i + nx * j + nxy * k) >>> 5] >>> ((i + nx * j + nxy * k) & 31)) & 1);
  const faces = [];
  for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    if (!at(i, j, k)) continue;
    // Kinds of face: 0 top, 1 bottom, 2 and 3 the ends (+x, -x), 4 and 5 the sides (+y, -y).
    if (k + 1 < nz && !at(i, j, k + 1)) faces.push(i, j, k, 0);
    if (k > 0 && !at(i, j, k - 1)) faces.push(i, j, k, 1);
    if (i + 1 < nx && !at(i + 1, j, k)) faces.push(i, j, k, 2);
    if (i > 0 && !at(i - 1, j, k)) faces.push(i, j, k, 3);
    if (j + 1 < ny && !at(i, j + 1, k)) faces.push(i, j, k, 4);
    if (j > 0 && !at(i, j - 1, k)) faces.push(i, j, k, 5);
    if (faces.length / 4 > maxFaces) return null;
  }
  const nf = faces.length / 4, pos = new Float32Array(nf * 12), col = new Uint8Array(nf * 16), idx = new Uint32Array(nf * 6);
  // The corners of each kind of face, in cell offsets.
  const CORNERS = [
    [[0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]], [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0]],
    [[1, 0, 0], [1, 1, 0], [1, 1, 1], [1, 0, 1]], [[0, 0, 0], [0, 1, 0], [0, 1, 1], [0, 0, 1]],
    [[0, 1, 0], [1, 1, 0], [1, 1, 1], [0, 1, 1]], [[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]],
  ];
  const SHADE = [[214, 220, 230, 45], [120, 128, 140, 110], [160, 170, 186, 120], [150, 160, 176, 120], [170, 180, 196, 120], [140, 150, 166, 120]];
  for (let f = 0; f < nf; f++) {
    const i = faces[f * 4], j = faces[f * 4 + 1], k = faces[f * 4 + 2], kind = faces[f * 4 + 3];
    CORNERS[kind].forEach(([a, b, c], v) => {
      const s = s0 + (i + a) * cell, t = t0 + (j + b) * cell;
      pos.set([dir[0] * s + left[0] * t, dir[1] * s + left[1] * t, floor + (k + c) * cell], (f * 4 + v) * 3);
      col.set(SHADE[kind], (f * 4 + v) * 4);
    });
    idx.set([f * 4, f * 4 + 1, f * 4 + 2, f * 4, f * 4 + 2, f * 4 + 3], f * 6);
  }
  return { pos, col, idx, faces: nf };
}

// Where the map is drawn in each column (model z): on the top surface, or, where there is none, on
// the floor of the grid within the model's extent (mn, mx), so a model of buildings alone, with no
// ground, still shows the wind round them; NaN beyond that.
export function windMapTops(G, tops, mn, mx) {
  const { nx, ny, cell, dir, left, s0, t0 } = G, out = new Float32Array(nx * ny);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const s = s0 + (i + 0.5) * cell, t = t0 + (j + 0.5) * cell, c = i + nx * j;
    const x = dir[0] * s + left[0] * t, y = dir[1] * s + left[1] * t;
    out[c] = Number.isFinite(tops[c]) ? tops[c] : x >= mn[0] && x <= mx[0] && y >= mn[1] && y <= mx[1] ? G.floor : NaN;
  }
  return out;
}

// The map the results are drawn on: a point on the surface in each column with one (lifted a little),
// joined into triangles except across steps (a building's edge). tops: windMapTops.
export function windMapMesh(G, tops, lift) {
  const { nx, ny, cell, dir, left, s0, t0 } = G, pos = new Float32Array(nx * ny * 3), idx = [];
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const s = s0 + (i + 0.5) * cell, t = t0 + (j + 0.5) * cell, c = i + nx * j, z = tops[c];
    pos.set([dir[0] * s + left[0] * t, dir[1] * s + left[1] * t, (Number.isFinite(z) ? z : G.floor) + lift], c * 3);
  }
  const ok = (c) => Number.isFinite(tops[c]), step = 1.5 * cell;
  for (let j = 0; j < ny - 1; j++) for (let i = 0; i < nx - 1; i++) {
    const a = i + nx * j, b = a + 1, c = a + nx, d = c + 1;
    if (!ok(a) || !ok(b) || !ok(c) || !ok(d)) continue;
    const zs = [tops[a], tops[b], tops[c], tops[d]];
    if (Math.max(...zs) - Math.min(...zs) > step) continue;
    idx.push(a, b, d, a, d, c);
  }
  return { pos, idx: Uint32Array.from(idx) };
}

// The widget. app gives what it needs from the viewer (see main.js).
export function createWindTool(app) {
  const $ = app.$;
  const W = {
    panel: false, on: true, source: 'epw', dir: 225, speed: 5, res: 'coarse', terrain: 'suburban', show: 'ratio', solids: false,
    // The latest run: { key, from, terrain, grid, voxels (windVoxels), shell (windVoxelShell, false if too
    // big, null not made yet), mapTops, ratio (Float32Array per column, or null), status, progress, done }
    run: null, token: 0, solver: null, ref: null,
  };

  // The wind blowing: { from (deg), speed (m/s), epw: true if from the weather file }, or null.
  // Without a weather file, the wind set by hand.
  const fromEpw = () => W.source === 'epw' && app.hasEpw();
  function wind() {
    if (fromEpw()) {
      const w = app.weatherNow();
      if (w && w.windDirection != null && w.windSpeed != null) return { from: w.windDirection, speed: w.windSpeed, epw: true };
      return null;
    }
    return { from: W.dir, speed: W.speed, epw: false };
  }
  // What a run depends on.
  const runKey = (from) => [Math.round(from), W.res, W.terrain, app.modelKey(), app.north()].join('|');

  function stale() {
    const r = W.run, w = wind();
    return !!(r && r.done && w && r.key !== runKey(w.from));
  }

  async function run() {
    const w = wind(), model = app.model, renderer = app.renderer;
    if (!w || !model || !renderer) return;
    const token = ++W.token, t0 = performance.now(), mpu = app.mpu(), [mn, mx] = app.visibleBounds();
    const res = WIND_RESOLUTIONS.find((r) => r.id === W.res) || WIND_RESOLUTIONS[0];
    W.solver ??= new WindSolver(renderer.device);
    const G = windGrid({ mn, mx, from: w.from, north: app.north(), mpu, cells: res.cells, maxCells: WindSolver.maxCells(renderer.device) });
    W.ref ??= new WindSolver(renderer.device);
    W.run = { key: runKey(w.from), from: w.from, terrain: W.terrain, grid: G, voxels: null, shell: null, ratio: null, status: 'Reading the model…', progress: 0, done: false };
    renderer.setWindShell(null);
    sync();
    const tick = () => new Promise((r) => setTimeout(r, 0));
    await tick();
    const vox = await windVoxels(G, app.windMeshes(), mpu, tick);
    if (token !== W.token) return;
    W.run.voxels = vox;
    syncShell();
    const { inlet, u10 } = windInlet(G.nz, G.dx, W.terrain);
    W.solver.setup({ nx: G.nx, ny: G.ny, nz: G.nz, solid: vox.solid, inlet });
    // The reference: the same wind over the empty grid (a slice of it a few cells wide, its sides
    // joined round). The wind near the ground drifts as it crosses the grid and as the run goes on
    // (the faster wind above mixes down), so each point is compared with the open wind at the same
    // place along the grid and the same moment, which the drift cancels out of.
    const RY = 4;
    W.ref.setup({ nx: G.nx, ny: RY, nz: G.nz, solid: new Uint32Array(Math.ceil((G.nx * RY * G.nz) / 32)), inlet, periodicY: true });
    const refLevel = new Float32Array(G.nx * RY).fill(WIND_PEDESTRIAN / G.dx);
    W.run.mapTops = windMapTops(G, vox.stand, mn, mx);
    const mesh = windMapMesh(G, W.run.mapTops, 0.05 / mpu);
    renderer.setWindMap(mesh.pos, mesh.idx, null);
    // Steps: the wind crosses the grid once to settle (at the speed at 10 m), then once more while
    // the average is taken.
    const cross = Math.ceil(G.nx / u10), warm = Math.min(Math.max(cross, 1500), 30000), total = warm + Math.min(Math.max(cross, 1500), 30000);
    let done = 0, batch = 4, lastShown = 0;
    const show = async (average) => {
      const v = await W.solver.level(vox.level, average), ref = await W.ref.level(refLevel, average);
      if (token !== W.token) return;
      for (let i = 0; i < v.length; i++) v[i] /= Math.max(ref[G.nx + (i % G.nx)], 1e-6);
      W.run.ratio = v;
      W.run.average = average;
      recolour();
    };
    W.run.status = 'Calculating…';
    while (done < total) {
      const tb = performance.now(), n = Math.min(batch, total - done), average = done >= warm;
      W.ref.run(n, { average, every: 5 });
      await W.solver.run(n, { average, every: 5 });
      if (token !== W.token) return;
      done += n;
      // Batches of about 30 ms, so the view keeps moving.
      const ms = performance.now() - tb;
      batch = Math.max(1, Math.min(400, Math.round(batch * Math.min(2, 30 / Math.max(ms, 1)))));
      W.run.progress = done / total;
      if (performance.now() - lastShown > 500) { lastShown = performance.now(); await show(done > warm + 200); if (token !== W.token) return; }
      syncProgress();
    }
    await show(true);
    if (token !== W.token) return;
    const secs = (performance.now() - t0) / 1000;
    Object.assign(W.run, { progress: null, done: true,
      status: `${G.nx} × ${G.ny} × ${G.nz} cells of ${G.dx} m · ${total.toLocaleString()} steps · ${secs < 10 ? secs.toFixed(1) : Math.round(secs)} s` });
    sync();
  }

  function stop() {
    if (!W.run || W.run.done) return;
    W.token++;
    Object.assign(W.run, { progress: null, done: true, status: 'Stopped: the results are as far as it got.', stopped: true });
    sync();
  }

  // A new model: nothing shown.
  function reset() {
    W.token++;
    W.run = null;
    W.solver?.destroy();
    W.ref?.destroy();
    app.renderer?.setWindMap(null);
    app.renderer?.setWindShell(null);
    sync();
  }

  // What the solver sees: the solid cells' outside, while asked for.
  function syncShell() {
    const r = W.run, renderer = app.renderer;
    if (!renderer) return;
    const want = W.solids && r?.voxels;
    if (want && r.shell === null) r.shell = windVoxelShell(r.grid, r.voxels.solid) || false;
    renderer.setWindShell(want && r.shell ? r.shell : null);
    app.redraw();
  }

  // The values shown: the speed ratio, or m/s; hidden where there is no surface.
  function recolour() {
    const r = W.run, renderer = app.renderer;
    if (!r?.ratio || !renderer) return;
    const w = wind(), mps = W.show === 'speed' && w, v = new Float32Array(r.ratio.length);
    const k = mps ? w.speed * windOpen(r.terrain) : 1;
    for (let i = 0; i < v.length; i++) v[i] = Number.isFinite(r.mapTops[i]) ? r.ratio[i] * k : 1e30;
    renderer.setWindMap(undefined, null, v, ColourScales.ramp(scale()));
    sync();
  }
  const scale = () => ColourScales.preferred(W.show === 'speed' && wind() ? 'windSpeed' : 'windRatio');

  function toggle() {
    W.panel = !W.panel;
    $('windPanel').hidden = !W.panel;
    app.setToolOpen(W.panel);
    sync();
  }

  function syncProgress() {
    const going = W.run?.progress != null;
    $('windBarBox').hidden = !going;
    $('windStop').hidden = !going;
    $('windRun').hidden = going;
    if (going) $('windBar').style.width = `${(W.run.progress * 100).toFixed(1)}%`;
  }

  function sync() {
    app.syncToolsButton();
    if (!W.panel) return;
    const w = wind(), r = W.run, model = app.model;
    $('windOn').checked = W.on;
    $('windSolids').checked = W.solids;
    app.setHtml($('windSolidsNote'), W.solids && W.run?.shell === false ? 'Too many cells to show: try a coarser resolution.' : W.solids && !W.run?.voxels ? 'Shown once the wind has been run.' : '');
    $('windSource').value = W.source;
    $('windCustom').hidden = fromEpw();
    $('windSource').querySelector('[value="epw"]').disabled = !app.hasEpw();
    if (!app.hasEpw()) $('windSource').value = 'custom';
    $('windDir').value = W.dir;
    $('windDirOut').value = `${compass16(W.dir)} · ${Math.round(W.dir)}°`;
    $('windSpeed').value = W.speed;
    $('windSpeedOut').value = `${W.speed.toFixed(1)} m/s`;
    $('windRes').value = W.res;
    $('windTerrain').value = W.terrain;
    $('windShow').value = W.show;
    $('windShow').querySelector('[value="speed"]').disabled = !w;
    app.setHtml($('windRead'), !model ? 'Open a model to see the wind round it.'
      : !w ? 'The weather file has no wind at this time. Choose <b>Set by hand</b>.'
      : `From the <b>${compass16(w.from)}</b> (${Math.round(w.from)}°) at <b>${w.speed.toFixed(1)} m/s</b>${w.epw ? `, 10 m up, at ${app.whenText()}` : app.hasEpw() ? '' : ' · No weather file, so set by hand: <button class="link" data-epw>add one</button>'}`);
    $('windRun').disabled = !model || !w;
    $('windRun').textContent = r?.done && !r.error ? 'Run again' : 'Run';
    syncProgress();
    const status = !r ? 'Press Run to work out the wind round what is shown.'
      : stale() ? `${r.status} · The wind or the model has changed since (it was from the ${compass16(r.from)}): run again to bring it up to date.`
        : r.progress != null ? `${r.status} ${r.average ? 'Averaging' : 'Settling'}: ${r.grid.nx} × ${r.grid.ny} × ${r.grid.nz} cells of ${r.grid.dx} m.` : r.status;
    app.setHtml($('windStatus'), status);
    const shown = r?.ratio && W.on;
    app.setHtml($('windLegend'), shown ? `${app.colourLegendHtml(scale(), W.show === 'speed' && w ? 'Wind speed' : 'Speed ratio', W.show === 'speed' && w ? 'm/s' : '× open ground')}<div class="exposure-ends"><span>Sheltered</span><span>Exposed</span></div>` : '');
  }

  function help() {
    app.Dialog.open({ title: 'Wind (CFD-lite)', html: true, width: 460, body: `<p>Where the wind is sheltered and where it is exposed round what is shown, and roughly how strong it is, 1.5 m above the ground (and roofs). It is worked out on the graphics card by computational fluid dynamics (a lattice Boltzmann solver), kept light so that it takes seconds rather than hours: a guide to the pattern of the wind for early design, not a substitute for a wind study by a specialist.</p>
      <p><b>Wind</b>: from the weather file at the Date and Time widgets' date and time (its direction and speed, measured 10 m up in the open), or set by hand. The weather file's wind is taken as measured 10 m up in open country, as at an airport; a wind set by hand is taken the same way.</p>
      <p><b>Site terrain</b>: what the land round the site is like, which slows the wind near the ground. The wind blows in rising with height as it does over that terrain, and the weather station's wind is brought to the site through the height where the ground no longer slows it (as ASHRAE Fundamentals does). Out in the open on the site, 1.5 m up, the wind is ${WIND_TERRAINS.map((t) => `${Math.round(windOpen(t.id) * 100)}% of the weather file's over ${t.label.toLowerCase()}`).join(', ')}. Run again after changing it.</p>
      <p><b>Speed ratio</b>: the wind's speed as a share of what it would be at the same place 1.5 m up with nothing there (worked out alongside, over the same grid left empty). Below 1 is sheltered; above 1, buildings speed it up, as round corners and through gaps. It does not depend on the wind's speed, so a change of speed needs no new run. <b>Wind speed</b> is the speed in m/s: the speed ratio times the wind out in the open on the site, 1.5 m up (see Site terrain).</p>
      <p><b>Resolution</b>: the size of the cells the air is divided into, chosen to fit the model and the room round it in about that many cells; the status line says what it came to. Finer takes longer and needs more of the graphics card's memory.</p>
      <p><b>Show what the wind sees</b>: the model as the solver has it, in cells. Every cell a surface passes through is solid, and so is the inside of every closed object, so a canopy is a slab a cell thick with the air free to pass under it. Thin walls come out a cell thick, and gaps narrower than about two cells close up: check that the gaps that matter are open, or try a finer resolution.</p>
      <p>What it leaves out, so read the colours as a pattern rather than exact figures:</p>
      <ul><li>Trees and other vegetation are left out: they let some wind through, which the solver does not model yet.</li>
      <li>Cells are a metre or more across, which smooths the detail close to walls and the ground, and the ground and roofs let the wind slide over them, as a rough ground of this size roughly does.</li>
      <li>One wind direction at a time, averaged over a short run. Wind comfort criteria (such as Lawson's) need how often each speed is exceeded over a year, from many directions.</li>
      <li>The results do not feed the thermal comfort figures yet.</li></ul>
      <p>The results are not kept: they go when the model is closed. Run again after changing the wind direction or the model.</p>` });
  }

  function bind() {
    $('windClose').addEventListener('click', () => W.panel && toggle());
    $('windHelp').addEventListener('click', help);
    $('windOn').addEventListener('change', (e) => { W.on = e.target.checked; sync(); app.redraw(); });
    $('windSolids').addEventListener('change', (e) => { W.solids = e.target.checked; syncShell(); sync(); });
    $('windSource').addEventListener('change', (e) => { W.source = e.target.value; recolour(); sync(); });
    $('windDir').addEventListener('input', (e) => { W.dir = +e.target.value; sync(); });
    $('windSpeed').addEventListener('input', (e) => { W.speed = +e.target.value; recolour(); sync(); });
    $('windRes').innerHTML = WIND_RESOLUTIONS.map((r) => `<option value="${r.id}" title="${r.title}">${r.label}</option>`).join('');
    $('windRes').addEventListener('change', (e) => { W.res = e.target.value; sync(); });
    $('windTerrain').innerHTML = WIND_TERRAINS.map((t) => `<option value="${t.id}" title="${t.title}">${t.label}</option>`).join('');
    $('windTerrain').addEventListener('change', (e) => { W.terrain = e.target.value; recolour(); sync(); });
    $('windShow').addEventListener('change', (e) => { W.show = e.target.value; recolour(); sync(); });
    $('windRun').addEventListener('click', () => run());
    $('windStop').addEventListener('click', stop);
    $('windRead').addEventListener('click', (e) => { if (e.target.closest('[data-epw]')) app.openAttachDialog(); });
    $('windLegend').addEventListener('change', (e) => {
      const sel = e.target.closest('select[data-metric]');
      if (sel) app.setColourScale(sel.dataset.metric, sel.value);
    });
  }

  return {
    state: W, bind, toggle, sync, reset, recolour,
    // For each frame: whether the results are drawn.
    shown: () => !!(W.run?.ratio && W.on),
    shellShown: () => !!(W.solids && W.run?.shell),
  };
}
