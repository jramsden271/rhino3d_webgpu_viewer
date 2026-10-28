// Dev-only: summarise what a .3dm contains and whether Breps carry render meshes.
// usage: node tools/probe.js <file.3dm>
const fs = require('fs');
const path = require('path');
const rhino3dm = require(path.join(__dirname, '../vendor/package/rhino3dm.js'));

(async () => {
  const rhino = await rhino3dm();
  const t0 = Date.now();
  const doc = rhino.File3dm.fromByteArray(new Uint8Array(fs.readFileSync(process.argv[2])));
  console.log('parsed in', Date.now() - t0, 'ms; units', doc.settings().modelUnitSystem.constructor.name, doc.settings().modelUnitSystem.value);
  const objs = doc.objects();
  const types = {}, noMesh = {};
  let idefObjs = 0, tris = 0;
  for (let i = 0; i < objs.count; i++) {
    const o = objs.get(i), g = o.geometry(), a = o.attributes();
    if (a.isInstanceDefinitionObject) idefObjs++;
    const t = Object.keys(rhino.ObjectType).find(k => rhino.ObjectType[k] === g.objectType) || String(g.objectType.value);
    types[t] = (types[t] || 0) + 1;
    let m = null;
    if (t === 'Brep') {
      const f = g.faces(); let ok = true;
      for (let j = 0; j < f.count; j++) { const fm = f.get(j).getMesh(rhino.MeshType.Any); if (!fm) { ok = false; break; } tris += fm.faces().count; }
      if (!ok) noMesh[t] = (noMesh[t] || 0) + 1;
    } else if (t === 'Extrusion') {
      m = g.getMesh(rhino.MeshType.Any); if (!m) noMesh[t] = (noMesh[t] || 0) + 1; else tris += m.faces().count;
    } else if (t === 'Mesh') tris += g.faces().count;
  }
  console.log({ objects: objs.count, idefObjs, layers: doc.layers().count, idefs: doc.instanceDefinitions().count, materials: doc.materials().count, types, noMesh, approxFaces: tris });
})();
