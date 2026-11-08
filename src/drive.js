// Drive mode: a car to drive around the model, with WASD / arrow keys, and a chase camera.
//
// The handling is an arcade one, after the Proving Ground: the car accelerates and brakes along
// its heading, its sideways speed bleeds away with the tyres' grip (the handbrake, braking while
// steering at speed, lets it
// slide), and it turns as a bicycle with a 2.7 m wheelbase would. Slopes slow it going up and
// speed it going down; off a ramp or an edge it flies under gravity and lands.
//
// It senses the model as the walker does (Renderer.probe, walk.js), with a wider footprint that
// grows with speed: a ground map below roof height, and four views looking out sideways between
// kerb height and the roof. The ground under each wheel gives the car's height, pitch and roll.
// Anything higher than a kerb (CLIMB) above the plane the wheels sit in, and lower than the roof,
// is an obstacle: the car's body, two circles one behind the other, is pushed out of it and
// bounces off. Results arrive a frame or two late, which the wider footprint covers.
//
// The car is drawn by the renderer as its actor (Renderer.setActor), placed each frame. Its own
// geometry is in metres, x forward, y to the left and z up, with the ground at z = 0.
//
// Water is no ground: the car drops through it with a splash and goes back, as off the model.
//
// Out of the car (Exit vehicle) it stays parked where it stopped, and the person walks from its
// driver's door; walking into it again gets back in (main.js, park, resume and touches below).
//
// All lengths here are in metres; the model is in its own units (mpu = metres per unit).

const DRIVE = {
  ACC: 10,           // acceleration (m/s²) at a standstill, falling to nothing at the top speed
  BRAKE: 20,         // braking (m/s²)
  REV_ACC: 6,        // reversing
  REV_MAX: 7,        // top speed in reverse (m/s)
  COAST: 2.2,        // slowing (m/s²) with neither pedal pressed
  TOP: 160,          // top speed (km/h)
  GRIP: 9,           // how fast sideways sliding dies away (1/s)
  HAND_GRIP: 1.1,    // the same with the handbrake on
  HAND_TURN: 1.6,    // the handbrake makes the car turn this much more sharply
  STEER: 0.58,       // full steering angle (radians) at a standstill; less at speed
  WHEELBASE: 2.7,
  TRACK: 1.62,       // between the left and right wheels
  AXLE: 1.35,        // the axles are this far in front of and behind the middle
  BODY_R: 1.05,      // the body is two circles of this radius...
  BODY_OFF: 1.15,    // ...this far in front of and behind the middle
  CLIMB: 0.3,        // highest kerb the car mounts
  SLOPE: 0.58,       // steepest ramp driven onto (tan 30°); steeper is a wall
  ROOF: 1.5,        // obstacles below this block
  DROP: 0.35,        // the ground falling away by more than this in a frame: the car flies
  GRAVITY: 20,       // stronger than real gravity, so jumps don't hang
  WHEEL_R: 0.15,     // the ground under a wheel is the highest surface within this
  HALF: 4,           // the ground map covers ±this around the car...
  LOOKAHEAD: 0.15,   // ...plus this many seconds of travel
  SUBSTEP: 0.2,      // longest single move, so thin walls cannot be driven through
  TILT_EASE: 0.08,   // time constant for pitch and roll following the ground
  LOST: 3,           // seconds flying with nothing below before going back
  LEDGE: 3.5,        // off a ledge, its edge is no obstacle within this of where the car left
  LOCK: 0.8,         // seconds the controls are locked after going back
  SINK: 0.05,        // water (by its layer's magic material) holds nothing up: this far into it, a splash...
  SPLASHED: 0.3,     // ...and this many seconds later, back to where the car last stood. Meanwhile
                     // the camera stays put, watching the car go under, rather than following it down
  MIN_FOV: 25,       // field of view range (degrees) for zooming with the mouse wheel
  MAX_FOV: 80,
};

// The cameras: behind the car, further back and higher, and at the driver's eyes.
const DRIVE_CAMS = [
  { id: 'chase', label: 'Chase', back: 7.5, up: 2.6, ahead: 3, at: 1.1, ease: 5 },
  { id: 'far', label: 'High', back: 16, up: 8, ahead: 4, at: 0.8, ease: 3 },
  { id: 'driver', label: 'Driver', eye: [0.15, 0.35, 1.2] }, // on the left: mirrored by Driver.side
];

const DRIVE_KEYS = { w: 'gas', arrowup: 'gas', s: 'brake', arrowdown: 'brake', a: 'left', arrowleft: 'left', d: 'right', arrowright: 'right', ' ': 'horn' };
const HAND_SPEED = 2; // braking while steering above this (m/s, going forwards) is the handbrake

// The car's lamps: their colours unlit and lit. Lit, they glow (Renderer.setActor).
const LAMPS = {
  head: { off: [205, 205, 196], on: [255, 246, 220] },
  tail: { off: [120, 18, 22], on: [255, 30, 24] },
  reverse: { off: [178, 180, 184], on: [255, 255, 250] },
};
// The headlights' beams, for the renderer's lamps: from the lamps, dipped a little.
const HEADLIGHT = { at: [2.2, 0.68, 0.66], dip: 0.06, inner: 12, outer: 30, rgb: [1, 0.95, 0.85], power: 60, range: 70 };

