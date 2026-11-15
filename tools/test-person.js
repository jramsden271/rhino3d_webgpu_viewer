// Checks src/person.js: the figures face outwards, stand on the ground, are the right size and face +x:
//   node tools/test-person.js

const { personGeometry, PERSON_HEIGHT, PERSON_COLOUR } = require('../src/person.js');

let failures = 0;
const check = (ok, msg) => { if (!ok) { failures++; console.log(`  FAIL ${msg}`); } };

for (const posture of ['standing', 'sitting']) {
  const g = personGeometry(posture), n = g.pos.length / 3;
  check(g.nrm.length === n * 3 && g.col.length === n * 4 && g.idx.every((i) => i < n), `${posture}: arrays match`);
  check(g.col.every((v, i) => i % 4 !== 3 || v === 255), `${posture}: opaque (alpha below 255 would glow like a lamp)`);
  // Every triangle turns the way its corners' normals point: lit on the outside.
  let wrong = 0;
  for (let t = 0; t < g.idx.length; t += 3) {
    const [a, b, c] = [g.idx[t], g.idx[t + 1], g.idx[t + 2]].map((i) => [g.pos[i * 3], g.pos[i * 3 + 1], g.pos[i * 3 + 2]]);
    const u = a.map((x, k) => b[k] - x), v = a.map((x, k) => c[k] - x);
    const f = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    if (Math.hypot(...f) < 1e-12) continue; // a sphere's pole
    let nx = 0, ny = 0, nz = 0;
    for (const i of [g.idx[t], g.idx[t + 1], g.idx[t + 2]]) { nx += g.nrm[i * 3]; ny += g.nrm[i * 3 + 1]; nz += g.nrm[i * 3 + 2]; }
    if (f[0] * nx + f[1] * ny + f[2] * nz <= 0) wrong++;
  }
  check(wrong === 0, `${posture}: ${wrong} of ${g.idx.length / 3} triangles face inwards`);
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < g.pos.length; i++) { lo[i % 3] = Math.min(lo[i % 3], g.pos[i]); hi[i % 3] = Math.max(hi[i % 3], g.pos[i]); }
  check(Math.abs(lo[2]) < 0.005, `${posture}: stands on the ground (lowest ${lo[2]})`); // the stool's splayed legs dip a hair
  check(Math.abs(hi[2] - PERSON_HEIGHT[posture]) < 0.06, `${posture}: ${hi[2].toFixed(2)} m tall, expected about ${PERSON_HEIGHT[posture]}`);
  check(hi[0] > -lo[0], `${posture}: faces +x (front ${hi[0].toFixed(2)}, back ${lo[0].toFixed(2)})`);
  check(Math.abs(hi[1] + lo[1]) < 1e-6, `${posture}: left and right alike`);
  check(g.col[0] === PERSON_COLOUR[0] || posture === 'sitting', `${posture}: coloured`);
}

console.log(failures ? `\n${failures} check(s) failed` : '\nAll person checks passed');
process.exit(failures ? 1 : 0);
