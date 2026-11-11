// Converts a parsed rhino3dm File3dm into flat, GPU-ready batches grouped by layer + colour.
//
// Precision: everything is expressed relative to `origin` (the model bounding-box centre).
// Top-level geometry is translated inside rhino3dm (double precision) before being read out
// as float32; block-definition geometry is read in its local coordinates and transformed in
// JS doubles. This keeps site-coordinate models (e.g. 6-digit eastings) free of float jitter.

const MAX_BATCH_VERTS = 4_000_000;
const CHUNKS_ACROSS = 32; // grid cells across the model (a square site; a long thin one has fewer)
const EDGE_COS = Math.cos((30 * Math.PI) / 180);
const MAX_EDGE_TRIS = 2_000_000; // skip crease detection on enormous single meshes
const DEFAULT_MATERIAL = { name: '', rgb: [0.85, 0.84, 0.81], alpha: 1 }; // warm off-white
const NO_REFS = { cLayer: -1, cMatLayer: -1, mLayer: -1 };

const tick = () => new Promise((r) => setTimeout(r, 0));
const enumName = (e) => (e && e.constructor ? e.constructor.name.replace(/^[A-Za-z]+_/, '') : String(e));
const rgbOf = (c) => [c.r / 255, c.g / 255, c.b / 255];

// ---------------------------------------------------------------------------------------------
// Batch accumulation

class Acc {
  constructor(kind, key, layers, color, mat, vc, cls, matSet, layer, refs) {
    Object.assign(this, { kind, key, layers, color, mat, vc, cls, matSet, layer, cLayer: refs.cLayer, cMatLayer: refs.cMatLayer, mLayer: refs.mLayer });
    this.pieces = []; // what was added: { pos, oid, box, and for a mesh nrm, idx (from 0), col }
    this.nv = 0; this.ni = 0;
  }
}

class Batcher {
  constructor() { this.open = new Map(); this.done = []; }

  // cls: magic material of the layer the material comes from (0 = none, see materials.js),
  // used for smooth foliage normals and surface priority; matSet: the model assigns a material;
  // layer: the layer the geometry itself is on; refs: where the colour and material came from
  // ({ cLayer, cMatLayer, mLayer }, see resolveLook), so layer edits can be applied per batch.
  get(kind, layers, color, mat, vc, extraVerts, cls = 0, matSet = false, layer = layers[0], refs = NO_REFS) {
    const key = `${kind}|${layers.join(',')}|${layer}|${color.join(',')}|${mat ? mat.join(',') : ''}|${vc ? 1 : 0}|${cls}|${matSet ? 1 : 0}|${refs.cLayer}|${refs.cMatLayer}|${refs.mLayer}`;
    let a = this.open.get(key);
    if (a && a.nv + extraVerts > MAX_BATCH_VERTS && a.nv > 0) { this.done.push(a); a = null; }
    if (!a) { a = new Acc(kind, key, layers, color, mat, vc, cls, matSet, layer, refs); this.open.set(key, a); }
    return a;
  }

  // Each batch's geometry goes in order of grid cell, with b.ranges saying where each cell's part is
  // ([first index or vertex, count, cell] in turn), so a view can draw only the cells it can see.
  // The cells' boxes are in batches.cells, shared by all the batches.
  finish() {
    const all = this.done.concat([...this.open.values()]).filter((a) => a.nv > 0);
    const cells = chunkCells(all);
    const batches = all.map((a) => {
      const b = { kind: a.kind, layers: a.layers, layer: a.layer, color: a.color, mat: a.mat, vc: a.vc, cls: a.cls, matSet: a.matSet,
        cLayer: a.cLayer, cMatLayer: a.cMatLayer, mLayer: a.mLayer, count: a.ni || a.nv };
      const parts = a.pieces.sort((p, q) => p.cell - q.cell), ranges = [];
      let first = 0, last = -1;
      for (const p of parts) {
        const n = a.ni ? p.idx.length : p.pos.length / 3;
        if (p.cell === last) ranges[ranges.length - 2] += n;
        else ranges.push(first, n, p.cell);
        first += n; last = p.cell;
      }
      b.ranges = Uint32Array.from(ranges);
      b.position = concat(Float32Array, parts.map((p) => p.pos), a.nv * 3);
      b.objectId = concat(Uint32Array, parts.map((p) => p.oid), a.nv);
      if (a.kind === 'mesh') {
        b.normal = concat(Int16Array, parts.map((p) => p.nrm), a.nv * 4);
        const index = (b.index = new Uint32Array(a.ni));
        let o = 0, base = 0;
        for (const { idx, pos } of parts) {
          for (let i = 0; i < idx.length; i++) index[o + i] = idx[i] + base;
          o += idx.length; base += pos.length / 3;
        }
        if (a.vc) b.vcolor = concat(Uint8Array, parts.map((p) => p.col), a.nv * 4);
      }
      return b;
    });
    batches.cells = cells;
    return batches;
  }
}

// Sets each piece's cell, and returns the cells' boxes (6 floats each). A piece goes in the cell its
// middle falls in, on a grid coarse enough for it: each grid's cells are 4 times as wide as the last's,
// so that a wide piece does not stretch the box of a small cell. Cells are numbered as they are met,
// not along the grid: an order along it would draw far things first from some directions, and the
// surfaces drawn over them later would cost much more shading.
function chunkCells(accs) {
  const mn = [Infinity, Infinity], mx = [-Infinity, -Infinity];
  const pieces = accs.flatMap((a) => a.pieces);
  for (const { box } of pieces) if (box[0] <= box[3]) for (let k = 0; k < 2; k++) { mn[k] = Math.min(mn[k], box[k]); mx[k] = Math.max(mx[k], box[k + 3]); }
  const w = mx[0] - mn[0], d = mx[1] - mn[1];
  const size = Math.max(Math.sqrt(w * d) / CHUNKS_ACROSS, Math.max(w, d) / (4 * CHUNKS_ACROSS), 1e-6);
  const found = new Map(), boxes = [];
  for (const p of pieces) {
    // A box with nothing valid in it (bad coordinates) is never culled.
    const b = p.box[0] <= p.box[3] ? p.box : [-Infinity, -Infinity, -Infinity, Infinity, Infinity, Infinity];
    const wide = Math.max(b[3] - b[0], b[4] - b[1]);
    let level = 0, s = size;
    while (wide > 2 * s && s < 1e30) { level++; s *= 4; }
    const key = isFinite(wide) ? `${level}|${Math.floor(((b[0] + b[3]) / 2 - mn[0]) / s)}|${Math.floor(((b[1] + b[4]) / 2 - mn[1]) / s)}` : 'all';
    let id = found.get(key);
    if (id === undefined) {
      found.set(key, (id = boxes.length));
      boxes.push([...b]);
    } else for (let k = 0; k < 3; k++) { boxes[id][k] = Math.min(boxes[id][k], b[k]); boxes[id][k + 3] = Math.max(boxes[id][k + 3], b[k + 3]); }
    p.cell = id;
  }
  // A little larger, so rounding on the GPU cannot leave geometry just outside its box.
  const out = new Float32Array(boxes.length * 6), m = size * 0.01;
  boxes.forEach((b, i) => { for (let k = 0; k < 3; k++) { out[i * 6 + k] = b[k] - m; out[i * 6 + k + 3] = b[k + 3] + m; } });
  return out;
}

