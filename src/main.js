// App wiring: file loading, input handling, layer panel and toolbar.

const $ = (id) => document.getElementById(id);
const canvas = $('gfx');

const prefs = (() => { try { return JSON.parse(localStorage.getItem('3dm-viewer') || '{}'); } catch (e) { return {}; } })();
const savePrefs = () => { try { localStorage.setItem('3dm-viewer', JSON.stringify({ mode: state.mode, showEdges: state.showEdges, showCurves: state.showCurves, ao: state.ao, specials: state.specials, animations: state.animations, walk: walker.settings, drive: driver.settings, comfortWind: state.comfort.wind, comfortClouds: state.comfort.clouds, colourScales: ColourScales.choices, cloudSpeed: clouds.speed, sideWidth: state.sideWidth })); } catch (e) { /* storage unavailable */ } };

const state = {
  devMode: false, // the secret developer mode: five quick clicks on the home screen's logo; never saved, so a refresh ends it
  mode: prefs.mode ?? 1, xray: false, showEdges: true, showCurves: true, showPoints: true, layers: false, blocks: false,
  pointSize: 5, edgeColor: [0.08, 0.09, 0.1, 0.55],
  bgTop: [0.93, 0.94, 0.95, 1], bgBot: [0.78, 0.8, 0.84, 1],
  // Lights (lamps): { name, src ('file' or 'added'), on, p (model, origin-relative), rgb (linear),
  // power, range (m) }, and for a spot light dir, inner and outer (cone half angles, degrees).
  // on marks the lamp as selected: while lightsOn, the selected lamps shine, or all if none is.
  lamps: [],
  lightsOn: true,
  torch: false,  // the walker's torch (T in pedestrian mode)
  lightsPanel: false,
  datePanel: false,
  weatherPanel: false,
  weatherViewOpen: true, // the Weather widget's View section is open
  weatherOn: true,  // the Weather widget's switch: off, none of its View items show, whatever is ticked
  // The Weather widget's View items, as ticked. Each also needs a location or a weather file
  // (VIEW_NEEDS), and the switch on: viewOn says whether it shows.
  view: { sun: false, sky: true, clouds: true, haze: true, path: false },
  // Thermal comfort panel; wind: the factor (0-1) applied to the weather file's wind speed.
  // details: the Details section is open.
  // clouds: count the simulated cloud over the camera, rather than the hour's average sun.
  comfort: { panel: false, details: false, wind: prefs.comfortWind >= 0 && prefs.comfortWind <= 1 ? prefs.comfortWind : 0.5, clouds: prefs.comfortClouds === true },
};
// Sun study settings. lat, lon and utcOffset follow the site location (applyLocation); north is
// the open model's. Dates are in EPW_YEAR: the year changes sun angles too little to matter.
state.sun = {
  lat: 51.5074, lon: -0.1278, utcOffset: 0, north: 90,
  doy: dayOfYear(EPW_YEAR, 6, 21), hour: 12,
};
// The site location of the open model: a custom location, the weather file (epw, an EPW object)
// and which source to use (use: 'custom', 'epw', 'file' or null for the first that is set).
const site = { custom: null, epw: null, use: null };
// The open model's results files: { id, name, size, parser, data }, parser and data null if nothing
// recognises a bound file any more. They are only ever read.
let results = [];
ColourScales.choices = prefs.colourScales || {};
// The CFD streamlines panel. on: its master switch. off: keys (streamlineKey) of what is unticked,
// streamlines and polylines alike. collapsed: keys of the streamlines folded up. lines: what was
// given to the renderer, a { key, parts: [{ key, range }] } for each streamline and its polylines.
state.streamlines = { panel: false, on: true, off: new Set(), collapsed: new Set(), lines: [] };
// The CFD map panel. on: its master switch. off: keys of the unticked maps. collapsed: of those
// folded up. picked: map key -> the name of the result shown. z: metres moved up. list: what was
// given to the renderer, a { key, map, label } for each map.
state.maps = { panel: false, on: true, off: new Set(), collapsed: new Set(), picked: {}, z: 0, list: [] };
state.ao = typeof prefs.ao === 'boolean' ? prefs.ao : true;
state.specials = typeof prefs.specials === 'boolean' ? prefs.specials : true; // the render mode menu's Magic item
state.animations = typeof prefs.animations === 'boolean' ? prefs.animations : true; // and its Animations item
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
  onExit: () => { if (stick) endStick(); $('walkHint').hidden = true; $('walkPanel').hidden = true; endPlacing(); if (walkFrom) { camera.restore(walkFrom); walkFrom = null; } syncToolbar(); syncWalkPanel(); syncLightsPanel(); redraw(); },
  notice: (text, ms = 0) => notice(text, false, ms),
  fade: () => { const f = $('walkFade'); f.classList.add('on'); requestAnimationFrame(() => requestAnimationFrame(() => f.classList.remove('on'))); },
});
// Drive mode: a car and a chase camera (drive.js). It shares the walker's ways in and out: the
// spot picker, the fade, and going back to the camera it started from (walkFrom).
const driver = new Driver({
  camera, get renderer() { return renderer; }, bounds: () => visibleBounds(),
  mpu: () => METRES_PER_UNIT[model.units] || 1,
  onExit: () => { if (stick) endStick(); $('driveHint').hidden = true; $('drivePanel').hidden = true; endPlacing(); if (walkFrom) { camera.restore(walkFrom); walkFrom = null; } syncToolbar(); syncDrivePanel(); redraw(); },
  notice: (text, ms = 0) => notice(text, false, ms),
  fade: () => { const f = $('walkFade'); f.classList.add('on'); requestAnimationFrame(() => requestAnimationFrame(() => f.classList.remove('on'))); },
});
driver.settings.collide = true;
if (prefs.drive) {
  const D = driver.settings, P = prefs.drive;
  D.shadows = P.shadows !== false;
  D.collide = P.collide !== false;
  if (P.cam >= 0 && P.cam < DRIVE_CAMS.length) D.cam = P.cam;
  D.headlights = P.headlights === true;
}
// Walking or driving: the frame round the window, the thumb stick, drag to look.
const moving = () => walker.active || driver.active;
const choosingStart = () => walker.placing || driver.placing;
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
  const SL = state.streamlines;
  s.resultMaps = state.maps.on ? state.maps.list.flatMap((m, i) => (state.maps.off.has(m.key) ? [] : [i])) : [];
  s.resultMapZ = state.maps.z / model.metresPerUnit;
  s.exposureMap = expo.on && expo.shown;
  checkExposure();
  s.resultRanges = SL.on ? SL.lines.filter((l) => !SL.off.has(l.key)).flatMap((l) => l.parts.filter((p) => !SL.off.has(p.key)).map((p) => p.range)) : [];
  const [mn, mx] = visibleBounds(), c = V3.scale(V3.add(mn, mx), 0.5), R = Math.max(V3.len(V3.sub(mx, mn)) / 2, 1e-6);
  s.aoMaxRadius = R * 0.04;
  // Look: the sky behind the model, haze beyond the orbit target (perspective views only).
  const sunOn = viewOn('sun'), skyOn = viewOn('sky'), cloudsOn = viewOn('clouds'), hazeOn = viewOn('haze');
  s.bgTop = STUDIO.top; s.bgBot = STUDIO.bottom;   // with the sun or the sky, the sky colours follow the time of day
  s.edgeColor = sunOn ? [0.1, 0.11, 0.13, state.mode === 1 ? 0.2 : 0.35] : state.edgeColor;
  s.time = anim.time;
  s.metresPerUnit = METRES_PER_UNIT[model.units] || 1;
  s.hazeStart = camera.distance;
  s.hazeDensity = camera.ortho ? 0 : 0.35 / R;
  s.lamps = shownLamps();
  s.sunPath = viewOn('path');
  if (s.sunPath) {
    const pos = sunPosition();
    fillSunPath();
    s.sunPathMark = pos.altitude > 0 ? sunVector(pos.azimuth, pos.altitude, state.sun.north) : null;
  }
  // Without the sky, a plain white background: for screenshots, as the light on the model is the same.
  s.plainBg = !skyOn;
  if (!sunOn && !skyOn) return s;
  const S = state.sun, pos = sunPosition(), moon = moonPosition(sunOpts());
  // With the sun off the model keeps its usual light, so the sky is never darker than dusk.
  const light = sunLight(sunOn ? pos.altitude : Math.max(pos.altitude, DUSK_ALTITUDE));
  // With a weather file, the clouds grey the sky and shade the model; the haze dims the sun by
  // the rest of what its direct radiation says (weatherSky), and sets the sky light by its diffuse.
  const wx = currentSky(pos.altitude);
  if (wx && cloudsOn) overcastSky(light, wx.cover);
  const haze = wx && hazeOn ? wx.haze : 1;
  s.bgTop = [...light.top, 1]; s.bgBot = [...light.horizon, 1];
  const sunDir = sunVector(pos.azimuth, pos.altitude, S.north), moonDir = sunVector(moon.azimuth, moon.altitude, S.north);
  s.backdrop = { glow: light.glow, night: light.night, sunDir, moonDir, moonLit: moon.lit, lat: S.lat, north: S.north, lst: siderealTime(sunOpts()) };
  if (wx && (cloudsOn || hazeOn)) s.clouds = { cover: cloudsOn ? wx.cover : 0, drift: clouds.drift, haze };
  if (sunOn) {
    // Once the sun is down, a moon above the horizon takes over as the light that casts shadows.
    // The moon is shaded by the clouds alone.
    const moonRgb = moonLight(moon.altitude, moon.lit, light.night);
    const byMoon = light.up === 0 && moonRgb[2] > 0.004;
    s.sun = { dir: byMoon ? moonDir : sunDir, rgb: byMoon ? moonRgb : light.rgb.map((v) => v * haze),
      sky: (light.sky + 0.06 * moonRgb[2] / 0.32) * (wx && hazeOn ? wx.sky : 1) };
    if ((light.up > 0 || byMoon) && !state.xray) {
      s.shadows = shadowCascades(cam, s.sun.dir, { center: c, radius: R * 1.9, receiverRadius: R * 1.1 });
    }
  }
  return s;
}

// Clouds: the weather file's sky at the Date widget's date and time, and how far the clouds have
// drifted. They move with the 10 m wind times the Weather widget's multiplier (clouds sit higher,
// where the wind is stronger, and the multiplier also makes the drift easier to see).
let comfortAt = 0;   // when the thermal comfort panel last followed the drifting clouds
const clouds = { drift: [0, 0], last: 0, speed: prefs.cloudSpeed >= 0 && prefs.cloudSpeed <= CLOUD_SPEED_MAX ? prefs.cloudSpeed : 10 };
const DUSK_ALTITUDE = -6; // the sun's height (degrees) whose sky is the darkest shown with the sun off

// The weather file's sky at the date and time: null without a weather file or its records for the day.
function currentSky(altitude) {
  const S = state.sun;
  return site.epw ? weatherSky(site.epw, S.doy, S.hour, altitude) : null;
}

// The Weather widget's View items: what each needs, and what each is.
const VIEW_ITEMS = ['sun', 'sky', 'clouds', 'haze', 'path'];
const VIEW_NEEDS = { sun: 'location', sky: 'location', clouds: 'epw', haze: 'epw', path: 'location' };
const VIEW_TITLES = {
  sun: 'Sunlight and shadows at the Date widget\'s date and time, and the moon\'s at night',
  sky: 'The sky behind the model. Off: a plain white background, for screenshots. The light on the model is the same either way',
  clouds: 'The weather file\'s clouds, drifting with its wind. They show in the sky, and cast shadows with the Sun on',
  haze: 'The weather file\'s haze: dims the sun beyond what the clouds account for, and sets how bright the sky\'s light is, from its radiation',
  path: 'The sun\'s path on the sky: the 21st of each month, each clock hour through the year, and in yellow the Date widget\'s date',
};

// Why a View item cannot show, or null if it can: it needs a location or a weather file, the
// widget's switch on, and (the sun path) a perspective view.
function viewWhyNot(item) {
  if (VIEW_NEEDS[item] === 'epw' ? !site.epw : !activeLocation()) return VIEW_NEEDS[item] === 'epw' ? 'Needs a weather file (EPW)' : 'Needs a location';
  if (!state.weatherOn) return 'The Weather widget is switched off';
  if (item === 'path' && camera.ortho) return 'Drawn in perspective views only';
  return null;
}
// Does a View item show: ticked, and able to.
const viewOn = (item) => state.view[item] && !viewWhyNot(item);

function setWeatherOn(on) {
  state.weatherOn = on;
  syncDateWeather();
  saveViewState();
  redraw();
}

