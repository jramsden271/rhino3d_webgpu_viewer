// Converts a parsed rhino3dm File3dm into flat, GPU-ready batches grouped by layer + colour.
//
// Precision: everything is expressed relative to `origin` (the model bounding-box centre).
// Top-level geometry is translated inside rhino3dm (double precision) before being read out
// as float32; block-definition geometry is read in its local coordinates and transformed in
// JS doubles. This keeps site-coordinate models (e.g. 6-digit eastings) free of float jitter.

const MAX_BATCH_VERTS = 4_000_000;
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
    this.pos = []; this.nrm = []; this.col = []; this.idx = []; this.oid = [];
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

  finish() {
    const all = this.done.concat([...this.open.values()]);
    return all.filter((a) => a.nv > 0).map((a) => {
      const b = { kind: a.kind, layers: a.layers, layer: a.layer, color: a.color, mat: a.mat, vc: a.vc, cls: a.cls, matSet: a.matSet,
        cLayer: a.cLayer, cMatLayer: a.cMatLayer, mLayer: a.mLayer, count: a.ni || a.nv };
      b.position = concat(Float32Array, a.pos, a.nv * 3);
      b.objectId = concat(Uint32Array, a.oid, a.nv);
      if (a.kind === 'mesh') {
        b.normal = concat(Int16Array, a.nrm, a.nv * 4);
        b.index = concat(Uint32Array, a.idx, a.ni);
        if (a.vc) b.vcolor = concat(Uint8Array, a.col, a.nv * 4);
      }
      return b;
    });
  }
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
// whenever an object's colour or material source changes or a block is exploded, without
// re-reading the file.

async function extractModel(rhino, doc, onProgress) {
  const scene = await extractScene(rhino, doc, onProgress);
  onProgress?.(1, 'Building batches');
  await tick();
  scene.batches = buildBatches(scene);
  return scene;
}

