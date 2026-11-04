// Writes the demo model built into the viewer, for trying it without a Rhino file (on a phone or
// tablet, say). A small site in London: a ground plane, a Building block placed three times and
// a Shade canopy block placed twice, with the location set in the file's Earth anchor point.
// usage: node tools/make-demo.js   writes src/demo.js (the .3dm as base64), and demo.3dm with --3dm
const fs = require('fs');
const path = require('path');
const rhino3dm = require(path.join(__dirname, '../vendor/package/rhino3dm.js'));

(async () => {
  const rhino = await rhino3dm();
  const doc = new rhino.File3dm();
  doc.settings().modelUnitSystem = rhino.UnitSystem.Meters;
  const ea = doc.settings().earthAnchorPoint;
  ea.earthBasepointLatitude = 51.5074;
  ea.earthBasepointLongitude = -0.1278;
  ea.name = 'London';
  doc.settings().earthAnchorPoint = ea;

  const layers = doc.layers(), table = doc.instanceDefinitions(), objs = doc.objects();
  const layer = (name, rgb) => { const l = new rhino.Layer(); l.name = name; l.color = { r: rgb[0], g: rgb[1], b: rgb[2], a: 255 }; return layers.add(l); };
  const ground = layer('Ground', [150, 160, 140]), buildings = layer('Buildings', [225, 215, 195]), shades = layer('Shades', [245, 245, 245]);
  const attrs = (layerIndex) => { const a = new rhino.ObjectAttributes(); a.layerIndex = layerIndex; return a; };
  // A box from (x0, y0, z0) to (x1, y1, z1), as a mesh with outward faces.
  const box = (x0, y0, z0, x1, y1, z1) => {
    const m = new rhino.Mesh(), v = m.vertices(), f = m.faces();
    for (const [x, y, z] of [[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0], [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]]) v.add(x, y, z);
    for (const q of [[3, 2, 1, 0], [4, 5, 6, 7], [0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7]]) f.addQuadFace(...q);
    m.normals().computeNormals();
    return m;
  };
  const define = (name, geometry, layerIndex) => table.get(table.add(name, '', '', '', [0, 0, 0], geometry, geometry.map(() => attrs(layerIndex)))).id;
  const place = (id, x, y, degrees = 0, layerIndex) => {
    const t = rhino.Transform.multiply(rhino.Transform.translationXYZ(x, y, 0), rhino.Transform.rotation(degrees * Math.PI / 180, [0, 0, 1], [0, 0, 0]));
    objs.add(new rhino.InstanceReference(id, t), attrs(layerIndex));
  };

  // The ground: a thin slab, so it has a top to analyse and casts no odd shadow.
  objs.add(box(-40, -30, -0.2, 40, 30, 0), attrs(ground));
  // A building 14 × 10 m and 12 m tall, its corner at the block's origin.
  const building = define('Building', [box(0, 0, 0, 14, 10, 12)], buildings);
  place(building, -30, 6, 0, buildings);
  place(building, -8, 10, 0, buildings);
  place(building, 18, -4, 30, buildings);
  // A shade canopy: a 6 × 3 m roof 3 m up, on four posts.
  const p = 0.15, posts = [[0, 0], [6 - p, 0], [6 - p, 3 - p], [0, 3 - p]].map(([x, y]) => box(x, y, 0, x + p, y + p, 2.9));
  const shade = define('Shade', [box(-0.3, -0.3, 2.9, 6.3, 3.3, 3.05), ...posts], shades);
  place(shade, -14, -12, 0, shades);
  place(shade, -2, -14, 15, shades);

  const bytes = doc.toByteArrayOptions(new rhino.File3dmWriteOptions());
  const out = path.join(__dirname, '../src/demo.js');
  fs.writeFileSync(out, `// The demo model (London, a few blocks and shades), written by tools/make-demo.js: don't edit.\nconst DEMO_3DM = '${Buffer.from(bytes).toString('base64')}';\n`);
  console.log(`Wrote ${out} (${(bytes.length / 1024).toFixed(1)} KB of .3dm)`);
  if (process.argv.includes('--3dm')) fs.writeFileSync(path.join(__dirname, '../demo.3dm'), bytes);
})();
