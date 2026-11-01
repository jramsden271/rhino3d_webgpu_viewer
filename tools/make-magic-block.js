// Dev-only: print a magic block's entry for MAGIC_BLOCKS in src/magicblocks.js, to paste in there.
// usage: node tools/make-magic-block.js tree | palm
//          the placeholder deciduous tree or the palm tree, generated here
//        node tools/make-magic-block.js from <file.3dm> <block name> <id> <display name>
//          a block from a model: its meshes on a layer whose path has "shape", "foliage", "leaf" or
//          "leaves" go on the foliage layer and the rest on the trunks layer. Its base point becomes
//          the entry's anchor, so it should be where the trunk meets the ground. Curves and nested
//          blocks are left out, and Breps and extrusions need a render mesh in the file.
const fs = require('fs');
const path = require('path');

const round = (v) => Math.round(v * 1000) / 1000;
const entry = (id, name, parts) => `  { id: '${id}', name: '${name}', fit: 'height', ground: true, randomRotation: true, parts: [\n${parts.map((p) =>
  `    { layer: '${p.layer}',\n      pos: [${p.pos.map(round).join(',')}],\n      idx: [${p.idx.join(',')}] },`).join('\n')}\n  ] },`;

// Positive when a closed mesh's triangles wind outwards.
const volume = (pos, idx) => {
  let v = 0;
  for (let t = 0; t < idx.length; t += 3) {
    const [a, b, c] = [idx[t], idx[t + 1], idx[t + 2]].map((i) => pos.slice(i * 3, i * 3 + 3));
    v += a[0] * (b[1] * c[2] - b[2] * c[1]) + a[1] * (b[2] * c[0] - b[0] * c[2]) + a[2] * (b[0] * c[1] - b[1] * c[0]);
  }
  return v / 6;
};

// Tapered tubes along lists of points ([x, y, z, radius]), each ring being `sides` points.
function tubes() {
  const wood = [], woodIdx = [];
  const tube = (points, sides) => {
    const first = wood.length / 3;
    for (let i = 0; i < points.length; i++) {
      const [x, y, z, r] = points[i], next = points[Math.min(i + 1, points.length - 1)], last = points[Math.max(i - 1, 0)];
      const dir = next.slice(0, 3).map((c, k) => c - last[k]), l = Math.hypot(...dir), n = dir.map((c) => c / l);
      const u = Math.abs(n[2]) > 0.9 ? [1, 0, 0] : [-n[1], n[0], 0], ul = Math.hypot(...u), U = u.map((c) => c / ul);
      const V = [n[1] * U[2] - n[2] * U[1], n[2] * U[0] - n[0] * U[2], n[0] * U[1] - n[1] * U[0]];
      for (let s = 0; s < sides; s++) {
        const a = (s / sides) * 2 * Math.PI, c = Math.cos(a) * r, d = Math.sin(a) * r;
        wood.push(x + U[0] * c + V[0] * d, y + U[1] * c + V[1] * d, z + U[2] * c + V[2] * d);
      }
    }
    for (let i = 0; i + 1 < points.length; i++) for (let s = 0; s < sides; s++) {
      const a = first + i * sides + s, b = first + i * sides + (s + 1) % sides, c = a + sides, d = b + sides;
      woodIdx.push(a, b, d, a, d, c);
    }
    const tip = first + (points.length - 1) * sides;
    for (let s = 1; s + 1 < sides; s++) woodIdx.push(tip, tip + s, tip + s + 1);
  };
  return { wood, woodIdx, tube };
}

