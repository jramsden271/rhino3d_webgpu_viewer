// Checks src/wind.js: the grid round the model, the inlet profile, the solid cells and the map
// (the solver itself runs on the GPU and is checked in the browser):
//   node tools/test-wind.js

const { windGrid, windInlet, windSolids, windMapTops, windMapMesh, compass16, WIND_OPEN, WIND_PEDESTRIAN } = require('../src/wind.js');

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

// Solids: a column with a 6 m roof on 1.5 m cells has four solid cells; the results are read 1.5 m
// above the roof; a column with nothing has none and is read 1.5 m above the floor.
{
  const G = { nx: 2, ny: 1, nz: 10, dx: 1.5, floor: 0 };
  const { solid, level } = windSolids(G, Float32Array.from([6, NaN]), 1);
  const solidAt = (c) => (solid[c >>> 5] >>> (c & 31)) & 1;
  const col0 = [...Array(10)].map((_, k) => solidAt(0 + 2 * k)), col1 = [...Array(10)].map((_, k) => solidAt(1 + 2 * k));
  check(col0.join('') === '1111000000', `the roofed column: ${col0.join('')}`);
  check(col1.every((v) => !v), 'the open column is empty');
  check(near(level[0], (6 + WIND_PEDESTRIAN) / 1.5, 1e-6) && near(level[1], WIND_PEDESTRIAN / 1.5, 1e-6), `read heights ${[...level]}`);
}

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

check(compass16(0) === 'N' && compass16(225) === 'SW' && compass16(350) === 'N' && compass16(-90) === 'W', 'compass points');

console.log(failures ? `${failures} failed` : 'All wind checks passed');
process.exitCode = failures ? 1 : 0;
