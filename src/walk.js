// Pedestrian mode: walk around the model at eye height, with WASD / arrow keys and drag to look.
//
// The walker is a vertical cylinder standing on the highest surface under its footprint. Each frame
// the renderer draws a small view of the surroundings (Renderer.probe): a ground map looking down
// from head height, and four views looking out sideways between step height and head height, so
// walls modelled as single vertical surfaces are seen too. Results arrive a frame or two late,
// which the footprint and body radius cover at walking speed.
//
// Rules: steps and walls up to STEP high are climbed; anything between STEP and the top of the
// head blocks, and movement slides along it. Where the ground drops away the walker waits LEDGE
// seconds (gaps between floors in imperfect models) and then falls under gravity. A fall with
// nothing below, or below the model, returns the walker to its last stable position.
//
// Space jumps (an upward kick, then gravity). E and Q rise and sink at a steady speed, ignoring
// gravity while held; sinking stops on the ground. With Fly on there is no gravity: the walker
// hovers wherever E and Q leave it, stays level off edges, and lands when ground comes up to it.
//
// All lengths here are in metres; the model is in its own units (mpu = metres per unit).

const WALK = {
  EYE: 1.5,         // eye height above the ground
  HEAD: 1.65,       // top of the head: obstacles below this block
  STEP: 1.0,        // highest step or wall that can be climbed
  BODY: 0.25,       // body radius: keeps the eye this far from walls
  FOOT: 0.25,       // footprint radius: the ground is the highest surface within it
  DROP: 0.3,        // drops up to this follow the ground (stairs down); more is a fall
  LEDGE: 0.15,      // seconds over a drop before falling starts
  MIN_SPEED: 0.5,   // walking speed range (m/s) of the Walk panel's slider
  MAX_SPEED: 15,
  MIN_FOV: 10,      // field of view range (degrees) for zooming with the mouse wheel
  MAX_FOV: 75,
  RUN: 3,           // Shift runs at this times the walking speed
  ACCEL: 0.08,      // time constant for speeding up and slowing down
  LOOKAHEAD: 0.1,   // seconds of travel the probes look ahead (beyond REACH and GROUND_HALF)
  SUBSTEP: 0.1,     // longest single move, so thin walls cannot be stepped over
  GRAVITY: 9.81,
  JUMP: 3.5,        // take-off speed (m/s) of a jump: about 0.6 m high
  CLIMB: 2,         // rising and sinking speed (m/s) with E and Q; Shift multiplies it by RUN
  GROUND_HALF: 1.5, // the ground map covers ±this around the walker
  REACH: 0.6,       // the wall views look this far out
  LOST: 3,          // seconds falling with nothing below before returning
  LOCK: 1,          // seconds the controls are locked after returning
  EASE: 0.07,       // time constant for the eye following steps up and down
};

const MOVE_KEYS = { w: [1, 0], arrowup: [1, 0], s: [-1, 0], arrowdown: [-1, 0], a: [0, -1], arrowleft: [0, -1], d: [0, 1], arrowright: [0, 1] };
const CLIMB_KEYS = { e: 1, q: -1 };

class Walker {
  // ctx: { camera, renderer, mpu(): metres per model unit, bounds(): [min, max] of what is shown,
  //        shift(): Shift held, onExit(), notice(text, ms), fade() }
  constructor(ctx) {
    this.ctx = ctx;
    this.active = false;
    this.keys = new Set();
    // Set from the Walk panel: walking speed in m/s, walls block, no gravity.
    this.settings = { speed: 1.4, collide: true, fly: false };
  }

  // Current target speed in m/s.
  speed() { return this.settings.speed * (this.ctx.shift() ? WALK.RUN : 1); }

  get u() { return 1 / this.ctx.mpu(); } // model units per metre

  // Choosing where to start: the person picks a point in the model (main.js), then enter(point).
  // exit() cancels it.
  place() { this.placing = true; }

