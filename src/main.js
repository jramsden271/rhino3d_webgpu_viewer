// App wiring: file loading, input handling, layer panel and toolbar.

const $ = (id) => document.getElementById(id);
const canvas = $('gfx');

const prefs = (() => { try { return JSON.parse(localStorage.getItem('3dm-viewer') || '{}'); } catch (e) { return {}; } })();
const savePrefs = () => { try { localStorage.setItem('3dm-viewer', JSON.stringify({ mode: state.mode, showEdges: state.showEdges, showCurves: state.showCurves, ao: state.ao, specials: state.specials, walk: walker.settings, comfortWind: state.comfort.wind, comfortClouds: state.comfort.clouds, cloudSpeed: clouds.speed })); } catch (e) { /* storage unavailable */ } };

const state = {
  mode: prefs.mode ?? 1, xray: false, showEdges: true, showCurves: true, showPoints: true, layers: false,
  pointSize: 5, edgeColor: [0.08, 0.09, 0.1, 0.55],
  bgTop: [0.93, 0.94, 0.95, 1], bgBot: [0.78, 0.8, 0.84, 1],
  // Lights (lamps): { name, src ('file' or 'added'), on, p (model, origin-relative), rgb (linear),
  // power, range (m) }, and for a spot light dir, inner and outer (cone half angles, degrees).
  // on marks the lamp as selected: while lightsOn, the selected lamps shine, or all if none is.
  lamps: [],
  lightsOn: true,
  torch: false,  // the walker's torch (T in pedestrian mode)
  lightsPanel: false,
  weatherPanel: false,
  weatherOn: true,  // the weather shown in the sky and light (clouds, sun and sky strength)
  // Thermal comfort panel; wind: the factor (0-1) applied to the weather file's wind speed.
  // inputs: the Inputs section is open.
  // clouds: count the simulated cloud over the camera, rather than the hour's average sun.
  comfort: { panel: false, inputs: false, wind: prefs.comfortWind >= 0 && prefs.comfortWind <= 1 ? prefs.comfortWind : 0.5, clouds: prefs.comfortClouds === true },
};
// Sun study settings. lat, lon and utcOffset follow the site location (applyLocation); north is
// the open model's. Dates are in EPW_YEAR: the year changes sun angles too little to matter.
state.sun = {
  on: false, panel: false,
  lat: 51.5074, lon: -0.1278, utcOffset: 0, north: 90,
  doy: dayOfYear(EPW_YEAR, 6, 21), hour: 12,
};
// The site location of the open model: a custom location, the weather file (epw, an EPW object)
// and which source to use (use: 'custom', 'epw', 'file' or null for the first that is set).
const site = { custom: null, epw: null, use: null };
state.ao = typeof prefs.ao === 'boolean' ? prefs.ao : true;
state.specials = typeof prefs.specials === 'boolean' ? prefs.specials : true; // the toolbar's Magic button
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
  onExit: () => { $('walkHint').hidden = true; endPlacing(); syncToolbar(); syncWalkPanel(); syncLightsPanel(); redraw(); },
  notice: (text, ms = 0) => notice(text, false, ms),
  fade: () => { const f = $('walkFade'); f.classList.add('on'); requestAnimationFrame(() => requestAnimationFrame(() => f.classList.remove('on'))); },
});
if (prefs.walk) {
  walker.settings.collide = prefs.walk.collide !== false;
  walker.settings.fly = prefs.walk.fly === true;
  if (prefs.walk.speed > 0) walker.settings.speed = Math.min(WALK.MAX_SPEED, Math.max(WALK.MIN_SPEED, prefs.walk.speed));
}
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
  applyLocation();
  Recent.store('readwrite', (s) => s.delete('epw')).catch(() => {}); // a browser-wide copy kept by earlier versions
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
  s.bgTop = STUDIO.top; s.bgBot = STUDIO.bottom;   // with the sun on, the sky colours follow the time of day
  s.edgeColor = state.sun.on ? [0.1, 0.11, 0.13, 0.35] : state.edgeColor;
  s.time = (performance.now() / 1000) % 3600;
  s.metresPerUnit = METRES_PER_UNIT[model.units] || 1;
  s.hazeStart = camera.distance;
  s.hazeDensity = camera.ortho ? 0 : 0.35 / R;
  s.lamps = shownLamps();
  if (state.sun.on) {
    const S = state.sun, pos = sunPosition(), light = sunLight(pos.altitude), moon = moonPosition(sunOpts());
    const wx = currentSky(pos.altitude);
    if (wx) overcastSky(light, wx.cover);
    s.bgTop = [...light.top, 1]; s.bgBot = [...light.horizon, 1];
    const sunDir = sunVector(pos.azimuth, pos.altitude, S.north), moonDir = sunVector(moon.azimuth, moon.altitude, S.north);
    // Once the sun is down, a moon above the horizon takes over as the light that casts shadows.
    // With a weather file, the sky is as bright as its diffuse radiation says, and the sun as its
    // direct: the cloud shadows (drawn on the model) and the haze between them (weatherSky)
    // share the dimming. The moon is shaded by the clouds alone.
    const moonRgb = moonLight(moon.altitude, moon.lit, light.night);
    const byMoon = light.up === 0 && moonRgb[2] > 0.004;
    const sunRgb = light.rgb.map((v) => v * (wx ? wx.haze : 1));
    s.sun = { dir: byMoon ? moonDir : sunDir, rgb: byMoon ? moonRgb : sunRgb, glow: light.glow, night: light.night,
      sky: (light.sky + 0.06 * moonRgb[2] / 0.32) * (wx ? wx.sky : 1), sunDir, moonDir, moonLit: moon.lit, lat: S.lat, north: S.north,
      lst: siderealTime(sunOpts()) };
    if (wx) s.clouds = { cover: wx.cover, drift: clouds.drift, haze: wx.haze };
    if ((light.up > 0 || byMoon) && !state.xray) {
      s.shadows = shadowCascades(cam, s.sun.dir, { center: c, radius: R * 1.9, receiverRadius: R * 1.1 });
    }
  }
  return s;
}

// Clouds: the weather file's sky at the Sun panel's date and time, and how far the clouds have
// drifted. They move with the 10 m wind times the Weather panel's multiplier (clouds sit higher,
// where the wind is stronger, and the multiplier also makes the drift easier to see).
let comfortAt = 0;   // when the thermal comfort panel last followed the drifting clouds
const clouds = { drift: [0, 0], last: 0, speed: prefs.cloudSpeed >= 0 && prefs.cloudSpeed <= CLOUD_SPEED_MAX ? prefs.cloudSpeed : 10 };

// The weather as the sky and light show it: null without a weather file or with the weather
// switched off (the Weather button's icon or the switch on its panel).
function currentSky(altitude) {
  const S = state.sun;
  return site.epw && state.weatherOn ? weatherSky(site.epw, S.doy, S.hour, altitude) : null;
}

function setWeatherOn(on) {
  state.weatherOn = on;
  $('weatherOn').checked = on;
  $('weatherQuick').setAttribute('aria-pressed', String(on));
  redraw();
}

// Greys the sky colours towards an even overcast as the cover closes in, and mutes the sunset glow.
function overcastSky(light, cover) {
  const k = 0.85 * Math.pow(cover, 1.5), lum = (c) => 0.3 * c[0] + 0.59 * c[1] + 0.11 * c[2];
  const g = 0.6 * lum(light.horizon) + 0.4 * lum(light.top), grey = [g * 0.97, g, g * 1.03];
  light.top = light.top.map((v, i) => v + (grey[i] - v) * k);
  light.horizon = light.horizon.map((v, i) => v + (grey[i] * 1.04 - v) * k);
  light.glow = light.glow.map((v) => v * (1 - 0.6 * cover));
}

// Moves the clouds on by the time since the last frame. Returns true while they are moving.
function driftClouds(now) {
  const dt = Math.min(0.1, (now - (clouds.last || now)) / 1000);
  clouds.last = now;
  if (!state.sun.on || !site.epw || !clouds.speed) return false;
  const wx = currentSky(sunPosition().altitude);
  if (!wx || wx.cover < 0.01 || wx.wind < 0.05) return false;
  const to = sunVector(wx.windFrom + 180, 0, state.sun.north), d = wx.wind * clouds.speed * dt;
  // Wrapped well before the noise's coordinates lose precision; a jump every few hundred km.
  clouds.drift = clouds.drift.map((v, i) => (v + to[i] * d) % 4e5);
  return true;
}

function sunOpts() {
  const S = state.sun;
  return { lat: S.lat, lon: S.lon, utcOffset: S.utcOffset, year: EPW_YEAR, doy: S.doy, hour: S.hour };
}
function sunPosition() { return solarPosition(sunOpts()); }

function loop() {
  // Water ripples animate while someone is using the viewer; after 15 s idle they freeze so an
  // untouched page does not keep the GPU busy.
  if (model && performance.now() - lastInput < 15000 && renderer.hasWater(state.mode)) renderer.dirty = true;
  // Drifting clouds likewise.
  if (model && performance.now() - lastInput < 15000 && driftClouds(performance.now())) {
    renderer.dirty = true;
    // A cloud may have moved over the camera.
    if (state.comfort.panel && state.comfort.clouds && performance.now() - comfortAt > 200) { comfortAt = performance.now(); syncComfortPanel(); }
  }
  if (walker.active) {
    walker.update(performance.now());
    renderer.dirty = true; lastInput = performance.now();
  }
  if (renderer.dirty) {
    renderer.dirty = false; renderer.draw(frameState()); positionInspector();
    if (state.comfort.panel) checkSunlight();
  }
  requestAnimationFrame(loop);
}

