// Drive mode: a car to drive around the model, with WASD / arrow keys, and a chase camera.
//
// The handling is an arcade one, after the Proving Ground: the car accelerates and brakes along
// its heading, its sideways speed bleeds away with the tyres' grip (Space, the handbrake, lets it
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
// All lengths here are in metres; the model is in its own units (mpu = metres per unit).

const DRIVE = {
  ACC: 10,           // acceleration (m/s²) at a standstill, falling to nothing at the top speed
  BRAKE: 20,         // braking (m/s²)
  REV_ACC: 6,        // reversing
  REV_MAX: 7,        // top speed in reverse (m/s)
  COAST: 2.2,        // slowing (m/s²) with neither pedal pressed
  MIN_TOP: 20,       // top speed range (km/h) of the Drive panel's slider
  MAX_TOP: 160,
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
  LOCK: 0.8,         // seconds the controls are locked after going back
  MIN_FOV: 25,       // field of view range (degrees) for zooming with the mouse wheel
  MAX_FOV: 80,
};

// The cameras: behind the car, further back and higher, and at the driver's eyes.
const DRIVE_CAMS = [
  { id: 'chase', label: 'Chase', back: 7.5, up: 2.6, ahead: 3, at: 1.1, ease: 5 },
  { id: 'far', label: 'High', back: 16, up: 8, ahead: 4, at: 0.8, ease: 3 },
  { id: 'driver', label: 'Driver', eye: [0.15, 0.35, 1.2] },
];

const DRIVE_KEYS = { w: 'gas', arrowup: 'gas', s: 'brake', arrowdown: 'brake', a: 'left', arrowleft: 'left', d: 'right', arrowright: 'right', ' ': 'hand' };

// The car's shape: flat-shaded panels, so each face has its own vertices.
function carGeometry() {
  const pos = [], nrm = [], col = [], idx = [];
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

  const PAINT = [196, 38, 30], GLASS = [34, 44, 56], TYRE = [26, 27, 29], RIM = [176, 180, 186], TRIM = [40, 42, 46], ARCH = [18, 18, 20];
  // The body: a wedge from the nose to the boot, a little narrower at the top.
  loft([[2.15, 0.32], [2.2, 0.55], [2.06, 0.78], [0.95, 0.97], [-1.55, 1.02], [-2.12, 0.96], [-2.2, 0.6], [-2.15, 0.32]],
    (z) => 0.95 - Math.max(0, z - 0.75) * 0.25, PAINT, () => PAINT);
  // The glasshouse: tinted glass all round, the roof in the paint colour.
  loft([[0.92, 0.97], [-0.05, 1.47], [-0.95, 1.45], [-1.5, 1.01]], (z) => 0.87 - (z - 0.97) * 0.36, GLASS, (i) => (i === 1 ? PAINT : i === 3 ? null : GLASS));
  // Bumpers, grille and lights.
  box(2.1, 2.26, -0.93, 0.93, 0.3, 0.47, TRIM);
  box(-2.27, -2.1, -0.93, 0.93, 0.3, 0.47, TRIM);
  box(2.15, 2.215, -0.38, 0.38, 0.5, 0.64, TRIM);
  for (const s of [1, -1]) {
    box(2.1, 2.2, s > 0 ? 0.5 : -0.86, s > 0 ? 0.86 : -0.5, 0.6, 0.71, [255, 246, 220]);
    box(-2.225, -2.16, s > 0 ? 0.46 : -0.88, s > 0 ? 0.88 : -0.46, 0.72, 0.84, [210, 24, 30]);
    box(0.62, 0.8, s * 0.95, s * 1.07, 1.0, 1.1, PAINT);  // door mirrors
  }
  // Wheels, with dark arches behind them.
  for (const x of [DRIVE.AXLE, -DRIVE.AXLE])
    for (const s of [1, -1]) {
      wheel(x, s * 0.952, 0.34, 0.45, 0.004, ARCH, ARCH, 20);
      wheel(x, s * 0.86, 0.34, 0.34, 0.24, TYRE, RIM);
    }
  return { pos: Float32Array.from(pos), nrm: Float32Array.from(nrm), col: Uint8Array.from(col), idx: Uint32Array.from(idx), gloss: 0.55 };
}

