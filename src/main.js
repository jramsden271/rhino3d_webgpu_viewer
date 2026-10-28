// App wiring: file loading, input handling, layer panel and toolbar.

const $ = (id) => document.getElementById(id);
const canvas = $('gfx');

const prefs = (() => { try { return JSON.parse(localStorage.getItem('3dm-viewer') || '{}'); } catch (e) { return {}; } })();
const savePrefs = () => { try { localStorage.setItem('3dm-viewer', JSON.stringify({ mode: state.mode, showEdges: state.showEdges, showCurves: state.showCurves, ao: state.ao, specials: state.specials, walk: walker.settings })); } catch (e) { /* storage unavailable */ } };

const state = {
  mode: prefs.mode ?? 1, xray: false, showEdges: true, showCurves: true, showPoints: true, layers: false,
  pointSize: 5, edgeColor: [0.08, 0.09, 0.1, 0.55],
  bgTop: [0.93, 0.94, 0.95, 1], bgBot: [0.78, 0.8, 0.84, 1],
};
// Sun study settings. Location defaults to London until a file provides one.
const today = new Date();
state.sun = {
  on: false, ground: true, panel: false,
  lat: 51.5074, lon: -0.1278, utcOffset: 0, north: 90, place: 'London',
  year: today.getFullYear(), doy: dayOfYear(today.getFullYear(), 6, 21), hour: 12,
  source: 'Default location (London) — the file has no location set',
};
state.ao = typeof prefs.ao === 'boolean' ? prefs.ao : true;
state.specials = typeof prefs.specials === 'boolean' ? prefs.specials : true; // the toolbar's Magic button
const SKY = { top: [0.55, 0.69, 0.86, 1], bottom: [0.87, 0.9, 0.93, 1] };
const STUDIO = { top: [0.93, 0.94, 0.95, 1], bottom: [0.78, 0.8, 0.84, 1] };
const METRES_PER_UNIT = { Millimeters: 0.001, Centimeters: 0.01, Meters: 1, Kilometers: 1000, Inches: 0.0254, Feet: 0.3048, Yards: 0.9144, Miles: 1609.344 };
let lastInput = performance.now();
if (typeof prefs.showEdges === 'boolean') state.showEdges = prefs.showEdges;
if (typeof prefs.showCurves === 'boolean') state.showCurves = prefs.showCurves;
const camera = new Camera();
let shiftDown = false;
const walker = new Walker({
  camera, get renderer() { return renderer; }, bounds: () => visibleBounds(), shift: () => shiftDown,
  mpu: () => METRES_PER_UNIT[model.units] || 1,
  onExit: () => { $('walkHint').hidden = true; $('walkPanel').hidden = true; syncToolbar(); redraw(); },
  onSettings: () => { syncWalkPanel(); savePrefs(); },
  notice: (text, ms = 0) => notice(text, false, ms),
  fade: () => { const f = $('walkFade'); f.classList.add('on'); requestAnimationFrame(() => requestAnimationFrame(() => f.classList.remove('on'))); },
});
if (prefs.walk) Object.assign(walker.settings, prefs.walk);
const BIG_FILE = 150e6; // above this, go straight to the 64-bit reader
let renderer = null, model = null, layerOn = [];

// ---------------------------------------------------------------------------------------------
// Startup

// Does this browser support WebAssembly memory64? (validates a module declaring a 64-bit memory)
const HAS_MEMORY64 = (() => {
  try { return WebAssembly.validate(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 5, 3, 1, 4, 1])); } catch (e) { return false; }
})();
const rhinoModules = {};

// kind: 'w32' or 'w64'. In the built single-file viewer both WASM binaries are inlined as
// base64; when running from src/ only the 32-bit reader is available.
function getRhino(kind) {
  if (typeof RHINO3DM_WASM !== 'object') return (rhinoModules.dev ||= rhino3dm());
  return (rhinoModules[kind] ||= (async () => {
    const bin = atob(RHINO3DM_WASM[kind]), bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return RHINO3DM_FACTORIES[kind]({ wasmBinary: bytes });
  })());
}
const can64 = () => HAS_MEMORY64 && typeof RHINO3DM_WASM === 'object';

async function boot() {
  bindUi();
  try {
    renderer = await Renderer.create(canvas);
  } catch (e) {
    fatal('WebGPU is not available', e.message === 'NO_WEBGPU'
      ? 'This browser does not support WebGPU. Open this file in a current version of Chrome or Microsoft Edge.'
      : 'WebGPU is supported but no compatible graphics adapter was found. Check that hardware acceleration is enabled in the browser settings.');
    return;
  }
  renderer.onLost = (info) => { if (info.reason !== 'destroyed') fatal('The graphics device was lost', 'Reload the page to continue. ' + (info.message || '')); };
  getRhino('w32');
  new ResizeObserver(onResize).observe(canvas);
  onResize();
  requestAnimationFrame(loop);

  const src = new URLSearchParams(location.search).get('model');
  if (src) {
    try {
      showBusy(`Downloading ${src}`, 0);
      const res = await fetch(src);
      if (!res.ok) throw new Error(res.status + ' ' + res.statusText);
      await openBytes(decodeURIComponent(src.split('/').pop()), new Uint8Array(await res.arrayBuffer()));
    } catch (e) { hideBusy(); notice(`Could not load ${src}: ${e.message}`, true); }
  }
}

function onResize() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = Math.max(1, Math.round(canvas.clientWidth * dpr)), h = Math.max(1, Math.round(canvas.clientHeight * dpr));
  renderer.resize(w, h);
  camera.aspect = w / h;
  redraw();
}

function redraw() { if (renderer) renderer.dirty = true; lastInput = performance.now(); }

function frameState() {
  const cam = { eye: camera.eye, forward: camera.forward, right: camera.right, up: camera.up, fov: camera.fov,
    aspect: camera.aspect, ortho: camera.ortho, halfHeight: camera.halfHeight, distance: camera.distance };
  const s = { ...state, viewProj: camera.viewProj(), eye: camera.eye, viewDir: camera.forward, light: camera.lightDir(),
    ortho: camera.ortho, dpr: Math.min(window.devicePixelRatio || 1, 2), showPoints: state.showCurves, sun: null, cam,
  };
  if (!model) return s;
  const [mn, mx] = visibleBounds(), c = V3.scale(V3.add(mn, mx), 0.5), R = Math.max(V3.len(V3.sub(mx, mn)) / 2, 1e-6);
  s.aoMaxRadius = R * 0.04;
  // Look: sky backdrop in sun mode, haze beyond the orbit target (perspective views only).
  const bg = state.sun.on ? SKY : STUDIO;
  s.bgTop = bg.top; s.bgBot = bg.bottom;
  s.edgeColor = state.sun.on ? [0.1, 0.11, 0.13, 0.35] : state.edgeColor;
  s.time = (performance.now() / 1000) % 3600;
  s.metresPerUnit = METRES_PER_UNIT[model.units] || 1;
  s.hazeStart = camera.distance;
  s.hazeDensity = camera.ortho ? 0 : 0.35 / R;
  if (state.sun.on) {
    const pos = sunPosition(), light = sunLight(pos.altitude);
    s.sun = { dir: sunVector(pos.azimuth, pos.altitude, state.sun.north), rgb: light.rgb, sky: light.sky };
    if (light.up > 0 && !state.xray) {
      // Shadows cover the model plus a margin of ground around it for long, low-sun shadows.
      s.shadows = shadowCascades(cam, s.sun.dir, { center: c, radius: R * 1.9, receiverRadius: R * (state.sun.ground ? 1.6 : 1.1) });
      if (state.sun.ground) s.ground = [c[0], c[1], mn[2] - R * 1e-4, R * 1.6];
    }
  }
  return s;
}

function sunPosition() {
  const S = state.sun;
  return solarPosition({ lat: S.lat, lon: S.lon, utcOffset: S.utcOffset, year: S.year, doy: S.doy, hour: S.hour });
}

function loop() {
  // Water ripples animate while someone is using the viewer; after 15 s idle they freeze so an
  // untouched page does not keep the GPU busy.
  if (model && performance.now() - lastInput < 15000 && renderer.hasWater(state.mode)) renderer.dirty = true;
  if (walker.active) {
    walker.update(performance.now());
    renderer.dirty = true; lastInput = performance.now();
    if (!$('walkPanel').hidden) checkSunlight();
  }
  if (renderer.dirty) { renderer.dirty = false; renderer.draw(frameState()); positionInspector(); }
  requestAnimationFrame(loop);
}

// ---------------------------------------------------------------------------------------------
// Loading

// handle: the file's FileSystemFileHandle, when there is one, for the recent files list.
async function openFile(file, handle = null) {
  if (!/\.3dm$/i.test(file.name)) { notice(`${file.name} is not a .3dm file.`, true); return; }
  showBusy(`Reading ${file.name}`, 0.02);
  await Recent.add(handle, file);
  renderRecent();
  await openBytes(file.name, new Uint8Array(await file.arrayBuffer()));
}

async function readModel(kind, name, bytes) {
  showBusy('Starting the Rhino file reader', 0.04);
  const rhino = await getRhino(kind);
  showBusy(`Parsing ${name} (${(bytes.length / 1e6).toFixed(0)} MB)`, 0.06);
  await new Promise((r) => setTimeout(r, 20));
  const doc = rhino.File3dm.fromByteArray(bytes);
  if (!doc) throw new Error('The file could not be read. It may be damaged or not a Rhino model.');
  try {
    return await extractModel(rhino, doc, (f, text) => showBusy(text, 0.08 + f * 0.82));
  } finally {
    doc.delete();
  }
}

async function openBytes(name, bytes) {
  const t0 = performance.now();
  walker.exit();
  clearNotices();
  try {
    let m;
    const first = can64() && bytes.length > BIG_FILE ? 'w64' : 'w32';
    try {
      m = await readModel(first, name, bytes);
      m.reader = first;
    } catch (e) {
      // The 32-bit reader aborts when it runs out of address space; retry with the 64-bit one.
      if (first !== 'w32' || !can64() || !(e instanceof WebAssembly.RuntimeError)) throw e;
      delete rhinoModules.w32;
      m = await readModel('w64', name, bytes);
      m.reader = 'w64';
    }
    model = m;
    model.name = name;
    model.size = bytes.length;
    model.bytes = bytes; // kept so a copy with the viewer's changes can be written
    if (loadEdits()) {
      showBusy('Applying your changes', 0.92);
      await new Promise((r) => setTimeout(r, 20));
      m.batches = buildBatches(m);
    }
    showBusy('Uploading to the GPU', 0.94);
    await new Promise((r) => setTimeout(r, 20));
    Object.assign(renderer, { specialsOn: state.specials, layerMaterials: null, layerColours: null, layerSpecials: null });
    renderer.setModel(m.batches);
    m.batches = null;
    model.loadMs = performance.now() - t0;
    resetObjectState();
    clearHistory();
    $('undoRedo').hidden = false;
    $('fileDialog').hidden = true;
    $('matDialog').hidden = true;
    layerOn = m.layers.map((l) => l.visible);
    applyLayerVisibility();
    buildLayerTree();
    applyLayerMaterials(false);
    applyFileLocation(m.location);
    setView('perspective', true);
    $('drop').hidden = true;
    $('fileName').textContent = name;
    document.title = `${name} · 3DM Viewer`;
    renderFileInfo();
    reportSkipped(m.stats);
  } catch (e) {
    console.error(e);
    notice(`Could not open ${name}: ${e.message || e}`, true);
  } finally {
    hideBusy();
  }
}

function reportSkipped(st) {
  const missing = Object.entries(st.noRenderMesh);
  if (missing.length) {
    const list = missing.map(([k, n]) => `${n.toLocaleString()} ${k}${n > 1 ? (k.endsWith('h') ? 'es' : 's') : ''}`).join(', ');
    notice(`${list} have no render mesh saved in the file and are not shown. In Rhino, open the file in a shaded view and save it normally (not "Save Small"), or run ExtractRenderMesh.`);
  }
  const unsup = Object.entries(st.unsupported).filter(([k]) => !['Annotation', 'Text', 'Leader', 'Hatch', 'TextDot', 'Detail', 'Light', 'ClipPlane'].includes(k));
  if (unsup.length) notice(`Not shown (unsupported type): ${unsup.map(([k, n]) => `${n.toLocaleString()} × ${k}`).join(', ')}.`);
}