function concat(T, parts, n) {
  const out = new T(n);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Geometry helpers

// xf: row-major Float64Array(16) or null (positions already final).
function xformPoints(src, xf) {
  if (!xf) return src instanceof Float32Array ? src : Float32Array.from(src);
  const n = src.length / 3, out = new Float32Array(src.length);
  for (let i = 0; i < n; i++) {
    const x = src[i * 3], y = src[i * 3 + 1], z = src[i * 3 + 2];
    const w = xf[12] * x + xf[13] * y + xf[14] * z + xf[15] || 1;
    out[i * 3] = (xf[0] * x + xf[1] * y + xf[2] * z + xf[3]) / w;
    out[i * 3 + 1] = (xf[4] * x + xf[5] * y + xf[6] * z + xf[7]) / w;
    out[i * 3 + 2] = (xf[8] * x + xf[9] * y + xf[10] * z + xf[11]) / w;
  }
  return out;
}

// The spare 4th component carries a per-object random value (-1..1) used for colour variation.
function packNormals(nrm, pos, idx, xf, seed = 0) {
  const n = pos.length / 3, out = new Int16Array(n * 4), s = Math.round(seed * 32767);
  out.fill(s);
  let src = nrm;
  if (!src || src.length !== pos.length) src = computeNormals(pos, idx);
  for (let i = 0; i < n; i++) {
    let x = src[i * 3], y = src[i * 3 + 1], z = src[i * 3 + 2];
    if (xf) {
      const tx = xf[0] * x + xf[1] * y + xf[2] * z, ty = xf[4] * x + xf[5] * y + xf[6] * z, tz = xf[8] * x + xf[9] * y + xf[10] * z;
      x = tx; y = ty; z = tz;
    }
    const l = Math.hypot(x, y, z) || 1;
    out[i * 4] = (x / l) * 32767; out[i * 4 + 1] = (y / l) * 32767; out[i * 4 + 2] = (z / l) * 32767;
  }
  return out;
}

function computeNormals(pos, idx) {
  const out = new Float32Array(pos.length);
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3;
    const ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2];
    const vx = pos[c] - pos[a], vy = pos[c + 1] - pos[a + 1], vz = pos[c + 2] - pos[a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    for (const v of [a, b, c]) { out[v] += nx; out[v + 1] += ny; out[v + 2] += nz; }
  }
  return out;
}

// Weld coincident vertices with an open-addressing hash on the float bit patterns.
// Returns weld[i] = welded id of vertex i, rep[w] = a source vertex for welded id w, nw = count.
function weldVertices(pos) {
  const nv = pos.length / 3, weld = new Uint32Array(nv), rep = new Uint32Array(nv);
  const bits = new Uint32Array(pos.buffer, pos.byteOffset, pos.length);
  let size = 1; while (size < nv * 2) size <<= 1;
  const mask = size - 1, vslot = new Int32Array(size).fill(-1);
  let nw = 0;
  for (let i = 0; i < nv; i++) {
    const x = bits[i * 3], y = bits[i * 3 + 1], z = bits[i * 3 + 2];
    let h = (Math.imul(x, 73856093) ^ Math.imul(y, 19349663) ^ Math.imul(z, 83492791)) & mask;
    for (;;) {
      const s = vslot[h];
      if (s < 0) { vslot[h] = nw; rep[nw] = i; weld[i] = nw++; break; }
      const r = rep[s] * 3;
      if (bits[r] === x && bits[r + 1] === y && bits[r + 2] === z) { weld[i] = s; break; }
      h = (h + 1) & mask;
    }
  }
  return { weld, rep, nw };
}

// Area-weighted normals averaged across coincident vertices: turns faceted low-poly shapes
// (typically tree canopies) into smoothly shaded ones.
function smoothNormals(pos, idx) {
  const pos32 = pos instanceof Float32Array ? pos : Float32Array.from(pos);
  const { weld, nw } = weldVertices(pos32), acc = new Float64Array(nw * 3);
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3;
    const ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2];
    const vx = pos[c] - pos[a], vy = pos[c + 1] - pos[a + 1], vz = pos[c + 2] - pos[a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    for (const v of [idx[t], idx[t + 1], idx[t + 2]]) { const w = weld[v] * 3; acc[w] += nx; acc[w + 1] += ny; acc[w + 2] += nz; }
  }
  const out = new Float32Array(pos.length);
  for (let i = 0; i < weld.length; i++) { const w = weld[i] * 3; out[i * 3] = acc[w]; out[i * 3 + 1] = acc[w + 1]; out[i * 3 + 2] = acc[w + 2]; }
  return out;
}