// The car's shape: flat-shaded panels, so each face has its own vertices.
function carGeometry() {
  const pos = [], nrm = [], col = [], idx = [], lamps = {};
  // The vertices drawn by fn are one of the car's lamps (see Driver.syncLamps).
  const lamp = (name, fn) => { const s = pos.length / 3; fn(); (lamps[name] ||= []).push([s, pos.length / 3]); };
  const tri = (a, b, c, rgb) => {
    const n = V3.norm(V3.cross(V3.sub(b, a), V3.sub(c, a))), i = pos.length / 3;
    for (const p of [a, b, c]) { pos.push(...p); nrm.push(...n); col.push(...rgb, 255); }
    idx.push(i, i + 1, i + 2);
  };
  const quad = (a, b, c, d, rgb) => { tri(a, b, c, rgb); tri(a, c, d, rgb); };
  const fan = (pts, rgb) => { for (let i = 1; i < pts.length - 1; i++) tri(pts[0], pts[i], pts[i + 1], rgb); };
  // A side profile (x forward, z up, convex) pushed out to each side by width(z), with the faces
  // round its edge coloured by faceRgb(i) (the edge from point i to the next).
  const loft = (profile, width, sideRgb, faceRgb) => {
    const L = profile.map(([x, z]) => [x, width(z), z]), R = profile.map(([x, z]) => [x, -width(z), z]);
    fan(L, sideRgb); fan(R, sideRgb);
    for (let i = 0; i < profile.length; i++) {
      const j = (i + 1) % profile.length, rgb = faceRgb(i);
      if (rgb) quad(L[i], L[j], R[j], R[i], rgb);
    }
  };
  const box = (x0, x1, y0, y1, z0, z1, rgb) => {
    const c = (i) => [i & 1 ? x1 : x0, i & 2 ? y1 : y0, i & 4 ? z1 : z0];
    for (const f of [[0, 1, 3, 2], [4, 6, 7, 5], [0, 4, 5, 1], [2, 3, 7, 6], [0, 2, 6, 4], [1, 5, 7, 3]]) quad(...f.map(c), rgb);
  };
  // A disc or short cylinder about the y axis, centred at (x, y, z).
  const wheel = (x, y, z, r, w, rgb, capRgb, segs = 16) => {
    const ring = (yy, rr) => Array.from({ length: segs }, (_, k) => [x + rr * Math.cos((k / segs) * 2 * Math.PI), yy, z + rr * Math.sin((k / segs) * 2 * Math.PI)]);
    const a = ring(y - w / 2, r), b = ring(y + w / 2, r);
    for (let k = 0; k < segs; k++) quad(a[k], a[(k + 1) % segs], b[(k + 1) % segs], b[k], rgb);
    fan(a, rgb); fan(b, rgb);
    const out = y > 0 ? 1 : -1;
    fan(ring(y + out * (w / 2 + 0.005), r * 0.62), capRgb);
  };

  // The part of a disc about the y axis above zMin: a wheel arch on the body's side, which
  // stops at the sill rather than hanging below it.
  const arch = (x, y, z, r, zMin, rgb, segs = 20) => {
    const a0 = Math.asin(Math.max(-1, Math.min(1, (zMin - z) / r))), pts = [];
    for (let k = 0; k <= segs; k++) {
      const t = a0 + ((Math.PI - 2 * a0) * k) / segs;
      pts.push([x + r * Math.cos(t), y, z + r * Math.sin(t)]);
    }
    fan(pts, rgb);
  };
  // A short tube along the x axis, from x0 to x1: the exhaust.
  const tube = (x0, x1, y, z, r, rgb, segs = 10) => {
    const ring = (x) => Array.from({ length: segs }, (_, k) => [x, y + r * Math.cos((k / segs) * 2 * Math.PI), z + r * Math.sin((k / segs) * 2 * Math.PI)]);
    const a = ring(x0), b = ring(x1);
    for (let k = 0; k < segs; k++) quad(a[k], a[(k + 1) % segs], b[(k + 1) % segs], b[k], rgb);
    fan(b, [10, 10, 11]);
  };
  const PAINT = [196, 38, 30], GLASS = [34, 44, 56], TYRE = [26, 27, 29], RIM = [176, 180, 186], TRIM = [40, 42, 46], ARCH = [18, 18, 20];
  // The body: a wedge from the nose to the boot, a little narrower at the top.
  loft([[2.15, 0.32], [2.2, 0.55], [2.06, 0.78], [0.95, 0.97], [-1.55, 1.02], [-2.12, 0.96], [-2.2, 0.6], [-2.15, 0.32]],
    (z) => 0.95 - Math.max(0, z - 0.75) * 0.25, PAINT, () => PAINT);
  // The glasshouse: tinted glass all round, the roof in the paint colour.
  loft([[0.92, 0.97], [-0.05, 1.47], [-0.95, 1.45], [-1.5, 1.01]], (z) => 0.87 - (z - 0.97) * 0.36, GLASS, (i) => (i === 1 ? PAINT : i === 3 ? null : GLASS));
  // Bumpers, grille and lights.
  box(2.1, 2.26, -0.93, 0.93, 0.3, 0.47, TRIM);
  box(-2.27, -2.1, -0.93, 0.93, 0.3, 0.47, TRIM);
  box(-2.205, -2.17, -0.26, 0.26, 0.5, 0.61, [236, 196, 44]); // number plate
  tube(-2.34, -2.0, -0.55, 0.27, 0.045, [120, 122, 126]);     // exhaust
  box(2.15, 2.215, -0.38, 0.38, 0.5, 0.64, TRIM);
  for (const s of [1, -1]) {
    lamp('head', () => box(2.1, 2.2, s > 0 ? 0.5 : -0.86, s > 0 ? 0.86 : -0.5, 0.6, 0.71, LAMPS.head.off));
    lamp('tail', () => box(-2.225, -2.16, s > 0 ? 0.58 : -0.88, s > 0 ? 0.88 : -0.58, 0.72, 0.84, LAMPS.tail.off));
    lamp('reverse', () => box(-2.22, -2.165, s > 0 ? 0.42 : -0.56, s > 0 ? 0.56 : -0.42, 0.72, 0.84, LAMPS.reverse.off));
    box(0.62, 0.8, s * 0.95, s * 1.07, 1.0, 1.1, PAINT);  // door mirrors
  }
  // Wheels, with dark arches behind them down to the sill.
  for (const x of [DRIVE.AXLE, -DRIVE.AXLE])
    for (const s of [1, -1]) {
      arch(x, s * 0.953, 0.34, 0.45, 0.32, ARCH);
      wheel(x, s * 0.86, 0.34, 0.34, 0.24, TYRE, RIM);
    }
  return { pos: Float32Array.from(pos), nrm: Float32Array.from(nrm), col: Uint8Array.from(col), idx: Uint32Array.from(idx), gloss: 0.55, lamps };
}

// The engine and crashes, synthesised as the Proving Ground's are: two oscillators through a
// low-pass filter for the engine, its pitch rising through five gears; filtered noise and a falling
// thud for a crash. The audio starts with driving, which always follows a click or a key press.
// The gears: the speed (km/h) at which each changes up, at SHIFT_REVS; top gear revs out at the
// top speed. Short lower gears, so top gear sounds all the faster.
const GEARS = [0, 30, 60, 90, 120, 999];
const SHIFT_REVS = 0.9;
const WIND_FROM = 60;   // km/h: the wind starts above this...
const WIND_LEVEL = 0.053; // ...and is this loud at the top speed: under the engine
const SCREECH_LEVEL = 0.14; // the tyres at full slide: about as loud as the engine
class DriveSound {
  constructor() { this.audio = null; this.failed = false; }

