// App wiring: file loading, input handling, layer panel and toolbar.

const $ = (id) => document.getElementById(id);
const canvas = $('gfx');

// What is kept where:
//   This machine (localStorage), for every project: the preferences below (render options, walk and drive,
//   comfort, colour scales, cloud speed, panel width, date and time controls), the dates and times added to
//   the date and time sliders, and the widget layout (widgets.js).
//   The project (recent.js, and project.json in a project zip): its files and which are active, its location
//   and weather choices, its weather and results files, and the changes made to its model and how it is
//   viewed (readStored). Lamps added in the viewer are not kept.
const prefs = (() => { try { return JSON.parse(localStorage.getItem('3dm-viewer') || '{}'); } catch (e) { return {}; } })();
const savePrefs = () => { try { localStorage.setItem('3dm-viewer', JSON.stringify({ mode: state.mode, showEdges: state.showEdges, showCurves: state.showCurves, ao: state.ao, specials: state.specials, animations: state.animations, walk: walker.settings, drive: driver.settings, comfortWind: state.comfort.wind, comfortClouds: state.comfort.clouds, colourScales: ColourScales.choices, cloudSpeed: clouds.speed, sideWidth: state.sideWidth, dateMode: state.dateMode, timeMode: state.timeMode })); } catch (e) { /* storage unavailable */ } };

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
  datePanel: false, timePanel: false,
  // The Date and Time widgets show a slider, or a picker (a calendar, a clock face).
  dateMode: prefs.dateMode === 'picker' ? 'picker' : 'slider', timeMode: prefs.timeMode === 'picker' ? 'picker' : 'slider',
  weatherPanel: false,
  weatherOn: true,  // the Weather widget's switch: off, none of its View items show, whatever is ticked
  // The View items, as ticked under Weather in the render mode menu. Each also needs a location or a weather file
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
// The site location of the open model: a typed custom location, a city, the attached weather files
// (epws: EPW objects, each with an id and its bytes), the one used as weather data source (epw), and
// which location source to use (use: 'custom', 'city', 'file', 'epw:<id>', or null for the first that is set).
const site = { custom: null, city: null, epws: [], epw: null, use: null };
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
  onExit: () => { if (stick) endStick(); $('walkHint').hidden = true; $('walkPanel').hidden = true; endPlacing(); if (driver.parked) driver.exit(); if (walkFrom) { camera.restore(walkFrom); walkFrom = null; } syncToolbar(); syncWalkPanel(); syncLightsPanel(); redraw(); },
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
  splash: () => { const s = $('driveSplash'); s.hidden = false; s.classList.remove('go'); void s.offsetWidth; s.classList.add('go'); },
  side: () => (drivesOnLeft() ? -1 : 1),
});
driver.settings.collide = true;
// Whether traffic keeps left in the site's country, so the car is right-hand drive. The country
// is the last part of the location's name ("Tokyo, Japan": a listed city, or a weather file's);
// with only a latitude and longitude, the car is left-hand drive.
const LEFT_DRIVING = new Set(['United Kingdom', 'Ireland', 'Japan', 'Australia', 'New Zealand', 'India', 'Indonesia', 'Malaysia', 'Singapore',
  'South Africa', 'Kenya', 'Thailand', 'Hong Kong', 'Pakistan', 'Bangladesh', 'Sri Lanka', 'Cyprus', 'Malta', 'Jamaica', 'Tanzania', 'Uganda',
  'Zambia', 'Zimbabwe', 'Botswana', 'Namibia', 'Mozambique', 'Mauritius', 'Nepal', 'Brunei', 'Macau', 'Fiji', 'Trinidad and Tobago', 'Bahamas', 'Barbados', 'Guyana']);
function drivesOnLeft() {
  const name = activeLocation()?.name;
  return !!name && name.includes(',') && LEFT_DRIVING.has(name.split(',').pop().trim());
}
if (prefs.drive) {
  const D = driver.settings, P = prefs.drive;
  D.shadows = P.shadows !== false;
  D.collide = P.collide !== false;
  if (P.cam >= 0 && P.cam < DRIVE_CAMS.length) D.cam = P.cam;
  D.headlights = P.headlights === true;
  D.sound = P.sound !== false;
  D.music = P.music !== false;
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
// base64. Running from src/, the 32-bit reader comes from its script tag and the 64-bit one is
// fetched from vendor/ when first needed, in its own scope, as its loader also defines `rhino3dm`.
function getRhino(kind) {
  return (rhinoModules[kind] ||= (async () => {
    if (typeof RHINO3DM_WASM !== 'object') {
      if (kind === 'w32') return rhino3dm();
      const dir = '../vendor/package/wasm64/';
      const [js, wasm] = await Promise.all([fetch(dir + 'rhino3dm.min.js').then((r) => r.text()), fetch(dir + 'rhino3dm.wasm').then((r) => r.arrayBuffer())]);
      return new Function(`${js}\nreturn rhino3dm;`)()({ wasmBinary: new Uint8Array(wasm) });
    }
    const bin = atob(RHINO3DM_WASM[kind]), bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return RHINO3DM_FACTORIES[kind]({ wasmBinary: bytes });
  })());
}
const can64 = () => HAS_MEMORY64;

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
  // The page opens on a blank project, with the projects menu open to start from.
  if (!model) projectsMenu.open();
}

function onResize() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = Math.max(1, Math.round(canvas.clientWidth * dpr)), h = Math.max(1, Math.round(canvas.clientHeight * dpr));
  renderer.resize(w, h);
  camera.aspect = w / h;
  redraw();
}

function redraw() { if (renderer) renderer.dirty = true; lastInput = performance.now(); thumb.due = true; }

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

// Clouds: the weather file's sky at the Date and Time widgets' date and time, and how far the clouds have
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

// The View items, under Weather in the render mode menu: what each needs, and what each is.
const VIEW_ITEMS = ['sun', 'sky', 'clouds', 'haze', 'path'];
const VIEW_LABELS = { sun: 'Sun', sky: 'Sky', clouds: 'Clouds', haze: 'Haze', path: 'Sun path diagram' };
const VIEW_NEEDS = { sun: 'location', sky: 'location', clouds: 'epw', haze: 'epw', path: 'location' };
const VIEW_TITLES = {
  sun: 'Sunlight and shadows at the Date and Time widgets\' date and time, and the moon\'s at night',
  sky: 'The sky behind the model. Off: a plain white background, for screenshots. The light on the model is the same either way',
  clouds: 'The weather file\'s clouds, drifting with its wind. They show in the sky, and cast shadows with the Sun on',
  haze: 'The weather file\'s haze: dims the sun beyond what the clouds account for, and sets how bright the sky\'s light is, from its radiation',
  path: 'The sun\'s path on the sky: the 21st of each month, each clock hour through the year, and in yellow the Date widget\'s date',
};

// Why a View item cannot show, or null if it can: it needs a location or a weather file, the
// widget's switch on, and (the sun path) a perspective view.
const viewHasData = (item) => (VIEW_NEEDS[item] === 'epw' ? !!site.epw : !!activeLocation());
function viewWhyNot(item) {
  if (!viewHasData(item)) return VIEW_NEEDS[item] === 'epw' ? 'Needs a weather file (EPW)' : 'Needs a location';
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
    if (!walker.pending && driver.touches(walker.pos, walker.foot, 0.3)) enterVehicle();
  }
  if (driver.active) {
    driver.update(performance.now());
    renderer.dirty = true; lastInput = performance.now();
    syncDriveSpeed();
  }
  diag.ticks++;
  // The project's thumbnail is taken once the view has settled after a change (see redraw).
  if (thumb.due && now - lastInput > THUMB_SETTLE && canThumb()) { thumb.due = false; thumb.take = true; renderer.dirty = true; }
  if (renderer.dirty) {
    anim.drawn = now;
    renderer.dirty = false;
    const t = performance.now();
    renderer.draw(frameState());
    if (thumb.take) { thumb.take = false; captureThumb(); } // the frame can only be read before this task ends
    if (state.devMode) diagFrame(t);
    positionInspector(); syncCompass();
    if (state.comfort.panel) checkSunlight();
  }
  requestAnimationFrame(loop);
}

// Thumbnails: a small picture of a project's view for the projects list, taken from the orbit view as the user
// left it (nothing is turned on or off for it). Not taken while walking or driving, so the last orbit view stays.
const THUMB_SETTLE = 1500, THUMB_W = 240, THUMB_H = 150; // ms of quiet before one is taken; its size in pixels
const thumb = { due: false, take: false };
const canThumb = () => !!(renderer && model?.projectId && !moving() && !choosingStart());
function captureThumb() {
  const id = model?.projectId;
  if (!id || !canvas.width || !canvas.height) return;
  const c = document.createElement('canvas');
  c.width = THUMB_W; c.height = THUMB_H;
  // The middle of the view, cropped to the thumbnail's shape.
  const s = Math.max(THUMB_W / canvas.width, THUMB_H / canvas.height), w = canvas.width * s, h = canvas.height * s;
  c.getContext('2d').drawImage(canvas, (THUMB_W - w) / 2, (THUMB_H - h) / 2, w, h);
  return new Promise((resolve) => c.toBlob((b) => {
    if (b) Recent.saveThumb(id, b).then(renderRecent);
    resolve(b);
  }, 'image/webp', 0.8));
}
// Before a project is put away, or saved as a zip: a frame drawn and taken now. Resolves to the picture, or null.
function thumbNow() {
  if (!canThumb()) return Promise.resolve(null);
  renderer.draw(frameState());
  return captureThumb();
}

// ---------------------------------------------------------------------------------------------
// Loading

// handle: the file's FileSystemFileHandle, when there is one, for the recent files list.
async function openFile(file, handle = null) {
  if (/\.epw$/i.test(file.name)) { attachEpw(file); return; }
  if (resultParsersFor(file.name).length) { addResultsFile(file); return; }
  if (!/\.3dm$/i.test(file.name)) { notice(`${file.name} is not a .3dm, .epw or results file.`, true); return; }
  showBusy(`Reading ${file.name}`, 0.02);
  try {
    // A file with a handle opens its project: the file's own, new or the one it belongs to, with all its files.
    const ids = await Recent.add(handle, file);
    renderRecent();
    if (ids) { await showProject(ids.project, { file, fileId: ids.file }); return; }
    await openBytes(file.name, new Uint8Array(await file.arrayBuffer()), null);
    attachDialog?.refresh();
  } catch (e) {
    // Errors here used to leave the welcome screen up with nothing said: say what went wrong.
    console.error(e);
    hideBusy();
    notice(`Could not open ${file.name}: ${e.message || e}`, true);
  }
}

// A 3dm file attached to the open model (from the Attach files dialog, or dropped on the viewer): it joins
// the model's project and is added to the view. With no project open, it opens as a new one.
async function attachRhinoFile(file, handle) {
  await attachRhinoFiles([{ file, handle }]);
}

// Several Rhino files attached at once: the view is shown again once, with all of them.
async function attachRhinoFiles(entries) {
  const projectId = model?.projectId;
  if (!model) { await openEntries(entries); return; } // a blank project: they start it
  const withHandle = entries.filter((e) => e.handle);
  if (!projectId || !withHandle.length) { for (const { file, handle } of entries) await openFile(file, handle); return; }
  for (const { file, handle } of withHandle) await Recent.attach(projectId, handle, file);
  renderRecent();
  await showProject(projectId);
  attachDialog?.refresh();
}

// The custom location, city, weather files and choice of location linked to a model come back with it.
// Returns what came back, for a notice.
async function restoreLinks(projectId) {
  const { custom, city, epws, weather, use, results: bound } = await Recent.links(projectId), back = [];
  const inRange = (p) => Math.abs(p.lat) <= 90 && Math.abs(p.lon) <= 180 && Math.abs(p.utcOffset) <= 14;
  if (custom && inRange(custom)) { site.custom = { lat: +custom.lat, lon: +custom.lon, utcOffset: +custom.utcOffset, name: null }; back.push(`custom location ${fmtCoords(custom.lat, custom.lon)}`); }
  if (city && inRange(city)) { site.city = { lat: +city.lat, lon: +city.lon, utcOffset: +city.utcOffset, name: typeof city.name === 'string' ? city.name : null }; back.push(`city ${site.city.name || fmtCoords(city.lat, city.lon)}`); }
  for (const d of epws) {
    try { const e = EPW.fromBytes(d.bytes, d.name); Object.assign(e, { id: d.id, bytes: d.bytes, off: !!d.off }); site.epws.push(e); }
    catch (err) { notice(`Could not read ${d.name}, a weather file linked to this model: ${err.message}`, true); }
  }
  if (site.epws.length) back.push(site.epws.length === 1 ? `weather file ${site.epws[0].fileName}` : `${site.epws.length} weather files`);
  site.epw = site.epws.find((e) => e.id === weather && !e.off) ?? null;
  if (['custom', 'city', 'file'].includes(use) || use?.startsWith('file:') || (use?.startsWith('epw:') && epwById(use.slice(4)))) site.use = use;
  for (const r of bound) {
    try {
      const bytes = await Recent.resultBytes(r.id);
      if (bytes) results.push({ ...r, parser: null, data: null, ...parseResultsFile(bytes, r.name) });
    } catch (e) { results.push({ ...r, parser: null, data: null }); notice(`Could not read ${r.name}, a results file linked to this model: ${e.message}`, true); }
  }
  if (results.length) back.push(results.length === 1 ? `results file ${results[0].name}` : `${results.length} results files`);
  return back;
}

// One file read. full: a file on its own, with its batches built; otherwise a part of a scene (see openScene).
// units: the scene's unit system; the file's geometry is scaled into it (a file in millimetres shown with
// one in metres comes out right). Without units, the file's own.
async function readModel(kind, name, bytes, origin = null, full = true, units = null) {
  showBusy('Starting the Rhino file reader', 0.04);
  const rhino = await getRhino(kind);
  showBusy(`Parsing ${name} (${(bytes.length / 1e6).toFixed(0)} MB)`, 0.06);
  await new Promise((r) => setTimeout(r, 20));
  const doc = rhino.File3dm.fromByteArray(bytes);
  if (!doc) throw new Error('The file could not be read. It may be damaged or not a Rhino model.');
  const progress = (f, text) => showBusy(text, 0.08 + f * 0.82);
  const scale = units ? (METRES_PER_UNIT[enumName(doc.settings().modelUnitSystem)] || 1) / (METRES_PER_UNIT[units] || 1) : 1;
  try {
    return full ? await extractModel(rhino, doc, progress, origin, scale) : await extractScene(rhino, doc, progress, origin, scale);
  } finally {
    doc.delete();
  }
}

// Reads a file with the reader its size calls for. The 32-bit reader aborts when it runs out of address
// space; then the file is read again with the 64-bit one.
async function readWithReader(name, bytes, origin, full, units = null) {
  const first = can64() && bytes.length > BIG_FILE ? 'w64' : 'w32';
  try {
    return { m: await readModel(first, name, bytes, origin, full, units), reader: first };
  } catch (e) {
    if (first !== 'w32' || !can64() || !(e instanceof WebAssembly.RuntimeError)) throw e;
    delete rhinoModules.w32;
    return { m: await readModel('w64', name, bytes, origin, full, units), reader: 'w64' };
  }
}

// handle: the file's handle when it was opened from the user's files (see openFile).
async function openBytes(name, bytes, handle = null) {
  return openScene([{ name, bytes, handle }]);
}