// ---------------------------------------------------------------------------------------------
// Loading

// handle: the file's FileSystemFileHandle, when there is one, for the recent files list.
async function openFile(file, handle = null) {
  if (/\.epw$/i.test(file.name)) { loadEpw(file); return; }
  if (!/\.3dm$/i.test(file.name)) { notice(`${file.name} is not a .3dm or .epw file.`, true); return; }
  showBusy(`Reading ${file.name}`, 0.02);
  await Recent.add(handle, file);
  renderRecent();
  await openBytes(file.name, new Uint8Array(await file.arrayBuffer()), handle);
}

// The custom location, weather file and choice of location linked to a model come back with it.
// Returns what came back, for a notice.
async function restoreLinks(handle) {
  const { custom, epw: d, use } = await Recent.links(handle), back = [];
  const c = custom && Math.abs(custom.lat) <= 90 && Math.abs(custom.lon) <= 180 && Math.abs(custom.utcOffset) <= 14 ? custom : null;
  if (c) { site.custom = { lat: +c.lat, lon: +c.lon, utcOffset: +c.utcOffset, name: typeof c.name === 'string' ? c.name : null }; back.push(`custom location ${site.custom.name || fmtCoords(c.lat, c.lon)}`); }
  if (d) {
    try { site.epw = EPW.fromBytes(d.bytes, d.name); back.push(`weather file ${d.name}`); }
    catch (e) { notice(`Could not read ${d.name}, the weather file linked to this model: ${e.message}`, true); }
  }
  if (['custom', 'epw', 'file'].includes(use)) site.use = use;
  return back;
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

// handle: the file's handle when it was opened from the user's files (see openFile).
async function openBytes(name, bytes, handle = null) {
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
    layerOn = m.layers.map((l) => l.visible); // before anything reads layer state for the new model
    model.name = name;
    model.size = bytes.length;
    model.bytes = bytes; // kept so a copy with the viewer's changes can be written
    model.handle = handle;
    // Rhino's point and spot lights light the scene as lamps (no shadows). Rhino's default
    // intensity (1) gives a lamp about as bright as a street light.
    state.lamps = (m.lights || []).map((l, i) => ({ name: l.name || `${l.dir ? 'Spot' : 'Point'} light ${i + 1}`, src: 'file', on: false,
      p: l.p, rgb: l.rgb, power: 25 * l.intensity, range: 30, dir: l.dir, inner: l.inner, outer: l.outer }));
    syncLightsPanel();
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
    applyLayerVisibility();
    buildLayerTree();
    applyLayerMaterials(false);
    Object.assign(site, { custom: null, epw: null, use: null }); // never carried over to another model
    const back = handle ? await restoreLinks(handle) : [];
    applyFileLocation(m.location);
    if (back.length) notice(`Restored with this model: ${back.join(' and ')}.`, false, 4000);
    viewNow = 'perspective'; viewCams = {};
    setView('perspective', true);
    leaveHome();
    $('fileName').textContent = name;
    document.title = `${name} · 3DM Viewer`;
    renderFileInfo();
    reportSkipped(m.stats);
    return true;
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
  const walking = walker.active || !!walker.placing;
  $('walkQuick').setAttribute('aria-pressed', String(walking));
  $('walkQuick').disabled = $('walkOn').disabled = !model || (camera.ortho && !walking);
  $('walkOn').checked = walking;
  document.body.classList.toggle('walking', walker.active);
  $('btnWalk').setAttribute('aria-pressed', String(!$('walkPanel').hidden));
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
  const L = model.layers;
  const visibleOn = (layers) => {
    const set = new Set(layers);
    return model.objects.flatMap((o, id) => (!o.gone && set.has(o.layer) && !state.hidden.has(id) && layerEffective(o.layer) ? [id] : []));
  };
  const setOn = (on) => { for (const l of tree || [i]) layerOn[l] = on; applyLayerVisibility(); buildLayerTree.refresh(); renderFileInfo(); };
  const own = visibleOn([i]), all = tree && visibleOn(tree);
  showMenu(L[i].fullPath, [
    { label: 'Select objects', n: own.length, run: () => selectObjects(own) },
    tree && { label: 'Select sublayer objects', n: all.length, run: () => selectObjects(all) },
    '-',
    { label: 'Show all', run: () => setOn(true) },
    { label: 'Hide all', run: () => setOn(false) },
  ].filter(Boolean), [x, y]);
}

// A right-click menu at (x, y): items are { label, n (a count shown on the right; 0 disables
// the item), run } or '-' for a divider.
function showMenu(titleText, items, [x, y]) {
  const menu = $('layerMenu');
  menu.innerHTML = '';
  const title = document.createElement('div');
  title.className = 'menu-title';
  title.textContent = title.title = titleText;
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
// object colour and material sources, exploded blocks, the north angle, Revert) can be undone. View
// changes, hiding objects, turning layers on or off and the site location (a viewer setting, not
// part of the model) are not recorded. Each entry keeps the edit state from before the change;
// undoing swaps it with the current one. Not kept between sessions.

const history = { undo: [], redo: [], coalesce: null };
const UNDO_LIMIT = 100;
const editSnapshot = () => structuredClone({ layerMat: state.layerMat, layerColor: state.layerColor, layerSpecial: state.layerSpecial, objEdits: state.objEdits, exploded: state.exploded,
  north: state.sun.north });

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
  if (e.north !== undefined) { setSun({ north: e.north }); renderFileInfo(); }
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
  if (state.sun.north !== fileNorth()) changes.push('North angle changed');
  if (document.activeElement !== $('fileNorth')) $('fileNorth').value = state.sun.north;
  $('fileNorthInfo').textContent = `Degrees anticlockwise from the model’s +X axis to north (90: +Y is north). ${loc ? `The file’s is ${+fileNorth().toFixed(1)}°, from its ${loc.source}.` : 'The file does not set one; 90 is the default.'}`;
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
    'Layer colours, materials and magic materials (back to Auto), object colours and materials, exploded blocks, the north angle, hidden objects and layer visibility go back to how they are in the file.\n\nUndo (Ctrl+Z) brings back the colour, material, block and north angle changes, but not hidden objects or layer visibility.',
    'Revert', { danger: true });
  if (!ok) return;
  const n = editCount(), north = fileNorth();
  if (n.mat + n.col + n.obj + n.expl || state.sun.north !== north) recordUndo('Revert changes');
  setSun({ north });
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
  renderFileInfo();
}

// The open model's north angle: the file's own (Rhino sun settings or Earth anchor), else 90.
const fileNorth = () => (model?.location ? +model.location.north.toFixed(2) : 90);

function bindFileDialog() {
  const north = $('fileNorth');
  north.addEventListener('input', () => {
    const v = parseFloat(north.value);
    if (!model || !Number.isFinite(v) || Math.abs(v) > 360 || v === state.sun.north) return;
    recordUndo('Change north angle', 'north');
    setSun({ north: v });
    renderFileInfo();
  });
  north.addEventListener('change', endUndoGroup);
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

// A newly opened model: its north angle, and the date and time from Rhino's sun settings if any.
function applyFileLocation(loc) {
  const S = state.sun;
  S.north = fileNorth();
  if (loc?.date) { S.doy = dayOfYear(EPW_YEAR, loc.date.month, loc.date.day); S.hour = loc.date.hour; }
  applyLocation();
}

function syncSunPanel() {
  const S = state.sun;
  $('sunOn').checked = S.on;
  $('sunQuick').setAttribute('aria-pressed', String(S.on));
  $('sunDay').max = daysInYear(EPW_YEAR);
  $('sunDay').value = S.doy;
  $('sunHour').value = S.hour;
  const { month, day } = dateFromDayOfYear(EPW_YEAR, S.doy);
  $('sunDateOut').textContent = `${day} ${MONTHS[month - 1]}`;
  $('sunTimeOut').textContent = `${fmtHour(S.hour)} ${fmtUtc(S.utcOffset)}`;
  syncWeather(month, day);
  syncComfortPanel();
  if (!activeLocation()) {
    $('sunTimeOut').textContent = fmtHour(S.hour);
    $('sunRead').innerHTML = 'No location is set, so the sun cannot be shown. <button class="link">Set location…</button>';
    document.querySelector('[data-act="sun"]').setAttribute('aria-pressed', String(S.panel));
    return;
  }
  const p = sunPosition();
  const dirName = COMPASS[Math.round(p.azimuth / 22.5) % 16];
  const pos = p.altitude > -0.83
    ? `Altitude <b>${p.altitude.toFixed(1)}°</b> · Azimuth <b>${p.azimuth.toFixed(1)}°</b> (${dirName})`
    : `<b>Sun below the horizon</b> (${p.altitude.toFixed(1)}°)`;
  const day2 = p.polar === 'day' ? 'Sun up all day' : p.polar === 'night' ? 'Sun down all day' : `Sunrise <b>${fmtHour(p.sunrise)}</b> · Sunset <b>${fmtHour(p.sunset)}</b>`;
  $('sunRead').innerHTML = `${pos}<br>${day2}`;
  document.querySelector('[data-act="sun"]').setAttribute('aria-pressed', String(S.panel));
}

function setSun(changes) {
  if (changes.on && !activeLocation()) {
    changes = { ...changes, on: false };
    warnNoLocation('The sun needs a location to be turned on.');
  }
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
  if (!state.sun.on) return; // no location
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
  // Date and time work with the sun off too, for the weather.
  $('sunDay').addEventListener('input', (e) => setSun({ doy: +e.target.value }));
  $('sunHour').addEventListener('input', (e) => setSun({ hour: +e.target.value }));
  // Right-click the date slider for the solstices and equinoxes.
  $('sunDay').addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const at = (label, m, d) => ({ label, run: () => setSun({ doy: dayOfYear(EPW_YEAR, m, d) }) });
    showMenu('Go to', [at('21 March · equinox', 3, 21), at('21 June · solstice', 6, 21), at('23 September · equinox', 9, 23),
      at('21 December · solstice', 12, 21)], [e.clientX, e.clientY]);
  });
  // Right-click the time slider for the usual analysis times.
  $('sunHour').addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const at = (label, hour) => ({ label, run: () => setSun({ hour }) });
    const noon = activeLocation() ? sunPosition().noon : null;
    showMenu('Go to', [at('10:00', 10), at('12:00', 12), noon != null && at(`Solar noon · ${fmtHour(noon)}`, noon), at('15:00', 15)].filter(Boolean),
      [e.clientX, e.clientY]);
  });
  $('sunPlay').addEventListener('click', toggleSunPlay);
  document.querySelector('[data-act="weather"]').addEventListener('click', toggleWeatherPanel);
  $('weatherClose').addEventListener('click', () => state.weatherPanel && toggleWeatherPanel());
  $('weatherBody').addEventListener('click', (e) => { if (e.target.closest('.link')) openWeatherDialog(); });
  $('cloudSpeed').addEventListener('input', (e) => { clouds.speed = +e.target.value; savePrefs(); syncSunPanel(); redraw(); });
  $('weatherOn').addEventListener('change', (e) => setWeatherOn(e.target.checked));
  $('weatherQuick').addEventListener('click', () => setWeatherOn(!state.weatherOn));
  $('weatherCombo').addEventListener('click', (e) => { if (e.target === e.currentTarget) toggleWeatherPanel(); }); // the gaps round the icon
  setWeatherOn(state.weatherOn);
  $('sunRead').addEventListener('click', (e) => { if (e.target.closest('.link')) openLocationDialog(); });
  syncSunPanel();
}

