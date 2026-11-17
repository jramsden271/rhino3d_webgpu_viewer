// The person placed in the model (main.js, "The person"), as a mesh the renderer draws as one of its
// actors: a simple figure, standing, or sitting on a stool. In its own metres, standing on the origin,
// facing +x with +y to its left and +z up; main.js turns and places it. Not part of the model: it is
// never picked or analysed, and does not shade the analysis.

export const PERSON_COLOUR = [245, 168, 0]; // sunny orange-yellow, near the walk and place marker's
const STOOL_COLOUR = [120, 118, 112];

// Builds a mesh from primitives: { pos, nrm (Float32Arrays), col (Uint8Array, RGBA), idx (Uint32Array) }.
function builder() {
  const pos = [], nrm = [], col = [], idx = [];
  const vert = (p, n, c) => { pos.push(...p); nrm.push(...n); col.push(...c, 255); return pos.length / 3 - 1; };
  const norm = (v) => { const l = Math.hypot(...v) || 1; return v.map((x) => x / l); };
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const B = {
    // A sphere of radius r at c (or an ellipsoid, r = [rx, ry, rz]).
    sphere(c, r, colour, seg = 12, rings = 8) {
      const R = Array.isArray(r) ? r : [r, r, r], first = pos.length / 3;
      for (let j = 0; j <= rings; j++) {
        const t = (j / rings) * Math.PI, z = Math.cos(t), s = Math.sin(t);
        for (let i = 0; i <= seg; i++) {
          const a = (i / seg) * 2 * Math.PI, d = [Math.cos(a) * s, Math.sin(a) * s, z];
          vert([c[0] + d[0] * R[0], c[1] + d[1] * R[1], c[2] + d[2] * R[2]], norm([d[0] / R[0], d[1] / R[1], d[2] / R[2]]), colour);
        }
      }
      for (let j = 0; j < rings; j++) for (let i = 0; i < seg; i++) {
        const a = first + j * (seg + 1) + i, b = a + seg + 1;
        idx.push(a, b, a + 1, a + 1, b, b + 1);
      }
      return B;
    },
    // A cylinder from a to b, radius r (or [ra, rb], tapering), open ends: joints are covered by spheres.
    limb(a, b, r, colour, seg = 10) {
      const [ra, rb] = Array.isArray(r) ? r : [r, r], ax = norm([b[0] - a[0], b[1] - a[1], b[2] - a[2]]);
      const u = norm(cross(ax, Math.abs(ax[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0])), v = cross(ax, u), first = pos.length / 3;
      for (let i = 0; i <= seg; i++) {
        const t = (i / seg) * 2 * Math.PI, d = [0, 1, 2].map((k) => Math.cos(t) * u[k] + Math.sin(t) * v[k]);
        vert(a.map((x, k) => x + d[k] * ra), d, colour);
        vert(b.map((x, k) => x + d[k] * rb), d, colour);
      }
      for (let i = 0; i < seg; i++) { const p = first + i * 2; idx.push(p, p + 2, p + 1, p + 1, p + 2, p + 3); }
      return B;
    },
    // A rounded limb: a cylinder with a sphere at each end.
    capsule(a, b, r, colour) {
      const [ra, rb] = Array.isArray(r) ? r : [r, r];
      return B.limb(a, b, [ra, rb], colour).sphere(a, ra, colour, 10, 6).sphere(b, rb, colour, 10, 6);
    },
    // An axis-aligned box from lo to hi.
    box(lo, hi, colour) {
      const faces = [[[1, 0, 0], 0], [[-1, 0, 0], 0], [[0, 1, 0], 1], [[0, -1, 0], 1], [[0, 0, 1], 2], [[0, 0, -1], 2]];
      for (const [n, k] of faces) {
        const [i, j] = [0, 1, 2].filter((x) => x !== k), side = n[k] > 0 ? hi[k] : lo[k], first = pos.length / 3;
        for (const [s, t] of [[0, 0], [1, 0], [1, 1], [0, 1]]) {
          const p = [0, 0, 0];
          p[k] = side; p[i] = s ? hi[i] : lo[i]; p[j] = t ? hi[j] : lo[j];
          vert(p, n, colour);
        }
        // Wound so the face looks out along n.
        const flip = (n[k] > 0) !== (((k + 1) % 3) === i);
        if (flip) idx.push(first, first + 2, first + 1, first, first + 3, first + 2);
        else idx.push(first, first + 1, first + 2, first, first + 2, first + 3);
      }
      return B;
    },
    // A smooth surface through closed cross-sections, bottom to top, closed at both ends: each
    // { z, x (its middle, forward), rx (half its depth), ry (half its width), p (squareness: 2 an
    // ellipse, more a rounded rectangle) }. Normals are smoothed from the faces.
    loft(sections, colour, seg = 24) {
      const P = [], tri = [];
      for (const S of sections) {
        const e = 2 / (S.p || 2);
        for (let i = 0; i < seg; i++) {
          const t = (i / seg) * 2 * Math.PI, c = Math.cos(t), sn = Math.sin(t);
          P.push([S.x + S.rx * Math.sign(c) * Math.abs(c) ** e, S.ry * Math.sign(sn) * Math.abs(sn) ** e, S.z]);
        }
      }
      const n = sections.length, lo = P.length, hi = lo + 1, first = sections[0], last = sections[n - 1];
      P.push([first.x, 0, first.z], [last.x, 0, last.z]);
      // Each ring runs anticlockwise seen from above, so these face outwards.
      for (let j = 0; j < n - 1; j++) for (let i = 0; i < seg; i++) {
        const a = j * seg + i, b = j * seg + ((i + 1) % seg), c = a + seg, d = b + seg;
        tri.push([a, b, d], [a, d, c]);
      }
      for (let i = 0; i < seg; i++) {
        tri.push([lo, (i + 1) % seg, i]);
        tri.push([hi, (n - 1) * seg + i, (n - 1) * seg + ((i + 1) % seg)]);
      }
      const N = P.map(() => [0, 0, 0]);
      for (const [a, b, c] of tri) {
        const f = cross(P[b].map((v, k) => v - P[a][k]), P[c].map((v, k) => v - P[a][k]));
        for (const v of [a, b, c]) for (let k = 0; k < 3; k++) N[v][k] += f[k];
      }
      const base = pos.length / 3;
      P.forEach((p, i) => vert(p, norm(N[i]), colour));
      for (const t of tri) idx.push(...t.map((v) => base + v));
      return B;
    },
    done: () => ({ pos: Float32Array.from(pos), nrm: Float32Array.from(nrm), col: Uint8Array.from(col), idx: Uint32Array.from(idx), gloss: 0.15 }),
  };
  return B;
}

// The body from the crotch to the neck, standing (dz moves it up or down): wide at the hips, in at
// the waist, widest across the chest under the arms, then the shoulders slope up into the neck.
const TORSO = [
  { z: 0.8, x: 0, rx: 0.085, ry: 0.13 },
  { z: 0.88, x: -0.005, rx: 0.11, ry: 0.17, p: 2.2 },
  { z: 0.97, x: 0, rx: 0.105, ry: 0.165, p: 2.2 },
  { z: 1.06, x: 0.005, rx: 0.095, ry: 0.145, p: 2.2 },
  { z: 1.16, x: 0.015, rx: 0.105, ry: 0.155, p: 2.4 },
  { z: 1.27, x: 0.02, rx: 0.115, ry: 0.165, p: 2.6 },
  { z: 1.35, x: 0.015, rx: 0.11, ry: 0.176, p: 2.8 },
  { z: 1.41, x: 0, rx: 0.09, ry: 0.176, p: 3 },
  { z: 1.455, x: -0.01, rx: 0.07, ry: 0.13, p: 2.5 },
  { z: 1.49, x: -0.005, rx: 0.052, ry: 0.06 },
  { z: 1.58, x: 0, rx: 0.045, ry: 0.045 },
];

// The figure: 'standing' (1.75 m tall) or 'sitting' (on a 0.45 m stool), its torso lowered by SIT.
const SIT = 0.35;
// colour: the figure's, sRGB 0-255 (the stool keeps its own).
export function personGeometry(posture = 'standing', colour = PERSON_COLOUR) {
  const c = colour, B = builder(), sitting = posture === 'sitting', dz = sitting ? -SIT : 0;
  const side = (f) => { f(1); f(-1); };
  B.loft(TORSO.map((S) => ({ ...S, z: S.z + dz })), c);
  // Head and nose (so the way it faces shows).
  B.sphere([0.005, 0, 1.65 + dz], [0.1, 0.078, 0.11], c, 16, 12);
  B.sphere([0.093, 0, 1.635 + dz], [0.02, 0.013, 0.02], c, 8, 6);
  side((s) => {
    // The shoulder joint, below the top of the shoulder, and the arm hanging from it.
    const sh = [-0.005, s * 0.178, 1.37 + dz];
    B.sphere(sh, 0.056, c, 12, 8);
    if (sitting) {
      // Hands resting on the thighs.
      const el = [0.05, s * 0.212, 0.76], wr = [0.27, s * 0.17, 0.64];
      B.capsule(sh, el, [0.048, 0.038], c).capsule(el, wr, [0.038, 0.028], c);
      B.sphere([0.31, s * 0.165, 0.62], [0.055, 0.03, 0.022], c, 10, 6);
    } else {
      const el = [-0.01, s * 0.205, 1.09], wr = [0.03, s * 0.212, 0.85];
      B.capsule(sh, el, [0.052, 0.038], c).capsule(el, wr, [0.038, 0.028], c);
      B.sphere([0.035, s * 0.212, 0.78], [0.028, 0.018, 0.075], c, 10, 6);
    }
    // Legs and feet: thighs from inside the hips.
    const hip = [0, s * 0.09, 0.88 + dz], knee = sitting ? [0.43, s * 0.1, 0.52] : [0.015, s * 0.1, 0.5];
    const ankle = sitting ? [0.45, s * 0.105, 0.085] : [0, s * 0.105, 0.085];
    B.capsule(hip, knee, [0.085, 0.052], c).capsule(knee, ankle, [0.05, 0.035], c);
    B.sphere([ankle[0] + 0.06, s * 0.105, 0.04], [0.12, 0.045, 0.04], c, 12, 8);
  });
  if (sitting) {
    // The stool: a round seat on four legs.
    B.limb([0, 0, 0.41], [0, 0, 0.45], 0.19, STOOL_COLOUR, 16).sphere([0, 0, 0.45], [0.19, 0.19, 0.005], STOOL_COLOUR, 16, 4).sphere([0, 0, 0.41], [0.19, 0.19, 0.005], STOOL_COLOUR, 16, 4);
    for (const [x, y] of [[0.12, 0.12], [0.12, -0.12], [-0.12, 0.12], [-0.12, -0.12]]) B.limb([x * 1.25, y * 1.25, 0], [x, y, 0.41], 0.016, STOOL_COLOUR, 6);
  }
  return B.done();
}

// How tall the figure is, m: for picking it on screen.
export const PERSON_HEIGHT = { standing: 1.76, sitting: 1.41 };