// The placeholder tree, in metres: a lumpy crown over a trunk with a few limbs reaching into it, so
// that a leaf-off version can drop the crown.
function placeholderTree() {
  let seed = 7;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;

  // A subdivided icosahedron.
  const t = (1 + Math.sqrt(5)) / 2;
  const verts = [[-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0], [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t], [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1]].map((v) => {
    const l = Math.hypot(...v);
    return v.map((c) => c / l);
  });
  let faces = [[0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11], [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
    [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9], [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1]];
  for (let level = 0; level < 2; level++) {
    const mid = new Map(), between = (a, b) => {
      const key = a < b ? `${a},${b}` : `${b},${a}`;
      if (!mid.has(key)) {
        const m = verts[a].map((c, k) => c + verts[b][k]), l = Math.hypot(...m);
        verts.push(m.map((c) => c / l));
        mid.set(key, verts.length - 1);
      }
      return mid.get(key);
    };
    faces = faces.flatMap(([a, b, c]) => {
      const ab = between(a, b), bc = between(b, c), ca = between(c, a);
      return [[a, ab, ca], [b, bc, ab], [c, ca, bc], [ab, bc, ca]];
    });
  }

  // Pushed out in lumps, as an ellipsoid with a flatter underside.
  const lumps = Array.from({ length: 11 }, () => {
    const z = rnd() * 1.5 - 0.5, a = rnd() * 2 * Math.PI, r = Math.sqrt(Math.max(0, 1 - z * z));
    return { d: [r * Math.cos(a), r * Math.sin(a), z], size: 0.2 + rnd() * 0.22, tight: 7 + rnd() * 8 };
  });
  const CROWN = { z: 5.9, xy: 3, up: 3.1, down: 2.8 };
  const crown = verts.flatMap((v) => {
    let r = 0.78;
    for (const { d, size, tight } of lumps) r += size * Math.exp(tight * (v[0] * d[0] + v[1] * d[1] + v[2] * d[2] - 1));
    const down = v[2] < 0;
    return [v[0] * r * CROWN.xy, v[1] * r * CROWN.xy, CROWN.z + v[2] * Math.min(r, down ? 0.9 : 1) * (down ? CROWN.down : CROWN.up)];
  });
  const crownIdx = faces.flat();

  // Trunk and limbs.
  const { wood, woodIdx, tube } = tubes();
  tube([[0, 0, 0, 0.3], [0.03, 0, 1.3, 0.2], [0, 0.04, 3, 0.16], [-0.05, 0.02, 5.4, 0.06]], 7);
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * 2 * Math.PI + rnd() * 0.5, z = 2.3 + i * 0.32, reach = 1.7 + rnd() * 0.7, c = Math.cos(a), s = Math.sin(a);
    tube([[0, 0, z, 0.1], [c * reach * 0.55, s * reach * 0.55, z + 0.9, 0.065], [c * reach, s * reach, z + 2.1, 0.02]], 4);
  }
  if (volume(crown, crownIdx) <= 0) throw new Error('Inside-out crown');
  return entry('deciduous', 'Deciduous tree', [{ layer: 'foliage', pos: crown, idx: crownIdx }, { layer: 'trunks', pos: wood, idx: woodIdx }]);
}