// Boundary, non-manifold and crease (> 30 deg) edges of one triangle mesh, as a line list.
function featureEdges(pos, idx) {
  const nt = idx.length / 3;
  if (nt === 0 || nt > MAX_EDGE_TRIS) return null;
  const { weld, rep } = weldVertices(pos);
  const fn = new Float32Array(nt * 3), valid = new Uint8Array(nt);
  for (let t = 0; t < nt; t++) {
    const a = idx[t * 3] * 3, b = idx[t * 3 + 1] * 3, c = idx[t * 3 + 2] * 3;
    const ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2];
    const vx = pos[c] - pos[a], vy = pos[c + 1] - pos[a + 1], vz = pos[c + 2] - pos[a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx, l = Math.hypot(nx, ny, nz);
    if (l > 0) { fn[t * 3] = nx / l; fn[t * 3 + 1] = ny / l; fn[t * 3 + 2] = nz / l; valid[t] = 1; }
  }
  // Edge table (open addressing): welded endpoints a < b, first two faces and a use count.
  let size = 1; while (size < nt * 4) size <<= 1;
  const emask = size - 1, ea = new Int32Array(size).fill(-1), eb = new Int32Array(size), f1 = new Int32Array(size), f2 = new Int32Array(size), cnt = new Int32Array(size);
  for (let t = 0; t < nt; t++) {
    if (!valid[t]) continue;
    for (let e = 0; e < 3; e++) {
      let a = weld[idx[t * 3 + e]], b = weld[idx[t * 3 + ((e + 1) % 3)]];
      if (a === b) continue;
      if (a > b) { const s = a; a = b; b = s; }
      let h = (Math.imul(a, 73856093) ^ Math.imul(b, 19349663)) & emask;
      while (ea[h] >= 0 && (ea[h] !== a || eb[h] !== b)) h = (h + 1) & emask;
      if (ea[h] < 0) { ea[h] = a; eb[h] = b; f1[h] = t; cnt[h] = 1; }
      else { if (cnt[h] === 1) f2[h] = t; cnt[h]++; }
    }
  }
  const out = [];
  for (let h = 0; h < size; h++) {
    if (ea[h] < 0) continue;
    if (cnt[h] === 2) {
      const p = f1[h] * 3, q = f2[h] * 3;
      if (fn[p] * fn[q] + fn[p + 1] * fn[q + 1] + fn[p + 2] * fn[q + 2] >= EDGE_COS) continue;
    }
    const a = rep[ea[h]] * 3, b = rep[eb[h]] * 3;
    out.push(pos[a], pos[a + 1], pos[a + 2], pos[b], pos[b + 1], pos[b + 2]);
  }
  return out.length ? Float32Array.from(out) : null;
}

// Sample a curve into a line list (pairs of points), in the curve's own coordinates (doubles).
function sampleCurve(c, out) {
  const cn = c.constructor.name;
  const strip = (pts) => { for (let i = 1; i < pts.length; i++) out.push(...pts[i - 1], ...pts[i]); };
  if (cn === 'LineCurve') return strip([c.pointAtStart, c.pointAtEnd]);
  if (cn === 'PolylineCurve') {
    const pts = []; for (let i = 0; i < c.pointCount; i++) pts.push(c.point(i));
    return strip(pts);
  }
  if (cn === 'PolyCurve') {
    for (let i = 0; i < c.segmentCount; i++) { const s = c.segmentCurve(i); if (s) { sampleCurve(s, out); s.delete?.(); } }
    return;
  }
  const [t0, t1] = c.domain;
  if (cn === 'ArcCurve') {
    const n = Math.max(8, Math.ceil((Math.abs(c.angleRadians) / (2 * Math.PI)) * 96));
    const pts = []; for (let i = 0; i <= n; i++) pts.push(c.pointAt(t0 + ((t1 - t0) * i) / n));
    return strip(pts);
  }
  // Generic: sample between distinct knots (span boundaries).
  const nc = cn === 'NurbsCurve' ? c : c.toNurbsCurve();
  if (!nc) return strip([c.pointAtStart, c.pointAtEnd]);
  const kl = nc.knots(), ts = [];
  for (let i = 0; i < kl.count; i++) { const k = kl.get(i); if (k >= t0 && k <= t1 && (!ts.length || k - ts[ts.length - 1] > 1e-12)) ts.push(k); }
  if (ts[0] > t0) ts.unshift(t0);
  if (ts[ts.length - 1] < t1) ts.push(t1);
  const per = c.degree <= 1 ? 1 : Math.max(2, Math.min(16, Math.ceil(400 / ts.length)));
  const pts = [];
  for (let s = 0; s < ts.length - 1; s++)
    for (let j = 0; j < per; j++) pts.push(c.pointAt(ts[s] + ((ts[s + 1] - ts[s]) * j) / per));
  pts.push(c.pointAt(t1));
  if (nc !== c) nc.delete?.();
  strip(pts);
}

const meshBuffers = (m) => {
  const b = m.toThreejsBuffers(false);
  return { pos: b.position, nrm: b.normal, idx: b.index, col: b.color || null };
};

// ---------------------------------------------------------------------------------------------
// Main entry
//
// Reading a model has two stages. extractScene() reads the file once into plain JS data: layers,
// materials, block definitions and one item per top-level object, with geometry already meshed.
// buildBatches() turns that into GPU batches using each item's current attributes; it runs again
// whenever an object's colour or material source changes, without re-reading the file.

// origin: the point geometry is measured from. A file read to be shown with others takes the first file's
// origin, so the files share coordinates; by default it is the middle of the file's objects.
async function extractModel(rhino, doc, onProgress, origin = null) {
  const scene = await extractScene(rhino, doc, onProgress, origin);
  onProgress?.(1, 'Building batches');
  await tick();
  scene.batches = buildBatches(scene);
  return scene;
}

