// What can be seen from a point, all round: how much sky, and which surfaces and how much of them is
// in sun. The renderer draws the world round the point onto the six faces of a cube (the top and
// bottom faces whole, the side faces in two halves, above and below the horizon), each texel holding
// what it sees (the world position and object, or nothing); this module weights the texels.
//
// Two sky factors are given, from the half above the horizon:
//  - the sky view factor (svf), the usual one in urban climate studies: the share of the radiation
//    a level surface facing up exchanges with the sky, so each part of the sky counts by the cosine
//    of its angle from straight up (low sky counts little);
//  - the share of the sky seen (sky), each part of the sky counting the same: what a person, who
//    is upright rather than a level surface, sees of it, used for the radiant temperature.
// Both are 1 for an open sky. A wall of even height round the point, rising to an angle h above
// the horizon, gives svf = cos²h and sky = 1 - sin h.
//
// The surfaces seen, above and below the horizon (surroundingPoints, surroundingsView), give the
// light they reflect onto a person and how much the sun warms them: the renderer tests whether each
// is in sun. Below the horizon, where nothing is drawn, open ground in the sun is assumed.

import { sunVector } from './sun.js';

const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

// The faces, for a texture 3N wide and 2N high. The top N rows hold what is above the horizon: the
// top face (N x N) on the left, then the upper halves of the four side faces (N x N/2 each), two above
// two; the bottom N rows hold what is below it, the same way: the bottom face, and the lower halves.
// Each face looks along f with up as its up; s and u are its right and up in the world (those of
// M4.lookAt). Its picture spans -1..1 along s, and along u -1..1 for a whole face (half 0), 0..1 for
// an upper half (half 1: the horizon to 45° up) and -1..0 for a lower half (half -1).
export function skyFaces(N) {
  const h = N / 2;
  const set = (z, y0, half) => [
    { f: [0, 0, z], up: [0, 1, 0], rect: [0, y0, N, N], half: 0 },
    { f: [1, 0, 0], up: [0, 0, 1], rect: [N, y0, N, h], half },
    { f: [-1, 0, 0], up: [0, 0, 1], rect: [N, y0 + h, N, h], half },
    { f: [0, 1, 0], up: [0, 0, 1], rect: [2 * N, y0, N, h], half },
    { f: [0, -1, 0], up: [0, 0, 1], rect: [2 * N, y0 + h, N, h], half },
  ];
  return [...set(1, 0, 1), ...set(-1, N, -1)].map((F) => {
    const s = cross(F.f, F.up), n = Math.hypot(...s), sn = s.map((v) => v / n);
    return { ...F, s: sn, u: cross(sn, F.f) };
  });
}

// For each texel of the 3N x 2N texture: the direction it looks in (not normalised: its component
// along its face's f is 1), its face, and its weights: for the two sky factors (above the horizon
// only, each summing to 1 there) and its share of the whole sphere of directions (sphereW, summing
// to 1 over the texture).
const tables = new Map();
export function skyTexels(N) {
  if (tables.has(N)) return tables.get(N);
  const W = 3 * N, n = W * 2 * N, dirs = new Float32Array(n * 3), faceOf = new Uint8Array(n);
  const cosW = new Float64Array(n), solidW = new Float64Array(n), sphereW = new Float64Array(n);
  let cosSum = 0, solidSum = 0, sphereSum = 0;
  skyFaces(N).forEach((F, fi) => {
    const [x0, y0, w, h] = F.rect;
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
      const t = (j + 0.5) / h, a = ((i + 0.5) / w) * 2 - 1, b = F.half === 1 ? 1 - t : F.half === -1 ? -t : 1 - 2 * t;
      const d = [0, 1, 2].map((k) => F.f[k] + a * F.s[k] + b * F.u[k]), r2 = dot(d, d), k = (y0 + j) * W + x0 + i;
      dirs.set(d, k * 3);
      faceOf[k] = fi;
      // Every texel covers the same area on its face (2/N square, the face 1 away), so its solid angle
      // goes as 1 / r³ and its share for a level surface as cos(from straight up) / r³ = d.z / r⁴.
      const solid = 1 / (r2 * Math.sqrt(r2));
      sphereW[k] = solid; sphereSum += solid;
      if (d[2] > 0) {
        solidW[k] = solid; solidSum += solid;
        cosW[k] = d[2] / (r2 * r2); cosSum += cosW[k];
      }
    }
  });
  for (let k = 0; k < n; k++) { solidW[k] /= solidSum; cosW[k] /= cosSum; sphereW[k] /= sphereSum; }
  const t = { dirs, faceOf, cosW, solidW, sphereW };
  tables.set(N, t);
  return t;
}