  ensure() {
    if (this.audio || this.failed) return this.audio;
    try {
      const ac = new (window.AudioContext || window.webkitAudioContext)();
      const o1 = ac.createOscillator(); o1.type = 'sawtooth';
      const o2 = ac.createOscillator(); o2.type = 'square';
      const f = ac.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 600; f.Q.value = 4;
      const gn = ac.createGain(); gn.gain.value = 0;
      const g2 = ac.createGain(); g2.gain.value = 0.5;
      o1.connect(f); o2.connect(g2); g2.connect(f); f.connect(gn); gn.connect(ac.destination);
      o1.start(); o2.start();
      const noise = ac.createBuffer(1, ac.sampleRate, ac.sampleRate), ch = noise.getChannelData(0);
      for (let i = 0; i < ch.length; i++) ch[i] = Math.random() * 2 - 1;
      // Wind: brown noise (white noise integrated, so mostly low rumble) through a low-pass that
      // opens a little with speed, its level swelling and easing in slow gusts. Two long loops of
      // different lengths play together, so the ear never hears a pattern repeat.
      const wf = ac.createBiquadFilter(); wf.type = 'lowpass'; wf.frequency.value = 180; wf.Q.value = 0.5;
      for (const secs of [9.1, 13.3]) {
        const wb = ac.createBuffer(1, Math.floor(ac.sampleRate * secs), ac.sampleRate), wd = wb.getChannelData(0);
        let b = 0;
        for (let i = 0; i < wd.length; i++) { b = (b + 0.02 * (Math.random() * 2 - 1)) / 1.02; wd[i] = b; }
        // Seamless: take away the drift from the first sample to the last, so the loop joins.
        const d0 = wd[0], d1 = wd[wd.length - 1];
        let peak = 0;
        for (let i = 0; i < wd.length; i++) { wd[i] -= d0 + ((d1 - d0) * i) / (wd.length - 1); peak = Math.max(peak, Math.abs(wd[i])); }
        for (let i = 0; i < wd.length; i++) wd[i] /= peak;
        const ws = ac.createBufferSource(); ws.buffer = wb; ws.loop = true; ws.connect(wf); ws.start(0, Math.random() * secs);
      }
      const wg = ac.createGain(); wg.gain.value = 0;
      const gust = ac.createGain(); gust.gain.value = 1;
      const lfo = ac.createOscillator(), lg = ac.createGain(); lfo.frequency.value = 0.13; lg.gain.value = 0.3;
      const lfo2 = ac.createOscillator(), lg2 = ac.createGain(); lfo2.frequency.value = 0.047; lg2.gain.value = 0.2;
      lfo.connect(lg); lg.connect(gust.gain); lfo2.connect(lg2); lg2.connect(gust.gain);
      wf.connect(wg); wg.connect(gust); gust.connect(ac.destination);
      lfo.start(); lfo2.start();
      // The tyres screeching, all from white noise: a high-pass to lose the rumble, then two
      // fairly narrow bands, for the squeal's colour without a pitch to wail; its level flutters
      // fast and at random (slow-moving noise), as rubber sticks and slips. Silent until the car slides.
      const sg = ac.createGain(); sg.gain.value = 0; sg.connect(ac.destination);
      const sb = ac.createBuffer(1, Math.floor(ac.sampleRate * 3.7), ac.sampleRate), sd = sb.getChannelData(0);
      for (let i = 0; i < sd.length; i++) sd[i] = Math.random() * 2 - 1;
      const ss = ac.createBufferSource(); ss.buffer = sb; ss.loop = true;
      const shp = ac.createBiquadFilter(); shp.type = 'highpass'; shp.frequency.value = 700;
      const flutter = ac.createGain(); flutter.gain.value = 1;
      ss.connect(shp);
      const bands = [[1100, 3.5, 1], [2600, 4, 0.8]].map(([fq, q, k]) => {
        const bp = ac.createBiquadFilter(), kg = ac.createGain();
        bp.type = 'bandpass'; bp.frequency.value = fq; bp.Q.value = q; kg.gain.value = k;
        shp.connect(bp); bp.connect(kg); kg.connect(flutter);
        return bp;
      });
      flutter.connect(sg);
      const fb = ac.createBuffer(1, Math.floor(ac.sampleRate * 2.9), ac.sampleRate), fd = fb.getChannelData(0);
      for (let i = 0; i < fd.length; i++) fd[i] = Math.random() * 2 - 1;
      const fs = ac.createBufferSource(); fs.buffer = fb; fs.loop = true;
      const flp = ac.createBiquadFilter(); flp.type = 'lowpass'; flp.frequency.value = 30;
      const fdepth = ac.createGain(); fdepth.gain.value = 16;
      fs.connect(flp); flp.connect(fdepth); fdepth.connect(flutter.gain);
      ss.start(); fs.start();
      this.audio = { ac, o1, o2, f, gn, noise, lastCrash: 0, wind: { f: wf, g: wg }, screech: { g: sg, bands, base: [1100, 2600] } };
    } catch (_) { this.failed = true; }
    return this.audio;
  }

  get ready() { return this.audio && this.audio.ac.state === 'running'; }

  // Each frame: the engine's note for the speed (km/h) and the accelerator, or quiet.
  engine(kmh, gas, on) {
    if (on) { const A = this.ensure(); if (A && A.ac.state !== 'running') A.ac.resume().catch(() => {}); }
    const A = this.audio;
    if (!A) return;
    const t = A.ac.currentTime;
    // The wind: nothing below WIND_FROM, then rising more and more steeply with the speed beyond it.
    const w = on ? Math.max(0, Math.min(1, (kmh - WIND_FROM) / (DRIVE.TOP - WIND_FROM))) : 0;
    A.wind.g.gain.setTargetAtTime(WIND_LEVEL * w ** 1.5, t, 0.3);
    A.wind.f.frequency.setTargetAtTime(180 + 420 * w, t, 0.3);
    if (!on) { A.gn.gain.setTargetAtTime(0, t, 0.08); return; }
    let gi = 1;
    while (gi < GEARS.length - 1 && kmh >= GEARS[gi]) gi++;
    // The revs are the speed times the gear's ratio, as in a real car: in each gear they rise in
    // proportion to the speed from 0 km/h, to SHIFT_REVS where it changes up (top gear: the limit
    // at the top speed). So a change up drops them only to the share of the new gear's (30 km/h
    // into 2nd: 90% × 30 / 60, 45%). They never fall below tick-over.
    const full = gi < GEARS.length - 1 ? GEARS[gi] / SHIFT_REVS : DRIVE.TOP; // km/h at the limit
    const rpm = Math.max(0.15, Math.min(1, kmh / full));
    const fq = 38 + rpm * 95 * (1 + gi * 0.06) + (gas ? 6 : 0);
    A.o1.frequency.setTargetAtTime(fq, t, 0.05); A.o2.frequency.setTargetAtTime(fq / 2, t, 0.05);
    A.f.frequency.setTargetAtTime(380 + (gas ? 1100 : 300) * rpm, t, 0.08);
    A.gn.gain.setTargetAtTime(0.05, t, 0.08);
  }

  // The tyres screeching, level 0 (gripping) to 1 (sliding hard), a little higher with speed.
  screech(level, kmh) {
    const A = this.audio;
    if (!A) return;
    const t = A.ac.currentTime, S = A.screech;
    S.g.gain.setTargetAtTime(SCREECH_LEVEL * level, t, level > 0 ? 0.04 : 0.09);
    S.bands.forEach((bp, k) => bp.frequency.setTargetAtTime(S.base[k] * (0.9 + Math.min(1, kmh / 120) * 0.2), t, 0.1));
  }

  silence() {
    if (!this.audio) return;
    const t = this.audio.ac.currentTime;
    this.audio.screech.g.gain.setTargetAtTime(0, t, 0.05);
    this.audio.gn.gain.setTargetAtTime(0, t, 0.05);
    this.audio.wind.g.gain.setTargetAtTime(0, t, 0.2);
    this.horn(false);
  }