// ---------------------------------------------------------------------------------------------
// View helpers

function visibleBounds() {
  const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  const use = renderer.batches.some((b) => b.visible) ? renderer.batches.filter((b) => b.visible) : renderer.batches;
  for (const b of use) for (let k = 0; k < 3; k++) { mn[k] = Math.min(mn[k], b.min[k]); mx[k] = Math.max(mx[k], b.max[k]); }
  return isFinite(mn[0]) ? [mn, mx] : [[-1, -1, -1], [1, 1, 1]];
}

function zoomExtents() {
  if (!model) return;
  const [mn, mx] = visibleBounds();
  camera.setBounds(mn, mx);
  camera.zoomExtents(mn, mx);
  redraw();
}

function setView(name, extents = true) {
  walker.exit();
  camera.setView(name);
  if (extents) zoomExtents();
  syncToolbar();
  redraw();
}

function syncToolbar() {
  const view = camera.ortho ? null : 'perspective';
  document.querySelectorAll('[data-view]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.view === (state.lastView || view))));
  document.querySelectorAll('[data-mode]').forEach((b) => b.setAttribute('aria-pressed', String(+b.dataset.mode === state.mode)));
  $('btnSpecials').setAttribute('aria-pressed', String(state.specials));
  $('btnWalk').setAttribute('aria-pressed', String(walker.active));
  $('btnWalk').disabled = !model || (camera.ortho && !walker.active);
  $('btnSpecials').classList.toggle('inactive', state.mode !== 1);
  document.querySelectorAll('[data-toggle]').forEach((b) => b.setAttribute('aria-pressed', String(!!state[b.dataset.toggle])));
}

// ---------------------------------------------------------------------------------------------
// Layers

function layerEffective(i) {
  for (let l = i; l >= 0; l = model.layers[l].parent) if (!layerOn[l]) return false;
  return true;
}

function applyLayerVisibility() {
  for (const b of renderer.batches) b.visible = b.layers.every((l) => l < 0 || l >= layerOn.length || layerEffective(l));
  redraw();
}

function buildLayerTree() {
  const tree = $('layerTree'), L = model.layers, kids = L.map(() => []), roots = [];
  for (const l of L) (l.parent >= 0 ? kids[l.parent] : roots).push(l.index);
  // Total object count including sub-layers; empty branches are hidden.
  const total = L.map(() => 0);
  const sum = (i) => (total[i] = L[i].count + kids[i].reduce((s, k) => s + sum(k), 0));
  roots.forEach(sum);
  const collapsed = new Set();
  tree.innerHTML = '';
  const caretSvg = '<svg viewBox="0 0 24 24"><path d="m6 9 6 6 6-6"/></svg>';
  const rows = [];
  const add = (i, depth) => {
    if (!total[i]) return;
    const l = L[i], row = document.createElement('div');
    row.className = 'layer-row';
    row.setAttribute('role', 'treeitem');
    row.style.paddingLeft = 10 + depth * 16 + 'px';
    const hasKids = kids[i].some((k) => total[k]);
    row.innerHTML = `<button class="caret ${hasKids ? '' : 'empty'}" aria-label="Expand">${caretSvg}</button>` +
      `<input type="checkbox"><button class="swatch" title="Material for this layer"></button>` +
      `<span class="layer-name"></span><span class="layer-special" hidden></span><span class="layer-count">${total[i].toLocaleString()}</span>`;
    row.querySelector('.layer-name').textContent = l.name;
    row.title = l.fullPath;
    row.querySelector('.swatch').addEventListener('click', (e) => openMaterialDialog(i, e.currentTarget));
    const cb = row.querySelector('input');
    cb.checked = layerOn[i];
    cb.addEventListener('click', (e) => {
      if (e.shiftKey) { // isolate: this layer, its ancestors and descendants
        const keep = new Set();
        for (let a = i; a >= 0; a = L[a].parent) keep.add(a);
        const desc = (k) => { keep.add(k); kids[k].forEach(desc); };
        desc(i);
        layerOn = L.map((_, k) => keep.has(k));
      } else layerOn[i] = cb.checked;
      applyLayerVisibility();
      refreshRows();
    });
    row.querySelector('.caret').addEventListener('click', () => {
      collapsed.has(i) ? collapsed.delete(i) : collapsed.add(i);
      refreshRows();
    });
    row.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const r = row.getBoundingClientRect();
      const at = e.clientX || e.clientY ? [e.clientX, e.clientY] : [r.left + 24, r.bottom]; // context-menu key
      openLayerMenu(i, hasKids ? subtree(i) : null, at);
    });
    tree.appendChild(row);
    rows.push({ i, row, cb });
    kids[i].forEach((k) => add(k, depth + 1));
  };
  const subtree = (i) => { const out = [i]; for (let n = 0; n < out.length; n++) out.push(...kids[out[n]]); return out; };
  roots.forEach((r) => add(r, 0));
  const hiddenByCollapse = (i) => { for (let p = L[i].parent; p >= 0; p = L[p].parent) if (collapsed.has(p)) return true; return false; };
  function refreshRows() {
    for (const { i, row, cb } of rows) {
      cb.checked = layerOn[i];
      row.classList.toggle('off', !layerOn[i]);
      row.classList.toggle('inherited-off', layerOn[i] && !layerEffective(i));
      row.hidden = hiddenByCollapse(i);
      row.querySelector('.caret').classList.toggle('collapsed', collapsed.has(i));
      const sw = row.querySelector('.swatch'), isMat = showsMaterial(), id = model.layers[i].id;
      sw.style.background = isMat ? lookBackground(layerLook(i)) : rgbHex(layerDisplayRgb(i));
      // Ring: set in the viewer ("Always off" alone does not count).
      sw.classList.toggle('edited', isMat ? !!state.layerMat[id] || !!state.layerSpecial[id] : !!state.layerColor[id]);
      sw.title = isMat ? 'Material for this layer (Rendered view)' : 'Display colour for this layer (Shaded view)';
      // Magic material hint, in Rendered view.
      const tag = row.querySelector('.layer-special'), info = isMat && state.specials ? layerSpecialInfo(i) : { id: 0 };
      tag.hidden = !info.id;
      if (info.id) {
        tag.textContent = info.auto ? 'auto' : SPECIAL[info.id].name.toLowerCase();
        tag.title = `Magic material: ${SPECIAL[info.id].name}. ${specialReason(info)}`;
      }
    }
  }
  refreshRows();
  buildLayerTree.refresh = refreshRows;
  // Reveal a layer's row (expanding its parents) and flash it.
  buildLayerTree.reveal = (i) => {
    for (let p = L[i].parent; p >= 0; p = L[p].parent) collapsed.delete(p);
    refreshRows();
    const r = rows.find((x) => x.i === i);
    if (!r) return;
    r.row.scrollIntoView({ block: 'center' });
    r.row.classList.remove('flash'); void r.row.offsetWidth; r.row.classList.add('flash');
  };
}

// Right-click menu for a layer row. `tree` is the layer and all its sub-layers, or null when it
// has none (the sub-layer items are then left out). Selection takes visible objects only.
function openLayerMenu(i, tree, [x, y]) {
  const L = model.layers, menu = $('layerMenu');
  const visibleOn = (layers) => {
    const set = new Set(layers);
    return model.objects.flatMap((o, id) => (!o.gone && set.has(o.layer) && !state.hidden.has(id) && layerEffective(o.layer) ? [id] : []));
  };
  const setOn = (on) => { for (const l of tree || [i]) layerOn[l] = on; applyLayerVisibility(); buildLayerTree.refresh(); renderFileInfo(); };
  const own = visibleOn([i]), all = tree && visibleOn(tree);
  const items = [
    { label: 'Select objects', n: own.length, run: () => selectObjects(own) },
    tree && { label: 'Select sublayer objects', n: all.length, run: () => selectObjects(all) },
    '-',
    { label: 'Show all', run: () => setOn(true) },
    { label: 'Hide all', run: () => setOn(false) },
  ].filter(Boolean);
  menu.innerHTML = '';
  const title = document.createElement('div');
  title.className = 'menu-title';
  title.textContent = title.title = L[i].fullPath;
  menu.appendChild(title);
  for (const it of items) {
    if (it === '-') { menu.appendChild(document.createElement('hr')); continue; }
    const b = document.createElement('button');
    b.setAttribute('role', 'menuitem');
    b.innerHTML = `<span></span>${it.n != null ? `<span class="n">${it.n.toLocaleString()}</span>` : ''}`;
    b.firstChild.textContent = it.label;
    b.disabled = it.n === 0;
    if (b.disabled) b.title = 'No visible objects';
    b.addEventListener('click', () => { closeLayerMenu(); it.run(); });
    menu.appendChild(b);
  }
  menu.hidden = false;
  const w = menu.offsetWidth, h = menu.offsetHeight;
  menu.style.transform = `translate(${Math.max(8, Math.min(x, innerWidth - w - 8))}px, ${Math.max(8, Math.min(y, innerHeight - h - 8))}px)`;
  menu.querySelector('button:not(:disabled)')?.focus();
}

function closeLayerMenu() { $('layerMenu').hidden = true; }

function bindLayerMenu() {
  const menu = $('layerMenu');
  window.addEventListener('pointerdown', (e) => { if (!menu.hidden && !menu.contains(e.target)) closeLayerMenu(); }, true);
  window.addEventListener('blur', closeLayerMenu);
  window.addEventListener('resize', closeLayerMenu);
  $('layerTree').addEventListener('scroll', closeLayerMenu);
  menu.addEventListener('keydown', (e) => {
    const bs = [...menu.querySelectorAll('button:not(:disabled)')], at = bs.indexOf(document.activeElement);
    if (e.key === 'Escape') { e.stopPropagation(); closeLayerMenu(); }
    else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); bs[(at + (e.key === 'ArrowDown' ? 1 : bs.length - 1)) % bs.length]?.focus(); }
  });
}

// ---------------------------------------------------------------------------------------------
// Changes made in the viewer
//
// state.layerColor: layer id -> display colour (sRGB 0..1), used in Shaded view.
// state.layerMat: layer id -> { rgb, alpha, gloss }, the layer's material properties as set in
//   the viewer, used in Rendered view.
// state.layerSpecial: layer id -> magic material (materials.js id, 0 = always off), as chosen
//   in the viewer; layers not listed are Auto (matched by name).
// They follow Rhino's rules: they change only objects whose colour or material comes from that
// layer. state.objEdits: object key -> changed attributes ({ cs, oc, ms, mi }, see resolveLook
// in extract.js). state.exploded: keys of block instances exploded in the viewer, in order.
// Everything is remembered in this browser per model, and can be written into a copy of the .3dm.

const rgbHex = (rgb) => '#' + rgb.map((v) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, '0')).join('');
const hexRgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
const NO_EDITS = () => ({ layerMat: {}, layerColor: {}, layerSpecial: {}, objEdits: {}, exploded: [] });
Object.assign(state, NO_EDITS());

// Swatches and dialogs show materials in Rendered view and display colours otherwise.
const showsMaterial = () => state.mode === 1;

// The material set in the viewer on a layer, or null.
function layerMaterialFor(i) {
  const l = model && model.layers[i];
  return (l && state.layerMat[l.id]) || null;
}

// A layer's display colour (as set in the viewer, else from the file).
function layerDisplayRgb(i) {
  const l = model.layers[i];
  return state.layerColor[l.id] || l.rgb;
}