function setWeatherView(item, on) {
  state.view[item] = on;
  syncDateWeather();
  saveViewState();
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
  // They move while they are seen, in the sky or by their shadows, or counted by the thermal comfort widget.
  const seen = viewOn('clouds') && (viewOn('sun') || (viewOn('sky') && !camera.ortho));
  if (!site.epw || !clouds.speed || !(seen || (state.comfort.panel && state.comfort.clouds))) return false;
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

// Gives the renderer the sun path diagram for the location, north and date, when any have changed.
let sunPathKey = null;
function fillSunPath() {
  const S = state.sun, scale = Math.min(window.devicePixelRatio || 1, 2);
  const key = [S.lat, S.lon, S.utcOffset, S.north, S.doy, scale].join();
  if (key === sunPathKey) return;
  sunPathKey = key;
  const { month, day } = dateFromDayOfYear(EPW_YEAR, S.doy);
  renderer.setSunPath(sunPathDiagram({ lat: S.lat, lon: S.lon, utcOffset: S.utcOffset, year: EPW_YEAR, north: S.north, doy: S.doy, dayName: `${day} ${MONTHS[month - 1]}` }), scale);
}

// The water's clock, stopped while Animations is off, and when the last frame was drawn.
const anim = { time: 0, last: performance.now(), drawn: 0 };
const ANIM_FRAME = 30; // ms between frames drawn only for the animations: about 30 a second, as they need no more

function loop() {
  const now = performance.now();
  if (state.animations) anim.time = (anim.time + (now - anim.last) / 1000) % 3600;
  anim.last = now;
  // Water ripples and drifting clouds animate while someone is using the viewer; after 15 s idle
  // they freeze so an untouched page does not keep the GPU busy.
  const live = model && state.animations && now - lastInput < 15000;
  const drifting = live && driftClouds(now);
  if (live && (drifting || renderer.hasWater(state.mode)) && now - anim.drawn >= ANIM_FRAME) renderer.dirty = true;
  // A cloud may have moved over the camera.
  if (drifting && state.comfort.panel && state.comfort.clouds && now - comfortAt > 200) { comfortAt = now; syncComfortPanel(); }
  if (walker.active) {
    walker.update(performance.now());
    renderer.dirty = true; lastInput = performance.now();
  }
  if (driver.active) {
    driver.update(performance.now());
    renderer.dirty = true; lastInput = performance.now();
    syncDriveSpeed();
  }
  diag.ticks++;
  if (renderer.dirty) {
    anim.drawn = now;
    renderer.dirty = false;
    const t = performance.now();
    renderer.draw(frameState());
    if (state.devMode) diagFrame(t);
    positionInspector(); syncCompass();
    if (state.comfort.panel) checkSunlight();
  }
  requestAnimationFrame(loop);
}

// ---------------------------------------------------------------------------------------------
// Loading

// handle: the file's FileSystemFileHandle, when there is one, for the recent files list.
async function openFile(file, handle = null) {
  if (/\.epw$/i.test(file.name)) { loadEpw(file); return; }
  if (resultParsersFor(file.name).length) { addResultsFile(file); return; }
  if (!/\.3dm$/i.test(file.name)) { notice(`${file.name} is not a .3dm, .epw or results file.`, true); return; }
  showBusy(`Reading ${file.name}`, 0.02);
  await Recent.add(handle, file);
  renderRecent();
  await openBytes(file.name, new Uint8Array(await file.arrayBuffer()), handle);
}

// The custom location, weather file and choice of location linked to a model come back with it.
// Returns what came back, for a notice.
async function restoreLinks(handle) {
  const { custom, epw: d, use, results: bound } = await Recent.links(handle), back = [];
  const c = custom && Math.abs(custom.lat) <= 90 && Math.abs(custom.lon) <= 180 && Math.abs(custom.utcOffset) <= 14 ? custom : null;
  if (c) { site.custom = { lat: +c.lat, lon: +c.lon, utcOffset: +c.utcOffset, name: typeof c.name === 'string' ? c.name : null }; back.push(`custom location ${site.custom.name || fmtCoords(c.lat, c.lon)}`); }
  if (d) {
    try { site.epw = EPW.fromBytes(d.bytes, d.name); back.push(`weather file ${d.name}`); }
    catch (e) { notice(`Could not read ${d.name}, the weather file linked to this model: ${e.message}`, true); }
  }
  if (['custom', 'epw', 'file'].includes(use)) site.use = use;
  for (const r of bound) {
    try {
      const bytes = await Recent.resultBytes(r.id);
      if (bytes) results.push({ ...r, parser: null, data: null, ...parseResultsFile(bytes, r.name) });
    } catch (e) { results.push({ ...r, parser: null, data: null }); notice(`Could not read ${r.name}, a results file linked to this model: ${e.message}`, true); }
  }
  if (results.length) back.push(results.length === 1 ? `results file ${results[0].name}` : `${results.length} results files`);
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
  driver.exit();
  saveViewState();
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
    state.blockOff = new Set();
    model.name = name;
    model.size = bytes.length;
    model.bytes = bytes; // kept so a copy with the viewer's changes can be written
    model.handle = handle;
    model.objectIndex = new Map(m.objects.map((o, i) => [o.id, i]));
    model.blocks = blockTable(m);
    model.metresPerUnit = METRES_PER_UNIT[m.units] || 1;
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
    const savedView = loadViewState();
    restoreLayersAndHidden(savedView);
    clearHistory();
    $('undoRedo').hidden = false;
    $('fileDialog').hidden = true;
    $('matDialog').hidden = true;
    $('blockDialog').hidden = true;
    applyLayerVisibility();
    $('layerFilter').value = '';
    buildLayerTree();
    buildBlockList();
    if (nestedBlockOff()) await rebuildModel();
    applyLayerMaterials(false);
    await settleMagicGround();
    Object.assign(site, { custom: null, epw: null, use: null }); // never carried over to another model
    results = [];
    const back = handle ? await restoreLinks(handle) : [];
    syncResults();
    applyFileLocation(m.location);
    if (model.savedNorth != null) setSun({ north: model.savedNorth });
    restoreSun(savedView);
    if (back.length) notice(`Restored with this model: ${back.join(' and ')}.`, false, 4000);
    viewNow = 'perspective'; viewCams = {};
    fillCameraMenu();
    setView('perspective', true);
    restoreCameras(savedView);
    model.viewReady = true;
    reportRestored();
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

function visibleBatches() {
  return renderer.batches.some((b) => b.visible) ? renderer.batches.filter((b) => b.visible) : renderer.batches;
}

function visibleBounds() {
  const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  for (const b of visibleBatches()) for (let k = 0; k < 3; k++) { mn[k] = Math.min(mn[k], b.min[k]); mx[k] = Math.max(mx[k], b.max[k]); }
  return isFinite(mn[0]) ? [mn, mx] : [[-1, -1, -1], [1, 1, 1]];
}

function zoomExtents() {
  if (!model) return;
  const [mn, mx] = visibleBounds();
  camera.setBounds(mn, mx);
  const points = visibleBatches().flatMap((b) => b.extremes);
  camera.zoomExtents(points.length ? points : [mn, mx]);
  redraw();
}

function setView(name, extents = true) {
  walker.exit();
  driver.exit();
  camera.setView(name);
  if (extents) zoomExtents();
  syncToolbar();
  redraw();
}

function syncToolbar() {
  syncViewChecks();
  syncCameraMenu();
  syncModeMenu();
  document.body.classList.toggle('walking', moving());
  document.body.classList.toggle('driving', driver.active);
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
  recheckMagicGround();
  saveViewState();
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
      } else for (const l of layerRows.has(i) ? layerRows.list() : [i]) layerOn[l] = cb.checked;
      applyLayerVisibility();
      refreshRows();
    });
    row.querySelector('.caret').addEventListener('click', () => {
      collapsed.has(i) ? collapsed.delete(i) : collapsed.add(i);
      refreshRows();
      layerRows.keepShown();
    });
    row.addEventListener('dblclick', (e) => { if (!e.target.closest('input, button')) openMaterialDialog(i, row); });
    row.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const r = row.getBoundingClientRect();
      const at = e.clientX || e.clientY ? [e.clientX, e.clientY] : [r.left + 24, r.bottom]; // context-menu key
      const picked = layerRows.take(i), tree = [...new Set(picked.flatMap(subtree))];
      openLayerMenu(picked, tree.length > picked.length ? tree : null, at);
    });
    tree.appendChild(row);
    rows.push({ key: i, i, row, cb });
    kids[i].forEach((k) => add(k, depth + 1));
  };
  const subtree = (i) => { const out = [i]; for (let n = 0; n < out.length; n++) out.push(...kids[out[n]]); return out; };
  roots.forEach((r) => add(r, 0));
  const hiddenByCollapse = (i) => { for (let p = L[i].parent; p >= 0; p = L[p].parent) if (collapsed.has(p)) return true; return false; };
  function refreshRows() {
    const filter = $('layerFilter').value.trim().toLowerCase(), match = new Set();
    if (filter) for (const { i } of rows) if (L[i].name.toLowerCase().includes(filter)) for (let a = i; a >= 0 && !match.has(a); a = L[a].parent) match.add(a);
    for (const { i, row, cb } of rows) {
      cb.checked = layerOn[i];
      row.classList.toggle('off', !layerOn[i]);
      row.classList.toggle('inherited-off', layerOn[i] && !layerEffective(i));
      row.hidden = filter ? !match.has(i) : hiddenByCollapse(i);
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
  layerRows.setRows(rows);
  buildLayerTree.refresh = refreshRows;
  // Reveal a layer's row (expanding its parents) and flash it.
  buildLayerTree.reveal = (i) => {
    $('layerFilter').value = ''; // the layer might not match it
    for (let p = L[i].parent; p >= 0; p = L[p].parent) collapsed.delete(p);
    refreshRows();
    const r = rows.find((x) => x.i === i);
    if (!r) return;
    layerRows.set([i]);
    flashRow(r.row);
  };
}

function flashRow(row) {
  row.scrollIntoView({ block: 'center' });
  row.classList.remove('flash'); void row.offsetWidth; row.classList.add('flash');
}

// Right-click menu for the selected layer rows. `tree` is those layers and all their sub-layers, or
// null when they have none (the sub-layer items are then left out). Selection takes visible objects
// only.
function openLayerMenu(picked, tree, [x, y]) {
  const L = model.layers;
  const visibleOn = (layers) => {
    const set = new Set(layers);
    return model.objects.flatMap((o, id) => (set.has(o.layer) && !objectOff(id) && layerEffective(o.layer) ? [id] : []));
  };
  const own = visibleOn(picked), all = tree && visibleOn(tree);
  showMenu(picked.length > 1 ? `${picked.length} layers` : L[picked[0]].fullPath, [
    { label: 'Select objects', n: own.length, run: () => selectObjects(own) },
    tree && { label: 'Select sublayer objects', n: all.length, run: () => selectObjects(all) },
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

const ROW_SELECT_HELP = (rows) => `<p><b>Selecting:</b> click a row to select it · <kbd>Ctrl</kbd>-click to add or remove a row · <kbd>Shift</kbd>-click to select a run of rows. A checkbox or right-click on a selected row acts on all the selected ${rows}.</p>`;

function showLayersHelp() {
  Dialog.open({ title: 'Layers', html: true, width: 420, body: `<p>The tick turns a layer and its sub-layers on or off. <kbd>Shift</kbd>-click a tick to isolate that layer.</p>
    <p>The square, or double-clicking the row, sets the layer's display colour in Shaded view, and its material and magic material in Rendered view. These reach objects whose source is “By layer”.</p>
    ${ROW_SELECT_HELP('layers')}
    <p><b>Right-click</b> to select the visible objects on a layer or its sub-layers.</p>` });
}

function showBlocksHelp() {
  Dialog.open({ title: 'Blocks', html: true, width: 420, body: `<p>Every block with an instance in the model, including those only used inside other blocks. The number is its copies in the model: a sub-block used 3 times in a block placed 10 times has 30.</p>
    <p>The tick hides every copy of a block. A copy shows only if it and every block around it are ticked. A row is dimmed when none of its copies can show because of the blocks around it. <b>Unhide all</b> doesn't turn blocks back on.</p>
    <p>The tag is the block's sub-element setting: where the objects inside it get their colour and material. Click it, or double-click the row, to change it. It applies to every instance of the block, and doesn't reach its sub-blocks unless you apply it to them.</p>
    <p>The same window can choose a <b>magic block</b>: geometry from the viewer's library that replaces every instance of the block, sized to its height. A tree stands on the visible ground below the block's centre, or at the bottom of the block if there is none. The tag then reads "magic". Saving a copy of the .3dm places the magic block in place of those instances, and leaves the block definitions as they were.</p>
    ${ROW_SELECT_HELP('blocks')}
    <p>Clicking a tag on a selected row sets all the selected blocks.</p>
    <p><b>Right-click</b> to select a block's instances in the view, add its sub-blocks to the selected rows, or change its setting.</p>` });
}

// ---------------------------------------------------------------------------------------------
// Blocks
//
// The block definitions in use (model.blocks, see blockTable in extract.js). Each has a setting for
// where its sub-elements get their colour and material (state.blockSub: definition id -> 'byParent'
// or 'byLayer', none meaning as in the file). As in Rhino this belongs to the definition, so it is
// shared by all its instances; it does not reach its sub-blocks unless applied to them. It is a
// change to the model, like a layer's material. Turning a block off (state.blockOff) hides every copy
// of it, like turning a layer off: a copy shows if it and every block around it are on. An object is
// visible only if its layer is on, it isn't hidden, and (for a block instance) its block is on.

const SUB_SETTINGS = [
  ['default', 'As in the file', 'Each sub-element keeps the colour and material source it has in the file.'],
  ['byParent', 'By parent: inherit from the block instance', 'Each sub-element takes its colour and material from the block instance. To change those, select an instance and set its Colour or Material.'],
  ['byLayer', 'By layer: use each sub-element’s own layer', 'Each sub-element takes its colour and material from the layer it is on, not the layer of the block instance.'],
];
const layerRows = new RowSelection(), blockRows = new RowSelection();
const blockSetting = (id) => state.blockSub[id] || 'default';
const blockMagic = (id) => MAGIC_BY_ID[state.blockMagic[id]?.id] || null;
const blockLink = (id) => `<button class="link" data-block="${id}">${escapeHtml(model.blocks.get(id).name)}</button>`;
const nestedBlockOff = () => [...state.blockOff].some((id) => model.blocks.get(id).parents.length);
const objectOff = (i) => { const o = model.objects[i]; return state.hidden.has(i) || (o.k === 'inst' && state.blockOff.has(o.idef)); };

// Everything inside these blocks, at any depth, other than the blocks themselves.
function subBlocks(ids) {
  const seen = new Set(ids), out = [], todo = [...ids];
  while (todo.length) {
    for (const k of model.blocks.get(todo.pop()).kids) if (!seen.has(k)) { seen.add(k); out.push(k); todo.push(k); }
  }
  return out;
}

// The blocks at the top of those containing this one (none if it isn't inside another).
function topParents(id) {
  const seen = new Set([id]), out = [], todo = [id];
  while (todo.length) {
    for (const p of model.blocks.get(todo.pop()).parents) {
      if (seen.has(p)) continue;
      seen.add(p);
      todo.push(p);
      if (!model.blocks.get(p).parents.length) out.push(p);
    }
  }
  return out.sort((a, b) => model.blocks.get(a).name.localeCompare(model.blocks.get(b).name, undefined, { numeric: true }));
}

// Whether any copy of a block can show, given its own tick and the blocks around it.
function blockReachable(id, seen = new Set()) {
  if (state.blockOff.has(id) || seen.has(id)) return false;
  seen.add(id);
  const b = model.blocks.get(id);
  return b.tops.length > 0 || b.parents.some((p) => !blockMagic(p) && blockReachable(p, seen));
}

function buildBlockList() {
  const list = $('blockList');
  list.innerHTML = '';
  $('blockFilter').value = '';
  const sorted = [...model.blocks.values()].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  blockRows.setRows(sorted.map((b) => {
    const row = document.createElement('div');
    row.className = 'layer-row block-row';
    row.title = b.name;
    row.innerHTML = `<input type="checkbox"><span class="layer-name"></span><button class="layer-special block-tag"></button><span class="layer-count">${b.copies.toLocaleString()}</span>`;
    row.querySelector('.layer-name').textContent = b.name;
    const cb = row.querySelector('input');
    cb.addEventListener('click', () => setBlocksOn(blockRows.has(b.id) ? blockRows.list() : [b.id], cb.checked));
    row.querySelector('.block-tag').addEventListener('click', () => openBlockDialog(blockRows.take(b.id), row));
    row.addEventListener('dblclick', (e) => { if (!e.target.closest('input, button')) openBlockDialog(blockRows.take(b.id), row); });
    row.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const r = row.getBoundingClientRect();
      openBlockMenu(blockRows.take(b.id), row, e.clientX || e.clientY ? [e.clientX, e.clientY] : [r.left + 24, r.bottom]); // context-menu key
    });
    list.appendChild(row);
    return { key: b.id, row, cb, name: b.name.toLowerCase() };
  }));
  document.querySelector('[data-toggle="blocks"]').hidden = !model.blocks.size;
  if (state.blocks && !model.blocks.size) toggle('blocks');
  refreshBlockList();
}

function refreshBlockList() {
  const filter = $('blockFilter').value.trim().toLowerCase();
  for (const { key, row, cb, name } of blockRows.rows) {
    const on = !state.blockOff.has(key), set = blockSetting(key), tag = row.querySelector('.block-tag');
    cb.checked = on;
    row.hidden = !name.includes(filter);
    row.classList.toggle('off', !on);
    row.classList.toggle('inherited-off', on && !blockReachable(key));
    const magic = blockMagic(key);
    tag.textContent = magic ? 'magic' : set;
    tag.classList.toggle('set', !!magic || set !== 'default');
    tag.title = `${magic ? `Magic block: ${magic.name}` : SUB_SETTINGS.find(([id]) => id === set)[1]}. Click to change.`;
  }
  blockRows.keepShown();
}

async function setBlocksOn(ids, on) {
  for (const id of ids) { if (on) state.blockOff.delete(id); else state.blockOff.add(id); }
  // Instances of a hidden block leave the selection; copies inside other blocks need a rebuild.
  const nested = ids.some((id) => model.blocks.get(id).parents.length);
  state.sel.ids = state.sel.ids.filter((i) => !objectOff(i));
  if (nested) await rebuildModel(); else pushObjectFlags();
  showInspector();
  refreshBlockList();
  renderFileInfo();
  saveViewState();
}

// Select these blocks' rows, showing them all if the filter leaves any out.
function revealBlocks(ids) {
  const rows = blockRows.rows.filter((r) => ids.includes(r.key));
  if (rows.some((r) => r.row.hidden)) { $('blockFilter').value = ''; refreshBlockList(); }
  blockRows.set(ids);
  if (ids.length === 1 && rows[0]) flashRow(rows[0].row);
  return rows[0]?.row;
}

// Right-click menu for the selected block rows.
function openBlockMenu(ids, row, at) {
  const instances = ids.flatMap((id) => model.blocks.get(id).tops).filter((i) => !objectOff(i) && layerEffective(model.objects[i].layer));
  const subs = subBlocks(ids);
  showMenu(ids.length > 1 ? `${ids.length} blocks` : model.blocks.get(ids[0]).name, [
    { label: 'Select instances', n: instances.length, run: () => selectObjects(instances) },
    subs.length && { label: 'Select sub-blocks', n: subs.length, run: () => revealBlocks([...ids, ...subs]) },
    '-',
    { label: 'Block settings…', run: () => openBlockDialog(ids, row) },
  ].filter(Boolean), at);
}

// The window for these blocks' magic block and sub-element setting.
let blockDialogIds = [];
function openBlockDialog(ids, anchor) {
  blockDialogIds = ids;
  syncBlockDialog();
  placePopover($('blockDialog'), anchor, 'blocksPanel');
}

function syncBlockDialog() {
  const ids = blockDialogIds, one = ids.length === 1 ? model.blocks.get(ids[0]) : null;
  const values = new Set(ids.map(blockSetting)), value = values.size === 1 ? [...values][0] : null, subs = subBlocks(ids);
  $('blockTitle').textContent = $('blockTitle').title = one ? one.name : `${ids.length} blocks`;
  const magics = new Set(ids.map((id) => blockMagic(id)?.id || 'none')), magic = magics.size === 1 ? [...magics][0] : null, anyMagic = ids.some(blockMagic);
  $('blockMagic').innerHTML = (magic ? '' : '<option value="" selected disabled>Mixed</option>') +
    [['none', 'None'], ...MAGIC_BLOCKS.map((b) => [b.id, b.name])].map(([id, label]) => `<option value="${id}"${id === magic ? ' selected' : ''}>${label}</option>`).join('');
  $('blockMagicHint').textContent = !anyMagic ? '' : `Replaces every instance, sized to the height of the block.${ids.some((id) => blockMagic(id) && model.blocks.get(id).parents.length) ? ' In a saved copy, instances inside other blocks stay as they are, as block definitions aren’t changed.' : ''}`;
  $('blockSub').disabled = anyMagic;
  $('blockSub').innerHTML = (value ? '' : '<option value="" selected disabled>Mixed</option>') +
    SUB_SETTINGS.map(([id, label]) => `<option value="${id}"${id === value ? ' selected' : ''}>${label}</option>`).join('');
  $('blockHint').textContent = anyMagic ? 'A magic block’s colours and materials come from its own layers.' : value ? SUB_SETTINGS.find(([id]) => id === value)[2] : 'These blocks have different settings.';
  const apply = $('blockApplySubs');
  apply.textContent = subs.length ? `Apply setting to sub-blocks (${subs.length})` : 'Apply setting to sub-blocks';
  apply.disabled = !subs.length || !value || anyMagic;
  apply.title = !subs.length ? 'No sub-blocks inside' : anyMagic ? 'Doesn’t apply to a magic block' : !value ? 'Choose one setting first' : '';
  $('blockSubsHint').textContent = subs.length && !anyMagic ?'The setting doesn’t change sub-blocks until applied to them, and applying it changes them everywhere they are used.' : '';
  const links = (items, heading) => (items.length ? `${heading}: ${items.slice(0, 6).join(', ')}${items.length > 6 ? ` and ${items.length - 6} more` : ''}` : '');
  const layers = [...new Set(ids.flatMap((id) => { const m = blockMagic(id); return m ? m.parts.map((p) => model.magicLayers[p.layer]) : model.blocks.get(id).layers; }))];
  $('blockLayers').innerHTML = links(layers.map((l) => `<button class="link" data-layer="${l}">${escapeHtml(model.layers[l].fullPath)}</button>`), 'Sub-element layers');
  $('blockParents').innerHTML = one ? links(topParents(one.id).map(blockLink), `Top-level parent block${topParents(one.id).length > 1 ? 's' : ''}`) : '';
}

async function setBlockSetting(ids, value, label) {
  recordUndo(label);
  for (const id of ids) { if (value === 'default') delete state.blockSub[id]; else state.blockSub[id] = value; }
  await rebuildModel();
  saveEdits();
  afterBlockChange();
}

async function setBlockMagic(ids, value, label) {
  recordUndo(label);
  for (const id of ids) { if (value === 'none') delete state.blockMagic[id]; else state.blockMagic[id] = { id: value }; }
  await rebuildModel();
  saveEdits();
  buildLayerTree();
  afterBlockChange();
}

function afterBlockChange() {
  refreshBlockList();
  if (!$('blockDialog').hidden) syncBlockDialog();
  if (state.sel.ids.length) showInspector();
  renderFileInfo();
}

function bindBlocksPanel() {
  blockRows.bind($('blockList'));
  $('blockFilter').addEventListener('input', refreshBlockList);
  $('layerFilter').addEventListener('input', () => { buildLayerTree.refresh?.(); layerRows.keepShown(); });
  $('blockList').addEventListener('scroll', closeLayerMenu);
  $('blocksClose').addEventListener('click', () => state.blocks && toggle('blocks'));
  $('blocksHelp').addEventListener('click', showBlocksHelp);
  document.querySelectorAll('[data-blocks]').forEach((b) => b.addEventListener('click', () => {
    if (model) setBlocksOn(blockRows.rows.filter((r) => !r.row.hidden).map((r) => r.key), b.dataset.blocks === 'all');
  }));
  const close = () => { $('blockDialog').hidden = true; };
  $('blockClose').addEventListener('click', close);
  $('blockDone').addEventListener('click', close);
  $('blockMagic').addEventListener('change', (e) => {
    const n = blockDialogIds.length;
    setBlockMagic(blockDialogIds, e.target.value, `Change magic block (${n > 1 ? `${n} blocks` : model.blocks.get(blockDialogIds[0]).name})`);
  });
  $('blockSub').addEventListener('change', (e) => {
    const n = blockDialogIds.length;
    setBlockSetting(blockDialogIds, e.target.value, `Change sub-element setting (${n > 1 ? `${n} blocks` : model.blocks.get(blockDialogIds[0]).name})`);
  });
  $('blockApplySubs').addEventListener('click', () => {
    const subs = subBlocks(blockDialogIds);
    setBlockSetting(subs, blockSetting(blockDialogIds[0]), `Apply sub-element setting to ${subs.length} sub-block${subs.length > 1 ? 's' : ''}`);
  });
  $('blockDialog').addEventListener('click', (e) => {
    const block = e.target.closest('[data-block]'), layer = e.target.closest('[data-layer]');
    if (block) openBlockDialog([block.dataset.block], revealBlocks([block.dataset.block]));
    if (layer) {
      if (!state.layers) toggle('layers');
      buildLayerTree.reveal(+layer.dataset.layer);
    }
  });
}

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
// in extract.js). state.blockSub: block definition id -> its sub-element setting (see Blocks).
// state.blockMagic: block definition id -> its magic block, { id } (see magicblocks.js).
// Everything is remembered in this browser per model, and can be written into a
// copy of the .3dm.

const rgbHex = (rgb) => '#' + rgb.map((v) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, '0')).join('');
const hexRgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
const NO_EDITS = () => ({ layerMat: {}, layerColor: {}, layerSpecial: {}, objEdits: {}, blockSub: {}, blockMagic: {} });
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
  obj: Object.keys(state.objEdits).length, blocks: Object.keys(state.blockSub).length, magic: Object.keys(state.blockMagic).length });