  // The horn, sounding while held: the Proving Ground's two square waves a major third apart.
  horn(on) {
    if (!!this.hornNode === on) return;
    if (!on) {
      const H = this.hornNode, t = this.audio.ac.currentTime;
      this.hornNode = null;
      H.g.gain.cancelScheduledValues(t); H.g.gain.setTargetAtTime(0.0001, t, 0.02);
      for (const o of H.o) o.stop(t + 0.15);
      return;
    }
    if (!this.ready) return;
    const ac = this.audio.ac, t = ac.currentTime;
    const lp = ac.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 2200;
    const g = ac.createGain(); g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.09, t + 0.02);
    const o = [400, 400 * 1.26].map((fq) => { const x = ac.createOscillator(); x.type = 'square'; x.frequency.value = fq; x.connect(lp); x.start(t); return x; });
    lp.connect(g); g.connect(ac.destination);
    this.hornNode = { g, o };
  }

  env(peak, attack, decay, t) {
    const g = this.audio.ac.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
    return g;
  }

  // Landing on all four wheels, strength 0 to 1: a low, soft thud, and the tyres and
  // suspension taking the weight (low-passed noise). No crack.
  land(str) {
    str = Math.max(0, Math.min(1, str));
    if (!this.ready) return;
    const A = this.audio, ac = A.ac, t = ac.currentTime;
    if (t - A.lastCrash < 0.12) return;
    A.lastCrash = t;
    const o = ac.createOscillator();
    o.type = 'sine'; o.frequency.setValueAtTime(85, t); o.frequency.exponentialRampToValueAtTime(38, t + 0.22);
    const g = this.env(0.2 + 0.35 * str, 0.008, 0.32, t);
    o.connect(g); g.connect(ac.destination); o.start(t); o.stop(t + 0.4);
    const src = ac.createBufferSource(); src.buffer = A.noise;
    const lp = ac.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 260 + 200 * str;
    const g2 = this.env(0.08 + 0.12 * str, 0.01, 0.2, t);
    src.connect(lp); lp.connect(g2); g2.connect(ac.destination);
    src.start(t, Math.random() * 0.4); src.stop(t + 0.3);
  }

  // A crash of strength 0 to 1: a burst of noise, rattling debris and a thud.
  crash(str) {
    str = Math.max(0, Math.min(1, str));
    if (!this.ready || str < 0.06) return;
    const A = this.audio, ac = A.ac, t = ac.currentTime;
    if (t - A.lastCrash < 0.12) return;
    A.lastCrash = t;
    const src = ac.createBufferSource(); src.buffer = A.noise;
    const f = ac.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 500 + str * 2600;
    const g = this.env(0.2 + 0.5 * str, 0.006, 0.18 + 0.4 * str, t);
    src.connect(f); f.connect(g); g.connect(ac.destination);
    src.start(t, Math.random() * 0.4); src.stop(t + 0.8);
    const src2 = ac.createBufferSource(); src2.buffer = A.noise;
    const bp = ac.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 2400; bp.Q.value = 3;
    const g2 = this.env(0.06 + 0.12 * str, 0.02, 0.35 + 0.3 * str, t + 0.03);
    src2.connect(bp); bp.connect(g2); g2.connect(ac.destination);
    src2.start(t + 0.03, Math.random() * 0.4); src2.stop(t + 1);
    const o = ac.createOscillator();
    o.type = 'sine'; o.frequency.setValueAtTime(120, t); o.frequency.exponentialRampToValueAtTime(42, t + 0.25);
    const g3 = this.env(0.15 + 0.4 * str, 0.005, 0.3, t);
    o.connect(g3); g3.connect(ac.destination); o.start(t); o.stop(t + 0.4);
  }
}

class Driver {
  // ctx: { camera, renderer, mpu(): metres per model unit, bounds(): [min, max] of what is shown,
  //        onExit(), notice(text, ms), fade(), onCrash(strength),
  //        side(): 1 where the driver sits on the left, -1 on the right (countries driving on the left) }
  constructor(ctx) {
    this.ctx = ctx;
    this.active = false;
    this.placing = false;
    this.input = { gas: false, brake: false, left: false, right: false, horn: false };
    this.stick = null; // a thumb stick on touch screens: [forward, right], 1 at its rim
    // Set from the Drive panel: the car casts the sun's shadows, which camera, headlights on, sounds.
    this.settings = { shadows: true, cam: 0, headlights: false, sound: true, music: true };
    this.sound = new DriveSound();
    this.music = new DriveMusic(() => this.sound.ensure()?.ac || null); // music.js: the car radio
    this.parked = false; // out of the car, which stays where it stopped
    this.lampsShown = '';
  }

  get u() { return 1 / this.ctx.mpu(); } // model units per metre

  // Choosing where to start: the person picks a point in the model (main.js), then enter(point, heading).
  place() { this.placing = true; }

  // Starts driving with the car on the ground below start ([x, y, z], model units), facing heading
  // (radians from +x, anticlockwise). Resolves false, with a notice, when there is nothing to stand on.
  async enter(start, heading) {
    const { camera, renderer } = this.ctx, u = this.u;
    if (!renderer.actor) renderer.setActor(carGeometry());
    this.placing = false;
    this.parked = false;
    this.side = this.ctx.side?.() === -1 ? -1 : 1;
    this.active = true;
    this.pending = true;
    this.releaseAll();
    this.fov0 = camera.fov;
    this.ortho0 = camera.ortho;
    camera.ortho = false;
    this.music.pick(); // a new drive, a new track at random (getting back in a parked car carries on)
    Object.assign(this, { x: start[0], y: start[1], z: start[2], a: heading, vF: 0, vL: 0, vz: 0, yaw: 0, steer: 0, pitch: 0, roll: 0, rawPitch: 0, rawRoll: 0,
      grounded: false, air: 0, map: null, stable: [], lastStable: 0, lockUntil: 0, shake: 0, orbit: 0, tilt: 0, dragging: false,
      camPos: null, launch: null, sunk: 0, last: performance.now(), gen: (this.gen || 0) + 1 });
    // The first look round: the ground straight below the start, however far down.
    let map = null;
    while (this.active && !(map = await this.look(start[2] + DRIVE.ROOF * u))) await new Promise(requestAnimationFrame);
    if (!this.active) return false;
    this.pending = false;
    const g = this.groundAt([this.x, this.y], 0.5 * u, start[2] + DRIVE.ROOF * u, map);
    if (g == null) {
      this.ctx.notice('There is nothing there for the car to stand on. Pick a spot on the ground.');
      this.exit();
      return false;
    }
    this.map = map;
    this.z = g;
    this.grounded = true;
    this.lampsShown = '';
    this.braking = this.reversing = false;
    this.place3d();
    this.syncLamps();
    this.updateCamera(0);
    return true;
  }

  exit() {
    if (this.placing) { this.placing = false; this.ctx.onExit(); return; }
    if (this.parked) { this.parked = false; this.ctx.renderer.setActorPose(null); return; }
    if (!this.active) return;
    this.active = false;
    this.releaseAll();
    this.sound.silence();
    this.music.set(false);
    const { camera, renderer } = this.ctx;
    renderer.setActorPose(null);
    if (this.fov0) camera.fov = this.fov0;
    camera.ortho = this.ortho0;
    this.ctx.onExit();
  }