  // Starts walking from the current (perspective) camera, or with start ([x, y, z], model units)
  // standing on the ground below that point, looking level. Resolves false, with a notice, when
  // there is nothing below to stand on.
  async enter(start = null) {
    const { camera } = this.ctx, u = this.u;
    const before = camera.snapshot();
    if (start) {
      camera.pitch = 0;
      camera.distance = 5 * u;
      camera.target = V3.sub([start[0], start[1], start[2] + WALK.EYE * u], V3.scale(camera.dir, camera.distance));
    }
    const eye = camera.eye;
    this.placing = false;
    this.active = true;
    this.pending = true;
    this.keys.clear();
    Object.assign(this, { pos: [eye[0], eye[1]], foot: eye[2] - WALK.EYE * u, vz: 0, air: 0, grounded: false, entryFall: false,
      lag: 0, lockUntil: 0, stable: [], lastStable: 0, map: null, vel: [0, 0], level: false, fallFrom: 0, last: performance.now(), gen: (this.gen || 0) + 1 });
    this.fov0 = camera.fov;
    camera.distance = 5 * u; // keeps the near plane and haze sensible at eye level
    camera.target = V3.sub(eye, V3.scale(camera.dir, camera.distance));
    // The first look round: the ground straight below the camera, however far down.
    let map = null;
    while (this.active && !(map = await this.look(eye[2] + 0.01 * u))) await new Promise(requestAnimationFrame);
    if (!this.active) return false;
    this.pending = false;
    const g = map && this.groundAt(this.pos, WALK.FOOT * u, eye[2], map);
    if (g == null) {
      camera.restore(before);
      this.ctx.notice('There is nothing below the camera to stand on. Move the camera over the model, then start walking.');
      this.exit();
      return false;
    }
    this.map = map;
    // Closer than eye height, or a chosen start point: stand on it.
    if (start || g > eye[2] - WALK.EYE * u) { this.foot = g; this.grounded = true; }
    else this.entryFall = true;
    this.updateCamera();
    return true;
  }

  exit() {
    if (this.placing) { this.placing = false; this.ctx.onExit(); return; }
    if (!this.active) return;
    this.active = false;
    this.keys.clear();
    if (this.fov0) this.ctx.camera.fov = this.fov0;
    this.ctx.onExit();
  }

  // Keyboard: returns true when the key was used for walking.
  key(e, down) {
    const k = e.key.toLowerCase();
    if (k === ' ') { if (down && !e.repeat) this.jump(); return true; }
    if (!MOVE_KEYS[k] && !CLIMB_KEYS[k]) return false;
    if (!down) this.keys.delete(k);
    else { this.keys.add(k); if (MOVE_KEYS[k]) this.skipFall(); }
    return true;
  }
  blur() { this.keys.clear(); }

  // Jumps from the ground (not while flying, where E rises instead).
  jump() {
    if (!this.grounded || this.settings.fly || performance.now() < this.lockUntil) return;
    Object.assign(this, { grounded: false, vz: WALK.JUMP * this.u, air: 0, fallFrom: this.foot });
  }

  // A long fall on entry ends as soon as the person moves or clicks (unless flying: then the
  // walker stays where the camera was).
  skipFall() {
    if (!this.entryFall || !this.map || this.settings.fly) return;
    const g = this.groundAt(this.pos, WALK.FOOT * this.u, this.foot + WALK.HEAD * this.u);
    if (g != null) this.land(g);
  }

  // Drag to look: dx, dy in CSS pixels. The view follows the pointer.
  turn(dx, dy) {
    const { camera } = this.ctx, eye = camera.eye;
    const lim = (89 * Math.PI) / 180;
    this.level = false;
    camera.yaw -= dx * 0.004;
    camera.pitch = Math.max(-lim, Math.min(lim, camera.pitch + dy * 0.004));
    camera.target = V3.sub(eye, V3.scale(camera.dir, camera.distance));
  }

  // Mouse wheel: zooms by narrowing or widening the field of view (the eye stays where the walker
  // stands). Walking ends with the field of view it started with.
  zoom(deltaY) {
    const { camera } = this.ctx, deg = Math.PI / 180;
    camera.fov = Math.max(WALK.MIN_FOV * deg, Math.min(WALK.MAX_FOV * deg, camera.fov * Math.exp(deltaY * 0.0015)));
  }

  // Ask the renderer for the surroundings at the current position. top: the ground map looks down
  // from here. Resolves to the decoded map, or null if a previous look is still in flight or the
  // probe failed (the caller asks again).
  async look(top) {
    const { renderer } = this.ctx, u = this.u, [mn] = this.ctx.bounds();
    // Faster movement looks further ahead, so walls are seen before the walker reaches them.
    const ahead = Math.max(this.speed(), Math.hypot(...(this.vel || [0, 0]))) * WALK.LOOKAHEAD;
    const q = { x: this.pos[0], y: this.pos[1], half: (WALK.GROUND_HALF + ahead) * u, top, bottom: Math.min(mn[2], this.foot) - 5 * u,
      reach: (WALK.REACH + ahead) * u, z0: this.foot + WALK.STEP * u, z1: this.foot + WALK.HEAD * u };
    const r = await renderer.probe(q);
    if (!r) return null;
    // Ground cells by row and column, and the walls as a list of hit points.
    const G = PROBE.ground, cell = (2 * q.half) / G;
    const walls = [];
    for (let i = 0; i < r.walls.length; i += 4) if (r.walls[i + 3] > 0) walls.push(r.walls[i], r.walls[i + 1], r.walls[i + 2]);
    return { x0: q.x - q.half, y1: q.y + q.half, cell, G, g: r.ground, walls };
  }