function saveEdits() {
  const n = editCount(), north = state.sun.north;
  try {
    localStorage.removeItem(oldMaterialsKey());
    if (n.mat + n.col + n.obj + n.blocks + n.magic || north !== fileNorth()) {
      const { layerMat, layerColor, layerSpecial, objEdits, blockSub, blockMagic } = state;
      localStorage.setItem(editsKey(), JSON.stringify({ layerMat, layerColor, layerSpecial, objEdits, blockSub, blockMagic, north }));
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

// Rebuild the GPU batches after objects' attributes change.
async function rebuildModel() {
  const slow = model.stats.triangles > 400000;
  if (slow) { showBusy('Updating the model', 0.5); await new Promise((r) => setTimeout(r, 20)); }
  try {
    renderer.setModel(buildBatches(model));
  } finally {
    if (slow) hideBusy();
  }
  applyLayerVisibility();
  applyLayerMaterials(false);
  pushObjectFlags();
  await settleMagicGround();
}

function pushMagicBatches() {
  renderer.setModel(buildBatches(model));
  applyLayerVisibility();
  applyLayerMaterials(false);
  pushObjectFlags();
}

// Rebuild if a build placed magic blocks whose ground isn't known yet. Their source blocks are gone
// from the batches by then, and magic blocks are left out of the look down, so neither is taken for
// ground. Resolves once they stand on it.
async function settleMagicGround() {
  if (!model.magicMissing) return;
  await lookForMagicGround([...model.magicPoints].filter(([key]) => !model.magicGround.has(key)));
  pushMagicBatches();
}

// Finds the ground under [key, point] entries and records it. Returns whether any of it moved.
async function lookForMagicGround(entries) {
  const u = 1 / model.metresPerUnit, bottom = Math.min(...renderer.batches.map((b) => b.min[2])) - u;
  const found = await renderer.groundBelow(entries.map(([, p]) => p), bottom, 0.05 * u, (b) => model.layers[b.layer]?.magic);
  let moved = false;
  entries.forEach(([key], i) => {
    const was = model.magicGround.get(key), z = found[i];
    if (was === undefined || (was == null) !== (z == null) || Math.abs(was - z) > 0.01 * u) moved = true;
    model.magicGround.set(key, z);
  });
  return moved;
}

// What is visible decides what is ground, so look again when that may have changed, and rebuild only
// if a magic block has to move.
let groundTimer = 0;
function recheckMagicGround() {
  if (!model?.magicPoints?.size) return;
  clearTimeout(groundTimer);
  groundTimer = setTimeout(async () => {
    const seen = model;
    if (seen?.magicPoints?.size && await lookForMagicGround([...seen.magicPoints]) && seen === model) pushMagicBatches();
  }, 200);
}

// Put the objects back as they are in the file, then apply attribute changes (object id ->
// changed attributes). Sets state.objEdits. The batches need rebuilding afterwards.
function applyObjectEdits(objEdits = {}) {
  for (const o of model.objects) o.ai = { ...o.ai0 };
  state.objEdits = {};
  for (const [id, d] of Object.entries(objEdits)) {
    const i = model.objectIndex.get(id);
    if (i == null) continue;
    Object.assign(model.objects[i].ai, d);
    state.objEdits[id] = { ...d };
  }
}

// ---------------------------------------------------------------------------------------------
// Undo and redo, as in Rhino: changes to the model (layer colours, materials and magic materials,
// object colour and material sources, the north angle, Revert) can be undone. View
// changes, hiding objects, turning layers on or off and the site location (a viewer setting, not
// part of the model) are not recorded. Each entry keeps the edit state from before the change;
// undoing swaps it with the current one. Not kept between sessions.

const history = { undo: [], redo: [], coalesce: null };
const UNDO_LIMIT = 100;
const editSnapshot = () => structuredClone({ layerMat: state.layerMat, layerColor: state.layerColor, layerSpecial: state.layerSpecial, objEdits: state.objEdits, blockSub: state.blockSub, blockMagic: state.blockMagic,
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
  } finally {
    historyBusy = false;
    syncUndoButtons();
  }
}

// Make the given edit state current, rebuilding only if objects or foliage normals change.
async function restoreEdits(e) {
  const magicChange = JSON.stringify(state.blockMagic) !== JSON.stringify(e.blockMagic);
  const objectsChange = magicChange || JSON.stringify(state.objEdits) !== JSON.stringify(e.objEdits) || JSON.stringify(state.blockSub) !== JSON.stringify(e.blockSub);
  const vegBefore = model.layers.map((_, i) => layerSpecialId(i) === MAT_VEGETATION).join();
  Object.assign(state, { layerMat: structuredClone(e.layerMat), layerColor: structuredClone(e.layerColor), layerSpecial: structuredClone(e.layerSpecial), blockSub: structuredClone(e.blockSub), blockMagic: structuredClone(e.blockMagic) });
  const vegChange = vegBefore !== model.layers.map((_, i) => layerSpecialId(i) === MAT_VEGETATION).join();
  if (objectsChange) applyObjectEdits(e.objEdits);
  if (objectsChange || vegChange) await rebuildModel();
  if (magicChange) buildLayerTree();
  if (e.north !== undefined) setSun({ north: e.north });
  applyLayerMaterials();
  if (!$('matDialog').hidden && matLayer >= 0) openMaterialDialog(matLayer, document.querySelector('.layer-row .swatch') || $('matDialog'));
  afterBlockChange();
  pushObjectFlags();
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
  for (const [id, set] of Object.entries(e.blockSub || {})) if (model.blocks.has(id) && SUB_SOURCES[set]) state.blockSub[id] = set;
  for (const [id, set] of Object.entries(e.blockMagic || {})) if (model.blocks.has(id) && MAGIC_BY_ID[set?.id]) state.blockMagic[id] = set;
  Object.assign(model, { specialOf: layerSpecialId, subSetting: (id) => state.blockSub[id], blockShown: (id) => !state.blockOff.has(id), magicOf: blockMagic });
  // Older saves numbered the material source "by parent" 2; Rhino's number for it is 3.
  for (const d of Object.values(e.objEdits || {})) if (d.ms === 2) d.ms = 3;
  applyObjectEdits(e.objEdits);
  model.savedNorth = Number.isFinite(e.north) && Math.abs(e.north) <= 360 ? e.north : null;
  const n = editCount(), parts = [];
  if (n.col) parts.push(`colours on ${n.col} layer${n.col > 1 ? 's' : ''}`);
  if (n.mat) parts.push(`materials on ${n.mat} layer${n.mat > 1 ? 's' : ''}`);
  if (n.obj) parts.push(`${n.obj.toLocaleString()} object${n.obj > 1 ? 's' : ''} changed`);
  if (n.blocks) parts.push(`sub-element settings on ${n.blocks.toLocaleString()} block${n.blocks > 1 ? 's' : ''}`);
  if (n.magic) parts.push(`magic blocks on ${n.magic.toLocaleString()} block${n.magic > 1 ? 's' : ''}`);
  if (model.savedNorth != null && model.savedNorth !== fileNorth()) parts.push('the north angle');
  model.restored = parts;
  return n.obj > 0 || n.blocks > 0 || n.magic > 0 || Object.keys(state.layerSpecial).length > 0;
}

// Layer visibility, hidden objects and the cameras are the state of looking at a model rather than
// changes to it: remembered in this browser per model, but not undoable or written to a copy.
// The cameras are saved as the page goes away or another model opens.
const viewKey = () => `3dm-viewer:view:${model.name}:${model.size}`;

function loadViewState() {
  try { return JSON.parse(localStorage.getItem(viewKey()) || '{}') || {}; } catch (e) { return {}; }
}

function saveViewState() {
  if (!model?.viewReady) return; // not until what was saved has been restored
  const layers = {};
  model.layers.forEach((l, i) => { if (layerOn[i] !== l.visible) layers[l.id] = layerOn[i]; });
  const now = walkFrom || camera.snapshot(); // walking saves the camera it will go back to
  try {
    localStorage.setItem(viewKey(), JSON.stringify({ layers, hidden: [...state.hidden].map((i) => model.objects[i].id), blocks: [...state.blockOff], streamlines: { on: state.streamlines.on, off: [...state.streamlines.off] }, maps: { on: state.maps.on, off: [...state.maps.off], picked: state.maps.picked, z: state.maps.z }, view: viewNow, cams: viewCams, camera: now, sun: { doy: state.sun.doy, hour: state.sun.hour }, weather: { on: state.weatherOn, ...state.view } }));
  } catch (e) { /* storage unavailable: lasts for this session only */ }
}

function restoreLayersAndHidden(saved) {
  layerOn = model.layers.map((l) => (typeof saved.layers?.[l.id] === 'boolean' ? saved.layers[l.id] : l.visible));
  for (const id of saved.hidden || []) {
    const i = model.objectIndex.get(id);
    if (i != null) state.hidden.add(i);
  }
  for (const id of saved.blocks || []) if (model.blocks.has(id)) state.blockOff.add(id);
  state.streamlines.on = saved.streamlines?.on !== false;
  state.streamlines.off = new Set(saved.streamlines?.off || []);
  Object.assign(state.maps, { on: saved.maps?.on !== false, off: new Set(saved.maps?.off || []), picked: saved.maps?.picked || {}, z: Number.isFinite(saved.maps?.z) ? saved.maps.z : 0 });
  pushObjectFlags();
  syncHiddenButton();
  if (state.hidden.size) model.restored.push(`${state.hidden.size.toLocaleString()} object${state.hidden.size > 1 ? 's' : ''} hidden`);
  if (layerOn.some((on, i) => on !== model.layers[i].visible)) model.restored.push('layer visibility');
  if (state.blockOff.size) model.restored.push('block visibility');
}

function restoreCameras(saved) {
  const finite = (...v) => v.every(Number.isFinite);
  const valid = (c) => c && Array.isArray(c.target) && c.target.length === 3 && finite(...c.target, c.yaw, c.pitch) && c.distance > 0 && c.fov > 0 && c.fov < Math.PI && typeof c.ortho === 'boolean';
  if (!valid(saved.camera)) return;
  // Saved before Elevation replaced Front and Right, and when a parallel view could be tilted into
  // a free view: those come back as Elevation, and as Perspective.
  const cams = { ...saved.cams }, wasFlat = saved.view === 'front' || saved.view === 'right';
  cams.elevation ||= (wasFlat && cams[saved.view]) || cams.front || cams.right;
  viewCams = Object.fromEntries(Object.entries(cams).filter(([id, c]) => isCameraId(id) && valid(c)));
  const view = wasFlat ? 'elevation' : saved.view;
  if (isCameraId(view)) { viewNow = view; camera.restore(saved.camera); }
  else if (viewCams.perspective) camera.restore(viewCams.perspective);
  syncToolbar();
  redraw();
}

// The sun as it was left with this model. Without a location now (a weather file or custom location
// that did not come back, say), it stays off.
// The date and time, and the Weather widget's switch and View ticks. Saved before the Weather
// widget had them, the sun's on, path and sky come back as its Sun, Sun path and Sky ticks.
function restoreSun(saved) {
  const { on, doy, hour, path, sky } = saved.sun || {};
  if (doy >= 1 && doy <= 366 && hour >= 0 && hour <= 24) Object.assign(state.sun, { doy, hour });
  const w = saved.weather || (typeof on === 'boolean' ? { sun: on, path, sky } : null);
  if (w) {
    const tick = (x, d) => (typeof x === 'boolean' ? x : d);
    state.weatherOn = tick(w.on, true);
    Object.assign(state.view, { sun: tick(w.sun, false), sky: tick(w.sky, true), clouds: tick(w.clouds, true), haze: tick(w.haze, true), path: tick(w.path, false) });
  }
  syncDateWeather();
  redraw();
}

function reportRestored() {
  const parts = model.restored;
  if (parts.length) notice(`Restored your changes to this model: ${parts.join(', ')}. To undo them, click the file name (top left) and choose Revert changes.`, 'info');
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
  placePopover(dlg, anchor, 'layersPanel');
}

// Show a window beside a side panel, level with the row it belongs to.
function placePopover(dlg, anchor, panel) {
  dlg.hidden = false;
  const r = anchor.getBoundingClientRect(), d = dlg.getBoundingClientRect(), side = $(panel).getBoundingClientRect();
  dlg.style.top = Math.max(12, Math.min(window.innerHeight - d.height - 12, r.top - 40)) + 'px';
  dlg.style.left = Math.max(12, (side.width ? side.left : r.left) - d.width - 10) + 'px';
}

// The right-hand panels share a column, whose width is set by dragging the left edge of any of them
// (double-click for the default). Remembered between sessions. Phones use the full window width.
const SIDE_WIDTH = 300, SIDE_EDGE = 6; // px; SIDE_EDGE: how close to the edge a drag can start
state.sideWidth = SIDE_WIDTH;
function setSideWidth(w) {
  state.sideWidth = Math.round(Math.max(SIDE_WIDTH, Math.min(w, window.innerWidth * 0.6)));
  document.querySelector('.side').style.setProperty('--side-width', state.sideWidth + 'px');
  // Windows beside the column move with it.
  for (const [dlg, panel] of [[$('matDialog'), $('layersPanel')], [$('blockDialog'), $('blocksPanel')]]) {
    if (!dlg.hidden && !panel.hidden) dlg.style.left = Math.max(12, panel.getBoundingClientRect().left - dlg.offsetWidth - 10) + 'px';
  }
}

function bindSideResize() {
  const side = document.querySelector('.side');
  const edgePanel = (e) => {
    const p = e.target.closest?.('.panel');
    return p && !window.matchMedia('(max-width: 720px)').matches && e.clientX - p.getBoundingClientRect().left <= SIDE_EDGE ? p : null;
  };
  let from = null;
  side.addEventListener('pointermove', (e) => {
    if (from) setSideWidth(from.width + from.x - e.clientX);
    else side.classList.toggle('at-edge', !!edgePanel(e));
  });
  side.addEventListener('pointerleave', () => { if (!from) side.classList.remove('at-edge'); });
  side.addEventListener('pointerdown', (e) => {
    const p = e.button === 0 && edgePanel(e);
    if (!p) return;
    e.preventDefault();
    e.stopPropagation();
    p.setPointerCapture(e.pointerId);
    from = { x: e.clientX, width: side.offsetWidth };
  }, true);
  const end = () => { if (from) { from = null; savePrefs(); } };
  side.addEventListener('pointerup', end);
  side.addEventListener('pointercancel', end);
  side.addEventListener('dblclick', (e) => { if (edgePanel(e)) { setSideWidth(SIDE_WIDTH); savePrefs(); } });
  if (prefs.sideWidth > SIDE_WIDTH) setSideWidth(prefs.sideWidth);
}

// Top-level objects on a layer whose colour (or material) does not come from the layer, so a
// layer setting does not change them.
function objectsNotFollowingLayer(i, kind) {
  return model.objects.flatMap((o, id) => (o.ai.layer === i && (kind === 'material' ? o.ai.ms === 1 : o.ai.cs === 1 || o.ai.cs === 2) ? [id] : []));
}

function syncMaterialDialog() {
  const isMat = matKind === 'material', l = model.layers[matLayer];
  if (isMat) {
    const info = layerSpecialInfo(matLayer), look = layerLook(matLayer), name = info.id ? SPECIAL[info.id].name : '';
    // The magic material and why; then where the colour comes from.
    $('matSpecialHint').textContent = (info.auto ? (info.id ? `Auto: ${name}. ` : '') : '') + specialReason(info) +
      (info.id && !state.specials ? ' Magic materials are off (Magic in the render mode menu).' : '');
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
    selectObjects(objectsNotFollowingLayer(matLayer, matKind).filter((id) => !objectOff(id)));
  });
}

// Write a copy of the .3dm with the viewer's changes (the original is never touched): layer
// colours, a Rhino material for each layer set in the viewer, object colour/material sources,
// block sub-element settings and magic blocks (writeMagicBlocks).
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
    const MS = { 0: rhino.ObjectMaterialSource.MaterialFromLayer, 1: rhino.ObjectMaterialSource.MaterialFromObject, 3: rhino.ObjectMaterialSource.MaterialFromParent };
    // Objects whose attributes changed.
    for (const it of model.objects) {
      if (!state.objEdits[it.id]) continue;
      const o = objs.findId(it.id);
      if (!o) continue;
      const a = o.attributes(), ai = it.ai;
      a.colorSource = CS[ai.cs] ?? CS[0];
      a.objectColor = rgba(ai.oc);
      a.materialSource = MS[ai.ms] ?? MS[0];
      a.materialIndex = ai.mi;
    }
    // Block sub-element settings: in the file these are the sources of the definition's own objects.
    const idefs = doc.instanceDefinitions();
    for (const [id, set] of Object.entries(state.blockSub)) {
      const src = SUB_SOURCES[set];
      for (const oid of idefs.findId(id)?.getObjectIds() || []) {
        const a = objs.findId(oid)?.attributes();
        if (a) { a.colorSource = CS[src.cs]; a.materialSource = MS[src.ms]; }
      }
    }
    const keptNested = writeMagicBlocks(rhino, doc, rgba);
    showBusy('Saving', 0.8);
    await new Promise((r) => setTimeout(r, 20));
    const out = doc.toByteArray();
    doc.delete();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([out], { type: 'application/octet-stream' }));
    a.download = model.name.replace(/\.3dm$/i, '') + ' - viewer edits.3dm';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    if (keptNested.length) notice(`Saved with the original geometry inside other blocks, as block definitions aren’t changed: ${keptNested.join(', ')}.`, false, 8000);
  } catch (e) {
    console.error(e);
    notice(`Could not write the file: ${e.message || e}`, true);
  } finally {
    hideBusy();
  }
}

// In a copy, top-level instances replaced by a magic block become instances of a new block definition
// holding it, on new layers, with the attributes the instances had. No existing definition changes,
// so the replaced ones stay, and instances inside other blocks stay as they are.
// Returns the names of the blocks left with such instances.
function writeMagicBlocks(rhino, doc, rgba) {
  const used = new Map(); // magic block -> top-level instances
  for (const it of model.objects) {
    const magic = it.k === 'inst' && it.magicXf && blockMagic(it.idef);
    if (magic) used.set(magic, [...(used.get(magic) || []), it]);
  }
  const lt = doc.layers(), mats = doc.materials(), idefs = doc.instanceDefinitions(), objs = doc.objects();
  const names = new Set(), layerIndex = {};
  for (let i = 0; i < idefs.count; i++) names.add(idefs.get(i).name);
  let parentId = null;
  const fileLayer = (key) => {
    if (layerIndex[key] != null) return layerIndex[key];
    if (!parentId) {
      const p = new rhino.Layer();
      Object.assign(p, { name: MAGIC_PARENT_LAYER, color: rgba([0.5, 0.5, 0.5]) });
      parentId = lt.get(lt.add(p)).id;
    }
    const i = model.magicLayers[key], m = new rhino.Material(), l = new rhino.Layer();
    m.name = model.layers[i].name;
    m.diffuseColor = rgba(layerLook(i).rgb);
    mats.add(m);
    Object.assign(l, { name: model.layers[i].name, parentLayerId: parentId, color: rgba(layerDisplayRgb(i)), renderMaterialIndex: mats.count - 1 });
    return (layerIndex[key] = lt.add(l));
  };
  for (const [magic, items] of used) {
    const meshes = [], attrs = [];
    for (const part of magicMeshes(magic, 1 / model.metresPerUnit)) {
      const mesh = new rhino.Mesh(), a = new rhino.ObjectAttributes();
      for (let i = 0; i < part.pos.length; i += 3) mesh.vertices().add(part.pos[i], part.pos[i + 1], part.pos[i + 2]);
      for (let i = 0; i < part.idx.length; i += 3) mesh.faces().addTriFace(part.idx[i], part.idx[i + 1], part.idx[i + 2]);
      mesh.normals().computeNormals();
      a.layerIndex = fileLayer(part.layer);
      meshes.push(mesh); attrs.push(a);
    }
    let name = `Magic block - ${magic.name}`;
    for (let k = 2; names.has(name); k++) name = `Magic block - ${magic.name} ${k}`;
    names.add(name);
    const defId = idefs.get(idefs.add(name, '', '', '', [0, 0, 0], meshes, attrs)).id;
    for (const it of items) {
      const o = objs.findId(it.id);
      if (!o) continue;
      const a = o.attributes(), p = it.magicXf, xf = new rhino.Transform(1);
      objs.delete(it.id);
      for (let r = 0; r < 3; r++) for (let c = 0; c < 4; c++) xf[`m${r}${c}`] = p[r * 4 + c] + (c === 3 ? model.origin[r] : 0);
      objs.addInstanceObject(new rhino.InstanceReference(defId, xf), a);
    }
  }
  return Object.keys(state.blockMagic).filter((id) => model.blocks.get(id).parents.some((p) => !blockMagic(p))).map((id) => model.blocks.get(id).name);
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
state.blockOff = new Set();
let objFlags = new Uint32Array(0);

function resetObjectState() {
  state.sel = { ids: [], p: null };
  state.hidden = new Set();
  objFlags = new Uint32Array(model ? model.objects.length : 0);
  renderer.setObjectFlags(objFlags);
  $('inspect').hidden = true; inspectPin = null;
  closeLayerMenu();
  syncHiddenButton();
  resetExposure();
}

let flagsHidden = '';
function pushObjectFlags() {
  const hidden = `${state.hidden.size},${state.blockOff.size}`;
  if (hidden !== flagsHidden) { flagsHidden = hidden; recheckMagicGround(); }
  objFlags.fill(0);
  for (const id of state.hidden) objFlags[id] |= 1;
  if (state.blockOff.size) model.objects.forEach((o, id) => { if (o.k === 'inst' && state.blockOff.has(o.idef)) objFlags[id] |= 1; });
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
  selectObjects(model.objects.flatMap((o, id) => (!objectOff(id) && layerEffective(o.layer) ? [id] : [])));
}

const UNIT_ABBR = { Meters: 'm', Millimeters: 'mm', Centimeters: 'cm', Kilometers: 'km', Feet: 'ft', Inches: 'in' };
const fmtLen = (v) => (Math.abs(v) >= 100 ? v.toFixed(1) : v.toPrecision(3));
const COLOR_SOURCES = [[0, 'By layer'], [1, 'By object'], [3, 'By parent'], [2, 'By material']];
const MATERIAL_SOURCES = [[0, 'By layer'], [1, 'By object'], [3, 'By parent']];
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
    html += `<select data-mi aria-label="Object material">${opts([[-1, 'Default material'], ...model.materials.filter((m) => !m.magic).map((m) => [m.index, materialLabel(m.index)])], mi)}</select>`;
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
  if (objs.some((o) => o.k === 'inst')) html += '<div class="fine">On a block, this reaches only sub-elements set to “By parent”: see its sub-element setting in the Blocks widget.</div>';
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
  const srcRow = [showsMaterial() ? 'Material' : 'Colour', sourceControl(objs), true];
  let rows, title, swatch;
  if (objs.length === 1) {
    const o = objs[0];
    title = o.name || o.block || o.type;
    swatch = o.look ? rgbHex(showsMaterial() ? shownMaterialRgb(o.look) : shownRgb(o.look)) : 'var(--accent)';
    rows = [
      ['Type', o.k === 'inst' ? `Block · ${blockLink(o.idef)}` : escapeHtml(o.type), true],
      ['Layer', layerLink(o.layer), true],
      srcRow,
      ['Size', sizeText],
      ['Triangles', o.triangles.toLocaleString()],
      ...o.userText.map(([k, v]) => [k, v]),
      ['ID', `<code>${o.id}</code>`, true],
    ];
  } else {
    const count = (key) => {
      const m = new Map();
      for (const o of objs) m.set(key(o), (m.get(key(o)) || 0) + 1);
      return [...m.entries()].sort((a, b) => b[1] - a[1]);
    };
    const types = count((o) => (o.k === 'inst' ? o.idef : o.type));
    const layers = count((o) => o.layer);
    title = `${objs.length} objects selected`;
    swatch = 'var(--accent)';
    rows = [
      ['Types', types.slice(0, 4).map(([t, n]) => `${n} × ${model.blocks.has(t) ? `Block · ${blockLink(t)}` : escapeHtml(t)}`).join('<br>') + (types.length > 4 ? `<br>and ${types.length - 4} more` : ''), true],
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
    if (Object.keys(d).length) state.objEdits[o.id] = { ...d, cs: o.ai.cs, ms: o.ai.ms }; else delete state.objEdits[o.id];
  }
  await rebuildModel();
  saveEdits();
  showInspector();
  if (!$('matDialog').hidden && matLayer >= 0) syncMaterialDialog();
}

function hideSelected() {
  if (!state.sel.ids.length) return;
  for (const id of state.sel.ids) state.hidden.add(id);
  state.sel = { ids: [], p: null };
  $('inspect').hidden = true;
  inspectPin = null;
  pushObjectFlags();
  syncHiddenButton();
  saveViewState();
}

function unhideAll() {
  state.hidden.clear();
  pushObjectFlags();
  syncHiddenButton();
  saveViewState();
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
    const block = e.target.closest('[data-block]');
    if (block) {
      if (!state.blocks) toggle('blocks');
      revealBlocks([block.dataset.block]);
    }
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
    ['Layers', fmt(model.layers.filter((l) => !l.magic).length)],
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
  if (n.blocks) saved.push(`Sub-element settings on ${plural(n.blocks, 'block')}`);
  if (n.magic) saved.push(`Magic blocks on ${plural(n.magic, 'block')}`);
  const changes = [...saved];
  if (nHidden) changes.push(`${plural(nHidden, 'object')} hidden`);
  if (layerOn.some((on, i) => on !== model.layers[i].visible)) changes.push('Layer visibility changed');
  if (state.blockOff.size) changes.push('Block visibility changed');
  if (state.sun.north !== fileNorth()) changes.push('North angle changed');
  if (document.activeElement !== $('fileNorth')) $('fileNorth').value = state.sun.north;
  $('fileNorthInfo').textContent = `Degrees anticlockwise from the model’s +X axis to north (90: +Y is north). ${loc ? `The file’s is ${+fileNorth().toFixed(1)}°, from its ${loc.source}.` : 'The file does not set one; 90 is the default.'}`;
  $('fileChanges').textContent = changes.length ? changes.join(' · ') : 'No changes made in the viewer.';
  $('btnDownload').disabled = saved.length === 0;
  $('btnDownload').title = saved.length ? 'Save a copy of the .3dm with the colours and materials changed in this viewer'
    : 'Change a layer colour or material, or an object’s colour or material, first';
  $('btnRevert').disabled = changes.length === 0;
}

function toggleFileDialog(show = $('fileDialog').hidden) {
  if (!model) return;
  renderFileInfo();
  $('fileDialog').hidden = !show;
}

async function revertChanges() {
  const ok = await Dialog.confirm('Revert changes',
    'Layer colours, materials and magic materials (back to Auto), object colours and materials, block settings, the north angle, hidden objects, and layer and block visibility go back to how they are in the file.\n\nUndo (Ctrl+Z) brings back the colour, material, block and north angle changes, but not hidden objects or layer visibility.',
    'Revert', { danger: true });
  if (!ok) return;
  const n = editCount(), north = fileNorth();
  if (n.mat + n.col + n.obj + n.blocks + n.magic || state.sun.north !== north) recordUndo('Revert changes');
  setSun({ north });
  const rebuild = Object.keys(state.objEdits).length || Object.keys(state.layerSpecial).length || n.blocks || n.magic || nestedBlockOff();
  Object.assign(state, NO_EDITS());
  state.hidden.clear();
  state.blockOff.clear();
  state.sel = { ids: [], p: null };
  $('inspect').hidden = true; inspectPin = null;
  layerOn = model.layers.map((l) => l.visible);
  if (rebuild) {
    applyObjectEdits();
    await rebuildModel();
  }
  applyLayerVisibility();
  applyLayerMaterials();
  buildLayerTree.refresh?.();
  if (n.magic) buildLayerTree();
  afterBlockChange();
  pushObjectFlags();
  syncHiddenButton();
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
    saveEdits();
    renderFileInfo();
  });
  north.addEventListener('change', endUndoGroup);
  $('fileName').addEventListener('click', () => toggleFileDialog());
  $('fileClose').addEventListener('click', () => toggleFileDialog(false));
  $('btnDownload').addEventListener('click', downloadCopy);
  $('btnRevert').addEventListener('click', revertChanges);
}