  // Gets out: the car stops and stays where it is, shown from outside. Returns where to stand,
  // just outside the driver's door (model units; the left door, or the right where the car is
  // right-hand drive), and the way the car faces.
  park() {
    if (!this.active) return null;
    const u = this.u, f = [Math.cos(this.a), Math.sin(this.a)], l = [-f[1], f[0]];
    this.active = false;
    this.parked = true;
    this.releaseAll();
    this.sound.silence();
    this.music.set(false);
    Object.assign(this, { vF: 0, vL: 0, vz: 0, yaw: 0, steer: 0, braking: false, reversing: false, shake: 0 });
    if (this.fov0) this.ctx.camera.fov = this.fov0;
    this.place3d(true);
    this.syncLamps();
    const s = this.side * 1.6 * u;
    return { p: [this.x + f[0] * 0.2 * u + l[0] * s, this.y + f[1] * 0.2 * u + l[1] * s, this.z + 0.3 * u], heading: this.a };
  }

  // Back in the parked car, driving again.
  resume() {
    if (!this.parked) return false;
    const { camera } = this.ctx;
    this.parked = false;
    this.active = true;
    this.releaseAll();
    this.fov0 = camera.fov;
    camera.ortho = false;
    Object.assign(this, { map: null, camPos: null, orbit: 0, tilt: 0, lockUntil: 0, last: performance.now(), gen: this.gen + 1, lampsShown: '' });
    this.place3d();
    this.syncLamps();
    this.updateCamera(0);
    return true;
  }

  // Whether p (x, y) is within r (metres) of the parked car's middle.
  near(p, r) { return this.parked && Math.hypot(p[0] - this.x, p[1] - this.y) < r * this.u; }

  // Whether someone standing at p (x, y, with their feet at height foot) is within r (metres)
  // of the parked car's sides: walking into it.
  touches(p, foot, r) {
    if (!this.parked) return false;
    const u = this.u, dx = p[0] - this.x, dy = p[1] - this.y, f = [Math.cos(this.a), Math.sin(this.a)];
    const along = Math.abs(dx * f[0] + dy * f[1]) / u, side = Math.abs(-dx * f[1] + dy * f[0]) / u, up = (foot - this.z) / u;
    return along < 2.27 + r && side < 0.95 + r && up > -1 && up < 1.4;
  }

  releaseAll() { for (const k in this.input) this.input[k] = false; this.stick = null; }

  // Keyboard: returns true when the key was used for driving.
  key(e, down) {
    const k = e.key.toLowerCase(), what = DRIVE_KEYS[k];
    if (what) { this.input[what] = down; return true; }
    if (!down || e.repeat) return false;
    if (k === 'c') { this.settings.cam = (this.settings.cam + 1) % DRIVE_CAMS.length; this.camPos = null; return true; }
    if (k === 'r') { this.reset(); return true; }
    if (k === 't') { this.settings.headlights = !this.settings.headlights; return true; }
    if (k === 'm') { this.settings.sound = !this.settings.sound; return true; }
    return false;
  }
  blur() { this.releaseAll(); }

  // Drag to look round the car: dx, dy in CSS pixels. The view swings back behind it once let go.
  turn(dx, dy) {
    this.orbit -= dx * 0.005;
    this.tilt = Math.max(-0.5, Math.min(1.2, this.tilt + dy * 0.004));
  }

  // Mouse wheel: zooms by narrowing or widening the field of view.
  zoom(deltaY) {
    const { camera } = this.ctx, deg = Math.PI / 180;
    camera.fov = Math.max(DRIVE.MIN_FOV * deg, Math.min(DRIVE.MAX_FOV * deg, camera.fov * Math.exp(deltaY * 0.0015)));
  }

  get speed() { return Math.abs(this.vF || 0); } // m/s
  get topSpeed() { return DRIVE.TOP / 3.6; }

  // Ask the renderer for the surroundings. Resolves to the decoded map, or null if a previous look
  // is still in flight or the probe failed (the caller asks again).
  async look(top) {
    const { renderer } = this.ctx, u = this.u, [mn] = this.ctx.bounds();
    const ahead = Math.max(this.speed, Math.hypot(this.vF || 0, this.vL || 0)) * DRIVE.LOOKAHEAD;
    const half = (DRIVE.HALF + ahead) * u;
    const q = { x: this.x, y: this.y, half, top, bottom: Math.min(mn[2], this.z) - 5 * u,
      reach: half, z0: this.z + DRIVE.CLIMB * u, z1: this.z + DRIVE.ROOF * u, water: true };
    const r = await renderer.probe(q);
    if (!r) return null;
    const G = PROBE.ground, cell = (2 * q.half) / G;
    const walls = [];
    for (let i = 0; i < r.walls.length; i += 4) if (r.walls[i + 3] > 0) walls.push(r.walls[i], r.walls[i + 1], r.walls[i + 2]);
    // Copied: the renderer reuses its arrays for the next look.
    return { x0: q.x - q.half, y1: q.y + q.half, cell, G, g: r.ground.slice(), w: r.water.slice(), walls };
  }

  // The water surface under p (the highest within r), or null where there is none or p is off the map.
  waterAt(p, r, map = this.map) {
    return (map && this.groundAt(p, r, Infinity, { ...map, g: map.w })) ?? null;
  }

  // Highest ground within radius r of p that is no higher than `below`; null where there is
  // nothing, undefined where p is off the map.
  groundAt(p, r, below, map = this.map) {
    if (!map) return undefined;
    const { x0, y1, cell, G, g } = map;
    const c0 = Math.floor((p[0] - r - x0) / cell), c1 = Math.floor((p[0] + r - x0) / cell);
    const r0 = Math.floor((y1 - p[1] - r) / cell), r1 = Math.floor((y1 - p[1] + r) / cell);
    if (c0 < 0 || r0 < 0 || c1 >= G || r1 >= G) return undefined;
    let best = null;
    for (let row = r0; row <= r1; row++)
      for (let col = c0; col <= c1; col++) {
        const i = (row * G + col) * 4;
        if (g[i + 3] <= 0) continue;
        const dx = g[i] - p[0], dy = g[i + 1] - p[1], z = g[i + 2];
        if (dx * dx + dy * dy <= r * r && z <= below && (best == null || z > best)) best = z;
      }
    return best;
  }

  // Height of the plane the wheels sit in, at (x, y): as the ground under them was last frame,
  // not the eased tilt the car is drawn with, which lags behind on the way onto a ramp.
  planeAt(x, y) {
    const f = [Math.cos(this.a), Math.sin(this.a)], dx = x - this.x, dy = y - this.y;
    const along = dx * f[0] + dy * f[1], left = -dx * f[1] + dy * f[0];
    return this.z + along * Math.tan(this.rawPitch) + left * Math.tan(this.rawRoll);
  }

