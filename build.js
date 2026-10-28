// Builds dist/rhino-viewer.html: one self-contained file with the viewer, rhino3dm.js and its
// WebAssembly binary inlined. Run once (or after editing src/):  node build.js
// Downloads rhino3dm from the npm registry the first time only; afterwards it works offline.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const RHINO3DM_VERSION = '8.35.0';
const root = __dirname;
const vendor = path.join(root, 'vendor', 'package');
const out = path.join(root, 'dist', 'rhino-viewer.html');

async function ensureRhino3dm() {
  const pkg = path.join(vendor, 'package.json');
  if (fs.existsSync(pkg) && JSON.parse(fs.readFileSync(pkg, 'utf8')).version === RHINO3DM_VERSION) return;
  console.log(`Downloading rhino3dm ${RHINO3DM_VERSION} from the npm registry…`);
  const res = await fetch(`https://registry.npmjs.org/rhino3dm/-/rhino3dm-${RHINO3DM_VERSION}.tgz`);
  if (!res.ok) throw new Error(`Download failed: ${res.status}`);
  const tgz = path.join(root, 'vendor', 'rhino3dm.tgz');
  fs.mkdirSync(path.dirname(tgz), { recursive: true });
  fs.writeFileSync(tgz, Buffer.from(await res.arrayBuffer()));
  fs.rmSync(vendor, { recursive: true, force: true });
  execFileSync('tar', ['-xzf', tgz, '-C', path.join(root, 'vendor')]);
}

(async () => {
  await ensureRhino3dm();
  const src = path.join(root, 'src');
  let html = fs.readFileSync(path.join(src, 'index.html'), 'utf8');
  const safe = (js) => js.replace(/<\/script/gi, '<\\/script');

  html = html.replace(/<link rel="stylesheet" href="([^"]+)">/g, (_, f) => `<style>\n${fs.readFileSync(path.join(src, f), 'utf8')}</style>`);

  // rhino3dm ships a 32-bit build (4 GB address space) and a 64-bit (memory64) build for very
  // large files. Both loaders define a global `rhino3dm`, so each is wrapped in its own scope.
  const builds = { w32: vendor, w64: path.join(vendor, 'wasm64') };
  let rhinoTags = '<script>var RHINO3DM_FACTORIES = {}, RHINO3DM_WASM = {};</script>\n';
  for (const [k, dir] of Object.entries(builds)) {
    const loader = fs.readFileSync(path.join(dir, 'rhino3dm.min.js'), 'utf8');
    const wasm = fs.readFileSync(path.join(dir, 'rhino3dm.wasm')).toString('base64');
    rhinoTags += `<script>RHINO3DM_FACTORIES.${k} = (function () {\n${safe(loader)}\nreturn rhino3dm;\n})();</script>\n`;
    rhinoTags += `<script>RHINO3DM_WASM.${k} = "${wasm}";</script>\n`;
  }
  html = html.replace(/<script src="([^"]+)"><\/script>\n?/g, (_, f) => {
    if (f.includes('vendor/')) return rhinoTags;
    return `<script>\n${safe(fs.readFileSync(path.join(src, f), 'utf8'))}\n</script>\n`;
  });

  html = html.replace('<title>3DM Viewer</title>', `<title>3DM Viewer</title>\n<!-- Built ${new Date().toISOString().slice(0, 10)} · rhino3dm ${RHINO3DM_VERSION} (MIT, Robert McNeel & Associates) -->`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, html);
  console.log(`Wrote ${path.relative(root, out)} (${(fs.statSync(out).size / 1e6).toFixed(1)} MB)`);
})().catch((e) => { console.error(e); process.exit(1); });
