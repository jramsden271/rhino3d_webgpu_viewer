// Checks src/skyview.js: the texel weights, the texel looked up for a direction, the two sky
// factors for skies with known answers, and the surroundings on level ground:  node tools/test-skyview.js

const { skyTexels, skyTexelAt, skyViewFactors, skyViewPoint, surroundingPoints, surroundingsView } = require('../src/skyview.js');

let failures = 0;
const check = (ok, msg) => { if (!ok) { failures++; console.log(`  FAIL ${msg}`); } };
const near = (a, b, tol) => Math.abs(a - b) <= tol;

for (const N of [64, 128, 256]) {
  const { dirs, cosW } = skyTexels(N), n = cosW.length;
  // A sky blocked where block(direction) says, as the renderer would give it.
  const sky = (block) => {
    const data = new Float32Array(n * 4);
    for (let k = 0; k < n; k++) if (block([dirs[k * 3], dirs[k * 3 + 1], dirs[k * 3 + 2]])) data[k * 4 + 3] = 1;
    return skyViewFactors(data, N);
  };
  const alt = (d) => Math.atan2(d[2], Math.hypot(d[0], d[1]));
  const tol = 4 / N;
  const open = sky(() => false), shut = sky(() => true);
  check(near(open.svf, 1, 1e-9) && near(open.sky, 1, 1e-9), `N ${N}: open sky ${open.svf}, ${open.sky}`);
  check(shut.svf === 0 && shut.sky === 0, `N ${N}: no sky`);
  const half = sky((d) => d[0] > 0);
  check(near(half.svf, 0.5, 1e-9) && near(half.sky, 0.5, 1e-9), `N ${N}: half the sky ${half.svf}, ${half.sky}`);
  // A wall all round rising to h above the horizon: svf cos²h, sky 1 - sin h.
  for (const h of [15, 30, 45, 60, 75]) {
    const r = (h * Math.PI) / 180, got = sky((d) => alt(d) < r);
    check(near(got.svf, Math.cos(r) ** 2, tol), `N ${N}: wall to ${h}° svf ${got.svf.toFixed(4)}, expected ${(Math.cos(r) ** 2).toFixed(4)}`);
    check(near(got.sky, 1 - Math.sin(r), tol), `N ${N}: wall to ${h}° sky ${got.sky.toFixed(4)}, expected ${(1 - Math.sin(r)).toFixed(4)}`);
  }
  // Each texel's own direction looks it up again.
  let wrong = 0;
  for (let k = 0; k < n; k++) if (skyTexelAt([dirs[k * 3], dirs[k * 3 + 1], dirs[k * 3 + 2]], N) !== k) wrong++;
  check(wrong === 0, `N ${N}: ${wrong} texels not found again from their direction`);
  const { sphereW } = skyTexels(N);
  let below = 0;
  for (let k = 0; k < n; k++) if (dirs[k * 3 + 2] < 0) below += sphereW[k];
  check(near(below, 0.5, 1e-9), `N ${N}: half the sphere below the horizon (${below})`);
}

// The surroundings: level ground 1.5 below the eye, and the open (nothing drawn at all).
for (const N of [64, 128]) {
  const { dirs } = skyTexels(N), n = dirs.length / 3, eye = [3, -2, 1.5];
  const ground = new Float32Array(n * 4), open = new Float32Array(n * 4);
  for (let k = 0; k < n; k++) {
    const d = [dirs[k * 3], dirs[k * 3 + 1], dirs[k * 3 + 2]];
    if (d[2] >= 0) continue;
    const t = -eye[2] / d[2];
    ground.set([eye[0] + d[0] * t, eye[1] + d[1] * t, 0, 1], k * 4);
  }
  const pts = surroundingPoints(ground, N, eye);
  let flat = 0, count = 0;
  for (let k = 0; k < n; k++) if (ground[k * 4 + 3] > 0.5) { count++; if (Math.abs(pts.normals[k * 3 + 2] - 1) > 1e-3) flat++; }
  check(flat <= count * 0.002, `N ${N}: ${flat} of ${count} ground normals not straight up`);
  check(pts.pos.length / 3 <= count / 4 + 2 * N, `N ${N}: one point per 2 x 2 block (${pts.pos.length / 3})`);
  for (const alt of [10, 35, 60]) {
    const a = (alt * Math.PI) / 180, sun = [Math.cos(a) * 0.6, Math.cos(a) * 0.8, Math.sin(a)];
    const lit = new Float32Array(pts.pos.length / 3).fill(1), want = { direct: Math.sin(a) / 2, diffuse: 0.5 };
    const g = surroundingsView(ground, N, pts, sun, lit), o = surroundingsView(open, N, surroundingPoints(open, N, eye), sun, null);
    for (const [name, v] of [['ground', g], ['open', o]]) {
      check(near(v.direct, want.direct, 2e-3) && near(v.diffuse, want.diffuse, 2e-3) && near(v.surfaces, 0.5, 1e-9) && near(v.sunlit, 1, 1e-9),
        `N ${N}, sun ${alt}°, ${name}: direct ${v.direct.toFixed(4)} (${want.direct.toFixed(4)}), diffuse ${v.diffuse.toFixed(4)}, surfaces ${v.surfaces}, sunlit ${v.sunlit}`);
    }
    const shade = surroundingsView(ground, N, pts, sun, lit.fill(0));
    check(shade.direct === 0 && shade.sunlit === 0 && near(shade.diffuse, 0.5, 2e-3), `N ${N}: ground all in shade`);
  }
}

const near2 = (p, q) => near(p[0], q[0], 1e-12) && near(p[1], q[1], 1e-12);
check(near2(skyViewPoint(0, 90), [0.5, 0.5]) && near2(skyViewPoint(0, 0), [0.5, 0]) && near2(skyViewPoint(90, 0), [1, 0.5]) && near2(skyViewPoint(180, 45), [0.5, 0.75]), 'fisheye points: zenith centre, north up, east right');

console.log(failures ? `\n${failures} check(s) failed` : '\nAll sky view checks passed');
process.exit(failures ? 1 : 0);