  // Obstacle points (x, y) within r of p: wall hits and ground above kerb height, below the roof.
  // Beyond the wheels the kerb height grows with distance, as a slope up to SLOPE would, so the
  // car can drive onto a ramp; a step or a wall rises at once, and still blocks when it comes close.
  obstacles(p, r) {
    const u = this.u, out = [], m = this.map, hi = DRIVE.ROOF * u, f = [Math.cos(this.a), Math.sin(this.a)];
    const near = (x, y) => (x - p[0]) ** 2 + (y - p[1]) ** 2 < r * r;
    const test = (x, y, z) => {
      const dx = x - this.x, dy = y - this.y, along = Math.abs(dx * f[0] + dy * f[1]) / u, side = Math.abs(-dx * f[1] + dy * f[0]) / u;
      const past = Math.max(0, along - DRIVE.AXLE) + Math.max(0, side - DRIVE.TRACK / 2);
      const h = z - this.planeAt(x, y);
      // Off a ledge, the edge just driven off (no higher than the ground the car left, near where
      // it left) is behind or under the car, not something it hits: it would snag the car.
      if (this.launch && z <= this.launch.z + DRIVE.CLIMB * u && Math.hypot(x - this.launch.x, y - this.launch.y) < DRIVE.LEDGE * u) return false;
      return h > (DRIVE.CLIMB + DRIVE.SLOPE * past) * u && h < hi;
    };
    const { x0, y1, cell, G, g } = m;
    // A side view's hit on a surface the ground map sees from above too is a ramp, not a wall.
    const fromAbove = (x, y, z) => {
      const col = Math.floor((x - x0) / cell), row = Math.floor((y1 - y) / cell);
      if (col < 0 || row < 0 || col >= G || row >= G) return false;
      const i = (row * G + col) * 4;
      return g[i + 3] > 0 && g[i + 2] > z - 0.15 * u;
    };
    const w = m.walls;
    for (let i = 0; i < w.length; i += 3) if (near(w[i], w[i + 1]) && test(w[i], w[i + 1], w[i + 2]) && !fromAbove(w[i], w[i + 1], w[i + 2])) out.push([w[i], w[i + 1]]);
    const c0 = Math.max(0, Math.floor((p[0] - r - x0) / cell)), c1 = Math.min(G - 1, Math.floor((p[0] + r - x0) / cell));
    const r0 = Math.max(0, Math.floor((y1 - p[1] - r) / cell)), r1 = Math.min(G - 1, Math.floor((y1 - p[1] + r) / cell));
    for (let row = r0; row <= r1; row++)
      for (let col = c0; col <= c1; col++) {
        const i = (row * G + col) * 4;
        if (g[i + 3] > 0 && near(g[i], g[i + 1]) && test(g[i], g[i + 1], g[i + 2])) out.push([g[i], g[i + 1]]);
      }
    return out;
  }

  // What the controls ask for: pedals and steering from the keys, else from the thumb stick
  // (forward is the accelerator, back the brake and then reverse, sideways steers).
  controls(now) {
    const I = this.input, out = { gas: I.gas, brake: I.brake, steer: (I.left ? 1 : 0) - (I.right ? 1 : 0), hand: false, horn: I.horn, throttle: 1 };
    if (!I.gas && !I.brake && !I.left && !I.right && this.stick) {
      const [f, r] = this.stick;
      out.gas = f > 0.15; out.brake = f < -0.15; out.throttle = Math.min(1, Math.abs(f));
      out.steer = -Math.max(-1, Math.min(1, r));
    }
    // Braking while steering, going forwards, pulls the handbrake: the car slides round. At a crawl
    // or in reverse, it brakes (and reverses) as usual.
    if (out.brake && out.steer && this.vF > HAND_SPEED) { out.hand = true; out.brake = false; }
    if (now < this.lockUntil) Object.assign(out, { gas: false, brake: false, steer: 0, hand: false });
    return out;
  }

