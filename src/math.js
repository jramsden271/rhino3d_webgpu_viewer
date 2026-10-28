// Small double-precision vector / matrix helpers. Matrices are column-major (WebGPU order)
// unless noted; Rhino transforms are handled as row-major arrays in extract.js.

const V3 = {
  add: (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]],
  sub: (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]],
  scale: (a, s) => [a[0] * s, a[1] * s, a[2] * s],
  dot: (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
  cross: (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]],
  len: (a) => Math.hypot(a[0], a[1], a[2]),
  norm: (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; },
  // Rotate v about unit axis k by angle (Rodrigues).
  rotate(v, k, angle) {
    const c = Math.cos(angle), s = Math.sin(angle), d = V3.dot(k, v), x = V3.cross(k, v);
    return [v[0] * c + x[0] * s + k[0] * d * (1 - c), v[1] * c + x[1] * s + k[1] * d * (1 - c), v[2] * c + x[2] * s + k[2] * d * (1 - c)];
  },
};

const M4 = {
  mul(a, b) {
    const o = new Float64Array(16);
    for (let c = 0; c < 4; c++)
      for (let r = 0; r < 4; r++) {
        let s = 0;
        for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
        o[c * 4 + r] = s;
      }
    return o;
  },
  lookAt(eye, target, up) {
    const f = V3.norm(V3.sub(target, eye));
    let s = V3.cross(f, up);
    if (V3.len(s) < 1e-9) s = V3.cross(f, [0, 1, 0]);
    s = V3.norm(s);
    const u = V3.cross(s, f);
    const m = new Float64Array(16);
    m[0] = s[0]; m[4] = s[1]; m[8] = s[2]; m[12] = -V3.dot(s, eye);
    m[1] = u[0]; m[5] = u[1]; m[9] = u[2]; m[13] = -V3.dot(u, eye);
    m[2] = -f[0]; m[6] = -f[1]; m[10] = -f[2]; m[14] = V3.dot(f, eye);
    m[15] = 1;
    return m;
  },
  // Reverse-Z, infinite far plane: depth = near / -z_view (1 at near, -> 0 at infinity).
  perspective(fovY, aspect, near) {
    const f = 1 / Math.tan(fovY / 2), m = new Float64Array(16);
    m[0] = f / aspect; m[5] = f; m[11] = -1; m[14] = near;
    return m;
  },
  // Reverse-Z orthographic: depth 1 at near, 0 at far.
  ortho(halfH, aspect, near, far) {
    const m = new Float64Array(16);
    m[0] = 1 / (halfH * aspect); m[5] = 1 / halfH;
    m[10] = 1 / (far - near); m[14] = far / (far - near); m[15] = 1;
    return m;
  },
};
