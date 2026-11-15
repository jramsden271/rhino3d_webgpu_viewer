// Wind (CFD-lite): a lattice Boltzmann solver on the GPU, for the wind round buildings.
//
// D3Q19 lattice, BGK collision with a Smagorinsky subgrid model (the eddies smaller than a cell),
// on a box of cubic cells lined up with the wind: it blows along +x, from the inlet at x = 0 to the
// outlet at x = nx - 1. Solid cells (the model: see wind.js) and the floor send back what reaches
// them: walls straight back (no slip, halfway bounce-back), the floor, the ground and roofs as a
// mirror would (free slip; see wall()). The sides are mirrors too (or joined round, for the empty
// reference). The inlet and the top hold the undisturbed wind, whose speed rises with height (the
// inlet profile, in lattice units: cells per step); the outlet lets the air out at the open air's
// pressure, after a damping zone.
//
// The 19 distributions of a cell are kept as half floats, two to a u32, less their value at rest
// (w_i), which keeps their precision: 10 half floats in one buffer, 9 in another, each laid out
// direction by direction (all cells' first pair, then their second...). Two copies are used in turn:
// each step reads one and writes the other ("pull" streaming, then collision).
//
// Every few steps the speed at each cell is added to a running sum, for the average once the flow
// has settled; level() reads the speed (now, or the average) at a height above the ground in each
// column.

const WG = 64;

