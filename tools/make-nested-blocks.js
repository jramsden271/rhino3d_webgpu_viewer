// Dev-only: write a small model with nested blocks, for testing the Blocks panel.
// usage: node tools/make-nested-blocks.js <out.3dm>
//   Top (2 placed)    holds Middle and Leaf
//   Middle (only nested) holds Leaf twice and a blue box set By object
//   Other (1 placed)  holds Leaf, so Leaf has two parents
//   Leaf (1 placed)   a red box set By object, on layer Parts
//   Plain (1 placed)  a green box By layer on layer Plain, on its own
//   Unused (0 placed) never appears
const fs = require('fs');
const path = require('path');
const rhino3dm = require(path.join(__dirname, '../vendor/package/rhino3dm.js'));

(async () => {
  const rhino = await rhino3dm();
  const doc = new rhino.File3dm();
  doc.settings().modelUnitSystem = rhino.UnitSystem.Meters;
  const layers = doc.layers(), table = doc.instanceDefinitions(), objs = doc.objects();
  const layer = (name, rgb) => { const l = new rhino.Layer(); l.name = name; l.color = { r: rgb[0], g: rgb[1], b: rgb[2], a: 255 }; return layers.add(l); };
  const blocks = layer('Blocks', [255, 200, 0]), parts = layer('Parts', [160, 0, 200]), plain = layer('Plain', [0, 200, 200]);
  const attrs = (layerIndex, rgb) => {
    const a = new rhino.ObjectAttributes();
    a.layerIndex = layerIndex;
    a.colorSource = rgb ? rhino.ObjectColorSource.ColorFromObject : rhino.ObjectColorSource.ColorFromLayer;
    if (rgb) a.objectColor = { r: rgb[0], g: rgb[1], b: rgb[2], a: 255 };
    return a;
  };
  const box = (x, y, z, s = 1) => {
    const m = new rhino.Mesh(), v = m.vertices(), f = m.faces();
    for (const [a, b, c] of [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0], [0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]]) v.add(x + a * s, y + b * s, z + c * s);
    for (const q of [[3, 2, 1, 0], [4, 5, 6, 7], [0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7]]) f.addQuadFace(...q);
    m.normals().computeNormals();
    return m;
  };
  const at = (x, y, z) => rhino.Transform.translationXYZ(x, y, z);
  const define = (name, geometry, attributes) => table.get(table.add(name, '', '', '', [0, 0, 0], geometry, attributes)).id;
  const inst = (id, x, y, z) => new rhino.InstanceReference(id, at(x, y, z));

  const leaf = define('Leaf', [box(0, 0, 0)], [attrs(parts, [255, 0, 0])]);
  const plainBlock = define('Plain', [box(0, 0, 0)], [attrs(plain)]);
  const middle = define('Middle', [inst(leaf, 0, 0, 0), inst(leaf, 2, 0, 0), box(4, 0, 0)], [attrs(parts), attrs(parts), attrs(parts, [0, 0, 255])]);
  const top = define('Top', [inst(middle, 0, 0, 0), inst(leaf, 0, 2, 0)], [attrs(blocks), attrs(blocks)]);
  const other = define('Other', [inst(leaf, 0, 0, 0)], [attrs(blocks)]);
  define('Unused', [box(0, 0, 0)], [attrs(parts)]);

  const place = (id, x, y, a) => objs.addInstanceObject(inst(id, x, y, 0), a);
  place(top, 0, 0, attrs(blocks));
  place(top, 0, 6, attrs(blocks, [255, 128, 0]));
  place(other, 8, 0, attrs(blocks));
  place(leaf, 8, 3, attrs(blocks));
  place(plainBlock, 8, 6, attrs(plain));
  fs.writeFileSync(process.argv[2], doc.toByteArray());
  console.log('wrote', process.argv[2]);
})().catch((e) => { console.error(e); process.exit(1); });