// ---------------------------------------------------------------------------------------------
// Date and Weather widgets

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

const dayName = (doy) => { const { month, day } = dateFromDayOfYear(EPW_YEAR, doy); return `${day} ${MONTHS[month - 1]}`; };

// The Date and Weather widgets, and the widgets that follow the date and time.
function syncDateWeather() {
  syncDatePanel();
  syncWeatherPanel();
  syncComfortPanel();
  syncExposurePanel();
}

function syncDatePanel() {
  const S = state.sun;
  document.querySelector('[data-act="date"]').setAttribute('aria-pressed', String(state.datePanel));
  $('dateDay').max = daysInYear(EPW_YEAR);
  $('dateDay').value = S.doy;
  $('dateHour').value = S.hour;
  $('dateDayOut').textContent = dayName(S.doy);
  $('dateTimeOut').textContent = activeLocation() ? `${fmtHour(S.hour)} ${fmtUtc(S.utcOffset)}` : fmtHour(S.hour);
  $('dateSum').textContent = `${dayName(S.doy)} · ${fmtHour(S.hour)}`; // the minimised widget's reading
}

// The View ticks: each disabled, with why in its tooltip, when it cannot show.
function syncViewChecks() {
  for (const item of VIEW_ITEMS) {
    const box = document.querySelector(`[data-view="${item}"]`), why = viewWhyNot(item);
    box.checked = state.view[item];
    box.disabled = !!why;
    box.closest('label').title = why ? `${why}. ${VIEW_TITLES[item]}` : VIEW_TITLES[item];
  }
  $('cloudSpeedField').hidden = !viewOn('clouds');
}

function syncWeatherPanel() {
  $('weatherOn').checked = state.weatherOn;
  $('weatherQuick').setAttribute('aria-pressed', String(state.weatherOn));
  document.querySelector('[data-act="weather"]').setAttribute('aria-pressed', String(state.weatherPanel));
  syncViewChecks();
  if (!state.weatherPanel) return;
  const loc = activeLocation(), e = site.epw;
  // Without a location, the location dialog: it takes a weather file too.
  $('weatherAdd').hidden = !!e;
  $('weatherAdd').textContent = loc ? 'Add EPW' : 'Set location';
  $('weatherAdd').title = loc ? 'Add a weather file (EPW): its weather, clouds and haze' : 'Set the site location, for the sun and the sky. A weather file can set it too';
  $('weatherViewToggle').setAttribute('aria-expanded', String(state.weatherViewOpen));
  $('weatherViewToggle').querySelector('.caret').classList.toggle('collapsed', !state.weatherViewOpen);
  $('weatherView').hidden = !state.weatherViewOpen;
  $('cloudSpeed').value = clouds.speed;
  $('cloudSpeedOut').value = clouds.speed ? `${clouds.speed}× wind speed` : 'Still';
  const cells = [...(loc ? sunCells() : []), ...(loc && e ? ['<span class="rule"></span>'] : []), ...(e ? weatherCells() : [])];
  $('weatherRead').hidden = !cells.length;
  $('weatherRead').innerHTML = cells.join('');
  // Minimised, the widget keeps one row: the weather's first (temperature, humidity, wind), or the sun's.
  const kids = [...$('weatherRead').children], first = e ? kids.length - 6 : 0;
  kids.forEach((k, i) => k.classList.toggle('min-row', i >= first && i < first + 3));
}

const cell = (title, icon, text) => `<span title="${title}">${icon}${text}</span>`;
const reading = (x, d, unit) => (x === null ? '—' : `<span><b>${x.toFixed(d)}</b>${unit}</span>`);

// The sun at the location: sunrise and sunset, altitude and azimuth, each drawn in its icon.
function sunCells() {
  const p = sunPosition(), up = p.altitude > -0.83;
  const riseIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2 19h20M6.5 19a5.5 5.5 0 0 1 11 0M12 3.5v7M9.2 6.3 12 3.5l2.8 2.8"/></svg>';
  const days = p.polar
    ? cell(p.polar === 'day' ? 'The sun is up all day' : 'The sun is down all day', riseIcon, `<span class="two"><b>${p.polar === 'day' ? 'Up' : 'Down'}</b><span>all day</span></span>`)
    : cell('Sunrise and sunset', riseIcon, `<span class="two"><span>↑ <b>${fmtHour(p.sunrise)}</b></span><span>↓ <b>${fmtHour(p.sunset)}</b></span></span>`);
  // Altitude: the sun on a ray up from the horizon, at its angle (down to 20° below).
  const a = (Math.max(-20, Math.min(90, p.altitude)) * Math.PI) / 180, at = (r) => [4 + r * Math.cos(a), 17 - r * Math.sin(a)].map((v) => v.toFixed(2)).join(' ');
  const altIcon = `<svg viewBox="0 0 24 24" aria-hidden="true" class="${up ? '' : 'down'}"><path d="M2 17h20"/><path d="M11 17A7 7 0 0 ${a < 0 ? 1 : 0} ${at(7)}"/><path d="M4 17L${at(14)}"/><circle class="sun-dot" cx="${at(14).split(' ')[0]}" cy="${at(14).split(' ')[1]}" r="2.6"/></svg>`;
  const alt = cell(up ? `Sun altitude: ${p.altitude.toFixed(1)}° above the horizon` : `Sun altitude: ${(-p.altitude).toFixed(1)}° below the horizon`, altIcon, `<b>${p.altitude.toFixed(0)}°</b>`);
  // Azimuth: the sun round a compass, north up.
  const z = (p.azimuth * Math.PI) / 180, zx = (12 + 7.5 * Math.sin(z)).toFixed(2), zy = (12 - 7.5 * Math.cos(z)).toFixed(2), dir = COMPASS[Math.round(p.azimuth / 22.5) % 16];
  const azIcon = `<svg viewBox="0 0 24 24" aria-hidden="true" class="${up ? '' : 'down'}"><circle cx="12" cy="12" r="10"/><path d="M12 12L${zx} ${zy}"/><circle class="sun-dot" cx="${zx}" cy="${zy}" r="2.6"/></svg>`;
  const az = cell(`Sun azimuth: ${p.azimuth.toFixed(1)}° from north (${dir}). The dot is the sun, with north up.`, azIcon, `<b>${p.azimuth.toFixed(0)}°</b> <span class="unit">${dir}</span>`);
  return [days, alt, az];
}

// The weather file at the date and time (interpolated): air, humidity and wind; cloud and radiation.
function weatherCells() {
  const e = site.epw, S = state.sun, { month, day } = dateFromDayOfYear(EPW_YEAR, S.doy);
  const w = e.at(month, day, S.hour), v = (x, d = 0) => (x === null ? '—' : x.toFixed(d));
  const sky = weatherSky(e, S.doy, S.hour, activeLocation() ? sunPosition().altitude : 30);
  const blowing = w.windSpeed >= 0.05 && w.windDirection !== null; // null >= 0.05 is false
  const windTitle = blowing ? `Wind from ${COMPASS[Math.round(w.windDirection / 22.5) % 16]} (${v(w.windDirection)}°). The arrow points the way it blows, with north up.` : 'Wind';
  // The file gives the direction the wind comes from; the arrow points the way it goes.
  const needle = blowing ? `<path class="needle" transform="rotate(${(w.windDirection + 180).toFixed(1)} 12 12)" d="M12 5.5 15.5 18 12 15.6 8.5 18Z"/>` : '';
  const svg = (d) => `<svg viewBox="0 0 24 24" aria-hidden="true">${d}</svg>`;
  const cloudTitle = !sky || sky.source === 'none' ? 'Cloud cover: none in the weather file'
    : sky.source === 'radiation' ? 'Cloud cover, estimated: this file has no usable cloud observations, so it is worked out from the share of diffuse light, by day, and filled in overnight'
      : 'Cloud cover, observed: total sky cover from the weather file';
  const cover = !sky || sky.source === 'none' ? '—' : `<span><b>${Math.round(sky.cover * 10)}</b><span class="unit">/10</span></span>`;
  const wm2 = ' <span class="unit">W/m²</span>';
  return [
    cell('Air temperature', svg('<path d="M14 14.76V5a2 2 0 0 0-4 0v9.76a4 4 0 1 0 4 0Z"/>'), reading(w.dryBulb, 1, ' °C')),
    cell('Relative humidity', svg('<path d="m12 2.7 5.66 5.66a8 8 0 1 1-11.31 0Z"/>'), reading(w.relativeHumidity, 0, '%')),
    cell(windTitle, svg(`<circle cx="12" cy="12" r="10"/>${needle}`), w.windSpeed !== null && w.windSpeed < 0.05 ? '<b>Calm</b>' : reading(w.windSpeed, 1, ' m/s')),
    cell(cloudTitle, svg('<path d="M7 18a4 4 0 0 1-.6-7.96A5.5 5.5 0 0 1 17 9.5a4.25 4.25 0 0 1 .25 8.5z"/>'), cover),
    cell(`Global horizontal radiation: ${v(w.globalHorizontal)} W/m², of which diffuse horizontal ${v(w.diffuseHorizontal)} W/m²`,
      svg('<circle cx="12" cy="6" r="3"/><path d="M3 21h18M7 12.5v5M12 12.5v5M17 12.5v5"/>'), reading(w.globalHorizontal, 0, wm2)),
    cell('Direct normal radiation: the sun\'s beam, on a surface facing it', svg('<circle cx="17" cy="7" r="3"/><path d="M14.5 9.5 4.5 19.5M4.5 19.5h4.5M4.5 19.5V15"/>'), reading(w.directNormal, 0, wm2)),
  ];
}

function setSun(changes) {
  Object.assign(state.sun, changes);
  syncDateWeather();
  redraw();
}

function toggleDatePanel() {
  state.datePanel = !state.datePanel;
  $('datePanel').hidden = !state.datePanel;
  syncDateWeather();
}

// Runs the time through the day: from just before sunrise to just after sunset at the location.
function toggleDatePlay() {
  if (sunAnim) { cancelAnimationFrame(sunAnim); sunAnim = 0; $('datePlay').classList.remove('on'); $('datePlay').textContent = '▶'; return; }
  $('datePlay').classList.add('on'); $('datePlay').textContent = '❚❚';
  let last = performance.now();
  const step = (now) => {
    const dt = Math.min(0.1, (now - last) / 1000); last = now;
    const p = activeLocation() ? sunPosition() : {};
    const start = p.sunrise != null ? p.sunrise - 0.25 : 0, end = p.sunset != null ? p.sunset + 0.25 : 24;
    let h = state.sun.hour + dt * 1.2; // 1.2 hours a second
    if (h > end || h < start) h = start;
    setSun({ hour: h });
    sunAnim = requestAnimationFrame(step);
  };
  sunAnim = requestAnimationFrame(step);
}

function bindDateWeather() {
  $('dateDay').addEventListener('input', (e) => setSun({ doy: +e.target.value }));
  $('dateHour').addEventListener('input', (e) => setSun({ hour: +e.target.value }));
  for (const id of ['dateDay', 'dateHour']) $(id).addEventListener('change', saveViewState);
  // Right-click the date slider for the solstices and equinoxes.
  $('dateDay').addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const at = (label, m, d) => ({ label, run: () => { setSun({ doy: dayOfYear(EPW_YEAR, m, d) }); saveViewState(); } });
    showMenu('Go to', [at('21 March · equinox', 3, 21), at('21 June · solstice', 6, 21), at('23 September · equinox', 9, 23),
      at('21 December · solstice', 12, 21)], [e.clientX, e.clientY]);
  });
  // Right-click the time slider for the usual analysis times.
  $('dateHour').addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const at = (label, hour) => ({ label, run: () => { setSun({ hour }); saveViewState(); } });
    const noon = activeLocation() ? sunPosition().noon : null;
    showMenu('Go to', [at('10:00', 10), at('12:00', 12), noon != null && at(`Solar noon · ${fmtHour(noon)}`, noon), at('15:00', 15)].filter(Boolean),
      [e.clientX, e.clientY]);
  });
  $('datePlay').addEventListener('click', toggleDatePlay);
  document.querySelector('[data-act="weather"]').addEventListener('click', toggleWeatherPanel);
  $('weatherClose').addEventListener('click', () => state.weatherPanel && toggleWeatherPanel());
  $('weatherAdd').addEventListener('click', () => (activeLocation() ? openWeatherDialog() : openLocationDialog()));
  $('weatherViewToggle').addEventListener('click', () => { state.weatherViewOpen = !state.weatherViewOpen; syncWeatherPanel(); });
  document.querySelectorAll('[data-view]').forEach((box) => box.addEventListener('change', () => setWeatherView(box.dataset.view, box.checked)));
  $('cloudSpeed').addEventListener('input', (e) => { clouds.speed = +e.target.value; savePrefs(); syncWeatherPanel(); redraw(); });
  $('weatherOn').addEventListener('change', (e) => setWeatherOn(e.target.checked));
  $('weatherQuick').addEventListener('click', () => setWeatherOn(!state.weatherOn));
  $('weatherCombo').addEventListener('click', (e) => { if (e.target === e.currentTarget) toggleWeatherPanel(); }); // the gaps round the icon
  syncDateWeather();
}

// The Weather widget: the sun and the weather file at the Date widget's date and time, and what to show.
function toggleWeatherPanel() {
  state.weatherPanel = !state.weatherPanel;
  $('weatherPanel').hidden = !state.weatherPanel;
  syncDateWeather();
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
  $('btnLocation').classList.toggle('set', !!A);
  $('locName').textContent = A ? A.name || fmtCoords(A.lat, A.lon) : 'Set location';
  $('btnLocation').title = A ? `${A.name ? fmtCoords(A.lat, A.lon) + ', ' : ''}${fmtUtc(A.utcOffset)}, ${LOCATION_KINDS[A.kind]}. Click to change the location.`
    : 'Set the site location';
  const e = site.epw;
  $('btnWeather').classList.toggle('set', !!e);
  $('btnWeather').title = e ? `Weather file: ${e.fileName}` : 'Add a weather file (EPW)';
  locationDialog?.refresh();
  weatherDialog?.refresh();
  syncDateWeather();
  redraw();
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
    el('note').textContent = `The weather file gives the weather in the Weather widget at the Date widget's date and time. A new one with a latitude and longitude also sets the site location (see Set location). ${!model
      ? 'It belongs to the open model; with none open, it is cleared when one is opened.'
      : model.handle ? `It belongs to ${model.name} and comes back when you reopen it from Recent files.`
        : `It belongs to ${model.name} while it is open.`}`;
  };
  refresh();
  weatherDialog = { refresh };
  Dialog.open({ title: 'Weather file', body: wrap, buttons: [{ label: 'Done', value: true, primary: true }], width: 420 })
    .then(() => { weatherDialog = null; });
}

// ---------------------------------------------------------------------------------------------
// Results files (results.js)

const resultLinks = () => results.map(({ id, name, size }) => ({ id, name, size }));

async function addResultsFile(file) {
  if (!model) { notice(`Open a model first, then add ${file.name} to it.`, true); return; }
  if (results.some((r) => r.name === file.name && r.size === file.size)) { notice(`${file.name} is already added.`, false, 3000); return; }
  const m = model, bytes = new Uint8Array(await file.arrayBuffer());
  let parsed;
  try { parsed = parseResultsFile(bytes, file.name); }
  catch (e) { notice(`Could not read ${file.name}: ${e.message}`, true); return; }
  if (!parsed) { notice(`${file.name} isn't a kind of results file the viewer can read.`, true); return; }
  if (m !== model) return;
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  results.push({ id, name: file.name, size: file.size, ...parsed });
  syncResults();
  notice(`${file.name}: ${parsed.parser.name}.`, false, 3000);
  if (m.handle) {
    try { await Recent.putResult(id, bytes); }
    catch (e) { notice(`${file.name} could not be stored with this model, so it won't come back when you reopen it.`, true); return; }
    if (m === model) linkToModel({ results: resultLinks() });
  }
}

function removeResultsFile(id) {
  results = results.filter((r) => r.id !== id);
  linkToModel({ results: resultLinks() });
  Recent.dropResults([id]);
  syncResults();
}

