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
    done: () => ({ pos: Float32Array.from(pos), nrm: Float32Array.from(nrm), col: Uint8Array.from(col), idx: Uint32Array.from(idx), gloss: 0.15 }),
  };
  return B;
}

// The figure: 'standing' (1.75 m tall) or 'sitting' (on a 0.45 m stool).
export function personGeometry(posture = 'standing') {
  const c = PERSON_COLOUR, B = builder();
  const side = (f) => { f(1); f(-1); };
  if (posture === 'sitting') {
    // The stool: a round seat on four legs.
    B.limb([0, 0, 0.41], [0, 0, 0.45], 0.19, STOOL_COLOUR, 16).sphere([0, 0, 0.45], [0.19, 0.19, 0.005], STOOL_COLOUR, 16, 4).sphere([0, 0, 0.41], [0.19, 0.19, 0.005], STOOL_COLOUR, 16, 4);
    for (const [x, y] of [[0.12, 0.12], [0.12, -0.12], [-0.12, 0.12], [-0.12, -0.12]]) B.limb([x * 1.25, y * 1.25, 0], [x, y, 0.41], 0.016, STOOL_COLOUR, 6);
    // Seated: thighs level, shins down, hands on the knees.
    side((s) => {
      B.capsule([0.02, s * 0.09, 0.53], [0.42, s * 0.1, 0.52], [0.075, 0.06], c);
      B.capsule([0.42, s * 0.1, 0.52], [0.44, s * 0.1, 0.1], [0.055, 0.045], c);
      B.box([0.4, s * 0.1 - 0.045, 0], [0.62, s * 0.1 + 0.045, 0.07], c);
      B.capsule([0, s * 0.2, 1.02], [0.1, s * 0.23, 0.79], [0.05, 0.045], c);
      B.capsule([0.1, s * 0.23, 0.79], [0.33, s * 0.16, 0.6], [0.045, 0.04], c);
      B.sphere([0.36, s * 0.15, 0.59], 0.05, c, 8, 6);
    });
    torso(B, c, 0.5);
  } else {
    side((s) => {
      B.capsule([0, s * 0.09, 0.9], [0.01, s * 0.1, 0.48], [0.075, 0.06], c);
      B.capsule([0.01, s * 0.1, 0.48], [0, s * 0.1, 0.1], [0.055, 0.045], c);
      B.box([-0.04, s * 0.1 - 0.045, 0], [0.18, s * 0.1 + 0.045, 0.07], c);
      B.capsule([0, s * 0.21, 1.41], [0.02, s * 0.24, 1.14], [0.05, 0.045], c);
      B.capsule([0.02, s * 0.24, 1.14], [0.1, s * 0.22, 0.92], [0.045, 0.04], c);
      B.sphere([0.11, s * 0.215, 0.88], 0.05, c, 8, 6);
    });
    torso(B, c, 0.88);
  }
  return B.done();
}

// Hips to head, from z0 (the hips) up: a body, neck and head, with a nose so the way it faces shows.
function torso(B, c, z0) {
  B.sphere([0, 0, z0 + 0.06], [0.12, 0.17, 0.11], c);
  B.sphere([0, 0, z0 + 0.3], [0.12, 0.17, 0.24], c, 14, 10);
  B.sphere([0, 0, z0 + 0.47], [0.12, 0.215, 0.08], c);
  B.limb([0, 0, z0 + 0.52], [0, 0, z0 + 0.62], 0.05, c, 8);
  B.sphere([0, 0, z0 + 0.74], [0.1, 0.09, 0.115], c);
  B.sphere([0.1, 0, z0 + 0.72], [0.025, 0.018, 0.022], c, 8, 6);
}

// How tall the figure is, m: for picking it on screen.
export const PERSON_HEIGHT = { standing: 1.75, sitting: 1.35 };
