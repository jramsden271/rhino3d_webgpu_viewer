// Dev-only: run src/extract.js under Node against a .3dm and print a summary.
// usage: node tools/test-extract.js <file.3dm>
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const rhino3dm = require(path.join(__dirname, process.env.W64 ? '../vendor/package/wasm64/rhino3dm.js' : '../vendor/package/rhino3dm.js'));

const src = ['math.js', 'materials.js', 'extract.js'].map((f) => fs.readFileSync(path.join(__dirname, '../src', f), 'utf8')).join('\n');
vm.runInThisContext(src + '\nglobalThis.extractModel = extractModel;');

(async () => {
  const rhino = await rhino3dm();
  const t0 = Date.now();
  const doc = rhino.File3dm.fromByteArray(new Uint8Array(fs.readFileSync(process.argv[2])));
  const t1 = Date.now();
  const m = await extractModel(rhino, doc, null);
  const t2 = Date.now();
  const kinds = {};
  let bytes = 0;
  for (const b of m.batches) {
    kinds[b.kind] = (kinds[b.kind] || 0) + 1;
    for (const k of ['position', 'normal', 'index', 'vcolor']) if (b[k]) bytes += b[k].byteLength;
  }
  const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  for (const b of m.batches) for (let k = 0; k < 3; k++) { mn[k] = Math.min(mn[k], b.min[k]); mx[k] = Math.max(mx[k], b.max[k]); }
  console.log({ parseMs: t1 - t0, extractMs: t2 - t1, units: m.units, origin: m.origin.map((v) => +v.toFixed(2)), batches: kinds, MB: +(bytes / 1e6).toFixed(1),
    bboxRel: [mn.map((v) => +v.toFixed(1)), mx.map((v) => +v.toFixed(1))], stats: m.stats,
    sampleColours: m.batches.slice(0, 4).map((b) => [b.kind, b.color, b.mat]) });
})();