// Everything that shows the results files follows the list.
function syncResults() {
  const n = results.length;
  $('btnResultsFiles').classList.toggle('set', n > 0);
  $('btnResultsFiles').title = n ? `Results files: ${results.map((r) => r.name).join(', ')}` : 'Add results files';
  $('btnResults').hidden = !results.some((r) => r.data);
  fillStreamlines();
  fillMaps();
  fillResultsMenu();
  resultsDialog?.refresh();
  redraw();
}

// Results files dialog: what is bound to the open model, and which parser read each.
let resultsDialog = null;
function openResultsDialog() {
  if (resultsDialog) return;
  const wrap = document.createElement('div');
  wrap.className = 'loc-dlg';
  wrap.innerHTML = `
    <div class="res-list" data-el="list"></div>
    <div class="loc-actions"><button class="btn small" data-el="pick">Add results file…</button></div>
    <div class="fine" data-el="note"></div>
    <input type="file" multiple data-el="input" hidden>`;
  const el = (k) => wrap.querySelector(`[data-el="${k}"]`);
  el('input').accept = [...new Set(RESULT_PARSERS.flatMap((p) => p.extensions))].join(',');
  el('pick').addEventListener('click', () => el('input').click());
  el('input').addEventListener('change', () => { const files = [...el('input').files]; el('input').value = ''; files.forEach(addResultsFile); });
  const refresh = () => {
    el('list').replaceChildren(...results.map((r) => {
      const row = document.createElement('div');
      row.className = 'res-row';
      row.innerHTML = `<div><div>${escapeHtml(r.name)}</div><div class="fine">${r.parser ? `${escapeHtml(r.parser.name)} · ${escapeHtml(r.parser.describe(r.data))}` : 'Not recognised by any parser'}</div></div><button class="x" aria-label="Remove ${escapeHtml(r.name)}" title="Remove">×</button>`;
      row.querySelector('.x').addEventListener('click', () => removeResultsFile(r.id));
      return row;
    }));
    el('pick').disabled = !model;
    el('note').textContent = `Results files are only read, never changed. ${!model
      ? 'They belong to a model: open one first.'
      : model.handle ? `These belong to ${model.name}, and a copy of each comes back when you reopen it from Recent files. To update one, remove it and add the new version.`
        : `These belong to ${model.name} while it is open. You can also drop a results file onto the window.`}`;
  };
  refresh();
  resultsDialog = { refresh };
  Dialog.open({ title: 'Results files', body: wrap, buttons: [{ label: 'Done', value: true, primary: true }], width: 460 })
    .then(() => { resultsDialog = null; });
}

// The toolbar's Results menu: one item for each kind of result there is.
let resultsList = null, resultsMenu = null;
function bindResultsMenu() {
  // An item's checkbox shows or hides what it draws, like its panel's switch; the rest of it opens or closes the panel.
  resultsList = new ChoiceList({ label: 'Results', onPick: (id, e) => {
    if (e.target.closest('.box')) { if (id === 'streamlines') setStreamlinesOn(!state.streamlines.on); else setMapsOn(!state.maps.on); }
    else if (id === 'streamlines') toggleStreamlinesPanel();
    else toggleMapPanel();
  } });
  resultsMenu = new ToolbarMenu($('btnResults'), { label: 'Results' });
  resultsMenu.body.append(resultsList.el);
}
function fillResultsMenu() {
  const items = [];
  if (state.streamlines.lines.length) items.push({ id: 'streamlines', label: 'CFD streamlines', toggle: true });
  if (state.maps.list.length) items.push({ id: 'map', label: 'CFD map', toggle: true });
  resultsList.setGroups(items.length ? [{ items }] : []);
  syncResultsMenu();
}
function syncResultsMenu() {
  const sync = (id, { on, panel }) => {
    if (!resultsList.item(id)) return;
    resultsList.setChecked(id, on);
    resultsList.setOpen(id, panel);
  };
  sync('streamlines', state.streamlines);
  sync('map', state.maps);
}

// A colour scale's legend, as HTML, with a dropdown when its metric has other scales to pick from.
function colourLegendHtml(scale, title, unit) {
  const L = ColourScales.legend(scale), all = scale.metric ? ColourScales.forMetric(scale.metric) : [];
  const bar = L.cells ? L.cells.map((c) => `<span style="background:${c.color}" title="${escapeHtml(c.label)}"></span>`).join('') : `<span style="background:${L.gradient}"></span>`;
  const ticks = L.ticks.map((t) => `<span class="${t.at <= 0 ? 'first' : t.at >= 1 ? 'last' : ''}" style="left:${(t.at * 100).toFixed(1)}%">${t.text}</span>`).join('');
  return `<div class="res-legend"><div class="res-legend-head"><span>${escapeHtml(title)}</span><span>${escapeHtml(unit || '')}</span></div>
    ${all.length > 1 ? `<select data-metric="${scale.metric}" aria-label="Colour scale for ${escapeHtml(title)}" title="Colour scale, used for this kind of data across the viewer">${all.map((s) => `<option value="${s.id}"${s === scale ? ' selected' : ''}>${escapeHtml(s.name)}</option>`).join('')}</select>` : ''}
    <div class="res-scale">${bar}</div><div class="res-ticks">${ticks}</div></div>`;
}

// The CFD streamlines panel, and the lines it shows.
const streamlineKey = (file, line) => `${file.name}|${line.name}`;

function toggleStreamlinesPanel() {
  state.streamlines.panel = !state.streamlines.panel;
  $('streamlinesPanel').hidden = !state.streamlines.panel;
  syncResultsMenu();
}

function setStreamlinesOn(on) {
  state.streamlines.on = on;
  syncStreamlines();
  saveViewState();
  redraw();
}

function fillStreamlines() {
  const SL = state.streamlines, files = model ? results.filter((r) => r.parser?.id === 'cfdStreamlines') : [];
  const all = files.flatMap((file) => file.data.streamlines.map((line) => ({ file, line })));
  const wind = ColourScales.preferred('windSpeed');
  const v = model && all.length ? streamlineVertices(all.map((a) => a.line), model.metresPerUnit, model.origin, (speed) => ColourScales.colour(wind, speed)) : null;
  setHtml($('streamlineLegend'), all.length ? colourLegendHtml(wind, 'Velocity', ColourScales.metrics.windSpeed.unit) : '');
  renderer.setResultLines(v);
  SL.lines = all.map(({ file, line }, i) => {
    const key = streamlineKey(file, line);
    return { key, parts: v.ranges[i].map((range, k) => ({ key: `${key}|${k}`, range })) };
  });
  if (SL.panel && !all.length) toggleStreamlinesPanel();
  // A row for each streamline, with one under it for each polyline when it has several.
  const makeRow = (key, parent, label, title, count) => {
    const row = document.createElement('div');
    row.className = 'layer-row';
    row.title = title;
    row.dataset.key = key;
    if (parent) row.dataset.parent = parent;
    row.style.paddingLeft = `${10 + (parent ? 16 : 0)}px`;
    row.innerHTML = `<button class="caret ${count ? '' : 'empty'}" aria-label="Expand"><svg viewBox="0 0 24 24"><path d="m6 9 6 6 6-6"/></svg></button><input type="checkbox"><span class="layer-name"></span>${count ? `<span class="layer-count">${count.toLocaleString()}</span>` : ''}`;
    row.querySelector('.layer-name').textContent = label;
    row.querySelector('.caret').addEventListener('click', () => {
      if (SL.collapsed.has(key)) SL.collapsed.delete(key); else SL.collapsed.add(key);
      syncStreamlines();
    });
    row.querySelector('input').addEventListener('change', (e) => {
      if (e.target.checked) SL.off.delete(key); else SL.off.add(key);
      syncStreamlines();
      saveViewState();
      redraw();
    });
    return row;
  };
  $('streamlineList').replaceChildren(...all.flatMap(({ file, line }, i) => {
    const { key, parts } = SL.lines[i], several = parts.length > 1;
    const top = makeRow(key, null, files.length > 1 ? `${line.name} · ${file.name}` : line.name, `${line.name} in ${file.name}`, several ? parts.length : 0);
    return several ? [top, ...parts.map((p, k) => makeRow(p.key, key, `Polyline ${k + 1}`, `Polyline ${k + 1} of ${line.name}`, 0))] : [top];
  }));
  syncStreamlines();
}

function syncStreamlines() {
  const SL = state.streamlines;
  $('streamlinesOn').checked = SL.on;
  syncResultsMenu();
  for (const row of $('streamlineList').children) {
    const on = !SL.off.has(row.dataset.key), parent = row.dataset.parent;
    row.querySelector('input').checked = on;
    row.classList.toggle('off', !on);
    row.classList.toggle('inherited-off', on && (!SL.on || SL.off.has(parent)));
    row.hidden = SL.collapsed.has(parent);
    row.querySelector('.caret').classList.toggle('collapsed', SL.collapsed.has(row.dataset.key));
  }
}

// The CFD map panel, and the maps it shows.
const resultScale = (r) => (r.metric ? ColourScales.preferred(r.metric) : (r.dataScale ||= ColourScales.fromData(r.values)));
const resultUnit = (r) => (r.metric ? ColourScales.metrics[r.metric].unit : r.unit);
const pickedResult = (m) => m.map.results.find((r) => r.name === state.maps.picked[m.key]) || m.map.results[0];

function toggleMapPanel() {
  state.maps.panel = !state.maps.panel;
  $('mapPanel').hidden = !state.maps.panel;
  syncResultsMenu();
}

function setMapsOn(on) {
  state.maps.on = on;
  syncMaps();
  hideMapHover();
  saveViewState();
  redraw();
}

function showMapResult(i) {
  const m = state.maps.list[i], r = pickedResult(m);
  renderer.setMapResult(i, cfdMapValues(r), ColourScales.ramp(resultScale(r)));
}

function fillMaps() {
  const M = state.maps, files = model ? results.filter((r) => r.parser?.id === 'cfdMap') : [];
  M.list = files.flatMap((file) => file.data.maps.map((map) => ({ key: `${file.name}|${map.name}`, map, file,
    label: files.length > 1 ? `${map.name} · ${file.name}` : map.name })));
  renderer.setResultMaps(M.list.map(({ map }) => ({ pos: cfdMapVertices(map, model.metresPerUnit, model.origin), indices: map.indices })));
  M.list.forEach((_, i) => showMapResult(i));
  if (M.panel && !M.list.length) toggleMapPanel();
  const changed = () => { syncMaps(); hideMapHover(); saveViewState(); redraw(); };
  const caret = '<svg viewBox="0 0 24 24"><path d="m6 9 6 6 6-6"/></svg>';
  $('mapList').replaceChildren(...M.list.flatMap((m, i) => {
    const top = document.createElement('div');
    top.className = 'layer-row';
    top.title = `${m.map.name} in ${m.file.name}`;
    top.dataset.key = m.key;
    top.innerHTML = `<button class="caret" aria-label="Expand">${caret}</button><input type="checkbox"><span class="layer-name"></span>`;
    top.querySelector('.layer-name').textContent = m.label;
    top.querySelector('.caret').addEventListener('click', () => {
      if (M.collapsed.has(m.key)) M.collapsed.delete(m.key); else M.collapsed.add(m.key);
      syncMaps();
    });
    top.querySelector('input').addEventListener('change', (e) => {
      if (e.target.checked) M.off.delete(m.key); else M.off.add(m.key);
      changed();
    });
    const kids = m.map.results.map((r) => {
      const row = document.createElement('label'), unit = resultUnit(r);
      row.className = 'layer-row';
      row.style.paddingLeft = '26px';
      row.dataset.parent = m.key;
      row.dataset.result = r.name;
      row.innerHTML = `<span class="caret empty"></span><input type="radio" name="map-${i}"><span class="layer-name"></span>`;
      row.querySelector('.layer-name').textContent = unit ? `${r.name} [${unit}]` : r.name;
      row.querySelector('input').addEventListener('change', () => {
        M.picked[m.key] = r.name;
        showMapResult(i);
        changed();
      });
      return row;
    });
    return [top, ...kids];
  }));
  syncMaps();
}

function syncMaps() {
  const M = state.maps;
  $('mapOn').checked = M.on;
  syncResultsMenu();
  $('mapZ').value = M.z;
  $('mapZOut').value = `${M.z > 0 ? '+' : ''}${M.z.toFixed(1)} m`;
  for (const row of $('mapList').children) {
    const parent = row.dataset.parent, input = row.querySelector('input');
    if (parent) {
      const m = M.list.find((x) => x.key === parent);
      input.checked = pickedResult(m).name === row.dataset.result;
      row.hidden = M.collapsed.has(parent);
      row.classList.toggle('inherited-off', !M.on || M.off.has(parent));
    } else {
      const on = !M.off.has(row.dataset.key);
      input.checked = on;
      row.classList.toggle('off', !on);
      row.classList.toggle('inherited-off', on && !M.on);
      row.querySelector('.caret').classList.toggle('collapsed', M.collapsed.has(row.dataset.key));
    }
  }
  setHtml($('mapLegends'), M.list.filter((m) => !M.off.has(m.key)).map((m) => {
    const r = pickedResult(m);
    return colourLegendHtml(resultScale(r), M.list.length > 1 ? `${m.label}: ${r.name}` : r.name, resultUnit(r));
  }).join(''));
}

// A colour scale picked for a kind of data applies wherever that data is shown.
function setColourScale(metric, id) {
  ColourScales.choices[metric] = id;
  savePrefs();
  state.maps.list.forEach((m, i) => { if (pickedResult(m).metric === metric) showMapResult(i); });
  syncMaps();
  if (metric === 'windSpeed') fillStreamlines();
  syncComfortPanel();
  redraw();
}

// The panel that follows the mouse over a map, with what the map holds there.
let mapHoverAt = null, mapHoverRead = null, mapHoverBusy = false;
function hideMapHover() { mapHoverAt = null; $('mapHover').hidden = true; }

function mapHoverMove(e) {
  const shown = model && state.maps.on && state.maps.list.some((m) => !state.maps.off.has(m.key));
  if (!shown || moving() || drag || pointers.size) { hideMapHover(); return; }
  mapHoverAt = { clientX: e.clientX, clientY: e.clientY };
  placeMapHover();
  if (!mapHoverBusy) readMapHover();
}

function placeMapHover() {
  const el = $('mapHover'), gap = 16, { clientX: x, clientY: y } = mapHoverAt;
  el.style.left = `${x + gap + el.offsetWidth > innerWidth ? x - gap - el.offsetWidth : x + gap}px`;
  el.style.top = `${y + gap + el.offsetHeight > innerHeight ? y - gap - el.offsetHeight : y + gap}px`;
}

async function readMapHover() {
  mapHoverBusy = true;
  try {
    // One read at a time, then the latest place the mouse has moved to, if it has.
    while (mapHoverAt && mapHoverAt !== mapHoverRead) {
      mapHoverRead = mapHoverAt;
      const s = frameState();
      s.pickMaps = true;
      const h = await renderer.pick(...toDevice(mapHoverRead), camera.viewProj(), s);
      if (!mapHoverAt) break;
      showMapHover(h);
      placeMapHover();
    }
  } finally { mapHoverBusy = false; }
}

function showMapHover(h) {
  const el = $('mapHover'), m = h && h.map !== undefined ? state.maps.list[h.map] : null;
  const f = m && cfdMapFind(m.map, (h.p[0] + model.origin[0]) * model.metresPerUnit, (h.p[1] + model.origin[1]) * model.metresPerUnit, (h.p[2] + model.origin[2]) * model.metresPerUnit - state.maps.z);
  if (!f) { el.hidden = true; return; }
  const picked = pickedResult(m), num = (v) => v.toFixed(Math.abs(v) < 10 ? 2 : 1);
  const rows = m.map.results.map((r) => {
    const v = cfdMapValueAt(r, f), scale = resultScale(r), unit = resultUnit(r);
    return { on: r === picked, label: r === picked && !Number.isNaN(v) ? ColourScales.label(scale, v) : null,
      html: `<div class="row${r === picked ? ' on' : ''}"><i style="background:${Number.isNaN(v) ? 'transparent' : ColourScales.css(scale, v)}"></i><span>${escapeHtml(r.name)}</span><b>${Number.isNaN(v) ? 'no data' : `${num(v)}${unit ? ` ${escapeHtml(unit)}` : ''}`}</b></div>` };
  });
  const band = rows.find((r) => r.label)?.label;
  setHtml(el, `<div class="head">${escapeHtml(m.map.name)}</div>${rows.map((r) => r.html).join('')}${band ? `<div class="band">${escapeHtml(picked.name)}: ${escapeHtml(band)}</div>` : ''}`);
  el.hidden = false;
}

function bindMapPanel() {
  $('mapOn').addEventListener('change', (e) => setMapsOn(e.target.checked));
  $('mapClose').addEventListener('click', () => state.maps.panel && toggleMapPanel());
  $('mapZ').addEventListener('input', (e) => { state.maps.z = +e.target.value; syncMaps(); saveViewState(); redraw(); });
  for (const id of ['mapLegends', 'streamlineLegend']) {
    $(id).addEventListener('change', (e) => { if (e.target.dataset.metric) setColourScale(e.target.dataset.metric, e.target.value); });
  }
  canvas.addEventListener('pointermove', mapHoverMove);
  canvas.addEventListener('pointerleave', hideMapHover);
}

function bindStreamlinesPanel() {
  $('streamlinesOn').addEventListener('change', (e) => setStreamlinesOn(e.target.checked));
  $('streamlinesClose').addEventListener('click', () => state.streamlines.panel && toggleStreamlinesPanel());
}