  // Called every frame while active.
  update(now) {
    const dt = Math.min(0.05, (now - this.last) / 1000);
    this.last = now;
    if (this.pending) return;
    const u = this.u, gen = this.gen;
    this.look(this.z + DRIVE.ROOF * u).then((m) => { if (m && this.active && gen === this.gen) this.map = m; });
    if (!this.map || !dt) { this.updateCamera(dt); return; }
    const inp = this.controls(now), top = this.topSpeed;

    // Along the heading and sideways (to the left), in m/s.
    let vF = this.vF, vL = this.vL;
    const speed = Math.abs(vF), a0 = this.a;
    this.steer += ((inp.steer * DRIVE.STEER) / (1 + speed * 0.05) - this.steer) * Math.min(1, dt * 9);
    if (this.grounded) {
      if (inp.gas) { if (vF < -0.5) vF += DRIVE.BRAKE * dt; else vF += DRIVE.ACC * inp.throttle * Math.max(0, 1 - Math.max(0, vF) / top) * dt; }
      if (inp.brake) { if (vF > 0.5) vF -= DRIVE.BRAKE * dt; else vF = Math.max(-DRIVE.REV_MAX, vF - DRIVE.REV_ACC * inp.throttle * dt); }
      if (!inp.gas && !inp.brake) vF -= Math.sign(vF) * Math.min(Math.abs(vF), DRIVE.COAST * dt);
      vF -= 9.81 * Math.sin(this.pitch) * dt; // slopes
      let grip = DRIVE.GRIP;
      if (inp.hand) { vF -= Math.sign(vF) * Math.min(Math.abs(vF), 7 * dt); grip = DRIVE.HAND_GRIP; }
      vL *= Math.exp(-grip * dt);
      this.yaw = (vF / DRIVE.WHEELBASE) * Math.tan(this.steer) * (inp.hand ? DRIVE.HAND_TURN : 1);
      this.a += this.yaw * dt;
    } else {
      this.a += this.yaw * dt * 0.4;
    }
    // Back to x and y along the heading before the turn, then the move in short steps, pushed out
    // of obstacles. The car turns under its momentum: what is left of it across the new heading is
    // the sideways slide, which the tyres' grip then wears away.
    const f0 = [Math.cos(a0), Math.sin(a0)], f = [Math.cos(this.a), Math.sin(this.a)], l = [-f[1], f[0]];
    let v = [f0[0] * vF - f0[1] * vL, f0[1] * vF + f0[0] * vL];
    v = this.move(v, dt);
    this.vF = v[0] * f[0] + v[1] * f[1];
    this.vL = v[0] * l[0] + v[1] * l[1];

    // The ground under each wheel: the car's height, pitch and roll. On the ground, moving onto a
    // ramp, the ground ahead of a wheel rises above last frame's plane. In the air, a wheel only
    // lands on what is below it: not on the top of the ledge it has dropped past.
    const flying = !this.grounded;
    const wheels = [[1, 1], [1, -1], [-1, 1], [-1, -1]].map(([sx, sy]) => {
      const p = [this.x + f[0] * sx * DRIVE.AXLE * u + l[0] * sy * (DRIVE.TRACK / 2) * u, this.y + f[1] * sx * DRIVE.AXLE * u + l[1] * sy * (DRIVE.TRACK / 2) * u];
      const reach = flying ? 0.05 + Math.max(0, -this.vz) * dt : DRIVE.CLIMB + DRIVE.SLOPE * (Math.abs(vF) * dt + 0.1);
      return this.groundAt(p, DRIVE.WHEEL_R * u, this.planeAt(...p) + reach * u);
    });
    const known = wheels.filter((g) => g != null), offMap = wheels.some((g) => g === undefined);
    const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
    // Off the map (it arrives a frame late) the ground is unknown: on it, stay at this height;
    // in the air, keep flying.
    const g = known.length && !offMap ? mean(known) : offMap ? (flying ? undefined : this.z) : null;
    if (this.grounded) {
      if (g != null && g >= this.z - DRIVE.DROP * u) {
        this.vz = Math.min(30, (g - this.z) / u / dt);
        this.z = g;
        this.air = 0;
        if (now - this.lastStable > 500 && known.length === 4) {
          this.lastStable = now;
          this.stable.push([this.x, this.y, this.z, this.a]);
          if (this.stable.length > 3) this.stable.shift();
        }
        // Clear of the ledge it last drove off.
        if (this.launch && (now - this.launch.landed > 1000 || Math.hypot(this.x - this.launch.x, this.y - this.launch.y) > DRIVE.LEDGE * u)) this.launch = null;
      } else {
        // Off an edge: it keeps the tilt it had, not the drop under its front wheels.
        this.grounded = false;
        this.air = 0;
        this.launch = { x: this.x, y: this.y, z: this.z, landed: Infinity };
      }
    }
    // The tilt follows the ground on it, and in the air only once the ground is close below.
    if (known.length === 4 && (this.grounded || (g != null && this.z - g < 1 * u))) {
      const [fl, fr, rl, rr] = wheels, ease = 1 - Math.exp(-dt / DRIVE.TILT_EASE);
      const pitch = Math.atan2((fl + fr - rl - rr) / 2, DRIVE.WHEELBASE * u), roll = Math.atan2((fl + rl - fr - rr) / 2, DRIVE.TRACK * u);
      this.rawPitch = pitch; this.rawRoll = roll;
      this.pitch += (Math.max(-0.6, Math.min(0.6, pitch)) - this.pitch) * ease;
      this.roll += (Math.max(-0.5, Math.min(0.5, roll)) - this.roll) * ease;
    }
    if (!this.grounded) {
      this.air += dt;
      this.vz -= DRIVE.GRAVITY * dt;
      this.z += this.vz * u * dt;
      // Level out a little in the air; the wheels' plane is the car's as drawn.
      this.pitch *= Math.exp(-dt * 0.8);
      this.roll *= Math.exp(-dt * 0.8);
      this.rawPitch = this.pitch; this.rawRoll = this.roll;
      if (g != null && this.z <= g) {
        // Down on all four wheels, tilted as the ground is: the suspension takes it, a soft thud.
        // Anything else (nose first, on one side, half on an edge) is a crash.
        if (this.vz < -4) {
          const str = Math.min(1, -this.vz / 16);
          let clean = known.length === 4;
          if (clean) {
            const [fl, fr, rl, rr] = wheels;
            const p = Math.atan2((fl + fr - rl - rr) / 2, DRIVE.WHEELBASE * u), r = Math.atan2((fl + rl - fr - rr) / 2, DRIVE.TRACK * u);
            clean = Math.abs(p - this.pitch) < 0.2 && Math.abs(r - this.roll) < 0.2;
          }
          if (clean) this.land(str); else this.bump(str);
        }
        this.z = g; this.vz = 0; this.grounded = true;
        if (this.launch) this.launch.landed = now;
      }
      const [mn] = this.ctx.bounds();
      if (this.z < mn[2] - 5 * u || (g === null && this.air > DRIVE.LOST)) this.lost(now);
    }
    // In water: a splash, and soon after back to firm ground.
    if (this.sunk && now >= this.sunk) this.lost(now);
    else if (!this.sunk && this.active) {
      const w = this.waterAt([this.x, this.y], 0.5 * u);
      if (w != null && this.z < w - DRIVE.SINK * u) {
        this.sunk = now + DRIVE.SPLASHED * 1000;
        this.lockUntil = this.sunk;
        this.ctx.splash?.();
      }
    }
    this.place3d();
    // Brake lights while braking, and in reverse as the accelerator stops the car; reversing lights
    // while going backwards; the rear lights glow faintly with the headlights on.
    this.braking = this.grounded && ((inp.brake && this.vF > 0.5) || (inp.gas && this.vF < -0.5) || (inp.hand && this.vF > 0.5));
    this.reversing = this.vF < -0.2;
    this.syncLamps();
    this.sound.engine(Math.abs(this.vF) * 3.6, inp.gas, this.settings.sound);
    this.sound.horn(inp.horn && this.settings.sound);
    // The tyres screech on the handbrake, and while the car slides sideways after it.
    const slideV = Math.abs(this.vL), moving = Math.hypot(this.vF, this.vL);
    const slip = !this.grounded || !this.settings.sound ? 0 : Math.max(
      inp.hand ? Math.min(1, (moving - 3) / 10) * (0.55 + 0.45 * Math.min(1, slideV / 5)) : 0,
      Math.min(1, (slideV - 2.5) / 6));
    this.sound.screech(Math.max(0, slip), moving * 3.6);
    this.music.set(this.settings.music);
    if (!this.sunk) this.updateCamera(dt);
  }

  // The lamps' colours and glow (0 to 1), written to the renderer when they change.
  syncLamps() {
    const { renderer } = this.ctx, H = this.settings.headlights;
    const glow = { head: H ? 1 : 0, tail: this.braking ? 1 : H ? 0.3 : 0, reverse: this.reversing ? 1 : 0 };
    const key = JSON.stringify(glow);
    if (key === this.lampsShown || !renderer.actor) return;
    this.lampsShown = key;
    const geo = renderer.actor.geo, col = geo.col.slice();
    for (const name in geo.lamps) {
      const g = glow[name], L = LAMPS[name], rgb = L.off.map((v, k) => Math.round(v + (L.on[k] - v) * Math.min(1, g * 2)));
      for (const [s, e] of geo.lamps[name])
        for (let i = s; i < e; i++) { col.set(rgb, i * 4); col[i * 4 + 3] = Math.round(255 * (1 - g)); }
    }
    renderer.setActorColours(col);
  }

  // The headlights' beams as the renderer's spot lights (in model units), or none.
  headlamps() {
    if (!(this.active || this.parked) || !this.settings.headlights || !this.basis) return [];
    const u = this.u, { f, l, up } = this.basis, H = HEADLIGHT;
    const dir = V3.norm(V3.sub(f, V3.scale(up, H.dip)));
    return [1, -1].map((s) => ({ name: 'Headlight', p: V3.add([this.x, this.y, this.z], V3.add(V3.add(V3.scale(f, H.at[0] * u), V3.scale(l, s * H.at[1] * u)), V3.scale(up, H.at[2] * u))),
      dir, inner: H.inner, outer: H.outer, rgb: H.rgb, power: H.power, range: H.range }));
  }