// The scene for several files shown together: each part's layers, materials, block definitions, objects
// and lights come after the ones before them, with their layer and material numbers moved along. The
// parts share one origin (see extractModel). Batches are built by the caller.
function mergeScenes(parts, names) {
  const sum = (a, b) => { for (const k of Object.keys(b)) a[k] = (a[k] || 0) + b[k]; return a; };
  const out = { origin: parts[0].origin, units: parts[0].units, layers: [], materials: [], magicLayers: {}, defs: new Map(),
    items: [], lights: [], views: [], location: parts.find((p) => p.location)?.location ?? null,
    stats: { objects: 0, triangles: 0, curves: 0, points: 0, instances: 0, unsupported: {}, noRenderMesh: {}, lights: {} } };
  parts.forEach((p, k) => {
    // With several files, each file's top layers sit under a layer named for the file, so the Layers
    // panel shows one group per file (like the magic block layers, it is a layer with no objects of its own).
    const root = names.length > 1 ? out.layers.length : -1;
    if (root >= 0) out.layers.push({ index: root, id: `file-${k}`, parentId: '', name: names[k], fullPath: names[k], rgb: [0.5, 0.5, 0.5],
      visible: true, material: -1, count: 0, parent: -1, materialName: '', materialRgb: DEFAULT_MATERIAL.rgb, materialAlpha: 1, file: true });
    const lOff = out.layers.length, mOff = out.materials.length;
    const shiftAi = (ai) => { if (!ai) return; if (ai.layer >= 0) ai.layer += lOff; if (ai.mi >= 0) ai.mi += mOff; };
    for (const l of p.layers) {
      out.layers.push({ ...l, index: out.layers.length, parent: l.parent >= 0 ? l.parent + lOff : root,
        material: l.material >= 0 ? l.material + mOff : l.material, fullPath: names.length > 1 ? `${names[k]}::${l.fullPath}` : l.fullPath });
    }
    for (const m of p.materials) out.materials.push({ ...m, index: out.materials.length });
    // The magic block layers (by key) are the first file's: each later file's are left in the layers, unused.
    if (k === 0) out.magicLayers = Object.fromEntries(Object.entries(p.magicLayers).map(([key, i]) => [key, i + lOff]));
    for (const it of p.items) { shiftAi(it.ai); shiftAi(it.ai0); out.items.push(it); }
    for (const [id, def] of p.defs) {
      for (const e of def.entries) shiftAi(e.ai);
      if (!out.defs.has(id)) out.defs.set(id, def);
    }
    out.lights.push(...p.lights);
    out.views.push(...(p.views || []));
    for (const key of ['objects', 'triangles', 'curves', 'points', 'instances']) out.stats[key] += p.stats[key] || 0;
    for (const key of ['unsupported', 'noRenderMesh', 'lights']) sum(out.stats[key], p.stats[key] || {});
  });
  out.objects = out.items;
  return out;
}