  // Highest ground within radius r of p that is no higher than `below`, or null (nothing there,
  // or p is off the map).
  groundAt(p, r, below, map = this.map) {
    if (!map) return null;
    const { x0, y1, cell, G, g } = map;
    const c0 = Math.floor((p[0] - r - x0) / cell), c1 = Math.floor((p[0] + r - x0) / cell);
    const r0 = Math.floor((y1 - p[1] - r) / cell), r1 = Math.floor((y1 - p[1] + r) / cell);
    if (c0 < 0 || r0 < 0 || c1 >= G || r1 >= G) return null;
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

  // Obstacle points (x, y) near p: wall hits and ground cells between step and head height.
  obstacles(p, r) {
    const u = this.u, lo = this.foot + WALK.STEP * u, hi = this.foot + WALK.HEAD * u, out = [], m = this.map;
    const near = (x, y) => (x - p[0]) ** 2 + (y - p[1]) ** 2 < r * r;
    const w = m.walls;
    for (let i = 0; i < w.length; i += 3) if (w[i + 2] > lo && w[i + 2] < hi && near(w[i], w[i + 1])) out.push([w[i], w[i + 1]]);
    const { x0, y1, cell, G, g } = m;
    const c0 = Math.max(0, Math.floor((p[0] - r - x0) / cell)), c1 = Math.min(G - 1, Math.floor((p[0] + r - x0) / cell));
    const r0 = Math.max(0, Math.floor((y1 - p[1] - r) / cell)), r1 = Math.min(G - 1, Math.floor((y1 - p[1] + r) / cell));
    for (let row = r0; row <= r1; row++)
      for (let col = c0; col <= c1; col++) {
        const i = (row * G + col) * 4;
        if (g[i + 3] > 0 && g[i + 2] > lo && g[i + 2] < hi && near(g[i], g[i + 1])) out.push([g[i], g[i + 1]]);
      }
    return out;
  }

  land(g) {
    this.lag += this.foot - g;
    if (this.entryFall) this.lag = 0;
    // After a real fall, a view pointing down comes back up to the horizontal.
    if ((this.entryFall || this.fallFrom - g > WALK.STEP * this.u) && this.ctx.camera.pitch > 0) this.level = true;
    Object.assign(this, { foot: g, vz: 0, grounded: true, air: 0, entryFall: false });
  }

  // Called every frame while active.
  update(now) {
    const dt = Math.min(0.05, (now - this.last) / 1000);
    this.last = now;
    if (this.pending) return;
    const u = this.u, { camera } = this.ctx;
    // Keep a look in flight; each one replaces the map when it arrives, unless the walker has
    // been moved back since (gen).
    const gen = this.gen;
    this.look(this.foot + WALK.HEAD * u).then((m) => { if (m && this.active && gen === this.gen) this.map = m; });
    if (!this.map) return;

    // Horizontal movement: the velocity (m/s) eases towards what the keys ask for.
    const f = camera.forward, fl = Math.hypot(f[0], f[1]) || 1, fwd = [f[0] / fl, f[1] / fl], right = [fwd[1], -fwd[0]];
    let mf = 0, mr = 0;
    if (now >= this.lockUntil) for (const k of this.keys) if (MOVE_KEYS[k]) { mf += MOVE_KEYS[k][0]; mr += MOVE_KEYS[k][1]; }
    const ml = Math.hypot(mf, mr), sp = ml > 0 ? this.speed() / ml : 0, k = 1 - Math.exp(-dt / WALK.ACCEL);
    const want = [(fwd[0] * mf + right[0] * mr) * sp, (fwd[1] * mf + right[1] * mr) * sp];
    this.vel = now < this.lockUntil ? [0, 0] : [this.vel[0] + (want[0] - this.vel[0]) * k, this.vel[1] + (want[1] - this.vel[1]) * k];
    if (!ml && Math.hypot(...this.vel) < 0.02) this.vel = [0, 0];
    if (this.vel[0] || this.vel[1]) this.move([this.vel[0] * dt * u, this.vel[1] * dt * u]);
    const p = this.pos;

    // Vertical: follow the ground, climb steps, fall where it drops away. E and Q rise and sink
    // at a steady speed (Q only off the ground).
    const fly = this.settings.fly;
    let climb = 0;
    if (now >= this.lockUntil) for (const k of this.keys) climb += CLIMB_KEYS[k] || 0;
    if (climb < 0 && this.grounded) climb = 0;
    if (climb) Object.assign(this, { grounded: false, entryFall: false, air: 0, vz: climb * WALK.CLIMB * (this.ctx.shift() ? WALK.RUN : 1) * u });
    else if (this.climbing) this.vz = 0; // let go: stop, then fall from rest
    this.climbing = climb !== 0;
    const g = this.groundAt(p, WALK.FOOT * u, this.foot + WALK.STEP * u);
    if (this.grounded) {
      if (g != null && g >= this.foot - WALK.DROP * u) {
        this.lag += this.foot - g;
        this.foot = g;
        this.air = 0;
        if (now - this.lastStable > 500) {
          this.lastStable = now;
          this.stable.push([...p, g]);
          if (this.stable.length > 3) this.stable.shift();
        }
      } else if (fly || (this.air += dt) > WALK.LEDGE) {
        // Off an edge: fall, or with Fly on, hover at this height.
        Object.assign(this, { grounded: false, fallFrom: this.foot, air: 0, vz: 0 });
      }
    } else {
      this.air += dt;
      // Only a fall under gravity counts towards levelling the view on landing.
      if (climb || fly) this.fallFrom = this.foot;
      if (fly && !climb) this.vz = 0;
      else if (!climb) this.vz -= WALK.GRAVITY * u * dt;
      const z = this.foot + this.vz * dt;
      // Rising passes through ledges; coming down (or hovering) lands on them.
      if (g != null && z <= g && this.vz <= 0) this.land(g);
      else this.foot = z;
      const [mn] = this.ctx.bounds();
      const below = this.groundAt(p, WALK.FOOT * u, this.foot + WALK.STEP * u);
      if (!this.grounded && (this.foot < mn[2] - 2 * u || (below == null && this.air > WALK.LOST && !fly))) this.lost(now);
    }
    this.lag *= Math.exp(-dt / WALK.EASE);
    if (this.level) {
      camera.pitch *= Math.exp(-dt / 0.15);
      if (camera.pitch < 0.003) { camera.pitch = 0; this.level = false; }
    }
    this.updateCamera();
  }

  // Moves the walker by d (model units) in short steps, sliding along walls: each step is pushed
  // out from the nearest obstacle point. A step is refused if it still runs into something (unless
  // it gets the walker out of a tight spot), climbs onto ground that is too high, or leaves the map.
  move(d) {
    const u = this.u, R = WALK.BODY * u, len = Math.hypot(d[0], d[1]), collide = this.settings.collide;
    const n = Math.max(1, Math.ceil(len / (WALK.SUBSTEP * u)));
    const obs = collide ? this.obstacles([this.pos[0] + d[0] / 2, this.pos[1] + d[1] / 2], len / 2 + R * 2) : [];
    const nearest = (at) => {
      let best = null, bd = Infinity;
      for (const q of obs) { const dd = Math.hypot(at[0] - q[0], at[1] - q[1]); if (dd < bd) { bd = dd; best = q; } }
      return [best, bd];
    };
    const m = this.map, margin = (WALK.FOOT + 0.1) * u;
    for (let i = 0; i < n; i++) {
      let p = [this.pos[0] + d[0] / n, this.pos[1] + d[1] / n];
      const [, before] = nearest(this.pos);
      for (let it = 0; it < 4; it++) {
        const [q, dd] = nearest(p);
        if (!q || dd >= R || dd < 1e-9) break;
        p = [p[0] + ((p[0] - q[0]) / dd) * (R - dd), p[1] + ((p[1] - q[1]) / dd) * (R - dd)];
      }
      const [, after] = nearest(p);
      const ahead = collide ? this.groundAt(p, WALK.FOOT * u, this.foot + WALK.HEAD * u) : null;
      const onMap = p[0] - margin > m.x0 && p[0] + margin < m.x0 + m.cell * m.G && p[1] + margin < m.y1 && p[1] - margin > m.y1 - m.cell * m.G;
      if (!onMap || (after < R * 0.9 && after <= before) || (ahead != null && ahead > this.foot + WALK.STEP * u)) break;
      this.pos = p;
    }
  }

  // Fell into the abyss: back to where the walker last stood firmly.
  lost(now) {
    const s = this.stable[0];
    if (!s) { this.ctx.notice('Fell off the model.'); this.exit(); return; }
    this.pos = [s[0], s[1]];
    Object.assign(this, { foot: s[2], vz: 0, vel: [0, 0], grounded: true, air: 0, lag: 0, lockUntil: now + WALK.LOCK * 1000, map: null, stable: [s], gen: this.gen + 1 });
    this.ctx.fade();
  }

  updateCamera() {
    const { camera } = this.ctx, eye = [this.pos[0], this.pos[1], this.foot + (WALK.EYE * this.u) + this.lag];
    camera.target = V3.sub(eye, V3.scale(camera.dir, camera.distance));
  }
}
