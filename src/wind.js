// Wind (CFD-lite): the wind round the model, from the lattice Boltzmann solver in lbm.js, shown as a
// map of the wind near the ground (PEDESTRIAN m above whatever is below: the ground, or a roof).
//
// The grid is a box lined up with the wind, round what is shown, with room upwind, downwind, to the
// sides and above in proportion to the tallest thing in the model. The model goes in as seen from
// above: every cell under the top surface is solid, so overhangs, arcades and bridges are filled in,
// and vegetation is left out (it is porous, which the solver does not model yet).
//
// The wind blowing in rises with height as over a suburb or town (a power law). The solver works in
// its own units, so the results are the speed as a share of the wind at the same height over the
// open ground upwind (the speed ratio: below 1 sheltered, above 1 where buildings speed it up), and
// the speed in m/s comes from the wind's speed at 10 m: from the weather file at the Date and Time
// widgets' date and time, or set by hand. Changing the speed needs no new run; changing the direction
// or the model does.

import { WindSolver } from './lbm.js';
import { sunVector } from './sun.js';
import { ColourScales } from './colourscales.js';

export const WIND_PEDESTRIAN = 1.5;   // m above the surface, where the results are read
export const WIND_ALPHA = 0.25;       // the inlet profile's power law exponent: suburban to urban terrain
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

// The inlet's speed at each cell's height (cells per step), at 10 m, and at WIND_PEDESTRIAN (the
// reference for the speed ratio).
export function windInlet(nz, dx) {
  const top = nz * dx, inlet = new Float32Array(nz), at = (z) => U_TOP * Math.pow(Math.max(z, 1) / top, WIND_ALPHA);
  for (let k = 0; k < nz; k++) inlet[k] = at((k + 0.5) * dx);
  return { inlet, u10: at(10), uRef: at(WIND_PEDESTRIAN) };
}
// The wind in the open at WIND_PEDESTRIAN, as a share of the wind at 10 m (the weather file's height).
export const WIND_OPEN = Math.pow(WIND_PEDESTRIAN / 10, WIND_ALPHA);