async function extractScene(rhino, doc, onProgress, originOverride = null) {
  const objects = doc.objects();
  const stats = { objects: 0, triangles: 0, curves: 0, points: 0, instances: 0, unsupported: {}, noRenderMesh: {} };
  const skip = (bucket, name) => (stats[bucket][name] = (stats[bucket][name] || 0) + 1);

  // Layers ------------------------------------------------------------------------------------
  const layerTable = doc.layers(), layers = [], layerById = new Map();
  for (let i = 0; i < layerTable.count; i++) {
    const l = layerTable.get(i);
    layers.push({ index: i, id: l.id, parentId: l.parentLayerId, name: l.name, fullPath: l.fullPath, rgb: rgbOf(l.color),
      visible: l.visible, material: l.renderMaterialIndex, count: 0 });
    layerById.set(l.id, i);
  }
  for (const l of layers) l.parent = layerById.has(l.parentId) ? layerById.get(l.parentId) : -1;

  // Materials ---------------------------------------------------------------------------------
  const matTable = doc.materials(), materials = [];
  for (let i = 0; i < matTable.count; i++) {
    const m = matTable.get(i);
    let d = m.diffuseColor, alpha = 1 - (m.transparency || 0);
    // PBR materials keep their real colour in baseColor; the legacy diffuse is often black.
    try {
      const p = m.physicallyBased();
      if (p && p.supported) { d = p.baseColor; alpha = p.opacity ?? alpha; }
    } catch (e) { /* not a PBR material */ }
    let rgb = Array.isArray(d) || ArrayBuffer.isView(d) ? Array.from(d).slice(0, 3) : d && 'r' in d ? [d.r, d.g, d.b] : null;
    if (rgb && rgb.some((v) => v > 1)) rgb = rgb.map((v) => v / 255);
    materials.push({ index: i, name: m.name || '', rgb: rgb || DEFAULT_MATERIAL.rgb, alpha: Math.min(Math.max(alpha, 0.1), 1) });
  }

  // Layer material as the file defines it (for the layer panel swatch and material dialog).
  for (const l of layers) {
    const m = materials[l.material];
    l.materialName = m ? m.name : '';
    l.materialRgb = m ? m.rgb : DEFAULT_MATERIAL.rgb;
    l.materialAlpha = m ? m.alpha : 1;
  }
  const magicLayers = addMagicLayers(layers, materials);

  // Attribute snapshot: plain values, so items and block definitions outlive the document.
  // cs colour source (0 layer, 1 object, 2 material, 3 parent); ms material source (0 layer,
  // 1 object, 3 parent); oc object colour; mi object material index.
  const attrInfo = (a) => ({ layer: a.layerIndex, cs: a.colorSource.value, oc: rgbOf(a.objectColor), ms: a.materialSource.value, mi: a.materialIndex, name: a.name || '' });
  const userText = (a) => {
    try { return (a.getUserStrings() || []).filter(([k]) => !k.startsWith('$')); } catch (e) { return []; }
  };

  // Origin ------------------------------------------------------------------------------------
  const bb = objects.getBoundingBox();
  const origin = originOverride || (bb && bb.isValid ? bb.center : [0, 0, 0]);
  const negOrigin = [-origin[0], -origin[1], -origin[2]];
  const originXf = new Float64Array([1, 0, 0, -origin[0], 0, 1, 0, -origin[1], 0, 0, 1, -origin[2], 0, 0, 0, 1]);

  // Geometry -> parts (meshes carry their own feature edges) -----------------------------------
  // `shift` translates geometry in rhino3dm first (top-level objects only; mutates the doc).
  const meshParts = (g, typeName, shift) => {
    const parts = [];
    const take = (m) => {
      if (shift) m.translate(negOrigin);
      const p = meshBuffers(m);
      p.edges = featureEdges(p.pos, p.idx);
      parts.push(p);
    };
    if (typeName === 'Mesh') { take(g); return parts; }
    if (typeName === 'Brep') {
      const faces = g.faces();
      let missing = false;
      for (let i = 0; i < faces.count; i++) {
        const f = faces.get(i), m = f.getMesh(rhino.MeshType.Any);
        if (m) { take(m); m.delete?.(); } else missing = true;
        f.delete?.();
      }
      if (missing) skip('noRenderMesh', 'Brep');
      return parts;
    }
    if (typeName === 'Extrusion') {
      const m = g.getMesh(rhino.MeshType.Any);
      if (m) { take(m); m.delete?.(); } else skip('noRenderMesh', 'Extrusion');
      return parts;
    }
    if (typeName === 'SubD') {
      let m = null;
      try { m = rhino.Mesh.createFromSubDControlNet(g); } catch (e) { m = null; }
      if (m) { take(m); m.delete?.(); } else skip('noRenderMesh', 'SubD');
      return parts;
    }
    return parts;
  };
  const MESH_TYPES = ['Brep', 'Extrusion', 'Mesh', 'SubD'];

  // Block definitions are converted once (local coordinates), including nested ones.
  // Entries: { k: 'inst' | 'mesh' | 'line' | 'point', ai, src (object id in the file), type, ... }
  const idefTable = doc.instanceDefinitions(), defs = new Map();
  const getIdef = (id) => {
    if (defs.has(id)) return defs.get(id);
    const def = { name: '', entries: [] };
    defs.set(id, def); // guards against self-referencing definitions
    const idef = idefTable.findId(id);
    if (!idef) return def;
    def.name = idef.name || '';
    for (const oid of idef.getObjectIds()) {
      const o = objects.findId(oid);
      if (!o) continue;
      const g = o.geometry(), a = o.attributes(), tn = enumName(g.objectType), ai = attrInfo(a);
      if (!a.visible) continue;
      const base = { ai };
      if (tn === 'InstanceReference') { getIdef(g.parentIdefId); def.entries.push({ ...base, k: 'inst', idef: g.parentIdefId, xf: xformOf(g.xform) }); }
      else if (tn === 'Curve') { const s = []; sampleCurve(g, s); def.entries.push({ ...base, k: 'line', segs: Float64Array.from(s) }); }
      else if (tn === 'Point') def.entries.push({ ...base, k: 'point', p: Float64Array.from(g.location) });
      else {
        const parts = meshParts(g, tn, false);
        if (parts.length) def.entries.push({ ...base, k: 'mesh', parts });
        else if (!MESH_TYPES.includes(tn)) skip('unsupported', tn);
      }
    }
    return def;
  };

  // Walk the object table ---------------------------------------------------------------------
  // One item per pickable top-level object (a block instance is one object). Its geometry is in
  // origin-relative coordinates (xf null), or in block coordinates with a transform `xf`.
  const items = [];
  const total = objects.count;
  // Rhino's own lights. Point and spot lights become lamps; directional, linear and rectangular
  // lights are counted in the stats but not used.
  const lights = [];
  const readLight = (g, ai) => {
    let style = '';
    try { style = enumName(g.lightStyle); } catch (e) { /* older rhino3dm */ }
    stats.lights = stats.lights || {};
    stats.lights[style || 'Light'] = (stats.lights[style || 'Light'] || 0) + 1;
    if (!g.isEnabled || !(g.isPointLight || g.isSpotLight)) return;
    const c = g.diffuse || { r: 255, g: 255, b: 255 };
    const l = { name: ai.name || g.name || '', p: V3.sub(g.location, origin),
      rgb: [c.r, c.g, c.b].map((v) => (v / 255) ** 2.2), intensity: g.intensity ?? 1 };
    if (g.isSpotLight) {
      // Rhino: spot angle is the cone's half angle; the hot spot is the share of it at full strength.
      const outer = ((g.spotAngleRadians || Math.PI / 4) * 180) / Math.PI;
      Object.assign(l, { dir: V3.norm(g.direction), outer, inner: outer * Math.min(0.95, g.hotSpot ?? 0.5) });
    }
    lights.push(l);
  };
  for (let i = 0; i < total; i++) {
    if (i % 150 === 0) { onProgress?.(i / total, `Converting geometry ${i.toLocaleString()} / ${total.toLocaleString()}`); await tick(); }
    const o = objects.get(i), a = o.attributes();
    if (a.isInstanceDefinitionObject || a.mode.value === 3 || a.mode.value === 1 || !a.visible) continue;
    if (a.activeSpace && a.activeSpace.value === 2) continue; // layout / page space
    const g = o.geometry(), tn = enumName(g.objectType), ai = attrInfo(a);
    const it = { id: a.id, name: ai.name, type: TYPE_LABEL[tn] || tn, block: '', userText: userText(a), ai, ai0: { ...ai },
      seed: seedOf(i, 0.5, 0.25), xf: null };
    if (tn === 'InstanceReference') {
      Object.assign(it, { k: 'inst', idef: g.parentIdefId, xf: mulRM(originXf, xformOf(g.xform)), block: getIdef(g.parentIdefId).name });
      it.seed = seedOf(it.xf[3], it.xf[7], it.xf[11]);
    } else if (tn === 'Curve') {
      const s = []; sampleCurve(g, s);
      for (let j = 0; j < s.length; j += 3) { s[j] -= origin[0]; s[j + 1] -= origin[1]; s[j + 2] -= origin[2]; }
      Object.assign(it, { k: 'line', segs: Float32Array.from(s) });
    } else if (tn === 'Point') {
      Object.assign(it, { k: 'point', p: Float32Array.from(V3.sub(g.location, origin)) });
    } else if (MESH_TYPES.includes(tn)) {
      Object.assign(it, { k: 'mesh', parts: meshParts(g, tn, true) });
    } else if (tn === 'Light') {
      readLight(g, ai);
      continue;
    } else {
      skip('unsupported', tn);
      continue;
    }
    items.push(it);
  }
  return { origin, units: enumName(doc.settings().modelUnitSystem), layers, materials, magicLayers, defs, items,
    stats, location: readLocation(doc), views: readNamedViews(doc, origin), objects: items, lights };
}

const TYPE_LABEL = { Brep: 'Polysurface', Extrusion: 'Extrusion', Mesh: 'Mesh', SubD: 'SubD', InstanceReference: 'Block instance', Curve: 'Curve', Point: 'Point' };
const xformOf = (t) => new Float64Array([t.m00, t.m01, t.m02, t.m03, t.m10, t.m11, t.m12, t.m13, t.m20, t.m21, t.m22, t.m23, t.m30, t.m31, t.m32, t.m33]);
const mulRM = (a, b) => {
  const o = new Float64Array(16);
  for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) { let s = 0; for (let k = 0; k < 4; k++) s += a[r * 4 + k] * b[k * 4 + c]; o[r * 4 + c] = s; }
  return o;
};
// Stable pseudo-random value in -1..1, used to vary colour between objects / block instances.
const seedOf = (a, b, c) => { const s = Math.sin(a * 12.9898 + b * 78.233 + c * 37.719) * 43758.5453; return (s - Math.floor(s)) * 2 - 1; };