// The texel of the 3N x 2N texture that looks in direction d.
const faceCache = new Map();
export function skyTexelAt(d, N) {
  const ax = Math.abs(d[0]), ay = Math.abs(d[1]), az = Math.abs(d[2]), below = d[2] < 0 ? 5 : 0;
  const face = below + (az >= ax && az >= ay ? 0 : ax >= ay ? (d[0] > 0 ? 1 : 2) : (d[1] > 0 ? 3 : 4));
  if (!faceCache.has(N)) faceCache.set(N, skyFaces(N));
  const { f, s, u, rect: [x0, y0, w, h], half } = faceCache.get(N)[face];
  const t = dot(d, f), a = dot(d, s) / t, b = dot(d, u) / t;
  const i = Math.min(w - 1, Math.max(0, Math.floor(((a + 1) / 2) * w)));
  const j = Math.min(h - 1, Math.max(0, Math.floor(half === 1 ? (1 - b) * h : half === -1 ? -b * h : ((1 - b) / 2) * h)));
  return (y0 + j) * 3 * N + x0 + i;
}

// The two sky factors from what the texels see: data holds 4 floats per texel of the 3N x 2N
// texture, the 4th above 0.5 where it sees an object.
export function skyViewFactors(data, N) {
  const { cosW, solidW } = skyTexels(N);
  let svf = 0, sky = 0;
  for (let k = 0; k < cosW.length; k++) if (!(data[k * 4 + 3] > 0.5)) { svf += cosW[k]; sky += solidW[k]; }
  return { svf: Math.min(1, svf), sky: Math.min(1, sky) };
}

// The facing of the surface a texel sees, from its neighbours' positions on the same object and face
// of the cube, or null.
function texelNormal(data, k, N, faceOf) {
  const W = 3 * N, x = k % W, y = (k - x) / W, id = data[k * 4 + 3], f = faceOf[k];
  const at = (xx, yy) => {
    if (xx < 0 || xx >= W || yy < 0 || yy >= 2 * N) return -1;
    const q = yy * W + xx;
    return faceOf[q] === f && data[q * 4 + 3] === id ? q * 4 : -1;
  };
  const a = at(x + 1, y) >= 0 ? at(x + 1, y) : at(x - 1, y), b = at(x, y + 1) >= 0 ? at(x, y + 1) : at(x, y - 1);
  if (a < 0 || b < 0) return null;
  const p = k * 4, u = [data[a] - data[p], data[a + 1] - data[p + 1], data[a + 2] - data[p + 2]];
  const v = [data[b] - data[p], data[b + 1] - data[p + 1], data[b + 2] - data[p + 2]];
  const n = cross(u, v), l = Math.hypot(...n);
  return l > 0 ? n.map((c) => c / l) : null;
}