// A layer's magic material: { id (0 = none), auto (not chosen in the viewer), match (the
// automatic match, see matchLayer in materials.js) }.
function layerSpecialInfo(i) {
  const l = model.layers[i], match = l ? matchLayer(model.layers, i) : null;
  const set = l ? state.layerSpecial[l.id] : undefined;
  return set === undefined ? { id: match?.id || 0, auto: true, match } : { id: set, auto: false, match };
}
const layerSpecialId = (i) => layerSpecialInfo(i).id;

// What a layer's material looks like in Rendered mode, for its swatch and as the dialog's
// starting point. special: the magic material shown (0 when the Magic button is off).
function layerLook(i) {
  const l = model.layers[i], set = layerMaterialFor(i), special = state.specials ? layerSpecialId(i) : 0;
  return {
    rgb: set?.rgb || (special ? SPECIAL[special].rgb : l.materialRgb),
    alpha: set ? set.alpha : special ? 1 : l.materialAlpha,
    gloss: set ? set.gloss : 0,
    special,
  };
}

// Swatch background for a layer's material: two tones when the magic material varies.
function lookBackground(look) {
  const tones = look.special && SPECIAL[look.special].tones;
  if (!tones) return rgbHex(look.rgb);
  const [a, b] = tones.map((k) => rgbHex(look.rgb.map((v, n) => v * k[n])));
  return `linear-gradient(135deg, ${b} 50%, ${a} 50%)`;
}

// How a layer's magic material was decided, in words.
function specialReason(info) {
  if (!info.auto) return info.id ? 'Chosen in this viewer.' : 'Turned off in this viewer.';
  const m = info.match;
  if (!m) return 'No match: the layer name and its material name don’t match any magic material.';
  const where = { name: 'the layer name', parent: 'the parent layer', material: 'the layer’s material' }[m.from];
  return `Matched on ${where} “${m.text}”.`;
}

// An object's colour and material as shown, including layer settings made in the viewer.
// look: from resolveLook (extract.js).
function shownRgb(look) {
  return (look.cLayer >= 0 && state.layerColor[model.layers[look.cLayer]?.id]) || (look.cMatLayer >= 0 && layerMaterialFor(look.cMatLayer)?.rgb) || look.rgb;
}
function shownMaterialRgb(look) {
  return look.mLayer >= 0 ? layerLook(look.mLayer).rgb : look.mat.rgb;
}

const editsKey = () => model && `3dm-viewer:edits:${model.name}:${model.size}`;
const oldMaterialsKey = () => model && `3dm-viewer:materials:${model.name}:${model.size}`;
// Layers whose material or magic material was set in the viewer.
const editedMaterialLayers = () => new Set([...Object.keys(state.layerMat), ...Object.keys(state.layerSpecial)]);
const editCount = () => ({ mat: editedMaterialLayers().size, col: Object.keys(state.layerColor).length,
  obj: Object.keys(state.objEdits).length, expl: state.exploded.length });

function saveEdits() {
  const n = editCount();
  try {
    localStorage.removeItem(oldMaterialsKey());
    if (n.mat + n.col + n.obj + n.expl) {
      const { layerMat, layerColor, layerSpecial, objEdits, exploded } = state;
      localStorage.setItem(editsKey(), JSON.stringify({ layerMat, layerColor, layerSpecial, objEdits, exploded }));
    } else localStorage.removeItem(editsKey());
  } catch (e) { /* storage unavailable: changes last for this session only */ }
}

// Push layer colours and materials to the renderer (no rebuild needed).
function applyLayerMaterials(save = true) {
  if (!model) return;
  model.specialOf = layerSpecialId;
  renderer.setMaterialRules(state.specials, layerMaterialFor,
    (i) => (model.layers[i] && state.layerColor[model.layers[i].id]) || null, layerSpecialId);
  buildLayerTree.refresh?.();
  renderFileInfo();
  if (save) saveEdits();
  redraw();
}

// Rebuild the GPU batches after objects' attributes change or blocks are exploded.
async function rebuildModel() {
  const slow = model.stats.triangles > 400000;
  if (slow) { showBusy('Updating the model', 0.5); await new Promise((r) => setTimeout(r, 20)); }
  try {
    renderer.setModel(buildBatches(model));
  } finally {
    if (slow) hideBusy();
  }
  if (objFlags.length !== model.objects.length) objFlags = new Uint32Array(model.objects.length);
  applyLayerVisibility();
  applyLayerMaterials(false);
  pushObjectFlags();
}

function indexKeys() {
  model.keyIndex = new Map(model.objects.map((o, i) => [o.key, i]));
}

// Put the objects back as they are in the file, then explode blocks (keys, in order) and apply
// attribute changes (object key -> changed attributes). Sets state.exploded and state.objEdits.
// The batches need rebuilding afterwards.
function replayObjectEdits(exploded = [], objEdits = {}) {
  model.objects.length = model.fileItems;
  for (const o of model.objects) { o.ai = { ...o.ai0 }; o.gone = false; }
  state.exploded = [];
  state.objEdits = {};
  indexKeys();
  for (const key of exploded) {
    const i = model.keyIndex.get(key);
    if (i == null || model.objects[i].k !== 'inst' || model.objects[i].gone) continue;
    explodeItem(model, i, shownRgb);
    state.exploded.push(key);
  }
  indexKeys();
  for (const [key, d] of Object.entries(objEdits)) {
    const i = model.keyIndex.get(key);
    if (i == null) continue;
    Object.assign(model.objects[i].ai, d);
    state.objEdits[key] = { ...d };
  }
}

// ---------------------------------------------------------------------------------------------
// Undo and redo, as in Rhino: changes to the model (layer colours, materials and magic materials,
// object colour and material sources, exploded blocks, Revert, the sun's location) can be undone. View changes,
// hiding objects and turning layers on or off are not recorded. Each entry keeps the edit state
// from before the change; undoing swaps it with the current one. Not kept between sessions.

const history = { undo: [], redo: [], coalesce: null };
const UNDO_LIMIT = 100;
const SUN_LOCATION = ['lat', 'lon', 'utcOffset', 'north', 'place', 'source'];
const editSnapshot = () => structuredClone({ layerMat: state.layerMat, layerColor: state.layerColor, layerSpecial: state.layerSpecial, objEdits: state.objEdits, exploded: state.exploded,
  sun: Object.fromEntries(SUN_LOCATION.map((k) => [k, state.sun[k]])) });

// Call before a change. Repeated changes with the same key (dragging a slider or colour picker)
// make one entry, until endUndoGroup() (the control's change event, or the dialog closing).
function recordUndo(label, key = null) {
  if (key && history.coalesce === key) return;
  history.undo.push({ label, edits: editSnapshot() });
  if (history.undo.length > UNDO_LIMIT) history.undo.shift();
  history.redo = [];
  history.coalesce = key;
  syncUndoButtons();
}
function endUndoGroup() { history.coalesce = null; }
function clearHistory() { Object.assign(history, { undo: [], redo: [], coalesce: null }); syncUndoButtons(); }

function syncUndoButtons() {
  const u = history.undo.at(-1), r = history.redo.at(-1);
  $('btnUndo').disabled = !u;
  $('btnRedo').disabled = !r;
  $('btnUndo').title = u ? `Undo: ${u.label} (Ctrl+Z)` : 'Nothing to undo';
  $('btnRedo').title = r ? `Redo: ${r.label} (Ctrl+Y)` : 'Nothing to redo';
}

let historyBusy = false;
async function stepHistory(redo) {
  const [from, to] = redo ? [history.redo, history.undo] : [history.undo, history.redo];
  if (!model || historyBusy || !from.length) return;
  historyBusy = true;
  try {
    const entry = from.pop();
    to.push({ label: entry.label, edits: editSnapshot() });
    history.coalesce = null;
    await restoreEdits(entry.edits);
    notice(`${redo ? 'Redone' : 'Undone'}: ${entry.label}.`, false, 2500);
  } finally {
    historyBusy = false;
    syncUndoButtons();
  }
}

// Make the given edit state current, rebuilding only if objects or foliage normals change.
async function restoreEdits(e) {
  const objectsChange = JSON.stringify([state.exploded, state.objEdits]) !== JSON.stringify([e.exploded, e.objEdits]);
  const vegBefore = model.layers.map((_, i) => layerSpecialId(i) === MAT_VEGETATION).join();
  Object.assign(state, { layerMat: structuredClone(e.layerMat), layerColor: structuredClone(e.layerColor), layerSpecial: structuredClone(e.layerSpecial) });
  const vegChange = vegBefore !== model.layers.map((_, i) => layerSpecialId(i) === MAT_VEGETATION).join();
  if (objectsChange) {
    replayObjectEdits(e.exploded, e.objEdits);
    state.sel = { ids: [], p: null };
    $('inspect').hidden = true; inspectPin = null;
  }
  if (objectsChange || vegChange) await rebuildModel();
  if (objectsChange) buildLayerTree();
  applyLayerMaterials();
  if (!$('matDialog').hidden && matLayer >= 0) openMaterialDialog(matLayer, document.querySelector('.layer-row .swatch') || $('matDialog'));
  if (state.sel.ids.length) showInspector();
  pushObjectFlags();
  if (e.sun) setSun(e.sun);
}

// Restore the changes remembered for this model. Returns true if objects changed (the batches
// then need rebuilding).
function loadEdits() {
  let e = null;
  try { e = JSON.parse(localStorage.getItem(editsKey()) || 'null'); } catch (err) { /* none */ }
  if (!e) try { const old = JSON.parse(localStorage.getItem(oldMaterialsKey()) || 'null'); if (old) e = { layerMat: old }; } catch (err) { /* none */ }
  e = e || {};
  const ids = new Set(model.layers.map((l) => l.id));
  const known = (o) => Object.fromEntries(Object.entries(o || {}).filter(([k]) => ids.has(k)));
  Object.assign(state, NO_EDITS(), { layerMat: known(e.layerMat), layerColor: known(e.layerColor), layerSpecial: known(e.layerSpecial) });
  // Older saves kept the type with the material: 0 (plain colour) meant no magic material.
  for (const [id, m] of Object.entries(state.layerMat)) {
    if (m.type === undefined) continue;
    const t = Math.round(Math.abs(m.type));
    if (!(id in state.layerSpecial)) state.layerSpecial[id] = t;
    state.layerMat[id] = t === MAT_WATER ? { alpha: m.alpha, gloss: m.gloss } : { rgb: m.rgb, alpha: m.alpha, gloss: m.gloss };
  }
  model.specialOf = layerSpecialId;
  replayObjectEdits(e.exploded, e.objEdits);
  const n = editCount(), parts = [];
  if (n.col) parts.push(`colours on ${n.col} layer${n.col > 1 ? 's' : ''}`);
  if (n.mat) parts.push(`materials on ${n.mat} layer${n.mat > 1 ? 's' : ''}`);
  if (n.obj) parts.push(`${n.obj.toLocaleString()} object${n.obj > 1 ? 's' : ''} changed`);
  if (n.expl) parts.push(`${n.expl.toLocaleString()} block${n.expl > 1 ? 's' : ''} exploded`);
  if (parts.length) notice(`Restored your changes to this model: ${parts.join(', ')}. To undo them, click the file name (top left) and choose Revert changes.`);
  return n.obj + n.expl > 0 || Object.keys(state.layerSpecial).length > 0;
}

// Layer colour / material dialog -------------------------------------------------------------