// The Weather panel: the weather file at the Sun panel's date and time (interpolated).
function toggleWeatherPanel() {
  state.weatherPanel = !state.weatherPanel;
  $('weatherPanel').hidden = !state.weatherPanel;
  document.querySelector('[data-act="weather"]').setAttribute('aria-pressed', String(state.weatherPanel));
  syncSunPanel();
}

function syncWeather(month, day) {
  if (!state.weatherPanel) return;
  const el = $('weatherBody'), e = site.epw;
  $('weatherSrc').textContent = e ? e.location.name || e.fileName : 'No weather file';
  $('weatherSrc').title = e ? e.fileName : '';
  $('weatherWhen').value = `${day} ${MONTHS[month - 1]} · ${fmtHour(state.sun.hour)}`;
  $('cloudSpeedField').hidden = !e;
  $('cloudSpeed').value = clouds.speed;
  $('cloudSpeedOut').value = clouds.speed ? `${clouds.speed}× wind` : 'Still';
  if (!e) {
    el.innerHTML = '<span class="fine">Add a weather file (EPW) to see the weather at this date and time.</span> <button class="link">Add one…</button>';
    return;
  }
  const w = e.at(month, day, state.sun.hour), v = (x, d = 0) => (x === null ? '—' : x.toFixed(d));
  const sky = weatherSky(e, state.sun.doy, state.sun.hour, activeLocation() ? sunPosition().altitude : 30);
  const cloud = !sky || sky.source === 'none' ? '—'
    : `<b>${Math.round(sky.cover * 10)}</b>/10 <span class="fine">${sky.source === 'observed' ? 'observed' : 'from radiation'}</span>`;
  const wind = w.windSpeed === null ? '—' : w.windSpeed < 0.05 ? '<b>Calm</b>'
    : `<b>${v(w.windSpeed, 1)}</b> m/s${w.windDirection === null ? '' : ` from ${COMPASS[Math.round(w.windDirection / 22.5) % 16]} (${v(w.windDirection)}°)`}`;
  el.innerHTML = `<dl class="wx">
    <dt>Air temperature</dt><dd><b>${v(w.dryBulb, 1)}</b> °C</dd>
    <dt>Relative humidity</dt><dd><b>${v(w.relativeHumidity)}</b>%</dd>
    <dt>Wind</dt><dd>${wind}</dd>
    <dt>Cloud cover</dt><dd title="${sky?.source === 'radiation' ? 'This file has no usable cloud observations, so the cover is estimated from the share of diffuse light, by day, and filled in overnight' : 'Total sky cover from the weather file'}">${cloud}</dd>
    <dt>Global horizontal</dt><dd><b>${v(w.globalHorizontal)}</b> W/m²</dd>
    <dt>Direct normal</dt><dd><b>${v(w.directNormal)}</b> W/m²</dd>
    <dt>Diffuse horizontal</dt><dd><b>${v(w.diffuseHorizontal)}</b> W/m²</dd></dl>`;
}

// "UTC", "UTC+3", "UTC−3:30".
function fmtUtc(h) {
  const a = Math.abs(h), m = Math.round((a % 1) * 60);
  return h === 0 ? 'UTC' : `UTC${h > 0 ? '+' : '−'}${Math.floor(a)}${m ? ':' + String(m).padStart(2, '0') : ''}`;
}

// ---------------------------------------------------------------------------------------------
// Site location and weather file. Three sources: a custom location (typed in or a city), the
// weather file's and the open Rhino file's. The one chosen with "Use this location" is used;
// until a choice is made, the first that is set, in that order. With none, there is no location
// and the sun cannot be turned on.
//
// The custom location, the weather file and the choice belong to the open model: opening another
// model clears them, and only those linked to it (in its recent files entry) come back with it.

const LOCATION_KINDS = { custom: 'custom location', epw: 'from the weather file', file: 'from the Rhino file' };
const fmtCoords = (lat, lon) => `${Math.abs(lat).toFixed(2)}° ${lat < 0 ? 'S' : 'N'}, ${Math.abs(lon).toFixed(2)}° ${lon < 0 ? 'W' : 'E'}`;

// { lat, lon, utcOffset, name, kind } for one source, or null when it has no location.
function locationOf(kind) {
  if (kind === 'custom') return site.custom && { ...site.custom, kind };
  if (kind === 'epw') {
    const e = site.epw?.location;
    return e?.known ? { lat: e.lat, lon: e.lon, utcOffset: e.utcOffset ?? Math.round(e.lon / 15), name: e.name, kind } : null;
  }
  const f = model?.location;
  return f ? { lat: f.lat, lon: f.lon, utcOffset: f.utcOffset, name: null, kind } : null;
}
const activeLocation = () => (site.use && locationOf(site.use)) || locationOf('custom') || locationOf('epw') || locationOf('file');

function applyLocation() {
  const A = activeLocation();
  if (A) Object.assign(state.sun, { lat: +A.lat.toFixed(5), lon: +A.lon.toFixed(5), utcOffset: A.utcOffset });
  else if (state.sun.on) { state.sun.on = false; warnNoLocation('The sun is off because there is no location now.'); }
  $('btnLocation').classList.toggle('set', !!A);
  $('locName').textContent = A ? A.name || fmtCoords(A.lat, A.lon) : 'Set location';
  $('btnLocation').title = A ? `${A.name ? fmtCoords(A.lat, A.lon) + ', ' : ''}${fmtUtc(A.utcOffset)}, ${LOCATION_KINDS[A.kind]}. Click to change the location.`
    : 'Set the site location';
  const e = site.epw;
  $('btnWeather').classList.toggle('set', !!e);
  $('btnWeather').title = e ? `Weather file: ${e.fileName}` : 'Add a weather file (EPW)';
  locationDialog?.refresh();
  weatherDialog?.refresh();
  syncSunPanel();
  redraw();
}

function warnNoLocation(why) {
  document.querySelectorAll('.notice.no-loc').forEach((n) => n.remove());
  notice(`${why} Set one from a weather file, a custom location or the Rhino file.`, false, 0, { label: 'Set location…', run: openLocationDialog }).classList.add('no-loc');
}

// Save a change to the open model's links. Typing saves once the typing pauses.
let linkTimer = 0, linkPending = null; // { handle, changes }
function linkToModel(changes, delay = 0) {
  const h = model?.handle;
  if (!h) return;
  if (linkPending && linkPending.handle !== h) flushLinks();
  linkPending = { handle: h, changes: { ...linkPending?.changes, ...changes } };
  clearTimeout(linkTimer);
  if (delay) linkTimer = setTimeout(flushLinks, delay); else flushLinks();
}
function flushLinks() {
  clearTimeout(linkTimer);
  const p = linkPending;
  linkPending = null;
  if (p) Recent.link(p.handle, p.changes).then(renderRecent);
}

function useLocation(kind) {
  site.use = kind;
  linkToModel({ use: kind });
  applyLocation();
}

function setCustomLocation(c, typing = false) {
  site.custom = c;
  site.use = 'custom';
  linkToModel({ custom: c, use: 'custom' }, typing ? 400 : 0);
  applyLocation();
}