// The Rhino files shown together as one model: sources = [{ name, bytes, handle }]. The first file's
// origin is used for all, so they line up as they do in Rhino. handle: the first file's, which
// holds the model's settings (see Recent).
async function openScene(sources, opts = {}) {
  const t0 = performance.now(), [first] = sources, handle = first.handle ?? null;
  const name = sources.map((s) => s.name).join(' + ');
  walker.exit();
  driver.exit();
  thumbNow(); // the project being put away
  saveViewState();
  clearNotices();
  try {
    let m, reader;
    // In a project, ids carry the project file's id (see mergeScenes), so its saved settings still find them
    // when files are added or turned off; so even one file goes through the merge.
    if (sources.length === 1 && !opts.projectId) {
      ({ m, reader } = await readWithReader(first.name, first.bytes, null, true));
    } else {
      const parts = [];
      for (const s of sources) {
        const r = await readWithReader(s.name, s.bytes, parts[0]?.origin ?? null, false, parts[0]?.units ?? null);
        parts.push(r.m);
        reader ??= r.reader;
      }
      m = mergeScenes(parts, sources.map((s) => s.name.replace(/\.3dm$/i, '')), opts.projectId ? sources.map((s) => s.key) : null);
      showBusy('Building batches', 0.9);
      await new Promise((r) => setTimeout(r, 20));
      m.batches = buildBatches(m);
    }
    m.reader = reader;
    model = m;
    model.projectId = opts.projectId ?? null; // the project the model is open in, if any
    model.stored = opts.stored ?? {};        // its saved changes and view (see readStored)
    layerOn = m.layers.map((l) => l.visible); // before anything reads layer state for the new model
    state.blockOff = new Set();
    model.name = name;
    model.size = sources.reduce((n, s) => n + s.bytes.length, 0);
    model.bytes = sources.length === 1 ? first.bytes : null; // kept so a copy with the viewer's changes can be written
    model.handle = handle;
    model.locations ??= [{ name: first.name, location: m.location }]; // a scene of several files has one per file
    model.sources = sources.map(({ name, handle, key, zip, entry }) => ({ name, handle, key, zip, entry })); // for a combined copy (exportCombined)
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
    bumpModel('objects');
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
    Object.assign(site, { custom: null, city: null, epws: [], epw: null, use: null }); // never carried over to another model
    results = [];
    const back = opts.projectId ? await restoreLinks(opts.projectId) : [];
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
    $('drop').hidden = true;
    // A model opened without a project (the demo, a file this browser cannot keep a handle for) is a project of
    // its own for now, not kept in the list; showProject names the project when there is one.
    if (!opts.projectId) current = { id: Recent.newId(), name, blank: false };
    showProjectName();
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
  // Total object count including sub-layers; empty branches are hidden (objects can move between
  // layers, so every layer has a row and the counts are worked out again on refresh).
  const total = L.map(() => 0);
  const sum = (i) => (total[i] = L[i].count + kids[i].reduce((s, k) => s + sum(k), 0));
  const collapsed = new Set();
  tree.innerHTML = '';
  const caretSvg = '<svg viewBox="0 0 24 24"><path d="m6 9 6 6 6-6"/></svg>';
  const rows = [];
  const add = (i, depth) => {
    const l = L[i], row = document.createElement('div');
    row.className = 'layer-row';
    row.setAttribute('role', 'treeitem');
    row.style.paddingLeft = 10 + depth * 16 + 'px';
    row.innerHTML = `<button class="caret" aria-label="Expand">${caretSvg}</button>` +
      `<input type="checkbox" class="eye" aria-label="Show this layer" title="Show or hide (Shift-click: isolate)"><span class="swatch"></span>` +
      `<span class="layer-name"></span><span class="layer-special" hidden></span><span class="layer-count"></span>`;
    row.querySelector('.layer-name').textContent = l.name;
    row.title = l.fullPath;
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
    row.addEventListener('dblclick', (e) => { if (!e.target.closest('input, button')) openMaterialDialog(layerRows.take(i), row); });
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
    roots.forEach(sum);
    // The top-level layers line up with the blocks: with no sub-layers (with objects) the carets
    // take no room, and with them the blocks leave the same room.
    const flat = !rows.some(({ i }) => total[i] && kids[i].some((k) => total[k]));
    tree.classList.toggle('flat', flat);
    $('blockList').classList.toggle('carets', !flat);
    const filter = $('layerFilter').value.trim().toLowerCase(), match = new Set();
    if (filter) for (const { i } of rows) if (total[i] && L[i].name.toLowerCase().includes(filter)) for (let a = i; a >= 0 && !match.has(a); a = L[a].parent) match.add(a);
    for (const { i, row, cb } of rows) {
      cb.checked = layerOn[i];
      row.classList.toggle('off', !layerOn[i]);
      row.classList.toggle('inherited-off', layerOn[i] && !layerEffective(i));
      row.hidden = !total[i] || (filter ? !match.has(i) : hiddenByCollapse(i));
      row.querySelector('.caret').classList.toggle('collapsed', collapsed.has(i));
      row.querySelector('.caret').classList.toggle('empty', !kids[i].some((k) => total[k]));
      row.querySelector('.layer-count').textContent = total[i].toLocaleString();
      const sw = row.querySelector('.swatch'), isMat = showsMaterial(), id = model.layers[i].id;
      sw.style.background = isMat ? lookBackground(layerLook(i)) : rgbHex(layerDisplayRgb(i));
      // Ring: set in the viewer ("Always off" alone does not count).
      sw.classList.toggle('edited', isMat ? !!state.layerMat[id] || !!state.layerSpecial[id] : !!state.layerColor[id]);
      sw.title = isMat ? 'Material for this layer (Rendered view): double-click or right-click the row to edit' : 'Display colour for this layer (Shaded view): double-click or right-click the row to edit';
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
  buildLayerTree.row = (i) => rows.find((x) => x.i === i)?.row;
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
  // Move the selection here: one layer of the file's own (not one made for magic blocks).
  const target = picked.length === 1 && !L[picked[0]].magic ? picked[0] : -1;
  const moving = target < 0 ? 0 : state.sel.ids.filter((id) => model.objects[id].ai.layer !== target).length;
  showMenu(picked.length > 1 ? `${picked.length} layers` : L[picked[0]].fullPath, [
    { label: 'Select objects', n: own.length, run: () => selectObjects(own) },
    tree && { label: 'Select sublayer objects', n: all.length, run: () => selectObjects(all) },
    target >= 0 && { label: 'Move selection to this layer', n: moving, run: () => moveSelectionToLayer(target) },
    '-',
    { label: showsMaterial() ? 'Edit material' : 'Edit colour', run: () => openMaterialDialog(picked, buildLayerTree.row?.(picked[0]) || $('layersPanel')) },
  ].filter(Boolean), [x, y]);
}

// A right-click menu at (x, y): items are { label, n (a count shown on the right; 0 disables
// the item), run } or '-' for a divider.
// add: an optional button at the right of the title ({ label, title, disabled, run }), which
// leaves the menu open. An item with remove gets a small cross at the right of its row, likewise.
function showMenu(titleText, items, [x, y], { add } = {}) {
  const menu = $('layerMenu');
  menu.innerHTML = '';
  const title = document.createElement('div');
  title.className = 'menu-title';
  title.innerHTML = '<span></span>';
  title.firstChild.textContent = title.firstChild.title = titleText;
  if (add) {
    const b = document.createElement('button');
    b.className = 'menu-side';
    b.textContent = add.label;
    b.title = add.title;
    b.setAttribute('aria-label', add.title);
    b.disabled = !!add.disabled;
    b.addEventListener('click', add.run);
    title.appendChild(b);
  }
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
    if (!it.remove) { menu.appendChild(b); continue; }
    const row = document.createElement('div'), cross = document.createElement('button');
    row.className = 'menu-row';
    cross.className = 'menu-side';
    cross.textContent = '×';
    cross.title = `Remove ${it.label} from this list`;
    cross.setAttribute('aria-label', cross.title);
    cross.addEventListener('click', it.remove);
    row.append(b, cross);
    menu.appendChild(row);
  }
  menu.hidden = false;
  const w = menu.offsetWidth, h = menu.offsetHeight;
  menu.style.transform = `translate(${Math.max(8, Math.min(x, innerWidth - w - 8))}px, ${Math.max(8, Math.min(y, innerHeight - h - 8))}px)`;
  menu.querySelector('button:not(:disabled)')?.focus();
}

function closeLayerMenu() { $('layerMenu').hidden = true; }

const ROW_SELECT_HELP = (rows) => `<p><b>Selecting:</b> click a row to select it · <kbd>Ctrl</kbd>-click to add or remove a row · <kbd>Shift</kbd>-click to select a run of rows. An eye or right-click on a selected row acts on all the selected ${rows}.</p>`;
// The keys a row list takes once clicked (see rowListKeys); other keys still reach the model.
const ROW_KEYS_HELP = (rows, enter) => `<p><b>Keys</b>, once you click in the widget (its title is underlined): <kbd>Ctrl</kbd>+<kbd>A</kbd> select all the ${rows} · <kbd>↑</kbd> <kbd>↓</kbd> move the selection (<kbd>Shift</kbd> to extend it) · <kbd>Space</kbd> show or hide the selected ${rows} · <kbd>Enter</kbd> ${enter} · <kbd>Esc</kbd> clear the selection. Other keys, such as <kbd>F</kbd> or <kbd>Ctrl</kbd>+<kbd>Z</kbd>, work as usual; click in the view to give <kbd>Ctrl</kbd>+<kbd>A</kbd> back to the model.</p>`;

function showLayersHelp() {
  Dialog.open({ title: 'Layers', html: true, width: 420, body: `<p>The eye shows or hides a layer and its sub-layers. <kbd>Shift</kbd>-click an eye to isolate that layer.</p>
    <p>The square shows the layer's colour or material. Double-click the row, or right-click it for <b>Edit colour</b> or <b>Edit material</b>, to set the layer's display colour in Shaded view, and its material and magic material in Rendered view. These reach objects whose source is “By layer”.</p>
    ${ROW_SELECT_HELP('layers')}
    <p><b>Right-click</b> to select the visible objects on a layer or its sub-layers, move the selected objects onto it, or edit its colour or material.</p>
    ${ROW_KEYS_HELP('layers', 'edit their colour or material')}` });
}

function showBlocksHelp() {
  Dialog.open({ title: 'Blocks', html: true, width: 420, body: `<p>Every block with an instance in the model, including those only used inside other blocks. The number is its copies in the model: a sub-block used 3 times in a block placed 10 times has 30.</p>
    <p>The eye hides every copy of a block. A copy shows only if it and every block around it are shown. A row is dimmed when none of its copies can show because of the blocks around it. <b>Unhide all</b> doesn't turn blocks back on.</p>
    <p>The tag is the block's sub-element setting: where the objects inside it get their colour and material. Click it, or double-click the row, to change it. It applies to every instance of the block, and doesn't reach its sub-blocks unless you apply it to them.</p>
    <p>The same window can choose a <b>magic block</b>: geometry from the viewer's library that replaces every instance of the block, sized to its height. A tree stands on the visible ground below the block's centre, or at the bottom of the block if there is none. The tag then reads "magic". Saving a copy of the .3dm places the magic block in place of those instances, and leaves the block definitions as they were.</p>
    ${ROW_SELECT_HELP('blocks')}
    <p>Clicking a tag on a selected row sets all the selected blocks.</p>
    <p><b>Right-click</b> to select a block's instances in the view, add its sub-blocks to the selected rows, or change its setting.</p>
    ${ROW_KEYS_HELP('blocks', 'open their setting')}` });
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
// An open layer window follows the selected layers (clearing the selection leaves it as it is).
layerRows.onChange = () => { const picked = layerRows.list(); if (matOpen() && picked.length) openMaterialDialog(picked); };
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
    row.innerHTML = `<input type="checkbox" class="eye" aria-label="Show this block" title="Show or hide every copy"><span class="layer-name"></span><button class="layer-special block-tag"></button><span class="layer-count">${b.copies.toLocaleString()}</span>`;
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
// layer. state.objEdits: object key -> changed attributes ({ cs, oc, ms, mi, layer }, see resolveLook
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

// Where a model's changes and view are kept: in its project when it has one (so they go with the project into a
// zip), otherwise in this browser under the file's name and size. kind: 'edits' or 'view'.
function readStored(kind) {
  if (model?.projectId) return model.stored?.[kind] ?? null;
  try { return JSON.parse(localStorage.getItem(kind === 'edits' ? editsKey() : viewKey()) || 'null'); } catch (e) { return null; }
}
function writeStored(kind, value) {
  if (model?.projectId) {
    model.stored = { ...model.stored, [kind]: value };
    queueStore(model.projectId, model.stored); // autosaved as it changes
    return;
  }
  const key = kind === 'edits' ? editsKey() : viewKey();
  if (value == null) localStorage.removeItem(key); else localStorage.setItem(key, JSON.stringify(value));
}
let storePending = null, storeTimer = 0;
function queueStore(projectId, stored) {
  if (storePending && storePending.projectId !== projectId) flushStore(); // another project's save is written, not dropped
  storePending = { projectId, stored };
  clearTimeout(storeTimer);
  storeTimer = setTimeout(flushStore, 300);
}
// Writes the save that is waiting, if any. Resolves once it is written.
function flushStore() {
  clearTimeout(storeTimer);
  const p = storePending;
  storePending = null;
  return p ? Recent.saveState(p.projectId, p.stored) : Promise.resolve();
}
addEventListener('pagehide', flushStore);

function saveEdits() {
  if (!model) return;
  const n = editCount(), north = state.sun.north;
  try {
    if (!model.projectId) localStorage.removeItem(oldMaterialsKey());
    if (n.mat + n.col + n.obj + n.blocks + n.magic || north !== fileNorth()) {
      const { layerMat, layerColor, layerSpecial, objEdits, blockSub, blockMagic } = state;
      writeStored('edits', { layerMat, layerColor, layerSpecial, objEdits, blockSub, blockMagic, north });
    } else writeStored('edits', null);
  } catch (e) { /* storage unavailable: changes last for this session only */ }
}

// Push layer colours and materials to the renderer (no rebuild needed).
function applyLayerMaterials(save = true) {
  if (!model) return;
  bumpModel('appearance');
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
    bumpModel('objects');
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
  bumpModel('objects');
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
// Model versions, for analyses. An analysis keeps the key of what its results were worked out
// from and compares it with modelKey(...) (see checkAnalysis), so a change made anywhere reaches
// every analysis without each one listing the ways the model can change.
//
//   objects:    which objects there are, where they are and their layers: any rebuild of the batches
//               (object edits, blocks, magic blocks, undo, Revert) and the hidden objects and blocks.
//   appearance: layer and object colours and materials.
//   visibility: which layers are on.
//   site:       the location and north angle.
// objects and appearance are counters that go up on any change, so undoing back to where results
// were made also marks them out of date: a needless run, never a missed change. visibility and
// site are their own values.

const modelVersion = { objects: 0, appearance: 0 };
const bumpModel = (part) => { modelVersion[part]++; };
const MODEL_PARTS = {
  objects: () => modelVersion.objects,
  appearance: () => modelVersion.appearance,
  visibility: () => layerOn.map(Number).join(''),
  site: () => { const S = state.sun; return [S.lat, S.lon, S.utcOffset, S.north].join(); },
};
const modelKey = (...parts) => parts.map((p) => MODEL_PARTS[p]()).join('|');

// Each frame, for an analysis with results: whether they still match their settings (key, from
// modelKey and the analysis's own settings, or null for nothing to work out), and if not, a new
// run after a pause (so dragging a slider runs once) or, without auto, a note that the results
// are out of date. a holds the state: auto, stale, timer, and the keys of the results shown
// (doneKey), the run going on (runKey), one waiting (pendingKey) and one stopped (stoppedKey).
// run() starts a run; sync() shows a change of stale.
function checkAnalysis(a, key, run, sync) {
  // Settings changed and changed back: the results shown are up to date again.
  if (key && key === a.doneKey && a.stale && !a.runKey) { a.stale = false; sync(); }
  if (!key || key === a.doneKey || key === a.runKey || key === a.pendingKey) return;
  if (!a.auto || key === a.stoppedKey) {
    if (!a.stale) { a.stale = true; sync(); }
    return;
  }
  a.pendingKey = key;
  clearTimeout(a.timer);
  a.timer = setTimeout(run, 150);
}

// ---------------------------------------------------------------------------------------------
// Undo and redo, as in Rhino: changes to the model (layer colours, materials and magic materials,
// object colour and material sources and layers, the north angle, Revert) can be undone. View
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
  refreshMaterialDialog();
  afterBlockChange();
  pushObjectFlags();
}

// Restore the changes remembered for this model. Returns true if objects changed (the batches
// then need rebuilding).
function loadEdits() {
  let e = readStored('edits');
  if (!e && !model.projectId) try { const old = JSON.parse(localStorage.getItem(oldMaterialsKey()) || 'null'); if (old) e = { layerMat: old }; } catch (err) { /* none */ }
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
  for (const d of Object.values(e.objEdits || {})) {
    if (d.ms === 2) d.ms = 3;
    // A move to a layer this file doesn't have (or one made for magic blocks) is dropped.
    if (d.layer !== undefined && !(Number.isInteger(d.layer) && model.layers[d.layer] && !model.layers[d.layer].magic)) delete d.layer;
  }
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
  return readStored('view') || {};
}

function saveViewState() {
  if (!model?.viewReady) return; // not until what was saved has been restored
  const layers = {};
  model.layers.forEach((l, i) => { if (layerOn[i] !== l.visible) layers[l.id] = layerOn[i]; });
  const now = walkFrom || camera.snapshot(); // walking saves the camera it will go back to
  try {
    writeStored('view', { layers, hidden: [...state.hidden].map((i) => model.objects[i].id), blocks: [...state.blockOff], streamlines: { on: state.streamlines.on, off: [...state.streamlines.off] }, maps: { on: state.maps.on, off: [...state.maps.off], picked: state.maps.picked, z: state.maps.z }, view: viewNow, cams: viewCams, camera: now, sun: { doy: state.sun.doy, hour: state.sun.hour }, weather: { on: state.weatherOn, ...state.view } });
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

// The layer window edits one layer or several (the selected rows). Where the layers differ, a
// setting shows as mixed until it is changed, and a change sets only that one setting on each.
let matLayers = [], matKind = 'material', matMixed = {};
const matOpen = () => !$('matDialog').hidden && matLayers.length > 0;
const matWhat = () => (matLayers.length === 1 ? model.layers[matLayers[0]].name : `${matLayers.length} layers`);
// The value shared by every layer in the window, or undefined when they differ.
const matSame = (f) => { const v = new Set(matLayers.map(f)); return v.size === 1 ? [...v][0] : undefined; };

// Without an anchor the window stays where it is (a refresh after an undo, a mode change or a new
// selection).
function openMaterialDialog(layers, anchor) {
  const dlg = $('matDialog'), L = model.layers, one = layers.length === 1 ? L[layers[0]] : null;
  matLayers = layers;
  matKind = showsMaterial() ? 'material' : 'colour';
  const isMat = matKind === 'material', first = layers[0];
  $('matTitle').textContent = one ? one.name : `${layers.length} layers`;
  const names = layers.map((i) => L[i].name);
  $('matPath').textContent = one ? (one.fullPath.includes('::') ? one.fullPath : '')
    : names.slice(0, 4).join(', ') + (names.length > 4 ? ` and ${names.length - 4} more` : '');
  $('matTitle').title = one ? one.fullPath : names.join(', ');
  for (const id of ['matSpecialRow', 'matSpecialHint', 'matGlossRow', 'matAlphaRow']) $(id).hidden = !isMat;
  const sel = $('matSpecial');
  sel.querySelector('option[value=""]')?.remove();
  if (isMat) {
    const special = matSame((i) => { const info = layerSpecialInfo(i); return info.auto ? 'auto' : String(info.id); });
    matMixed = {
      matSpecial: special === undefined,
      matColor: matSame((i) => rgbHex(layerLook(i).rgb)) === undefined,
      matGloss: matSame((i) => layerLook(i).gloss) === undefined,
      matAlpha: matSame((i) => layerLook(i).alpha) === undefined,
    };
    if (matMixed.matSpecial) sel.insertAdjacentHTML('afterbegin', '<option value="" disabled>Mixed</option>');
    sel.value = special ?? '';
    const look = layerLook(first);
    $('matColor').value = rgbHex(look.rgb);
    $('matGloss').value = look.gloss;
    $('matAlpha').value = 1 - look.alpha;
    $('matReset').hidden = !layers.some((i) => editedMaterialLayers().has(L[i].id));
  } else {
    matMixed = { matColor: matSame((i) => rgbHex(layerDisplayRgb(i))) === undefined };
    $('matColor').value = rgbHex(layerDisplayRgb(first));
    $('matReset').hidden = !layers.some((i) => state.layerColor[L[i].id]);
  }
  syncMaterialDialog();
  if (anchor) placePopover(dlg, anchor, 'layersPanel');
}
const refreshMaterialDialog = () => { if (matOpen()) openMaterialDialog(matLayers); };

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
  const isMat = matKind === 'material', L = model.layers, n = matLayers.length, one = n === 1;
  // "Set in this viewer" for all, some or none of the layers.
  const setHere = (has) => {
    const k = matLayers.filter((i) => has(L[i].id)).length;
    return k === n ? 'Set in this viewer.' : k ? `Set in this viewer on ${k} of ${n}.` : null;
  };
  const differ = matMixed.matColor ? ' The colours differ; picking one sets it on all of them.' : '';
  if (isMat) {
    const first = matLayers[0], info = layerSpecialInfo(first), look = layerLook(first), name = info.id ? SPECIAL[info.id].name : '';
    const off = !state.specials && matLayers.some((i) => layerSpecialId(i)) ? ' Magic materials are off (Magic in the render mode menu).' : '';
    if (one) {
      // The magic material and why; then where the colour comes from.
      const l = L[first];
      $('matSpecialHint').textContent = (info.auto ? (info.id ? `Auto: ${name}. ` : '') : '') + specialReason(info) + off;
      $('matSource').textContent = 'Render material, used in Rendered view. ' + (state.layerMat[l.id] ? 'Set in this viewer.'
        : look.special ? `Colour: the ${name} default.`
        : l.materialName ? `From the file's material “${l.materialName}”.` : 'No material in the file (default).');
    } else {
      // With Auto, each layer has its own match.
      const ids = matLayers.map(layerSpecialId), names = [...new Set(ids.filter(Boolean).map((id) => SPECIAL[id].name))];
      const matched = ids.filter(Boolean).length;
      $('matSpecialHint').textContent = (matMixed.matSpecial ? 'These layers have different magic material settings.'
        : !info.auto ? (info.id ? `${name} on all ${n}, chosen in this viewer.` : 'Turned off in this viewer.')
        : !matched ? 'Auto: none of these layers match a magic material.'
        : `Auto: ${names.join(', ')} on ${matched === n ? `all ${n}` : `${matched} of ${n}`}.`) + off;
      $('matSource').textContent = 'Render material, used in Rendered view. ' + (setHere((id) => state.layerMat[id]) || 'From the file.') + differ;
    }
    const tones = matLayers.some((i) => { const s = layerLook(i).special; return s && SPECIAL[s].tones; });
    $('matColorLabel').textContent = tones ? 'Base colour' : 'Colour';
    $('matColorRow').title = tones ? 'A magic material varies around this colour; any colour keeps the variation.' : '';
  } else {
    $('matSource').textContent = 'Display colour, used in Shaded view. ' + (setHere((id) => state.layerColor[id]) || 'From the file.') + differ;
    $('matColorLabel').textContent = 'Colour';
    $('matColorRow').title = '';
  }
  $('matAlphaOut').textContent = matMixed.matAlpha ? 'Mixed' : Math.round($('matAlpha').value * 100) + '%';
  $('matGlossOut').textContent = matMixed.matGloss ? 'Mixed' : Math.round($('matGloss').value * 100) + '%';
  const own = matLayers.flatMap((i) => objectsNotFollowingLayer(i, matKind));
  const what = isMat ? 'material' : 'colour', many = own.length > 1;
  $('matOwn').innerHTML = own.length
    ? `${own.length.toLocaleString()} object${many ? 's' : ''} on ${one ? 'this layer' : 'these layers'} ${many ? 'have their' : 'has its'} own ${what}, so ${many ? 'they are' : 'it is'} not changed here. <button class="link" id="matSelectOwn">Select ${many ? 'them' : 'it'}</button> to set the ${what} source to “By layer”.`
    : '';
}

// Any edit in the window becomes each layer's own setting. Only the setting changed is written,
// so each layer keeps its other settings.
function onMaterialEdit(e) {
  const L = model.layers, field = e?.target.id || '';
  const what = matKind === 'colour' ? 'layer colour' : field === 'matSpecial' ? 'magic material' : { matGloss: 'layer gloss', matAlpha: 'layer transparency' }[field] || 'layer material';
  recordUndo(`Change ${what} (${matWhat()})`, field === 'matSpecial' ? null : `${matKind}:${matLayers.map((i) => L[i].id).join(',')}:${field}`);
  if (matKind === 'colour') {
    const rgb = hexRgb($('matColor').value);
    for (const i of matLayers) state.layerColor[L[i].id] = [...rgb];
  } else if (field === 'matSpecial') {
    // A new magic material starts from its own default colour (other settings are kept).
    const v = $('matSpecial').value;
    let veg = false;
    for (const i of matLayers) {
      const id = L[i].id, wasVeg = layerSpecialId(i) === MAT_VEGETATION;
      if (v === 'auto') delete state.layerSpecial[id]; else state.layerSpecial[id] = +v;
      const m = state.layerMat[id];
      if (m) {
        delete m.rgb;
        if (m.alpha >= 1 && !m.gloss) delete state.layerMat[id];
      }
      if (wasVeg !== (layerSpecialId(i) === MAT_VEGETATION)) veg = true;
    }
    // Foliage uses smoothed normals, which are built with the batches.
    if (veg) rebuildModel();
  } else {
    // A layer without its own colour keeps following the file or its magic material.
    const key = { matColor: 'rgb', matAlpha: 'alpha', matGloss: 'gloss' }[field];
    const v = key === 'rgb' ? hexRgb($('matColor').value) : key === 'alpha' ? 1 - +$('matAlpha').value : +$('matGloss').value;
    for (const i of matLayers) {
      const id = L[i].id, prev = state.layerMat[id], look = layerLook(i);
      state.layerMat[id] = { ...(prev?.rgb ? { rgb: prev.rgb } : {}), alpha: look.alpha, gloss: look.gloss, [key]: key === 'rgb' ? [...v] : v };
    }
  }
  applyLayerMaterials();
  if (field === 'matSpecial') openMaterialDialog(matLayers); // the colours change with it
  else {
    matMixed[field] = false;
    const edited = matKind === 'colour' ? (id) => !!state.layerColor[id] : (id) => editedMaterialLayers().has(id);
    $('matReset').hidden = !matLayers.some((i) => edited(L[i].id));
    syncMaterialDialog();
  }
  if (state.sel.ids.length) showInspector();
}

function bindMaterialDialog() {
  $('matSpecial').innerHTML = '<option value="0">Always off</option><option value="auto">Auto</option>' +
    MATERIAL_RULES.map((r) => `<option value="${r.id}">${r.name}</option>`).join('');
  for (const id of ['matColor', 'matGloss', 'matAlpha']) $(id).addEventListener('input', onMaterialEdit);
  $('matSpecial').addEventListener('change', onMaterialEdit);
  // A drag of a slider or the colour picker is one undo step; it ends with the change event.
  for (const id of ['matColor', 'matGloss', 'matAlpha']) $(id).addEventListener('change', endUndoGroup);
  const close = () => { $('matDialog').hidden = true; matLayers = []; endUndoGroup(); };
  $('matClose').addEventListener('click', close);
  $('matDone').addEventListener('click', close);
  $('matReset').addEventListener('click', () => {
    const L = model.layers;
    recordUndo(`Reset layer ${matKind === 'colour' ? 'colour' : 'material'} (${matWhat()})`);
    let veg = false;
    for (const i of matLayers) {
      const id = L[i].id;
      if (matKind === 'colour') { delete state.layerColor[id]; continue; }
      const wasVeg = layerSpecialId(i) === MAT_VEGETATION;
      delete state.layerMat[id];
      delete state.layerSpecial[id];
      if (wasVeg !== (layerSpecialId(i) === MAT_VEGETATION)) veg = true;
    }
    if (veg) rebuildModel();
    applyLayerMaterials();
    openMaterialDialog(matLayers);
  });
  $('matOwn').addEventListener('click', (e) => {
    if (e.target.id !== 'matSelectOwn') return;
    selectObjects(matLayers.flatMap((i) => objectsNotFollowingLayer(i, matKind)).filter((id) => !objectOff(id)));
  });
}

// Write a copy of the .3dm with the viewer's changes (the original is never touched): layer
// colours, a Rhino material for each layer set in the viewer, object colour/material sources,
// block sub-element settings and magic blocks (writeMagicBlocks).
async function downloadCopy() {
  if (model?.sources?.length > 1) return exportCombined();
  if (!model || !model.bytes) return;
  try {
    showBusy('Writing a copy of the .3dm with your changes', 0.3);
    await new Promise((r) => setTimeout(r, 20));
    const rhino = await getRhino(model.reader);
    const doc = rhino.File3dm.fromByteArray(model.bytes);
    const rgba = (c) => ({ r: Math.round(c[0] * 255), g: Math.round(c[1] * 255), b: Math.round(c[2] * 255), a: 255 });
    // Layer colours and materials, object sources and block sub-element settings (the same as a combined copy).
    // Materials with a magic material are named after it, so the viewer recognises them again.
    applyViewerEdits(rhino, doc, 0);
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

// A combined copy of the Rhino files in view: one .3dm, in the first file's units. Each file goes in under a
// layer named for it, with its layers, materials, block definitions and objects; the viewer's changes to a
// file (colours, materials, object and block settings) are written into its part. Each file is read again
// from its handle, as the viewer keeps no copy of the bytes. Magic blocks and lights are not written.
async function exportCombined() {
  const missing = model.sources.filter((s) => !s.handle && !s.zip).map((s) => s.name);
  if (missing.length) { notice(`A combined copy needs every file to be one the viewer can read again. ${missing.join(', ')} ${missing.length > 1 ? 'were' : 'was'} added without a file handle.`, true); return; }
  try {
    const rhino = await getRhino(model.reader), n = model.sources.length;
    const master = new rhino.File3dm();
    master.settings().modelUnitSystem = rhino.UnitSystem[model.units];
    for (let k = 0; k < n; k++) {
      const s = model.sources[k];
      showBusy(`Adding ${s.name} (${k + 1} of ${n})`, 0.1 + (0.8 * k) / n);
      await new Promise((r) => setTimeout(r, 20));
      const blob = await projectFileBlob(s);
      if (!blob) throw new Error(`permission to read ${s.name} was not given`);
      const src = rhino.File3dm.fromByteArray(new Uint8Array(await blob.arrayBuffer()));
      try {
        applyViewerEdits(rhino, src, k);
        addFileTo(rhino, master, src, s.name, (METRES_PER_UNIT[enumName(src.settings().modelUnitSystem)] || 1) / (METRES_PER_UNIT[model.units] || 1));
      } finally {
        src.delete();
      }
    }
    showBusy('Saving', 0.95);
    await new Promise((r) => setTimeout(r, 20));
    const out = master.toByteArray();
    master.delete();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([out], { type: 'application/octet-stream' }));
    a.download = `${model.sources.map((s) => s.name.replace(/\.3dm$/i, '')).join(' + ')} - combined.3dm`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    notice('Magic blocks and Rhino lights are not written to a combined copy.', false, 6000);
  } catch (e) {
    console.error(e);
    notice(`Could not write the combined file: ${e.message || e}`, true);
  } finally {
    hideBusy();
  }
}

// The viewer's changes that belong to one file of the model (k: its place in the model), written into that
// file's document. In a merged model, ids carry the file's key and layer and material numbers run on from the
// files before (see mergeScenes): here they are turned back into the file's own. A model read on its own
// keeps the file's ids and numbers.
function applyViewerEdits(rhino, src, k) {
  const rgba = (c) => ({ r: Math.round(c[0] * 255), g: Math.round(c[1] * 255), b: Math.round(c[2] * 255), a: 255 });
  const lt = src.layers(), mats = src.materials(), objs = src.objects();
  const pre = model.fileKeys?.[k] != null ? `${model.fileKeys[k]}:` : '';
  const guidOf = (x) => x.guid ?? x.id, fileOf = (x) => x.file ?? 0;
  const mine = (x) => !!x && !x.fileRoot && !x.magic && fileOf(x) === k && !!guidOf(x);
  const layerAt = new Map();
  for (let i = 0; i < lt.count; i++) layerAt.set(lt.get(i).id, i);
  const fileLayer = (i) => (mine(model.layers[i]) ? layerAt.get(guidOf(model.layers[i])) ?? null : null);
  const fileMaterial = (mi) => (mi >= 0 ? model.materials[mi]?.srcIndex ?? mi : mi);
  for (const [id, c] of Object.entries(state.layerColor)) {
    const l = model.layers.find((x) => x.id === id);
    if (mine(l)) { const layer = lt.findId(guidOf(l)); if (layer) layer.color = rgba(c); }
  }
  for (const id of editedMaterialLayers()) {
    const L = model.layers.find((x) => x.id === id);
    if (!mine(L)) continue;
    const i = model.layers.indexOf(L), layer = lt.findId(guidOf(L));
    if (!layer) continue;
    const sp = layerSpecialId(i), set = state.layerMat[id];
    const o = { rgb: set?.rgb || (sp ? SPECIAL[sp].rgb : L.materialRgb), alpha: set ? set.alpha : sp ? 1 : L.materialAlpha, gloss: set?.gloss || 0 };
    const m = new rhino.Material();
    m.name = sp ? `${SPECIAL[sp].name} – ${L.name}` : `${L.name} (viewer)`;
    m.diffuseColor = rgba(o.rgb);
    m.transparency = 1 - o.alpha;
    m.shine = Math.round(o.gloss * 255);
    m.reflectivity = o.gloss * 0.5;
    mats.add(m);
    layer.renderMaterialIndex = mats.count - 1;
  }
  const CS = [rhino.ObjectColorSource.ColorFromLayer, rhino.ObjectColorSource.ColorFromObject, rhino.ObjectColorSource.ColorFromMaterial, rhino.ObjectColorSource.ColorFromParent];
  const MS = { 0: rhino.ObjectMaterialSource.MaterialFromLayer, 1: rhino.ObjectMaterialSource.MaterialFromObject, 3: rhino.ObjectMaterialSource.MaterialFromParent };
  for (const it of model.objects) {
    if (fileOf(it) !== k || !state.objEdits[it.id]) continue;
    const o = objs.findId(guidOf(it));
    if (!o) continue;
    const a = o.attributes(), ai = it.ai, layer = fileLayer(ai.layer);
    a.colorSource = CS[ai.cs] ?? CS[0];
    a.objectColor = rgba(ai.oc);
    a.materialSource = MS[ai.ms] ?? MS[0];
    a.materialIndex = fileMaterial(ai.mi);
    if (layer != null) a.layerIndex = layer; // a move to another file's layer is not written
  }
  // Only the block sub-element settings of this file's definitions (their ids carry the file's key).
  const idefs = src.instanceDefinitions();
  for (const [id, set] of Object.entries(state.blockSub)) {
    if (pre && !id.startsWith(pre)) continue;
    const src2 = SUB_SOURCES[set];
    for (const oid of idefs.findId(id.slice(pre.length))?.getObjectIds() || []) {
      const a = objs.findId(oid)?.attributes();
      if (a) { a.colorSource = CS[src2.cs]; a.materialSource = MS[src2.ms]; }
    }
  }
}

// Adds every object of one file to the combined file, with the file's layers (under a layer named for it),
// materials and block definitions renumbered. scale: the file's units in the combined file's units.
function addFileTo(rhino, master, src, name, scale) {
  const mats = master.materials(), lt = master.layers(), idefs = master.instanceDefinitions(), objs = master.objects();
  const rgba = (c) => ({ r: Math.round(c[0] * 255), g: Math.round(c[1] * 255), b: Math.round(c[2] * 255), a: 255 });
  // Materials: each one is added, and the file's material numbers point at the new ones.
  const matMap = [];
  const srcMats = src.materials();
  for (let i = 0; i < srcMats.count; i++) { mats.add(srcMats.get(i)); matMap[i] = mats.count - 1; }
  // The file's layers sit under one layer named for it.
  const root = new rhino.Layer();
  root.name = name;
  root.color = rgba([0.5, 0.5, 0.5]);
  const rootIndex = lt.add(root), rootId = lt.get(rootIndex).id;
  const srcLayers = src.layers(), byId = new Map(), layerMap = new Map(), layerIds = new Map();
  for (let i = 0; i < srcLayers.count; i++) byId.set(srcLayers.get(i).id, i);
  const addLayer = (i) => {
    if (layerMap.has(i)) return layerMap.get(i);
    const l = srcLayers.get(i), nl = new rhino.Layer();
    nl.name = l.name;
    nl.color = l.color;
    nl.visible = l.visible;
    nl.renderMaterialIndex = l.renderMaterialIndex >= 0 && matMap[l.renderMaterialIndex] !== undefined ? matMap[l.renderMaterialIndex] : -1;
    const p = byId.has(l.parentLayerId) ? addLayer(byId.get(l.parentLayerId)) : null;
    nl.parentLayerId = p == null ? rootId : layerIds.get(p);
    const at = lt.add(nl);
    layerIds.set(at, lt.get(at).id);
    layerMap.set(i, at);
    return at;
  };
  for (let i = 0; i < srcLayers.count; i++) addLayer(i);
  const layerOf = (i) => (layerMap.has(i) ? layerMap.get(i) : rootIndex);
  const remapAttrs = (a) => {
    a.layerIndex = layerOf(a.layerIndex);
    if (a.materialIndex >= 0) a.materialIndex = matMap[a.materialIndex] ?? -1;
    return a;
  };
  const scaled = (g) => { if (scale !== 1) g.transform(rhino.Transform.scale([0, 0, 0], scale)); return g; };
  // A placement with its translation in the combined file's units (the block's own geometry is scaled as well).
  const placement = (g) => { const x = g.xform; if (scale !== 1) { x.m03 *= scale; x.m13 *= scale; x.m23 *= scale; } return x; };
  // Block definitions: nested ones first, so every reference points at a definition already added.
  const names = new Set();
  for (let i = 0; i < idefs.count; i++) names.add(idefs.get(i).name);
  const srcDefs = src.instanceDefinitions(), defMap = new Map();
  const addDef = (sid) => {
    if (defMap.has(sid)) return defMap.get(sid);
    const def = srcDefs.findId(sid);
    if (!def) return -1;
    const geos = [], attrs = [];
    for (const oid of def.getObjectIds()) {
      const o = src.objects().findId(oid);
      if (!o) continue;
      let g = o.geometry();
      if ('parentIdefId' in g) {
        const nd = addDef(g.parentIdefId);
        if (nd < 0) continue;
        g = new rhino.InstanceReference(idefs.get(nd).id, placement(g));
      } else g = scaled(g);
      geos.push(g);
      attrs.push(remapAttrs(o.attributes()));
    }
    const base = def.name || 'Block';
    let uniq = base;
    for (let n = 2; names.has(uniq); n++) uniq = `${base} (${n})`;
    names.add(uniq);
    const at = idefs.add(uniq, '', '', '', [0, 0, 0], geos, attrs);
    defMap.set(sid, at);
    return at;
  };
  // Objects: the top-level ones of the file.
  for (let i = 0; i < src.objects().count; i++) {
    const o = src.objects().get(i), a = o.attributes();
    if (a.isInstanceDefinitionObject) continue;
    let g = o.geometry();
    if ('parentIdefId' in g) {
      const nd = addDef(g.parentIdefId);
      if (nd < 0) continue;
      g = new rhino.InstanceReference(idefs.get(nd).id, placement(g));
    } else g = scaled(g);
    objs.add(g, remapAttrs(a));
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
      const o = objs.findId(it.guid ?? it.id);
      if (!o) continue;
      const a = o.attributes(), p = it.magicXf, xf = new rhino.Transform(1);
      objs.delete(it.guid ?? it.id);
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
  const hidden = [...state.hidden].join('.') + '/' + [...state.blockOff].join('.');
  if (hidden !== flagsHidden) { flagsHidden = hidden; bumpModel('objects'); recheckMagicGround(); }
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

// Record how an object's attributes now differ from the file in state.objEdits.
function noteObjectEdit(o) {
  const d = {};
  for (const k of ['cs', 'ms', 'mi', 'layer']) if (o.ai[k] !== o.ai0[k]) d[k] = o.ai[k];
  if (rgbHex(o.ai.oc) !== rgbHex(o.ai0.oc)) d.oc = o.ai.oc;
  if (Object.keys(d).length) state.objEdits[o.id] = { ...d, cs: o.ai.cs, ms: o.ai.ms }; else delete state.objEdits[o.id];
}

// Change the selected objects' attributes (see resolveLook in extract.js) and rebuild.
async function setSelectedAttrs(change) {
  const n = state.sel.ids.length;
  recordUndo(`Change ${showsMaterial() ? 'material' : 'colour'} of ${n > 1 ? `${n} objects` : 'object'}`);
  for (const id of state.sel.ids) {
    Object.assign(model.objects[id].ai, change);
    noteObjectEdit(model.objects[id]);
  }
  await rebuildModel();
  saveEdits();
  showInspector();
  if (matOpen()) syncMaterialDialog();
}

// Put the selected objects on layer i. Their colour and material follow it where they come from
// the layer. Objects that end up on a layer that is off leave the selection, as in Rhino.
async function moveSelectionToLayer(i) {
  const ids = state.sel.ids.filter((id) => model.objects[id].ai.layer !== i);
  if (!ids.length) return;
  recordUndo(`Move ${ids.length > 1 ? `${ids.length.toLocaleString()} objects` : 'object'} to ${model.layers[i].name}`);
  for (const id of ids) {
    model.objects[id].ai.layer = i;
    noteObjectEdit(model.objects[id]);
  }
  await rebuildModel();
  saveEdits();
  layerRows.keepShown();
  const kept = state.sel.ids.filter((id) => layerEffective(model.objects[id].layer));
  if (kept.length === state.sel.ids.length) showInspector();
  else if (kept.length) selectObjects(kept);
  else { state.sel = { ids: [], p: null }; $('inspect').hidden = true; inspectPin = null; pushObjectFlags(); }
  if (matOpen()) syncMaterialDialog();
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
    'Layer colours, materials and magic materials (back to Auto), object colours, materials and layers, block settings, the north angle, hidden objects, and layer and block visibility go back to how they are in the file.\n\nUndo (Ctrl+Z) brings back the colour, material, object layer, block and north angle changes, but not hidden objects or layer visibility.',
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
const MONTHS_FULL = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const dayFull = (doy) => { const { month, day } = dateFromDayOfYear(EPW_YEAR, doy); return `${day} ${MONTHS_FULL[month - 1]}`; };

// The Date and Weather widgets, and the widgets that follow the date and time.
function syncDateWeather() {
  syncDatePanel();
  syncWeatherPanel();
  syncComfortPanel();
  syncExposurePanel();
}

function syncDatePanel() {
  const S = state.sun, doy = Math.round(S.doy), datePick = state.dateMode === 'picker', timePick = state.timeMode === 'picker';
  document.querySelector('[data-act="date"]').setAttribute('aria-pressed', String(state.datePanel));
  document.querySelector('[data-act="time"]').setAttribute('aria-pressed', String(state.timePanel));
  $('dateDay').max = daysInYear(EPW_YEAR);
  $('dateDay').value = S.doy;
  $('dateHour').value = S.hour;
  // The toolbar buttons and the widgets' titles read the date and the time ("9 June", "09:00"),
  // and the clocks' hands show it.
  $('dateLabel').textContent = $('dateTitle').textContent = dayFull(doy);
  $('timeLabel').textContent = $('timeTitle').textContent = fmtClock(S.hour);
  $('timeZone').textContent = activeLocation() ? fmtUtc(S.utcOffset) : '';
  const mins = Math.round(S.hour * 60) % 1440;
  for (const h of document.querySelectorAll('.clock-h')) h.setAttribute('transform', `rotate(${((mins / 2) % 360).toFixed(1)} 12 12)`);
  for (const m of document.querySelectorAll('.clock-m')) m.setAttribute('transform', `rotate(${(mins % 60) * 6} 12 12)`);
  $('dateSliderField').hidden = datePick; $('datePicker').hidden = !datePick;
  $('timeSliderField').hidden = timePick; $('timePicker').hidden = !timePick;
  drawSunHeads();
  if (datePick) syncDayPicker();
  if (timePick) syncTimePicker();
}

// The Date and Time widgets' title-bar buttons: slider or picker, and for the time, run through the day.
const HEAD_ICONS = {
  slider: '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M1.2 6h2M6.8 6h4"/><circle cx="4.9" cy="6" r="1.8"/></svg>',
  calendar: '<svg viewBox="0 0 12 12" aria-hidden="true"><rect x="1.75" y="2.5" width="8.5" height="7.75" rx="1"/><path d="M1.75 5.2h8.5M4.2 1.2v2.4M7.8 1.2v2.4"/></svg>',
  clock: '<svg viewBox="0 0 12 12" aria-hidden="true"><circle cx="6" cy="6" r="4.6"/><path d="M6 3.4V6l1.8 1.1"/></svg>',
  play: '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M3.6 2.3v7.4L9.5 6z"/></svg>',
  pause: '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M4.3 2.6v6.8M7.7 2.6v6.8"/></svg>',
};
function drawSunHeads() {
  const set = (b, icon, title) => {
    if (b.dataset.icon !== icon) { b.innerHTML = HEAD_ICONS[icon]; b.dataset.icon = icon; }
    b.title = title; b.setAttribute('aria-label', title);
  };
  const datePick = state.dateMode === 'picker', timePick = state.timeMode === 'picker';
  set($('dateMode'), datePick ? 'slider' : 'calendar', datePick ? 'Show the slider' : 'Show the calendar');
  set($('timeMode'), timePick ? 'slider' : 'clock', timePick ? 'Show the slider' : 'Show the clock');
  set($('timePlay'), sunAnim ? 'pause' : 'play', sunAnim ? 'Stop' : 'Run the time from sunrise to sunset');
  $('timePlay').classList.toggle('on', !!sunAnim);
}

// ---------------------------------------------------------------------------------------------
// The pickers, in the Date and Time widgets' picker mode. A click sets the date or time at once,
// as the sliders do.

let pickMonth = 1, pickDoy = 0; // the month the calendar shows, and the date it last showed

function syncDayPicker() {
  const doy = Math.round(state.sun.doy), grid = $('dayPickGrid');
  // A new date (from the slider, a menu, the file) shows its month; the arrows only browse.
  if (doy !== pickDoy) { pickDoy = doy; pickMonth = dateFromDayOfYear(EPW_YEAR, doy).month; }
  $('dayPickMonth').textContent = MONTHS_FULL[pickMonth - 1];
  if (grid.dataset.month !== String(pickMonth)) {
    const first = dayOfYear(EPW_YEAR, pickMonth, 1), next = pickMonth === 12 ? daysInYear(EPW_YEAR) + 1 : dayOfYear(EPW_YEAR, pickMonth + 1, 1);
    grid.innerHTML = '';
    for (let d = first; d < next; d++) {
      const b = document.createElement('button');
      b.dataset.doy = d;
      b.textContent = d - first + 1;
      b.setAttribute('aria-label', dayFull(d));
      grid.appendChild(b);
    }
    grid.dataset.month = pickMonth;
  }
  for (const b of grid.children) { const on = +b.dataset.doy === doy; b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on)); }
}

// The time picker is a clock face, as on a phone: the hours in two rings (00 to 11 outside, 12 to
// 23 inside), then the minutes, to the minute. Click or drag round the face; letting go of an hour moves on to the
// minutes. The hour and minute at the top switch between them. The arrow keys step the face.
let clockMode = 'h';
const CLOCK = { c: 120, face: 116, outer: 96, inner: 64 }; // the dial's SVG geometry

// The time as an hour (0 to 23) and minutes; 24:00 is 23 h and 60 min.
function pickedTime() {
  const m = Math.round(state.sun.hour * 60), h = Math.min(23, Math.floor(m / 60));
  return { h, m: m - h * 60 };
}

function syncTimePicker() {
  const { h, m } = pickedTime(), end = m >= 60, hourMode = clockMode === 'h', { c, face, outer, inner } = CLOCK;
  $('timePickH').textContent = end ? '24' : String(h).padStart(2, '0');
  $('timePickM').textContent = end ? '00' : String(m).padStart(2, '0');
  $('timePickH').classList.toggle('on', hourMode); $('timePickH').setAttribute('aria-pressed', String(hourMode));
  $('timePickM').classList.toggle('on', !hourMode); $('timePickM').setAttribute('aria-pressed', String(!hourMode));
  const at = (turn, r) => [c + r * Math.sin(turn * 2 * Math.PI), c - r * Math.cos(turn * 2 * Math.PI)];
  const text = (x, y, s, cls) => `<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" class="${cls}">${s}</text>`;
  let labels = '', knob;
  if (hourMode) {
    const sel = end ? 0 : h;
    for (let k = 0; k < 24; k++) {
      const [x, y] = at((k % 12) / 12, k < 12 ? outer : inner);
      const cls = k < 12 ? (k === sel ? 'outer on' : 'outer') : (k === sel ? 'inner on' : 'inner');
      labels += text(x, y, k === 0 ? '00' : k, cls);
    }
    knob = { p: at((sel % 12) / 12, sel < 12 ? outer : inner), dot: false };
  } else {
    const sel = end ? 0 : m;
    for (let k = 0; k < 60; k += 5) { const [x, y] = at(k / 60, outer); labels += text(x, y, String(k).padStart(2, '0'), `outer${k === sel ? ' on' : ''}`); }
    knob = { p: at(sel / 60, outer), dot: sel % 5 !== 0 };
  }
  const [kx, ky] = knob.p, dial = $('timePickDial');
  // The knob goes under the labels, so the chosen one reads white on it.
  dial.innerHTML = `<circle class="face" cx="${c}" cy="${c}" r="${face}"/><line class="hand" x1="${c}" y1="${c}" x2="${kx.toFixed(1)}" y2="${ky.toFixed(1)}"/>` +
    `<circle class="hub" cx="${c}" cy="${c}" r="3"/><circle class="knob" cx="${kx.toFixed(1)}" cy="${ky.toFixed(1)}" r="17"/>` +
    (knob.dot ? `<circle class="knob-dot" cx="${kx.toFixed(1)}" cy="${ky.toFixed(1)}" r="2.5"/>` : '') + labels;
  dial.setAttribute('aria-label', hourMode ? 'Hour' : 'Minute');
  dial.setAttribute('aria-valuetext', hourMode ? $('timePickH').textContent : $('timePickM').textContent);
}

// Sets the hour or the minute, keeping the other.
function setClock(mode, v) {
  const { h, m } = pickedTime();
  if (sunAnim) toggleDatePlay();
  setSun({ hour: mode === 'h' ? v + (m >= 60 ? 0 : m) / 60 : h + v / 60 });
  saveViewState();
}

function bindClock() {
  const dial = $('timePickDial');
  // The hour or minute under the pointer: by its angle, and for the hours by the ring it is nearer.
  const valueAt = (e) => {
    const r = dial.getBoundingClientRect(), s = (2 * CLOCK.c) / r.width;
    const dx = (e.clientX - r.left) * s - CLOCK.c, dy = (e.clientY - r.top) * s - CLOCK.c;
    const turn = ((Math.atan2(dx, -dy) / (2 * Math.PI)) + 1) % 1;
    if (clockMode === 'm') return Math.round(turn * 60) % 60;
    const k = Math.round(turn * 12) % 12;
    return Math.hypot(dx, dy) < (CLOCK.outer + CLOCK.inner) / 2 ? k + 12 : k;
  };
  let dragging = false;
  dial.addEventListener('pointerdown', (e) => { dragging = true; dial.setPointerCapture(e.pointerId); setClock(clockMode, valueAt(e)); });
  dial.addEventListener('pointermove', (e) => { if (dragging) { const v = valueAt(e), { h, m } = pickedTime(); if (v !== (clockMode === 'h' ? h : m)) setClock(clockMode, v); } });
  const release = () => { if (!dragging) return; dragging = false; if (clockMode === 'h') { clockMode = 'm'; syncTimePicker(); } };
  dial.addEventListener('pointerup', release);
  dial.addEventListener('pointercancel', () => { dragging = false; });
  dial.addEventListener('keydown', (e) => {
    const step = { ArrowUp: 1, ArrowRight: 1, ArrowDown: -1, ArrowLeft: -1 }[e.key];
    if (step) {
      const { h, m } = pickedTime();
      if (clockMode === 'h') setClock('h', (h + step + 24) % 24); else setClock('m', ((m >= 60 ? 0 : m) + step + 60) % 60);
    } else if (e.key === 'Enter' && clockMode === 'h') { clockMode = 'm'; syncTimePicker(); }
    else return;
    e.preventDefault(); e.stopPropagation();
  });
  for (const [id, mode] of [['timePickH', 'h'], ['timePickM', 'm']]) $(id).addEventListener('click', () => { clockMode = mode; syncTimePicker(); dial.focus(); });
}

function bindPickers() {
  const pick = (changes) => { if (sunAnim) toggleDatePlay(); setSun(changes); saveViewState(); };
  $('dayPickGrid').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) pick({ doy: +b.dataset.doy }); });
  const month = (d) => { pickMonth = ((pickMonth - 1 + d + 12) % 12) + 1; syncDayPicker(); };
  $('dayPickPrev').addEventListener('click', () => month(-1));
  $('dayPickNext').addEventListener('click', () => month(1));
  bindClock();
  // The title bars' buttons: slider or picker, and run the time through the day.
  $('dateMode').addEventListener('click', () => { state.dateMode = state.dateMode === 'picker' ? 'slider' : 'picker'; pickDoy = 0; savePrefs(); syncDatePanel(); });
  $('timeMode').addEventListener('click', () => { state.timeMode = state.timeMode === 'picker' ? 'slider' : 'picker'; clockMode = 'h'; savePrefs(); syncDatePanel(); });
  $('timePlay').addEventListener('click', toggleDatePlay);
}

// The View ticks, under Weather in the render mode menu. Those without the data they need (a
// location, a weather file) are hidden, and the section with them if none is left; any other that
// cannot show is greyed out, with why in its tooltip.
function syncViewChecks() {
  if (!modeList) return;
  let any = false;
  for (const item of VIEW_ITEMS) {
    const id = `view-${item}`, has = viewHasData(item);
    modeList.setChecked(id, state.view[item]);
    modeList.item(id).hidden = !has;
    modeList.setDisabled(id, has && viewWhyNot(item), VIEW_TITLES[item]);
    any ||= has;
  }
  modeList.showGroup('weather', any);
  $('cloudSpeedField').hidden = !viewOn('clouds');
  $('cloudSpeed').value = clouds.speed;
  $('cloudSpeedOut').value = clouds.speed ? `${clouds.speed}× wind speed` : 'Still';
}

function syncWeatherPanel() {
  $('weatherOn').checked = state.weatherOn;
  $('weatherQuick').setAttribute('aria-pressed', String(state.weatherOn));
  document.querySelector('[data-act="weather"]').setAttribute('aria-pressed', String(state.weatherPanel));
  syncToolsButton();
  syncViewChecks();
  if (!state.weatherPanel) return;
  const loc = activeLocation(), e = site.epw;
  // Without a location, the location dialog: it takes a weather file too.
  $('weatherAdd').hidden = !!e;
  $('weatherAdd').textContent = loc ? 'Add EPW' : 'Set location';
  $('weatherAdd').title = loc ? 'Attach a weather file (EPW): its weather, clouds and haze' : 'Set the site location, for the sun and the sky. A weather file can set it too';
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
function toggleTimePanel() {
  state.timePanel = !state.timePanel;
  $('timePanel').hidden = !state.timePanel;
  syncDateWeather();
}

// Runs the time through the day: from just before sunrise to just after sunset at the location.
function toggleDatePlay() {
  if (sunAnim) { cancelAnimationFrame(sunAnim); sunAnim = 0; drawSunHeads(); return; }
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
  drawSunHeads();
}

function bindDateWeather() {
  $('dateDay').addEventListener('input', (e) => setSun({ doy: +e.target.value }));
  $('dateHour').addEventListener('input', (e) => setSun({ hour: +e.target.value }));
  for (const id of ['dateDay', 'dateHour']) $(id).addEventListener('change', saveViewState);
  // Right-click the date or time slider for its usual values, and the user's own. Those are kept
  // for this machine, for every model; + adds the value showing, × removes one. Values are whole
  // numbers: the day of the year, or the minute of the day.
  const presetMenu = ({ key, fixed, now, name, go, valid }) => {
    const load = () => { try { return JSON.parse(localStorage.getItem(key) || '[]').filter(valid); } catch (err) { return []; } };
    const save = (list) => { try { localStorage.setItem(key, JSON.stringify(list)); } catch (err) { /* storage unavailable */ } };
    const at = (label, v) => ({ label, run: () => { go(v); saveViewState(); } });
    const open = (pos) => {
      const mine = load(), has = mine.includes(now) || fixed.some((f) => f.v === now);
      const items = fixed.map((f) => at(f.label, f.v));
      if (mine.length) items.push('-', ...mine.map((v) => ({ ...at(name(v), v), remove: () => { save(load().filter((w) => w !== v)); open(pos); } })));
      showMenu('Go to', items, pos, { add: { label: '+', title: has ? `${name(now)} is already in this list` : `Add ${name(now)} to this list`, disabled: has,
        run: () => { save([...load(), now].sort((a, b) => a - b)); open(pos); } } });
    };
    return open;
  };
  // Each slider's whole field takes the menu, and so does the minimised widget's reading in the
  // title bar, in place of its lock menu.
  const onMenu = (ids, show) => {
    for (const id of ids) ($(id).closest('.field') || $(id)).addEventListener('contextmenu', (e) => { e.preventDefault(); e.stopPropagation(); show(e); });
  };
  onMenu(['dateDay', 'dateTitle'], (e) => {
    const fixed = [[3, 21, 'equinox'], [6, 21, 'solstice'], [9, 23, 'equinox'], [12, 21, 'solstice']].map(([m, d, what]) => {
      const v = dayOfYear(EPW_YEAR, m, d);
      return { v, label: `${dayFull(v)} · ${what}` };
    });
    presetMenu({ key: '3dm-viewer-dates', fixed, now: Math.round(state.sun.doy), name: dayFull, valid: (d) => d >= 1 && d <= 365,
      go: (doy) => setSun({ doy }) })([e.clientX, e.clientY]);
  });
  onMenu(['dateHour', 'timeTitle'], (e) => {
    const noon = activeLocation() ? sunPosition().noon : null, clock = (m) => fmtClock(m / 60);
    const fixed = noon != null ? [{ v: Math.round(noon * 60), label: `Solar noon · ${fmtHour(noon)}` }] : [];
    presetMenu({ key: '3dm-viewer-times', fixed, now: Math.round(state.sun.hour * 60), name: clock, valid: (m) => m >= 0 && m <= 1440,
      go: (m) => setSun({ hour: m / 60 }) })([e.clientX, e.clientY]);
  });
  bindPickers();
  document.querySelector('[data-act="weather"]').addEventListener('click', toggleWeatherPanel);
  $('weatherClose').addEventListener('click', () => state.weatherPanel && toggleWeatherPanel());
  $('weatherAdd').addEventListener('click', () => (activeLocation() ? openAttachDialog() : openLocationDialog()));
  $('cloudSpeed').addEventListener('input', (e) => { clouds.speed = +e.target.value; savePrefs(); syncWeatherPanel(); redraw(); });
  $('weatherOn').addEventListener('change', (e) => setWeatherOn(e.target.checked));
  $('weatherQuick').addEventListener('click', () => setWeatherOn(!state.weatherOn));
  $('weatherCombo').addEventListener('click', (e) => { if (e.target === e.currentTarget) toggleWeatherPanel(); }); // the gaps round the icon
  syncDateWeather();
}

// The Weather widget: the sun and the weather file at the Date and Time widgets' date and time, and what to show.
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

const LOCATION_KINDS = { custom: 'custom location', city: 'city', epw: 'from the weather file', file: 'from the Rhino file' };
const fmtCoords = (lat, lon) => `${Math.abs(lat).toFixed(2)}° ${lat < 0 ? 'S' : 'N'}, ${Math.abs(lon).toFixed(2)}° ${lon < 0 ? 'W' : 'E'}`;
const epwById = (id) => site.epws.find((e) => e.id === id) ?? null;
const newId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

// The location source for a Rhino file in the model: 'file' for the first file, 'file:<n>' for the next.
const fileUse = (k) => (k ? `file:${k}` : 'file');
// The Rhino files that set a location: [{ name, location, use }].
function fileLocations() {
  return (model?.locations || []).map((x, k) => ({ name: x.name, location: x.location, use: fileUse(k) })).filter((x) => x.location);
}

// { lat, lon, utcOffset, name, kind, use } for one location source (use: 'custom', 'city', 'file',
// 'file:<n>' or 'epw:<id>'), or null when it has no location.
function locationOf(use) {
  if (use === 'custom') return site.custom && { ...site.custom, name: null, kind: 'custom', use };
  if (use === 'city') return site.city && { ...site.city, kind: 'city', use };
  if (use?.startsWith('epw:')) {
    const ep = epwById(use.slice(4)), e = ep && !ep.off ? ep.location : null;
    return e?.known ? { lat: e.lat, lon: e.lon, utcOffset: e.utcOffset ?? Math.round(e.lon / 15), name: e.name, kind: 'epw', use } : null;
  }
  const k = use === 'file' ? 0 : use?.startsWith('file:') ? +use.slice(5) : -1;

  const f = k >= 0 ? model?.locations?.[k]?.location : null;
  return f ? { lat: f.lat, lon: f.lon, utcOffset: f.utcOffset, name: null, kind: 'file', use: fileUse(k) } : null;
}
const activeLocation = () => (site.use && locationOf(site.use)) || locationOf('custom') || locationOf('city')
  || (site.epw && locationOf(`epw:${site.epw.id}`)) || (fileLocations()[0] && locationOf(fileLocations()[0].use));

function applyLocation() {
  const A = activeLocation();
  if (A) Object.assign(state.sun, { lat: +A.lat.toFixed(5), lon: +A.lon.toFixed(5), utcOffset: A.utcOffset });
  $('btnLocation').classList.toggle('set', !!A);
  $('locName').textContent = A ? A.name || fmtCoords(A.lat, A.lon) : 'Set location';
  $('btnLocation').title = A ? `${A.name ? fmtCoords(A.lat, A.lon) + ', ' : ''}${fmtUtc(A.utcOffset)}, ${LOCATION_KINDS[A.kind]}. Click to change the location.`
    : 'Set the site location';
  const e = site.epw;
  $('btnWeather').classList.toggle('set', !!e);
  $('btnWeather').title = e ? `Weather data source: ${e.fileName}` : 'Weather data source: none yet. Attach a weather file (EPW) first';
  locationDialog?.refresh();
  weatherDialog?.refresh();
  attachDialog?.refresh();
  syncDateWeather();
  redraw();
}

// Save a change to the open project's settings. Typing saves once the typing pauses.
let linkTimer = 0, linkPending = null; // { projectId, changes }
function linkToModel(changes, delay = 0) {
  const id = model?.projectId;
  if (!id) return;
  if (linkPending && linkPending.projectId !== id) flushLinks();
  linkPending = { projectId: id, changes: { ...linkPending?.changes, ...changes } };
  clearTimeout(linkTimer);
  if (delay) linkTimer = setTimeout(flushLinks, delay); else flushLinks();
}
function flushLinks() {
  clearTimeout(linkTimer);
  const p = linkPending;
  linkPending = null;
  if (p) Recent.link(p.projectId, p.changes).then(renderRecent);
}

// The location source picked in the Set location list. A weather file's location also makes it the
// weather data source.
function useLocation(use) {
  site.use = use;
  if (use.startsWith('epw:')) site.epw = epwById(use.slice(4));
  linkToModel({ use, weather: site.epw?.id ?? null });
  applyLocation();
}

function setCustomLocation(c, typing = false) {
  site.custom = c;
  site.use = 'custom';
  linkToModel({ custom: c, use: 'custom' }, typing ? 400 : 0);
  applyLocation();
}

function setCity(c) {
  site.city = c;
  useLocation('city');
}

// The weather data source: one of the attached weather files, or null. Its weather shows in the Weather widget.
function setWeather(epw) {
  site.epw = epw;
  linkToModel({ weather: epw?.id ?? null });
  applyLocation();
}

// The weather files as the model keeps them: a copy of each, with its id.
const epwLinks = () => site.epws.map((e) => ({ id: e.id, name: e.fileName, bytes: e.bytes, off: !!e.off }));

// A weather file (EPW) attached from the Attach files dialog or dropped onto the window. A new one
// becomes the weather data source, and sets the location straight away when it has one.
async function attachEpw(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (site.epws.some((e) => e.fileName === file.name && e.bytes.length === bytes.length)) { notice(`${file.name} is already attached.`, false, 3000); return; }
  let epw;
  try { epw = EPW.fromBytes(bytes, file.name); }
  catch (e) { notice(`Could not read ${file.name}: ${e.message}`, true); return; }
  Object.assign(epw, { id: newId(), bytes });
  site.epws.push(epw);
  site.epw = epw;
  if (epw.location.known) site.use = `epw:${epw.id}`;
  linkToModel({ epws: epwLinks(), weather: epw.id, use: site.use });
  applyLocation();
  syncResults();
  if (!epw.location.known) notice(`${file.name} has no usable latitude and longitude, so it does not set the location. Its weather is still shown.`);
  else notice(`Location and weather from ${file.name}.`, false, 3000);
}

// Detaches a weather file. The weather data source and the location fall back to another, if there is one.
function removeEpw(id) {
  site.epws = site.epws.filter((e) => e.id !== id);
  if (site.epw?.id === id) site.epw = site.epws[0] ?? null;
  if (site.use === `epw:${id}`) site.use = null;
  linkToModel({ epws: epwLinks(), weather: site.epw?.id ?? null, use: site.use });
  applyLocation();
  syncResults();
}

// The weather file's place and coordinates (or that it has none), as a line of text.
const epwSub = (e) => (e.location.known ? `${fmtCoords(e.location.lat, e.location.lon)} · ${fmtUtc(e.location.utcOffset ?? 0)}` : 'No usable latitude and longitude');

// Weather data source dialog: which of the attached weather files gives the weather. Other kinds of
// weather data will be listed here too, when they can be imported.
let weatherDialog = null;
function openWeatherDialog() {
  if (weatherDialog) return;
  const wrap = document.createElement('div');
  wrap.className = 'loc-dlg';
  wrap.innerHTML = `
    <div class="choice-holder" data-el="list"></div>
    <div class="loc-actions" data-el="empty"><span class="fine">No weather files attached.</span><button class="btn small" data-el="attach">Attach files…</button></div>`;
  const el = (k) => wrap.querySelector(`[data-el="${k}"]`);
  const list = new ChoiceList({ label: 'Weather data source', onPick: (id) => setWeather(epwById(id)) });
  el('list').append(list.el);
  el('attach').addEventListener('click', openAttachDialog);
  const refresh = () => {
    list.setGroups([{ items: site.epws.filter((e) => !e.off).map((e) => ({ id: e.id, label: e.fileName, sub: epwSub(e), title: `Weather from ${e.fileName}` })) }]);
    list.setActive(site.epw?.id ?? '');
    el('list').hidden = !site.epws.length;
    el('empty').hidden = !!site.epws.length;
  };
  refresh();
  weatherDialog = { refresh };
  Dialog.open({ title: 'Weather data source', body: wrap, buttons: [{ label: 'Done', value: true, primary: true }], width: 420 })
    .then(() => { weatherDialog = null; });
}

// ---------------------------------------------------------------------------------------------
// Results files (results.js)

const resultLinks = () => results.map(({ id, name, size, off }) => ({ id, name, size, off: !!off }));

// A results file is active (used in the view) unless it is turned off in the Attach files dialog.
function setResultOn(id, on) {
  const r = results.find((x) => x.id === id);
  if (!r) return;
  r.off = !on;
  linkToModel({ results: resultLinks() });
  syncResults();
}

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
  if (m.projectId) {
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

// Everything that shows the attached files follows the lists.
function syncResults() {
  const names = [...site.epws.map((e) => e.fileName), ...results.map((r) => r.name)];
  $('btnResultsFiles').classList.toggle('set', names.length > 0);
  $('btnResultsFiles').title = names.length ? `Attached: ${names.join(', ')}` : 'Attach files: weather (EPW) and results files';
  $('btnResults').hidden = !results.some((r) => r.data && !r.off);
  fillStreamlines();
  fillMaps();
  fillResultsMenu();
  attachDialog?.refresh();
  redraw();
}

// Attach files help: the kinds of file that can be attached.
function showAttachHelp() {
  Dialog.open({ title: 'Attach files', html: true, width: 420, body: `<p>Files attached to the open model are only read, never changed. Three kinds can be attached:</p>
    <p><b>Weather files (.epw)</b>: EnergyPlus weather, with the location in its header. The weather data source is the one that gives the weather in the Weather widget and drives the UTCI. A file with a usable location can also set the site location.</p>
    <p><b>CFD streamlines (.csv)</b>: a CFX export with <i>[Name]</i>, <i>[Data]</i> and <i>[Lines]</i> sections. The streamlines are drawn on the model, coloured by velocity against the Lawson comfort criteria. Open them from Results.</p>
    <p><b>CFD map (.csv)</b>: a CFX export of results on a surface, with <i>[Name]</i>, <i>[Data]</i> and <i>[Faces]</i> sections. Each map is drawn on the model, and a result is chosen for it from Results. Hover over a map to read its values.</p>
    <p>Drop files onto the window to attach them too.</p>` });
}

// Attach files dialog: the Rhino files in the open model's project (one is open, the others are
// chosen to open), the weather files and results files attached to the model, and which parser
// read each results file.
let attachDialog = null;
function openAttachDialog() {
  if (attachDialog) return;
  const wrap = document.createElement('div');
  wrap.className = 'loc-dlg';
  wrap.innerHTML = `
    <div class="res-list" data-el="list"></div>
    <div class="loc-actions"><button class="btn small" data-el="pick">Attach files…</button></div>
    <input type="file" multiple data-el="input" hidden>`;
  const el = (k) => wrap.querySelector(`[data-el="${k}"]`);
  const types = [...new Set(['.epw', '.3dm', ...RESULT_PARSERS.flatMap((p) => p.extensions)])];
  el('input').accept = types.join(',');
  const route = (f, handle) => (/\.epw$/i.test(f.name) ? attachEpw(f) : /\.3dm$/i.test(f.name) ? attachRhinoFile(f, handle) : addResultsFile(f));
  el('pick').addEventListener('click', async () => {
    // With the file picker, each file comes with a handle, so an attached Rhino file can be reopened later.
    if (!Recent.supported) { el('input').click(); return; }
    let handles;
    try { handles = await window.showOpenFilePicker({ multiple: true, types: [{ description: 'Weather, Rhino and results files', accept: { 'application/octet-stream': types } }] }); }
    catch (e) { return; } // cancelled
    for (const h of handles) route(await h.getFile(), h);
  });
  el('input').addEventListener('change', () => { const files = [...el('input').files]; el('input').value = ''; files.forEach((f) => route(f, null)); });
  // A row: its name and detail, a Remove button (remove), and a checkbox (toggle: { label, title, on, change }).
  const row = (name, detail, remove, toggle) => {
    const r = document.createElement('div');
    r.className = 'res-row';
    r.innerHTML = `<div><div>${escapeHtml(name)}</div><div class="fine">${detail}</div></div>${remove ? `<button class="x" aria-label="Remove ${escapeHtml(name)}" title="Remove">×</button>` : ''}`;
    if (remove) r.querySelector('.x').addEventListener('click', remove);
    if (toggle) {
      const label = document.createElement('label'), box = document.createElement('input');
      label.className = 'fine'; label.title = toggle.title;
      box.type = 'checkbox'; box.checked = toggle.on;
      box.addEventListener('change', () => toggle.change(box.checked));
      label.append(box, ' ' + toggle.label);
      r.querySelector('.fine').append(' · ', label);
    }
    return r;
  };
  const refresh = async () => {
    const project = model?.projectId ? (await Recent.list()).find((p) => p.id === model.projectId) : null;
    // Every Rhino file of the model is in its view; a file's layers are shown or hidden in the Layers panel.
    // The last one cannot be taken off, as the view would have nothing in it.
    // Active: a Rhino file is in the view; a weather file is offered as a location or weather source.
    const many = (project?.files.length || 0) > 1;
    const rhino = (project?.files || []).map((f) => row(f.name, 'Rhino file', many ? () => detachRhinoFile(f.id) : null,
      { label: 'In view', title: 'Show this file in the view, with the others that are in view', on: !f.off, change: (on) => setRhinoFileOn(f.id, on) }));
    el('list').replaceChildren(
      ...rhino,
      ...site.epws.map((e) => row(e.fileName, `Weather file · ${escapeHtml(epwSub(e))}`, () => removeEpw(e.id),
        { label: 'Active', title: 'Offer this file as a location and weather source', on: !e.off, change: (on) => setEpwOn(e.id, on) })),
      ...results.map((r) => row(r.name, r.parser ? `${escapeHtml(r.parser.name)} · ${escapeHtml(r.parser.describe(r.data))}` : 'Not recognised by any parser', () => removeResultsFile(r.id),
        { label: 'Active', title: 'Show these results in the view', on: !r.off, change: (on) => setResultOn(r.id, on) })),
    );
    if (!rhino.length && !site.epws.length && !results.length) el('list').innerHTML = '<div class="fine">Nothing attached yet.</div>';
  };
  refresh();
  attachDialog = { refresh };
  Dialog.open({ title: 'Attach files', body: wrap, buttons: [{ label: 'Done', value: true, primary: true }], width: 460, help: showAttachHelp })
    .then(() => { attachDialog = null; });
}

// The toolbar's Results menu: one item for each kind of result there is.
let resultsList = null, resultsMenu = null;
function bindResultsMenu() {
  // An item's eye shows or hides what it draws, like its panel's switch; the rest of it opens or closes the panel.
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
  if (state.streamlines.lines.length) items.push({ id: 'streamlines', label: 'CFD streamlines', toggle: 'eye' });
  if (state.maps.list.length) items.push({ id: 'map', label: 'CFD map', toggle: 'eye' });
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
  const SL = state.streamlines, files = model ? results.filter((r) => r.parser?.id === 'cfdStreamlines' && !r.off) : [];
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
    row.innerHTML = `<button class="caret ${count ? '' : 'empty'}" aria-label="Expand"><svg viewBox="0 0 24 24"><path d="m6 9 6 6 6-6"/></svg></button><input type="checkbox" class="eye" aria-label="Show" title="Show or hide"><span class="layer-name"></span>${count ? `<span class="layer-count">${count.toLocaleString()}</span>` : ''}`;
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
  const M = state.maps, files = model ? results.filter((r) => r.parser?.id === 'cfdMap' && !r.off) : [];
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
    top.innerHTML = `<button class="caret" aria-label="Expand">${caret}</button><input type="checkbox" class="eye" aria-label="Show this map" title="Show or hide"><span class="layer-name"></span>`;
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

// Set location dialog: one choice of location source, picked from a list. Changes apply as they are made.
let locationDialog = null;
function showLocationHelp() {
  Dialog.open({ title: 'Location', html: true, width: 400, body: `<p>The site location places the sun and sets the clock's UTC offset. Pick one source in the list:</p>
    <p><b>Weather file (EPW)</b>: the location in each attached weather file. Attach them with the file icon at the top left, or by dropping an .epw file onto the window.</p>
    <p><b>Rhino file</b>: the location saved in the .3dm file, if it has one.</p>
    <p><b>From city</b>: a city from the list. <b>Custom location</b>: a latitude, longitude and UTC offset that you type.</p>
    <p>Picking a weather file's location also makes that file the weather data source, the one the Weather widget and the UTCI use. It is chosen separately, with the sun-and-cloud button next to the pin.</p>
    <p>The sun needs a location. The choice, the city, the custom location and the weather files belong to the open model, and come back with it when you reopen it from Recent files.</p>` });
}

// The rows of the list: the weather files with a usable location, the Rhino file, a city and a custom location.
function locationGroups() {
  const epw = site.epws.filter((e) => e.location.known && !e.off).map((e) => ({ id: `epw:${e.id}`, label: e.fileName, sub: epwSub(e), title: `Location from ${e.fileName}` }));
  const cityOf = site.city, customOf = site.custom;
  const files = fileLocations();
  const rhino = files.length
    ? files.map(({ name, location, use }) => ({ id: use, label: model.locations.length > 1 ? name : 'Rhino file', sub: fmtCoords(location.lat, location.lon),
      title: `The location saved in ${name}` }))
    : [{ id: 'file', label: 'Rhino file', sub: !model ? 'No file open' : `${model.name} does not set a location`,
      title: 'The location saved in the Rhino file', disabled: 'The Rhino file does not set a location' }];
  return [{ items: [
    ...epw,
    ...rhino,
    { id: 'city', label: 'From city', sub: cityOf ? `${cityOf.name} · ${fmtCoords(cityOf.lat, cityOf.lon)}` : 'No city chosen', title: 'A city from the list',
      disabled: cityOf ? null : 'No city chosen', action: { label: cityOf ? 'Change…' : 'Set city…', title: 'Choose a city', run: openCityDialog } },
    { id: 'custom', label: 'Custom location', sub: customOf ? `${fmtCoords(customOf.lat, customOf.lon)} · ${fmtUtc(customOf.utcOffset)}` : 'Not set', title: 'A latitude, longitude and UTC offset that you type',
      disabled: customOf ? null : 'No custom location set', action: { label: 'Set…', title: 'Type a latitude, longitude and UTC offset', run: openCustomDialog } },
  ] }];
}

function openLocationDialog() {
  if (locationDialog) return;
  const wrap = document.createElement('div');
  wrap.className = 'loc-dlg';
  const intro = document.createElement('div');
  intro.innerHTML = '<b>Choose a location for this model:</b>';
  const hint = document.createElement('div');
  hint.className = 'fine';
  hint.innerHTML = 'Location can also be provided by EPW files. <button class="link">Attach files</button>';
  hint.querySelector('.link').addEventListener('click', openAttachDialog);
  const list = new ChoiceList({ label: 'Set location', onPick: (id) => useLocation(id) });
  wrap.append(intro, hint, list.el);
  let shown = null; // the rows as last built: rebuilt only when what they say changes
  const refresh = () => {
    const groups = locationGroups(), key = JSON.stringify(groups);
    if (key !== shown) { list.setGroups(groups); shown = key; }
    list.setActive(activeLocation()?.use ?? '');
    hint.hidden = site.epws.some((e) => e.location.known && !e.off);
  };
  refresh();
  locationDialog = { refresh };
  Dialog.open({ title: 'Set location', body: wrap, buttons: [{ label: 'Done', value: true, primary: true }], width: 460, help: showLocationHelp })
    .then(() => { locationDialog = null; });
}

// City dialog: search the cities and countries, and pick one. The list closes with the choice.
let cityDialog = null;
function openCityDialog() {
  if (cityDialog) return;
  const wrap = document.createElement('div');
  wrap.className = 'loc-dlg';
  wrap.innerHTML = `<input type="search" class="city-search" placeholder="Search cities and countries" aria-label="Search cities">
    <div class="city-list" role="listbox"></div>
    <div class="fine">The UTC offset is the city's standard time; daylight saving is not applied.</div>`;
  const search = wrap.querySelector('.city-search'), list = wrap.querySelector('.city-list');
  let dlg = null;
  const pick = (name, country, la, lo, off) => { setCity({ lat: la, lon: lo, utcOffset: off, name: `${name}, ${country}` }); dlg?.close(true); };
  const showCities = () => {
    const q = search.value.trim().toLowerCase();
    const hits = CITIES.filter(([n, c]) => !q || n.toLowerCase().includes(q) || c.toLowerCase().includes(q));
    list.innerHTML = hits.length ? '' : '<div class="empty">No matching city. Set a custom location instead.</div>';
    for (const [name, country, la, lo, off] of hits) {
      const b = document.createElement('button');
      b.setAttribute('role', 'option');
      b.innerHTML = '<span></span><span class="n"></span>';
      b.firstChild.textContent = `${name}, ${country}`;
      b.lastChild.textContent = `${la.toFixed(2)}, ${lo.toFixed(2)} · ${fmtUtc(off)}`;
      b.setAttribute('aria-selected', String(site.city?.name === `${name}, ${country}`));
      b.addEventListener('click', () => pick(name, country, la, lo, off));
      list.appendChild(b);
    }
  };
  search.addEventListener('input', showCities);
  search.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.stopPropagation(); list.querySelector('button')?.click(); } });
  showCities();
  cityDialog = true;
  dlg = new Dialog({ title: 'From city', body: wrap, buttons: [], width: 420 });
  dlg.result.then(() => { cityDialog = null; });
}

// Custom location dialog: a latitude, longitude and UTC offset, typed. Each change applies as it is typed.
let customDialog = null;
function openCustomDialog() {
  if (customDialog) return;
  const wrap = document.createElement('div');
  wrap.className = 'loc-dlg';
  wrap.innerHTML = `
    <div class="grid3">
      <label>Latitude<input type="number" data-el="lat" step="0.0001" min="-90" max="90"></label>
      <label>Longitude<input type="number" data-el="lon" step="0.0001" min="-180" max="180"></label>
      <label>UTC offset (h)<input type="number" data-el="utc" step="0.5" min="-12" max="14"></label>
    </div>
    <div class="fine">The UTC offset follows the longitude until you type one. Use the Set location list to pick the location once it is set.</div>`;
  const el = (k) => wrap.querySelector(`[data-el="${k}"]`);
  const lat = el('lat'), lon = el('lon'), utc = el('utc');
  const c = site.custom;
  if (c) { lat.value = c.lat; lon.value = c.lon; utc.value = c.utcOffset; }

  // Typing a latitude and longitude sets the custom location; the UTC offset follows the
  // longitude until one is typed.
  let utcTyped = !!c;
  const typed = () => {
    const a = parseFloat(lat.value), o = parseFloat(lon.value), u = parseFloat(utc.value);
    if (!(Math.abs(a) <= 90 && Math.abs(o) <= 180)) return;
    const followed = Math.round(o / 15);
    if (!utcTyped) utc.value = followed; // shown as the offset in use, until one is typed
    setCustomLocation({ lat: a, lon: o, utcOffset: utcTyped && Math.abs(u) <= 14 ? u : followed, name: null }, true);
  };
  lat.addEventListener('input', typed);
  lon.addEventListener('input', typed);
  utc.addEventListener('input', () => { utcTyped = utc.value !== ''; typed(); });

  customDialog = true;
  const dlg = new Dialog({ title: 'Custom location', body: wrap, buttons: [{ label: 'Done', value: true, primary: true }], width: 420 });
  dlg.result.then(() => { customDialog = null; });
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

// The days and hours tested: the chosen spans round the Date and Time widgets' date and time.
const exposurePeriod = () => ({ days: exposureDays(expo.dateSpan, state.sun.doy, EPW_YEAR), hours: exposureHours(expo.timeSpan, state.sun.hour) });

// The settings a surface and a run depend on, or null when there is nothing to work out.
function exposureKeys() {
  if (!model || expo.layer < 0 || !activeLocation()) return null;
  const { days, hours } = exposurePeriod();
  // The surface is the layer's objects. The shadows on it come from every visible object that is
  // not too transparent, so they also depend on the materials.
  const surface = [expo.layer, expo.flip, expo.upOnly, expo.spacing, modelKey('objects')].join('|');
  return { surface, run: [surface, days[0], days.length, hours, expo.step, modelKey('visibility', 'appearance', 'site')].join('|') };
}

// Each frame, and on a change in the panel (see checkAnalysis).
function checkExposure() {
  checkAnalysis(expo, expo.on ? exposureKeys()?.run : null, runExposure, syncExposurePanel);
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
  syncToolsButton();
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

// The Tools button is pressed while any widget it opens is open.
function syncToolsButton() {
  $('btnTools').setAttribute('aria-pressed', String(!!(expo.panel || state.weatherPanel || state.comfort.panel || state.lightsPanel)));
}

function showExposureHelp() {
  Dialog.open({ title: 'Sun exposure', html: true, width: 440, body: `<p>How often each part of a layer’s objects can see the sun over a period, ignoring cloud: the share of the times tested, while the sun is up, that the sun reaches it.</p>
    <p><b>Surfaces:</b> choose the layer, or press the picker and click an object on it. Each object is tested on the side facing most nearly up; <b>Flip sides</b> tests the other side instead. <b>Ground/roof only</b> keeps just the parts facing within 45° of straight up, leaving out walls and the like.</p>
    <p>Under the results: the area analysed, and how much of it is in sun and shaded on average over the period.</p>
    <p><b>Date span</b> and <b>Time span</b> are periods round the date and time in the Date and Time widgets, shown beside each, both ends included: 1 week is three days either side, 1 hour half an hour either side. Every day in the dates is tested at the times, every <b>Interval</b>. Change the Date widget and the results follow it.</p>
    <p><b>Grid spacing</b> is the most distance between the points tested on the surfaces: closer gives a finer result and takes longer. The colours blend between the points.</p>
    <p>What shades the surfaces is what is shown: hide a layer or an object, and the results update without it. Times are the location’s clock time, as in the Time widget.</p>
    <p>With <b>Update automatically</b> off, the results stay as they are while you change the settings, which keeps long periods quick to set up. Tick it again to calculate.</p>
    <p>The results are not kept: they go when the model is closed.</p>` });
}

function bindExposurePanel() {
  toolsList = new ChoiceList({ label: 'Tools', onPick: (id) => { if (id === 'exposure') toggleExposurePanel(); } });
  toolsList.setGroups([{ items: [{ id: 'exposure', label: 'Sun exposure', title: 'How often surfaces see the sun over a period' }] }]);
  toolsMenu = new ToolbarMenu($('btnTools'), { label: 'Tools' });
  // Weather, thermal comfort and lights: the toolbar's controls for them, their on/off icons
  // included, live in this menu, above the analysis tools.
  const widgets = document.createElement('div'), rule = document.createElement('hr');
  widgets.className = 'tool-widgets';
  widgets.append($('weatherCombo'), document.querySelector('[data-act="comfort"]'), $('lightsCombo'));
  rule.className = 'tool-rule';
  toolsMenu.body.append(widgets, rule, toolsList.el);
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
    if (walker.active && e.pointerType === 'touch' && !stick) {
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
      drag = { mode, x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY, moved: false, button: e.button };
      // Top views turn about a dial whose middle is a fixed distance left of where the drag starts,
      // so the turn feels the same wherever it starts.
      if (mode === 'top') Object.assign(drag, { cx: e.clientX - innerWidth * DIAL_OFFSET, cy: e.clientY, at: 0 });
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
  const el = $('compassOverlay'), on = drag?.mode === 'top';
  el.hidden = !on;
  if (on) { el.style.left = `${drag.cx}px`; el.style.top = `${drag.cy}px`; }
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

// Right-drag in a view looking straight down: the whole window is a dial, like the compass, its
// middle at (drag.cx, drag.cy). The view turns about the point under that middle, which stays put.
const DIAL_OFFSET = 0.1; // of the window's width, left of where the drag starts
function turnByDial(e) {
  const x = e.clientX - drag.cx, y = e.clientY - drag.cy;
  if (Math.hypot(x, y) < 8) return;
  const a = Math.atan2(y, x), mid = toNdc({ clientX: drag.cx, clientY: drag.cy });
  const before = camera.planePoint(...mid);
  camera.yaw += wrapAngle(a - drag.at);
  camera.target = V3.add(camera.target, V3.sub(before, camera.planePoint(...mid)));
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
  walker.stick = [-dy / STICK_R, dx / STICK_R];
  const k = d > STICK_R ? STICK_R / d : 1, el = $('walkStick');
  el.firstElementChild.style.transform = `translate(${dx * k}px, ${dy * k}px)`;
  el.classList.toggle('run', walker.active && d / STICK_R > WALK.STICK_RUN);
}

// The driving pad: each button holds its control while pressed, so two can be held at once
// (gas with a steer, for instance).
for (const b of document.querySelectorAll('#drivePad [data-in]')) {
  const k = b.dataset.in;
  const release = () => { b.classList.remove('on'); driver.input[k] = false; };
  b.addEventListener('pointerdown', (e) => { e.preventDefault(); b.setPointerCapture(e.pointerId); b.classList.add('on'); driver.input[k] = true; });
  b.addEventListener('pointerup', release);
  b.addEventListener('pointercancel', release);
  b.addEventListener('lostpointercapture', release);
}

function endStick() {
  stick = null;
  walker.stick = null;
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
  if (cameraList) fillCameraMenu(); // Drive is listed in developer mode only
  if (!on) driver.exit();
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
  const el = $('diag'), on = state.devMode && !!model && !!renderer;
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
  let on = litLamps();
  if ((driver.active || driver.parked) && model) on = [...driver.headlamps(), ...on];
  if (driver.active && model) return on;
  if (!state.torch || !walker.active || !model) return on;
  const u = 1 / (METRES_PER_UNIT[model.units] || 1);
  const hand = V3.add(camera.eye, V3.add(V3.scale(camera.right, 0.2 * u), V3.scale(camera.up, -0.3 * u)));
  return [{ name: 'Torch', p: hand, dir: camera.forward, inner: 9, outer: 20, rgb: [1, 0.94, 0.84], power: 20, range: 40 }, ...on];
}

function toggleLightsPanel() {
  state.lightsPanel = !state.lightsPanel;
  $('lightsPanel').hidden = !state.lightsPanel;
  document.querySelector('[data-act="lights"]').setAttribute('aria-pressed', String(state.lightsPanel));
  syncToolsButton();
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
    <p>The switch at the top (or the bulb on the Lights button in the Tools menu) turns the file's and added lights on and off. While on, the ticked lights shine; with none ticked, all of them do. The torch has its own checkbox.</p>
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

// Widget shortcuts. A click (or keyboard focus) in a widget that has shortcuts makes it the active
// widget, marked on its title bar; a click in the view, or in a widget without them, ends that.
// Keys go to the active widget first, and on to the model when it doesn't use them.
const widgetKeys = new Map(); // panel id -> (keydown event) => true when the widget used the key
let activeWidget = null;
function setActiveWidget(p) {
  if (p === activeWidget) return;
  activeWidget?.classList.remove('active-widget');
  activeWidget = p;
  p?.classList.add('active-widget');
}
function bindWidgetKeys() {
  widgetKeys.set('layersPanel', rowListKeys(layerRows, (layers, row) => openMaterialDialog(layers, row)));
  widgetKeys.set('blocksPanel', rowListKeys(blockRows, (ids, row) => openBlockDialog(ids, row)));
  const pick = (e) => {
    const p = e.target.closest?.('.side .panel');
    if (p) setActiveWidget(widgetKeys.has(p.id) ? p : null);
    else if (e.target === canvas) setActiveWidget(null);
  };
  window.addEventListener('pointerdown', pick, true);
  window.addEventListener('focusin', pick, true);
}
function widgetKey(e) {
  if (!activeWidget) return false;
  if (activeWidget.hidden || !activeWidget.offsetParent) { setActiveWidget(null); return false; }
  return !!widgetKeys.get(activeWidget.id)?.(e);
}

// Shortcuts for a list of rows (Layers, Blocks): Ctrl+A all the rows, the arrows move the selection
// (Shift: extend it), Space shows or hides the selected rows (as clicking the first one's eye),
// Enter opens their window, Esc clears the selection.
function rowListKeys(rows, open) {
  return (e) => {
    const k = e.key, ctrl = e.ctrlKey || e.metaKey, sel = rows.list();
    const first = sel.length ? rows.rows.find((r) => r.key === sel[0]) : null;
    if (ctrl && !e.altKey && k.toLowerCase() === 'a') { rows.all(); return true; }
    if (ctrl || e.altKey) return false;
    if (k === 'ArrowDown' || k === 'ArrowUp') { rows.step(k === 'ArrowDown' ? 1 : -1, e.shiftKey); return true; }
    if (k === ' ' && first) { first.row.querySelector('.eye').click(); return true; }
    if (k === 'Enter' && first) { open(sel, first.row); return true; }
    if (k === 'Escape' && sel.length) { rows.set([]); return true; }
    return false;
  };
}

function onKey(e) {
  // A checkbox or radio button with the focus (as after clicking an eye) doesn't take the keys.
  const typing = !!e.target.matches?.('input:not([type="checkbox"], [type="radio"]), select, textarea');
  if (!typing && model && !walker.active && !driver.active && widgetKey(e)) { e.preventDefault(); return; }
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
    // F within 5 m of the parked car gets back in, as walking into it does.
    if (k === 'f' && driver.parked && !e.repeat) { if (driver.near(walker.pos, 5)) { e.preventDefault(); enterVehicle(); return; } }
    if (k === 'escape') { e.preventDefault(); leaveWalk(); return; }
  }
  if (driver.active) {
    if (driver.key(e, true)) { e.preventDefault(); if (k === 'c' || k === 't' || k === 'm') { syncDrivePanel(); savePrefs(); syncLightsPanel(); } return; }
    if (k === 'f' && !e.repeat) { e.preventDefault(); exitVehicle(); return; }
    if (k === 'escape') { e.preventDefault(); leaveWalk(); return; }
  }
  if (walker.placing && k === 'escape') { e.preventDefault(); walker.exit(); return; }
  if (driver.placing && k === 'escape') { e.preventDefault(); driver.exit(); return; }
  const actions = {
    f: zoomExtents,
    1: () => pickView('top'), 2: () => pickView('elevation'), 3: () => pickView('perspective'), 4: () => pickView('walk'), 5: () => { if (state.devMode) pickView('drive'); },
    m: () => setMode(MODES[(MODES.findIndex(([id]) => id === state.mode) + 1) % MODES.length][0]),
    e: () => toggle('showEdges'), c: () => toggle('showCurves'), x: () => toggle('xray'), o: () => toggle('ao'), l: () => toggle('layers'), k: () => { if (model.blocks.size) toggle('blocks'); }, s: toggleDatePanel,
    '?': toggleHelp, escape: () => {
      closeLayerMenu(); $('matDialog').hidden = true; $('blockDialog').hidden = true; $('fileDialog').hidden = true; selectObject(null); },
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
  if (id === 'drive') { if (state.devMode) { walker.exit(); startDrive(); } return; }
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
    { items: [...CAMERAS.map(([id, label, hint]) => ({ id, label, hint })), { id: 'walk', label: 'Walk', hint: '4' }, ...(state.devMode ? [{ id: 'drive', label: 'Drive', hint: '5' }] : [])] }]);
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
// An easter egg of developer mode: driving starts from Drive in the camera list (or 5), listed only
// in developer mode, always by choosing where to start, with the
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

// Exit vehicle (the Drive panel, or F): the car stays parked where it stopped, and walking starts
// just outside its driver's door, facing the way it faces. Walking into the car gets back in (the
// loop, Driver.touches); stopping walking takes the car away too, back to the camera from before.
let swapping = false;
function exitVehicle() {
  if (!driver.active || driver.pending || swapping) return;
  swapping = true;
  const f = $('walkFade');
  f.classList.add('dark');
  setTimeout(() => {
    const out = driver.park();
    $('drivePanel').hidden = true; $('driveHint').hidden = true;
    if (stick) endStick();
    // Walker.enter keeps the camera's heading: face the way the car does.
    camera.yaw = out.heading + Math.PI;
    walker.enter(out.p).then((ok) => {
      swapping = false;
      if (ok) { $('walkPanel').hidden = false; notice('Walk into the car, or press F near it, to drive it again.', false, 4000); }
      else driver.exit();
      f.classList.remove('dark'); syncToolbar(); syncWalkPanel(); syncLightsPanel(); redraw();
    });
    syncToolbar();
  }, 250);
}
function enterVehicle() {
  if (!driver.parked || swapping) return;
  swapping = true;
  walker.keys.clear(); walker.stick = null;
  const f = $('walkFade');
  f.classList.add('dark');
  setTimeout(() => {
    swapping = false;
    // Walking stops without going back to the camera from before, which driving keeps.
    const from = walkFrom;
    walkFrom = null;
    driver.resume();
    walker.exit();
    walkFrom = from;
    $('drivePanel').hidden = false;
    f.classList.remove('dark'); syncToolbar(); syncDrivePanel(); syncLightsPanel(); redraw();
  }, 250);
}

// The Drive panel -----------------------------------------------------------------------------

function showDriveHelp() {
  Dialog.open({ title: 'Driving', html: true, width: 420, body: `<p><b>Drive</b> in the camera list, or <kbd>5</kbd>, starts driving: click where the car should start. It faces the way the camera looks. Until you click you can still move the view; <kbd>Esc</kbd> cancels. Closing this panel does not stop you: pick Drive again to bring it back.</p>
    <p><kbd>W</kbd> or <kbd>↑</kbd> accelerates · <kbd>S</kbd> or <kbd>↓</kbd> brakes, then reverses · <kbd>A</kbd><kbd>D</kbd> or <kbd>←</kbd><kbd>→</kbd> steer · braking while steering pulls the handbrake, to slide round · <kbd>Space</kbd> horn · <kbd>T</kbd> headlights · <kbd>M</kbd> sounds · <kbd>F</kbd> gets out · <kbd>C</kbd> changes the camera · <kbd>R</kbd> puts the car back where it last stood firmly (as does driving off the model, or into water, which holds nothing up) · drag to look round · wheel to zoom · <kbd>Esc</kbd> or another camera to stop</p>
    <p>On a touch screen, the buttons along the bottom drive: <b>GO</b> accelerates, <b>BRK</b> brakes and reverses, and <b>&lsaquo;</b> <b>&rsaquo;</b> steer. Drag the view to look round. <b>Exit</b> in this panel stops driving.</p>
    <p>The car mounts kerbs up to 30 cm; anything higher, and lower than its roof, it bounces off. Slopes slow it down going up, and off a ramp or an edge it flies. Hidden layers and vegetation are driven through.</p>
    <p>The car's top speed is 160 km/h · <b>Collision detection</b> off drives through walls (the car still follows the ground) · <b>Shadows</b>: the car casts the sun's shadows; that redraws them every frame, which can be slow on big models · <b>Headlights</b> (<kbd>T</kbd>): two beams that light the model, best at night, as the walker's torch does. The brake and reversing lights come on by themselves · <b>Sounds</b> (<kbd>M</kbd>): the engine, crashes and the horn · <b>Music</b>: the car radio while you drive, a track at random each time you start: 80s synthwave, two old-school West Coast hip hop tracks or 90s shooter metal. <b>Change track</b> picks another at random.</p>
    <p><b>Exit vehicle</b> (<kbd>F</kbd>) gets out: the car stays where it is and you walk from beside its driver's door, on the left, or on the right where the location is in a country that drives on the left. Walk into the car, or press <kbd>F</kbd> within 5 m of it, to drive it again. Stopping walking takes the car away too.</p>` });
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
  $('driveSound').checked = S.sound;
  $('driveMusic').checked = S.music;
  $('driveTrack').textContent = driver.music.track.title;
  $('driveRadio').hidden = !S.music;
  syncDriveSpeed();
}

function bindDrivePanel() {
  const S = driver.settings, changed = () => { syncDrivePanel(); savePrefs(); };
  $('driveCam').innerHTML = DRIVE_CAMS.map((c, i) => `<option value="${i}">${c.label}</option>`).join('');
  $('driveCam').addEventListener('change', () => { S.cam = +$('driveCam').value; driver.camPos = null; changed(); canvas.focus(); });
  $('driveCollide').addEventListener('change', () => { S.collide = $('driveCollide').checked; changed(); canvas.focus(); });
  $('driveShadows').addEventListener('change', () => { S.shadows = $('driveShadows').checked; changed(); redraw(); canvas.focus(); });
  $('driveHeadlights').addEventListener('change', () => { S.headlights = $('driveHeadlights').checked; changed(); syncLightsPanel(); redraw(); canvas.focus(); });
  $('driveSound').addEventListener('change', () => { S.sound = $('driveSound').checked; changed(); canvas.focus(); });
  $('driveMusic').addEventListener('change', () => { S.music = $('driveMusic').checked; changed(); canvas.focus(); });
  $('driveNextTrack').addEventListener('click', () => { driver.music.pick(); syncDrivePanel(); canvas.focus(); });
  $('driveGetOut').addEventListener('click', exitVehicle);
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
// UTCI at the camera from the weather file at the Date and Time widgets' date and time: air temperature and
// humidity as they are, wind speed times the panel's wind factor (a stand-in for shelter), and a
// mean radiant temperature equal to the air temperature, raised when the camera is in sunlight by
// the direct sun on the person (SolarCal) and by sun-warmed surroundings (a placeholder).

function toggleComfortPanel() {
  const C = state.comfort;
  C.panel = !C.panel;
  $('comfortPanel').hidden = !C.panel;
  document.querySelector('[data-act="comfort"]').setAttribute('aria-pressed', String(C.panel));
  syncToolsButton();
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
  // With no UTCI to show, the minimised widget shows the sunlight line in the reading's place
  // (style.css). With no weather file at all there is no reading, only Add EPW in the title bar.
  $('comfortPanel').classList.toggle('no-utci', !!r.missing);
  $('comfortAdd').hidden = r.missing !== 'epw';
  $('comfortRead').hidden = r.missing === 'epw';
  const [sunCls, sunHtml] = sunState(r);
  $('comfortSun').className = 'sun-state ' + sunCls;
  setHtml($('comfortSun'), `<span class="dot"></span><span>${sunHtml}</span>`);
  if (r.missing) {
    $('comfortRead').style.removeProperty('--cat');
    setHtml($('comfortRead'), r.missing === 'epw' ? '' : '<span class="fine">The weather file has no temperature, humidity or wind at this time.</span>');
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
    <p>It is estimated at the camera, at the Date and Time widgets' date and time, from the weather file: the air temperature and humidity as they are, and the wind speed times the <b>wind factor</b>. The factor stands in for shelter, which the viewer cannot work out yet: 1 is the open-ground wind of the weather file, lower values are more sheltered. It starts at 0.5, a typical allowance for the shelter of streets and buildings compared with the open site where weather files are recorded (at 10 m, which is the height the UTCI expects). The UTCI was fitted for wind speeds from 0.5 m/s, so slower winds, including calm, are counted as 0.5 m/s.</p>
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
  $('comfortAdd').addEventListener('click', openAttachDialog);
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
    if (id.startsWith('view-')) { const item = id.slice(5); setWeatherView(item, !state.view[item]); }
    else if (id === 'specials') toggleSpecials();
    else if (RENDER_TOGGLES.some((t) => t.id === id)) toggle(id);
    else setMode(+id);
  } });
  // What the Weather widget can draw, each item hidden while there is no data for it.
  const weather = { id: 'weather', heading: 'Weather', items: VIEW_ITEMS.map((item) => ({ id: `view-${item}`, label: VIEW_LABELS[item], title: VIEW_TITLES[item], toggle: true })) };
  modeList.setGroups([{ items: RENDER_TOGGLES.map((t) => ({ ...t, toggle: true })) }, weather,
    { items: MODES.map(([id, label, title]) => ({ id: String(id), label, title })) }]);
  modeList.item('view-clouds').after($('cloudSpeedField')); // the cloud speed, under Clouds while they show
  new ToolbarMenu($('btnMode'), { label: 'Render mode', onOpen: syncViewChecks }).body.append(modeList.el);
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
  if (matKind === 'material') refreshMaterialDialog();
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
  refreshMaterialDialog();
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

// Projects -----------------------------------------------------------------------------------
// The viewer always has a project open. On load it is a blank one, with no files: it joins the
// list of projects (recent.js) once a file is opened into it. The 3DM Viewer button opens the
// projects menu: New, Open, the projects so far (newest first, with a filter) and Settings.

const UNTITLED = 'Untitled project';
let current = { id: Recent.newId(), name: UNTITLED, blank: true }; // the open project

function showProjectName() {
  $('fileName').textContent = current.name;
  $('fileName').title = model ? 'File properties' : current.name;
  document.title = `${current.name} · 3DM Viewer`;
}

// A new blank project: whatever was open is put away (its changes are saved as they happen).
function newProject() {
  thumbNow();
  flushStore();
  flushLinks();
  walker.exit();
  driver.exit();
  saveViewState();
  clearNotices();
  model = null;
  layerOn = [];
  renderer?.clearModel();
  resetObjectState();
  Object.assign(site, { custom: null, city: null, epws: [], epw: null, use: null });
  results = [];
  syncResults();
  applyLocation();
  for (const id of ['fileDialog', 'matDialog', 'blockDialog']) $(id).hidden = true;
  $('layerTree').innerHTML = '';
  $('blockList').innerHTML = '';
  $('undoRedo').hidden = true;
  clearHistory();
  attachDialog?.refresh();
  current = { id: Recent.newId(), name: UNTITLED, blank: true };
  showProjectName();
  redraw();
}

// Rhino, weather and results files can be opened or attached; so can a zip (a project), later.
const OPEN_TYPES = () => [...new Set(['.3dm', '.epw', ...RESULT_PARSERS.flatMap((p) => p.extensions)])];
const canAttach = (name) => /\.(3dm|epw)$/i.test(name) || resultParsersFor(name).length > 0;

// Files opened with Open (or dropped on a blank project) start a project: the blank one that is open, or
// a new one. Its name: the folder's, the first Rhino file's, or Untitled. Rhino files go in by handle, and
// weather and results files are attached once the model is open.
async function openEntries(entries, folderName = null) {
  // A zip opens as a project of its own.
  const zips = entries.filter(({ file }) => /\.zip$/i.test(file.name));
  for (const z of zips) await openZip(z.handle, z.file);
  const valid = entries.filter(({ file }) => canAttach(file.name));
  if (!valid.length) { if (!zips.length) notice('Nothing to open: choose Rhino (.3dm), weather (.epw) or results files, or a project zip.', true); return; }
  const rhino = valid.filter(({ file }) => /\.3dm$/i.test(file.name)), other = valid.filter((e) => !rhino.includes(e));
  // Files go into the open project while it has no model to show (a blank one, or one with no Rhino files yet).
  if (model) newProject();
  const name = current.blank ? folderName || rhino[0]?.file.name || UNTITLED : current.name;
  current.name = name;
  showProjectName();
  if (rhino.length && rhino.every((e) => e.handle) && Recent.supported) {
    await Recent.put(current.id, name, rhino);
    await showProject(current.id);
  } else if (rhino.length) {
    // Without file handles (this browser cannot keep them), the first Rhino file opens on its own.
    await openBytes(rhino[0].file.name, new Uint8Array(await rhino[0].file.arrayBuffer()));
  }
  for (const { file } of other) await openFile(file);
  renderRecent();
}

async function pickFiles() {
  if (!Recent.supported) { $('fileInput').click(); return; }
  let handles;
  try { handles = await window.showOpenFilePicker({ multiple: true, types: [{ description: 'Rhino, weather and results files, and project zips', accept: { 'application/octet-stream': [...OPEN_TYPES(), '.zip'] } }] }); }
  catch (e) { return; } // cancelled
  openEntries(await Promise.all(handles.map(async (handle) => ({ handle, file: await handle.getFile() }))));
}

// A folder: the files in it (not in folders inside it) that can be opened. They stay where they are.
async function openFolder(dir) {
  if (!dir) {
    if (!window.showDirectoryPicker) { notice('Opening a folder needs Chrome or Edge.', true); return; }
    try { dir = await window.showDirectoryPicker({ mode: 'read' }); } catch (e) { return; } // cancelled
  }
  const entries = [];
  for await (const h of dir.values()) if (h.kind === 'file' && canAttach(h.name)) entries.push({ handle: h, file: await h.getFile() });
  if (!entries.length) { notice(`${dir.name} has no Rhino, weather or results files in it.`, true); return; }
  entries.sort((a, b) => a.file.name.localeCompare(b.file.name));
  openEntries(entries, dir.name);
}

// Project zips --------------------------------------------------------------------------------
// A project saved as a zip holds a copy of each of its files and a project.json with its settings, so it opens
// the same wherever the viewer runs. A zip is only read: opening one makes a new project (with a new id) that
// reads its Rhino files from the zip in place; what changes after that is kept in the project, and Save as zip
// writes a new zip. A zip that is not a saved project opens as a project of the files in it.
//
// project.json: { format: '3dm-viewer-project', version: 1, name, saved,
//   files: [{ id, name, path, off }]   Rhino files. Their ids are kept: the saved changes and view refer to them.
//   epws: [{ id, name, path, off }], weather (an epws id), use (the location source), custom, city,
//   results: [{ name, path, off }], state: { edits, view } (see readStored),
//   thumbnail: the path of a small picture of the view, for the projects list }

const PROJECT_FORMAT = '3dm-viewer-project';
const safeFileName = (name) => name.replace(/[\\/:*?"<>|]/g, '_').trim() || 'Project';

// Where to save a file: asked first, while the click that asked for it still counts (the browser allows the
// question only then), so a long write can follow. Null if cancelled; 'download' where the browser cannot ask.
async function chooseSaveTarget(name, description, type, ext) {
  if (!window.showSaveFilePicker) return 'download';
  try { return await window.showSaveFilePicker({ suggestedName: name, types: [{ description, accept: { [type]: [ext] } }] }); }
  catch (e) { if (e.name === 'AbortError') return null; throw e; }
}
async function saveBlobTo(target, blob, name) {
  if (target === 'download') {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 60000);
    return;
  }
  const w = await target.createWritable();
  await w.write(blob);
  await w.close();
}

async function saveProjectZip() {
  if (!model?.projectId) { notice('There is nothing to save: open some files into the project first.', true); return; }
  const project = (await Recent.list()).find((p) => p.id === model.projectId);
  if (!project) return;
  const zipName = `${safeFileName(project.name.replace(/\.3dm$/i, ''))}.zip`;
  const picture = thumbNow(); // the view as it is now, before the save dialog covers it
  const target = await chooseSaveTarget(zipName, 'Project zip', 'application/zip', '.zip');
  if (!target) return;
  saveViewState();
  flushStore();
  flushLinks();
  await Recent.serial(async () => {}); // settings changed just before are saved first
  const fresh = (await Recent.list()).find((p) => p.id === project.id) || project;
  const used = new Set();
  const pathFor = (dir, name) => {
    let p = `${dir}/${name}`;
    for (let n = 2; used.has(p.toLowerCase()); n++) p = `${dir}/${name.replace(/(\.[^.]*)?$/, (ext) => ` (${n})${ext}`)}`;
    used.add(p.toLowerCase());
    return p;
  };
  const json = { format: PROJECT_FORMAT, version: 1, name: fresh.name, saved: new Date().toISOString(), files: [], epws: [], results: [],
    weather: fresh.weather ?? null, use: fresh.use ?? null, custom: fresh.custom ?? null, city: fresh.city ?? null, state: model.stored || {} };
  const entries = [];
  try {
    for (const f of fresh.files) {
      showBusy(`Reading ${f.name}`, 0.02);
      const blob = await projectFileBlob(f);
      if (!blob) { notice(`Permission to read ${f.name} was not given, so the zip was not saved.`, true); return; }
      const path = pathFor('models', f.name);
      json.files.push({ id: f.id, name: f.name, path, off: !!f.off });
      entries.push({ name: path, data: blob });
    }
    for (const e of fresh.epws || []) {
      const path = pathFor('weather', e.name);
      json.epws.push({ id: e.id, name: e.name, path, off: !!e.off });
      entries.push({ name: path, data: e.bytes });
    }
    for (const r of fresh.results || []) {
      const bytes = await Recent.resultBytes(r.id);
      if (!bytes) continue;
      const path = pathFor('results', r.name);
      json.results.push({ name: r.name, path, off: !!r.off });
      entries.push({ name: path, data: bytes });
    }
    const t = (await picture) || (await Recent.loadThumb(fresh.id));
    if (t instanceof Blob) {
      json.thumbnail = t.type === 'image/png' ? 'thumbnail.png' : 'thumbnail.webp';
      entries.push({ name: json.thumbnail, data: t });
    }
    entries.unshift({ name: 'project.json', data: JSON.stringify(json, null, 1) });
    const zip = await Zip.write(entries, (f, name) => showBusy(name ? `Adding ${name} to the zip` : 'Finishing the zip', 0.05 + 0.85 * f));
    showBusy(`Saving ${zipName}`, 0.95);
    await saveBlobTo(target, zip, zipName);
    notice(`Saved ${target === 'download' ? zipName : target.name}.`, false, 4000);
  } catch (e) {
    console.error(e);
    notice(`Could not save the project as a zip: ${e.message || e}`, true);
  } finally {
    hideBusy();
  }
}

// Opens a zip as a new project. handle: the zip's file handle, which the project keeps to read its Rhino files
// from; without one (a browser that cannot keep it), the zip's Rhino files open for this session only.
async function openZip(handle, file = null) {
  try {
    file ??= await handle.getFile();
    showBusy(`Reading ${file.name}`, 0.02);
    const entries = await Zip.entries(file), byPath = new Map(entries.map((e) => [e.name, e]));
    const bytesOf = async (e) => new Uint8Array(await (await Zip.read(file, e)).arrayBuffer());
    let json = null;
    if (byPath.has('project.json')) {
      try { json = JSON.parse(new TextDecoder().decode(await bytesOf(byPath.get('project.json')))); } catch (e) { json = null; }
      if (json?.format !== PROJECT_FORMAT) json = null;
    }
    if (json?.version > 1) notice(`${file.name} was saved by a newer version of the viewer: some of its settings may not come back.`, true);
    const leaf = (p) => p.split('/').pop();
    const listed = (test) => entries.filter((e) => test(e.name)).map((e) => ({ id: Recent.newId(), name: leaf(e.name), path: e.name, off: false }));
    const fileList = (json ? json.files || [] : listed((n) => /\.3dm$/i.test(n))).filter((f) => byPath.has(f.path));
    const epwList = (json ? json.epws || [] : listed((n) => /\.epw$/i.test(n))).filter((e) => byPath.has(e.path));
    const resList = (json ? json.results || [] : listed((n) => resultParsersFor(n).length > 0)).filter((r) => byPath.has(r.path));
    if (!fileList.length && !epwList.length && !resList.length) { notice(`${file.name} has no Rhino, weather or results files in it.`, true); return; }
    const name = file.name.replace(/\.zip$/i, '');
    if (!handle || !Recent.supported) {
      if (!fileList.length) { notice(`${file.name} has no Rhino files in it.`, true); return; }
      notice(`This browser cannot keep ${file.name}, so it is open for this session only.`, false, 6000);
      const sources = [];
      for (const f of fileList) if (!f.off) sources.push({ name: f.name, bytes: await bytesOf(byPath.get(f.path)), handle: null });
      await openScene(sources);
      return;
    }
    // The weather and results files are copied into the project (they are small); the Rhino files stay in the zip.
    const id = Recent.newId();
    const epws = [];
    for (const e of epwList) epws.push({ id: e.id, name: e.name, bytes: await bytesOf(byPath.get(e.path)), off: !!e.off });
    const results = [];
    for (const r of resList) {
      const rid = newId(), z = byPath.get(r.path);
      await Recent.putResult(rid, await bytesOf(z));
      results.push({ id: rid, name: r.name, size: z.size, off: !!r.off });
    }
    const files = fileList.map((f) => ({ id: f.id, name: f.name, size: byPath.get(f.path).size, zip: handle, entry: f.path, off: !!f.off }));
    const epwIds = new Set(epws.map((e) => e.id));
    const use = typeof json?.use === 'string' && (!json.use.startsWith('epw:') || epwIds.has(json.use.slice(4))) ? json.use : null;
    const weather = epwIds.has(json?.weather) ? json.weather : epws.find((e) => !e.off)?.id ?? null;
    await Recent.create({ id, name, files, epws, weather, use, custom: json?.custom ?? null, city: json?.city ?? null, results });
    if (json?.state && typeof json.state === 'object') await Recent.saveState(id, json.state);
    // Its thumbnail shows in the projects list straight away.
    const pic = typeof json?.thumbnail === 'string' && byPath.get(json.thumbnail);
    if (pic) await Recent.saveThumb(id, new Blob([await bytesOf(pic)], { type: json.thumbnail.endsWith('.png') ? 'image/png' : 'image/webp' }));
    if (model) newProject();
    current = { id, name, blank: false };
    showProjectName();
    if (files.length) await showProject(id);
    else notice(`${name} has no Rhino files yet: attach one to see the model.`, false, 6000);
    renderRecent();
  } catch (e) {
    console.error(e);
    notice(`Could not open ${file?.name || 'the zip'}: ${e.message || e}`, true);
  } finally {
    hideBusy();
  }
}

// The projects menu: built once, filled each time it opens (and when the list changes while it is open).
let projectsMenu = null;
function bindProjectsMenu() {
  projectsMenu = new ToolbarMenu($('btnHome'), { label: 'Projects', below: true, onOpen: () => { filter.value = ''; queueMicrotask(renderRecent); } }); // filled once it is open
  projectsMenu.el.classList.add('projects-menu');
  projectsMenu.body.innerHTML = `
    <div class="proj-actions">
      <button class="btn small" data-act="new" title="A new, blank project">New</button>
      <button class="btn small" data-act="open" title="Open Rhino, weather or results files as a new project, or a project zip">Open files…</button>
      <button class="btn small" data-act="folder" title="Open the files in a folder as a new project, named after it">Open folder…</button>
      <button class="btn small" data-act="zip" title="Save this project, with a copy of each of its files and its settings, as a zip that opens anywhere">Save as zip…</button>
    </div>
    <input type="search" class="proj-filter" placeholder="Filter projects and files" aria-label="Filter projects by name or file name">
    <div class="proj-list" role="list"></div>
    <div class="proj-foot">
      <button class="link" data-act="demo">Open the demo model</button>
      <button class="btn icon" data-act="settings" title="Settings" aria-label="Settings"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z"/></svg></button>
    </div>`;
  const filter = projectsMenu.body.querySelector('.proj-filter');
  filter.addEventListener('input', renderRecent);
  const act = { new: newProject, open: pickFiles, folder: () => openFolder(), zip: saveProjectZip, demo: openDemo, settings: openSettings };
  projectsMenu.body.addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    projectsMenu.close();
    act[b.dataset.act]();
  });
}

const PROJECT_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2 3 7v10l9 5 9-5V7l-9-5Zm0 2.3 6.6 3.7L12 11.7 5.4 8 12 4.3ZM5 9.7l6 3.4v6.6l-6-3.4V9.7Zm8 10v-6.6l6-3.4v6.6l-6 3.4Z"/></svg>';
const thumbUrls = []; // object URLs of the thumbnails shown, let go when the list is filled again

// The list of projects in the menu, newest first, filtered by the project's name and its files' names.
async function renderRecent() {
  if (!projectsMenu?.isOpen) return;
  const list = await Recent.list(), box = projectsMenu.body.querySelector('.proj-list');
  const q = projectsMenu.body.querySelector('.proj-filter').value.trim().toLowerCase();
  const fileNames = (r) => [...r.files.map((f) => f.name), ...(r.epws || []).map((e) => e.name), ...(r.results || []).map((x) => x.name)];
  const shown = list.filter((r) => !q || [r.name, ...fileNames(r)].some((n) => n?.toLowerCase().includes(q)));
  const date = (t) => new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
  box.replaceChildren();
  thumbUrls.splice(0).forEach((u) => URL.revokeObjectURL(u));
  if (!Recent.supported) { box.innerHTML = '<div class="fine">Projects are kept in Chrome and Edge only.</div>'; return; }
  if (!shown.length) { box.innerHTML = `<div class="fine">${list.length ? 'No project matches.' : 'No projects yet. Open some files to start one.'}</div>`; return; }
  for (const r of shown) {
    const row = document.createElement('div');
    row.className = 'proj-row' + (r.id === current.id ? ' current' : '');
    row.setAttribute('role', 'listitem');
    row.innerHTML = `<button class="proj-open"><span class="proj-thumb">${PROJECT_ICON}</span><span class="proj-text"><span class="proj-name"></span><span class="proj-info"></span></span></button><button class="x" aria-label="Remove from the list" title="Remove from the list">×</button>`;
    // The thumbnail of the project's view, when it has one; the cube until then.
    Recent.loadThumb(r.id).then((b) => {
      if (!(b instanceof Blob) || !row.isConnected) return;
      const img = new Image(), url = URL.createObjectURL(b);
      thumbUrls.push(url);
      img.src = url;
      img.alt = '';
      row.querySelector('.proj-thumb').replaceChildren(img);
    });
    const n = fileNames(r).length;
    row.querySelector('.proj-name').textContent = r.name;
    row.querySelector('.proj-info').textContent = [`${n} file${n === 1 ? '' : 's'}`, `opened ${date(r.opened)}`].join(' · ');
    row.querySelector('.proj-open').title = [r.name, ...fileNames(r)].join('\n');
    // The menu stays open, so one project after another can be looked at.
    row.querySelector('.proj-open').addEventListener('click', () => openRecent(r));
    row.querySelector('.x').addEventListener('click', async () => { await Recent.remove(list.indexOf(r)); renderRecent(); });
    box.append(row);
  }
}

// Settings: a placeholder for the settings that are the viewer's own rather than a project's.
function openSettings() {
  const body = document.createElement('div');
  body.innerHTML = `<p class="fine">Settings that apply to every project will go here.</p>
    <label class="fine"><input type="checkbox" data-el="dev"> Developer mode</label>`;
  const dev = body.querySelector('[data-el="dev"]');
  dev.checked = !!state.devMode;
  dev.addEventListener('change', () => setDevMode(dev.checked));
  Dialog.open({ title: 'Settings', body, buttons: [{ label: 'Close', value: true, primary: true }], width: 380 });
}

// The demo model built into the page (src/demo.js, from tools/make-demo.js): a small site in
// London with a few blocks and shades, for trying the viewer without a Rhino file.
async function openDemo() {
  showBusy('Opening the demo model', 0.02);
  await openBytes('Demo.3dm', Uint8Array.from(atob(DEMO_3DM), (c) => c.charCodeAt(0)));
}

// A project file's contents as a Blob: its own file, or its entry in the zip the project was opened from (read
// in place: nothing is unpacked). Null when the browser was not given permission to read it.
async function projectFileBlob(f) {
  const h = f.zip || f.handle;
  if (!h) return null;
  if ((await h.queryPermission({ mode: 'read' })) !== 'granted' && (await h.requestPermission({ mode: 'read' })) !== 'granted') return null;
  const file = await h.getFile();
  if (!f.zip) return file;
  const e = (await Zip.entries(file)).find((x) => x.name === f.entry);
  if (!e) throw Object.assign(new Error(`${f.entry} is not in ${file.name}`), { name: 'NotFoundError' });
  return Zip.read(file, e);
}

// Opens a project: all its Rhino files, together as one model. given: a file already read, { file, fileId },
// so it is not read again. The browser asks once per session before it can read a file again.
async function showProject(projectId, given = null) {
  const project = (await Recent.list()).find((p) => p.id === projectId);
  if (!project) return;
  const files = project.files.filter((f) => !f.off && (f.handle || f.zip || (given && f.id === given.fileId)));
  if (!files.length) { notice(`Nothing in ${project.name} is active. Tick a file in Attach files to show it.`, true); renderRecent(); return; }
  try {
    const sources = [];
    for (const f of files) {
      let blob = given && f.id === given.fileId ? given.file : null;
      if (!blob) { showBusy(`Reading ${f.name}`, 0.02); blob = await projectFileBlob(f); }
      if (!blob) { notice(`Permission to read ${f.name} was not given, so it is not in the view.`, true); continue; }
      sources.push({ key: f.id, name: f.name, bytes: new Uint8Array(await blob.arrayBuffer()), handle: f.handle ?? null, zip: f.zip ?? null, entry: f.entry ?? null });
    }
    if (!sources.length) { hideBusy(); return; }
    // The view open now is saved, and written, before the project's saved state is read: reopening the
    // project that is open must find the view as it is, not the one saved before it.
    saveViewState();
    await flushStore();
    const stored = (await Recent.loadState(projectId)) || {};
    await openScene(sources, { projectId, stored });
    if (model?.projectId === projectId) { current = { id: projectId, name: project.name, blank: false }; showProjectName(); }
  } catch (e) {
    hideBusy();
    notice(e.name === 'NotFoundError' ? `A file in ${project.name} could not be found. It may have been moved, renamed or deleted; remove it from the project in Attach files.` : `Could not open ${project.name}: ${e.message}`, true);
  }
  renderRecent();
  attachDialog?.refresh();
}
const openRecent = (r) => showProject(r.id);

// Takes a Rhino file off the open model's project, and out of the view.
async function detachRhinoFile(fileId) {
  await Recent.detach(model.projectId, fileId);
  renderRecent();
  await showProject(model.projectId);
}

// Makes a Rhino file of the open model active (in the view) or not, and shows the view again.
async function setRhinoFileOn(fileId, on) {
  await Recent.setFileOn(model.projectId, fileId, on);
  renderRecent();
  await showProject(model.projectId);
}

// Makes a weather file active or not. An inactive one is not offered as a location or weather source; if it
// was the weather data source, another active one takes its place, or none.
function setEpwOn(id, on) {
  const e = site.epws.find((x) => x.id === id);
  if (!e) return;
  e.off = !on;
  if (!on) {
    if (site.epw?.id === id) site.epw = site.epws.find((x) => !x.off) ?? null;
    if (site.use === `epw:${id}`) site.use = null;
  }
  linkToModel({ epws: epwLinks(), weather: site.epw?.id ?? null, use: site.use });
  applyLocation();
  syncResults();
}

function bindUi() {
  const input = $('fileInput');
  // The plain file input is the fallback where the file picker (and so file handles) is not available.
  input.multiple = true;
  input.accept = OPEN_TYPES().join(',');
  bindProjectsMenu();
  showProjectName();
  $('btnLocation').addEventListener('click', openLocationDialog);
  $('btnWeather').addEventListener('click', openWeatherDialog);
  $('btnResultsFiles').addEventListener('click', openAttachDialog);
  $('btnMessages').addEventListener('click', openMessages);
  input.addEventListener('change', () => { const files = [...input.files]; input.value = ''; if (files.length) openEntries(files.map((file) => ({ file, handle: null }))); });

  // Only a drag that carries files shows the drop screen. Any other (text, a link, an image) can
  // still be dropped into a text box, and elsewhere is refused, so a link can't open over the model.
  const drop = $('drop'), hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
  const editable = (e) => e.target instanceof Element && !!e.target.closest('input, textarea, [contenteditable]');
  let depth = 0;
  window.addEventListener('dragenter', (e) => { if (!hasFiles(e)) return; e.preventDefault(); if (++depth === 1) { drop.hidden = false; drop.classList.add('over'); } });
  window.addEventListener('dragleave', (e) => { if (!hasFiles(e) || !depth) return; if (--depth === 0) { drop.classList.remove('over'); drop.hidden = true; } });
  window.addEventListener('dragover', (e) => {
    if (hasFiles(e)) e.preventDefault();
    else if (!editable(e)) { e.preventDefault(); e.dataTransfer.dropEffect = 'none'; }
  });
  // Dropped files are added to the open project; on a blank project they start it. A folder opens as a new project.
  window.addEventListener('drop', async (e) => {
    if (!hasFiles(e)) { if (!editable(e)) e.preventDefault(); return; }
    e.preventDefault(); depth = 0; drop.classList.remove('over');
    drop.hidden = true;
    // The handles have to be requested before anything else is awaited.
    const files = [...e.dataTransfer.files], items = [...e.dataTransfer.items].filter((i) => i.kind === 'file');
    const asked = Recent.supported ? items.map((i) => i.getAsFileSystemHandle?.()) : [];
    const handles = await Promise.all(asked.map((p) => Promise.resolve(p).catch(() => null)));
    const dir = handles.find((h) => h?.kind === 'directory');
    if (dir) { openFolder(dir); return; }
    let entries = files.map((file, i) => ({ file, handle: handles[i]?.kind === 'file' ? handles[i] : null }));
    // A project zip opens as a new project.
    for (const z of entries.filter(({ file }) => /\.zip$/i.test(file.name))) await openZip(z.handle, z.file);
    entries = entries.filter(({ file }) => !/\.zip$/i.test(file.name));
    if (!entries.length) return;
    if (!model) { openEntries(entries); return; }
    const rhino = entries.filter(({ file }) => /\.3dm$/i.test(file.name));
    if (rhino.length) await attachRhinoFiles(rhino);
    for (const { file, handle } of entries) if (!rhino.some((r) => r.file === file)) await openFile(file, handle);
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
  document.querySelector('[data-act="time"]').addEventListener('click', toggleTimePanel);
  bindCompass();
  $('dateClose').addEventListener('click', () => state.datePanel && toggleDatePanel());
  $('timeClose').addEventListener('click', () => state.timePanel && toggleTimePanel());
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
  for (const [btn, panel] of [['[data-act="date"]', 'datePanel'], ['[data-act="time"]', 'timePanel'], ['#weatherQuick', 'weatherPanel'], ['[data-act="comfort"]', 'comfortPanel'],
    ['#lightsQuick', 'lightsPanel'], ['[data-toggle="layers"]', 'layersPanel'], ['[data-toggle="blocks"]', 'blocksPanel'], ['#btnResults', 'streamlinesPanel'], ['#btnResults', 'mapPanel']]) {
    const title = $(panel).querySelector('.panel-head > span');
    title.classList.add('panel-title');
    title.prepend(document.querySelector(`${btn} svg`).cloneNode(true));
  }
  bindLightsPanel();
  bindComfortPanel();
  bindExposurePanel();
  window.addEventListener('keydown', onKey);
  const setShift = (on) => { if (shiftDown !== on) { shiftDown = on; syncWalkPanel(); } };
  window.addEventListener('keydown', (e) => { if (e.key === 'Shift') setShift(true); });
  window.addEventListener('keyup', (e) => { if (e.key === 'Shift') setShift(false); walker.key(e, false); driver.key(e, false); });
  window.addEventListener('blur', () => { setShift(false); walker.blur(); driver.blur(); });
  bindWalkPanel();
  bindDrivePanel();
  bindPointer();
  bindWidgetKeys();
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