let matLayer = -1, matKind = 'material';
function openMaterialDialog(i, anchor) {
  const dlg = $('matDialog'), l = model.layers[i], look = layerLook(i);
  matLayer = i;
  matKind = showsMaterial() ? 'material' : 'colour';
  const isMat = matKind === 'material';
  $('matTitle').textContent = l.name;
  $('matPath').textContent = l.fullPath.includes('::') ? l.fullPath : '';
  for (const id of ['matSpecialRow', 'matSpecialHint', 'matGlossRow', 'matAlphaRow']) $(id).hidden = !isMat;
  if (isMat) {
    const info = layerSpecialInfo(i);
    $('matSpecial').value = info.auto ? 'auto' : String(info.id);
    $('matColor').value = rgbHex(look.rgb);
    $('matGloss').value = look.gloss;
    $('matAlpha').value = 1 - look.alpha;
    $('matReset').hidden = !editedMaterialLayers().has(l.id);
  } else {
    $('matSource').textContent = 'Display colour, used in Shaded view. ' + (state.layerColor[l.id] ? 'Set in this viewer.' : 'From the file.');
    $('matColor').value = rgbHex(layerDisplayRgb(i));
    $('matReset').hidden = !state.layerColor[l.id];
  }
  syncMaterialDialog();
  dlg.hidden = false;
  // Place it beside the layers panel, level with the swatch.
  const r = anchor.getBoundingClientRect(), d = dlg.getBoundingClientRect(), side = $('layersPanel').getBoundingClientRect();
  dlg.style.top = Math.max(12, Math.min(window.innerHeight - d.height - 12, r.top - 40)) + 'px';
  dlg.style.left = Math.max(12, (side.width ? side.left : r.left) - d.width - 10) + 'px';
}

// Top-level objects on a layer whose colour (or material) does not come from the layer, so a
// layer setting does not change them.
function objectsNotFollowingLayer(i, kind) {
  return model.objects.flatMap((o, id) => (!o.gone && o.ai.layer === i && (kind === 'material' ? o.ai.ms === 1 : o.ai.cs === 1 || o.ai.cs === 2) ? [id] : []));
}

function syncMaterialDialog() {
  const isMat = matKind === 'material', l = model.layers[matLayer];
  if (isMat) {
    const info = layerSpecialInfo(matLayer), look = layerLook(matLayer), name = info.id ? SPECIAL[info.id].name : '';
    // The magic material and why; then where the colour comes from.
    $('matSpecialHint').textContent = (info.auto ? (info.id ? `Auto: ${name}. ` : '') : '') + specialReason(info) +
      (info.id && !state.specials ? ' Magic materials are off (Magic button on the toolbar).' : '');
    $('matSource').textContent = 'Render material, used in Rendered view. ' + (state.layerMat[l.id] ? 'Set in this viewer.'
      : look.special ? `Colour: the ${name} default.`
      : l.materialName ? `From the file's material “${l.materialName}”.` : 'No material in the file (default).');
    $('matColorLabel').textContent = look.special && SPECIAL[look.special].tones ? 'Base colour' : 'Colour';
    $('matColorRow').title = look.special ? `${name} varies around this colour; any colour keeps the variation.` : '';
  }
  $('matAlphaOut').textContent = Math.round($('matAlpha').value * 100) + '%';
  $('matGlossOut').textContent = Math.round($('matGloss').value * 100) + '%';
  const own = objectsNotFollowingLayer(matLayer, matKind);
  const what = isMat ? 'material' : 'colour';
  $('matOwn').innerHTML = own.length
    ? `${own.length.toLocaleString()} object${own.length > 1 ? 's' : ''} on this layer ${own.length > 1 ? 'have their' : 'has its'} own ${what}, so ${own.length > 1 ? 'they are' : 'it is'} not changed here. <button class="link" id="matSelectOwn">Select ${own.length > 1 ? 'them' : 'it'}</button> to set the ${what} source to “By layer”.`
    : '';
}

// Any edit in the dialog becomes this layer's own setting.
function onMaterialEdit(e) {
  const l = model.layers[matLayer], field = e?.target.id || '';
  const what = matKind === 'colour' ? 'layer colour' : field === 'matSpecial' ? 'magic material' : { matGloss: 'layer gloss', matAlpha: 'layer transparency' }[field] || 'layer material';
  recordUndo(`Change ${what} (${l.name})`, field === 'matSpecial' ? null : `${matKind}:${l.id}:${field}`);
  if (matKind === 'colour') {
    state.layerColor[l.id] = hexRgb($('matColor').value);
  } else if (e && e.target.id === 'matSpecial') {
    // A new magic material starts from its own default colour (other settings are kept).
    const wasVeg = layerSpecialId(matLayer) === MAT_VEGETATION, v = $('matSpecial').value;
    if (v === 'auto') delete state.layerSpecial[l.id]; else state.layerSpecial[l.id] = +v;
    const m = state.layerMat[l.id];
    if (m) {
      delete m.rgb;
      if (m.alpha >= 1 && !m.gloss) delete state.layerMat[l.id];
    }
    $('matColor').value = rgbHex(layerLook(matLayer).rgb);
    // Foliage uses smoothed normals, which are built with the batches.
    if (wasVeg !== (layerSpecialId(matLayer) === MAT_VEGETATION)) rebuildModel();
  } else {
    state.layerMat[l.id] = { rgb: hexRgb($('matColor').value), alpha: 1 - +$('matAlpha').value, gloss: +$('matGloss').value };
  }
  $('matReset').hidden = matKind === 'colour' ? false : !editedMaterialLayers().has(l.id);
  if (matKind === 'colour') $('matSource').textContent = 'Display colour, used in Shaded view. Set in this viewer.';
  syncMaterialDialog();
  applyLayerMaterials();
  if (state.sel.ids.length) showInspector();
}

function bindMaterialDialog() {
  $('matSpecial').innerHTML = '<option value="0">Always off</option><option value="auto">Auto</option>' +
    MATERIAL_RULES.map((r) => `<option value="${r.id}">${r.name}</option>`).join('');
  for (const id of ['matColor', 'matGloss', 'matAlpha']) $(id).addEventListener('input', onMaterialEdit);
  $('matSpecial').addEventListener('change', onMaterialEdit);
  // A drag of a slider or the colour picker is one undo step; it ends with the change event.
  for (const id of ['matColor', 'matGloss', 'matAlpha']) $(id).addEventListener('change', endUndoGroup);
  const close = () => { $('matDialog').hidden = true; matLayer = -1; endUndoGroup(); };
  $('matClose').addEventListener('click', close);
  $('matDone').addEventListener('click', close);
  $('matReset').addEventListener('click', () => {
    const id = model.layers[matLayer].id;
    recordUndo(`Reset layer ${matKind === 'colour' ? 'colour' : 'material'} (${model.layers[matLayer].name})`);
    if (matKind === 'colour') delete state.layerColor[id];
    else {
      const wasVeg = layerSpecialId(matLayer) === MAT_VEGETATION;
      delete state.layerMat[id];
      delete state.layerSpecial[id];
      if (wasVeg !== (layerSpecialId(matLayer) === MAT_VEGETATION)) rebuildModel();
    }
    applyLayerMaterials();
    openMaterialDialog(matLayer, document.querySelector('.layer-row .swatch') || $('matDialog'));
  });
  $('matOwn').addEventListener('click', (e) => {
    if (e.target.id !== 'matSelectOwn') return;
    selectObjects(objectsNotFollowingLayer(matLayer, matKind).filter((id) => !state.hidden.has(id)));
  });
}

// Object attributes carried over to the parts of an exploded block (not its id or block mode).
const COPY_ATTRS = ['visible', 'name', 'castsShadows', 'receivesShadows', 'linetypeSource', 'colorSource', 'plotColorSource', 'plotWeightSource',
  'url', 'layerIndex', 'materialIndex', 'materialSource', 'objectColor', 'plotColor', 'displayOrder', 'plotWeight', 'objectDecoration', 'wireDensity'];

// Write a copy of the .3dm with the viewer's changes (the original is never touched): layer
// colours, a Rhino material for each layer set in the viewer, object colour/material sources,
// and exploded blocks (replaced by copies of their contents).
async function downloadCopy() {
  if (!model || !model.bytes) return;
  try {
    showBusy('Writing a copy of the .3dm with your changes', 0.3);
    await new Promise((r) => setTimeout(r, 20));
    const rhino = await getRhino(model.reader);
    const doc = rhino.File3dm.fromByteArray(model.bytes);
    const mats = doc.materials(), lt = doc.layers(), objs = doc.objects();
    const rgba = (c) => ({ r: Math.round(c[0] * 255), g: Math.round(c[1] * 255), b: Math.round(c[2] * 255), a: 255 });
    for (const [id, c] of Object.entries(state.layerColor)) { const layer = lt.findId(id); if (layer) layer.color = rgba(c); }
    for (const id of editedMaterialLayers()) {
      const layer = lt.findId(id), i = model.layers.findIndex((l) => l.id === id);
      if (!layer || i < 0) continue;
      const m = new rhino.Material(), sp = layerSpecialId(i), set = state.layerMat[id];
      const o = { rgb: set?.rgb || (sp ? SPECIAL[sp].rgb : model.layers[i].materialRgb), alpha: set ? set.alpha : sp ? 1 : model.layers[i].materialAlpha, gloss: set?.gloss || 0 };
      // Materials with a magic material are named after it, so the viewer recognises them again.
      m.name = sp ? `${SPECIAL[sp].name} – ${layer.name}` : `${layer.name} (viewer)`;
      m.diffuseColor = rgba(o.rgb);
      m.transparency = 1 - o.alpha;
      m.shine = Math.round(o.gloss * 255);
      m.reflectivity = o.gloss * 0.5;
      mats.add(m);
      layer.renderMaterialIndex = mats.count - 1;
    }
    const CS = [rhino.ObjectColorSource.ColorFromLayer, rhino.ObjectColorSource.ColorFromObject, rhino.ObjectColorSource.ColorFromMaterial, rhino.ObjectColorSource.ColorFromParent];
    const MS = [rhino.ObjectMaterialSource.MaterialFromLayer, rhino.ObjectMaterialSource.MaterialFromObject, rhino.ObjectMaterialSource.MaterialFromParent];
    const setAttrs = (a, ai) => {
      a.colorSource = CS[ai.cs] ?? CS[0];
      a.objectColor = rgba(ai.oc);
      a.materialSource = MS[ai.ms] ?? MS[0];
      a.materialIndex = ai.mi;
    };
    // Objects from the file whose attributes changed.
    for (const it of model.objects) {
      if (!it.id || it.gone || !state.objEdits[it.key]) continue;
      const o = objs.findId(it.id);
      if (o) setAttrs(o.attributes(), it.ai);
    }
    // Exploded blocks: add a transformed copy of each part, then delete the instances.
    showBusy('Writing exploded blocks', 0.5);
    await new Promise((r) => setTimeout(r, 20));
    for (const it of model.objects) {
      if (!it.from) continue;
      const src = objs.findId(it.src);
      if (!src) continue;
      const g = src.geometry().duplicate(), t = new rhino.Transform(1);
      ['m00', 'm01', 'm02', 'm03', 'm10', 'm11', 'm12', 'm13', 'm20', 'm21', 'm22', 'm23', 'm30', 'm31', 'm32', 'm33'].forEach((k, n) => (t[k] = it.fileXf[n]));
      g.transform(t);
      // attributes() writes through to the block's own object, so build a separate copy.
      const s = src.attributes(), a = new rhino.ObjectAttributes();
      for (const k of COPY_ATTRS) try { a[k] = s[k]; } catch (e) { /* not in this rhino3dm version */ }
      for (const [k, v] of s.getUserStrings() || []) a.setUserString(k, v);
      setAttrs(a, it.ai);
      objs.add(g, a);
      g.delete?.(); t.delete?.();
    }
    for (const key of state.exploded) if (objs.findId(key)) objs.delete(key);
    showBusy('Saving', 0.8);
    await new Promise((r) => setTimeout(r, 20));
    const out = doc.toByteArray();
    doc.delete();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([out], { type: 'application/octet-stream' }));
    a.download = model.name.replace(/\.3dm$/i, '') + ' - viewer edits.3dm';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  } catch (e) {
    console.error(e);
    notice(`Could not write the file: ${e.message || e}`, true);
  } finally {
    hideBusy();
  }
}

// ---------------------------------------------------------------------------------------------
// Selection, inspector and hiding
//
// Click an object to select it (Shift-click adds or removes objects). Selected objects are
// tinted and described in the inspector beside the last clicked point; Hide removes them from
// view. Each object's state is one entry in `objFlags`, read by the GPU: bit 0 hidden,
// bit 1 selected.

