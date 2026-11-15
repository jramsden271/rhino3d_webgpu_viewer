// Checks src/wind.js: the grid round the model, the inlet profile, the solid cells and the map
// (the solver itself runs on the GPU and is checked in the browser):
//   node tools/test-wind.js

const { windGrid, windInlet, windVoxels, windVoxelShell, windMapTops, windMapMesh, compass16, WIND_OPEN, WIND_PEDESTRIAN } = require('../src/wind.js');

let failures = 0;
const check = (ok, msg) => { if (!ok) { failures++; console.log(`  FAIL ${msg}`); } };
const near = (a, b, tol) => Math.abs(a - b) <= tol;

// A 100 × 60 m site with a 20 m building, in metres, north up.
const mn = [0, 0, 0], mx = [100, 60, 20];
for (const from of [0, 90, 225, 270]) {
  const G = windGrid({ mn, mx, from, north: 90, mpu: 1, cells: 1.5e6 });
  const n = G.nx * G.ny * G.nz;
  check(n <= 1.6e6 && n >= 0.4e6, `from ${from}: about the cells asked for (${n})`);
  check(Math.abs(Math.hypot(...G.dir) - 1) < 1e-9 && Math.abs(G.dir[0] * G.left[0] + G.dir[1] * G.left[1]) < 1e-9, `from ${from}: dir and left are unit and square`);
  // Every corner of the site is inside the grid, with room upwind, downwind and to the sides.
  for (const x of [mn[0], mx[0]]) for (const y of [mn[1], mx[1]]) {
    const s = x * G.dir[0] + y * G.dir[1], t = x * G.left[0] + y * G.left[1];
    check(s - G.s0 >= 60 - 1e-6 && G.s0 + G.nx * G.cell - s >= 120 - 1e-6, `from ${from}: room upwind and downwind`);
    check(t - G.t0 >= 40 - 1e-6 && G.t0 + G.ny * G.cell - t >= 40 - 1e-6, `from ${from}: room to the sides`);
  }
  check(G.zTop >= 60, `from ${from}: room above (${G.zTop} m)`);
}
// The wind blows towards where it is going: from the south (180) is towards north (+y with north up).
{
  const G = windGrid({ mn, mx, from: 180, north: 90, mpu: 1, cells: 1e6 });
  check(near(G.dir[0], 0, 1e-9) && near(G.dir[1], 1, 1e-9), `from the south blows north: ${G.dir}`);
  const H = windGrid({ mn, mx, from: 270, north: 90, mpu: 1, cells: 1e6 });
  check(near(H.dir[0], 1, 1e-9) && near(H.dir[1], 0, 1e-9), `from the west blows east: ${H.dir}`);
}
// A device that holds fewer cells gets coarser ones.
{
  const G = windGrid({ mn, mx, from: 0, north: 90, mpu: 1, cells: 4e6, maxCells: 300e3 });
  check(G.nx * G.ny * G.nz <= 300e3, 'fits the device');
}
// Millimetre models: the same grid in metres, cells in model units.
{
  const a = windGrid({ mn, mx, from: 45, north: 90, mpu: 1, cells: 1e6 });
  const b = windGrid({ mn: mn.map((v) => v * 1000), mx: mx.map((v) => v * 1000), from: 45, north: 90, mpu: 0.001, cells: 1e6 });
  check(a.nx === b.nx && a.ny === b.ny && a.nz === b.nz && a.dx === b.dx && near(b.cell, a.cell * 1000, 1e-6), 'units do not change the grid');
}

// The inlet: rising with height, as fast at the top as the solver allows.
{
  const { inlet, u10, uRef } = windInlet(40, 1.5);
  check(inlet.every((v, k) => k === 0 || v >= inlet[k - 1]), 'the inlet speeds up with height');
  check(inlet[39] <= 0.1 && inlet[39] > 0.09, `top speed ${inlet[39]}`);
  check(near(uRef / u10, WIND_OPEN, 1e-9), 'the reference is the open wind at pedestrian height');
}