// Directions: rest, the 6 faces, the 12 edges. Each odd direction's opposite is the next one.
const STEP_WGSL = /* wgsl */ `
struct Params { nx: u32, ny: u32, nz: u32, n: u32, tau0: f32, smag: f32, acc: u32, init: u32, periodic: u32, pad0: u32, pad1: u32, pad2: u32 };
@group(0) @binding(0) var<uniform> P: Params;
@group(0) @binding(1) var<storage, read> src0: array<u32>;
@group(0) @binding(2) var<storage, read> src1: array<u32>;
@group(0) @binding(3) var<storage, read_write> dst0: array<u32>;
@group(0) @binding(4) var<storage, read_write> dst1: array<u32>;
@group(0) @binding(5) var<storage, read> solid: array<u32>;
@group(0) @binding(6) var<storage, read> inlet: array<f32>;
@group(0) @binding(7) var<storage, read_write> sum: array<f32>;

var<private> EX: array<i32, 19> = array<i32, 19>(0, 1, -1, 0, 0, 0, 0, 1, -1, 1, -1, 0, 0, 1, -1, 1, -1, 0, 0);
var<private> EY: array<i32, 19> = array<i32, 19>(0, 0, 0, 1, -1, 0, 0, 1, -1, 0, 0, 1, -1, -1, 1, 0, 0, 1, -1);
var<private> EZ: array<i32, 19> = array<i32, 19>(0, 0, 0, 0, 0, 1, -1, 0, 0, 1, -1, 1, -1, 0, 0, -1, 1, -1, 1);
var<private> W: array<f32, 19> = array<f32, 19>(1.0 / 3.0, 1.0 / 18.0, 1.0 / 18.0, 1.0 / 18.0, 1.0 / 18.0, 1.0 / 18.0, 1.0 / 18.0,
  1.0 / 36.0, 1.0 / 36.0, 1.0 / 36.0, 1.0 / 36.0, 1.0 / 36.0, 1.0 / 36.0, 1.0 / 36.0, 1.0 / 36.0, 1.0 / 36.0, 1.0 / 36.0, 1.0 / 36.0, 1.0 / 36.0);
// Each direction mirrored top to bottom.
var<private> MZ: array<u32, 19> = array<u32, 19>(0u, 1u, 2u, 3u, 4u, 6u, 5u, 7u, 8u, 15u, 16u, 17u, 18u, 13u, 14u, 9u, 10u, 11u, 12u);
// Each direction mirrored side to side.
var<private> MY: array<u32, 19> = array<u32, 19>(0u, 1u, 2u, 4u, 3u, 5u, 6u, 13u, 14u, 9u, 10u, 18u, 17u, 7u, 8u, 15u, 16u, 12u, 11u);

fn opp(i: u32) -> u32 { if (i == 0u) { return 0u; } return select(i - 1u, i + 1u, (i & 1u) == 1u); }
fn isSolid(c: u32) -> bool { return (solid[c >> 5u] & (1u << (c & 31u))) != 0u; }

// Distribution i of cell c (less its value at rest), from the copy read this step.
fn readF(i: u32, c: u32) -> f32 {
  let p = i >> 1u;
  var word: u32;
  if (p < 5u) { word = src0[p * P.n + c]; } else { word = src1[(p - 5u) * P.n + c]; }
  let v = unpack2x16float(word);
  return select(v.y, v.x, (i & 1u) == 0u);
}

// The equilibrium of direction i for density rho and velocity u, less its value at rest.
fn geq(i: u32, rho: f32, u: vec3f) -> f32 {
  let eu = f32(EX[i]) * u.x + f32(EY[i]) * u.y + f32(EZ[i]) * u.z;
  return W[i] * (rho * (1.0 + 3.0 * eu + 4.5 * eu * eu - 1.5 * dot(u, u)) - 1.0);
}

// What comes back off a solid surface in direction i. Up off the floor, the ground and roofs, the
// wind slides along it (it is reflected as off a mirror, from the cell beside this one it left):
// on a grid this coarse, holding it still there (no slip) slows the lowest cells far more than real
// ground does. Off walls and anything else it bounces straight back (no slip).
fn wall(i: u32, x: u32, y: u32, z: u32, c: u32, sx: i32, sy: i32) -> f32 {
  if (EZ[i] == 1) {
    let h = u32(sx) + P.nx * (u32(sy) + P.ny * z);
    if (!isSolid(h)) { return readF(MZ[i], h); }
  }
  return readF(opp(i), c);
}

// What comes in through the sides: the wind slides along them (reflected as off a mirror, from the
// cell beside this one it left). Holding the open wind there instead boxed the air in: what the
// buildings pushed aside could not spread out, and the whole site sped up.
fn side(i: u32, c: u32, sx: i32, y: u32, sz: i32, far: vec3f) -> f32 {
  if (sz < 0) { return readF(opp(i), c); }
  let h = u32(sx) + P.nx * (y + P.ny * u32(sz));
  if (isSolid(h)) { return readF(opp(i), c); }
  return readF(MY[i], h);
}

@compute @workgroup_size(${WG})
fn step(@builtin(global_invocation_id) id: vec3u) {
  let x = id.x; let y = id.y; let z = id.z;
  if (x >= P.nx) { return; }
  let c = x + P.nx * (y + P.ny * z);
  if (isSolid(c)) { return; }
  let far = vec3f(inlet[z], 0.0, 0.0);
  var g: array<f32, 19>;
  if (P.init == 1u) {
    for (var i = 0u; i < 19u; i++) { g[i] = geq(i, 1.0, far); }
  } else {
    // The outlet lets the air out at the open air's pressure, at the speed it reaches it (never
    // drawing any back in): copying what was there instead let eddies leaving the grid bounce back
    // in and grow, until the whole flow ran away.
    var out = far;
    if (x == P.nx - 1u) {
      var r0 = 1.0;
      var m0 = vec3f(0.0);
      for (var i = 0u; i < 19u; i++) { let f = readF(i, c); r0 += f; m0 += vec3f(f32(EX[i]), f32(EY[i]), f32(EZ[i])) * f; }
      out = m0 / r0;
      out.x = max(out.x, 0.25 * inlet[z]);
    }
    // Streaming: each direction from the neighbour it comes from.
    for (var i = 0u; i < 19u; i++) {
      let sx = i32(x) - EX[i]; let sz = i32(z) - EZ[i];
      var sy = i32(y) - EY[i];
      if (P.periodic == 1u) { sy = (sy + i32(P.ny)) % i32(P.ny); }                      // the sides joined round
      if (sx < 0) { g[i] = geq(i, 1.0, vec3f(inlet[z], 0.0, 0.0)); }                       // the inlet
      else if (sx >= i32(P.nx)) { g[i] = geq(i, 1.0, out); }                                // the outlet
      else if (sz >= i32(P.nz)) { g[i] = geq(i, 1.0, far); }                               // the top: the open wind
      else if (sy < 0 || sy >= i32(P.ny)) { g[i] = side(i, c, sx, y, sz, far); }           // the sides
      else if (sz < 0 || isSolid(u32(sx) + P.nx * (u32(sy) + P.ny * u32(sz)))) { g[i] = wall(i, x, y, z, c, sx, sy); }
      else {
        let s = u32(sx) + P.nx * (u32(sy) + P.ny * u32(sz));
        g[i] = readF(i, s);
      }
    }
  }
  var rho = 1.0;
  var m = vec3f(0.0);
  for (var i = 0u; i < 19u; i++) { rho += g[i]; m += vec3f(f32(EX[i]), f32(EY[i]), f32(EZ[i])) * g[i]; }
  var u = m / rho;
  // Should anything go wrong (it can, at sharp corners on a coarse grid), start the cell again.
  let bad = !(rho > 0.6 && rho < 1.6) || !(dot(u, u) < 0.09);
  if (bad) { rho = 1.0; u = far; for (var i = 0u; i < 19u; i++) { g[i] = geq(i, 1.0, far); } }
  // Smagorinsky: the relaxation time grows with the strain, from the non-equilibrium stress.
  var pxx = 0.0; var pyy = 0.0; var pzz = 0.0; var pxy = 0.0; var pxz = 0.0; var pyz = 0.0;
  var eq: array<f32, 19>;
  for (var i = 0u; i < 19u; i++) {
    eq[i] = geq(i, rho, u);
    let d = g[i] - eq[i]; let ex = f32(EX[i]); let ey = f32(EY[i]); let ez = f32(EZ[i]);
    pxx += ex * ex * d; pyy += ey * ey * d; pzz += ez * ez * d; pxy += ex * ey * d; pxz += ex * ez * d; pyz += ey * ez * d;
  }
  let q = sqrt(pxx * pxx + pyy * pyy + pzz * pzz + 2.0 * (pxy * pxy + pxz * pxz + pyz * pyz));
  var tau = 0.5 * (P.tau0 + sqrt(P.tau0 * P.tau0 + P.smag * q / rho));
  // A damping zone before the outlet (the last eighth of the grid, at least 8 cells): the air
  // thickens towards it, so eddies die away before they reach it.
  let sponge = max(8.0, f32(P.nx) / 8.0);
  let sp = clamp((f32(x) - (f32(P.nx) - sponge)) / sponge, 0.0, 1.0);
  tau += sp * sp;
  let k = 1.0 / tau;
  for (var p = 0u; p < 10u; p++) {
    let a = g[2u * p] - (g[2u * p] - eq[2u * p]) * k;
    var b = 0.0;
    if (p < 9u) { b = g[2u * p + 1u] - (g[2u * p + 1u] - eq[2u * p + 1u]) * k; }
    let word = pack2x16float(vec2f(a, b));
    if (p < 5u) { dst0[p * P.n + c] = word; } else { dst1[(p - 5u) * P.n + c] = word; }
  }
  if (P.acc == 1u) { sum[c] += length(u); }
}
`;

