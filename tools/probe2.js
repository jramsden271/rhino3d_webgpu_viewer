// Dev-only: check value shapes returned by rhino3dm.js
const fs = require('fs');
const path = require('path');
const rhino3dm = require(path.join(__dirname, '../vendor/package/rhino3dm.js'));

(async () => {
  const rhino = await rhino3dm();
  const doc = rhino.File3dm.fromByteArray(new Uint8Array(fs.readFileSync(process.argv[2])));
  const objs = doc.objects();
  console.log('bbox', objs.getBoundingBox().min, objs.getBoundingBox().max);
  console.log('layer0', doc.layers().get(0).color, doc.layers().get(0).fullPath);
  const seen = new Set();
  for (let i = 0; i < objs.count; i++) {
    const o = objs.get(i), g = o.geometry(), a = o.attributes();
    const cn = g.constructor.name;
    if (seen.has(cn)) continue; seen.add(cn);
    console.log('---', cn, 'colorSource', a.colorSource.value, 'objColor', a.objectColor, 'space', a.activeSpace && a.activeSpace.value, 'mode', a.mode.value);
    if (cn === 'InstanceReference') {
      console.log('xform', g.xform.toFloatArray(true), 'idef objs', doc.instanceDefinitions().findId(g.parentIdefId).getObjectIds());
    }
    if (cn === 'Brep') {
      const m = g.faces().get(0).getMesh(rhino.MeshType.Any);
      const b = m.toThreejsBuffers(false);
      console.log('buffers keys', Object.keys(b), b.position.constructor.name, b.position.slice(0, 3), b.index && b.index.length, b.normal && b.normal.length);
      m.translate([-1000, 0, 0]);
      console.log('after translate', m.toThreejsBuffers(false).position.slice(0, 3));
    }
    if (cn.endsWith('Curve')) console.log('degree', g.degree, 'spans', g.spanCount, 'domain', g.domain, 'isPolyline', g.isPolyline());
  }
})();