state.sel = { ids: [], p: null };
state.hidden = new Set();
let objFlags = new Uint32Array(0);

function resetObjectState() {
  state.sel = { ids: [], p: null };
  state.hidden = new Set();
  objFlags = new Uint32Array(model ? model.objects.length : 0);
  renderer.setObjectFlags(objFlags);
  $('inspect').hidden = true; inspectPin = null;
  closeLayerMenu();
  syncHiddenButton();
}

function pushObjectFlags() {
  objFlags.fill(0);
  for (const id of state.hidden) objFlags[id] |= 1;
  for (const id of state.sel.ids) objFlags[id] |= 2;
  renderer.setObjectFlags(objFlags);
  redraw();
}

// id: object index or null (click on empty space); additive: Shift held.
function selectObject(id, p, additive = false) {
  if (!model) return;
  let ids = additive ? [...state.sel.ids] : [];
  if (id != null && model.objects[id]) {
    const at = ids.indexOf(id);
    if (additive && at >= 0) ids.splice(at, 1); else if (at < 0) ids.push(id);
  } else if (additive) {
    return; // Shift-click on empty space keeps the selection
  }
  state.sel = { ids, p: id != null ? p : state.sel.p };
  pushObjectFlags();
  showInspector();
}

// Replace the selection with a list of objects (from the layer menu). The inspector sits at the
// centre of their combined bounding box.
function selectObjects(ids, p = null) {
  if (!model || !ids.length) return;
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (const id of ids) for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], model.objects[id].min[k]); max[k] = Math.max(max[k], model.objects[id].max[k]); }
  state.sel = { ids: [...ids], p: p || (isFinite(min[0]) ? V3.scale(V3.add(min, max), 0.5) : null) };
  pushObjectFlags();
  showInspector();
}

// Ctrl+A: every visible object (not hidden, on a layer that is on).
function selectAll() {
  selectObjects(model.objects.flatMap((o, id) => (!o.gone && !state.hidden.has(id) && layerEffective(o.layer) ? [id] : [])));
}

const UNIT_ABBR = { Meters: 'm', Millimeters: 'mm', Centimeters: 'cm', Kilometers: 'km', Feet: 'ft', Inches: 'in' };
const fmtLen = (v) => (Math.abs(v) >= 100 ? v.toFixed(1) : v.toPrecision(3));
const COLOR_SOURCES = [[0, 'By layer'], [1, 'By object'], [3, 'By parent'], [2, 'By material']];
const MATERIAL_SOURCES = [[0, 'By layer'], [1, 'By object'], [2, 'By parent']];
const materialLabel = (mi) => (mi >= 0 && model.materials[mi] ? model.materials[mi].name || `Material ${mi + 1}` : 'Default material');

// The colour (Shaded view) or material (Rendered view) source control for the selection: a
// dropdown, plus a colour picker or material list when the source is "By object".
function sourceControl(objs) {
  const isMat = showsMaterial(), key = isMat ? 'ms' : 'cs';
  const same = (f) => objs.every((o) => f(o) === f(objs[0]));
  const src = same((o) => o.ai[key]) ? objs[0].ai[key] : null;
  const opts = (list, value) => (value == null ? '<option value="" selected disabled>Mixed</option>' : '') +
    list.map(([v, label]) => `<option value="${v}"${v === value ? ' selected' : ''}>${escapeHtml(label)}</option>`).join('');
  let html = `<div class="src"><select data-src aria-label="${isMat ? 'Material' : 'Colour'} source">${opts(isMat ? MATERIAL_SOURCES : COLOR_SOURCES, src)}</select>`;
  if (src === 1 && !isMat) {
    const oc = same((o) => rgbHex(o.ai.oc)) ? rgbHex(objs[0].ai.oc) : '#808080';
    html += `<input type="color" data-oc value="${oc}" title="Object colour">`;
  }
  if (src === 1 && isMat) {
    const mi = same((o) => o.ai.mi) ? (model.materials[objs[0].ai.mi] ? objs[0].ai.mi : -1) : null;
    html += `<select data-mi aria-label="Object material">${opts([[-1, 'Default material'], ...model.materials.map((m) => [m.index, materialLabel(m.index)])], mi)}</select>`;
  }
  html += '</div>';
  // What it resolves to (single object), and what "by parent" means for blocks.
  if (objs.length === 1 && objs[0].look) {
    const o = objs[0], look = o.look;
    const chip = (rgb) => `<span class="chip" style="background:${rgbHex(rgb)}"></span>`;
    if (isMat) {
      const set = look.mLayer >= 0 && layerMaterialFor(look.mLayer), sp = look.mLayer >= 0 ? layerLook(look.mLayer).special : 0;
      const what = set?.rgb ? 'Layer material set in this viewer' : sp ? `${SPECIAL[sp].name} default` : escapeHtml(materialLabel(look.mi));
      html += `<div class="fine">${chip(shownMaterialRgb(look))}${what}${sp ? ` · magic material: ${SPECIAL[sp].name.toLowerCase()} (layer ${escapeHtml(model.layers[look.mLayer].name)})` : ''}</div>`;
    } else {
      html += `<div class="fine">${chip(shownRgb(look))}${rgbHex(shownRgb(look))}</div>`;
    }
  }
  if (objs.some((o) => o.k === 'inst')) html += '<div class="fine">On a block, this applies to the parts inside it that are set to “By parent”.</div>';
  return html;
}

function showInspector() {
  const ids = state.sel.ids;
  if (!ids.length) { $('inspect').hidden = true; inspectPin = null; return; }
  const unit = UNIT_ABBR[model.units] || '';
  const objs = ids.map((i) => model.objects[i]);
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (const o of objs) for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], o.min[k]); max[k] = Math.max(max[k], o.max[k]); }
  const size = V3.sub(max, min);
  const sizeText = isFinite(size[0]) ? `${fmtLen(size[0])} × ${fmtLen(size[1])} × ${fmtLen(size[2])} ${unit}` : '—';
  const layerLink = (i) => `<button class="link" data-layer="${i}">${escapeHtml(model.layers[i] ? model.layers[i].fullPath : '?')}</button>`;
  const nBlocks = objs.filter((o) => o.k === 'inst').length;
  const explode = nBlocks ? ` <button class="btn small" data-act="explode" title="Replace ${nBlocks > 1 ? 'these blocks' : 'this block'} with the objects inside (including nested blocks)">Explode block${nBlocks > 1 ? 's' : ''}</button>` : '';
  const srcRow = [showsMaterial() ? 'Material' : 'Colour', sourceControl(objs), true];
  let rows, title, swatch;
  if (objs.length === 1) {
    const o = objs[0];
    title = o.name || o.block || o.type;
    swatch = o.look ? rgbHex(showsMaterial() ? shownMaterialRgb(o.look) : shownRgb(o.look)) : 'var(--accent)';
    rows = [
      ['Type', (o.block ? `Block · ${escapeHtml(o.block)}` : escapeHtml(o.type)) + explode, true],
      ['Layer', layerLink(o.layer), true],
      srcRow,
      ['Size', sizeText],
      ['Triangles', o.triangles.toLocaleString()],
      ...o.userText.map(([k, v]) => [k, v]),
      o.id ? ['ID', `<code>${o.id}</code>`, true] : ['ID', 'None yet (from an exploded block)'],
    ];
  } else {
    const count = (key) => {
      const m = new Map();
      for (const o of objs) m.set(key(o), (m.get(key(o)) || 0) + 1);
      return [...m.entries()].sort((a, b) => b[1] - a[1]);
    };
    const types = count((o) => (o.block ? `Block · ${o.block}` : o.type));
    const layers = count((o) => o.layer);
    title = `${objs.length} objects selected`;
    swatch = 'var(--accent)';
    rows = [
      ['Types', types.slice(0, 4).map(([t, n]) => `${n} × ${escapeHtml(t)}`).join('<br>') + (types.length > 4 ? `<br>and ${types.length - 4} more` : '') + (explode ? `<br>${explode}` : ''), true],
      ['Layers', layers.slice(0, 4).map(([l]) => layerLink(l)).join('<br>') + (layers.length > 4 ? `<br>and ${layers.length - 4} more` : ''), true],
      srcRow,
      ['Extent', sizeText],
      ['Triangles', objs.reduce((s, o) => s + o.triangles, 0).toLocaleString()],
    ];
  }
  $('insTitle').textContent = title;
  $('insSwatch').style.background = swatch;
  $('insBody').innerHTML = rows.map(([k, v, html]) => `<dt>${escapeHtml(k)}</dt><dd>${html ? v : escapeHtml(String(v))}</dd>`).join('');
  $('insHide').textContent = objs.length === 1 ? 'Hide' : `Hide ${objs.length}`;
  $('inspect').hidden = false;
  positionInspector();
}

function escapeHtml(s) { return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]); }

// Change the selected objects' attributes (see resolveLook in extract.js) and rebuild.
async function setSelectedAttrs(change) {
  const n = state.sel.ids.length;
  recordUndo(`Change ${showsMaterial() ? 'material' : 'colour'} of ${n > 1 ? `${n} objects` : 'object'}`);
  for (const id of state.sel.ids) {
    const o = model.objects[id];
    Object.assign(o.ai, change);
    const d = {};
    for (const k of ['cs', 'ms', 'mi']) if (o.ai[k] !== o.ai0[k]) d[k] = o.ai[k];
    if (rgbHex(o.ai.oc) !== rgbHex(o.ai0.oc)) d.oc = o.ai.oc;
    if (Object.keys(d).length) state.objEdits[o.key] = { ...d, cs: o.ai.cs, ms: o.ai.ms }; else delete state.objEdits[o.key];
  }
  await rebuildModel();
  saveEdits();
  showInspector();
  if (!$('matDialog').hidden && matLayer >= 0) syncMaterialDialog();
}

async function explodeSelected() {
  const keep = [], added = [], n = state.sel.ids.filter((id) => model.objects[id].k === 'inst').length;
  recordUndo(`Explode ${n > 1 ? `${n} blocks` : 'block'}`);
  for (const id of state.sel.ids) {
    const o = model.objects[id];
    if (o.k !== 'inst') { keep.push(id); continue; }
    state.exploded.push(o.key);
    added.push(...explodeItem(model, id, shownRgb));
  }
  indexKeys();
  await rebuildModel();
  buildLayerTree();
  saveEdits();
  if (keep.length + added.length) selectObjects([...keep, ...added], state.sel.p);
  else selectObject(null);
}

function hideSelected() {
  if (!state.sel.ids.length) return;
  for (const id of state.sel.ids) state.hidden.add(id);
  state.sel = { ids: [], p: null };
  $('inspect').hidden = true;
  inspectPin = null;
  pushObjectFlags();
  syncHiddenButton();
}

function unhideAll() {
  state.hidden.clear();
  pushObjectFlags();
  syncHiddenButton();
}

function syncHiddenButton() {
  const n = state.hidden.size;
  $('unhideAll').hidden = n === 0;
  $('unhideAll').textContent = `Unhide all (${n.toLocaleString()})`;
  renderFileInfo();
}

// Keep the inspector beside the last clicked point as the view moves, unless it has been dragged
// somewhere (inspectPin: its top-left corner; cleared when it closes).
let inspectPin = null;
function positionInspector() {
  const box = $('inspect');
  if (!state.sel.ids.length || box.hidden) return;
  if (inspectPin) {
    const left = Math.max(0, Math.min(window.innerWidth - 60, inspectPin.left)), top = Math.max(0, Math.min(window.innerHeight - 40, inspectPin.top));
    box.style.visibility = '';
    box.style.transform = `translate(${left}px, ${top}px)`;
  }
  if (!state.sel.p) return;
  const m = camera.viewProj(), [x, y, z] = state.sel.p;
  const cx = m[0] * x + m[4] * y + m[8] * z + m[12], cy = m[1] * x + m[5] * y + m[9] * z + m[13], cw = m[3] * x + m[7] * y + m[11] * z + m[15];
  if (cw <= 0) { if (!inspectPin) box.style.visibility = 'hidden'; return; }
  box.style.visibility = '';
  const r = canvas.getBoundingClientRect(), bw = box.offsetWidth, bh = box.offsetHeight;
  const px = r.left + ((cx / cw) * 0.5 + 0.5) * r.width, py = r.top + (0.5 - (cy / cw) * 0.5) * r.height;
  $('inspectDot').style.transform = `translate(${px - 4}px, ${py - 4}px)`;
  if (inspectPin) return;
  let left = px + 16, top = py - 20;
  if (left + bw > window.innerWidth - 12) left = px - bw - 16;
  left = Math.max(12, left);
  top = Math.max(12, Math.min(window.innerHeight - bh - 70, top));
  box.style.transform = `translate(${left}px, ${top}px)`;
}