// The speed at a height in each column: level[col] is the height (in cells, from the floor) to read
// at; it is read between the two nearest cell centres. mode 0: the speed now; 1: the average.
const LEVEL_WGSL = /* wgsl */ `
struct Params { nx: u32, ny: u32, nz: u32, n: u32, mode: u32, count: f32, pad0: u32, pad1: u32 };
@group(0) @binding(0) var<uniform> P: Params;
@group(0) @binding(1) var<storage, read> src0: array<u32>;
@group(0) @binding(2) var<storage, read> src1: array<u32>;
@group(0) @binding(3) var<storage, read> solid: array<u32>;
@group(0) @binding(4) var<storage, read> sum: array<f32>;
@group(0) @binding(5) var<storage, read> level: array<f32>;
@group(0) @binding(6) var<storage, read_write> out: array<f32>;

var<private> EX: array<i32, 19> = array<i32, 19>(0, 1, -1, 0, 0, 0, 0, 1, -1, 1, -1, 0, 0, 1, -1, 1, -1, 0, 0);
var<private> EY: array<i32, 19> = array<i32, 19>(0, 0, 0, 1, -1, 0, 0, 1, -1, 0, 0, 1, -1, -1, 1, 0, 0, 1, -1);
var<private> EZ: array<i32, 19> = array<i32, 19>(0, 0, 0, 0, 0, 1, -1, 0, 0, 1, -1, 1, -1, 0, 0, -1, 1, -1, 1);

fn isSolid(c: u32) -> bool { return (solid[c >> 5u] & (1u << (c & 31u))) != 0u; }
fn readF(i: u32, c: u32) -> f32 {
  let p = i >> 1u;
  var word: u32;
  if (p < 5u) { word = src0[p * P.n + c]; } else { word = src1[(p - 5u) * P.n + c]; }
  let v = unpack2x16float(word);
  return select(v.y, v.x, (i & 1u) == 0u);
}
fn speedAt(c: u32) -> f32 {
  if (P.mode == 1u) { return sum[c] / max(P.count, 1.0); }
  var rho = 1.0;
  var m = vec3f(0.0);
  for (var i = 0u; i < 19u; i++) { let g = readF(i, c); rho += g; m += vec3f(f32(EX[i]), f32(EY[i]), f32(EZ[i])) * g; }
  return length(m / rho);
}

@compute @workgroup_size(${WG})
fn readLevel(@builtin(global_invocation_id) id: vec3u) {
  let x = id.x; let y = id.y;
  if (x >= P.nx || y >= P.ny) { return; }
  let col = x + P.nx * y;
  let h = clamp(level[col] - 0.5, 0.0, f32(P.nz) - 1.001);
  let k0 = u32(floor(h)); let t = h - f32(k0);
  let a = x + P.nx * (y + P.ny * k0); let b = a + P.nx * P.ny;
  let sa = isSolid(a); let sb = isSolid(b);
  var v = 0.0;
  if (sa && sb) { v = 0.0; }
  else if (sa) { v = speedAt(b); }
  else if (sb) { v = speedAt(a); }
  else { v = mix(speedAt(a), speedAt(b), t); }
  out[col] = v;
}
`;