// The surfaces seen from eye, ready to test for sun: each texel that sees a surface gets the
// facing of that surface (turned towards eye; facing eye where it cannot be told), and each 2 x 2
// block of texels one point to test, at the first of them that sees a surface. Gives { pos, nrm }
// (the points, 3 floats each), normals (3 floats per texel) and block (per texel, its point, or -1).
export function surroundingPoints(data, N, eye) {
  const { faceOf } = skyTexels(N), W = 3 * N, H = 2 * N, n = W * H;
  const normals = new Float32Array(n * 3), block = new Int32Array(n).fill(-1);
  // A neighbour of texel k on the same face of the cube that sees the same object, or -1.
  const same = (k, q) => (faceOf[q] === faceOf[k] && data[q * 4 + 3] === data[k * 4 + 3] ? q : -1);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const k = y * W + x, p = k * 4;
    if (!(data[p + 3] > 0.5)) continue;
    const ex = eye[0] - data[p], ey = eye[1] - data[p + 1], ez = eye[2] - data[p + 2];
    let a = x + 1 < W ? same(k, k + 1) : -1;
    if (a < 0 && x > 0) a = same(k, k - 1);
    let b = y + 1 < H ? same(k, k + W) : -1;
    if (b < 0 && y > 0) b = same(k, k - W);
    let nx = 0, ny = 0, nz = 0;
    if (a >= 0 && b >= 0) {
      const ux = data[a * 4] - data[p], uy = data[a * 4 + 1] - data[p + 1], uz = data[a * 4 + 2] - data[p + 2];
      const vx = data[b * 4] - data[p], vy = data[b * 4 + 1] - data[p + 1], vz = data[b * 4 + 2] - data[p + 2];
      nx = uy * vz - uz * vy; ny = uz * vx - ux * vz; nz = ux * vy - uy * vx;
    }
    let l = Math.hypot(nx, ny, nz);
    if (!(l > 0)) { nx = ex; ny = ey; nz = ez; l = Math.hypot(nx, ny, nz) || 1; }
    if (nx * ex + ny * ey + nz * ez < 0) l = -l;
    normals[k * 3] = nx / l; normals[k * 3 + 1] = ny / l; normals[k * 3 + 2] = nz / l;
  }
  let count = 0;
  for (let by = 0; by < H; by += 2) for (let bx = 0; bx < W; bx += 2) {
    const k0 = by * W + bx;
    if (data[k0 * 4 + 3] > 0.5 || data[k0 * 4 + 7] > 0.5 || data[(k0 + W) * 4 + 3] > 0.5 || data[(k0 + W) * 4 + 7] > 0.5) count++;
  }
  const pos = new Float32Array(count * 3), nrm = new Float32Array(count * 3);
  let i = 0;
  for (let by = 0; by < H; by += 2) for (let bx = 0; bx < W; bx += 2) {
    const k0 = by * W + bx;
    let r = -1;
    for (const k of [k0, k0 + 1, k0 + W, k0 + W + 1]) if (data[k * 4 + 3] > 0.5) { if (r < 0) r = k; block[k] = i; }
    if (r < 0) continue;
    pos[i * 3] = data[r * 4]; pos[i * 3 + 1] = data[r * 4 + 1]; pos[i * 3 + 2] = data[r * 4 + 2];
    nrm[i * 3] = normals[r * 3]; nrm[i * 3 + 1] = normals[r * 3 + 1]; nrm[i * 3 + 2] = normals[r * 3 + 2];
    i++;
  }
  return { pos, nrm, normals, block };
}

// What the surfaces seen give, for the sun towards sun (a unit vector), with lit[i] how much of the
// sun point i of surroundingPoints sees (0-1; null for none). Each is a share of the whole sphere
// of directions round the person, weighted:
//  - direct: by how square each surface faces the sun, where it is in sun (cos of the sun's angle to
//    it): times the direct normal radiation, the direct sun on the surfaces seen;
//  - diffuse: by how much sky each surface faces ((1 + its normal's upward part) / 2, as if nothing
//    stood in its way): times the diffuse horizontal radiation, the skylight on them;
//  - surfaces: the share of the view that is surfaces, and sunlit the share of those in sun.
// Below the horizon, where nothing was seen, is counted as open level ground in the sun. In the
// open (nothing seen at all) direct is sin(altitude) / 2 and diffuse 1/2.
export function surroundingsView(data, N, { normals, block }, sun, lit) {
  const { dirs, sphereW } = skyTexels(N), sinAlt = Math.max(0, sun[2]);
  let direct = 0, diffuse = 0, surfaces = 0, sunlit = 0;
  for (let k = 0; k < sphereW.length; k++) {
    const w = sphereW[k];
    if (data[k * 4 + 3] > 0.5) {
      const c = Math.max(0, normals[k * 3] * sun[0] + normals[k * 3 + 1] * sun[1] + normals[k * 3 + 2] * sun[2]);
      const l = c > 0 && lit ? lit[block[k]] : 0;
      direct += w * c * l;
      diffuse += (w * (1 + normals[k * 3 + 2])) / 2;
      surfaces += w;
      sunlit += w * l;
    } else if (dirs[k * 3 + 2] < 0) {
      direct += w * sinAlt;
      diffuse += w;
      surfaces += w;
      if (sinAlt > 0) sunlit += w;
    }
  }
  return { direct, diffuse, surfaces, sunlit: surfaces > 0 ? sunlit / surfaces : 0 };
}