// From the top surface heights (heightMap, model units, NaN for none): the solid cells (bits, one per
// cell) and the height each column's results are read at (cells above the floor).
export function windSolids(G, tops, mpu) {
  const { nx, ny, nz, dx, floor } = G, n = nx * ny * nz, solid = new Uint32Array(Math.ceil(n / 32)), level = new Float32Array(nx * ny);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const col = i + nx * j, h = Number.isFinite(tops[col]) ? Math.max(0, (tops[col] - floor) * mpu) : 0;
    const k1 = Math.min(nz, Math.round(h / dx)); // cells whose middle is below the top
    for (let k = 0; k < k1; k++) { const c = col + nx * ny * k; solid[c >>> 5] |= 1 << (c & 31); }
    level[col] = (h + WIND_PEDESTRIAN) / dx;
  }
  return { solid, level };
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
    panel: false, on: true, source: 'epw', dir: 225, speed: 5, res: 'coarse', show: 'ratio',
    // The latest run: { key, from, grid, tops, ratio (Float32Array per column, or null), status, progress, error }
    run: null, token: 0, solver: null,
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
  const runKey = (from) => [Math.round(from), W.res, app.modelKey(), app.north()].join('|');

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
    W.run = { key: runKey(w.from), from: w.from, grid: G, tops: null, ratio: null, status: 'Reading the model…', progress: 0, done: false };
    sync();
    const centre = [G.dir[0] * (G.s0 + (G.nx * G.cell) / 2) + G.left[0] * (G.t0 + (G.ny * G.cell) / 2), G.dir[1] * (G.s0 + (G.nx * G.cell) / 2) + G.left[1] * (G.t0 + (G.ny * G.cell) / 2)];
    const tops = await renderer.heightMap({ centre, dir: G.dir, nx: G.nx, ny: G.ny, cell: G.cell, top: mx[2] + 1 / mpu, bottom: G.floor - 1 / mpu });
    if (token !== W.token) return;
    if (!tops) { Object.assign(W.run, { status: 'The model could not be read for the wind: try a coarser resolution.', progress: null, done: true, error: true }); sync(); return; }
    W.run.tops = tops;
    const { solid, level } = windSolids(G, tops, mpu), { inlet, u10, uRef } = windInlet(G.nz, G.dx);
    W.solver.setup({ nx: G.nx, ny: G.ny, nz: G.nz, solid, inlet });
    W.run.mapTops = windMapTops(G, tops, mn, mx);
    const mesh = windMapMesh(G, W.run.mapTops, 0.05 / mpu);
    renderer.setWindMap(mesh.pos, mesh.idx, null);
    // Steps: the wind crosses the grid once to settle (at the speed at 10 m), then once more while
    // the average is taken.
    const cross = Math.ceil(G.nx / u10), warm = Math.min(Math.max(cross, 1500), 30000), total = warm + Math.min(Math.max(cross, 1500), 30000);
    let done = 0, batch = 4, lastShown = 0;
    const show = async (average) => {
      const v = await W.solver.level(level, average);
      if (token !== W.token) return;
      for (let i = 0; i < v.length; i++) v[i] /= uRef;
      W.run.ratio = v;
      W.run.average = average;
      recolour();
    };
    W.run.status = 'Calculating…';
    while (done < total) {
      const tb = performance.now(), n = Math.min(batch, total - done), average = done >= warm;
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
    app.renderer?.setWindMap(null);
    sync();
  }

  // The values shown: the speed ratio, or m/s; hidden where there is no surface.
  function recolour() {
    const r = W.run, renderer = app.renderer;
    if (!r?.ratio || !renderer) return;
    const w = wind(), mps = W.show === 'speed' && w, v = new Float32Array(r.ratio.length);
    for (let i = 0; i < v.length; i++) v[i] = Number.isFinite(r.mapTops[i]) ? (mps ? r.ratio[i] * w.speed * WIND_OPEN : r.ratio[i]) : 1e30;
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
    $('windSource').value = W.source;
    $('windCustom').hidden = fromEpw();
    $('windSource').querySelector('[value="epw"]').disabled = !app.hasEpw();
    if (!app.hasEpw()) $('windSource').value = 'custom';
    $('windDir').value = W.dir;
    $('windDirOut').value = `${compass16(W.dir)} · ${Math.round(W.dir)}°`;
    $('windSpeed').value = W.speed;
    $('windSpeedOut').value = `${W.speed.toFixed(1)} m/s`;
    $('windRes').value = W.res;
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
      <p><b>Wind</b>: from the weather file at the Date and Time widgets' date and time (its direction and speed, measured 10 m up in the open), or set by hand. The wind blowing in rises with height as it does over a suburb or town.</p>
      <p><b>Speed ratio</b>: the wind's speed as a share of the wind at the same height (1.5 m) over the open ground upwind. Below 1 is sheltered; above 1, buildings speed it up, as round corners and through gaps. It does not depend on the wind's speed, so a change of speed needs no new run. <b>Wind speed</b> is the speed in m/s: the weather file's speed is taken as the wind blowing in at 10 m, and 1.5 m up in the open it is ${Math.round(WIND_OPEN * 100)}% of that.</p>
      <p><b>Resolution</b>: the size of the cells the air is divided into, chosen to fit the model and the room round it in about that many cells; the status line says what it came to. Finer takes longer and needs more of the graphics card's memory.</p>
      <p>What it leaves out, so read the colours as a pattern rather than exact figures:</p>
      <ul><li>The model is taken as seen from above: everything under a roof is solid, so arcades, overhangs and the space under bridges are filled in. Trees are left out.</li>
      <li>Cells are a metre or more across, which smooths the detail close to walls and the ground.</li>
      <li>One wind direction at a time, averaged over a short run. Wind comfort criteria (such as Lawson's) need how often each speed is exceeded over a year, from many directions.</li>
      <li>The results do not feed the thermal comfort figures yet.</li></ul>
      <p>The results are not kept: they go when the model is closed. Run again after changing the wind direction or the model.</p>` });
  }

  function bind() {
    $('windClose').addEventListener('click', () => W.panel && toggle());
    $('windHelp').addEventListener('click', help);
    $('windOn').addEventListener('change', (e) => { W.on = e.target.checked; sync(); app.redraw(); });
    $('windSource').addEventListener('change', (e) => { W.source = e.target.value; recolour(); sync(); });
    $('windDir').addEventListener('input', (e) => { W.dir = +e.target.value; sync(); });
    $('windSpeed').addEventListener('input', (e) => { W.speed = +e.target.value; recolour(); sync(); });
    $('windRes').innerHTML = WIND_RESOLUTIONS.map((r) => `<option value="${r.id}" title="${r.title}">${r.label}</option>`).join('');
    $('windRes').addEventListener('change', (e) => { W.res = e.target.value; sync(); });
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
  };
}