async function extractScene(rhino, doc, onProgress) {
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

  // Attribute snapshot: plain values, so items and block definitions outlive the document.
  // cs colour source (0 layer, 1 object, 2 material, 3 parent); ms material source (0 layer,
  // 1 object, 2 parent); oc object colour; mi object material index.
  const attrInfo = (a) => ({ layer: a.layerIndex, cs: a.colorSource.value, oc: rgbOf(a.objectColor), ms: a.materialSource.value, mi: a.materialIndex, name: a.name || '' });
  const userText = (a) => {
    try { return (a.getUserStrings() || []).filter(([k]) => !k.startsWith('$')); } catch (e) { return []; }
  };

  // Origin ------------------------------------------------------------------------------------
  const bb = objects.getBoundingBox();
  const origin = bb && bb.isValid ? bb.center : [0, 0, 0];
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
      const base = { ai, src: oid, type: TYPE_LABEL[tn] || tn, userText: userText(a) };
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
  for (let i = 0; i < total; i++) {
    if (i % 150 === 0) { onProgress?.(i / total, `Converting geometry ${i.toLocaleString()} / ${total.toLocaleString()}`); await tick(); }
    const o = objects.get(i), a = o.attributes();
    if (a.isInstanceDefinitionObject || a.mode.value === 3 || a.mode.value === 1 || !a.visible) continue;
    if (a.activeSpace && a.activeSpace.value === 2) continue; // layout / page space
    const g = o.geometry(), tn = enumName(g.objectType), ai = attrInfo(a);
    const it = { id: a.id, key: a.id, name: ai.name, type: TYPE_LABEL[tn] || tn, block: '', userText: userText(a), ai, ai0: { ...ai },
      seed: seedOf(i, 0.5, 0.25), xf: null, chain: '' };
    if (tn === 'InstanceReference') {
      const fileXf = xformOf(g.xform);
      Object.assign(it, { k: 'inst', idef: g.parentIdefId, xf: mulRM(originXf, fileXf), fileXf, block: getIdef(g.parentIdefId).name });
      it.seed = seedOf(it.xf[3], it.xf[7], it.xf[11]);
    } else if (tn === 'Curve') {
      const s = []; sampleCurve(g, s);
      for (let j = 0; j < s.length; j += 3) { s[j] -= origin[0]; s[j + 1] -= origin[1]; s[j + 2] -= origin[2]; }
      Object.assign(it, { k: 'line', segs: Float32Array.from(s) });
    } else if (tn === 'Point') {
      Object.assign(it, { k: 'point', p: Float32Array.from(V3.sub(g.location, origin)) });
    } else if (MESH_TYPES.includes(tn)) {
      Object.assign(it, { k: 'mesh', parts: meshParts(g, tn, true) });
    } else {
      skip('unsupported', tn);
      continue;
    }
    items.push(it);
  }
  return { origin, units: enumName(doc.settings().modelUnitSystem), layers, materials, defs, items, fileItems: items.length,
    stats, location: readLocation(doc), objects: items };
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

// An object's colour and material from its attributes, its layer, and (inside a block) the
// enclosing instance's resolved look. Also records where each came from, so that layer edits made
// in the viewer apply without a rebuild: cLayer = the colour is that layer's display colour;
// cMatLayer = the colour is that layer's material colour ("by material"); mLayer = the material
// is that layer's render material. mi is the material index (-1 = Rhino's default material).
function resolveLook(scene, ai, parent) {
  const L = scene.layers[ai.layer] ? ai.layer : 0, layer = scene.layers[L] || { rgb: [0, 0, 0], material: -1 };
  let mi, mLayer = -1;
  if (ai.ms === 1) mi = ai.mi;
  else if (ai.ms === 2 && parent) { mi = parent.mi; mLayer = parent.mLayer; }
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
    growBox(p, c);
    rec.triangles += part.idx.length / 3;
    a.pos.push(p);
    a.oid.push(oids(c, n, objId));
    if (c && (c.nrmFrom !== nrm || c.seed !== seed)) Object.assign(c, { packed: packNormals(nrm, part.pos, part.idx, null, seed), nrmFrom: nrm, seed });
    a.nrm.push(c ? c.packed : packNormals(nrm, part.pos, part.idx, xf, seed));
    if (vc) {
      const c8 = new Uint8Array(n * 4), stride = part.col.length / n;
      for (let i = 0; i < n; i++) {
        c8[i * 4] = part.col[i * stride] * 255; c8[i * 4 + 1] = part.col[i * stride + 1] * 255;
        c8[i * 4 + 2] = part.col[i * stride + 2] * 255; c8[i * 4 + 3] = 255;
      }
      a.col.push(c8);
    }
    const idx = new Uint32Array(part.idx.length);
    for (let i = 0; i < idx.length; i++) idx[i] = part.idx[i] + a.nv;
    a.idx.push(idx);
    a.nv += n; a.ni += idx.length;
    stats.triangles += idx.length / 3;
    if (part.edges) emitLines('edge', part.edges, layerSet, look, xf, objId, cls, layer, part);
  };
  const emitLines = (kind, segs, layerSet, look, xf, objId, cls = 0, layer = layerSet[0], holder = null) => {
    const n = segs.length / 3;
    if (!n) return;
    const a = batcher.get(kind, layerSet, kind === 'edge' ? [0, 0, 0, 1] : colorKey(look.rgb), null, false, n, cls, look.matSet, layer,
      kind === 'edge' ? { cLayer: -1, cMatLayer: -1, mLayer: look.mLayer } : look);
    const p = xformPoints(segs, xf), c = holder && cacheOf(holder, kind + 'Cache', xf);
    if (kind !== 'edge') growBox(p, c);
    a.pos.push(p);
    a.oid.push(oids(c, n, objId));
    a.nv += n;
  };
  const emitPoint = (pt, layerSet, look, xf, objId) => {
    const a = batcher.get('point', layerSet, colorKey(look.rgb), null, false, 1, 0, false, layerSet[0], look);
    const p = xformPoints(pt, xf);
    growBox(p);
    a.pos.push(p);
    a.oid.push(new Uint32Array([objId]));
    a.nv += 1;
    stats.points++;
  };
  const instantiate = (idefId, xf, parentLook, layerChain, depth, objId) => {
    const def = defs.get(idefId);
    if (!def || depth > 24) return;
    const seed = seedOf(xf[3], xf[7], xf[11]);
    for (const e of def.entries) {
      const look = resolveLook(scene, e.ai, parentLook);
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
  };

  items.forEach((it, objId) => {
    rec = it;
    it.min = [Infinity, Infinity, Infinity]; it.max = [-Infinity, -Infinity, -Infinity]; it.triangles = 0;
    it.layer = it.ai.layer;
    if (it.gone) return;
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
  }
  return batches;
}

// Replace a block instance with the objects inside it (recursively, so nested blocks are
// exploded too) as new top-level items, like Rhino's ExplodeBlock. "By parent" colours and
// materials become the instance's values, so nothing changes on screen; shownRgb(look) gives a
// look's colour as currently displayed (including colours set in the viewer). Returns the new
// item indices.
function explodeItem(scene, index, shownRgb) {
  const it = scene.items[index];
  if (!it || it.k !== 'inst' || it.gone) return [];
  const added = [];
  const path = (l) => (scene.layers[l] ? scene.layers[l].fullPath : '');
  const walk = (idefId, xf, fileXf, parentLook, chain, depth) => {
    const def = scene.defs.get(idefId);
    if (!def || depth > 24) return;
    chain += ' ' + def.name;
    const seed = seedOf(xf[3], xf[7], xf[11]);
    for (const e of def.entries) {
      const look = resolveLook(scene, e.ai, parentLook);
      if (e.k === 'inst') { walk(e.idef, mulRM(xf, e.xf), mulRM(fileXf, e.xf), look, `${chain} ${path(e.ai.layer)} ${e.ai.name}`, depth + 1); continue; }
      const ai = { ...e.ai };
      if (ai.cs === 3) { ai.cs = 1; ai.oc = shownRgb(parentLook); }
      if (ai.ms === 2) { ai.ms = 1; ai.mi = parentLook.mi; }
      const child = { id: '', key: `${it.key}/${added.length}`, name: ai.name, type: e.type, block: '', userText: e.userText, ai, ai0: { ...ai },
        seed, xf, fileXf, chain, src: e.src, from: it.key, k: e.k, parts: e.parts, segs: e.segs, p: e.p };
      added.push(scene.items.push(child) - 1);
    }
  };
  walk(it.idef, it.xf, it.fileXf, it.look || resolveLook(scene, it.ai, null), `${path(it.ai.layer)} ${it.ai.name}`, 0);
  it.gone = true;
  return added;
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