// Draws the sky seen from the point as a fisheye picture into a size x size image (an ImageData's
// data, RGBA): equidistant, so the angle from straight up grows evenly out to the horizon at the
// edge, and as on a plan, north up and east to the right. mode 'mask': the sky white, everything else
// black. 'model': objects in colourOf(id) ([r, g, b], 0-1), shaded by which way they face
// (light: a direction towards the light), and the sky blue. Outside the circle is left clear.
export function drawSkyView(px, size, data, N, { mode = 'mask', north = 0, colourOf, light = [0.3, -0.4, 0.86] } = {}) {
  const map = fisheyeMap(size, N, north), { faceOf } = skyTexels(N);
  const L = (() => { const n = Math.hypot(...light) || 1; return light.map((v) => v / n); })();
  for (let p = 0; p < size * size; p++) {
    const o = p * 4, k = map.texel[p];
    if (k < 0) { px[o + 3] = 0; continue; }
    const hit = data[k * 4 + 3] > 0.5;
    let c;
    if (mode === 'mask') c = hit ? BLACK : WHITE;
    else if (!hit) {
      // Paler towards the horizon.
      const t = map.alt[p];
      c = [168 - 80 * t, 205 - 55 * t, 240 - 10 * t];
    } else {
      const base = colourOf?.(Math.round(data[k * 4 + 3]) - 1) || [0.6, 0.6, 0.6];
      const n = texelNormal(data, k, N, faceOf);
      const lit = n ? 0.45 + 0.55 * Math.abs(dot(n, L)) : 0.75;
      c = base.map((v) => Math.min(255, 255 * v * lit));
    }
    px[o] = c[0]; px[o + 1] = c[1]; px[o + 2] = c[2]; px[o + 3] = 255;
  }
}

const BLACK = [0, 0, 0], WHITE = [255, 255, 255];

// For each pixel of the size x size fisheye picture, the texel it shows (-1 outside the circle) and
// its height in the sky (0 at the horizon, 1 straight up). Kept for the last size, N and north.
let lastMap = null;
function fisheyeMap(size, N, north) {
  if (lastMap?.size === size && lastMap.N === N && lastMap.north === north) return lastMap;
  const R = size / 2, texel = new Int32Array(size * size), alt = new Float32Array(size * size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const p = y * size + x, dx = (x + 0.5 - R) / R, dy = (y + 0.5 - R) / R, r = Math.hypot(dx, dy);
    if (r > 1) { texel[p] = -1; continue; }
    alt[p] = 1 - r;
    // Just above the horizon at the very edge, so the picture never reaches below it.
    texel[p] = skyTexelAt(sunVector((Math.atan2(dx, -dy) * 180) / Math.PI, Math.max(1e-3, 90 * (1 - r)), north), N);
  }
  lastMap = { size, N, north, texel, alt };
  return lastMap;
}

// Where a direction in the sky (azimuth and altitude, degrees) falls on the fisheye picture of
// drawSkyView, as a fraction of its size from the top left: [x, y], the same whatever the north angle.
export function skyViewPoint(azimuth, altitude) {
  const r = (90 - altitude) / 90 / 2, a = (azimuth * Math.PI) / 180;
  return [0.5 + r * Math.sin(a), 0.5 - r * Math.cos(a)];
}