  // Moves the car by v (m/s) over dt in short steps: each step pushes both body circles out of
  // the obstacles near them and bounces the velocity off. Returns the velocity after.
  move(v, dt) {
    const u = this.u, R = DRIVE.BODY_R * u, len = Math.hypot(v[0], v[1]) * dt * u;
    const n = Math.max(1, Math.ceil(len / (DRIVE.SUBSTEP * u)));
    const obs = this.settings.collide === false ? [] : this.obstacles([this.x + (v[0] * dt * u) / 2, this.y + (v[1] * dt * u) / 2], len / 2 + (DRIVE.BODY_OFF + DRIVE.BODY_R) * u + R);
    const m = this.map, margin = (DRIVE.BODY_OFF + DRIVE.BODY_R) * u;
    for (let i = 0; i < n; i++) {
      let x = this.x + (v[0] * dt * u) / n, y = this.y + (v[1] * dt * u) / n;
      if (x - margin < m.x0 || x + margin > m.x0 + m.cell * m.G || y + margin > m.y1 || y - margin < m.y1 - m.cell * m.G) break; // wait for the map
      if (obs.length) {
        const f = [Math.cos(this.a), Math.sin(this.a)];
        for (let it = 0; it < 3; it++) {
          let push = null;
          for (const s of [1, -1]) {
            const cx = x + f[0] * s * DRIVE.BODY_OFF * u, cy = y + f[1] * s * DRIVE.BODY_OFF * u;
            let best = null, bd = R;
            for (const q of obs) { const d = Math.hypot(cx - q[0], cy - q[1]); if (d < bd) { bd = d; best = q; } }
            if (best && (!push || R - bd > push.pen)) push = { nx: (cx - best[0]) / (bd || 1), ny: (cy - best[1]) / (bd || 1), pen: R - bd };
          }
          if (!push) break;
          x += push.nx * push.pen; y += push.ny * push.pen;
          const vn = v[0] * push.nx + v[1] * push.ny;
          if (vn < 0) {
            v = [(v[0] - 1.25 * vn * push.nx) * 0.85, (v[1] - 1.25 * vn * push.ny) * 0.85];
            if (vn < -1.5) this.bump(Math.min(1, -vn / 14));
          }
        }
      }
      this.x = x; this.y = y;
    }
    return v;
  }

  // A clean landing: a little shake and a low thud.
  land(strength) {
    this.shake = Math.max(this.shake, strength * 0.45);
    if (this.settings.sound) this.sound.land(strength);
  }

  bump(strength) {
    this.shake = Math.max(this.shake, strength);
    if (this.settings.sound) this.sound.crash(strength);
    this.ctx.onCrash?.(strength);
  }

  // Back to the last spot the car stood firmly (R, or after flying off the model).
  reset() {
    if (!this.active || this.pending) return;
    this.lost(performance.now());
  }
  lost(now) {
    const s = this.stable[0];
    if (!s) { this.ctx.notice('The car went off the model.'); this.exit(); return; }
    Object.assign(this, { x: s[0], y: s[1], z: s[2], a: s[3], vF: 0, vL: 0, vz: 0, yaw: 0, steer: 0, pitch: 0, roll: 0, rawPitch: 0, rawRoll: 0, grounded: true, air: 0,
      lockUntil: now + DRIVE.LOCK * 1000, map: null, stable: [s], gen: this.gen + 1, camPos: null, launch: null, sunk: 0 });
    this.ctx.fade();
  }

  // The car's transform, its metres to the model, for the renderer.
  place3d(outside = false) {
    const u = this.u, ca = Math.cos(this.a), sa = Math.sin(this.a), cp = Math.cos(this.pitch), sp = Math.sin(this.pitch), cr = Math.cos(this.roll), sr = Math.sin(this.roll);
    // Heading about z, then pitch (nose up), then roll (left side up) about the car's length.
    const fx = [ca * cp, sa * cp, sp];
    const left0 = [-sa, ca, 0], up0 = V3.cross(fx, left0);
    const left = V3.add(V3.scale(left0, cr), V3.scale(up0, sr)), up = V3.cross(fx, left);
    this.basis = { f: fx, l: left, up };
    // From the driver's seat the car itself is left out: the glass is solid.
    if (DRIVE_CAMS[this.settings.cam].eye && !outside) { this.ctx.renderer.setActorPose(null); return; }
    this.ctx.renderer.setActorPose([fx[0] * u, fx[1] * u, fx[2] * u, 0, left[0] * u, left[1] * u, left[2] * u, 0, up[0] * u, up[1] * u, up[2] * u, 0, this.x, this.y, this.z, 1], this.settings.shadows);
  }

  // The chase camera follows behind, easing after the car; the driver's camera is fixed to it.
  updateCamera(dt) {
    const { camera } = this.ctx, u = this.u, C = DRIVE_CAMS[this.settings.cam], b = this.basis || { f: [Math.cos(this.a), Math.sin(this.a), 0], l: [-Math.sin(this.a), Math.cos(this.a), 0], up: [0, 0, 1] };
    const at = [this.x, this.y, this.z];
    // Let go of a drag and the view swings back behind the car, quicker the faster it goes.
    if (!this.dragging) {
      const k = 1 - Math.exp(-dt * (0.6 + this.speed * 0.15));
      this.orbit *= 1 - k; this.tilt *= 1 - k;
    }
    let eye, look;
    if (C.eye) {
      eye = V3.add(at, V3.add(V3.add(V3.scale(b.f, C.eye[0] * u), V3.scale(b.l, C.eye[1] * this.side * u)), V3.scale(b.up, C.eye[2] * u)));
      const dir = V3.rotate(V3.rotate(b.f, b.up, this.orbit), b.l, -this.tilt);
      look = V3.add(eye, V3.scale(dir, 20 * u));
    } else {
      const h = this.a + this.orbit, f = [Math.cos(h), Math.sin(h), 0];
      const back = C.back * (1 + this.tilt * 0.3), up = C.up + this.tilt * C.back * 0.6;
      const want = [at[0] - f[0] * back * u, at[1] - f[1] * back * u, at[2] + up * u];
      look = [at[0] + Math.cos(this.a) * C.ahead * u, at[1] + Math.sin(this.a) * C.ahead * u, at[2] + C.at * u];
      if (!this.camPos || !dt) this.camPos = want;
      else {
        const k = 1 - Math.exp(-dt * C.ease);
        this.camPos = V3.add(this.camPos, V3.scale(V3.sub(want, this.camPos), k));
        // Keep the chase distance at least, so a car accelerating away doesn't leave it behind far.
        const d = V3.sub(this.camPos, look), dl = V3.len(d), max = Math.hypot(back, up) * u * 1.6;
        if (dl > max) this.camPos = V3.add(look, V3.scale(d, max / dl));
      }
      eye = this.camPos;
    }
    if (this.shake > 0.01) {
      eye = V3.add(eye, [(Math.random() - 0.5) * this.shake * 0.4 * u, (Math.random() - 0.5) * this.shake * 0.4 * u, (Math.random() - 0.5) * this.shake * 0.4 * u]);
      this.shake *= Math.exp(-dt * 6);
    }
    const d = V3.sub(eye, look), dist = V3.len(d) || u;
    camera.yaw = Math.atan2(d[1], d[0]);
    camera.pitch = Math.asin(Math.max(-1, Math.min(1, d[2] / dist)));
    // A short distance keeps the near plane close, for the driver's camera.
    camera.distance = C.eye ? 1 * u : dist;
    camera.target = V3.sub(eye, V3.scale(camera.dir, camera.distance));
  }
}