// Set location dialog: the three sources, each marked "In use" or offering "Use this location".
// Changes apply as they are made.
let locationDialog = null;
function showLocationHelp() {
  Dialog.open({ title: 'Location', html: true, width: 400, body: `<p>The site location places the sun and sets the clock's UTC offset. It can come from three sources; <b>Use this location</b> picks which one is used.</p>
    <p><b>Weather file (EPW)</b>: the location in the file. Choose or replace it here, with the sun-and-cloud button next to the pin, or by dropping an .epw file onto the window. Its weather shows in the Weather widget and drives the UTCI.</p>
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
// Walking on a touch screen: the finger on the thumb stick, kept apart from the ones that look.
let stick = null; // { id, x, y, moved }
const STICK_R = 55;
let drag = null, pivot = null, wheelZoom = null, clickTimer = 0;

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
// camera.distance has no fixed relation to what is on screen: zooming about a point scales it, and
// orbiting leaves it. So a drag finds how far away the surface it grabbed is, and leaves drag.depth
// unset over empty space, where the camera's distance is all there is to go on.
const pickDepth = (e, d) => pickPoint(e).then((p) => { if (p && drag === d) d.depth = V3.dot(V3.sub(p, camera.eye), camera.forward); });

// ---------------------------------------------------------------------------------------------
// Sun exposure (Tools): how often each part of a layer's objects sees the sun over a period. The
// results are drawn on the model until the settings change; nothing is kept.

const expo = {
  panel: false, on: true, layer: -1, flip: false, upOnly: false, summary: null, dateSpan: 'day', timeSpan: 'hours3', step: 10, spacing: 1, auto: true, picking: false,
  // Working state: the surface tested (for surfaceKey), the run going on (runKey, token), the
  // settings of the results shown (doneKey), and of a run stopped or waiting for Update.
  surface: null, surfaceKey: '', runKey: '', doneKey: '', pendingKey: '', stoppedKey: '', token: 0, timer: 0,
  progress: null, status: '', shown: false, stale: false,
};
let toolsMenu = null, toolsList = null, exposureBound = false;

const fmtDay = (doy) => { const { month, day } = dateFromDayOfYear(EPW_YEAR, doy); return `${day} ${MONTHS[month - 1]}`; };
const fmtRange = ([a, b], f) => (a === b ? f(a) : `${f(a)} – ${f(b)}`);
const fmtMetres = (m) => `${m} m`;
const fmtClock = (h) => (h >= 24 ? '24:00' : fmtHour(h)); // the end of the day, not the start

// The days and hours tested: the chosen spans round the Date widget's date and time.
const exposurePeriod = () => ({ days: exposureDays(expo.dateSpan, state.sun.doy, EPW_YEAR), hours: exposureHours(expo.timeSpan, state.sun.hour) });

// The settings a surface and a run depend on, or null when there is nothing to work out.
function exposureKeys() {
  if (!model || expo.layer < 0 || !activeLocation()) return null;
  const S = state.sun, hidden = [...state.hidden].join('.') + '/' + [...state.blockOff].join('.'), { days, hours } = exposurePeriod();
  const surface = [expo.layer, expo.flip, expo.upOnly, expo.spacing, hidden].join('|');
  return { surface, run: [surface, days[0], days.length, hours, expo.step, S.lat, S.lon, S.utcOffset, S.north, layerOn.map(Number).join('')].join('|') };
}

// Each frame, and on a change in the panel: whether the results still match the settings, and if not, a new run (after a
// pause, so that dragging a slider runs once) or, without Update automatically, a note that the
// results are out of date.
function checkExposure() {
  const k = expo.on ? exposureKeys() : null;
  // Settings changed and changed back: the results shown are up to date again.
  if (k && k.run === expo.doneKey && expo.stale && !expo.runKey) { expo.stale = false; syncExposurePanel(); }
  if (!k || k.run === expo.doneKey || k.run === expo.runKey || k.run === expo.pendingKey) return;
  if (!expo.auto || k.run === expo.stoppedKey) {
    if (!expo.stale) { expo.stale = true; syncExposurePanel(); }
    return;
  }
  expo.pendingKey = k.run;
  clearTimeout(expo.timer);
  expo.timer = setTimeout(runExposure, 150);
}

async function runExposure() {
  const k = exposureKeys();
  expo.pendingKey = '';
  if (!k) return;
  const token = ++expo.token, t0 = performance.now(), u = 1 / model.metresPerUnit;
  Object.assign(expo, { runKey: k.run, stoppedKey: '', stale: false });
  if (k.surface !== expo.surfaceKey) {
    Object.assign(expo, { status: 'Preparing the surfaces…', progress: 0 });
    syncExposurePanel();
    await new Promise((r) => setTimeout(r, 30));
    if (token !== expo.token) return;
    const surface = exposureSurface(exposureLayerMeshes(model, expo.layer, objectOff), { spacing: expo.spacing * u, flip: expo.flip, upOnly: expo.upOnly, lift: EXPOSURE_LIFT * u, weldTol: 1e-4 * u });
    Object.assign(expo, { surface, surfaceKey: k.surface });
    renderer.setExposurePoints(surface.error ? null : surface);
  }
  const surface = expo.surface, S = state.sun;
  const times = exposureTimes({ ...exposurePeriod(), step: expo.step }), dirs = surface.error ? [] : exposureSunDirs(times, { lat: S.lat, lon: S.lon, utcOffset: S.utcOffset, year: EPW_YEAR, north: S.north });
  const done = (status) => {
    Object.assign(expo, { status, progress: null, runKey: '', doneKey: k.run });
    syncExposurePanel();
    redraw();
  };
  if (surface.error || !dirs.length) {
    renderer.setExposureMap(null);
    expo.shown = false;
    expo.summary = null;
    done(surface.error === 'tooMany' ? 'Too many points to test at this spacing: try a wider one.'
      : surface.error === 'noneUp' ? 'None of the layer’s surfaces face within 45° of straight up.'
      : surface.error ? 'The layer has no surfaces to analyse that are shown.' : `The sun is down at all ${times.length.toLocaleString()} times.`);
    return;
  }
  Object.assign(expo, { status: 'Calculating…', progress: 0 });
  syncExposurePanel();
  const lit = await renderer.exposureRun({ dirs, texel: Math.min(expo.spacing / 2, EXPOSURE_TEXEL) * u, stop: () => token !== expo.token,
    progress: (f) => { expo.progress = f; syncExposureProgress(); } });
  if (!lit) return;
  const values = new Float32Array(lit.length), all = EXPOSURE_FULL * dirs.length;
  for (let i = 0; i < lit.length; i++) values[i] = (lit[i] * 100) / all;
  renderer.setExposureMap(surface, values, ColourScales.ramp(ColourScales.preferred('sunExposure')));
  expo.shown = true;
  const sum = exposureSummary(surface, values), u2 = model.metresPerUnit ** 2;
  expo.summary = { area: sum.area * u2, exposed: sum.exposed * u2 };
  const n = surface.pos.length / 3, secs = (performance.now() - t0) / 1000;
  done(`${times.length.toLocaleString()} ${times.length === 1 ? 'time' : 'times'}, the sun up at ${dirs.length.toLocaleString()} · ${n.toLocaleString()} points · ${secs < 10 ? secs.toFixed(1) : Math.round(secs)} s`);
}

function stopExposure() {
  if (!expo.runKey && !expo.pendingKey) return;
  clearTimeout(expo.timer);
  expo.token++;
  Object.assign(expo, { stoppedKey: expo.runKey || expo.pendingKey, runKey: '', pendingKey: '', progress: null, status: 'Stopped.', stale: true });
  syncExposurePanel();
}

// A new model: nothing chosen, nothing shown.
function resetExposure() {
  clearTimeout(expo.timer);
  expo.token++;
  Object.assign(expo, { layer: -1, summary: null, surface: null, surfaceKey: '', runKey: '', doneKey: '', pendingKey: '', stoppedKey: '', progress: null, status: '', shown: false, stale: false });
  setExposurePicking(false);
  renderer.setExposurePoints(null);
  renderer.setExposureMap(null);
  syncExposurePanel();
}

// The layers that hold surfaces (meshes, polysurfaces and the like, or block instances), with how
// many objects each.
function exposureLayerCounts() {
  const n = new Map();
  for (const o of model ? model.objects : []) if (o.k === 'mesh' || o.k === 'inst') n.set(o.ai.layer, (n.get(o.ai.layer) || 0) + 1);
  return n;
}

function setExposureLayer(layer) {
  expo.layer = layer;
  if (layer >= 0) {
    // The finest spacing that keeps the points to a quick run, to start with.
    const u = model.metresPerUnit, area = exposureLayerMeshes(model, layer, objectOff).reduce((s, list) => s + Meshes.area(Meshes.join(list)), 0) * u * u;
    expo.spacing = EXPOSURE_SPACINGS.find((s) => exposurePointEstimate(area, s) <= 200000) || EXPOSURE_SPACINGS[EXPOSURE_SPACINGS.length - 1];
  } else {
    renderer.setExposureMap(null);
    expo.shown = false;
    expo.summary = null;
  }
  expo.status = '';
  syncExposurePanel();
  checkExposure();
  redraw();
}

function setExposurePicking(on) {
  expo.picking = on && !!model;
  canvas.classList.toggle('picking', expo.picking);
  $('exposurePick').setAttribute('aria-pressed', String(expo.picking));
  if (expo.picking && hoverAt) showWalkMarker(hoverAt);
  if (!expo.picking && !choosingStart() && state.walkMarker) { placing.next = null; state.walkMarker = null; redraw(); }
}

// The picker's click on the model: the layer of the object under it.
function pickExposureLayer(e) {
  setExposurePicking(false);
  pickAt(e).then((h) => { if (h?.id != null && model.objects[h.id]) setExposureLayer(model.objects[h.id].ai.layer); });
}

function setExposure(changes) {
  Object.assign(expo, changes);
  syncExposurePanel();
  checkExposure();
  redraw();
}

function toggleExposurePanel() {
  expo.panel = !expo.panel;
  $('exposurePanel').hidden = !expo.panel;
  if (!expo.panel) setExposurePicking(false);
  toolsList?.setOpen('exposure', expo.panel);
  syncExposurePanel();
}

function syncExposureProgress() {
  const going = expo.progress != null;
  $('exposureBarBox').hidden = !going;
  $('exposureStop').hidden = !going;
  if (going) $('exposureBar').style.width = `${(expo.progress * 100).toFixed(1)}%`;
}

function syncExposurePanel() {
  if (!exposureBound) return;
  $('btnTools').setAttribute('aria-pressed', String(expo.panel));
  if (!expo.panel) return;
  const located = !!activeLocation();
  $('exposureRead').hidden = located;
  if (!located) $('exposureRead').innerHTML = 'No location is set, so the sun’s position is not known. <button class="link">Set location…</button>';
  $('exposureOn').checked = expo.on;
  const counts = exposureLayerCounts(), sel = $('exposureLayer');
  const options = [['-1', counts.size ? 'Choose a layer…' : 'No layers with surfaces']].concat([...counts.keys()]
    .sort((a, b) => model.layers[a].fullPath.localeCompare(model.layers[b].fullPath))
    .map((l) => [String(l), `${model.layers[l].fullPath} (${counts.get(l).toLocaleString()})`]));
  const html = options.map(([v, t]) => `<option value="${v}">${escapeHtml(t)}</option>`).join('');
  if (sel.dataset.html !== html) { sel.innerHTML = html; sel.dataset.html = html; }
  sel.value = String(expo.layer);
  $('exposureFlip').checked = expo.flip;
  $('exposureUp').checked = expo.upOnly;
  const { days, hours } = exposurePeriod();
  $('exposureDateSpan').value = expo.dateSpan;
  $('exposureTimeSpan').value = expo.timeSpan;
  $('exposureDaysOut').textContent = fmtRange([days[0], days[days.length - 1]], fmtDay);
  $('exposureHoursOut').textContent = fmtRange(hours, fmtClock);
  $('exposureStep').value = String(expo.step);
  $('exposureSpacing').value = String(expo.spacing);
  $('exposureAuto').checked = expo.auto;
  const going = expo.progress != null, ready = located && expo.layer >= 0 && expo.on;
  syncExposureProgress();
  const status = !ready ? (expo.layer < 0 ? 'Choose the layer to analyse, or pick it from the model.' : located && !expo.on ? 'Results are hidden.' : '')
    : expo.stale && !going ? (expo.status === 'Stopped.' ? `Stopped. ${expo.auto ? 'Change a setting, or untick and tick Update automatically' : 'Tick Update automatically'} to calculate.`
      : `${expo.shown ? 'Settings changed since these results. ' : ''}Tick Update automatically to calculate.`) : expo.status;
  $('exposureStatus').textContent = status;
  const m2 = (a) => `${Math.round(a).toLocaleString()} m²`, pc = (a) => `${Math.round((a / sum.area) * 100)}%`, sum = expo.summary;
  const stats = expo.shown && expo.on && sum && sum.area > 0;
  $('exposureStats').hidden = !stats;
  if (stats) setHtml($('exposureStats'), `<dl class="wx exposure-stats"><dt>Area analysed</dt><dd><b>${m2(sum.area)}</b></dd>
    <dt>In sun, on average</dt><dd><b>${m2(sum.exposed)}</b> (${pc(sum.exposed)})</dd>
    <dt>Shaded, on average</dt><dd><b>${m2(sum.area - sum.exposed)}</b> (${pc(sum.area - sum.exposed)})</dd></dl>`);
  const scale = ColourScales.preferred('sunExposure');
  setHtml($('exposureLegend'), expo.shown && expo.on ? `${colourLegendHtml(scale, 'Time in sun', '%')}<div class="exposure-ends"><span>Always shaded</span><span>Always in sun</span></div>` : '');
}

function showExposureHelp() {
  Dialog.open({ title: 'Sun exposure', html: true, width: 440, body: `<p>How often each part of a layer’s objects can see the sun over a period, ignoring cloud: the share of the times tested, while the sun is up, that the sun reaches it.</p>
    <p><b>Surfaces:</b> choose the layer, or press the picker and click an object on it. Each object is tested on the side facing most nearly up; <b>Flip sides</b> tests the other side instead. <b>Ground/roof only</b> keeps just the parts facing within 45° of straight up, leaving out walls and the like.</p>
    <p>Under the results: the area analysed, and how much of it is in sun and shaded on average over the period.</p>
    <p><b>Date span</b> and <b>Time span</b> are periods round the date and time in the Date widget (press S), shown beside each, both ends included: 1 week is three days either side, 1 hour half an hour either side. Every day in the dates is tested at the times, every <b>Interval</b>. Change the Date widget and the results follow it.</p>
    <p><b>Grid spacing</b> is the most distance between the points tested on the surfaces: closer gives a finer result and takes longer. The colours blend between the points.</p>
    <p>What shades the surfaces is what is shown: hide a layer or an object, and the results update without it. Times are the location’s clock time, as in the Date widget.</p>
    <p>With <b>Update automatically</b> off, the results stay as they are while you change the settings, which keeps long periods quick to set up. Tick it again to calculate.</p>
    <p>The results are not kept: they go when the model is closed.</p>` });
}

function bindExposurePanel() {
  toolsList = new ChoiceList({ label: 'Tools', onPick: (id) => { if (id === 'exposure') toggleExposurePanel(); } });
  toolsList.setGroups([{ items: [{ id: 'exposure', label: 'Sun exposure', title: 'How often surfaces see the sun over a period' }] }]);
  toolsMenu = new ToolbarMenu($('btnTools'), { label: 'Tools' });
  toolsMenu.body.append(toolsList.el);
  $('exposureClose').addEventListener('click', () => expo.panel && toggleExposurePanel());
  $('exposureHelp').addEventListener('click', showExposureHelp);
  $('exposureRead').addEventListener('click', (e) => { if (e.target.closest('.link')) openLocationDialog(); });
  $('exposureOn').addEventListener('change', (e) => {
    if (!e.target.checked) stopExposure();
    setExposure({ on: e.target.checked });
  });
  $('exposureLayer').addEventListener('change', (e) => setExposureLayer(+e.target.value));
  $('exposurePick').addEventListener('click', () => setExposurePicking(!expo.picking));
  $('exposureFlip').addEventListener('change', (e) => setExposure({ flip: e.target.checked }));
  $('exposureUp').addEventListener('change', (e) => setExposure({ upOnly: e.target.checked }));
  const options = (spans) => spans.map((sp) => `<option value="${sp.id}">${escapeHtml(sp.label)}</option>`).join('');
  $('exposureDateSpan').innerHTML = options(EXPOSURE_DATE_SPANS);
  $('exposureTimeSpan').innerHTML = options(EXPOSURE_TIME_SPANS);
  $('exposureDateSpan').addEventListener('change', (e) => setExposure({ dateSpan: e.target.value }));
  $('exposureTimeSpan').addEventListener('change', (e) => setExposure({ timeSpan: e.target.value }));
  $('exposureStep').innerHTML = EXPOSURE_STEPS.map((m) => `<option value="${m}">every ${m} min</option>`).join('');
  $('exposureSpacing').innerHTML = EXPOSURE_SPACINGS.map((m) => `<option value="${m}">${fmtMetres(m)}</option>`).join('');
  $('exposureStep').addEventListener('change', (e) => setExposure({ step: +e.target.value }));
  $('exposureSpacing').addEventListener('change', (e) => setExposure({ spacing: +e.target.value }));
  // Ticking it again also restarts a stopped run.
  $('exposureAuto').addEventListener('change', (e) => setExposure({ auto: e.target.checked, ...(e.target.checked ? { stoppedKey: '' } : {}) }));
  $('exposureStop').addEventListener('click', stopExposure);
  // Esc puts the picker down.
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && expo.picking) { e.preventDefault(); e.stopPropagation(); setExposurePicking(false); }
  }, true);
  exposureBound = true;
  syncExposurePanel();
}

function bindPointer() {
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());

  window.addEventListener('pointerdown', (e) => document.body.classList.toggle('touch', e.pointerType === 'touch'), true);
  canvas.addEventListener('pointerdown', (e) => {
    canvas.focus();
    canvas.setPointerCapture(e.pointerId);
    if (moving() && e.pointerType === 'touch' && !stick) {
      const r = canvas.getBoundingClientRect();
      if (e.clientX < r.left + r.width / 2) { startStick(e); return; }
    }
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 1 && moving()) {
      // Pedestrian and drive modes: any button (or one finger) drags to look.
      drag = { mode: 'look', x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY, moved: false, button: e.button };
      if (walker.active) walker.skipFall();
      else driver.dragging = true;
      canvas.classList.add('dragging');
    } else if (pointers.size === 1) {
      // Rhino-style mouse: right-drag orbits (Shift + right pans), left/middle-drag pans.
      // Alt + left orbits for trackpads; on touch screens one finger orbits. Top-down and level
      // parallel views keep their tilt: right-drag turns them about Z instead, and one finger pans.
      const rules = viewRules(), rightDrag = e.pointerType !== 'touch' && e.button === 2 && !e.shiftKey;
      const orbit = rules === 'orbit' && (e.pointerType === 'touch' || rightDrag || (e.button === 0 && e.altKey));
      const mode = orbit ? 'orbit' : rightDrag ? rules : 'pan';
      drag = { mode, x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY, moved: false, button: e.button, at: dialAngle(canvas, e) };
      pivot = null;
      if (orbit) pickPoint(e).then((p) => { if (drag && drag.mode === 'orbit') pivot = p; });
      else if (mode === 'pan') pickDepth(e, drag);
      canvas.classList.add('dragging');
    } else if (pointers.size === 2 && !moving()) {
      drag = { mode: 'pinch', ...pinchInfo() };
      pickDepth({ clientX: drag.cx, clientY: drag.cy }, drag);
    }
    syncCompassOverlay();
  });

  canvas.addEventListener('pointermove', (e) => {
    if (stick && e.pointerId === stick.id) { moveStick(e); return; }
    hoverAt = { clientX: e.clientX, clientY: e.clientY };
    if ((choosingStart() || expo.picking) && !drag) showWalkMarker(hoverAt);
    if (!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (!drag) return;
    if (drag.mode === 'pinch' && pointers.size === 2) {
      const p = pinchInfo(), r = canvas.getBoundingClientRect();
      camera.pan(p.cx - drag.cx, p.cy - drag.cy, r.height, drag.depth);
      const ndc = [((p.cx - r.left) / r.width) * 2 - 1, 1 - ((p.cy - r.top) / r.height) * 2];
      const before = camera.distance;
      camera.zoomAt(drag.dist / p.dist, drag.depth ? camera.pointAtDepth(...ndc, drag.depth) : camera.planePoint(...ndc));
      if (drag.depth) drag.depth *= camera.distance / before;
      Object.assign(drag, p);
      redraw();
      return;
    }
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    if (Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) > 4) drag.moved = true;
    drag.x = e.clientX; drag.y = e.clientY;
    if (drag.mode === 'look') (driver.active ? driver : walker).turn(dx, dy);
    else if (drag.mode === 'orbit') camera.orbit(dx, dy, pivot);
    else if (drag.mode === 'top') turnByDial(e);
    else if (drag.mode === 'elevation') camera.yaw -= dx * 0.006;
    else if (drag.mode === 'pan') camera.pan(dx, dy, canvas.getBoundingClientRect().height, drag.depth);
    redraw();
  });

  const end = (e) => {
    if (stick && e.pointerId === stick.id) {
      // A tap there, without moving, selects as a tap anywhere else does.
      if (!stick.moved && e.type === 'pointerup') pickAt(e).then((h) => selectObject(h ? h.id : null, h ? h.p : null, false));
      endStick();
      return;
    }
    pointers.delete(e.pointerId);
    // A left click or tap without dragging selects the object under the pointer.
    // While choosing where to start walking, it starts there instead.
    if (pointers.size === 0 && drag && !drag.moved && drag.mode !== 'pinch' && (drag.button === 0 || e.pointerType === 'touch') && e.type === 'pointerup') {
      if (choosingStart()) startWalkAt(e);
      else if (expo.picking) pickExposureLayer(e);
      else pickAt(e).then((h) => selectObject(h ? h.id : null, h ? h.p : null, e.shiftKey));
    }
    if (pointers.size === 0) { drag = null; driver.dragging = false; canvas.classList.remove('dragging'); }
    else if (pointers.size === 1) {
      const [p] = pointers.values();
      drag = { mode: moving() ? 'look' : viewRules() === 'orbit' ? 'orbit' : 'pan', x: p.x, y: p.y, moved: true };
    }
    syncCompassOverlay();
  };
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);
  canvas.addEventListener('pointerleave', () => { if ((choosingStart() || expo.picking) && state.walkMarker) { placing.next = null; state.walkMarker = null; redraw(); } });

  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    if (!model) return;
    if (moving()) { (driver.active ? driver : walker).zoom(e.deltaY); redraw(); return; }
    const unit = e.deltaMode === 1 ? 0.05 : e.deltaMode === 2 ? 1 : 0.0015;
    const factor = Math.exp(Math.max(-0.5, Math.min(0.5, e.deltaY * unit)));
    const now = performance.now();
    // A burst of wheel events zooms about the surface under the pointer. The first waits for the
    // pick, as the camera's distance can put the plane through its target far behind that surface.
    if (!wheelZoom || now - wheelZoom.t >= 600 || Math.hypot(e.clientX - wheelZoom.x, e.clientY - wheelZoom.y) >= 4) {
      const z = (wheelZoom = { t: now, x: e.clientX, y: e.clientY, ready: false, p: null, factor: 1, ndc: toNdc(e) });
      pickPoint(e).catch(() => null).then((p) => {
        Object.assign(z, { p, ready: true });
        camera.zoomAt(z.factor, p || camera.planePoint(...z.ndc));
        redraw();
      });
    }
    wheelZoom.t = now;
    if (!wheelZoom.ready) { wheelZoom.factor *= factor; return; }
    camera.zoomAt(factor, wheelZoom.p || camera.planePoint(...toNdc(e)));
    redraw();
  }, { passive: false });

  canvas.addEventListener('dblclick', async (e) => {
    if (!model || walker.active) return;
    const p = await pickPoint(e);
    if (p) animateFocus(p); else zoomExtents();
  });
}

// The compass: turned so that its arrow points to north on the screen, with the N kept upright.
// The way the view faces along the ground is the yaw + 180°, at any pitch.
function syncCompass() {
  const r = (camera.yaw * 180) / Math.PI + 180 - state.sun.north;
  $('compassDial').setAttribute('transform', `rotate(${r})`);
  $('compassN').setAttribute('transform', `rotate(${-r} 0 -21)`);
  $('compassOverlayDial').setAttribute('transform', `rotate(${r})`);
  $('compassOverlayN').setAttribute('transform', `rotate(${-r} 0 -27)`);
}

// While the window is a dial, a large see-through compass shows where the dial's middle is.
function syncCompassOverlay() {
  $('compassOverlay').hidden = drag?.mode !== 'top';
}

// Turns the view the short way round to face a compass bearing (degrees clockwise from north),
// keeping its tilt: around the middle of the view, or on the spot when walking.
function faceBearing(bearing) {
  if (!model) return;
  const from = camera.yaw, to = ((state.sun.north - bearing) * Math.PI) / 180 - Math.PI;
  const turn = wrapAngle(to - from);
  if (Math.abs(turn) < 1e-4) return;
  const t0 = performance.now(), dur = 260;
  const step = (now) => {
    const t = Math.min(1, (now - t0) / dur), k = 1 - Math.pow(1 - t, 3);
    setHeading(from + turn * k);
    if (t < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

function setHeading(yaw) {
  const eye = camera.eye;
  camera.yaw = yaw;
  if (walker.active) camera.target = V3.sub(eye, V3.scale(camera.dir, camera.distance));
  redraw();
}

const wrapAngle = (a) => ((((a + Math.PI) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)) - Math.PI;

// The pointer's angle around the middle of an element, as on a dial. Too near the middle, the angle
// means little.
function dialAngle(el, e) {
  const r = el.getBoundingClientRect(), x = e.clientX - (r.left + r.width / 2), y = e.clientY - (r.top + r.height / 2);
  return Math.hypot(x, y) < 8 ? null : Math.atan2(y, x);
}

// Right-drag in a view looking straight down: the whole window is a dial, like the compass.
function turnByDial(e) {
  const a = dialAngle(canvas, e);
  if (a === null) return;
  if (drag.at !== null) camera.yaw += wrapAngle(a - drag.at);
  drag.at = a;
}

// Dragging the compass turns it like a dial, and the view with it. The drag only starts once the
// pointer has moved, so a click (a press and release without moving) on the N or a tick faces that
// way, and it carries on outside the compass, where the angle is easier to control.
function bindCompass() {
  const el = $('compass');
  let drag = null;
  el.addEventListener('pointerdown', (e) => {
    if (model && e.button === 0) drag = { id: e.pointerId, x: e.clientX, y: e.clientY, at: dialAngle(el, e), moved: false, point: e.target.closest('.compass-point') };
  });
  window.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    if (!drag.moved) {
      if (Math.hypot(e.clientX - drag.x, e.clientY - drag.y) < 4) return;
      drag.moved = true;
      el.setPointerCapture(e.pointerId);
      el.classList.add('dragging');
    }
    const a = dialAngle(el, e);
    if (a === null) return;
    if (drag.at !== null) setHeading(camera.yaw + wrapAngle(a - drag.at));
    drag.at = a;
  });
  const end = (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    if (e.type === 'pointerup' && !drag.moved && drag.point) faceBearing(+drag.point.dataset.bearing);
    drag = null;
    el.classList.remove('dragging');
  };
  window.addEventListener('pointerup', end);
  window.addEventListener('pointercancel', end);
}

function startStick(e) {
  stick = { id: e.pointerId, x: e.clientX, y: e.clientY, moved: false };
  const el = $('walkStick'), r = el.offsetParent?.getBoundingClientRect() || { left: 0, top: 0 };
  el.style.left = e.clientX - r.left + 'px';
  el.style.top = e.clientY - r.top + 'px';
  el.classList.add('active');
  if (walker.active) walker.skipFall();
}

function moveStick(e) {
  const dx = e.clientX - stick.x, dy = e.clientY - stick.y, d = Math.hypot(dx, dy);
  if (d > 6) stick.moved = true;
  if (!stick.moved) return;
  (driver.active ? driver : walker).stick = [-dy / STICK_R, dx / STICK_R];
  const k = d > STICK_R ? STICK_R / d : 1, el = $('walkStick');
  el.firstElementChild.style.transform = `translate(${dx * k}px, ${dy * k}px)`;
  el.classList.toggle('run', walker.active && d / STICK_R > WALK.STICK_RUN);
}

function endStick() {
  stick = null;
  walker.stick = null;
  driver.stick = null;
  const el = $('walkStick');
  el.classList.remove('active', 'run');
  el.style.left = el.style.top = el.firstElementChild.style.transform = '';
}

window.devMode = false;
function setDevMode(on) {
  state.devMode = on;
  window.devMode = on;
  $('devLabel').hidden = !on;
  document.body.classList.toggle('dev', on);
  clearInterval(diag.timer);
  if (on) { diagReset(); diag.timer = setInterval(showDiag, 500); }
  showDiag();
}

// Developer diagnostics: an overlay over the model with the frame rate and what the GPU holds.
// The viewer draws only when something changes, so an untouched view shows 0 frames a second;
// "display" is how often the browser offers a frame (the screen's refresh rate).
const diag = { timer: 0, t0: 0, ticks: 0, frames: 0, cpu: 0, cpuMax: 0, gpu: 0, gpuN: 0, gpuWaiting: false };
function diagReset() { Object.assign(diag, { t0: performance.now(), ticks: 0, frames: 0, cpu: 0, cpuMax: 0, gpu: 0, gpuN: 0 }); }
function diagFrame(t) {
  const ms = performance.now() - t;
  diag.frames++; diag.cpu += ms; diag.cpuMax = Math.max(diag.cpuMax, ms);
  // Until the GPU has finished the frame: one frame at a time, so the measuring costs nothing.
  if (diag.gpuWaiting) return;
  diag.gpuWaiting = true;
  const t1 = performance.now();
  renderer.device.queue.onSubmittedWorkDone().then(() => { diag.gpu += performance.now() - t1 + ms; diag.gpuN++; diag.gpuWaiting = false; });
}
function showDiag() {
  const el = $('diag'), on = state.devMode && !!model && !atHome && !!renderer;
  el.hidden = !on;
  if (!on) return;
  const s = (performance.now() - diag.t0) / 1000 || 1, n = (v) => Math.round(v).toLocaleString();
  const ms = (v) => v.toFixed(v < 10 ? 1 : 0), st = renderer.stats, info = renderer.adapterInfo;
  const dpr = Math.min(window.devicePixelRatio || 1, 2), heap = performance.memory?.usedJSHeapSize;
  const rows = [
    ['fps', `${n(diag.frames / s)} drawn · ${n(diag.ticks / s)} display`],
    ['frame', diag.frames ? `${ms(diag.cpu / diag.frames)} ms CPU (max ${ms(diag.cpuMax)}) · ${diag.gpuN ? ms(diag.gpu / diag.gpuN) + ' ms GPU' : '–'}` : 'idle'],
    ['view', `${canvas.width} × ${canvas.height} px @${dpr}× · MSAA ${MSAA}×`],
    ['model', `${n(st.triangles)} triangles · ${n(st.vertices)} vertices · ${renderer.batches.length} batches`],
    ['memory', `${st.bytes < 1048576 ? (st.bytes / 1024).toFixed(0) + ' KB' : (st.bytes / 1048576).toFixed(1) + ' MB'} geometry${heap ? ` · ${(heap / 1048576).toFixed(0)} MB JS heap` : ''}`],
  ];
  if (info) rows.push(['adapter', [info.vendor, info.architecture, info.description].filter(Boolean).join(' · ') || 'unknown']);
  el.innerHTML = rows.map(([k, v]) => `<div><b>${k}</b>${v}</div>`).join('');
  diagReset();
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
  if (driver.active && model) return [...driver.headlamps(), ...on];
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
    if (k === 'escape') { e.preventDefault(); leaveWalk(); return; }
  }
  if (driver.active) {
    if (driver.key(e, true)) { e.preventDefault(); if (k === 'c' || k === 't') { syncDrivePanel(); savePrefs(); syncLightsPanel(); } return; }
    if (k === 'escape') { e.preventDefault(); leaveWalk(); return; }
  }
  if (walker.placing && k === 'escape') { e.preventDefault(); walker.exit(); return; }
  if (driver.placing && k === 'escape') { e.preventDefault(); driver.exit(); return; }
  const actions = {
    f: zoomExtents,
    1: () => pickView('top'), 2: () => pickView('elevation'), 3: () => pickView('perspective'), 4: () => pickView('walk'), 5: () => pickView('drive'),
    m: () => setMode(MODES[(MODES.findIndex(([id]) => id === state.mode) + 1) % MODES.length][0]),
    e: () => toggle('showEdges'), c: () => toggle('showCurves'), x: () => toggle('xray'), o: () => toggle('ao'), l: () => toggle('layers'), k: () => { if (model.blocks.size) toggle('blocks'); }, s: toggleDatePanel,
    '?': toggleHelp, escape: () => {
      if (atHome) { leaveHome(); return; } closeLayerMenu(); $('matDialog').hidden = true; $('blockDialog').hidden = true; $('fileDialog').hidden = true; selectObject(null); },
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

// Top, Elevation, Perspective and the file's named views each keep their own camera: leaving one
// remembers it, and coming back restores it. The first visit, or picking the view you are in, gives
// the view's default: zoom extents, or the camera saved in the file. Named views are read-only.
// viewNow is the view the camera belongs to: the last one picked. Walk is listed with them but has
// no camera of its own: see startWalk.
let viewNow = 'perspective', viewCams = {};
// How the view moves (see movementRules). A named view keeps the rules of its saved camera, so that
// orbiting one up to straight down or through level doesn't catch it there.
const viewRules = () => { const named = namedViewOf(viewNow); return movementRules(named ? camera.fromRhino(named) : camera); };
function pickView(id) {
  // From walking to driving or back: out of one, then into the other.
  if ((id === 'walk' && driver.active) || (id === 'drive' && walker.active)) { leaveWalk(() => pickView(id)); return; }
  if (id === 'walk') { driver.exit(); startWalk(); return; }
  if (id === 'drive') { walker.exit(); startDrive(); return; }
  if (moving()) { leaveWalk(() => { if (id !== viewNow) pickView(id); }); return; }
  walker.exit();
  driver.exit();
  if (viewNow !== id) viewCams[viewNow] = camera.snapshot();
  const saved = viewNow !== id && viewCams[id], named = namedViewOf(id);
  viewNow = id;
  if (!saved && !named) { setView(id, true); return; }
  camera.restore(saved || camera.fromRhino(named));
  syncToolbar();
  redraw();
}

// The toolbar's Camera menu. Picking leaves it open, to compare views.
const CAMERAS = [['top', 'Top', '1'], ['elevation', 'Elevation', '2'], ['perspective', 'Perspective', '3']];
const namedViewOf = (id) => (typeof id === 'string' && id.startsWith('named:') ? model?.views[+id.slice(6)] : null);
const isCameraId = (id) => CAMERAS.some(([c]) => c === id) || !!namedViewOf(id);
let cameraList = null, cameraMenu = null;

function bindCameraMenu() {
  cameraList = new ChoiceList({ label: 'Cameras', onPick: (id) => model && pickView(id) });
  cameraMenu = new ToolbarMenu($('btnCamera'), { label: 'Camera' });
  cameraMenu.body.append(cameraList.el);
  fillCameraMenu();
}

function showNamedViewsHelp() {
  cameraMenu.close();
  Dialog.open({ title: 'Named views', html: true, width: 380, body: `<p>These are the views saved by name in the Rhino file. In Rhino, they are made and managed with the <b>NamedView</b> command.</p>
    <p>Here they can be picked but not changed. Moving the camera from one does not alter the file, and picking it again goes back to the saved view. To add or change a named view, do it in Rhino and open the file again.</p>
    <p>The camera matches Rhino's as closely as it can, so the framing may differ a little.</p>` });
}

function fillCameraMenu() {
  const named = (model?.views || []).map((v, i) => ({ id: `named:${i}`, label: v.name }));
  cameraList.setGroups([...(named.length ? [{ heading: 'From this file', help: { title: 'About named views', run: showNamedViewsHelp }, items: named }] : []),
    { items: [...CAMERAS.map(([id, label, hint]) => ({ id, label, hint })), { id: 'walk', label: 'Walk', hint: '4' }, { id: 'drive', label: 'Drive', hint: '5' }] }]);
}

function syncCameraMenu() {
  const walking = walker.active || walker.placing, driving = driver.active || driver.placing;
  cameraList?.setActive(walking ? 'walk' : driving ? 'drive' : viewNow);
  const name = walking ? 'Walk' : driving ? 'Drive' : namedViewOf(viewNow)?.name || CAMERAS.find(([id]) => id === viewNow)?.[1];
  $('cameraName').textContent = name;
  $('btnCamera').title = `Camera: ${name}`;
}
// Walking starts from Walk in the camera list, which usually first asks where to start: the figure
// follows the cursor, a marker shows the spot under it, and a click there starts walking (as Street
// View's figure is dropped). Esc or another camera cancels. The start is found as a lamp's place is
// (B): the surface under the cursor, a little towards the eye; the walker then stands on the ground
// below it. With a perspective camera already near the ground, walking starts where it is.
// Picking Walk while walking shows its panel again, if closed. Walking ends through the fade, by
// Esc or another camera; walkFrom is the camera it started from, which it then goes back to.
const WALK_MARKER = 1;   // marker radius (m)
const WALK_NEAR = 3;     // camera at most this high above the surface below it (m): no choosing
const placing = { busy: false, next: null, checking: false };
let walkFrom = null, leaving = null;
function startWalk() {
  cameraMenu.close();
  if (walker.active) { $('walkPanel').hidden = false; canvas.focus(); return; }
  if (!model || walker.placing || placing.checking) return;
  if (camera.ortho) { startPlacing(); return; }
  placing.checking = true;
  heightAboveGround().then((h) => {
    placing.checking = false;
    if (walker.active || walker.placing || !model) return;
    if (h != null && h <= WALK_NEAR) fadeIntoWalk(); else startPlacing();
  });
}
// Fades to black, stops walking, runs then (the latest, if asked again meanwhile) and fades back in.
function leaveWalk(then = null) {
  const first = !leaving, f = $('walkFade');
  leaving = then || (() => {});
  if (!first) return;
  f.classList.add('dark');
  setTimeout(() => {
    const next = leaving;
    leaving = null;
    walker.exit();
    driver.exit();
    next();
    f.classList.remove('dark');
  }, 250);
}
// Fades to black, starts walking (at start, or where the camera is) and fades back in.
function fadeIntoWalk(start = null) {
  const f = $('walkFade');
  placing.checking = true;
  f.classList.add('dark');
  canvas.focus();
  setTimeout(() => {
    placing.checking = false;
    $('walkHint').hidden = false;
    walkFrom = camera.snapshot();
    walker.enter(start).then((ok) => { if (ok) $('walkPanel').hidden = false; f.classList.remove('dark'); syncToolbar(); syncWalkPanel(); syncLightsPanel(); redraw(); });
    syncToolbar();
  }, 250);
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
function startPlacing(who = walker) {
  who.place();
  canvas.classList.add('placing');
  canvas.classList.toggle('placing-car', who === driver);
  $('walkPlaceHint').innerHTML = `Click where to start ${who === driver ? 'driving' : 'walking'} · drag to move the view · <kbd>Esc</kbd> to cancel`;
  $('walkPlaceHint').hidden = false;
  if (hoverAt) showWalkMarker(hoverAt);
  syncToolbar();
  syncWalkPanel();
  canvas.focus();
}
function endPlacing() {
  canvas.classList.remove('placing', 'placing-car');
  $('walkPlaceHint').hidden = true;
  placing.next = null;
  if (state.walkMarker) { state.walkMarker = null; redraw(); }
}
// Moves the marker to the surface under the cursor (one pick at a time, the latest position next),
// while choosing where to walk or picking a layer for sun exposure.
function showWalkMarker(at) {
  if (placing.busy) { placing.next = at; return; }
  placing.busy = true;
  pickAt(at).then((h) => {
    if (choosingStart() || expo.picking) {
      // At least about 12 pixels across, so it shows from far off too. The car's is its length across.
      const px = h && (2 * V3.len(V3.sub(h.p, camera.eye)) * Math.tan(camera.fov / 2)) / canvas.clientHeight;
      state.walkMarker = h ? { p: h.p, r: Math.max((driver.placing ? DRIVE_MARKER : WALK_MARKER) / (METRES_PER_UNIT[model.units] || 1), 6 * px) } : null;
      redraw();
    }
  }).finally(() => {
    placing.busy = false;
    const next = placing.next;
    placing.next = null;
    if (next && (choosingStart() || expo.picking)) showWalkMarker(next);
  });
}
// A click while choosing: start walking (or driving) there.
function startWalkAt(e) {
  if (driver.placing) { startDriveAt(e); return; }
  pickAt(e).then((h) => {
    if (!h || !walker.placing) return;
    const mpu = METRES_PER_UNIT[model.units] || 1, back = camera.ortho ? camera.dir : V3.norm(V3.sub(camera.eye, h.p));
    walker.placing = false;
    endPlacing();
    fadeIntoWalk(V3.add(h.p, V3.scale(back, 0.4 / mpu)));
  });
}
// Driving starts from Drive in the camera list (or 5), always by choosing where to start, with the
// car's footprint following the cursor. It faces the way the camera looks. Esc or another camera
// stops it; the Drive panel's Exit too.
const DRIVE_MARKER = 2.2; // marker radius (m): about the car's half length
function startDrive() {
  cameraMenu.close();
  if (driver.active) { $('drivePanel').hidden = false; canvas.focus(); return; }
  if (!model || driver.placing || placing.checking) return;
  startPlacing(driver);
}
function startDriveAt(e) {
  pickAt(e).then((h) => {
    if (!h || !driver.placing) return;
    const mpu = METRES_PER_UNIT[model.units] || 1;
    // Facing away from the camera; straight down, the top of the view is ahead.
    const f = camera.forward, flat = Math.hypot(f[0], f[1]) > 0.05 ? f : camera.up;
    const heading = Math.atan2(flat[1], flat[0]);
    // A little towards the eye, so a spot on a wall's foot is in front of it.
    const back = V3.norm([camera.eye[0] - h.p[0], camera.eye[1] - h.p[1], 0]);
    driver.placing = false;
    endPlacing();
    fadeIntoDrive(V3.add(h.p, V3.scale(back, 0.05 / mpu)), heading);
  });
}
function fadeIntoDrive(start, heading) {
  const f = $('walkFade');
  placing.checking = true;
  f.classList.add('dark');
  canvas.focus();
  setTimeout(() => {
    placing.checking = false;
    walkFrom = camera.snapshot();
    driver.enter(start, heading).then((ok) => {
      if (ok) { $('drivePanel').hidden = false; $('driveHint').hidden = false; }
      f.classList.remove('dark'); syncToolbar(); syncDrivePanel(); redraw();
    });
    syncToolbar();
  }, 250);
}

// The Drive panel -----------------------------------------------------------------------------

function showDriveHelp() {
  Dialog.open({ title: 'Driving', html: true, width: 420, body: `<p><b>Drive</b> in the camera list, or <kbd>5</kbd>, starts driving: click where the car should start. It faces the way the camera looks. Until you click you can still move the view; <kbd>Esc</kbd> cancels. Closing this panel does not stop you: pick Drive again to bring it back.</p>
    <p><kbd>W</kbd> or <kbd>↑</kbd> accelerates · <kbd>S</kbd> or <kbd>↓</kbd> brakes, then reverses · <kbd>A</kbd><kbd>D</kbd> or <kbd>←</kbd><kbd>→</kbd> steer · <kbd>Space</kbd> handbrake · <kbd>T</kbd> headlights · <kbd>C</kbd> changes the camera · <kbd>R</kbd> puts the car back where it last stood firmly · drag to look round · wheel to zoom · <kbd>Esc</kbd> or another camera to stop</p>
    <p>On a touch screen, drag on the left half of the view: forward accelerates, back brakes and reverses, and sideways steers. Drag on the right half to look round. <b>Exit</b> in this panel stops driving.</p>
    <p>The car mounts kerbs up to 30 cm; anything higher, and lower than its roof, it bounces off. Slopes slow it down going up, and off a ramp or an edge it flies. Hidden layers and vegetation are driven through.</p>
    <p>The car's top speed is 160 km/h · <b>Collision detection</b> off drives through walls (the car still follows the ground) · <b>Shadows</b>: the car casts the sun's shadows; that redraws them every frame, which can be slow on big models · <b>Headlights</b> (<kbd>T</kbd>): two beams that light the model, best at night, as the walker's torch does. The brake and reversing lights come on by themselves.</p>` });
}

let driveShown = '';
function syncDriveSpeed() {
  const t = `${Math.round(driver.speed * 3.6)} km/h`;
  if (t !== driveShown) { driveShown = t; $('driveSpeedNow').textContent = t; }
}

function syncDrivePanel() {
  const S = driver.settings;
  $('driveCam').value = String(S.cam);
  $('driveCollide').checked = S.collide;
  $('driveShadows').checked = S.shadows;
  $('driveHeadlights').checked = S.headlights;
  syncDriveSpeed();
}

function bindDrivePanel() {
  const S = driver.settings, changed = () => { syncDrivePanel(); savePrefs(); };
  $('driveCam').innerHTML = DRIVE_CAMS.map((c, i) => `<option value="${i}">${c.label}</option>`).join('');
  $('driveCam').addEventListener('change', () => { S.cam = +$('driveCam').value; driver.camPos = null; changed(); canvas.focus(); });
  $('driveCollide').addEventListener('change', () => { S.collide = $('driveCollide').checked; changed(); canvas.focus(); });
  $('driveShadows').addEventListener('change', () => { S.shadows = $('driveShadows').checked; changed(); redraw(); canvas.focus(); });
  $('driveHeadlights').addEventListener('change', () => { S.headlights = $('driveHeadlights').checked; changed(); syncLightsPanel(); redraw(); canvas.focus(); });
  $('driveHelp').addEventListener('click', showDriveHelp);
  $('driveExit').addEventListener('click', () => { if (driver.active) leaveWalk(); });
  $('driveClose').addEventListener('click', () => { $('drivePanel').hidden = true; canvas.focus(); });
  syncDrivePanel();
}

// The Walk panel ------------------------------------------------------------------------------

function showWalkHelp() {
  Dialog.open({ title: 'Walking', html: true, width: 420, body: `<p><b>Walk</b> in the camera list, or <kbd>4</kbd>, starts walking. The figure then follows the cursor, with a yellow circle on the spot below it: click to stand there, with your eyes 1.5 m above the ground (on a wall, you stand at its foot, on your side). Until you click you can still move the view; <kbd>Esc</kbd> cancels. With a perspective camera already within 3 m of the ground, you start walking where you are. Closing this panel does not stop you: pick Walk again to bring it back.</p>
    <p>On a touch screen, drag on the left half of the view to walk: a thumb stick comes up under your finger, slow near its middle and full speed at its rim, and pushing well past the rim runs. Drag on the right half to look, with both thumbs at once if you like. <b>Exit</b> in this panel stops walking.</p>
    <p><kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> or arrow keys to walk · drag to look · <kbd>Shift</kbd> to run · <kbd>Space</kbd> to jump · hold <kbd>E</kbd> to rise and <kbd>Q</kbd> to sink · wheel to zoom · <kbd>T</kbd> torch · <kbd>Esc</kbd> or another camera to stop</p>
    <p>You climb steps and anything up to 1 m high; higher obstacles block the way and you slide along them. Over a drop you pause for a moment, then fall; a fall with nothing below takes you back to where you last stood. Hidden layers and vegetation are walked through.</p>
    <p><b>Speed</b>: Shift runs at three times it · <b>Collision detection</b> off walks through walls (you still follow the ground) · <b>Fly</b> turns gravity off, lifting you a few metres if you are standing: you hover where <kbd>E</kbd> and <kbd>Q</kbd> leave you, stay level off edges, and <kbd>Space</kbd> does not jump. Whether you are standing in sunlight shows in the Thermal comfort panel (<b>UTCI</b> on the toolbar).</p>` });
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
  $('walkFly').addEventListener('change', () => { S.fly = $('walkFly').checked; if (S.fly) walker.lift(); changed(); canvas.focus(); });
  $('walkHelp').addEventListener('click', showWalkHelp);
  $('walkExit').addEventListener('click', () => { if (walker.active) leaveWalk(); });
  $('walkClose').addEventListener('click', () => { $('walkPanel').hidden = true; canvas.focus(); });
  syncWalkPanel();
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
// UTCI at the camera from the weather file at the Date widget's date and time: air temperature and
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
  $('comfortWhen').value = `${dayName(state.sun.doy)} · ${fmtHour(state.sun.hour)}`;
  $('comfortToggle').setAttribute('aria-expanded', String(C.details));
  $('comfortToggle').querySelector('.caret').classList.toggle('collapsed', !C.details);
  $('comfortDetails').hidden = !C.details;
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
  const cat = utciCategory(r.value), scale = ColourScales.preferred('utci');
  // Each band's cell shows the colour in its middle (the same as all of it, on a grouped scale).
  const cellColour = (c, i) => {
    const before = UTCI_CATEGORIES[i - 1]?.below, mid = Number.isFinite(before) && Number.isFinite(c.below) ? (before + c.below) / 2 : Number.isFinite(before) ? before + 1 : c.below - 1;
    return ColourScales.css(scale, mid);
  };
  $('comfortRead').style.setProperty('--cat', ColourScales.css(scale, r.value));
  // Minimised, the sunlight state (without the radiation) takes the category's place.
  const sunWord = sunHtml.match(/<b>(.*?)<\/b>/)?.[1];
  const sunChip = sunWord ? `<span class="sun-state utci-sun ${sunCls}" data-min-only><span class="dot"></span><span>${sunWord}</span></span>` : '';
  setHtml($('comfortRead'), `<div class="utci-top"><span class="utci-val">${f(r.value)}<small> °C</small></span><span class="utci-cat" data-full>${cat.name}</span>${sunChip}</div>
    <div class="utci-scale">${UTCI_CATEGORIES.map((c, i) => `<span style="background:${cellColour(c, i)}"${c === cat ? ' class="on"' : ''} title="${c.name}"></span>`).join('')}</div>
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
    <p>It is estimated at the camera, at the Date widget's date and time, from the weather file: the air temperature and humidity as they are, and the wind speed times the <b>wind factor</b>. The factor stands in for shelter, which the viewer cannot work out yet: 1 is the open-ground wind of the weather file, lower values are more sheltered. It starts at 0.5, a typical allowance for the shelter of streets and buildings compared with the open site where weather files are recorded (at 10 m, which is the height the UTCI expects). The UTCI was fitted for wind speeds from 0.5 m/s, so slower winds, including calm, are counted as 0.5 m/s.</p>
    <p>The <b>mean radiant temperature</b> is taken to be the air temperature in shade. In sunlight two things are added: the direct sun on the person (the SolarCal method, for a standing person turned side-on to the sun), and the warmth of sunlit ground and walls nearby, a rough allowance of about 10 °C for 600 W/m² of direct sun on the ground. Together they make a sunlit spot about 15 to 27 °C warmer in radiant temperature than a shaded one in summer, in line with field measurements, which typically adds 4 to 7 °C to the UTCI. Surfaces heating up and cooling down over the day, their materials, the sky and reflected light are not counted.</p>
    <p><b>Clouds.</b> By default the sun on the person is the weather file's direct radiation for the hour: an average, which already allows for the cloud that hour by dimming the sun evenly. This is how comfort is normally assessed (hour by hour, as Ladybug does), and it does not change as the drawn clouds pass.</p>
    <p><b>Include simulated clouds</b> counts the cloud over the camera instead, so the UTCI follows the clouds you see: in a gap the sun is as strong as between the clouds that hour, under a cloud it drops to a tenth, which typically moves the UTCI by a few degrees in summer. The clouds themselves are invented: the weather file gives only how much of the sky is cloudy, so where each cloud is, and when one crosses the sun, is a random pattern, not a record. Averaged over time the two ways agree, so use the hourly figure for assessments and the simulated one to show what a passing cloud does. The warmth of sunlit surroundings keeps the hour's average either way, since ground and walls do not cool as a cloud passes. The option needs the sun and the weather switched on, and an hour with some cloud.</p>` });
}

function bindComfortPanel() {
  document.querySelector('[data-act="comfort"]').addEventListener('click', toggleComfortPanel);
  $('comfortClose').addEventListener('click', () => state.comfort.panel && toggleComfortPanel());
  $('comfortHelp').addEventListener('click', showComfortHelp);
  $('comfortToggle').addEventListener('click', () => { state.comfort.details = !state.comfort.details; syncComfortPanel(); });
  $('comfortWind').addEventListener('input', () => { state.comfort.wind = +$('comfortWind').value; syncComfortPanel(); savePrefs(); });
  $('comfortClouds').checked = state.comfort.clouds;
  $('comfortClouds').addEventListener('change', (e) => { state.comfort.clouds = e.target.checked; syncComfortPanel(); savePrefs(); });
  $('comfortRead').addEventListener('click', (e) => { if (e.target.closest('[data-weather]')) openWeatherDialog(); });
  $('comfortSun').addEventListener('click', (e) => { if (e.target.closest('[data-location]')) openLocationDialog(); });
}

// The toolbar's render mode menu: what is drawn, on and off, then the modes. Picking leaves it open,
// to compare. A mode's id is its value of state.mode, and an on/off item's its key in state.
const MODES = [[0, 'Shaded', 'Shaded: object / layer colours'], [2, 'Clay', 'Clay: uniform white'], [1, 'Rendered', 'Rendered: material colours']];
const RENDER_TOGGLES = [
  { id: 'showEdges', label: 'Edges', hint: 'E' },
  { id: 'showCurves', label: 'Curves', hint: 'C', title: 'Curves and points' },
  { id: 'specials', label: 'Magic ✨', title: 'Magic materials: water, glass, vegetation, grass, road, paving and ground looks, set per layer, and a faint natural variation on other surfaces (Rendered view; Clay view shows only the water). Off: plain material colours only.' },
  { id: 'animations', label: 'Animations', title: 'Water ripples and drifting clouds. Off: they stand still, and the view is only redrawn when something changes, which saves the graphics card work on large models.' },
  { id: 'ao', label: 'Ambient occlusion', hint: 'O', title: 'Ambient occlusion: soft shading in corners and recesses' },
  { id: 'xray', label: 'X-ray', hint: 'X' },
];
let modeList = null;

function bindModeMenu() {
  modeList = new ChoiceList({ label: 'Render settings', onPick: (id) => {
    if (id === 'specials') toggleSpecials();
    else if (RENDER_TOGGLES.some((t) => t.id === id)) toggle(id);
    else setMode(+id);
  } });
  modeList.setGroups([{ items: RENDER_TOGGLES.map((t) => ({ ...t, toggle: true })) },
    { items: MODES.map(([id, label, title]) => ({ id: String(id), label, title })) }]);
  new ToolbarMenu($('btnMode'), { label: 'Render mode' }).body.append(modeList.el);
}

function syncModeMenu() {
  const [, name, title] = MODES.find(([id]) => id === state.mode);
  modeList?.setActive(String(state.mode));
  for (const { id } of RENDER_TOGGLES) modeList?.setChecked(id, !!state[id]);
  $('modeName').textContent = name;
  $('btnMode').title = `${title} (M changes it)`;
}

function toggleSpecials() {
  state.specials = !state.specials;
  savePrefs();
  applyLayerMaterials(false);
  if (!$('matDialog').hidden && matLayer >= 0 && matKind === 'material') openMaterialDialog(matLayer, document.querySelector('.layer-row .swatch') || $('matDialog'));
  if (state.sel.ids.length) showInspector();
  syncToolbar();
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
  if (key === 'blocks') {
    $('blocksPanel').hidden = !state.blocks;
    if (!state.blocks) $('blockDialog').hidden = true;
  }
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
  $('demo').hidden = !!list.length; // with nothing to reopen (always, where the list isn't kept), the demo
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

// The demo model built into the page (src/demo.js, from tools/make-demo.js): a small site in
// London with a few blocks and shades, for trying the viewer without a Rhino file.
async function openDemo() {
  showBusy('Opening the demo model', 0.02);
  await openBytes('Demo.3dm', Uint8Array.from(atob(DEMO_3DM), (c) => c.charCodeAt(0)));
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
  $('btnResultsFiles').addEventListener('click', openResultsDialog);
  $('btnMessages').addEventListener('click', openMessages);
  $('btnBack').addEventListener('click', leaveHome);
  $('btnDemo').addEventListener('click', openDemo);
  $('dropBrowse').addEventListener('click', browse);
  // Developer mode: five quick clicks on the logo turn it on, and five more turn it off.
  let logoClicks = 0, logoLast = 0;
  $('dropLogo').addEventListener('click', () => {
    const now = performance.now();
    logoClicks = now - logoLast < 400 ? logoClicks + 1 : 1;
    logoLast = now;
    if (logoClicks < 5) return;
    logoClicks = 0;
    setDevMode(!state.devMode);
  });
  input.addEventListener('change', () => { if (input.files[0]) openFile(input.files[0]); input.value = ''; });

  // Only a drag that carries files shows the drop screen. Any other (text, a link, an image) can
  // still be dropped into a text box, and elsewhere is refused, so a link can't open over the model.
  const drop = $('drop'), hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
  const editable = (e) => e.target instanceof Element && !!e.target.closest('input, textarea, [contenteditable]');
  let depth = 0;
  window.addEventListener('dragenter', (e) => { if (!hasFiles(e)) return; e.preventDefault(); if (++depth === 1) { drop.hidden = false; drop.classList.add('over'); } });
  window.addEventListener('dragleave', (e) => { if (!hasFiles(e) || !depth) return; if (--depth === 0) { drop.classList.remove('over'); if (model && !atHome) drop.hidden = true; } });
  window.addEventListener('dragover', (e) => {
    if (hasFiles(e)) e.preventDefault();
    else if (!editable(e)) { e.preventDefault(); e.dataTransfer.dropEffect = 'none'; }
  });
  window.addEventListener('drop', (e) => {
    if (!hasFiles(e)) { if (!editable(e)) e.preventDefault(); return; }
    e.preventDefault(); depth = 0; drop.classList.remove('over');
    if (model && !atHome) drop.hidden = true;
    const f = e.dataTransfer.files[0];
    if (f && resultParsersFor(f.name).length) { [...e.dataTransfer.files].forEach((x) => openFile(x)); return; }
    // The handle has to be requested before anything else is awaited.
    const h = Recent.supported ? e.dataTransfer.items[0]?.getAsFileSystemHandle?.() : null;
    if (f) Promise.resolve(h).then((handle) => openFile(f, handle?.kind === 'file' ? handle : null), () => openFile(f));
  });

  bindCameraMenu();
  bindModeMenu();
  bindResultsMenu();
  bindStreamlinesPanel();
  bindMapPanel();
  document.querySelectorAll('[data-toggle]').forEach((b) => b.addEventListener('click', () => toggle(b.dataset.toggle)));
  document.querySelectorAll('[data-act="extents"]').forEach((b) => b.addEventListener('click', zoomExtents));
  document.querySelectorAll('[data-act="help"]').forEach((b) => b.addEventListener('click', toggleHelp));
  document.querySelector('[data-act="date"]').addEventListener('click', toggleDatePanel);
  bindCompass();
  $('dateClose').addEventListener('click', () => state.datePanel && toggleDatePanel());
  $('layersClose').addEventListener('click', () => state.layers && toggle('layers'));
  $('layersHelp').addEventListener('click', showLayersHelp);
  bindLayerMenu();
  layerRows.bind($('layerTree'));
  bindBlocksPanel();
  bindSideResize();
  Widgets.init({ showMenu });
  renderRecent();
  $('btnUndo').addEventListener('click', () => stepHistory(false));
  $('btnRedo').addEventListener('click', () => stepHistory(true));
  bindMaterialDialog();
  bindInspector();
  bindFileDialog();
  bindDateWeather();
  // Each widget's title carries its toolbar button's icon.
  for (const [btn, panel] of [['[data-act="date"]', 'datePanel'], ['#weatherQuick', 'weatherPanel'], ['[data-act="comfort"]', 'comfortPanel'],
    ['#lightsQuick', 'lightsPanel'], ['[data-toggle="layers"]', 'layersPanel'], ['[data-toggle="blocks"]', 'blocksPanel'], ['#btnResults', 'streamlinesPanel'], ['#btnResults', 'mapPanel']]) {
    const title = $(panel).querySelector('.panel-head > span');
    title.classList.add('panel-title');
    title.prepend(document.querySelector(`.toolbar ${btn} svg`).cloneNode(true));
  }
  bindLightsPanel();
  bindComfortPanel();
  bindExposurePanel();
  document.querySelectorAll('[data-layers]').forEach((b) => b.addEventListener('click', () => {
    if (!model) return;
    layerOn = model.layers.map(() => b.dataset.layers === 'all');
    applyLayerVisibility();
    buildLayerTree.refresh?.();
  }));
  window.addEventListener('keydown', onKey);
  const setShift = (on) => { if (shiftDown !== on) { shiftDown = on; syncWalkPanel(); } };
  window.addEventListener('keydown', (e) => { if (e.key === 'Shift') setShift(true); });
  window.addEventListener('keyup', (e) => { if (e.key === 'Shift') setShift(false); walker.key(e, false); driver.key(e, false); });
  window.addEventListener('blur', () => { setShift(false); walker.blur(); driver.blur(); });
  bindWalkPanel();
  bindDrivePanel();
  bindPointer();
  window.addEventListener('pagehide', saveViewState);
  document.addEventListener('visibilitychange', () => { if (document.hidden) saveViewState(); });
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
// error: true for an error, 'info' for news that needs no action.
function notice(text, error = false, timeout = 0, action = null) {
  const n = document.createElement('div');
  const kind = (error === 'info' ? ' info' : error ? ' error' : '') + (timeout ? ' brief' : '');
  n.className = 'notice' + kind;
  const message = saveMessage({ text, kind, action, time: new Date(), toast: n });
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
    a.onclick = () => { dismissMessage(message); action.run(); };
    n.append(' ', a);
  }
  const x = document.createElement('button');
  x.className = 'x'; x.textContent = '×'; x.setAttribute('aria-label', 'Dismiss');
  x.onclick = () => n.remove();
  n.appendChild(x);
  $('notices').appendChild(n);
  return n;
}
function clearNotices() {
  $('notices').innerHTML = '';
  messages.length = 0;
  syncMessages();
}

// The bell's window keeps every notice about the open model, after it has left the screen, until
// it is dismissed there or another model loads. A notice repeated moves to the top instead of
// appearing twice.
const messages = []; // oldest first
let messagesDialog = null;

function saveMessage(message) {
  const same = messages.find((m) => m.text === message.text);
  if (same) dismissMessage(same);
  messages.push(message);
  syncMessages();
  return message;
}

function dismissMessage(message) {
  const i = messages.indexOf(message);
  if (i >= 0) messages.splice(i, 1);
  message.toast.remove();
  syncMessages();
}

function syncMessages() {
  const n = messages.length;
  $('msgCount').hidden = !n;
  $('msgCount').textContent = n > 99 ? '99+' : n;
  $('btnMessages').title = !n ? 'No messages' : n === 1 ? '1 message' : `${n} messages`;
  if (messagesDialog) renderMessages();
}

function renderMessages() {
  const d = messagesDialog, close = d.box.querySelector('.dlg-actions .primary');
  d.box.querySelector('.dlg-actions .btn').hidden = !messages.length; // Dismiss all
  if (!messages.length) {
    const none = document.createElement('p');
    none.textContent = 'No messages.';
    d.body.replaceChildren(none);
  } else {
    const list = document.createElement('div');
    list.className = 'msg-list';
    messages.slice().reverse().forEach((m, i) => {
      const row = document.createElement('div');
      row.className = 'notice' + m.kind;
      const time = document.createElement('span');
      time.className = 'msg-time';
      time.textContent = m.time.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      row.append(time, m.text);
      if (m.action) {
        const a = document.createElement('button');
        a.className = 'link'; a.textContent = m.action.label;
        a.onclick = () => { d.close(null); dismissMessage(m); m.action.run(); };
        row.append(' ', a);
      }
      const x = document.createElement('button');
      x.className = 'x'; x.textContent = '×'; x.setAttribute('aria-label', 'Dismiss');
      x.onclick = () => { dismissMessage(m); d.body.querySelectorAll('.x')[i]?.focus(); };
      row.append(x);
      list.append(row);
    });
    d.body.replaceChildren(list);
  }
  if (!d.box.contains(document.activeElement)) close.focus();
}

function openMessages() {
  if (messagesDialog) return;
  messagesDialog = new Dialog({ title: 'Messages', width: 440, buttons: [{ label: 'Dismiss all', value: 'all' }, { label: 'Close', value: true, primary: true }] });
  renderMessages();
  messagesDialog.result.then((v) => {
    messagesDialog = null;
    if (v === 'all') messages.slice().forEach(dismissMessage);
  });
}

function fatal(title, text) {
  $('drop').hidden = true;
  $('fatal').hidden = false;
  $('fatalTitle').textContent = title;
  $('fatalText').textContent = text;
}

boot();