// A block definition's setting for its sub-elements, chosen in the viewer: the sources that replace
// each sub-element's own. Without one, they are as in the file.
const SUB_SOURCES = { byParent: { cs: 3, ms: 3 }, byLayer: { cs: 0, ms: 0 } };

// An object's colour and material from its attributes, its layer, and (inside a block) the
// enclosing instance's resolved look. Also records where each came from, so that layer edits made
// in the viewer apply without a rebuild: cLayer = the colour is that layer's display colour;
// cMatLayer = the colour is that layer's material colour ("by material"); mLayer = the material
// is that layer's render material. mi is the material index (-1 = Rhino's default material).
function resolveLook(scene, ai, parent) {
  const L = scene.layers[ai.layer] ? ai.layer : 0, layer = scene.layers[L] || { rgb: [0, 0, 0], material: -1 };
  let mi, mLayer = -1;
  if (ai.ms === 1) mi = ai.mi;
  else if (ai.ms === 3 && parent) { mi = parent.mi; mLayer = parent.mLayer; }
  else { mi = layer.material; mLayer = L; }
  const mat = scene.materials[mi] || DEFAULT_MATERIAL;
  if (mat === DEFAULT_MATERIAL) mi = -1;
  let rgb = layer.rgb, cLayer = -1, cMatLayer = -1;
  if (ai.cs === 1) rgb = ai.oc;
  else if (ai.cs === 2) { rgb = mat.rgb; cMatLayer = mLayer; }
  else if (ai.cs === 3 && parent) ({ rgb, cLayer, cMatLayer } = parent);
  else cLayer = L;
  return { rgb, mat, mi, matSet: mat !== DEFAULT_MATERIAL, cLayer, cMatLayer, mLayer };
}

// The block definitions in use, those a top-level instance reaches: id -> { id, name, tops (object
// indexes of its top-level instances), kids and parents (definition ids), layers (of its own
// objects), copies (in the whole model, counting those inside other blocks) }.
function blockTable(scene) {
  const { defs, items, layers } = scene, out = new Map();
  for (const [id, def] of defs) {
    const inner = def.entries.filter((e) => e.k === 'inst' && defs.has(e.idef)).map((e) => e.idef);
    out.set(id, { id, name: def.name || '(unnamed block)', tops: [], kids: [...new Set(inner)], parents: [], copies: 0,
      layers: [...new Set(def.entries.map((e) => e.ai.layer))].filter((l) => layers[l]) });
  }
  for (const b of out.values()) for (const k of b.kids) out.get(k).parents.push(b.id);
  items.forEach((it, i) => { if (it.k === 'inst') out.get(it.idef)?.tops.push(i); });
  const active = new Set(); // a damaged file could have a block contain itself
  const count = (id, n) => {
    if (active.has(id)) return;
    active.add(id);
    out.get(id).copies += n;
    for (const e of defs.get(id).entries) if (e.k === 'inst' && out.has(e.idef)) count(e.idef, n);
    active.delete(id);
  };
  for (const b of out.values()) if (b.tops.length) count(b.id, b.tops.length);
  return out;
}

// A block definition's box in its own coordinates, sub-blocks included ([x0, y0, z0, x1, y1, z1]), or
// null if it holds no geometry.
function defBox(scene, id) {
  const boxes = (scene.defBoxes ||= new Map());
  if (boxes.has(id)) return boxes.get(id);
  const b = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity], active = new Set();
  const take = (p, xf) => {
    for (let i = 0; i < p.length; i += 3) for (let k = 0; k < 3; k++) {
      const v = xf[k * 4] * p[i] + xf[k * 4 + 1] * p[i + 1] + xf[k * 4 + 2] * p[i + 2] + xf[k * 4 + 3];
      if (v < b[k]) b[k] = v;
      if (v > b[k + 3]) b[k + 3] = v;
    }
  };
  const walk = (defId, xf) => {
    const def = scene.defs.get(defId);
    if (!def || active.has(defId)) return;
    active.add(defId);
    for (const e of def.entries) {
      if (e.k === 'inst') walk(e.idef, mulRM(xf, e.xf));
      else if (e.k === 'mesh') for (const part of e.parts) take(part.pos, xf);
      else take(e.k === 'line' ? e.segs : e.p, xf);
    }
    active.delete(defId);
  };
  walk(id, new Float64Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]));
  const box = b[0] <= b[3] ? b : null;
  boxes.set(id, box);
  return box;
}

// Directions to look for a batch's outermost vertices in, both ways along each: most of them level,
// as models are mostly wide and flat.
const EXTREME_AXES = (() => {
  const axes = [[0, 0, 1]], deg = Math.PI / 180;
  for (const [elevation, count, step] of [[0, 12, 15], [35, 12, 30], [65, 6, 60]]) {
    for (let i = 0; i < count; i++) {
      const a = i * step * deg, c = Math.cos(elevation * deg);
      axes.push([c * Math.cos(a), c * Math.sin(a), Math.sin(elevation * deg)]);
    }
  }
  return Float64Array.from(axes.flat());
})();

// A few vertices on a batch's outline. Its vertex data leaves for the GPU, and these remain for
// zoom extents, which fits them far more tightly than a box around a round or diagonal model.
function extremePoints(p) {
  if (!p.length) return [];
  const a = EXTREME_AXES, n = a.length / 3, lo = new Float64Array(n).fill(Infinity), hi = new Float64Array(n).fill(-Infinity);
  const loAt = new Uint32Array(n), hiAt = new Uint32Array(n);
  for (let i = 0; i < p.length; i += 3) {
    const x = p[i], y = p[i + 1], z = p[i + 2];
    for (let k = 0; k < n; k++) {
      const d = x * a[k * 3] + y * a[k * 3 + 1] + z * a[k * 3 + 2];
      if (d < lo[k]) { lo[k] = d; loAt[k] = i; }
      if (d > hi[k]) { hi[k] = d; hiAt[k] = i; }
    }
  }
  return [...new Set([...loAt, ...hiAt])].map((i) => [p[i], p[i + 1], p[i + 2]]);
}