// A weather file from the Weather file dialog or dropped onto the window. A new one is used
// for the location straight away, when it has one.
async function loadEpw(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  try { setEpw(EPW.fromBytes(bytes, file.name), bytes); }
  catch (e) { notice(`Could not read ${file.name}: ${e.message}`, true); return; }
  if (!site.epw.location.known) notice(`${file.name} has no usable latitude and longitude, so it does not set the location. Its weather is still shown.`);
  else notice(`Location and weather from ${file.name}.`, false, 3000);
}

// epw: an EPW object, or null to remove it. A copy of the file is linked to the open model.
function setEpw(epw, bytes) {
  site.epw = epw;
  if (epw?.location.known) site.use = 'epw';
  else if (site.use === 'epw') site.use = null;
  linkToModel({ epw: epw ? { name: epw.fileName, bytes } : null, use: site.use });
  applyLocation();
}

// The weather file's name, place and coordinates (or that there is none), as HTML.
function epwStatusHtml() {
  const e = site.epw;
  return e
    ? `<div>${escapeHtml(e.location.name || 'Unnamed location')}</div><div class="fine">${escapeHtml(e.fileName)} · ${e.location.known ? `${fmtCoords(e.location.lat, e.location.lon)} · ${fmtUtc(e.location.utcOffset ?? 0)}` : 'no usable latitude and longitude; its weather is still shown'}</div>`
    : '<div class="fine">None. Choose one, or drop an .epw file onto the window.</div>';
}

// Weather file dialog: load, replace or remove the open model's EPW file.
let weatherDialog = null;
function openWeatherDialog() {
  if (weatherDialog) return;
  const wrap = document.createElement('div');
  wrap.className = 'loc-dlg';
  wrap.innerHTML = `
    <section class="loc-src">
      <div class="loc-status" data-el="epw"></div>
      <div class="loc-actions"><button class="btn small" data-el="pick"></button><button class="link" data-el="remove">Remove</button></div>
    </section>
    <div class="fine" data-el="note"></div>
    <input type="file" accept=".epw" data-el="input" hidden>`;
  const el = (k) => wrap.querySelector(`[data-el="${k}"]`);
  el('pick').addEventListener('click', () => el('input').click());
  el('input').addEventListener('change', () => { const f = el('input').files[0]; el('input').value = ''; if (f) loadEpw(f); });
  el('remove').addEventListener('click', () => setEpw(null, null));
  const refresh = () => {
    const e = site.epw;
    el('epw').innerHTML = epwStatusHtml();
    el('pick').textContent = e ? 'Replace…' : 'Choose EPW file…';
    el('remove').hidden = !e;
    el('note').textContent = `The weather file gives the weather in the Weather panel at the Sun panel's date and time. A new one with a latitude and longitude also sets the site location (see Set location). ${!model
      ? 'It belongs to the open model; with none open, it is cleared when one is opened.'
      : model.handle ? `It belongs to ${model.name} and comes back when you reopen it from Recent files.`
        : `It belongs to ${model.name} while it is open.`}`;
  };
  refresh();
  weatherDialog = { refresh };
  Dialog.open({ title: 'Weather file', body: wrap, buttons: [{ label: 'Done', value: true, primary: true }], width: 420 })
    .then(() => { weatherDialog = null; });
}

// Set location dialog: the three sources, each marked "In use" or offering "Use this location".
// Changes apply as they are made.
let locationDialog = null;
function showLocationHelp() {
  Dialog.open({ title: 'Location', html: true, width: 400, body: `<p>The site location places the sun and sets the clock's UTC offset. It can come from three sources; <b>Use this location</b> picks which one is used.</p>
    <p><b>Weather file (EPW)</b>: the location in the file. Choose or replace it here, with the sun-and-cloud button next to the pin, or by dropping an .epw file onto the window. Its weather shows in the Weather panel and drives the UTCI.</p>
    <p><b>Custom location</b>: type a latitude and longitude, or search for a city or country. The UTC offset follows the longitude until you type one.</p>
    <p><b>Rhino file</b>: the location saved in the .3dm file, if it has one.</p>
    <p>The sun needs a location. The choice, the custom location and the weather file belong to the open model, and come back with it when you reopen it from Recent files.</p>` });
}

function openLocationDialog() {
  if (locationDialog) return;
  const wrap = document.createElement('div');
  wrap.className = 'loc-dlg';
  const head = (kind, title) => `<div class="loc-head"><b>${title}</b><button class="btn small" data-use="${kind}"></button></div>`;
  wrap.innerHTML = `
    <section class="loc-src" data-kind="epw">
      ${head('epw', 'Weather file (EPW)')}
      <div class="loc-status" data-el="epw"></div>
      <div class="loc-actions"><button class="btn small" data-el="pick"></button></div>
    </section>
    <section class="loc-src" data-kind="custom">
      ${head('custom', 'Custom location')}
      <div class="grid3">
        <label>Latitude<input type="number" data-el="lat" step="0.0001" min="-90" max="90"></label>
        <label>Longitude<input type="number" data-el="lon" step="0.0001" min="-180" max="180"></label>
        <label>UTC offset (h)<input type="number" data-el="utc" step="0.5" min="-12" max="14"></label>
      </div>
      <input type="search" class="city-search" placeholder="Or search cities and countries" aria-label="Search cities">
      <div class="city-list" role="listbox"></div>
    </section>
    <section class="loc-src" data-kind="file">
      ${head('file', 'Rhino file')}
      <div class="loc-status" data-el="file"></div>
    </section>
    <div class="fine" data-el="note"></div>`;
  const el = (k) => wrap.querySelector(`[data-el="${k}"]`);
  const lat = el('lat'), lon = el('lon'), utc = el('utc'), search = wrap.querySelector('.city-search'), list = wrap.querySelector('.city-list');

  wrap.querySelectorAll('[data-use]').forEach((b) => b.addEventListener('click', () => useLocation(b.dataset.use)));
  el('pick').addEventListener('click', openWeatherDialog);

  // Typing a latitude and longitude sets the custom location; the UTC offset follows the
  // longitude until one is typed.
  let utcTyped = !!site.custom;
  const typed = () => {
    const a = parseFloat(lat.value), o = parseFloat(lon.value), u = parseFloat(utc.value);
    if (!(Math.abs(a) <= 90 && Math.abs(o) <= 180)) return;
    setCustomLocation({ lat: a, lon: o, utcOffset: utcTyped && Math.abs(u) <= 14 ? u : Math.round(o / 15), name: null }, true);
  };
  lat.addEventListener('input', typed);
  lon.addEventListener('input', typed);
  utc.addEventListener('input', () => { utcTyped = utc.value !== ''; typed(); });

  const showCities = () => {
    const q = search.value.trim().toLowerCase();
    const hits = CITIES.filter(([n, c]) => !q || n.toLowerCase().includes(q) || c.toLowerCase().includes(q));
    list.innerHTML = hits.length ? '' : '<div class="empty">No matching city. Type a latitude and longitude above instead.</div>';
    for (const [name, country, la, lo, off] of hits) {
      const b = document.createElement('button');
      b.setAttribute('role', 'option');
      b.innerHTML = '<span></span><span class="n"></span>';
      b.firstChild.textContent = `${name}, ${country}`;
      b.lastChild.textContent = `${la.toFixed(2)}, ${lo.toFixed(2)} · ${fmtUtc(off)}`;
      b.setAttribute('aria-selected', String(site.custom?.name === `${name}, ${country}`));
      b.addEventListener('click', () => { utcTyped = true; setCustomLocation({ lat: la, lon: lo, utcOffset: off, name: `${name}, ${country}` }); });
      list.appendChild(b);
    }
  };
  search.addEventListener('input', showCities);
  search.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.stopPropagation(); list.querySelector('button')?.click(); } });

  const refresh = () => {
    const A = activeLocation(), e = site.epw, c = site.custom, f = model?.location;
    wrap.querySelectorAll('.loc-src').forEach((s) => s.classList.toggle('active', A?.kind === s.dataset.kind));
    // Each source with a location has a button: "Use this location", or "In use" (not clickable).
    // Both look alike; the outline round the source shows which is in use.
    wrap.querySelectorAll('[data-use]').forEach((b) => {
      const inUse = A?.kind === b.dataset.use;
      b.hidden = !locationOf(b.dataset.use);
      b.disabled = inUse;
      b.classList.toggle('in-use', inUse);
      b.textContent = inUse ? 'In use' : 'Use this location';
    });
    el('epw').innerHTML = epwStatusHtml();
    el('pick').textContent = e ? 'Replace…' : 'Choose EPW file…';
    for (const [input, k] of [[lat, 'lat'], [lon, 'lon'], [utc, 'utcOffset']])
      if (document.activeElement !== input) input.value = c ? c[k] : '';
    el('file').innerHTML = !model ? '<div class="fine">No file open</div>'
      : f ? `<div>${fmtCoords(f.lat, f.lon)} · ${fmtUtc(f.utcOffset)}</div><div class="fine">From the ${escapeHtml(f.source)} in ${escapeHtml(model.name)}</div>`
        : `<div class="fine">${escapeHtml(model.name)} does not set a location</div>`;
    el('note').textContent = `${A ? '' : 'No location is set, so the sun cannot be turned on. '}A new weather file or custom location is used straight away. ${!model
      ? 'They belong to the open model; with none open, they are cleared when one is opened.'
      : model.handle ? `They belong to ${model.name}, with your choice, and come back when you reopen it from Recent files. Other models do not use them.`
        : `They belong to ${model.name} while it is open. It was not opened from your files, so they cannot be kept with it.`}`;
    showCities();
  };
  refresh();
  locationDialog = { refresh };
  Dialog.open({ title: 'Set location', body: wrap, buttons: [{ label: 'Done', value: true, primary: true }], width: 460, help: showLocationHelp })
    .then(() => { locationDialog = null; });
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
    hoverAt = { clientX: e.clientX, clientY: e.clientY };
    if (walker.placing && !drag) showWalkMarker(hoverAt);
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
      if (camera.ortho) viewNow = null;
      syncToolbar();
    } else if (drag.mode === 'pan') camera.pan(dx, dy, canvas.getBoundingClientRect().height);
    redraw();
  });

  const end = (e) => {
    pointers.delete(e.pointerId);
    // A left click or tap without dragging selects the object under the pointer.
    // While choosing where to start walking, it starts there instead.
    if (pointers.size === 0 && drag && !drag.moved && drag.mode !== 'pinch' && (drag.button === 0 || e.pointerType === 'touch') && e.type === 'pointerup') {
      if (walker.placing) startWalkAt(e);
      else pickAt(e).then((h) => selectObject(h ? h.id : null, h ? h.p : null, e.shiftKey));
    }
    if (pointers.size === 0) { drag = null; canvas.classList.remove('dragging'); }
    else if (pointers.size === 1) {
      const [p] = pointers.values();
      drag = { mode: walker.active ? 'look' : 'orbit', x: p.x, y: p.y, moved: true };
    }
  };
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);
  canvas.addEventListener('pointerleave', () => { if (walker.placing && state.walkMarker) { placing.next = null; state.walkMarker = null; redraw(); } });

  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    if (!model) return;
    if (walker.active) { walker.zoom(e.deltaY); redraw(); return; }
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