function bindInspector() {
  $('insClose').addEventListener('click', () => selectObject(null));
  // Drag the panel by its title bar; it then stays put until it closes.
  const head = document.querySelector('.inspect-head');
  head.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || e.target.closest('button')) return;
    const r = $('inspect').getBoundingClientRect(), dx = e.clientX - r.left, dy = e.clientY - r.top;
    head.setPointerCapture(e.pointerId);
    const move = (ev) => { inspectPin = { left: ev.clientX - dx, top: ev.clientY - dy }; positionInspector(); };
    const up = () => { head.removeEventListener('pointermove', move); head.removeEventListener('pointerup', up); head.removeEventListener('pointercancel', up); };
    head.addEventListener('pointermove', move);
    head.addEventListener('pointerup', up);
    head.addEventListener('pointercancel', up);
  });
  $('insHide').addEventListener('click', hideSelected);
  $('unhideAll').addEventListener('click', unhideAll);
  $('insBody').addEventListener('click', (e) => {
    const b = e.target.closest('[data-layer]');
    if (b) {
      if (!state.layers) toggle('layers');
      buildLayerTree.reveal(+b.dataset.layer);
    }
    if (e.target.closest('[data-act="explode"]')) explodeSelected();
    const code = e.target.closest('code');
    if (code) navigator.clipboard?.writeText(code.textContent).then(() => { code.classList.add('copied'); setTimeout(() => code.classList.remove('copied'), 900); });
  });
  $('insBody').addEventListener('change', (e) => {
    const t = e.target;
    if (t.matches('[data-src]')) setSelectedAttrs(showsMaterial() ? { ms: +t.value } : { cs: +t.value });
    else if (t.matches('[data-oc]')) setSelectedAttrs({ cs: 1, oc: hexRgb(t.value) });
    else if (t.matches('[data-mi]')) setSelectedAttrs({ ms: 1, mi: +t.value });
  });
}

// ---------------------------------------------------------------------------------------------
// File properties dialog: model statistics, saving a copy, reverting viewer changes