// Solids, on 1 m cells: a ground plane, a closed box standing on it, and a canopy (a single
// surface) over open ground, either way up. The box is filled; under the canopy stays open.
(async () => {
  const G = { nx: 20, ny: 20, nz: 20, dx: 1, cell: 1, dir: [1, 0], left: [0, 1], s0: 0, t0: 0, floor: 0 };
  const quad = (a, b, c, d) => ({ pos: Float32Array.from([...a, ...b, ...c, ...d]), idx: Uint32Array.from([0, 1, 2, 0, 2, 3]), xf: null });
  // A box with its faces turned out.
  const box = (x0, y0, z0, x1, y1, z1) => {
    const p = [[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0], [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]];
    const f = [[0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7]];
    return { pos: Float32Array.from(p.flat()), idx: Uint32Array.from(f.flatMap(([a, b, c, d]) => [a, b, c, a, c, d])), xf: null };
  };
  const ground = quad([0, 0, 0.2], [20, 0, 0.2], [20, 20, 0.2], [0, 20, 0.2]);
  for (const flip of [false, true]) {
    const canopy = flip ? quad([10, 10, 3.5], [10, 16, 3.5], [16, 16, 3.5], [16, 10, 3.5]) : quad([10, 10, 3.5], [16, 10, 3.5], [16, 16, 3.5], [10, 16, 3.5]);
    const V = await windVoxels(G, [ground, box(2, 2, 0.2, 6, 6, 8.2), canopy], 1);
    const column = (i, j) => [...Array(G.nz)].map((_, k) => { const c = i + 20 * j + 400 * k; return (V.solid[c >>> 5] >>> (c & 31)) & 1; }).join('');
    const way = flip ? 'canopy facing down' : 'canopy facing up';
    check(column(4, 4) === '11111111100000000000', `${way}: the box is filled to its roof: ${column(4, 4)}`);
    check(column(13, 13) === '10010000000000000000', `${way}: open under the canopy: ${column(13, 13)}`);
    check(column(18, 2) === '10000000000000000000', `${way}: open ground: ${column(18, 2)}`);
    check(near(V.stand[4 + 20 * 4], 8.2, 1e-4) && near(V.level[4 + 20 * 4], 8.2 + WIND_PEDESTRIAN, 1e-4), `${way}: read above the roof`);
    check(near(V.stand[13 + 20 * 13], 0.2, 1e-4) && near(V.level[13 + 20 * 13], 0.2 + WIND_PEDESTRIAN, 1e-4), `${way}: read above the ground under the canopy`);
  }
  // Nothing at all: read above the floor, nowhere to stand.
  const E = await windVoxels(G, [], 1);
  check(E.count === 0 && Number.isNaN(E.stand[0]) && near(E.level[0], WIND_PEDESTRIAN, 1e-9), 'an empty grid');
  // One solid cell in the middle of the grid has six faces.
  const one = new Uint32Array(Math.ceil(8000 / 32)), c = 5 + 20 * 5 + 400 * 5;
  one[c >>> 5] |= 1 << (c & 31);
  const S = windVoxelShell(G, one);
  check(S.faces === 6 && S.idx.length === 36 && S.pos.length === 72, `one cell's shell: ${S.faces} faces`);
  check(windVoxelShell(G, one, 3) === null, 'too many faces to show');
})().then(() => {
  check(compass16(0) === 'N' && compass16(225) === 'SW' && compass16(350) === 'N' && compass16(-90) === 'W', 'compass points');
  console.log(failures ? `${failures} failed` : 'All wind checks passed');
  process.exitCode = failures ? 1 : 0;
});

// The map: no triangles across a step, and none where nothing is drawn.
{
  const G = { nx: 4, ny: 3, cell: 1, dir: [1, 0], left: [0, 1], s0: 0, t0: 0, floor: 0 };
  const tops = Float32Array.from([0, 0, 10, 10, 0, 0, 10, 10, 0, 0, 10, 10]);
  const shown = windMapTops(G, tops, [0, 0, 0], [4, 3, 10]);
  const { pos, idx } = windMapMesh(G, shown, 0.05);
  check(pos.length === 36 && near(pos[2], 0.05, 1e-6) && near(pos[2 * 3 + 2], 10.05, 1e-6), 'points on the surface, lifted');
  check(idx.length === 6 * 4, `quads either side of the step only (${idx.length / 6})`);
  const none = windMapTops(G, new Float32Array(12).fill(NaN), [0, 0, 0], [1.6, 3, 10]);
  check(none.filter(Number.isFinite).length === 6 && none.every((z, c) => Number.isFinite(z) === (c % 4 < 2)), 'nothing beyond the model, the floor within it');
}