// ---------------------------------------------------------------------------------------------
// Lights: the file's point and spot lights, lamps added here (B puts one just off the surface
// under the cursor, towards the eye; Shift+B removes the added ones) and the walker's torch.

let hoverAt = null;
function placeLamp() {
  if (!hoverAt) return;
  pickAt(hoverAt).then((h) => {
    if (!h) return;
    const mpu = METRES_PER_UNIT[model.units] || 1, back = V3.norm(V3.sub(camera.eye, h.p));
    const p = V3.add(h.p, V3.scale(back, 0.4 / mpu));
    const n = state.lamps.filter((l) => l.src === 'added').length + 1;
    // A new lamp joins the selection, if there is one; otherwise all lamps shine anyway.
    state.lamps = [...state.lamps, { name: `Lamp ${n}`, src: 'added', on: state.lamps.some((l) => l.on), p, rgb: [1, 0.62, 0.32], power: 25, range: 30 }];
    syncLightsPanel();
    redraw();
  });
}
function clearLamps() { state.lamps = state.lamps.filter((l) => l.src !== 'added'); syncLightsPanel(); redraw(); }

function setTorch(on) { state.torch = on; syncLightsPanel(); redraw(); }

function setLightsOn(on) {
  state.lightsOn = on;
  $('lightsOn').checked = on;
  $('lightsQuick').setAttribute('aria-pressed', String(on));
  syncLightsPanel();
  redraw();
}

// The file's and added lamps that shine: none while the lights are off, else the selected ones,
// or all of them when none is selected. The torch has its own switch.
function litLamps() {
  if (!state.lightsOn) return [];
  return state.lamps.some((l) => l.on) ? state.lamps.filter((l) => l.on) : state.lamps;
}

// The lamps that light the scene this frame: the torch first (held at chest height, a little to
// the right, pointing where the walker looks), then the lights that shine. The renderer uses the
// first MAX_LAMPS; lampShadowPlan decides which of those cast shadows.
function shownLamps() {
  const on = litLamps();
  if (!state.torch || !walker.active || !model) return on;
  const u = 1 / (METRES_PER_UNIT[model.units] || 1);
  const hand = V3.add(camera.eye, V3.add(V3.scale(camera.right, 0.2 * u), V3.scale(camera.up, -0.3 * u)));
  return [{ name: 'Torch', p: hand, dir: camera.forward, inner: 9, outer: 20, rgb: [1, 0.94, 0.84], power: 20, range: 40 }, ...on];
}

function toggleLightsPanel() {
  state.lightsPanel = !state.lightsPanel;
  $('lightsPanel').hidden = !state.lightsPanel;
  document.querySelector('[data-act="lights"]').setAttribute('aria-pressed', String(state.lightsPanel));
  syncLightsPanel();
}

function syncLightsPanel() {
  if (!state.lightsPanel) return;
  // Which lights the renderer uses and which cast shadows, as it will see them.
  const shown = shownLamps().slice(0, MAX_LAMPS), plan = lampShadowPlan(shown), lit = litLamps();
  const status = (l) => {
    const i = shown.indexOf(l);
    if (!lit.includes(l)) return 'off';
    if (i < 0) return `not shown (${MAX_LAMPS} at most)`;
    return plan[i] ? 'shadows' : 'no shadows';
  };
  const hex = (rgb) => `#${rgb.map((v) => Math.round(255 * Math.min(1, v) ** (1 / 2.2)).toString(16).padStart(2, '0')).join('')}`;
  const row = (l, i) => `<div class="light-row${lit.includes(l) ? '' : ' off'}" data-i="${i}">
      <input type="checkbox" ${l.on ? 'checked' : ''} aria-label="Select ${escapeHtml(l.name)}" title="Select: only the selected lights shine (all of them when none is)">
      <span class="swatch" style="background:${hex(l.rgb)}"></span>
      <span class="light-name" title="${escapeHtml(l.name)}">${escapeHtml(l.name)}</span>
      <span class="light-meta">${l.dir ? 'Spot' : 'Point'} · ${status(l)}</span>
      ${l.src === 'added' ? '<button class="x" title="Remove this lamp" aria-label="Remove">×</button>' : ''}</div>`;
  const group = (title, src) => {
    const rows = state.lamps.map((l, i) => (l.src === src ? row(l, i) : '')).join('');
    return rows ? `<div class="lights-group">${title}</div>${rows}` : '';
  };
  const torchMeta = !walker.active ? 'in walk mode' : state.torch ? (plan[0] ? 'shadows' : 'on') : 'off';
  $('lightsList').innerHTML = `<div class="light-row${state.torch ? '' : ' off'}" data-torch>
      <input type="checkbox" ${state.torch ? 'checked' : ''} aria-label="Torch on">
      <span class="swatch" style="background:#fff4e0"></span>
      <span class="light-name">Torch (T)</span><span class="light-meta">Spot · ${torchMeta}</span></div>`
    + (group('From the Rhino file', 'file') || '<div class="lights-empty">The Rhino file has no point or spot lights.</div>')
    + group('Added here', 'added');
}

function showLightsHelp() {
  Dialog.open({ title: 'Lights', html: true, width: 360, body: `<p>The Rhino file's point and spot lights, lamps you add and the walker's torch light the model; they show best at night.</p>
    <p><kbd>B</kbd> adds a lamp just off the surface under the cursor · <kbd>Shift</kbd>+<kbd>B</kbd> removes the lamps you added · <kbd>T</kbd> switches the torch on and off while walking.</p>
    <p>The switch at the top (or the bulb on the toolbar's Lights button) turns the file's and added lights on and off. While on, the ticked lights shine; with none ticked, all of them do. The torch has its own checkbox.</p>
    <p>Up to ${MAX_LAMPS} lights shine at once: the torch first, then the list in order. The torch and about four lamps also cast shadows.</p>` });
}

function bindLightsPanel() {
  document.querySelector('[data-act="lights"]').addEventListener('click', toggleLightsPanel);
  $('lightsClose').addEventListener('click', () => state.lightsPanel && toggleLightsPanel());
  $('lightsHelp').addEventListener('click', showLightsHelp);
  $('lightsOn').addEventListener('change', (e) => setLightsOn(e.target.checked));
  $('lightsQuick').addEventListener('click', () => setLightsOn(!state.lightsOn));
  $('lightsCombo').addEventListener('click', (e) => { if (e.target === e.currentTarget) toggleLightsPanel(); }); // the gaps round the icon
  setLightsOn(state.lightsOn);
  $('lightsList').addEventListener('change', (e) => {
    const r = e.target.closest('.light-row');
    if (!r) return;
    if (r.hasAttribute('data-torch')) { setTorch(e.target.checked); return; }
    state.lamps[+r.dataset.i].on = e.target.checked;
    syncLightsPanel();
    redraw();
  });
  $('lightsList').addEventListener('click', (e) => {
    const r = e.target.closest('.light-row');
    if (!r || !e.target.closest('.x')) return;
    state.lamps.splice(+r.dataset.i, 1);
    syncLightsPanel();
    redraw();
  });
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
  if (walker.placing && k === 'escape') { e.preventDefault(); walker.exit(); return; }
  const actions = {
    f: zoomExtents,
    1: () => pickView('top'), 2: () => pickView('front'), 3: () => pickView('right'), 4: () => pickView('perspective'),
    p: () => { walker.exit(); camera.ortho = !camera.ortho; state.lastView = null; viewNow = null; syncToolbar(); redraw(); },
    m: () => setMode((state.mode + 1) % 3),
    e: () => toggle('showEdges'), c: () => toggle('showCurves'), x: () => toggle('xray'), o: () => toggle('ao'), l: () => toggle('layers'), s: toggleSunPanel,
    '?': toggleHelp, escape: () => {
      if (atHome) { leaveHome(); return; } closeLayerMenu(); $('matDialog').hidden = true; $('fileDialog').hidden = true; selectObject(null); },
    h: hideSelected,
    b: () => (e.shiftKey ? clearLamps() : placeLamp()),
    t: () => { if (walker.active) setTorch(!state.torch); },
    g: toggleLightsPanel,
    u: toggleComfortPanel,
  };
  if (actions[k] && (model || ['?', 'escape', 'l'].includes(k))) { e.preventDefault(); actions[k](); }
}