class Driver {
  // ctx: { camera, renderer, mpu(): metres per model unit, bounds(): [min, max] of what is shown,
  //        onExit(), notice(text, ms), fade(), onCrash(strength) }
  constructor(ctx) {
    this.ctx = ctx;
    this.active = false;
    this.placing = false;
    this.input = { gas: false, brake: false, left: false, right: false, hand: false };
    this.stick = null; // a thumb stick on touch screens: [forward, right], 1 at its rim
    // Set from the Drive panel: top speed in km/h, the car casts the sun's shadows, which camera.
    this.settings = { top: 60, shadows: true, cam: 0 };
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
    this.active = true;
    this.pending = true;
    this.releaseAll();
    this.fov0 = camera.fov;
    this.ortho0 = camera.ortho;
    camera.ortho = false;
    Object.assign(this, { x: start[0], y: start[1], z: start[2], a: heading, vF: 0, vL: 0, vz: 0, yaw: 0, steer: 0, pitch: 0, roll: 0, rawPitch: 0, rawRoll: 0,
      grounded: false, air: 0, map: null, stable: [], lastStable: 0, lockUntil: 0, shake: 0, orbit: 0, tilt: 0, dragging: false,
      camPos: null, last: performance.now(), gen: (this.gen || 0) + 1 });
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
    this.place3d();
    this.updateCamera(0);
    return true;
  }

  exit() {
    if (this.placing) { this.placing = false; this.ctx.onExit(); return; }
    if (!this.active) return;
    this.active = false;
    this.releaseAll();
    const { camera, renderer } = this.ctx;
    renderer.setActorPose(null);
    if (this.fov0) camera.fov = this.fov0;
    camera.ortho = this.ortho0;
    this.ctx.onExit();
  }

  releaseAll() { for (const k in this.input) this.input[k] = false; this.stick = null; }