function renderFileInfo() {
  if (!model) return;
  const s = model.stats, fmt = (n) => Math.round(n).toLocaleString();
  const units = { Meters: 'metres', Millimeters: 'millimetres', Centimeters: 'centimetres', Feet: 'feet', Inches: 'inches', Kilometers: 'kilometres' }[model.units] || model.units;
  const loc = model.location;
  const hiddenTypes = Object.entries(s.unsupported).map(([k, n]) => `${fmt(n)} × ${k}`).join(', ');
  const missing = Object.entries(s.noRenderMesh).map(([k, n]) => `${fmt(n)} × ${k}`).join(', ');
  const rows = [
    ['File size', `${(model.size / 1e6).toFixed(1)} MB`],
    ['Units', units],
    ['Objects', fmt(s.objects)],
    ['Triangles', fmt(s.triangles)],
    s.curves && ['Curves', fmt(s.curves)],
    s.points && ['Points', fmt(s.points)],
    s.instances && ['Block instances', fmt(s.instances)],
    ['Layers', fmt(model.layers.length)],
    ['Location', loc ? `${loc.lat.toFixed(4)}°, ${loc.lon.toFixed(4)}°` : 'Not set'],
    hiddenTypes && ['Not shown', hiddenTypes],
    missing && ['No render mesh', missing],
    ['Loaded in', `${(model.loadMs / 1000).toFixed(1)} s${model.reader === 'w64' ? ' (64-bit reader)' : ''}`],
  ].filter(Boolean);
  $('fileTitle').textContent = model.name;
  $('fileBody').innerHTML = rows.map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd>${escapeHtml(String(v))}</dd>`).join('');
  const n = editCount(), nHidden = state.hidden.size, plural = (k, w) => `${k.toLocaleString()} ${w}${k > 1 ? 's' : ''}`;
  const saved = [];
  if (n.col) saved.push(`Colours set on ${plural(n.col, 'layer')}`);
  if (n.mat) saved.push(`Materials set on ${plural(n.mat, 'layer')}`);
  if (n.obj) saved.push(`${plural(n.obj, 'object')} with changed colour or material`);
  if (n.expl) saved.push(`${plural(n.expl, 'block')} exploded`);
  const changes = [...saved];
  if (nHidden) changes.push(`${plural(nHidden, 'object')} hidden`);
  if (layerOn.some((on, i) => on !== model.layers[i].visible)) changes.push('Layer visibility changed');
  $('fileChanges').textContent = changes.length ? changes.join(' · ') : 'No changes made in the viewer.';
  $('btnDownload').disabled = saved.length === 0;
  $('btnDownload').title = saved.length ? 'Save a copy of the .3dm with the colours, materials and exploded blocks changed in this viewer'
    : 'Change a layer colour or material, an object’s colour or material, or explode a block first';
  $('btnRevert').disabled = changes.length === 0;
}

function toggleFileDialog(show = $('fileDialog').hidden) {
  if (!model) return;
  renderFileInfo();
  $('fileDialog').hidden = !show;
}

async function revertChanges() {
  const ok = await Dialog.confirm('Revert changes',
    'Layer colours, materials and magic materials (back to Auto), object colours and materials, exploded blocks, hidden objects and layer visibility go back to how they are in the file.\n\nUndo (Ctrl+Z) brings back the colour, material and block changes, but not hidden objects or layer visibility.',
    'Revert', { danger: true });
  if (!ok) return;
  const n = editCount();
  if (n.mat + n.col + n.obj + n.expl) recordUndo('Revert changes');
  const rebuild = state.exploded.length || Object.keys(state.objEdits).length || Object.keys(state.layerSpecial).length;
  Object.assign(state, NO_EDITS());
  state.hidden.clear();
  state.sel = { ids: [], p: null };
  $('inspect').hidden = true; inspectPin = null;
  layerOn = model.layers.map((l) => l.visible);
  if (rebuild) {
    model.objects.length = model.fileItems;
    for (const o of model.objects) { o.ai = { ...o.ai0 }; o.gone = false; }
    indexKeys();
    await rebuildModel();
    buildLayerTree();
  }
  applyLayerVisibility();
  applyLayerMaterials();
  buildLayerTree.refresh?.();
  pushObjectFlags();
  syncHiddenButton();
}

function bindFileDialog() {
  $('fileName').addEventListener('click', () => toggleFileDialog());
  $('fileClose').addEventListener('click', () => toggleFileDialog(false));
  $('btnDownload').addEventListener('click', downloadCopy);
  $('btnRevert').addEventListener('click', revertChanges);
}

// ---------------------------------------------------------------------------------------------
// Sun panel

const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
let sunAnim = 0;

function applyFileLocation(loc) {
  const S = state.sun;
  if (loc) {
    Object.assign(S, { lat: +loc.lat.toFixed(5), lon: +loc.lon.toFixed(5), utcOffset: loc.utcOffset, north: +loc.north.toFixed(2), place: null, source: `Location from the ${loc.source}` });
    if (loc.date) { S.year = loc.date.year; S.doy = dayOfYear(loc.date.year, loc.date.month, loc.date.day); S.hour = loc.date.hour; }
  } else {
    S.source = `No location in the file — using ${S.lat.toFixed(2)}°, ${S.lon.toFixed(2)}°`;
  }
  syncSunPanel();
}

function syncSunPanel() {
  const S = state.sun;
  $('sunOn').checked = S.on;
  $('sunGround').checked = S.ground;
  $('sunDay').max = daysInYear(S.year);
  $('sunDay').value = S.doy;
  $('sunHour').value = S.hour;
  // The location fields are in the Select location dialog, when it is open.
  for (const [id, k] of [['sunLat', 'lat'], ['sunLon', 'lon'], ['sunUtc', 'utcOffset'], ['sunNorth', 'north']])
    if ($(id) && document.activeElement !== $(id)) $(id).value = S[k];
  if ($('sunSource')) $('sunSource').textContent = S.source;
  const { month, day } = dateFromDayOfYear(S.year, S.doy);
  $('sunDateOut').textContent = `${day} ${MONTHS[month - 1]} ${S.year}`;
  const utc = fmtUtc(S.utcOffset);
  const coords = `${Math.abs(S.lat).toFixed(2)}° ${S.lat < 0 ? 'S' : 'N'}, ${Math.abs(S.lon).toFixed(2)}° ${S.lon < 0 ? 'W' : 'E'}`;
  $('sunLocName').textContent = S.place || coords;
  $('sunLocInfo').textContent = `${S.place ? coords + ' · ' : ''}${utc} · north ${+S.north.toFixed(1)}°`;
  $('sunLocName').parentNode.title = S.source;
  $('sunTimeOut').textContent = `${fmtHour(S.hour)} ${utc}`;
  const p = sunPosition();
  const dirName = COMPASS[Math.round(p.azimuth / 22.5) % 16];
  const pos = p.altitude > -0.83
    ? `Altitude <b>${p.altitude.toFixed(1)}°</b> · Azimuth <b>${p.azimuth.toFixed(1)}°</b> (${dirName})`
    : `<b>Sun below the horizon</b> (${p.altitude.toFixed(1)}°)`;
  const day2 = p.polar === 'day' ? 'Sun up all day' : p.polar === 'night' ? 'Sun down all day' : `Sunrise <b>${fmtHour(p.sunrise)}</b> · Sunset <b>${fmtHour(p.sunset)}</b>`;
  $('sunRead').innerHTML = `${pos}<br>${day2}`;
  document.querySelector('.sun-body').classList.toggle('off', !S.on);
  document.querySelector('[data-act="sun"]').setAttribute('aria-pressed', String(S.panel));
}

function setSun(changes) {
  Object.assign(state.sun, changes);
  syncSunPanel();
  redraw();
}

function toggleSunPanel() {
  const S = state.sun;
  S.panel = !S.panel;
  $('sunPanel').hidden = !S.panel;
  syncSunPanel();
}

function toggleSunPlay() {
  if (sunAnim) { cancelAnimationFrame(sunAnim); sunAnim = 0; $('sunPlay').classList.remove('on'); $('sunPlay').textContent = '▶'; return; }
  if (!state.sun.on) setSun({ on: true });
  $('sunPlay').classList.add('on'); $('sunPlay').textContent = '❚❚';
  let last = performance.now();
  const step = (now) => {
    const dt = Math.min(0.1, (now - last) / 1000); last = now;
    const p = sunPosition();
    const start = p.sunrise != null ? p.sunrise - 0.25 : 0, end = p.sunset != null ? p.sunset + 0.25 : 24;
    let h = state.sun.hour + dt * 1.2; // 1.2 hours of sun per second
    if (h > end || h < start) h = start;
    setSun({ hour: h });
    sunAnim = requestAnimationFrame(step);
  };
  sunAnim = requestAnimationFrame(step);
}

function bindSunPanel() {
  $('sunOn').addEventListener('change', (e) => setSun({ on: e.target.checked }));
  $('sunGround').addEventListener('change', (e) => setSun({ ground: e.target.checked }));
  $('sunDay').addEventListener('input', (e) => setSun({ doy: +e.target.value, on: true }));
  $('sunHour').addEventListener('input', (e) => setSun({ hour: +e.target.value, on: true }));
  document.querySelectorAll('[data-md]').forEach((b) => b.addEventListener('click', () => {
    const [m, d] = b.dataset.md.split('-').map(Number);
    setSun({ doy: dayOfYear(state.sun.year, m, d), on: true });
  }));
  $('sunPlay').addEventListener('click', toggleSunPlay);
  $('sunPickCity').addEventListener('click', selectLocation);
  syncSunPanel();
}

// "UTC", "UTC+3", "UTC−3:30".
function fmtUtc(h) {
  const a = Math.abs(h), m = Math.round((a % 1) * 60);
  return h === 0 ? 'UTC' : `UTC${h > 0 ? '+' : '−'}${Math.floor(a)}${m ? ':' + String(m).padStart(2, '0') : ''}`;
}

// The sun's location: latitude, longitude, UTC offset and north angle, typed in or set from a city
// (cities.js). Changes apply as they are made.
function selectLocation() {
  const wrap = document.createElement('div');
  wrap.className = 'loc-dlg';
  wrap.innerHTML = `<div class="grid2">
      <label>Latitude<input type="number" id="sunLat" step="0.0001" min="-90" max="90"></label>
      <label>Longitude<input type="number" id="sunLon" step="0.0001" min="-180" max="180"></label>
      <label>UTC offset (h)<input type="number" id="sunUtc" step="0.5" min="-12" max="14"></label>
      <label title="Degrees anticlockwise from the model's +X axis to north (90 = +Y is north)">North angle (°)<input type="number" id="sunNorth" step="1"></label>
    </div>
    <div class="fine" id="sunSource"></div>
    <div class="loc-cities">Or choose a city <span class="fine">(sets latitude, longitude and the standard-time UTC offset)</span></div>
    <input type="search" class="city-search" placeholder="Search cities or countries" aria-label="Search cities">
    <div class="city-list" role="listbox"></div>`;
  const search = wrap.querySelector('.city-search'), list = wrap.querySelector('.city-list');
  const num = (id, key, lo, hi, label, typed) => {
    const el = wrap.querySelector('#' + id);
    el.addEventListener('change', endUndoGroup);
    el.addEventListener('input', (e) => {
      const v = parseFloat(e.target.value);
      if (!Number.isFinite(v) || v < lo || v > hi || v === state.sun[key]) return;
      if (model) recordUndo(`Change ${label}`, id);
      setSun({ [key]: v, on: true, ...(typed && { place: null, source: 'Latitude and longitude typed in' }) });
      if (typed) show(); // no city is selected now
    });
  };
  num('sunLat', 'lat', -90, 90, 'latitude', true);
  num('sunLon', 'lon', -180, 180, 'longitude', true);
  num('sunUtc', 'utcOffset', -12, 14, 'UTC offset');
  num('sunNorth', 'north', -360, 360, 'north angle');
  const show = () => {
    const q = search.value.trim().toLowerCase();
    const hits = CITIES.filter(([n, c]) => !q || n.toLowerCase().includes(q) || c.toLowerCase().includes(q));
    list.innerHTML = hits.length ? '' : '<div class="empty">No matching city. Type a latitude and longitude above instead.</div>';
    for (const [name, country, lat, lon, off] of hits) {
      const b = document.createElement('button');
      b.setAttribute('role', 'option');
      b.innerHTML = '<span></span><span class="n"></span>';
      b.firstChild.textContent = `${name}, ${country}`;
      b.lastChild.textContent = `${lat.toFixed(2)}, ${lon.toFixed(2)} · ${fmtUtc(off)}`;
      b.setAttribute('aria-selected', String(state.sun.place === name && state.sun.lat === lat && state.sun.lon === lon));
      b.addEventListener('click', () => {
        if (model) { endUndoGroup(); recordUndo(`Set location to ${name}`); }
        setSun({ lat, lon, utcOffset: off, on: true, place: name, source: `${name}, ${country}, from the city list (UTC offset is standard time, without daylight saving)` });
        show();
      });
      list.appendChild(b);
    }
  };
  search.addEventListener('input', show);
  // Enter in the search box picks the first match (and, through the dialog, closes it).
  search.addEventListener('keydown', (e) => { if (e.key === 'Enter') list.querySelector('button')?.click(); });
  show();
  const dlg = new Dialog({ title: 'Select location', body: wrap, buttons: [{ label: 'Done', value: true, primary: true }], width: 420,
    onOpen: () => { search.focus(); syncSunPanel(); } });
  dlg.result.then(endUndoGroup);
}

// ---------------------------------------------------------------------------------------------
// Pointer / keyboard input

const pointers = new Map();
let drag = null, pivot = null, lastWheelPick = null, clickTimer = 0;

const toDevice = (e) => {
  const r = canvas.getBoundingClientRect();
  return [(e.clientX - r.left) * (canvas.width / r.width), (e.clientY - r.top) * (canvas.height / r.height)];
};
const toNdc = (e) => {
  const r = canvas.getBoundingClientRect();
  return [((e.clientX - r.left) / r.width) * 2 - 1, 1 - ((e.clientY - r.top) / r.height) * 2];
};
// Resolves to { p: world point, id: object index } for the surface under the pointer, or null.
const pickAt = (e) => (model ? renderer.pick(...toDevice(e), camera.viewProj(), frameState()) : Promise.resolve(null));
const pickPoint = (e) => pickAt(e).then((h) => h && h.p);

function bindPointer() {
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());

  canvas.addEventListener('pointerdown', (e) => {
    canvas.focus();
    canvas.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 1 && walker.active) {
      // Pedestrian mode: any button (or one finger) drags to look.
      drag = { mode: 'look', x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY, moved: false, button: e.button };
      walker.skipFall();
      canvas.classList.add('dragging');
    } else if (pointers.size === 1) {
      // Rhino-style mouse: right-drag orbits (Shift + right pans), left/middle-drag pans.
      // Alt + left orbits for trackpads; on touch screens one finger orbits. In the Top, Front
      // and Right views right-drag (and one finger) pans, as in Rhino's parallel views.
      const flat = ['top', 'front', 'right'].includes(state.lastView);
      const orbit = (!flat && (e.pointerType === 'touch' || (e.button === 2 && !e.shiftKey))) || (e.button === 0 && e.altKey);
      const pan = !orbit;
      drag = { mode: pan ? 'pan' : 'orbit', x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY, moved: false, button: e.button };
      pivot = null;
      if (!pan) pickPoint(e).then((p) => { if (drag && drag.mode === 'orbit') pivot = p; });
      canvas.classList.add('dragging');
    } else if (pointers.size === 2 && !walker.active) {
      drag = { mode: 'pinch', ...pinchInfo() };
    }
  });

  canvas.addEventListener('pointermove', (e) => {
    if (!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (!drag) return;
    if (drag.mode === 'pinch' && pointers.size === 2) {
      const p = pinchInfo(), r = canvas.getBoundingClientRect();
      camera.pan(p.cx - drag.cx, p.cy - drag.cy, r.height);
      const ndc = [((p.cx - r.left) / r.width) * 2 - 1, 1 - ((p.cy - r.top) / r.height) * 2];
      camera.zoomAt(drag.dist / p.dist, camera.planePoint(...ndc));
      Object.assign(drag, p);
      state.lastView = null; syncToolbar(); redraw();
      return;
    }
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    if (Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) > 4) drag.moved = true;
    drag.x = e.clientX; drag.y = e.clientY;
    if (drag.mode === 'look') walker.turn(dx, dy);
    else if (drag.mode === 'orbit') {
      camera.orbit(dx, dy, pivot);
      state.lastView = null;
      syncToolbar();
    } else if (drag.mode === 'pan') camera.pan(dx, dy, canvas.getBoundingClientRect().height);
    redraw();
  });

  const end = (e) => {
    pointers.delete(e.pointerId);
    // A left click or tap without dragging selects the object under the pointer.
    if (pointers.size === 0 && drag && !drag.moved && drag.mode !== 'pinch' && (drag.button === 0 || e.pointerType === 'touch') && e.type === 'pointerup')
      pickAt(e).then((h) => selectObject(h ? h.id : null, h ? h.p : null, e.shiftKey));
    if (pointers.size === 0) { drag = null; canvas.classList.remove('dragging'); }
    else if (pointers.size === 1) {
      const [p] = pointers.values();
      drag = { mode: walker.active ? 'look' : 'orbit', x: p.x, y: p.y, moved: true };
    }
  };
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);

  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    if (!model) return;
    if (walker.active) { walker.wheel(e.deltaY); return; }
    const unit = e.deltaMode === 1 ? 0.05 : e.deltaMode === 2 ? 1 : 0.0015;
    const factor = Math.exp(Math.max(-0.5, Math.min(0.5, e.deltaY * unit)));
    const now = performance.now();
    let q = null;
    if (lastWheelPick && now - lastWheelPick.t < 600 && Math.hypot(e.clientX - lastWheelPick.x, e.clientY - lastWheelPick.y) < 4) q = lastWheelPick.p;
    else {
      const wx = e.clientX, wy = e.clientY;
      lastWheelPick = { t: now, x: wx, y: wy, p: null };
      pickPoint(e).then((p) => { if (lastWheelPick && lastWheelPick.x === wx && lastWheelPick.y === wy) lastWheelPick.p = p; });
    }
    if (lastWheelPick) lastWheelPick.t = now;
    camera.zoomAt(factor, q || camera.planePoint(...toNdc(e)));
    redraw();
  }, { passive: false });

  canvas.addEventListener('dblclick', async (e) => {
    if (!model || walker.active) return;
    const p = await pickPoint(e);
    if (p) animateFocus(p); else zoomExtents();
  });
}

function pinchInfo() {
  const [a, b] = [...pointers.values()];
  return { cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2, dist: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)) };
}

function animateFocus(q) {
  const from = camera.snapshot();
  camera.focus(q);
  const to = camera.snapshot();
  camera.restore(from);
  const t0 = performance.now(), dur = 260;
  const step = (now) => {
    const t = Math.min(1, (now - t0) / dur), k = 1 - Math.pow(1 - t, 3);
    camera.target = from.target.map((v, i) => v + (to.target[i] - v) * k);
    camera.distance = from.distance + (to.distance - from.distance) * k;
    redraw();
    if (t < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

function onKey(e) {
  const typing = ['INPUT', 'SELECT', 'TEXTAREA'].includes(e.target.tagName);
  if ((e.ctrlKey || e.metaKey) && !e.altKey && !typing && model) {
    const k = e.key.toLowerCase();
    if (k === 'z' || k === 'y') { e.preventDefault(); stepHistory(k === 'y' || e.shiftKey); return; }
    if (k === 'a') { e.preventDefault(); selectAll(); return; }
  }
  if (typing || e.ctrlKey || e.metaKey || e.altKey) return;
  const k = e.key.toLowerCase();
  // Pedestrian mode: movement keys walk, Esc stops; other shortcuts still work.
  if (walker.active) {
    if (walker.key(e, true)) { e.preventDefault(); return; }
    if (k === 'escape') { e.preventDefault(); walker.exit(); return; }
  }
  const actions = {
    f: zoomExtents,
    1: () => pickView('top'), 2: () => pickView('front'), 3: () => pickView('right'), 4: () => pickView('perspective'),
    p: () => { walker.exit(); camera.ortho = !camera.ortho; state.lastView = null; syncToolbar(); redraw(); },
    m: () => setMode((state.mode + 1) % 3),
    e: () => toggle('showEdges'), c: () => toggle('showCurves'), x: () => toggle('xray'), o: () => toggle('ao'), l: () => toggle('layers'), s: toggleSunPanel,
    '?': toggleHelp, escape: () => { closeLayerMenu(); $('help').hidden = true; $('matDialog').hidden = true; $('fileDialog').hidden = true; selectObject(null); },
    h: hideSelected,
  };
  if (actions[k] && (model || ['?', 'escape', 'l'].includes(k))) { e.preventDefault(); actions[k](); }
}

// ---------------------------------------------------------------------------------------------
// Toolbar and chrome

function pickView(name) { state.lastView = name; setView(name, true); }
function toggleWalk() {
  if (walker.active) { walker.exit(); return; }
  if (!model || camera.ortho) return;
  state.lastView = null;
  $('walkHint').hidden = false;
  $('walkPanel').hidden = false;
  syncWalkPanel();
  walker.enter().then(() => syncToolbar());
  syncToolbar();
  canvas.focus();
}
// The Walk panel ------------------------------------------------------------------------------

function syncWalkPanel() {
  const S = walker.settings;
  if (document.activeElement !== $('walkSpeed')) $('walkSpeed').value = S.speed;
  $('walkMul').value = Math.log2(S.mul);
  $('walkMulOut').value = '×' + (S.mul < 1 ? S.mul.toFixed(2) : S.mul.toFixed(1));
  $('walkSpeedInfo').textContent = `Walking ${(S.speed * S.mul).toFixed(1)} m/s · Shift runs at ${(S.speed * S.mul * WALK.RUN).toFixed(1)} m/s · the mouse wheel changes the multiplier`;
  $('walkCollide').checked = S.collide;
}

function bindWalkPanel() {
  const S = walker.settings, changed = () => { syncWalkPanel(); savePrefs(); };
  $('walkSpeed').addEventListener('input', () => { const v = parseFloat($('walkSpeed').value); if (v > 0) { S.speed = Math.min(50, v); changed(); } });
  $('walkSpeed').addEventListener('change', syncWalkPanel);
  $('walkMul').addEventListener('input', () => { S.mul = Math.round(2 ** $('walkMul').value * 20) / 20; changed(); });
  $('walkCollide').addEventListener('change', () => { S.collide = $('walkCollide').checked; changed(); canvas.focus(); });
  $('walkClose').addEventListener('click', () => { $('walkPanel').hidden = true; canvas.focus(); });
  $('walkStop').addEventListener('click', () => walker.exit());
  $('walkSun').addEventListener('click', (e) => { if (e.target.id === 'walkSunOn') { setSun({ on: true }); syncSunPanel(); } });
  syncWalkPanel();
}

// Is the walker standing in sunlight? A ray from the eye towards the sun, drawn with the pick
// pass (so trees and every visible object cast shade), a few times a second.
let sunlightAt = 0, sunlightBusy = false;
function checkSunlight() {
  const now = performance.now();
  if (sunlightBusy || now - sunlightAt < 250) return;
  sunlightAt = now;
  // show() only touches the DOM when the text changes, so the Turn on button stays clickable.
  const el = $('walkSun'), show = (cls, html, extra = '') => {
    const k = cls + html + extra;
    if (el.dataset.k === k) return;
    el.dataset.k = k; el.className = 'walk-sun ' + cls; el.innerHTML = '<span class="dot"></span><span>' + html + '</span>' + extra;
  };
  if (!state.sun.on) { show('', 'Sun is off: turn it on to see if you are in sunlight', '<button class="link" id="walkSunOn">Turn on</button>'); return; }
  const pos = sunPosition();
  if (pos.altitude <= 0) { show('shade', '<b>Night</b> · the sun is below the horizon'); return; }
  const d = sunVector(pos.azimuth, pos.altitude, state.sun.north), eye = camera.eye, u = 1 / (METRES_PER_UNIT[model.units] || 1);
  const [mn, mx] = visibleBounds(), far = V3.len(V3.sub(eye, V3.scale(V3.add(mn, mx), 0.5))) + V3.len(V3.sub(mx, mn)) / 2 + u;
  // A one-pixel orthographic view along the ray: pixel (W/2 - 0.5, H/2 - 0.5) is its centre.
  const W = renderer.width, H = renderer.height, hh = 0.005 * u * H;
  const view = M4.lookAt(eye, V3.add(eye, d), Math.abs(d[2]) > 0.99 ? [0, 1, 0] : [0, 0, 1]);
  sunlightBusy = true;
  renderer.pick(W / 2 - 0.5, H / 2 - 0.5, M4.mul(M4.ortho(hh, W / H, 0.05 * u, far), view), frameState()).then((h) => {
    if (!walker.active) return;
    const alt = `sun ${Math.round(pos.altitude)}° up`;
    if (!h) show('lit', `<b>In sunlight</b> · ${alt}`);
    else {
      const layer = model.layers[model.objects[h.id]?.layer], dist = V3.len(V3.sub(h.p, eye)) / u;
      show('shade', `<b>In shade</b> · cast by ${layer ? escapeHtml(layer.name) : 'an object'}, ${dist < 1 ? "less than 1" : Math.round(dist)} m away`);
    }
  }).finally(() => { sunlightBusy = false; });
}

function setMode(m) {
  const wasMat = showsMaterial();
  state.mode = m;
  savePrefs(); syncToolbar(); redraw();
  if (!model || wasMat === showsMaterial()) return;
  // Swatches, the layer dialog and the inspector switch between display colour and material.
  buildLayerTree.refresh?.();
  if (!$('matDialog').hidden && matLayer >= 0) openMaterialDialog(matLayer, document.querySelector('.layer-row .swatch') || $('matDialog'));
  if (state.sel.ids.length) showInspector();
}
function toggle(key) {
  state[key] = !state[key];
  savePrefs();
  if (key === 'layers') $('layersPanel').hidden = !state.layers;
  syncToolbar();
  redraw();
}
function toggleHelp() { $('help').hidden = !$('help').hidden; }

// Recent files on the welcome screen (recent.js) ---------------------------------------------

async function renderRecent() {
  const list = await Recent.list(), ul = $('recentList');
  $('recent').hidden = !list.length;
  ul.innerHTML = '';
  const date = (t) => new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
  list.forEach((r, i) => {
    const li = document.createElement('li');
    li.innerHTML = '<button class="recent-open"><span class="recent-name"></span><span class="recent-info"></span></button><button class="x" aria-label="Remove from the list" title="Remove from the list">×</button>';
    li.querySelector('.recent-name').textContent = r.name;
    li.querySelector('.recent-info').textContent = `${(r.size / 1e6).toFixed(r.size < 1e7 ? 1 : 0)} MB · opened ${date(r.opened)}`;
    li.querySelector('.recent-open').title = `Open ${r.name}`;
    li.querySelector('.recent-open').addEventListener('click', () => openRecent(r));
    li.querySelector('.x').addEventListener('click', async () => { await Recent.remove(i); renderRecent(); });
    ul.appendChild(li);
  });
}

async function openRecent(r) {
  try {
    // The browser asks once per session before the page can read the file again.
    if ((await r.handle.queryPermission({ mode: 'read' })) !== 'granted' && (await r.handle.requestPermission({ mode: 'read' })) !== 'granted') return;
    await openFile(await r.handle.getFile(), r.handle);
  } catch (e) {
    hideBusy();
    notice(e.name === 'NotFoundError' ? `${r.name} could not be found. It may have been moved, renamed or deleted; remove it from the list with ×.` : `Could not open ${r.name}: ${e.message}`, true);
  }
  renderRecent();
}

function bindUi() {
  const input = $('fileInput');
  // The file picker gives a handle for the recent files list; the plain file input is the fallback.
  const browse = async () => {
    if (!Recent.supported) { input.click(); return; }
    let handle;
    try { [handle] = await window.showOpenFilePicker({ types: [{ description: 'Rhino model', accept: { 'application/octet-stream': ['.3dm'] } }] }); } catch (e) { return; } // cancelled
    openFile(await handle.getFile(), handle);
  };
  $('btnOpen').addEventListener('click', browse);
  $('dropBrowse').addEventListener('click', browse);
  input.addEventListener('change', () => { if (input.files[0]) openFile(input.files[0]); input.value = ''; });

  const drop = $('drop');
  let depth = 0;
  window.addEventListener('dragenter', (e) => { e.preventDefault(); if (++depth === 1) { drop.hidden = false; drop.classList.add('over'); } });
  window.addEventListener('dragleave', () => { if (--depth === 0) { drop.classList.remove('over'); if (model) drop.hidden = true; } });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => {
    e.preventDefault(); depth = 0; drop.classList.remove('over');
    if (model) drop.hidden = true;
    const f = e.dataTransfer.files[0];
    // The handle has to be requested before anything else is awaited.
    const h = Recent.supported ? e.dataTransfer.items[0]?.getAsFileSystemHandle?.() : null;
    if (f) Promise.resolve(h).then((handle) => openFile(f, handle?.kind === 'file' ? handle : null), () => openFile(f));
  });

  document.querySelectorAll('[data-view]').forEach((b) => b.addEventListener('click', () => model && pickView(b.dataset.view)));
  document.querySelectorAll('[data-mode]').forEach((b) => b.addEventListener('click', () => setMode(+b.dataset.mode)));
  document.querySelectorAll('[data-toggle]').forEach((b) => b.addEventListener('click', () => toggle(b.dataset.toggle)));
  document.querySelectorAll('[data-act="extents"]').forEach((b) => b.addEventListener('click', zoomExtents));
  document.querySelectorAll('[data-act="help"]').forEach((b) => b.addEventListener('click', toggleHelp));
  document.querySelector('[data-act="sun"]').addEventListener('click', toggleSunPanel);
  $('sunClose').addEventListener('click', () => state.sun.panel && toggleSunPanel());
  $('layersClose').addEventListener('click', () => state.layers && toggle('layers'));
  bindLayerMenu();
  renderRecent();
  $('btnUndo').addEventListener('click', () => stepHistory(false));
  $('btnRedo').addEventListener('click', () => stepHistory(true));
  bindMaterialDialog();
  bindInspector();
  bindFileDialog();
  $('btnSpecials').addEventListener('click', () => {
    state.specials = !state.specials;
    savePrefs();
    applyLayerMaterials(false);
    if (!$('matDialog').hidden && matLayer >= 0 && matKind === 'material') openMaterialDialog(matLayer, document.querySelector('.layer-row .swatch') || $('matDialog'));
    if (state.sel.ids.length) showInspector();
    syncToolbar();
  });
  bindSunPanel();
  $('help').addEventListener('click', (e) => { if (e.target === $('help')) toggleHelp(); });
  document.querySelectorAll('[data-layers]').forEach((b) => b.addEventListener('click', () => {
    if (!model) return;
    layerOn = model.layers.map(() => b.dataset.layers === 'all');
    applyLayerVisibility();
    buildLayerTree.refresh?.();
  }));
  window.addEventListener('keydown', onKey);
  window.addEventListener('keydown', (e) => { if (e.key === 'Shift') shiftDown = true; });
  window.addEventListener('keyup', (e) => { if (e.key === 'Shift') shiftDown = false; walker.key(e, false); });
  window.addEventListener('blur', () => { shiftDown = false; walker.blur(); });
  $('btnWalk').addEventListener('click', toggleWalk);
  bindWalkPanel();
  bindPointer();
  state.lastView = 'perspective';
  syncToolbar();
}

function showBusy(text, frac) {
  $('busy').hidden = false;
  $('busyText').textContent = text;
  $('busyBar').style.width = Math.round(frac * 100) + '%';
}
function hideBusy() { $('busy').hidden = true; }

// timeout: remove after this many ms (brief, informational notices).
function notice(text, error = false, timeout = 0) {
  const n = document.createElement('div');
  n.className = 'notice' + (error ? ' error' : '') + (timeout ? ' brief' : '');
  if (timeout) {
    $('notices').querySelectorAll('.notice.brief').forEach((b) => b.remove()); // one at a time
    setTimeout(() => n.remove(), timeout);
  }
  n.textContent = text;
  const x = document.createElement('button');
  x.className = 'x'; x.textContent = '×'; x.setAttribute('aria-label', 'Dismiss');
  x.onclick = () => n.remove();
  n.appendChild(x);
  $('notices').appendChild(n);
}
function clearNotices() { $('notices').innerHTML = ''; }

function fatal(title, text) {
  $('drop').hidden = true;
  $('fatal').hidden = false;
  $('fatalTitle').textContent = title;
  $('fatalText').textContent = text;
}

boot();
