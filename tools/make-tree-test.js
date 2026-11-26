// Writes samples/tree-test.3dm, for checking magic trees: node tools/make-tree-test.js
//   - terrain: a 1 km square sloping 40 m towards the east, with a hill
//   - "Canopy": a floating 3D tree crown (no trunk), 3 to 8 m above its base point, 6 m across;
//     1,600 instances on a 25 m grid, each with its base point 3 m above the ground there, so each
//     crown is 6 to 11 m over the ground, and its ground is looked for from 6.5 m up (a tenth of the
//     way up its box)
//   - "Overhang": a slab 7.5 m over the ground at one canopy: above where its ground is looked for
//     from, below where others in its 102.4 m tile are looked for from (further up the hill), so a
//     tile seen from the highest of those sees the slab first
//   - "Tree 8m": a flat 2D tree symbol, a circle 8 m across, 400 instances at ground level
// Set the magic tree on both blocks (Blocks widget): the canopies should get trunks to the ground
// (the one at the slab too: to the ground, not the slab), the symbols trees 8 m across.
const fs = require('fs');
const path = require('path');
const rhino3dm = require(path.join(__dirname, '../vendor/package/rhino3dm.js'));

const SIZE = 1000, N = 80; // terrain size (m) and cells along each side
const groundZ = (x, y) => 40 * (x / SIZE) + 15 * Math.exp(-((x - 300) ** 2 + (y - 700) ** 2) / (2 * 120 ** 2));

(async () => {
  const rhino = await rhino3dm();
  const doc = new rhino.File3dm();
  doc.settings().modelUnitSystem = rhino.UnitSystem.Meters;

  const layer = (name, rgb) => {
    const l = new rhino.Layer();
    l.name = name; l.color = { r: rgb[0], g: rgb[1], b: rgb[2], a: 255 };
    return doc.layers().add(l);
  };
  const lTerrain = layer('Terrain', [180, 170, 150]), lTrees = layer('Trees', [90, 140, 70]), lSlab = layer('Overhang', [200, 200, 205]);
  const attrs = (l) => { const a = new rhino.ObjectAttributes(); a.layerIndex = l; return a; };

  // Terrain.
  const t = new rhino.Mesh(), step = SIZE / N;
  for (let j = 0; j <= N; j++) for (let i = 0; i <= N; i++) t.vertices().add(i * step, j * step, groundZ(i * step, j * step));
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    const a = j * (N + 1) + i;
    t.faces().addQuadFace(a, a + 1, a + N + 2, a + N + 1);
  }
  t.normals().computeNormals();
  doc.objects().add(t, attrs(lTerrain));

  // A canopy: an octahedron-ish crown, 6 m across, from 3 to 8 m above the base point.
  const crown = new rhino.Mesh();
  const pts = [[0, 0, 3], [3, 0, 5.5], [0, 3, 5.5], [-3, 0, 5.5], [0, -3, 5.5], [0, 0, 8]];
  for (const p of pts) crown.vertices().add(...p);
  for (const [a, b, c] of [[0, 2, 1], [0, 3, 2], [0, 4, 3], [0, 1, 4], [5, 1, 2], [5, 2, 3], [5, 3, 4], [5, 4, 1]]) crown.faces().addTriFace(a, b, c);
  crown.normals().computeNormals();
  const table = doc.instanceDefinitions();
  const define = (name, geometry) => table.get(table.add(name, '', '', '', [0, 0, 0], geometry, [attrs(lTrees)])).id;
  const canopy = define('Canopy', [crown]);

  // A flat symbol: a circle 8 m across.
  const circle = new rhino.Circle(4).toNurbsCurve();
  const symbol = define('Tree 8m', [circle]);

  const place = (id, x, y, z) => doc.objects().addInstanceObject(new rhino.InstanceReference(id, rhino.Transform.translationXYZ(x, y, z)), attrs(lTrees));
  let overhung = null;
  for (let j = 0; j < 40; j++) for (let i = 0; i < 40; i++) {
    const x = 12.5 + i * 25, y = 12.5 + j * 25;
    place(canopy, x, y, groundZ(x, y) + 3);
    if (i === 2 && j === 30) overhung = [x, y];
  }
  for (let j = 0; j < 20; j++) for (let i = 0; i < 20; i++) {
    const x = 25 + i * 50, y = 25 + j * 50 + 6;
    place(symbol, x, y, groundZ(x, y));
  }

  // The slab: 7.5 m over the ground at the overhung canopy, 10 m square, 0.3 m thick.
  const [ox, oy] = overhung, oz = groundZ(ox, oy) + 7.5;
  const slab = new rhino.Mesh();
  for (const [a, b, c] of [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0], [0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]]) slab.vertices().add(ox - 5 + a * 10, oy - 5 + b * 10, oz + c * 0.3);
  for (const q of [[3, 2, 1, 0], [4, 5, 6, 7], [0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7]]) slab.faces().addQuadFace(...q);
  slab.normals().computeNormals();
  doc.objects().add(slab, attrs(lSlab));

  const out = path.join(__dirname, '../samples/tree-test.3dm');
  fs.writeFileSync(out, doc.toByteArray());
  console.log(`Wrote ${out}: overhung canopy at ${ox}, ${oy}, ground ${groundZ(ox, oy).toFixed(2)}, slab at ${oz.toFixed(2)}`);
})().catch((e) => { console.error(e); process.exit(1); });
