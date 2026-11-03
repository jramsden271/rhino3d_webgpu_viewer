// Triangle meshes made in the viewer, for analysis: joining pieces, merging their shared vertices,
// splitting long edges and finding normals. A mesh is { pos (x, y, z, ...), idx (three vertices
// per triangle, anticlockwise seen from its front) }.

const Meshes = {
  // One mesh from several: [{ pos, idx, xf (optional: a row-major 4x4 transform) }].
  join(list) {
    let nv = 0, ni = 0;
    for (const m of list) { nv += m.pos.length; ni += m.idx.length; }
    const pos = new Float64Array(nv), idx = new Uint32Array(ni);
    let v = 0, i = 0;
    for (const { pos: p, idx: t, xf } of list) {
      const base = v / 3;
      for (let k = 0; k < p.length; k += 3) {
        const x = p[k], y = p[k + 1], z = p[k + 2];
        if (xf) {
          pos[v++] = xf[0] * x + xf[1] * y + xf[2] * z + xf[3];
          pos[v++] = xf[4] * x + xf[5] * y + xf[6] * z + xf[7];
          pos[v++] = xf[8] * x + xf[9] * y + xf[10] * z + xf[11];
        } else { pos[v++] = x; pos[v++] = y; pos[v++] = z; }
      }
      for (let k = 0; k < t.length; k++) idx[i++] = t[k] + base;
    }
    return { pos, idx };
  },

  // Vertices closer than about tol become one, and triangles left with two corners the same go.
  weld({ pos, idx }, tol) {
    const at = new Map(), map = new Uint32Array(pos.length / 3), out = [];
    for (let v = 0; v < map.length; v++) {
      const key = `${Math.round(pos[v * 3] / tol)},${Math.round(pos[v * 3 + 1] / tol)},${Math.round(pos[v * 3 + 2] / tol)}`;
      let k = at.get(key);
      if (k === undefined) { k = out.length / 3; at.set(key, k); out.push(pos[v * 3], pos[v * 3 + 1], pos[v * 3 + 2]); }
      map[v] = k;
    }
    const tris = [];
    for (let t = 0; t < idx.length; t += 3) {
      const a = map[idx[t]], b = map[idx[t + 1]], c = map[idx[t + 2]];
      if (a !== b && b !== c && c !== a) tris.push(a, b, c);
    }
    return { pos: Float64Array.from(out), idx: Uint32Array.from(tris) };
  },

  // The sum of the triangles' normals, each as long as its triangle's area (about every
  // step-th triangle, for a quick answer on a big mesh).
  areaNormal({ pos, idx }, step = 1) {
    const n = [0, 0, 0];
    for (let t = 0; t < idx.length; t += 3 * step) {
      const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3;
      const ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2];
      const vx = pos[c] - pos[a], vy = pos[c + 1] - pos[a + 1], vz = pos[c + 2] - pos[a + 2];
      n[0] += (uy * vz - uz * vy) / 2; n[1] += (uz * vx - ux * vz) / 2; n[2] += (ux * vy - uy * vx) / 2;
    }
    return n;
  },

  area(m, step = 1) {
    let s = 0;
    const { pos, idx } = m;
    for (let t = 0; t < idx.length; t += 3 * step) {
      const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3;
      const ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2];
      const vx = pos[c] - pos[a], vy = pos[c + 1] - pos[a + 1], vz = pos[c + 2] - pos[a + 2];
      s += Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) / 2;
    }
    return s;
  },

  // The triangles facing within angle degrees of the unit direction dir.
  keepFacing({ pos, idx }, dir, angle) {
    const cos = Math.cos((angle * Math.PI) / 180), out = [];
    for (let t = 0; t < idx.length; t += 3) {
      const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3;
      const ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2];
      const vx = pos[c] - pos[a], vy = pos[c + 1] - pos[a + 1], vz = pos[c + 2] - pos[a + 2];
      const x = uy * vz - uz * vy, y = uz * vx - ux * vz, z = ux * vy - uy * vx, l = Math.hypot(x, y, z);
      if (l && (x * dir[0] + y * dir[1] + z * dir[2]) / l >= cos) out.push(idx[t], idx[t + 1], idx[t + 2]);
    }
    return { pos, idx: Uint32Array.from(out) };
  },

  // The same mesh seen from its other side.
  flip({ pos, idx }) {
    const out = idx.slice();
    for (let t = 0; t < out.length; t += 3) { out[t + 1] = idx[t + 2]; out[t + 2] = idx[t + 1]; }
    return { pos, idx: out };
  },

  // Splits edges longer than maxEdge at their middles until none is, keeping neighbouring
  // triangles joined. A triangle with one long edge becomes two, with two becomes three (its four-
  // sided part cut along the shorter diagonal), with three becomes four. Long thin triangles get
  // cut across, so they end up about maxEdge / 2 to maxEdge on a side. Null if it would need more
  // than maxVerts vertices.
  refine({ pos, idx }, maxEdge, maxVerts = 2e6) {
    const P = Array.from(pos);
    let T = idx;
    const L2 = maxEdge * maxEdge, K = maxVerts + 1;
    const len2 = (a, b) => (P[a * 3] - P[b * 3]) ** 2 + (P[a * 3 + 1] - P[b * 3 + 1]) ** 2 + (P[a * 3 + 2] - P[b * 3 + 2]) ** 2;
    for (;;) {
      const mid = new Map();
      // The vertex in the middle of edge a-b if it is too long, otherwise -1.
      const split = (a, b) => {
        if (len2(a, b) <= L2) return -1;
        const key = a < b ? a * K + b : b * K + a;
        let m = mid.get(key);
        if (m === undefined) {
          m = P.length / 3;
          mid.set(key, m);
          P.push((P[a * 3] + P[b * 3]) / 2, (P[a * 3 + 1] + P[b * 3 + 1]) / 2, (P[a * 3 + 2] + P[b * 3 + 2]) / 2);
        }
        return m;
      };
      const out = [];
      for (let t = 0; t < T.length; t += 3) {
        let a = T[t], b = T[t + 1], c = T[t + 2];
        let ab = split(a, b), bc = split(b, c), ca = split(c, a);
        if (P.length / 3 > maxVerts) return null;
        const n = (ab >= 0) + (bc >= 0) + (ca >= 0);
        if (n === 0) { out.push(a, b, c); continue; }
        if (n === 3) { out.push(a, ab, ca, ab, b, bc, ca, bc, c, ab, bc, ca); continue; }
        // Turn the triangle round so that a-b is split, and for two splits b-c too.
        for (let r = 0; r < 3 && !(ab >= 0 && (n === 1 || bc >= 0)); r++) {
          [a, b, c] = [b, c, a];
          [ab, bc, ca] = [bc, ca, ab];
        }
        if (n === 1) { out.push(a, ab, c, ab, b, c); continue; }
        out.push(ab, b, bc);
        // The four-sided part a, ab, bc, c.
        if (len2(a, bc) < len2(ab, c)) out.push(a, ab, bc, a, bc, c);
        else out.push(a, ab, c, ab, bc, c);
      }
      if (!mid.size) return { pos: Float64Array.from(P), idx: Uint32Array.from(T) };
      T = out;
    }
  },

  // The same mesh with its vertices in order along a curve that keeps near ones together (a Z-order
  // curve), for faster work on the GPU, where neighbouring vertices are worked on together.
  sortVertices({ pos, idx, nrm }) {
    if (pos.length / 3 >= 2 ** 22) return { pos, idx, nrm }; // too many to number in the sort keys
    const n = pos.length / 3, lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < pos.length; i++) { const k = i % 3; lo[k] = Math.min(lo[k], pos[i]); hi[k] = Math.max(hi[k], pos[i]); }
    const span = Math.max(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) || 1;
    // 10 bits per axis, interleaved.
    const spread = (v) => {
      v = (v | (v << 16)) & 0x030000ff; v = (v | (v << 8)) & 0x0300f00f; v = (v | (v << 4)) & 0x030c30c3;
      return (v | (v << 2)) & 0x09249249;
    };
    // Each key with its vertex number below it, so a plain numeric sort puts them in order.
    const key = new Float64Array(n), q = (v, k) => Math.min(1023, Math.floor(((v - lo[k]) / span) * 1024));
    for (let i = 0; i < n; i++) key[i] = ((spread(q(pos[i * 3], 0)) | (spread(q(pos[i * 3 + 1], 1)) << 1) | (spread(q(pos[i * 3 + 2], 2)) << 2)) >>> 0) * 2 ** 22 + i;
    key.sort();
    const order = Uint32Array.from(key, (k) => k % 2 ** 22), at = new Uint32Array(n);
    const P = new pos.constructor(pos.length), N = nrm && new nrm.constructor(nrm.length);
    order.forEach((v, i) => {
      at[v] = i;
      for (let k = 0; k < 3; k++) { P[i * 3 + k] = pos[v * 3 + k]; if (N) N[i * 3 + k] = nrm[v * 3 + k]; }
    });
    return { pos: P, idx: idx.map((v) => at[v]), nrm: N };
  },

  // Unit normals at the vertices: at each corner of a triangle, the average of the triangles round
  // it that face within crease degrees of it, weighted by area. A vertex on a sharper edge becomes
  // one for each side, so that each keeps its own normal. Gives { pos, idx, nrm }.
  splitNormals({ pos, idx }, crease = 40) {
    const nt = idx.length / 3, fn = new Float64Array(nt * 3), fu = new Float64Array(nt * 3);
    for (let t = 0; t < nt; t++) {
      const a = idx[t * 3] * 3, b = idx[t * 3 + 1] * 3, c = idx[t * 3 + 2] * 3;
      const ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2];
      const vx = pos[c] - pos[a], vy = pos[c + 1] - pos[a + 1], vz = pos[c + 2] - pos[a + 2];
      const x = uy * vz - uz * vy, y = uz * vx - ux * vz, z = ux * vy - uy * vx, l = Math.hypot(x, y, z) || 1;
      fn[t * 3] = x; fn[t * 3 + 1] = y; fn[t * 3 + 2] = z;
      fu[t * 3] = x / l; fu[t * 3 + 1] = y / l; fu[t * 3 + 2] = z / l;
    }
    // The triangles round each vertex.
    const nv = pos.length / 3, start = new Uint32Array(nv + 1);
    for (let i = 0; i < idx.length; i++) start[idx[i] + 1]++;
    for (let v = 0; v < nv; v++) start[v + 1] += start[v];
    const fill = start.slice(0, nv), round = new Uint32Array(idx.length);
    for (let i = 0; i < idx.length; i++) round[fill[idx[i]]++] = (i / 3) | 0;
    // The vertices made for each vertex so far: first[v], then next[] (-1 ends).
    const cos = Math.cos((crease * Math.PI) / 180), out = new Uint32Array(idx.length), first = new Int32Array(nv).fill(-1);
    const P = new Float64Array(idx.length * 3), N = new Float32Array(idx.length * 3), next = new Int32Array(idx.length);
    let made = 0;
    for (let i = 0; i < idx.length; i++) {
      const v = idx[i], t = (i / 3) | 0;
      let x = 0, y = 0, z = 0;
      for (let k = start[v]; k < start[v + 1]; k++) {
        const u = round[k];
        if (fu[u * 3] * fu[t * 3] + fu[u * 3 + 1] * fu[t * 3 + 1] + fu[u * 3 + 2] * fu[t * 3 + 2] < cos) continue;
        x += fn[u * 3]; y += fn[u * 3 + 1]; z += fn[u * 3 + 2];
      }
      const l = Math.hypot(x, y, z) || 1;
      x /= l; y /= l; z /= l;
      // Corners of a vertex with nearly the same normal share one.
      let k = first[v];
      while (k >= 0 && N[k * 3] * x + N[k * 3 + 1] * y + N[k * 3 + 2] * z < 0.9998) k = next[k];
      if (k < 0) {
        k = made++;
        next[k] = first[v]; first[v] = k;
        for (let c = 0; c < 3; c++) P[k * 3 + c] = pos[v * 3 + c];
        N[k * 3] = x; N[k * 3 + 1] = y; N[k * 3 + 2] = z;
      }
      out[i] = k;
    }
    return { pos: P.slice(0, made * 3), idx: out, nrm: N.slice(0, made * 3) };
  },
};