// Turn the scene's items into GPU batches. Also refreshes per-item and per-layer statistics.
function buildBatches(scene) {
  const { layers, items, defs } = scene, stats = scene.stats;
  Object.assign(stats, { objects: 0, triangles: 0, curves: 0, points: 0, instances: 0 });
  for (const l of layers) l.count = 0;
  const batcher = new Batcher();
  const q = (v) => Math.round(v * 255) / 255;
  const colorKey = (rgb, a = 1) => [q(rgb[0]), q(rgb[1]), q(rgb[2]), a];
  // Magic material (materials.js) of the layer an object's material comes from: as set in the
  // viewer (scene.specialOf), else the automatic match. Objects with their own material have none.
  const specialOf = scene.specialOf || ((l) => matchLayer(layers, l)?.id || 0);
  const specials = layers.map((_, l) => specialOf(l));
  const special = (look) => (look.mLayer >= 0 ? specials[look.mLayer] || 0 : 0);
  // The block settings made in the viewer: a definition's sub-element setting, and whether it is
  // shown. A hidden block's top-level instances stay in the batches, hidden by their object flags.
  const subSetting = scene.subSetting || (() => null), blockShown = scene.blockShown || (() => true);
  // The magic block replacing a definition (magicblocks.js), if any. The ground under its instances
  // is found on the GPU, so not during a build: an instance not yet in scene.magicGround is placed
  // without it, and magicMissing tells the caller to look it up and build again.
  const magicOf = scene.magicOf || (() => null), unit = 1 / (scene.metresPerUnit || 1);
  const magicGround = (scene.magicGround ||= new Map());
  scene.magicPoints = new Map();
  scene.magicMissing = false;

  let rec = null; // the item being emitted
  // Geometry that needs no transform (xf null) is the same on every rebuild, so its bounding
  // box, packed normals and object-id list are cached on it (`c`, a per-geometry cache).
  const boxOf = (p) => {
    let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
    for (let i = 0; i < p.length; i += 3) {
      const x = p[i], y = p[i + 1], z = p[i + 2];
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; if (z < z0) z0 = z; if (z > z1) z1 = z;
    }
    return [x0, y0, z0, x1, y1, z1];
  };
  const growBox = (p, c) => {
    const b = c ? (c.box ||= boxOf(p)) : boxOf(p), mn = rec.min, mx = rec.max;
    for (let k = 0; k < 3; k++) { if (b[k] < mn[k]) mn[k] = b[k]; if (b[k + 3] > mx[k]) mx[k] = b[k + 3]; }
    return b;
  };
  const oids = (c, n, objId) => {
    if (!c) return new Uint32Array(n).fill(objId);
    if (c.oidFor !== objId) { c.oids = new Uint32Array(n).fill(objId); c.oidFor = objId; }
    return c.oids;
  };
  const cacheOf = (holder, key, xf) => (xf ? null : (holder[key] ||= {}));
  // objId: index into items (the pickable top-level object); layer: the geometry's own layer.
  const emitMesh = (part, layerSet, look, xf, cls, seed, objId, layer) => {
    const n = part.pos.length / 3;
    if (!n || !part.idx || !part.idx.length) return;
    const vc = !!part.col;
    const a = batcher.get('mesh', layerSet, colorKey(look.rgb), colorKey(look.mat.rgb, look.mat.alpha), vc, n, cls, look.matSet, layer, look);
    // Vegetation is usually low-poly and faceted; smooth shading reads as soft foliage.
    const nrm = cls === MAT_VEGETATION ? (part.smooth ||= smoothNormals(part.pos, part.idx)) : part.nrm;
    const p = xformPoints(part.pos, xf), c = cacheOf(part, 'meshCache', xf);
    const box = growBox(p, c);
    rec.triangles += part.idx.length / 3;
    if (c && (c.nrmFrom !== nrm || c.seed !== seed)) Object.assign(c, { packed: packNormals(nrm, part.pos, part.idx, null, seed), nrmFrom: nrm, seed });
    const piece = { pos: p, oid: oids(c, n, objId), nrm: c ? c.packed : packNormals(nrm, part.pos, part.idx, xf, seed), idx: part.idx, box };
    if (vc) {
      const c8 = new Uint8Array(n * 4), stride = part.col.length / n;
      for (let i = 0; i < n; i++) {
        c8[i * 4] = part.col[i * stride] * 255; c8[i * 4 + 1] = part.col[i * stride + 1] * 255;
        c8[i * 4 + 2] = part.col[i * stride + 2] * 255; c8[i * 4 + 3] = 255;
      }
      piece.col = c8;
    }
    a.pieces.push(piece);
    a.nv += n; a.ni += part.idx.length;
    stats.triangles += part.idx.length / 3;
    if (part.edges) emitLines('edge', part.edges, layerSet, look, xf, objId, cls, layer, part, box);
  };
  // box: a mesh's edges lie on the mesh, so they take its box.
  const emitLines = (kind, segs, layerSet, look, xf, objId, cls = 0, layer = layerSet[0], holder = null, box = null) => {
    const n = segs.length / 3;
    if (!n) return;
    const a = batcher.get(kind, layerSet, kind === 'edge' ? [0, 0, 0, 1] : colorKey(look.rgb), null, false, n, cls, look.matSet, layer,
      kind === 'edge' ? { cLayer: -1, cMatLayer: -1, mLayer: look.mLayer } : look);
    const p = xformPoints(segs, xf), c = holder && cacheOf(holder, kind + 'Cache', xf);
    a.pieces.push({ pos: p, oid: oids(c, n, objId), box: box || growBox(p, c) });
    a.nv += n;
  };
  const emitPoint = (pt, layerSet, look, xf, objId) => {
    const a = batcher.get('point', layerSet, colorKey(look.rgb), null, false, 1, 0, false, layerSet[0], look);
    const p = xformPoints(pt, xf);
    a.pieces.push({ pos: p, oid: new Uint32Array([objId]), box: growBox(p) });
    a.nv += 1;
    stats.points++;
  };
  const emitMagic = (block, idefId, xf, layerChain, depth, objId) => {
    const box = defBox(scene, idefId);
    if (!box) return;
    const meshes = magicMeshes(block, unit), source = magicSource(box, xf);
    let ground = null;
    if (block.ground) {
      const key = `${source.x.toFixed(3)},${source.y.toFixed(3)},${source.top.toFixed(3)}`;
      scene.magicPoints.set(key, source);
      if (magicGround.has(key)) ground = magicGround.get(key);
      else scene.magicMissing = true;
    }
    const seed = seedOf(source.x, source.y, source.lo), place = magicPlacement(block, source, xf, ground, seed);
    if (depth === 0) rec.magicXf = place;
    for (const m of meshes) {
      const L = scene.magicLayers[m.layer], look = resolveLook(scene, { layer: L, cs: 0, oc: [0, 0, 0], ms: 0, mi: -1 }, null);
      layers[L].count++;
      emitMesh(m, [...new Set([...layerChain, L])].sort((a, b) => a - b), look, place, special(look), seed, objId, L);
    }
  };
  const expanding = new Set(); // a damaged file could have a block contain itself
  const instantiate = (idefId, xf, parentLook, layerChain, depth, objId) => {
    const def = defs.get(idefId);
    if (!def || depth > 24 || expanding.has(idefId)) return;
    const magic = magicOf(idefId);
    if (magic) { emitMagic(magic, idefId, xf, layerChain, depth, objId); return; }
    expanding.add(idefId);
    const seed = seedOf(xf[3], xf[7], xf[11]), sources = SUB_SOURCES[subSetting(idefId)];
    for (const e of def.entries) {
      if (e.k === 'inst' && !blockShown(e.idef)) continue;
      const look = resolveLook(scene, sources ? { ...e.ai, ...sources } : e.ai, parentLook);
      const ls = [...new Set([...layerChain, e.ai.layer])].sort((a, b) => a - b);
      if (layers[e.ai.layer]) layers[e.ai.layer].count++;
      if (e.k === 'inst') {
        stats.instances++;
        instantiate(e.idef, mulRM(xf, e.xf), look, ls, depth + 1, objId);
      } else if (e.k === 'mesh') {
        const cls = special(look);
        for (const p of e.parts) emitMesh(p, ls, look, xf, cls, seed, objId, e.ai.layer);
      }
      else if (e.k === 'line') { stats.curves++; emitLines('line', e.segs, ls, look, xf, objId); }
      else if (e.k === 'point') emitPoint(e.p, ls, look, xf, objId);
    }
    expanding.delete(idefId);
  };

  items.forEach((it, objId) => {
    rec = it;
    it.magicXf = null;
    it.min = [Infinity, Infinity, Infinity]; it.max = [-Infinity, -Infinity, -Infinity]; it.triangles = 0;
    it.layer = it.ai.layer;
    const look = resolveLook(scene, it.ai, null), ls = [it.ai.layer];
    it.look = look;
    it.material = look.matSet ? look.mat.name : '';
    stats.objects++;
    if (layers[it.ai.layer]) layers[it.ai.layer].count++;
    if (it.k === 'inst') {
      stats.instances++;
      instantiate(it.idef, it.xf, look, ls, 0, objId);
    } else if (it.k === 'line') {
      stats.curves++;
      emitLines('line', it.segs, ls, look, it.xf, objId, 0, ls[0], it);
    } else if (it.k === 'point') {
      emitPoint(it.p, ls, look, it.xf, objId);
    } else if (it.k === 'mesh') {
      const cls = special(look);
      for (const p of it.parts) emitMesh(p, ls, look, it.xf, cls, it.seed, objId, it.ai.layer);
    }
  });
  rec = null;

  const batches = batcher.finish();
  for (const b of batches) {
    const bx = boxOf(b.position);
    b.min = bx.slice(0, 3); b.max = bx.slice(3);
    b.extremes = extremePoints(b.position);
  }
  return batches;
}