export class WindSolver {
  constructor(device) {
    this.device = device;
    const dev = device;
    this.stepPipe = dev.createComputePipeline({ layout: 'auto', compute: { module: dev.createShaderModule({ code: STEP_WGSL }), entryPoint: 'step' } });
    this.levelPipe = dev.createComputePipeline({ layout: 'auto', compute: { module: dev.createShaderModule({ code: LEVEL_WGSL }), entryPoint: 'readLevel' } });
    this.bufs = [];
  }

  // The largest grid (cells) the device can hold: each buffer of distributions is 20 bytes a cell.
  static maxCells(device) {
    return Math.floor(Math.min(device.limits.maxStorageBufferBindingSize, device.limits.maxBufferSize) / 20);
  }

  // A new grid: nx × ny × nz cells; solid: Uint32Array of bits, one per cell (x fastest, then y,
  // then z); inlet: Float32Array(nz), the wind's speed at each height (cells per step); nu: the
  // lattice viscosity; cs: the Smagorinsky constant; periodicY: the sides are joined round (what leaves
  // one comes in at the other) rather than holding the open wind. Starts the flow as the open wind everywhere.
  setup({ nx, ny, nz, solid, inlet, nu = 0.0005, cs = 0.17, periodicY = false }) {
    this.destroy();
    const dev = this.device, U = GPUBufferUsage, n = nx * ny * nz;
    Object.assign(this, { nx, ny, nz, n, tau0: 0.5 + 3 * nu, smag: 18 * Math.SQRT2 * cs * cs, steps: 0, count: 0, periodicY });
    const buf = (size, usage) => { const b = dev.createBuffer({ size: Math.max(16, Math.ceil(size / 16) * 16), usage }); this.bufs.push(b); return b; };
    const f = () => buf(5 * n * 4, U.STORAGE);
    this.f = [[f(), f()], [f(), f()]];
    this.solid = buf(solid.byteLength, U.STORAGE | U.COPY_DST);
    dev.queue.writeBuffer(this.solid, 0, solid);
    this.inlet = buf(nz * 4, U.STORAGE | U.COPY_DST);
    dev.queue.writeBuffer(this.inlet, 0, inlet);
    this.sum = buf(n * 4, U.STORAGE | U.COPY_DST);
    this.params = [0, 1, 2, 3].map(() => buf(48, U.UNIFORM | U.COPY_DST));
    // Params for: a step from copy 0 and from copy 1, each plain or adding to the sum; the first
    // step (from nothing) uses the same as 'from copy 1, plain', with init set.
    const layout = this.stepPipe.getBindGroupLayout(0);
    this.stepBG = [0, 1].map((from) => [0, 1].map((acc) => dev.createBindGroup({ layout, entries: [
      { binding: 0, resource: { buffer: this.params[from * 2 + acc] } },
      { binding: 1, resource: { buffer: this.f[from][0] } }, { binding: 2, resource: { buffer: this.f[from][1] } },
      { binding: 3, resource: { buffer: this.f[1 - from][0] } }, { binding: 4, resource: { buffer: this.f[1 - from][1] } },
      { binding: 5, resource: { buffer: this.solid } }, { binding: 6, resource: { buffer: this.inlet } }, { binding: 7, resource: { buffer: this.sum } }] })));
    this.writeParams(0);
    this.cur = 0;
    // The first step writes the open wind into copy 0, from copy 1 (unread).
    const enc = dev.createCommandEncoder();
    this.writeParams(1);
    this.encodeStep(enc, 1, 0);
    dev.queue.submit([enc.finish()]);
    this.writeParams(0);
    this.cur = 0;
    // Reading levels.
    this.levelParams = buf(32, U.UNIFORM | U.COPY_DST);
    this.levelIn = buf(nx * ny * 4, U.STORAGE | U.COPY_DST);
    this.levelOut = buf(nx * ny * 4, U.STORAGE | U.COPY_SRC);
    this.levelRead = buf(nx * ny * 4, U.MAP_READ | U.COPY_DST);
    this.levelBG = [0, 1].map((from) => dev.createBindGroup({ layout: this.levelPipe.getBindGroupLayout(0), entries: [
      { binding: 0, resource: { buffer: this.levelParams } },
      { binding: 1, resource: { buffer: this.f[from][0] } }, { binding: 2, resource: { buffer: this.f[from][1] } },
      { binding: 3, resource: { buffer: this.solid } }, { binding: 4, resource: { buffer: this.sum } },
      { binding: 5, resource: { buffer: this.levelIn } }, { binding: 6, resource: { buffer: this.levelOut } }] }));
  }