// ---------------------------------------------------------------------------------------------
// Toolbar and chrome

// Top, Front, Right and Perspective each keep their own camera: leaving one remembers it, and
// coming back restores it (the first visit, or picking the view you are in, zooms to extents).
// viewNow is the view the camera belongs to: the last one picked, kept while panning, zooming,
// walking and orbiting in perspective. Orbiting Top, Front or Right, or P, makes it a free view
// that belongs to none.
let viewNow = 'perspective', viewCams = {};
function pickView(name) {
  walker.exit();
  if (viewNow && viewNow !== name) viewCams[viewNow] = camera.snapshot();
  const saved = viewNow !== name && viewCams[name];
  viewNow = name; state.lastView = name;
  if (!saved) { setView(name, true); return; }
  camera.restore(saved);
  syncToolbar();
  redraw();
}
// Walking on and off: the Walk button's icon and the switch on the Walk panel. Turning it on
// usually first asks where to start: the figure follows the cursor, a marker shows the spot under it,
// and a click there starts walking (as Street View's figure is dropped). Esc, the icon or the
// switch cancel. The start is found as a lamp's place is (B): the surface under the cursor, a
// little towards the eye; the walker then stands on the ground below it.
// With the camera already near the ground (back from a walk, say), walking starts where it is.
const WALK_MARKER = 1;   // marker radius (m)
const WALK_NEAR = 3;     // camera at most this high above the surface below it (m): no choosing
const placing = { busy: false, next: null, checking: false };
function toggleWalk() {
  if (walker.active || walker.placing) { walker.exit(); return; }
  if (!model || camera.ortho) { syncWalkPanel(); return; }
  if (placing.checking) return;
  placing.checking = true;
  heightAboveGround().then((h) => {
    placing.checking = false;
    if (walker.active || walker.placing || !model || camera.ortho) return;
    if (h != null && h <= WALK_NEAR) enterWalkHere(); else startPlacing();
  });
}
function enterWalkHere() {
  state.lastView = null;
  $('walkHint').hidden = false;
  walker.enter().then(() => { syncToolbar(); syncWalkPanel(); syncLightsPanel(); });
  syncToolbar();
  syncWalkPanel();
  canvas.focus();
}
// Height (m) of the camera above the surface straight below it, or null with nothing there:
// a one-pixel orthographic view looking down (as checkSunlight looks towards the sun).
function heightAboveGround() {
  const mpu = METRES_PER_UNIT[model.units] || 1, u = 1 / mpu, eye = camera.eye, [mn] = visibleBounds();
  const far = eye[2] - mn[2] + u;
  if (far <= 0) return Promise.resolve(null);
  const W = renderer.width, H = renderer.height, hh = 0.005 * u * H;
  const view = M4.lookAt(eye, V3.add(eye, [0, 0, -1]), [0, 1, 0]);
  return renderer.pick(W / 2 - 0.5, H / 2 - 0.5, M4.mul(M4.ortho(hh, W / H, 0.01 * u, far), view), frameState())
    .then((h) => (h ? (eye[2] - h.p[2]) * mpu : null));
}
function startPlacing() {
  walker.place();
  canvas.classList.add('placing');
  $('walkPlaceHint').hidden = false;
  if (hoverAt) showWalkMarker(hoverAt);
  syncToolbar();
  syncWalkPanel();
  canvas.focus();
}
function endPlacing() {
  canvas.classList.remove('placing');
  $('walkPlaceHint').hidden = true;
  placing.next = null;
  if (state.walkMarker) { state.walkMarker = null; redraw(); }
}
// Moves the marker to the surface under the cursor (one pick at a time, the latest position next).
function showWalkMarker(at) {
  if (placing.busy) { placing.next = at; return; }
  placing.busy = true;
  pickAt(at).then((h) => {
    if (walker.placing) {
      // At least about 12 pixels across, so it shows from far off too.
      const px = h && (2 * V3.len(V3.sub(h.p, camera.eye)) * Math.tan(camera.fov / 2)) / canvas.clientHeight;
      state.walkMarker = h ? { p: h.p, r: Math.max(WALK_MARKER / (METRES_PER_UNIT[model.units] || 1), 6 * px) } : null;
      redraw();
    }
  }).finally(() => {
    placing.busy = false;
    const next = placing.next;
    placing.next = null;
    if (next && walker.placing) showWalkMarker(next);
  });
}
// A click while choosing: fade to black, start walking there, and fade back in.
function startWalkAt(e) {
  pickAt(e).then((h) => {
    if (!h || !walker.placing) return;
    const mpu = METRES_PER_UNIT[model.units] || 1, back = V3.norm(V3.sub(camera.eye, h.p));
    const p = V3.add(h.p, V3.scale(back, 0.4 / mpu)), f = $('walkFade');
    walker.placing = false;
    endPlacing();
    f.classList.add('dark');
    setTimeout(() => {
      state.lastView = null;
      $('walkHint').hidden = false;
      walker.enter(p).then(() => { f.classList.remove('dark'); syncToolbar(); syncWalkPanel(); syncLightsPanel(); redraw(); });
      syncToolbar();
    }, 250);
  });
}
function toggleWalkPanel() {
  $('walkPanel').hidden = !$('walkPanel').hidden;
  syncWalkPanel();
  syncToolbar();
}
// The Walk panel ------------------------------------------------------------------------------

function showWalkHelp() {
  Dialog.open({ title: 'Walking', html: true, width: 420, body: `<p>The switch above, or the figure on the toolbar's Walk button, starts walking (perspective views only). The figure then follows the cursor, with a yellow circle on the spot below it: click to stand there, with your eyes 1.5 m above the ground (on a wall, you stand at its foot, on your side). Until you click you can still move the view; <kbd>Esc</kbd>, the figure or the switch cancel. With the camera already within 3 m of the ground (back from a walk, say), you start walking where you are. Closing this panel does not stop you.</p>
    <p><kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> or arrow keys to walk · drag to look · <kbd>Shift</kbd> to run · <kbd>Space</kbd> to jump · hold <kbd>E</kbd> to rise and <kbd>Q</kbd> to sink · wheel to zoom · <kbd>T</kbd> torch · <kbd>Esc</kbd> or the switch to stop</p>
    <p>You climb steps and anything up to 1 m high; higher obstacles block the way and you slide along them. Over a drop you pause for a moment, then fall; a fall with nothing below takes you back to where you last stood. Hidden layers and vegetation are walked through.</p>
    <p><b>Speed</b>: Shift runs at three times it · <b>Collision detection</b> off walks through walls (you still follow the ground) · <b>Fly</b> turns gravity off: you hover where <kbd>E</kbd> and <kbd>Q</kbd> leave you, stay level off edges, and <kbd>Space</kbd> does not jump. Whether you are standing in sunlight shows in the Thermal comfort panel (<b>UTCI</b> on the toolbar).</p>` });
}

function syncWalkPanel() {
  const S = walker.settings;
  $('walkSpeed').value = S.speed;
  // While Shift is held the label shows the running speed.
  $('walkSpeedOut').value = shiftDown ? `Running ${(S.speed * WALK.RUN).toFixed(1)} m/s` : S.speed.toFixed(1) + ' m/s';
  $('walkSpeedOut').classList.toggle('running', shiftDown);
  $('walkCollide').checked = S.collide;
  $('walkFly').checked = S.fly;
}

function bindWalkPanel() {
  const S = walker.settings, changed = () => { syncWalkPanel(); savePrefs(); };
  $('walkSpeed').addEventListener('input', () => { S.speed = +$('walkSpeed').value; changed(); });
  $('walkCollide').addEventListener('change', () => { S.collide = $('walkCollide').checked; changed(); canvas.focus(); });
  $('walkFly').addEventListener('change', () => { S.fly = $('walkFly').checked; changed(); canvas.focus(); });
  $('walkHelp').addEventListener('click', showWalkHelp);
  $('walkClose').addEventListener('click', () => { toggleWalkPanel(); canvas.focus(); });
  $('walkOn').addEventListener('change', toggleWalk);
  $('walkQuick').addEventListener('click', toggleWalk);
  $('walkCombo').addEventListener('click', (e) => { if (e.target === e.currentTarget) toggleWalkPanel(); }); // the gaps round the icon  syncWalkPanel();
}

