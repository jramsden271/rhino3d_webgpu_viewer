// Sun exposure: how often each part of some surfaces can see the sun over a period, ignoring
// cloud. The surfaces are a layer's objects, joined and cut into small triangles (mesh.js) whose
// corners are the points tested; the renderer tests them against the model, as seen from the sun
// at each time.

const EXPOSURE_STEPS = [5, 10, 15, 20, 30, 60]; // minutes between times
const EXPOSURE_SPACINGS = [0.1, 0.2, 0.25, 0.5, 1, 2, 5, 10]; // metres between points, at most
// The most points a surface may have. Not a GPU limit (that is about 4.2 million, the most one
// compute pass can take): preparing the surface freezes the page, for a few seconds at this size,
// and splitting normals at sharp edges can add points after this check and briefly needs a lot of
// memory, so this leaves room.
const EXPOSURE_MAX_POINTS = 2e6;
const EXPOSURE_LIFT = 0.03; // metres: the results are drawn this far in front of the surface
const EXPOSURE_UP_ONLY = 45; // degrees from straight up, at most, for Ground/roof only

// The times in a period, as [{ doy, hour }]: each day from the first to the last of days, at
// hours from the first to the last of hours every step minutes, both ends included. Either pair
// can be in either order.
function exposureTimes({ days, hours, step }) {
  const [d0, d1] = [Math.min(...days), Math.max(...days)], [h0, h1] = [Math.min(...hours), Math.max(...hours)];
  const m0 = Math.round(h0 * 60), m1 = Math.round(h1 * 60), out = [];
  for (let doy = d0; doy <= d1; doy++) for (let m = m0; m <= m1; m += step) out.push({ doy, hour: m / 60 });
  return out;
}

// The sun's directions in model space at the times when it is up. loc: { lat, lon, utcOffset,
// year, north }.
function exposureSunDirs(times, loc) {
  const dirs = [];
  for (const { doy, hour } of times) {
    const p = solarPosition({ ...loc, doy, hour });
    if (p.altitude > 0) dirs.push(sunVector(p.azimuth, p.altitude, loc.north));
  }
  return dirs;
}

// The meshes of a layer's objects: [{ pos, idx, xf }], one list for each object (a block
// instance's geometry is all on its layer here). skip(i): leave out object i.
function exposureLayerMeshes(model, layer, skip) {
  const out = [];
  const walk = (defId, xf, list, depth, active) => {
    const def = model.defs.get(defId);
    if (!def || depth > 24 || active.has(defId)) return;
    active.add(defId);
    for (const e of def.entries) {
      if (e.k === 'inst') walk(e.idef, mulRM(xf, e.xf), list, depth + 1, active);
      else if (e.k === 'mesh') for (const p of e.parts) list.push({ pos: p.pos, idx: p.idx, xf });
    }
    active.delete(defId);
  };
  model.objects.forEach((o, i) => {
    if (o.ai.layer !== layer || skip(i)) return;
    const list = [];
    if (o.k === 'mesh') for (const p of o.parts) list.push({ pos: p.pos, idx: p.idx, xf: o.xf });
    else if (o.k === 'inst') walk(o.idef, o.xf, list, 0, new Set());
    if (list.length) out.push(list);
  });
  return out;
}

// A rough count of the points a spacing gives on an area (from refining test surfaces).
const exposurePointEstimate = (area, spacing) => (2.6 * area) / (spacing * spacing);

// The surface to test: objects (from exposureLayerMeshes) each turned to face up, or down with flip
// (one facing as much down as up, such as a closed object or a wall, keeps the file's sides, or the
// others with flip), then joined and cut so that no edge is longer than spacing. upOnly keeps
// only the faces that, turned up, face within EXPOSURE_UP_ONLY of straight up (before flip). Lengths
// are in model units. Gives
// { pos, nrm (Float32Arrays, at the surface), shown (positions lift in front of it), idx, area }
// or { error }.
function exposureSurface(objects, { spacing, flip, upOnly, lift, weldTol }) {
  if (!objects.length) return { error: 'empty' };
  const faced = objects.map((list) => {
    const m = Meshes.join(list), step = Math.max(1, Math.floor(m.idx.length / 3 / 2000));
    const z = Meshes.areaNormal(m, step)[2], up = Math.abs(z) < 0.01 * Meshes.area(m, step) || z > 0;
    let faced = up ? m : Meshes.flip(m);
    if (upOnly) faced = Meshes.keepFacing(faced, [0, 0, 1], EXPOSURE_UP_ONLY);
    return flip ? Meshes.flip(faced) : faced;
  });
  const joined = Meshes.weld(Meshes.join(faced), weldTol), area = Meshes.area(joined);
  if (!joined.idx.length) return { error: upOnly ? 'noneUp' : 'empty' };
  if (exposurePointEstimate(area, spacing) > EXPOSURE_MAX_POINTS * 1.5) return { error: 'tooMany', area };
  const fine = Meshes.refine(joined, spacing, EXPOSURE_MAX_POINTS);
  if (!fine) return { error: 'tooMany', area };
  const m = Meshes.sortVertices(Meshes.splitNormals(fine)), nrm = m.nrm, pos = Float32Array.from(m.pos), shown = new Float32Array(pos.length);
  for (let i = 0; i < pos.length; i++) shown[i] = pos[i] + nrm[i] * lift;
  return { pos, nrm, shown, idx: m.idx, area };
}

// The area of a surface (from exposureSurface) and how much of it is in sun on average, from the
// percentage at each point (values), in model units squared.
function exposureSummary({ pos, idx }, values) {
  let area = 0, exposed = 0;
  for (let t = 0; t < idx.length; t += 3) {
    const i = idx[t], j = idx[t + 1], k = idx[t + 2], a = i * 3, b = j * 3, c = k * 3;
    const ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2];
    const vx = pos[c] - pos[a], vy = pos[c + 1] - pos[a + 1], vz = pos[c + 2] - pos[a + 2];
    const s = Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) / 2;
    area += s;
    exposed += (s * (Math.min(100, values[i]) + Math.min(100, values[j]) + Math.min(100, values[k]))) / 300;
  }
  return { area, exposed };
}
