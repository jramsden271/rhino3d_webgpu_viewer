// Sky view: how much of the sky can be seen from a point. The renderer draws the half of the world
// above the point onto five faces of a cube round it (a hemicube: the top face, and the upper half
// of each side face), each texel holding what it sees (the world position and object, or nothing);
// this module weights the texels into the sky view factors and draws the sky as a fisheye picture.
//
// Two factors are given:
//  - the sky view factor (svf), the usual one in urban climate studies: the share of the radiation
//    a level surface facing up exchanges with the sky, so each part of the sky counts by the cosine
//    of its angle from straight up (low sky counts little);
//  - the share of the sky seen (sky), each part of the sky counting the same: what a person, who
//    is upright rather than a level surface, sees of it, used for the radiant temperature.
// Both are 1 for an open sky. A wall of even height round the point, rising to an angle h above
// the horizon, gives svf = cos²h and sky = 1 - sin h.

import { sunVector } from './sun.js';

const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

// The faces, for a texture 3N wide and N high: the top face (N x N) on the left, then the four side
// faces (N x N/2 each, only their upper half), two above two. Each looks along f with up as its
// up; s and u are its right and up in the world (those of M4.lookAt), and its picture spans -1..1
// along s and, for the top, along u too; a side face spans 0..1 along u (the horizon to 45° up).
export function skyFaces(N) {
  const h = N / 2;
  return [
    { f: [0, 0, 1], up: [0, 1, 0], rect: [0, 0, N, N], half: false },
    { f: [1, 0, 0], up: [0, 0, 1], rect: [N, 0, N, h], half: true },
    { f: [-1, 0, 0], up: [0, 0, 1], rect: [N, h, N, h], half: true },
    { f: [0, 1, 0], up: [0, 0, 1], rect: [2 * N, 0, N, h], half: true },
    { f: [0, -1, 0], up: [0, 0, 1], rect: [2 * N, h, N, h], half: true },
  ].map((F) => {
    const s = cross(F.f, F.up), n = Math.hypot(...s), sn = s.map((v) => v / n);
    return { ...F, s: sn, u: cross(sn, F.f) };
  });
}

// For each texel of the 3N x N texture: the direction it looks in (not normalised: its component
// along its face's f is 1), and its weights for the two factors, each summing to 1 over the
// texture (so the weights of the texels that see the sky add up to the factors).
const tables = new Map();
export function skyTexels(N) {
  if (tables.has(N)) return tables.get(N);
  const W = 3 * N, dirs = new Float32Array(W * N * 3), cosW = new Float64Array(W * N), solidW = new Float64Array(W * N);
  let cosSum = 0, solidSum = 0;
  for (const F of skyFaces(N)) {
    const [x0, y0, w, h] = F.rect;
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
      const a = ((i + 0.5) / w) * 2 - 1, b = F.half ? 1 - (j + 0.5) / h : 1 - ((j + 0.5) / h) * 2;
      const d = [0, 1, 2].map((k) => F.f[k] + a * F.s[k] + b * F.u[k]), r2 = dot(d, d), k = (y0 + j) * W + x0 + i;
      dirs.set(d, k * 3);
      // Every texel covers the same area on its face (2/N square, the face 1 away), so its solid angle
      // goes as 1 / r³ and its share for a level surface as cos(from straight up) / r³ = d.z / r⁴.
      solidW[k] = 1 / (r2 * Math.sqrt(r2));
      cosW[k] = Math.max(0, d[2]) / (r2 * r2);
      solidSum += solidW[k]; cosSum += cosW[k];
    }
  }
  for (let k = 0; k < W * N; k++) { solidW[k] /= solidSum; cosW[k] /= cosSum; }
  const t = { dirs, cosW, solidW };
  tables.set(N, t);
  return t;
}

// The texel of the 3N x N texture that looks in direction d, or -1 below the horizon.
const faceCache = new Map();
export function skyTexelAt(d, N) {
  if (d[2] < 0) return -1;
  const ax = Math.abs(d[0]), ay = Math.abs(d[1]);
  const face = d[2] >= ax && d[2] >= ay ? 0 : ax >= ay ? (d[0] > 0 ? 1 : 2) : (d[1] > 0 ? 3 : 4);
  if (!faceCache.has(N)) faceCache.set(N, skyFaces(N));
  const { f, s, u, rect: [x0, y0, w, h], half } = faceCache.get(N)[face];
  const t = dot(d, f), a = dot(d, s) / t, b = dot(d, u) / t;
  const i = Math.min(w - 1, Math.max(0, Math.floor(((a + 1) / 2) * w)));
  const j = Math.min(h - 1, Math.max(0, Math.floor(half ? (1 - b) * h : ((1 - b) / 2) * h)));
  return (y0 + j) * 3 * N + x0 + i;
}

// The two factors from what the texels see: data holds 4 floats per texel of the 3N x N texture,
// the 4th above 0.5 where it sees an object.
export function skyViewFactors(data, N) {
  const { cosW, solidW } = skyTexels(N);
  let svf = 0, sky = 0;
  for (let k = 0; k < cosW.length; k++) if (!(data[k * 4 + 3] > 0.5)) { svf += cosW[k]; sky += solidW[k]; }
  return { svf: Math.min(1, svf), sky: Math.min(1, sky) };
}

// Draws the sky seen from the point as a fisheye picture into a size x size image (an ImageData's
// data, RGBA): equidistant, so the angle from straight up grows evenly out to the horizon at the
// edge, and as on a plan, north up and east to the right. mode 'mask': the sky white, everything else
// black. 'model': objects in colourOf(id) ([r, g, b], 0-1), shaded by which way they face
// (light: a direction towards the light), and the sky blue. Outside the circle is left clear.
export function drawSkyView(px, size, data, N, { mode = 'mask', north = 0, colourOf, light = [0.3, -0.4, 0.86] } = {}) {
  const W = 3 * N, map = fisheyeMap(size, N, north);
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
      const n = skyNormal(data, k, W, N);
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
    texel[p] = skyTexelAt(sunVector((Math.atan2(dx, -dy) * 180) / Math.PI, 90 * (1 - r), north), N);
  }
  lastMap = { size, N, north, texel, alt };
  return lastMap;
}

// The facing of the surface a texel sees, from its neighbours' positions on the same object, or null.
function skyNormal(data, k, W, N) {
  const x = k % W, y = (k - x) / W, id = data[k * 4 + 3];
  const at = (xx, yy) => (xx >= 0 && xx < W && yy >= 0 && yy < N && data[(yy * W + xx) * 4 + 3] === id ? (yy * W + xx) * 4 : -1);
  const a = at(x + 1, y) >= 0 ? at(x + 1, y) : at(x - 1, y), b = at(x, y + 1) >= 0 ? at(x, y + 1) : at(x, y - 1);
  if (a < 0 || b < 0) return null;
  const p = k * 4, u = [data[a] - data[p], data[a + 1] - data[p + 1], data[a + 2] - data[p + 2]];
  const v = [data[b] - data[p], data[b + 1] - data[p + 1], data[b + 2] - data[p + 2]];
  const n = cross(u, v), l = Math.hypot(...n);
  return l > 0 ? n.map((c) => c / l) : null;
}

// Where a direction in the sky (azimuth and altitude, degrees) falls on the fisheye picture of
// drawSkyView, as a fraction of its size from the top left: [x, y], the same whatever the north angle.
export function skyViewPoint(azimuth, altitude) {
  const r = (90 - altitude) / 90 / 2, a = (azimuth * Math.PI) / 180;
  return [0.5 + r * Math.sin(a), 0.5 - r * Math.cos(a)];
}