// Is the camera in sunlight? A ray from the eye towards the sun, drawn with the pick pass (so
// trees and every visible object cast shade), a few times a second while the Walk or Thermal
// comfort panel shows. It works with the sun's lighting off too, as long as there is a location.
// sunlight: null (no model or location), { night: true }, or { lit, by (layer name), dist (m) }.
let sunlight = null, sunlightAt = 0, sunlightBusy = false, sunlightLater = 0;
function checkSunlight() {
  const now = performance.now();
  if (sunlightBusy || now - sunlightAt < 250) {
    // Check again shortly, so the last camera move or time change is not missed.
    if (!sunlightLater) sunlightLater = setTimeout(() => { sunlightLater = 0; checkSunlight(); }, 260);
    return;
  }
  sunlightAt = now;
  const pos = model && activeLocation() ? sunPosition() : null;
  if (!pos || pos.altitude <= 0) { setSunlight(pos && { night: true }); return; }
  const d = sunVector(pos.azimuth, pos.altitude, state.sun.north), eye = camera.eye, u = 1 / (METRES_PER_UNIT[model.units] || 1);
  const [mn, mx] = visibleBounds(), far = V3.len(V3.sub(eye, V3.scale(V3.add(mn, mx), 0.5))) + V3.len(V3.sub(mx, mn)) / 2 + u;
  // A one-pixel orthographic view along the ray: pixel (W/2 - 0.5, H/2 - 0.5) is its centre.
  const W = renderer.width, H = renderer.height, hh = 0.005 * u * H;
  const view = M4.lookAt(eye, V3.add(eye, d), Math.abs(d[2]) > 0.99 ? [0, 1, 0] : [0, 0, 1]);
  sunlightBusy = true;
  renderer.pick(W / 2 - 0.5, H / 2 - 0.5, M4.mul(M4.ortho(hh, W / H, 0.05 * u, far), view), frameState()).then((h) => {
    if (!model) return;
    const layer = h && model.layers[model.objects[h.id]?.layer];
    setSunlight(h ? { lit: false, by: layer?.name, dist: V3.len(V3.sub(h.p, eye)) / u } : { lit: true });
  }).finally(() => { sunlightBusy = false; });
}

function setSunlight(s) {
  sunlight = s;
  syncComfortPanel();
}
const shadeText = (s) => `cast by ${s.by ? escapeHtml(s.by) : 'an object'}, ${s.dist < 1 ? 'less than 1' : Math.round(s.dist)} m away`;

// Direct sun on the person (W/m²) below which the Thermal comfort panel calls it weak sunlight:
// a thin or hazy sun, or one just over the horizon, adds little warmth.
const WEAK_SUN = 100;

// The Thermal comfort panel's sunlight line, for comfortNow()'s result: [class, html]. Shade from
// the model comes first, then a simulated cloud over the sun, then how strong the sun is.
function sunState(r) {
  const s = sunlight, pos = activeLocation() ? sunPosition() : null;
  if (!pos) return ['', 'No location, so no sun · <button class="link" data-location>Set location…</button>'];
  if (pos.altitude <= 0 || s?.night) return ['shade', '<b>Night</b> · the sun is below the horizon'];
  if (!s) return ['', 'Checking for sunlight…'];
  if (!s.lit) return ['shade', `<b>In shade</b> · ${shadeText(s)}`];
  if (!r || r.missing) return ['lit', '<b>In sunlight</b>'];
  const w = `${Math.round(r.beam)} W/m² direct`;
  if (r.sim?.shade != null && r.sim.shade < 0.55) return ['cloud', `<b>Under a simulated cloud</b> · ${w}`];
  if (r.beam < WEAK_SUN) return ['weak', `<b>In weak sunlight</b> · ${w}`];
  return ['lit', `<b>In sunlight</b> · ${w}${r.sim?.shade != null ? ' between simulated clouds' : ''}`];
}

// The Thermal comfort panel ---------------------------------------------------------------------
// UTCI at the camera from the weather file at the Sun panel's date and time: air temperature and
// humidity as they are, wind speed times the panel's wind factor (a stand-in for shelter), and a
// mean radiant temperature equal to the air temperature, raised when the camera is in sunlight by
// the direct sun on the person (SolarCal) and by sun-warmed surroundings (a placeholder).

function toggleComfortPanel() {
  const C = state.comfort;
  C.panel = !C.panel;
  $('comfortPanel').hidden = !C.panel;
  document.querySelector('[data-act="comfort"]').setAttribute('aria-pressed', String(C.panel));
  if (C.panel) { syncComfortPanel(); checkSunlight(); }
}

// The inputs and result, or { missing: reason }.
function comfortNow() {
  const e = site.epw;
  if (!e) return { missing: 'epw' };
  const { month, day } = dateFromDayOfYear(EPW_YEAR, state.sun.doy);
  const w = e.at(month, day, state.sun.hour);
  if (w.dryBulb === null || w.relativeHumidity === null || w.windSpeed === null) return { missing: 'data', w };
  const pos = activeLocation() ? sunPosition() : null;
  const sun = sunlight?.lit && pos && pos.altitude > 0 && w.directNormal > 0;
  const ta = w.dryBulb, rh = w.relativeHumidity, va = w.windSpeed * state.comfort.wind;
  // With simulated clouds the sun on the person is the beam between the clouds, cut by the cloud
  // over the camera if there is one (the same cloud field as the sky and its shadows). The
  // sunlit surroundings keep the hour's average: ground and walls do not cool as a cloud passes.
  const sim = comfortClouds(pos);
  const beam = sim?.shade != null ? sim.gap * sim.shade : w.directNormal;
  const dSun = sun ? solarMrtDelta(beam, pos.altitude) : 0, dSurr = sun ? surroundingsMrtDelta(w.directNormal, pos.altitude) : 0;
  const tr = ta + dSun + dSurr;
  // Wind below the UTCI's 0.5 m/s is raised to it (utci does), so it is not counted as out of range.
  return { w, pos, sun, sim, beam, ta, rh, va, tr, dSun, dSurr, value: utci(ta, tr, va, rh), inRange: utciInRange(ta, tr, Math.max(va, UTCI_WIND_MIN), rh) };
}

// The simulated cloud at the camera: null with the option off; { off: reason } when there are no
// clouds to count; else { shade (1 open .. 0.1 under a cloud), gap (the beam between clouds, W/m²) }.
function comfortClouds(pos) {
  if (!state.comfort.clouds) return null;
  if (!state.sun.on || !state.weatherOn) return { off: 'Simulated clouds need the sun and the weather switched on' };
  if (!pos || pos.altitude <= 0) return { off: 'No sun to cover' };
  const sky = currentSky(pos.altitude);
  if (!sky || sky.cover < 0.01) return { off: 'No cloud in the weather file at this hour' };
  const mpu = (model && METRES_PER_UNIT[model.units]) || 1;
  return { shade: cloudShadeAt(camera.eye, sunVector(pos.azimuth, pos.altitude, state.sun.north), sky.cover, clouds.drift, mpu), gap: sky.gapBeam };
}

function syncComfortPanel() {
  if (!state.comfort.panel) return;
  const C = state.comfort, f = (x, d = 1) => x.toFixed(d);
  $('comfortWind').value = C.wind;
  $('comfortWindOut').value = f(C.wind, 2);
  $('comfortWhen').value = `${$('sunDateOut').textContent} · ${fmtHour(state.sun.hour)}`;
  $('comfortToggle').setAttribute('aria-expanded', String(C.inputs));
  $('comfortToggle').querySelector('.caret').classList.toggle('collapsed', !C.inputs);
  $('comfortInputs').hidden = !C.inputs;
  const r = comfortNow();
  const [sunCls, sunHtml] = sunState(r);
  $('comfortSun').className = 'sun-state ' + sunCls;
  setHtml($('comfortSun'), `<span class="dot"></span><span>${sunHtml}</span>`);
  if (r.missing) {
    $('comfortRead').style.removeProperty('--cat');
    setHtml($('comfortRead'), r.missing === 'epw'
      ? '<span class="fine">The UTCI needs the weather from a weather file (EPW).</span> <button class="link" data-weather>Add one…</button>'
      : '<span class="fine">The weather file has no temperature, humidity or wind at this time.</span>');
    setHtml($('comfortInputs'), '');
    return;
  }
  const cat = utciCategory(r.value);
  $('comfortRead').style.setProperty('--cat', cat.color);
  setHtml($('comfortRead'), `<div class="utci-top"><span class="utci-val">${f(r.value)}<small> °C</small></span><span class="utci-cat">${cat.name}</span></div>
    <div class="utci-scale">${UTCI_CATEGORIES.map((c) => `<span style="background:${c.color}"${c === cat ? ' class="on"' : ''} title="${c.name}"></span>`).join('')}</div>
    ${r.inRange ? '' : '<div class="fine">Outside the range the UTCI was fitted over, so only a rough guide.</div>'}
    ${comfortCloudNote(r)}`);
  const s = sunlight, pos = r.pos;
  const under = r.sim?.shade != null && r.sim.shade < 0.55;
  const direct = r.sim?.shade != null
    ? `${f(r.beam, 0)} W/m² direct ${under ? 'under a simulated cloud' : 'between simulated clouds'} (hourly average ${f(r.w.directNormal, 0)})`
    : `${f(r.w.directNormal, 0)} W/m² direct`;
  const sunRow = !pos ? 'No location: shade assumed' : pos.altitude <= 0 || s?.night ? 'Night' : !s ? 'Checking…'
    : s.lit ? (r.w.directNormal > 0 ? `<b>In sunlight</b> · ${direct}, ${f(pos.altitude, 0)}° up` : '<b>In sunlight</b> · no direct sun in the weather file')
      : `<b>In shade</b> · ${shadeText(s)}`;
  setHtml($('comfortInputs'), `<dl class="wx">
    <dt>Air temperature</dt><dd><b>${f(r.ta)}</b> °C</dd>
    <dt>Relative humidity</dt><dd><b>${f(r.rh, 0)}</b>%</dd>
    <dt>Wind</dt><dd>${f(r.w.windSpeed)} × ${f(C.wind, 2)} = <b>${f(r.va)}</b> m/s</dd>
    <dt>Sun</dt><dd>${sunRow}</dd>
    <dt>Radiant temp.</dt><dd><b>${f(r.tr)}</b> °C${r.sun ? ` <span class="fine">(air + ${f(r.dSun)} sun on you + ${f(r.dSurr)} sunlit surroundings)</span>` : ' <span class="fine">(= air)</span>'}</dd></dl>
    ${walker.active ? '' : '<div class="fine">Measured at the camera. Walk to stand in the model at head height.</div>'}`);
}