  // Keyboard: returns true when the key was used for driving.
  key(e, down) {
    const k = e.key.toLowerCase(), what = DRIVE_KEYS[k];
    if (what) { this.input[what] = down; return true; }
    if (!down || e.repeat) return false;
    if (k === 'c') { this.settings.cam = (this.settings.cam + 1) % DRIVE_CAMS.length; this.camPos = null; return true; }
    if (k === 'r') { this.reset(); return true; }
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
  get topSpeed() { return this.settings.top / 3.6; }

  // Ask the renderer for the surroundings. Resolves to the decoded map, or null if a previous look
  // is still in flight or the probe failed (the caller asks again).
  async look(top) {
    const { renderer } = this.ctx, u = this.u, [mn] = this.ctx.bounds();
    const ahead = Math.max(this.speed, Math.hypot(this.vF || 0, this.vL || 0)) * DRIVE.LOOKAHEAD;
    const half = (DRIVE.HALF + ahead) * u;
    const q = { x: this.x, y: this.y, half, top, bottom: Math.min(mn[2], this.z) - 5 * u,
      reach: half, z0: this.z + DRIVE.CLIMB * u, z1: this.z + DRIVE.ROOF * u };
    const r = await renderer.probe(q);
    if (!r) return null;
    const G = PROBE.ground, cell = (2 * q.half) / G;
    const walls = [];
    for (let i = 0; i < r.walls.length; i += 4) if (r.walls[i + 3] > 0) walls.push(r.walls[i], r.walls[i + 1], r.walls[i + 2]);
    // Copied: the renderer reuses its arrays for the next look.
    return { x0: q.x - q.half, y1: q.y + q.half, cell, G, g: r.ground.slice(), walls };
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
    const I = this.input, out = { gas: I.gas, brake: I.brake, steer: (I.left ? 1 : 0) - (I.right ? 1 : 0), hand: I.hand, throttle: 1 };
    if (!I.gas && !I.brake && !I.left && !I.right && this.stick) {
      const [f, r] = this.stick;
      out.gas = f > 0.15; out.brake = f < -0.15; out.throttle = Math.min(1, Math.abs(f));
      out.steer = -Math.max(-1, Math.min(1, r));
    }
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
    const speed = Math.abs(vF);
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
    // Back to x and y, then the move in short steps, pushed out of obstacles.
    const f = [Math.cos(this.a), Math.sin(this.a)], l = [-f[1], f[0]];
    let v = [f[0] * vF + l[0] * vL, f[1] * vF + l[1] * vL];
    v = this.move(v, dt);
    this.vF = v[0] * f[0] + v[1] * f[1];
    this.vL = v[0] * l[0] + v[1] * l[1];

    // The ground under each wheel: the car's height, pitch and roll.
    const wheels = [[1, 1], [1, -1], [-1, 1], [-1, -1]].map(([sx, sy]) => {
      const p = [this.x + f[0] * sx * DRIVE.AXLE * u + l[0] * sy * (DRIVE.TRACK / 2) * u, this.y + f[1] * sx * DRIVE.AXLE * u + l[1] * sy * (DRIVE.TRACK / 2) * u];
      // Moving onto a ramp, the ground ahead of a wheel rises above last frame's plane.
      return this.groundAt(p, DRIVE.WHEEL_R * u, this.planeAt(...p) + (DRIVE.CLIMB + DRIVE.SLOPE * (Math.abs(vF) * dt + 0.1)) * u);
    });
    const known = wheels.filter((g) => g != null), offMap = wheels.some((g) => g === undefined);
    const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
    const g = known.length && !offMap ? mean(known) : offMap ? this.z : null;
    if (known.length === 4) {
      const [fl, fr, rl, rr] = wheels, ease = 1 - Math.exp(-dt / DRIVE.TILT_EASE);
      const pitch = Math.atan2((fl + fr - rl - rr) / 2, DRIVE.WHEELBASE * u), roll = Math.atan2((fl + rl - fr - rr) / 2, DRIVE.TRACK * u);
      this.rawPitch = pitch; this.rawRoll = roll;
      this.pitch += (Math.max(-0.6, Math.min(0.6, pitch)) - this.pitch) * ease;
      this.roll += (Math.max(-0.5, Math.min(0.5, roll)) - this.roll) * ease;
    }
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
      } else {
        this.grounded = false;
        this.air = 0;
      }
    }
    if (!this.grounded) {
      this.air += dt;
      this.vz -= DRIVE.GRAVITY * dt;
      this.z += this.vz * u * dt;
      // Level out a little in the air.
      this.pitch *= Math.exp(-dt * 0.8);
      this.roll *= Math.exp(-dt * 0.8);
      if (g != null && this.z <= g) {
        if (this.vz < -4) this.bump(Math.min(1, -this.vz / 16));
        this.z = g; this.vz = 0; this.grounded = true;
      }
      const [mn] = this.ctx.bounds();
      if (this.z < mn[2] - 5 * u || (g == null && this.air > DRIVE.LOST)) this.lost(now);
    }
    this.place3d();
    this.updateCamera(dt);
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

  bump(strength) {
    this.shake = Math.max(this.shake, strength);
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
      lockUntil: now + DRIVE.LOCK * 1000, map: null, stable: [s], gen: this.gen + 1, camPos: null });
    this.ctx.fade();
  }

  // The car's transform, its metres to the model, for the renderer.
  place3d() {
    const u = this.u, ca = Math.cos(this.a), sa = Math.sin(this.a), cp = Math.cos(this.pitch), sp = Math.sin(this.pitch), cr = Math.cos(this.roll), sr = Math.sin(this.roll);
    // Heading about z, then pitch (nose up), then roll (left side up) about the car's length.
    const fx = [ca * cp, sa * cp, sp];
    const left0 = [-sa, ca, 0], up0 = V3.cross(fx, left0);
    const left = V3.add(V3.scale(left0, cr), V3.scale(up0, sr)), up = V3.cross(fx, left);
    this.basis = { f: fx, l: left, up };
    // From the driver's seat the car itself is left out: the glass is solid.
    if (DRIVE_CAMS[this.settings.cam].eye) { this.ctx.renderer.setActorPose(null); return; }
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
      eye = V3.add(at, V3.add(V3.add(V3.scale(b.f, C.eye[0] * u), V3.scale(b.l, C.eye[1] * u)), V3.scale(b.up, C.eye[2] * u)));
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