// A date palm, in metres: a tall bare trunk swelling at the head, under a crown of arching fronds.
// Each frond is a rib with a row of leaflets down each side, one triangle per leaflet, so its outline
// stays feathery on few triangles.
function palmTree() {
  let seed = 11;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const { wood, woodIdx, tube } = tubes();
  const HEAD = [0.16, 0.1, 9.9];
  tube([[0, 0, 0, 0.36], [0.03, 0, 0.9, 0.26], [0.12, 0.05, 4.8, 0.22], [0.14, 0.09, 8.2, 0.24], [0.15, 0.09, 9, 0.44], [HEAD[0], HEAD[1], HEAD[2], 0.2]], 7);

  const FRONDS = 17, LEAFLETS = 7, leaves = [], leafIdx = [];
  for (let f = 0; f < FRONDS; f++) {
    // From the upright young fronds at the top to the drooping old ones below.
    const age = f / (FRONDS - 1), azimuth = f * 2.4 + (rnd() - 0.5) * 0.3;
    const rise = ((78 - 72 * age + (rnd() - 0.5) * 10) * Math.PI) / 180, droop = ((38 + 48 * age + rnd() * 16) * Math.PI) / 180;
    const length = 3.7 + 1.3 * Math.sin(age * Math.PI) + rnd() * 0.4;
    const out = [Math.cos(azimuth), Math.sin(azimuth)], side = [-out[1], out[0]], step = length / LEAFLETS;
    const rib = [[HEAD[0] + out[0] * 0.15, HEAD[1] + out[1] * 0.15, HEAD[2] - 0.45 * age]];
    for (let i = 0; i < LEAFLETS; i++) {
      const a = rise - droop * ((i + 0.5) / LEAFLETS), [x, y, z] = rib[i];
      rib.push([x + out[0] * Math.cos(a) * step, y + out[1] * Math.cos(a) * step, z + Math.sin(a) * step]);
    }
    const first = leaves.length / 3;
    leaves.push(...rib.flat());
    for (let i = 0; i < LEAFLETS; i++) {
      const t = (i + 1) / LEAFLETS, width = (0.2 + 0.5 * Math.sin(Math.min(1, t * 1.25) * Math.PI * 0.9)) * (i === LEAFLETS - 1 ? 0.55 : 1);
      const a = rise - droop * t, ahead = step * 1.1, [x, y, z] = rib[i + 1];
      for (const sign of [1, -1]) {
        leaves.push(x + out[0] * Math.cos(a) * ahead + side[0] * sign * width, y + out[1] * Math.cos(a) * ahead + side[1] * sign * width, z + Math.sin(a) * ahead - width * 0.3);
        const apex = leaves.length / 3 - 1;
        if (sign > 0) leafIdx.push(first + i, first + i + 1, apex);
        else leafIdx.push(first + i + 1, first + i, apex);
      }
    }
  }
  return entry('palm', 'Palm tree', [{ layer: 'foliage', pos: leaves, idx: leafIdx }, { layer: 'trunks', pos: wood, idx: woodIdx }]);
}

async function fromModel(file, blockName, id, name) {
  const rhino = await require(path.join(__dirname, '../vendor/package/rhino3dm.js'))();
  const doc = rhino.File3dm.fromByteArray(new Uint8Array(fs.readFileSync(file)));
  const idefs = doc.instanceDefinitions(), objs = doc.objects(), layers = doc.layers();
  let def = null;
  for (let i = 0; i < idefs.count; i++) if (idefs.get(i).name === blockName) def = idefs.get(i);
  if (!def) throw new Error(`No block called ${blockName}`);
  const toMetres = { Millimeters: 0.001, Centimeters: 0.01, Meters: 1, Kilometers: 1000, Inches: 0.0254, Feet: 0.3048 }[Object.keys(rhino.UnitSystem).find((k) => rhino.UnitSystem[k] === doc.settings().modelUnitSystem)] || 1;
  const parts = { foliage: { layer: 'foliage', pos: [], idx: [] }, trunks: { layer: 'trunks', pos: [], idx: [] } };
  const add = (mesh, part) => {
    const b = mesh.toThreejsBuffers(false), base = part.pos.length / 3;
    part.pos.push(...Array.from(b.position, (v) => v * toMetres));
    part.idx.push(...Array.from(b.index, (i) => i + base));
  };
  for (const oid of def.getObjectIds()) {
    const o = objs.findId(oid), g = o.geometry(), part = /shape|foliage|leaf|leaves/i.test(layers.get(o.attributes().layerIndex).fullPath) ? parts.foliage : parts.trunks;
    if (g.objectType === rhino.ObjectType.Mesh) add(g, part);
    else if (g.objectType === rhino.ObjectType.Extrusion) { const m = g.getMesh(rhino.MeshType.Any); if (m) add(m, part); }
    else if (g.objectType === rhino.ObjectType.Brep) {
      const faces = g.faces();
      for (let f = 0; f < faces.count; f++) { const m = faces.get(f).getMesh(rhino.MeshType.Any); if (m) add(m, part); }
    }
  }
  return entry(id, name, Object.values(parts).filter((p) => p.idx.length));
}

(async () => {
  const [mode, ...args] = process.argv.slice(2);
  console.log(mode === 'tree' ? placeholderTree() : mode === 'palm' ? palmTree() : await fromModel(...args));
})().catch((e) => { console.error(e); process.exit(1); });