// Under the UTCI: why simulated clouds, when asked for, could not be counted (the sunlight line
// says whether a cloud is over the sun when they are).
function comfortCloudNote(r) {
  return r.sim?.off ? `<div class="fine">${r.sim.off}: using the hour's average sun.</div>` : '';
}

// Replaces an element's content only when it changes (the panel refreshes several times a second).
function setHtml(el, html) { if (el.dataset.html !== html) { el.dataset.html = html; el.innerHTML = html; } }

function showComfortHelp() {
  Dialog.open({ title: 'Thermal comfort', html: true, width: 400, body: `<p>The Universal Thermal Climate Index (UTCI) is the air temperature that would feel the same in calm, shaded, reference conditions. 9 to 26 °C is <b>no thermal stress</b>.</p>
    <p>It is estimated at the camera, at the Sun panel's date and time, from the weather file: the air temperature and humidity as they are, and the wind speed times the <b>wind factor</b>. The factor stands in for shelter, which the viewer cannot work out yet: 1 is the open-ground wind of the weather file, lower values are more sheltered. It starts at 0.5, a typical allowance for the shelter of streets and buildings compared with the open site where weather files are recorded (at 10 m, which is the height the UTCI expects). The UTCI was fitted for wind speeds from 0.5 m/s, so slower winds, including calm, are counted as 0.5 m/s.</p>
    <p>The <b>mean radiant temperature</b> is taken to be the air temperature in shade. In sunlight two things are added: the direct sun on the person (the SolarCal method, for a standing person turned side-on to the sun), and the warmth of sunlit ground and walls nearby, a rough allowance of about 10 °C for 600 W/m² of direct sun on the ground. Together they make a sunlit spot about 15 to 27 °C warmer in radiant temperature than a shaded one in summer, in line with field measurements, which typically adds 4 to 7 °C to the UTCI. Surfaces heating up and cooling down over the day, their materials, the sky and reflected light are not counted.</p>
    <p><b>Clouds.</b> By default the sun on the person is the weather file's direct radiation for the hour: an average, which already allows for the cloud that hour by dimming the sun evenly. This is how comfort is normally assessed (hour by hour, as Ladybug does), and it does not change as the drawn clouds pass.</p>
    <p><b>Include simulated clouds</b> counts the cloud over the camera instead, so the UTCI follows the clouds you see: in a gap the sun is as strong as between the clouds that hour, under a cloud it drops to a tenth, which typically moves the UTCI by a few degrees in summer. The clouds themselves are invented: the weather file gives only how much of the sky is cloudy, so where each cloud is, and when one crosses the sun, is a random pattern, not a record. Averaged over time the two ways agree, so use the hourly figure for assessments and the simulated one to show what a passing cloud does. The warmth of sunlit surroundings keeps the hour's average either way, since ground and walls do not cool as a cloud passes. The option needs the sun and the weather switched on, and an hour with some cloud.</p>` });
}

function bindComfortPanel() {
  document.querySelector('[data-act="comfort"]').addEventListener('click', toggleComfortPanel);
  $('comfortClose').addEventListener('click', () => state.comfort.panel && toggleComfortPanel());
  $('comfortHelp').addEventListener('click', showComfortHelp);
  $('comfortToggle').addEventListener('click', () => { state.comfort.inputs = !state.comfort.inputs; syncComfortPanel(); });
  $('comfortWind').addEventListener('input', () => { state.comfort.wind = +$('comfortWind').value; syncComfortPanel(); savePrefs(); });
  $('comfortClouds').checked = state.comfort.clouds;
  $('comfortClouds').addEventListener('change', (e) => { state.comfort.clouds = e.target.checked; syncComfortPanel(); savePrefs(); });
  $('comfortRead').addEventListener('click', (e) => { if (e.target.closest('[data-weather]')) openWeatherDialog(); });
  $('comfortSun').addEventListener('click', (e) => { if (e.target.closest('[data-location]')) openLocationDialog(); });
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
let helpDialog = null;
function toggleHelp() {
  if (helpDialog) { helpDialog.close(null); return; }
  helpDialog = new Dialog({ title: 'Controls', body: $('helpBody').content.cloneNode(true), width: 600, buttons: [{ label: 'Close', value: true, primary: true }] });
  helpDialog.result.then(() => { helpDialog = null; });
}

// Home: the welcome screen, with recent files. An open model stays loaded underneath, and
// "Back to …" (or Esc) returns to it.
let atHome = false;
function goHome() {
  walker.exit();
  if (model) { atHome = true; $('dropBackName').textContent = model.name; }
  $('dropBack').hidden = !model;
  $('drop').hidden = false;
  renderRecent();
}
function leaveHome() {
  atHome = false;
  $('drop').hidden = true;
  canvas.focus();
}

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
    const linked = [r.custom && `custom location ${r.custom.name || fmtCoords(r.custom.lat, r.custom.lon)}`, r.epw && `weather ${r.epw.name}`].filter(Boolean);
    li.querySelector('.recent-info').textContent = [`${(r.size / 1e6).toFixed(r.size < 1e7 ? 1 : 0)} MB`, `opened ${date(r.opened)}`, ...linked].join(' · ');
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
  $('btnHome').addEventListener('click', goHome);
  $('btnLocation').addEventListener('click', openLocationDialog);
  $('btnWeather').addEventListener('click', openWeatherDialog);
  $('btnBack').addEventListener('click', leaveHome);
  $('dropBrowse').addEventListener('click', browse);
  input.addEventListener('change', () => { if (input.files[0]) openFile(input.files[0]); input.value = ''; });

  const drop = $('drop');
  let depth = 0;
  window.addEventListener('dragenter', (e) => { e.preventDefault(); if (++depth === 1) { drop.hidden = false; drop.classList.add('over'); } });
  window.addEventListener('dragleave', () => { if (--depth === 0) { drop.classList.remove('over'); if (model && !atHome) drop.hidden = true; } });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => {
    e.preventDefault(); depth = 0; drop.classList.remove('over');
    if (model && !atHome) drop.hidden = true;
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
  $('sunCombo').addEventListener('click', (e) => { if (e.target === e.currentTarget) toggleSunPanel(); }); // the gaps round the icon
  $('sunQuick').addEventListener('click', () => setSun({ on: !state.sun.on }));
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
  // Each tool panel's title carries its toolbar button's icon.
  for (const [btn, panel] of [['#sunQuick', 'sunPanel'], ['#weatherQuick', 'weatherPanel'], ['[data-act="comfort"]', 'comfortPanel'],
    ['#lightsQuick', 'lightsPanel'], ['#walkQuick', 'walkPanel'], ['[data-toggle="layers"]', 'layersPanel']]) {
    const title = $(panel).querySelector('.panel-head > span');
    title.classList.add('panel-title');
    title.prepend(document.querySelector(`.toolbar ${btn} svg`).cloneNode(true));
  }
  bindLightsPanel();
  bindComfortPanel();
  document.querySelectorAll('[data-layers]').forEach((b) => b.addEventListener('click', () => {
    if (!model) return;
    layerOn = model.layers.map(() => b.dataset.layers === 'all');
    applyLayerVisibility();
    buildLayerTree.refresh?.();
  }));
  window.addEventListener('keydown', onKey);
  const setShift = (on) => { if (shiftDown !== on) { shiftDown = on; syncWalkPanel(); } };
  window.addEventListener('keydown', (e) => { if (e.key === 'Shift') setShift(true); });
  window.addEventListener('keyup', (e) => { if (e.key === 'Shift') setShift(false); walker.key(e, false); });
  window.addEventListener('blur', () => { setShift(false); walker.blur(); });
  $('btnWalk').addEventListener('click', toggleWalkPanel);
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

// timeout: remove after this many ms (brief, informational notices); others, warnings and errors
// included, go after NOTICE_MS. The countdown restarts while the pointer is over the notice.
// action: { label, run } adds a link that runs it and dismisses the notice.
const NOTICE_MS = 10000;
function notice(text, error = false, timeout = 0, action = null) {
  const n = document.createElement('div');
  n.className = 'notice' + (error ? ' error' : '') + (timeout ? ' brief' : '');
  if (timeout) $('notices').querySelectorAll('.notice.brief').forEach((b) => b.remove()); // one at a time
  let timer = 0;
  const arm = () => { clearTimeout(timer); timer = setTimeout(() => n.remove(), timeout || NOTICE_MS); };
  n.onmouseenter = () => clearTimeout(timer);
  n.onmouseleave = arm;
  arm();
  n.textContent = text;
  if (action) {
    const a = document.createElement('button');
    a.className = 'link'; a.textContent = action.label;
    a.onclick = () => { n.remove(); action.run(); };
    n.append(' ', a);
  }
  const x = document.createElement('button');
  x.className = 'x'; x.textContent = '×'; x.setAttribute('aria-label', 'Dismiss');
  x.onclick = () => n.remove();
  n.appendChild(x);
  $('notices').appendChild(n);
  return n;
}
function clearNotices() { $('notices').innerHTML = ''; }

function fatal(title, text) {
  $('drop').hidden = true;
  $('fatal').hidden = false;
  $('fatalTitle').textContent = title;
  $('fatalText').textContent = text;
}

boot();