  writeParams(init) {
    const { nx, ny, nz, n } = this;
    for (let k = 0; k < 4; k++) {
      const p = new ArrayBuffer(48), u = new Uint32Array(p), fl = new Float32Array(p);
      u[0] = nx; u[1] = ny; u[2] = nz; u[3] = n; fl[4] = this.tau0; fl[5] = this.smag; u[6] = k & 1; u[7] = init && k === 2 ? 1 : 0; u[8] = this.periodicY ? 1 : 0;
      this.device.queue.writeBuffer(this.params[k], 0, p);
    }
  }

  encodeStep(enc, from, acc) {
    const pass = enc.beginComputePass();
    pass.setPipeline(this.stepPipe);
    pass.setBindGroup(0, this.stepBG[from][acc]);
    pass.dispatchWorkgroups(Math.ceil(this.nx / WG), this.ny, this.nz);
    pass.end();
  }

  // Runs n steps, adding to the average every `every` steps if averaging. Resolves when the GPU
  // has done them.
  run(n, { average = false, every = 10 } = {}) {
    const enc = this.device.createCommandEncoder();
    for (let i = 0; i < n; i++) {
      this.steps++;
      const acc = average && this.steps % every === 0 ? 1 : 0;
      if (acc) this.count++;
      this.encodeStep(enc, this.cur, acc);
      this.cur = 1 - this.cur;
    }
    this.device.queue.submit([enc.finish()]);
    return this.device.queue.onSubmittedWorkDone();
  }

  // Forgets the average so far.
  resetAverage() {
    this.count = 0;
    const enc = this.device.createCommandEncoder();
    enc.clearBuffer(this.sum);
    this.device.queue.submit([enc.finish()]);
  }

  // The speed (cells per step) at heights[col] (cells above the floor) in each column, now or on
  // average. Resolves to a new Float32Array(nx * ny).
  async level(heights, average) {
    const dev = this.device, { nx, ny, nz, n } = this;
    const p = new ArrayBuffer(32), u = new Uint32Array(p), fl = new Float32Array(p);
    u[0] = nx; u[1] = ny; u[2] = nz; u[3] = n; u[4] = average && this.count ? 1 : 0; fl[5] = this.count;
    dev.queue.writeBuffer(this.levelParams, 0, p);
    dev.queue.writeBuffer(this.levelIn, 0, heights);
    const enc = dev.createCommandEncoder(), pass = enc.beginComputePass();
    pass.setPipeline(this.levelPipe);
    pass.setBindGroup(0, this.levelBG[this.cur]);
    pass.dispatchWorkgroups(Math.ceil(nx / WG), ny, 1);
    pass.end();
    enc.copyBufferToBuffer(this.levelOut, 0, this.levelRead, 0, nx * ny * 4);
    dev.queue.submit([enc.finish()]);
    await this.levelRead.mapAsync(GPUMapMode.READ);
    const out = new Float32Array(this.levelRead.getMappedRange(0, nx * ny * 4)).slice();
    this.levelRead.unmap();
    return out;
  }

  destroy() {
    for (const b of this.bufs) b.destroy();
    this.bufs = [];
  }
}