// The views saved by name in the file, relative to the origin; Camera.fromRhino turns one into a
// camera. Their viewport handles are not freed: delete() on one aborts inside rhino3dm.
function readNamedViews(doc, origin) {
  const views = [];
  try {
    const table = doc.namedViews();
    for (let i = 0; i < table.count; i++) {
      const v = table.get(i), p = v.getViewport();
      views.push({ name: v.name || `View ${i + 1}`, ortho: p.isParallelProjection, eye: V3.sub(p.cameraLocation, origin), dir: V3.norm(p.cameraDirection),
        up: V3.norm(p.cameraUp), target: V3.sub(p.targetPoint, origin), frustum: p.getFrustum() });
    }
  } catch (e) { console.warn('Could not read all the named views', e); }
  return views;
}

// Site location for sun studies: Rhino's Sun settings first (they include date, time and time
// zone), then the Earth anchor point. Returns null when the file has no location.
function readLocation(doc) {
  const settings = doc.settings();
  let sun = null, ea = null;
  try { sun = settings.renderSettings().sun; } catch (e) { /* older files */ }
  try { ea = settings.earthAnchorPoint; } catch (e) { /* older files */ }
  if (sun && (sun.latitude || sun.longitude)) {
    const ok = sun.year > 1900 && sun.month >= 1 && sun.day >= 1;
    return {
      source: 'Rhino sun settings', lat: sun.latitude, lon: sun.longitude, north: sun.north,
      utcOffset: sun.timeZone + (sun.daylightSavingOn ? sun.daylightSavingMinutes / 60 : 0),
      date: ok ? { year: sun.year, month: sun.month, day: sun.day, hour: sun.hours } : null,
    };
  }
  if (ea && ea.earthLocationIsSet() && (ea.earthBasepointLatitude || ea.earthBasepointLongitude)) {
    const n = ea.modelNorth || [0, 1, 0];
    return { source: 'Rhino Earth anchor point', lat: ea.earthBasepointLatitude, lon: ea.earthBasepointLongitude,
      north: (Math.atan2(n[1], n[0]) * 180) / Math.PI, utcOffset: Math.round(ea.earthBasepointLongitude / 15), date: null };
  }
  return null;
}
