// WebGPU renderer: reverse-Z depth, 4x MSAA, on-demand redraw, GPU picking for orbit/zoom
// pivots, and sun lighting with cascaded shadow maps.

const CASCADES = 4;
const SHADOW_SIZE = 2048;

const SHADER = /* wgsl */ `
struct Frame {
  viewProj: mat4x4f,
  eye: vec4f,       // xyz eye position, w = 1 when parallel projection
  light: vec4f,     // xyz direction towards the key light (headlight mode)
  viewport: vec4f,  // width, height, point size (px), shading mode (0 shaded, 1 rendered, 2 clay)
  edge: vec4f,      // edge colour
  bgTop: vec4f,
  bgBot: vec4f,
  opts: vec4f,      // x = x-ray alpha (0 = off), y = shadows on, z = ambient occlusion on, w = 1 / shadow depth range
  viewDir: vec4f,   // camera forward
  sunDir: vec4f,    // xyz towards the key light (the sun, or the moon at night), w = 1 when sun lighting is on
  sunColor: vec4f,  // rgb = linear key light colour x intensity, w = sky brightness
  splits: vec4f,    // far view depth of each shadow cascade
  texel: vec4f,     // world size of one shadow texel, per cascade
  ground: vec4f,    // shadow-catcher plane: centre x, centre y, z, half size
  misc: vec4f,      // x = time (s), y = metres per model unit, z = haze start distance, w = haze density
  sel: vec4f,       // yzw = highlight colour for selected objects (see objFlags)
  camRight: vec4f,  // xyz camera right, w = tan(fov / 2)
  camUp: vec4f,     // xyz camera up, w = aspect ratio
  skyGlow: vec4f,   // rgb = twilight glow along the horizon towards the sun (sRGB), w = night (0 day .. 1 dark)
  stars: vec4f,     // x = latitude, y = local sidereal time, z = north angle (radians)
  moon: vec4f,      // xyz towards the moon, w = illuminated fraction
  skySun: vec4f,    // xyz towards the sun itself (sunDir is the moon when it lights the scene)
  shadow: array<mat4x4f, ${CASCADES}>,
};
// flags.x vertex colours, flags.y edge, flags.z material type (see materials.js), resolved on the
// CPU from the rule mode and any layer settings made in the viewer; flags.w gloss (0..1).
struct Batch { color: vec4f, mat: vec4f, flags: vec4f };

@group(0) @binding(0) var<uniform> F: Frame;
@group(0) @binding(1) var shadowMap: texture_depth_2d_array;
@group(0) @binding(2) var shadowCmp: sampler_comparison;
@group(0) @binding(3) var aoTex: texture_2d<f32>;
@group(0) @binding(4) var<storage, read> objFlags: array<u32>; // per object: bit 0 hidden, bit 1 selected
@group(1) @binding(0) var<uniform> B: Batch;

fn objFlag(oid: u32, bit: u32) -> bool { return oid < arrayLength(&objFlags) && (objFlags[oid] & bit) != 0u; }
// Vertices of hidden objects are moved outside the clip volume, so nothing is drawn.
const CULLED = vec4f(2.0, 2.0, 2.0, 1.0);

fn toLinear(c: vec3f) -> vec3f { return pow(c, vec3f(2.2)); }
fn toSrgb(c: vec3f) -> vec3f { return pow(clamp(c, vec3f(0.0), vec3f(1.0)), vec3f(1.0 / 2.2)); }

// Filmic tone mapping (ACES fit): rolls bright values off smoothly instead of clipping to white.
const EXPOSURE = 0.82;
fn tonemap(c: vec3f) -> vec3f {
  let x = c * EXPOSURE;
  return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), vec3f(0.0), vec3f(1.0));
}

// Aerial perspective: geometry beyond the orbit target fades towards the horizon colour.
fn hazeAmount(wp: vec3f) -> f32 {
  let d = length(wp - F.eye.xyz);
  return clamp(1.0 - exp(-max(d - F.misc.z, 0.0) * F.misc.w), 0.0, 0.6);
}
fn finish(lin: vec3f, wp: vec3f) -> vec3f {
  return mix(toSrgb(tonemap(lin)), F.bgBot.rgb, hazeAmount(wp));
}

// Value noise for subtle large-scale variation on ground surfaces.
fn hash2(p: vec2f) -> f32 { return fract(sin(dot(p, vec2f(127.1, 311.7))) * 43758.5453); }
fn noise2(p: vec2f) -> f32 {
  let i = floor(p);
  let f = fract(p);
  let u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash2(i), hash2(i + vec2f(1.0, 0.0)), u.x), mix(hash2(i + vec2f(0.0, 1.0)), hash2(i + vec2f(1.0, 1.0)), u.x), u.y);
}
fn sky(dir: vec3f) -> vec3f {
  return mix(toLinear(F.bgBot.rgb), toLinear(F.bgTop.rgb), pow(clamp(dir.z, 0.0, 1.0), 0.6));
}

// 1 = fully lit, 0 = fully in shadow. n should face away from the surface towards the viewer.
// Shadow test against one cascade (3x3 PCF). Returns 1 when outside the cascade's map.
fn sampleCascade(wp: vec3f, n: vec3f, c: u32) -> f32 {
  // Normal offset against shadow acne, largest on surfaces at a grazing angle to the sun.
  let sinT = sqrt(max(1.0 - pow(dot(n, F.sunDir.xyz), 2.0), 0.0));
  let p = wp + n * F.texel[c] * (0.4 + 1.1 * sinT);
  let s = F.shadow[c] * vec4f(p, 1.0);
  let uv = vec2f(s.x * 0.5 + 0.5, 0.5 - s.y * 0.5);
  if (any(uv < vec2f(0.0)) || any(uv > vec2f(1.0))) { return 1.0; }
  let depthRef = s.z + F.texel[c] * F.opts.w;   // ~1 texel of depth bias
  let d = 1.0 / ${SHADOW_SIZE}.0;
  var sum = 0.0;
  for (var y = -1; y <= 1; y++) {
    for (var x = -1; x <= 1; x++) {
      sum += textureSampleCompareLevel(shadowMap, shadowCmp, uv + vec2f(f32(x), f32(y)) * d, c, depthRef);
    }
  }
  return sum / 9.0;
}

// 1 = fully lit, 0 = fully in shadow. Near the far end of each cascade the result blends into
// the next (coarser) cascade, so there is no visible line where they meet.
fn sunVisibility(wp: vec3f, n: vec3f) -> f32 {
  if (F.opts.y < 0.5) { return 1.0; }
  let vd = dot(wp - F.eye.xyz, F.viewDir.xyz);
  var c = ${CASCADES - 1}u;
  if (vd < F.splits.x) { c = 0u; } else if (vd < F.splits.y) { c = 1u; } else if (vd < F.splits.z) { c = 2u; }
  let v = sampleCascade(wp, n, c);
  if (c == ${CASCADES - 1}u) { return v; }
  var start = 0.0;
  if (c > 0u) { start = F.splits[c - 1u]; }
  let t = (vd - start) / max(F.splits[c] - start, 1e-6);
  let w = smoothstep(0.7, 1.0, t);
  if (w <= 0.0) { return v; }
  return mix(v, sampleCascade(wp, n, c + 1u), w);
}

// Night sky: stars fixed on the celestial sphere, so they turn with the time of day, and a faint
// Milky Way. View directions go to local east / north / up, then to equatorial coordinates.
fn starField(dir: vec3f) -> vec3f {
  let na = F.stars.z;
  let enu = vec3f(dot(dir.xy, vec2f(sin(na), -cos(na))), dot(dir.xy, vec2f(cos(na), sin(na))), dir.z);
  let sl = sin(F.stars.x);
  let cl = cos(F.stars.x);
  let x = dot(enu, vec3f(0.0, -sl, cl));           // towards the celestial equator on the meridian
  let z = dot(enu, vec3f(0.0, cl, sl));            // towards the celestial pole
  let ra = F.stars.y - atan2(-enu.x, x);           // sidereal time minus hour angle
  let rxy = sqrt(max(1.0 - z * z, 0.0));
  let q = vec3f(rxy * cos(ra), rxy * sin(ra), z);  // fixed among the stars
  // One candidate star per cell of a grid on each cube face.
  let a = abs(q);
  var uv: vec2f;
  var face: f32;
  if (a.x >= a.y && a.x >= a.z) { uv = q.yz / a.x; face = sign(q.x); }
  else if (a.y >= a.z) { uv = q.xz / a.y; face = 2.0 + sign(q.y); }
  else { uv = q.xy / a.z; face = 4.0 + sign(q.z); }
  let N = 140.0;
  let cell = floor((uv * 0.5 + 0.5) * N);
  let seed = cell + vec2f(face * 157.0, face * 311.0);
  let h = hash2(seed);
  let p = (cell + 0.2 + 0.6 * vec2f(hash2(seed + 17.3), hash2(seed + 41.9))) / N * 2.0 - 1.0;
  var sd: vec3f;
  if (a.x >= a.y && a.x >= a.z) { sd = vec3f(sign(q.x), p); }
  else if (a.y >= a.z) { sd = vec3f(p.x, sign(q.y), p.y); }
  else { sd = vec3f(p, sign(q.z)); }
  let px = length(q - normalize(sd)) * F.viewport.y / (2.0 * F.camRight.w);   // distance in pixels
  let star = select(0.0, (0.07 + 2.0 * pow(fract(h * 7.31), 7.0)) * exp(-px * px * 1.4), h < 0.32);
  let tint = mix(vec3f(0.75, 0.83, 1.0), vec3f(1.0, 0.86, 0.7), fract(h * 13.7));
  // Milky Way: a soft band along the galactic plane (north galactic pole at RA 192.9 deg, dec 27.1 deg).
  let g = dot(q, vec3f(-0.8677, -0.1981, 0.4560));
  let band = exp(-g * g * 18.0) * (0.45 + 0.55 * noise2(uv * 9.0 + face * 13.0)) * noise2(uv * 3.0 - face * 7.0);
  return tint * star + vec3f(0.07, 0.075, 0.09) * band;
}

// Background ---------------------------------------------------------------------------------
struct BgOut { @builtin(position) pos: vec4f, @location(0) ndc: vec2f };
@vertex fn vsBg(@builtin(vertex_index) i: u32) -> BgOut {
  let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u)) * 2.0 - 1.0;
  return BgOut(vec4f(p, 0.0, 1.0), p);
}
@fragment fn fsBg(in: BgOut) -> @location(0) vec4f {
  let screen = mix(F.bgBot.rgb, F.bgTop.rgb, in.ndc.y * 0.5 + 0.5);
  if (F.sunDir.w < 0.5 || F.eye.w > 0.5) { return vec4f(screen, 1.0); }
  // Sun lighting in perspective: a real sky. Gradient by elevation of the view ray, plus the sun.
  let t = F.camRight.w;
  let dir = normalize(F.viewDir.xyz + F.camRight.xyz * in.ndc.x * t * F.camUp.w + F.camUp.xyz * in.ndc.y * t);
  var col = mix(F.bgBot.rgb, F.bgTop.rgb, pow(clamp(dir.z, 0.0, 1.0), 0.55));
  let L = F.skySun.xyz;
  let night = F.skyGlow.w;
  let Mv = F.moon.xyz;
  let moonUp = smoothstep(-0.02, 0.05, Mv.z);
  // Sunset and twilight: a warm glow low in the sky, strongest on the sun's side.
  let side = dot(normalize(dir.xy + vec2f(1e-5)), normalize(L.xy + vec2f(1e-5))) * 0.5 + 0.5;
  col += F.skyGlow.rgb * (0.2 + 0.8 * pow(side, 3.0)) * exp(-max(dir.z, 0.0) * 7.0);
  // A bright moon washes out the fainter stars.
  col += starField(dir) * night * (1.0 - 0.6 * F.moon.w * moonUp) * smoothstep(0.0, 0.12, dir.z);
  col = mix(col, F.bgBot.rgb * 0.94, smoothstep(0.0, -0.08, dir.z));   // below the horizon
  let sky = col;
  let above = smoothstep(-0.02, 0.02, L.z) * smoothstep(-0.0015, 0.0015, dir.z);
  let d = max(dot(dir, L), 0.0);
  // A low sun is orange-red, and so is the glow around it.
  let high = smoothstep(0.0, 0.25, L.z);
  let discCol = mix(vec3f(1.0, 0.42, 0.16), vec3f(1.0, 0.98, 0.92), high);
  let warm = mix(vec3f(1.0, 0.5, 0.2), vec3f(0.96, 0.95, 0.91), high);
  let glow = pow(d, 900.0) * 0.55 + pow(d, 80.0) * 0.14 + pow(d, 10.0) * 0.035;
  let disc = smoothstep(0.99985, 0.99993, d);                          // ~0.7 deg across
  col = mix(col + warm * glow * above, discCol, disc * above);
  col = moonDisc(dir, col, sky, night);
  return vec4f(clamp(col, vec3f(0.0), vec3f(1.0)), 1.0);
}

// The moon: a sphere lit from the sun's direction, so its phase and the tilt of the lit side
// are right for the place and time. Dark side faintly lit by earthshine at night; pale by day.
fn moonDisc(dir: vec3f, col: vec3f, sky: vec3f, night: f32) -> vec3f {
  let Mv = F.moon.xyz;
  let dm = dot(dir, Mv);
  if (dm < 0.99) { return col; }
  let clip = smoothstep(-0.0015, 0.0015, dir.z);                    // hidden below the horizon
  let ax = normalize(cross(Mv, vec3f(0.0, 0.0, 1.0)) + vec3f(1e-5, 0.0, 0.0));
  let ay = cross(ax, Mv);
  let r = 0.0062;                                                  // ~0.7 deg across, like the sun
  let p = vec2f(dot(dir, ax), dot(dir, ay)) / r;
  let rr = dot(p, p);
  let edge = 2.0 * F.camRight.w / F.viewport.y / r;               // one pixel, in disc radii
  let mask = clamp((1.0 - sqrt(rr)) / edge + 0.5, 0.0, 1.0) * clip;
  // Halo around a bright moon in a dark sky.
  let halo = (pow(dm, 3000.0) * 0.12 + pow(dm, 300.0) * 0.035) * F.moon.w * night * clip;
  var c = col + vec3f(0.62, 0.68, 0.8) * halo;
  if (mask <= 0.0) { return c; }
  let n = ax * p.x + ay * p.y - Mv * sqrt(max(1.0 - rr, 0.0));     // surface facing us
  let lit = smoothstep(-0.03, 0.05, dot(n, F.skySun.xyz));
  // Darker maria, slight limb darkening, and a warmer tint near the horizon.
  let m = noise2(p * 1.6 + vec2f(4.2, 1.3)) * 0.7 + noise2(p * 4.3 + vec2f(9.1, 2.7)) * 0.3;
  let albedo = mix(1.0, 0.68, smoothstep(0.42, 0.62, m)) * (0.86 + 0.14 * sqrt(max(1.0 - rr, 0.0)));
  let tint = mix(vec3f(1.0, 0.72, 0.5), vec3f(0.97, 0.96, 0.92), smoothstep(0.0, 0.2, Mv.z));
  let surface = tint * albedo;
  let bright = mix(sky + surface * 0.45, surface, night);
  let dark = sky + vec3f(0.02, 0.024, 0.03) * night;              // earthshine
  return mix(c, mix(dark, bright, lit), mask);
}

// Meshes -------------------------------------------------------------------------------------
struct MOut { @builtin(position) pos: vec4f, @location(0) n: vec3f, @location(1) wp: vec3f, @location(2) c: vec4f,
  @location(3) @interpolate(flat) seed: f32, @location(4) @interpolate(flat) oid: u32 };
// Surface priority (B.color.a): ground-like layers are pushed very slightly away from the camera
// so roads, paving and water win where they nearly coincide with or dip into the terrain.
// The push is a fraction of the viewing distance, so it is invisible at any zoom.
fn meshClip(p: vec3f, oid: u32) -> vec4f {
  if (objFlag(oid, 1u)) { return CULLED; }
  let c = F.viewProj * vec4f(p, 1.0);
  return vec4f(c.xy, c.z * (1.0 - B.color.a * 1e-3), c.w);
}
@vertex fn vsMesh(@location(0) p: vec3f, @location(1) n: vec4f, @location(4) oid: u32) -> MOut {
  return MOut(meshClip(p, oid), n.xyz, p, vec4f(0.0), n.w, oid);
}
@vertex fn vsMeshVC(@location(0) p: vec3f, @location(1) n: vec4f, @location(2) c: vec4f, @location(4) oid: u32) -> MOut {
  return MOut(meshClip(p, oid), n.xyz, p, c, n.w, oid);
}
// Selected object: tint it with the highlight colour.
fn highlight(c: vec3f, oid: u32) -> vec3f {
  if (objFlag(oid, 2u)) { return mix(c, F.sel.yzw, 0.45); }
  return c;
}

// Light arriving at a surface: sun (with shadows) or headlight, plus sky / ambient.
struct Light { direct: vec3f, ambient: vec3f, L: vec3f, vis: f32 };
fn lighting(wp: vec3f, n: vec3f, wrap: f32) -> Light {
  var o: Light;
  if (F.sunDir.w > 0.5) {
    o.L = F.sunDir.xyz;
    let ndl = max((dot(n, o.L) + wrap) / (1.0 + wrap), 0.0);
    o.vis = 0.0;
    if (dot(n, o.L) > -wrap) { o.vis = sunVisibility(wp, n); }
    o.direct = F.sunColor.rgb * ndl * o.vis;
    o.ambient = mix(vec3f(0.13, 0.125, 0.12), vec3f(0.31, 0.35, 0.43), n.z * 0.5 + 0.5) * F.sunColor.w;
    o.ambient = mix(o.ambient, o.ambient * vec3f(0.62, 0.78, 1.25), F.skyGlow.w);   // blue night light
  } else {
    o.L = normalize(F.light.xyz);
    o.vis = 1.0;
    o.direct = vec3f(0.62) * max((dot(n, o.L) + wrap) / (1.0 + wrap), 0.0);
    o.ambient = mix(vec3f(0.30, 0.29, 0.28), vec3f(0.58, 0.60, 0.64), n.z * 0.5 + 0.5);
  }
  return o;
}

// Water: wind ripples (analytic wave normals), sky reflection with Fresnel, sun glint.
fn shadeWater(in: MOut, V: vec3f, flatN: vec3f) -> vec3f {
  let p = in.wp.xy * F.misc.y;                     // metres
  let t = F.misc.x;
  let dist = length(in.wp - F.eye.xyz) * F.misc.y;
  let fade = 1.0 / (1.0 + dist / 120.0);            // calm the ripples in the distance (no shimmer)
  var g = vec2f(0.0);
  let dirs = array<vec2f, 4>(vec2f(0.8, 0.6), vec2f(-0.4, 0.9), vec2f(0.95, -0.3), vec2f(-0.7, -0.7));
  let lens = array<f32, 4>(7.0, 4.3, 2.6, 1.7);
  for (var i = 0; i < 4; i++) {
    let k = 6.2831853 / lens[i];
    let ph = dot(dirs[i], p) * k + t * sqrt(9.81 * k);
    g += dirs[i] * cos(ph) * k * 0.035 * lens[i] / 7.0;
  }
  let n = normalize(vec3f(-g * fade, 1.0) * select(1.0, -1.0, flatN.z < 0.0));
  let lt = lighting(in.wp, flatN, 0.0);
  let cosV = max(dot(n, V), 0.0);
  let fres = 0.02 + 0.98 * pow(1.0 - cosV, 5.0);
  let R = reflect(-V, n);
  let body = toLinear(B.mat.rgb) * (lt.ambient * 1.6 + lt.direct * 0.25);  // the layer's water colour
  var col = mix(body, sky(R) * (0.55 + 0.45 * F.sunColor.w), fres);
  if (F.sunDir.w > 0.5) { col += F.sunColor.rgb * pow(max(dot(R, lt.L), 0.0), 600.0) * 6.0 * lt.vis; }
  return col;
}

@fragment fn fsMesh(in: MOut) -> @location(0) vec4f {
  let mode = F.viewport.w;
  var V = normalize(F.eye.xyz - in.wp);
  if (F.eye.w > 0.5) { V = -F.viewDir.xyz; }
  // Two-sided lighting: decide which side we see from the true face orientation, not the
  // interpolated normal (which can face away near silhouettes of smooth-shaded shapes).
  var faceN = cross(dpdx(in.wp), dpdy(in.wp));
  if (dot(faceN, V) < 0.0) { faceN = -faceN; }
  var n = normalize(in.n);
  if (dot(n, faceN) < 0.0) { n = -n; }

  // Magic materials (materials.js) apply in Rendered mode; water also keeps its look in Clay mode.
  var cls = 0;
  if (mode > 0.5 && mode < 1.5) { cls = i32(B.flags.z + 0.5); }
  if (mode > 1.5 && B.flags.z > 0.5 && B.flags.z < 1.5) { cls = 1; }
  if (F.opts.x > 0.0) { cls = 0; }

  var alpha = 1.0;
  if (cls == 1) { return vec4f(highlight(finish(shadeWater(in, V, n), in.wp), in.oid), 1.0); }

  var base = B.color.rgb;
  var spec = 0.035;   // matte by default: a broad, faint sheen only
  var gloss = 24.0;
  var wrap = 0.0;
  let v = in.seed;    // per-object random value, -1..1
  if (mode > 0.5 && mode < 1.5) {
    base = B.mat.rgb * (1.0 + 0.05 * v);
    alpha = B.mat.a;
    // Gloss set in the viewer's material dialog (0 = matte).
    spec = mix(spec, 0.7, B.flags.w);
    gloss = mix(gloss, 260.0, B.flags.w);
  }
  if (mode > 1.5) { base = vec3f(0.91, 0.91, 0.90) * (1.0 + 0.03 * v); }
  let ground = noise2(in.wp.xy * F.misc.y * 0.04) * 0.6 + noise2(in.wp.xy * F.misc.y * 0.25) * 0.4;
  // Each type varies around the layer's material colour (the factors match "tones" in materials.js),
  // so its default colour gives the standard look and any other colour keeps the same variation.
  let c = B.mat.rgb;
  switch cls {
    case 2: { base = c; spec = 0.6; gloss = 220.0; }                                                           // glass
    case 3: {                                                                                                     // vegetation
      base = mix(c * vec3f(1.2, 1.132, 1.13), c * vec3f(0.8, 0.868, 0.87), v * 0.5 + 0.5) * (0.92 + 0.16 * fract(v * 7.31));
      spec = 0.0; wrap = 0.35;
    }
    case 4: { base = mix(c * vec3f(0.928, 0.963, 0.941), c * vec3f(1.072, 1.037, 1.059), ground); spec = 0.0; } // grass
    case 5: { base = c * (0.94 + 0.12 * ground); spec = 0.05; gloss = 12.0; }                                   // road
    case 6: { base = c * (0.95 + 0.08 * ground); }                                                               // paving
    case 7: { base = mix(c * vec3f(1.04, 1.034, 1.045), c * vec3f(0.96, 0.966, 0.955), ground); spec = 0.0; }   // ground
    default: {}
  }
  let vc = B.flags.x > 0.5 && mode < 1.5;
  if (vc) { base = in.c.rgb; }

  var ao = 1.0;
  if (F.opts.z > 0.5 && F.opts.x == 0.0 && alpha >= 1.0) { ao = textureLoad(aoTex, vec2i(in.pos.xy), 0).r; }
  let lt = lighting(in.wp, n, wrap);
  let h = normalize(lt.L + V);
  let specular = pow(max(dot(n, h), 0.0), gloss) * spec * lt.vis * select(0.6, 1.0, F.sunDir.w > 0.5);
  var lit = toLinear(base) * (lt.ambient * ao + lt.direct * mix(1.0, ao, 0.3));
  if (F.sunDir.w > 0.5) { lit += F.sunColor.rgb * specular; } else { lit += vec3f(specular); }
  if (cls == 2) {                                   // glass reflects the sky
    let fres = 0.08 + 0.92 * pow(1.0 - max(dot(n, V), 0.0), 4.0);
    lit = mix(lit, sky(reflect(-V, n)) * 0.9, fres * 0.8);
  }
  // Vertex colours keep an even, readable shading under the headlight; with the sun on they take
  // the scene's light like any other surface (so they darken at dusk and night).
  if (vc && F.sunDir.w < 0.5) { lit = toLinear(base) * (0.55 + 0.45 * max(dot(n, lt.L), 0.0) * lt.vis) * mix(1.0, ao, 0.5); }
  if (F.opts.x > 0.0) { alpha = F.opts.x; }
  return vec4f(highlight(finish(lit, in.wp), in.oid), alpha);
}

// Shadow-catcher ground plane: transparent except where shadows fall -------------------------
struct GOut { @builtin(position) pos: vec4f, @location(0) wp: vec3f };
@vertex fn vsGround(@builtin(vertex_index) i: u32) -> GOut {
  var q = array<vec2f, 6>(vec2f(-1, -1), vec2f(1, -1), vec2f(1, 1), vec2f(-1, -1), vec2f(1, 1), vec2f(-1, 1));
  let wp = vec3f(F.ground.xy + q[i] * F.ground.w, F.ground.z);
  return GOut(F.viewProj * vec4f(wp, 1.0), wp);
}
@fragment fn fsGround(in: GOut) -> @location(0) vec4f {
  let vis = sunVisibility(in.wp, vec3f(0.0, 0.0, 1.0));
  let r = length(in.wp.xy - F.ground.xy) / F.ground.w;
  let fade = 1.0 - smoothstep(0.6, 1.0, r);
  return vec4f(0.08, 0.09, 0.12, (1.0 - vis) * 0.5 * fade);
}

// Curves and edges ---------------------------------------------------------------------------
// Lines are nudged towards the camera (reverse-Z: larger depth is nearer) so curves lying on a
// surface win the depth test instead of breaking up into dashes.
const LINE_PULL = 1.0006;
struct LOut { @builtin(position) pos: vec4f, @location(0) wp: vec3f };
@vertex fn vsLine(@location(0) p: vec3f, @location(4) oid: u32) -> LOut {
  if (objFlag(oid, 1u)) { return LOut(CULLED, p); }
  let c = F.viewProj * vec4f(p, 1.0);
  return LOut(vec4f(c.xy, min(c.z * LINE_PULL, c.w), c.w), p);
}
@fragment fn fsLine(in: LOut) -> @location(0) vec4f {
  let fade = 1.0 - hazeAmount(in.wp) * 1.4;        // edges and curves fade out with the haze
  if (B.flags.y > 0.5) { return vec4f(F.edge.rgb, F.edge.a * fade); }
  return vec4f(mix(F.bgBot.rgb, B.color.rgb * min(F.sunColor.w * 1.5, 1.0), fade), 1.0);   // dimmer at dusk and night
}

// Points (screen-space squares) --------------------------------------------------------------
@vertex fn vsPoint(@builtin(vertex_index) i: u32, @location(0) p: vec3f, @location(4) oid: u32) -> @builtin(position) vec4f {
  if (objFlag(oid, 1u)) { return CULLED; }
  let c = vec2f(f32(i & 1u), f32(i >> 1u)) * 2.0 - 1.0;
  var clip = F.viewProj * vec4f(p, 1.0);
  clip = vec4f(clip.xy + c * F.viewport.z / F.viewport.xy * clip.w, min(clip.z * LINE_PULL, clip.w), clip.w);
  return clip;
}
@fragment fn fsPoint() -> @location(0) vec4f { return vec4f(B.color.rgb, 1.0); }

// Picking: writes the world position and object id (+1, so 0 = nothing) ----------------------
struct POut { @builtin(position) pos: vec4f, @location(0) wp: vec3f, @location(1) @interpolate(flat) oid: u32 };
@vertex fn vsPick(@location(0) p: vec3f, @location(4) oid: u32) -> POut {
  if (objFlag(oid, 1u)) { return POut(CULLED, p, oid); }
  return POut(F.viewProj * vec4f(p, 1.0), p, oid);
}
@fragment fn fsPick(in: POut) -> @location(0) vec4f { return vec4f(in.wp, f32(in.oid + 1u)); }

// Ambient-occlusion prepass: camera-facing world normal and view depth (0 = background) ---
// The normal is the true face normal, not the interpolated one: the occlusion test is against
// the faceted depth, and a smoothed normal (foliage) tilts the sampling hemisphere into its own
// facet near silhouettes, which darkened the rims of tree canopies.
@fragment fn fsGbuf(in: MOut) -> @location(0) vec4f {
  var V = normalize(F.eye.xyz - in.wp);
  if (F.eye.w > 0.5) { V = -F.viewDir.xyz; }
  var n = normalize(cross(dpdx(in.wp), dpdy(in.wp)));
  if (dot(n, V) < 0.0) { n = -n; }
  return vec4f(n, dot(in.wp - F.eye.xyz, F.viewDir.xyz));
}
`;

// Screen-space ambient occlusion (normal-oriented hemisphere) and a depth-aware blur.
const AO_SHADER = /* wgsl */ `
struct AO {
  viewProj: mat4x4f,
  eye: vec4f, fwd: vec4f, right: vec4f, up: vec4f,
  proj: vec4f,    // tan(fov/2), aspect, parallel (1/0), parallel half-height
  params: vec4f,  // radius as a fraction of view depth, max radius (world), strength, -
  size: vec4f,    // width, height
  kernel: array<vec4f, 16>,
};
@group(0) @binding(0) var<uniform> A: AO;
@group(0) @binding(1) var gbuf: texture_2d<f32>;
@group(0) @binding(2) var aoIn: texture_2d<f32>;

@vertex fn vsFull(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u)) * 2.0 - 1.0;
  return vec4f(p, 0.0, 1.0);
}

fn worldPos(px: vec2f, d: f32) -> vec3f {
  let ndc = vec2f(px.x / A.size.x * 2.0 - 1.0, 1.0 - px.y / A.size.y * 2.0);
  var h = A.proj.w;
  if (A.proj.z < 0.5) { h = d * A.proj.x; }
  return A.eye.xyz + A.fwd.xyz * d + A.right.xyz * (ndc.x * h * A.proj.y) + A.up.xyz * (ndc.y * h);
}

@fragment fn fsAO(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  let g = textureLoad(gbuf, vec2i(pos.xy), 0);
  if (g.w <= 0.0) { return vec4f(1.0); }
  let n = g.xyz;
  let P = worldPos(pos.xy, g.w);
  var scale = g.w;
  if (A.proj.z > 0.5) { scale = A.proj.w / A.proj.x; }
  let R = min(scale * A.params.x, A.params.y);
  // Per-pixel rotation of the kernel (interleaved gradient noise).
  let ang = 6.2831853 * fract(52.9829189 * fract(dot(pos.xy, vec2f(0.06711056, 0.00583715))));
  var t0 = cross(n, vec3f(0.0, 0.0, 1.0));
  if (length(t0) < 0.1) { t0 = cross(n, vec3f(1.0, 0.0, 0.0)); }
  t0 = normalize(t0);
  let b0 = cross(n, t0);
  let t = t0 * cos(ang) + b0 * sin(ang);
  let b = cross(n, t);
  var occ = 0.0;
  for (var i = 0; i < 16; i++) {
    let k = A.kernel[i].xyz;
    let S = P + (t * k.x + b * k.y + n * k.z) * R;
    let c = A.viewProj * vec4f(S, 1.0);
    if (c.w <= 0.0) { continue; }
    let uv = vec2f(c.x / c.w * 0.5 + 0.5, 0.5 - c.y / c.w * 0.5);
    if (any(uv < vec2f(0.0)) || any(uv >= vec2f(1.0))) { continue; }
    let sd = dot(S - A.eye.xyz, A.fwd.xyz);
    let gs = textureLoad(gbuf, vec2i(uv * A.size.xy), 0).w;
    if (gs > 0.0 && gs < sd - R * 0.04) {
      occ += clamp(R / abs(g.w - gs), 0.0, 1.0);  // ignore occluders far in front
    }
  }
  return vec4f(pow(1.0 - occ / 16.0, A.params.z));
}

@fragment fn fsBlur(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  let p = vec2i(pos.xy);
  let g = textureLoad(gbuf, p, 0);
  if (g.w <= 0.0) { return vec4f(1.0); }
  let lim = vec2i(A.size.xy) - 1;
  var sum = 0.0;
  var wsum = 0.0;
  for (var y = -2; y <= 2; y++) {
    for (var x = -2; x <= 2; x++) {
      let q = clamp(p + vec2i(x, y), vec2i(0), lim);
      let gq = textureLoad(gbuf, q, 0);
      if (gq.w <= 0.0) { continue; }
      let w = exp(-abs(gq.w - g.w) / (g.w * 0.02)) * max(dot(gq.xyz, g.xyz), 0.0);
      sum += textureLoad(aoIn, q, 0).r * w;
      wsum += w;
    }
  }
  return vec4f(select(1.0, sum / wsum, wsum > 0.0));
}
`;

// Depth-only pass from the sun. Depth = how close to the sun (1 nearest), cleared to 0.
const SHADOW_SHADER = /* wgsl */ `
@group(0) @binding(0) var<uniform> S: mat4x4f;
@group(0) @binding(1) var<storage, read> objFlags: array<u32>;
@vertex fn vsShadow(@location(0) p: vec3f, @location(4) oid: u32) -> @builtin(position) vec4f {
  if (oid < arrayLength(&objFlags) && (objFlags[oid] & 1u) != 0u) { return vec4f(2.0, 2.0, 2.0, 1.0); } // hidden
  return S * vec4f(p, 1.0);
}
`;

const FRAME_SIZE = 768;
// How far each surface type yields to others where surfaces nearly coincide (see meshClip).
const SURFACE_PRIORITY = { 1: 0.5, 4: 1, 5: 0.5, 6: 0, 7: 2 }; // water, grass, road, paving, ground
const BATCH_STRIDE = 256;
const MSAA = 4;
const DEPTH = 'depth32float';

// Fit CASCADES orthographic shadow frusta to slices of the camera's view.
// cam: { eye, forward, right, up, fov, aspect, ortho, halfHeight, distance }
// sunDir: unit vector towards the sun; scene: { center, radius, receiverRadius }: radius bounds
// everything that can cast a shadow, receiverRadius the area shadows need to be shown on (kept
// tight so the far cascade stays sharp). Returns light matrices (column-major), splits, texel sizes.
function shadowCascades(cam, sunDir, scene) {
  const L = sunDir;
  let lx = V3.cross([0, 0, 1], L);
  if (V3.len(lx) < 1e-4) lx = [1, 0, 0];
  lx = V3.norm(lx);
  const ly = V3.cross(L, lx);

  // Depth range along the sun direction covers the whole scene, so every caster is captured.
  const sc = V3.dot(scene.center, L), sMin = sc - scene.radius * 1.02, sMax = sc + scene.radius * 1.02, range = sMax - sMin;

  // View-depth range that can contain shadow receivers.
  const RR = scene.receiverRadius || scene.radius;
  const camToCenter = V3.dot(V3.sub(scene.center, cam.eye), cam.forward);
  const far = Math.max(camToCenter + RR, 1e-6);
  let near = cam.ortho ? Math.max(camToCenter - RR, cam.distance - RR * 1.5) : Math.max(camToCenter - RR, cam.distance * 0.002);
  near = Math.min(near, far * 0.999);

  const lambda = cam.ortho ? 0 : 0.8;
  const splitAt = (i) => {
    const t = i / CASCADES;
    const log = near > 0 ? near * Math.pow(far / near, t) : near + (far - near) * t;
    return lambda * log + (1 - lambda) * (near + (far - near) * t);
  };

  const mats = [], splits = [], texel = [];
  for (let c = 0; c < CASCADES; c++) {
    const d0 = splitAt(c), d1 = splitAt(c + 1);
    splits.push(d1);
    // Bounding sphere of the frustum slice (rotation-invariant, so shadows do not swim).
    const corners = [];
    for (const d of [d0, d1]) {
      const h = cam.ortho ? cam.halfHeight : Math.max(d, 0) * Math.tan(cam.fov / 2), w = h * cam.aspect;
      const mid = V3.add(cam.eye, V3.scale(cam.forward, d));
      for (const sx of [-1, 1]) for (const sy of [-1, 1]) corners.push(V3.add(mid, V3.add(V3.scale(cam.right, sx * w), V3.scale(cam.up, sy * h))));
    }
    let center = corners.reduce((a, p) => V3.add(a, p), [0, 0, 0]).map((v) => v / 8);
    let r = Math.max(...corners.map((p) => V3.len(V3.sub(p, center))));
    if (r >= RR) { center = scene.center; r = RR; }
    r = Math.pow(2, Math.ceil(Math.log2(r) * 16) / 16); // quantise to limit size changes
    const tx = (2 * r) / SHADOW_SIZE;
    texel.push(tx);
    // Snap the centre to whole texels in light space.
    const cx = Math.round(V3.dot(center, lx) / tx) * tx, cy = Math.round(V3.dot(center, ly) / tx) * tx;
    const m = new Float32Array(16);
    m[0] = lx[0] / r; m[4] = lx[1] / r; m[8] = lx[2] / r; m[12] = -cx / r;
    m[1] = ly[0] / r; m[5] = ly[1] / r; m[9] = ly[2] / r; m[13] = -cy / r;
    m[2] = L[0] / range; m[6] = L[1] / range; m[10] = L[2] / range; m[14] = -sMin / range;
    m[15] = 1;
    mats.push(m);
  }
  return { mats, splits, texel, invRange: 1 / range };
}

class Renderer {
  static async create(canvas) {
    if (!navigator.gpu) throw new Error('NO_WEBGPU');
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) throw new Error('NO_ADAPTER');
    const lim = adapter.limits;
    const device = await adapter.requestDevice({ requiredLimits: { maxBufferSize: lim.maxBufferSize } });
    return new Renderer(canvas, device);
  }

  constructor(canvas, device) {
    this.canvas = canvas;
    this.device = device;
    this.ctx = canvas.getContext('webgpu');
    this.format = navigator.gpu.getPreferredCanvasFormat();
    this.ctx.configure({ device, format: this.format, alphaMode: 'opaque' });
    this.batches = [];
    this.dirty = true;
    this.onLost = null;
    device.lost.then((info) => this.onLost?.(info));

    const U = GPUBufferUsage;
    this.frameBuf = device.createBuffer({ size: FRAME_SIZE, usage: U.UNIFORM | U.COPY_DST });
    this.pickFrameBuf = device.createBuffer({ size: FRAME_SIZE, usage: U.UNIFORM | U.COPY_DST });

    const VF = GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT;
    this.frameLayout = device.createBindGroupLayout({ entries: [
      { binding: 0, visibility: VF, buffer: {} },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'depth', viewDimension: '2d-array' } },
      { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'comparison' } },
      { binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'unfilterable-float' } },
      { binding: 4, visibility: VF, buffer: { type: 'read-only-storage' } },
    ] });
    this.objFlagsBuf = device.createBuffer({ size: 4, usage: U.STORAGE | U.COPY_DST });
    this.batchLayout = device.createBindGroupLayout({ entries: [{ binding: 0, visibility: VF, buffer: { hasDynamicOffset: true, minBindingSize: 48 } }] });

    // Shadow maps: one depth layer per cascade, rendered from the sun.
    this.shadowTex = device.createTexture({ size: [SHADOW_SIZE, SHADOW_SIZE, CASCADES], format: DEPTH,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING });
    this.shadowLayers = [...Array(CASCADES).keys()].map((c) => this.shadowTex.createView({ dimension: '2d', baseArrayLayer: c, arrayLayerCount: 1 }));
    this.shadowView = this.shadowTex.createView({ dimension: '2d-array' });
    this.shadowCmp = device.createSampler({ compare: 'greater-equal', magFilter: 'linear', minFilter: 'linear' });
    // frameBG / pickFrameBG also bind the screen-sized AO texture, so they are built in resize().

    // Ambient occlusion: one layout, two bind groups (the AO pass and the blur pass read
    // different textures, and neither reads the texture it renders into).
    this.aoBuf = device.createBuffer({ size: 512, usage: U.UNIFORM | U.COPY_DST });
    this.aoLayout = device.createBindGroupLayout({ entries: [
      { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: {} },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'unfilterable-float' } },
      { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'unfilterable-float' } },
    ] });
    const aoModule = device.createShaderModule({ code: AO_SHADER });
    const aoPipe = (fs) => device.createRenderPipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [this.aoLayout] }),
      vertex: { module: aoModule, entryPoint: 'vsFull' },
      fragment: { module: aoModule, entryPoint: fs, targets: [{ format: 'r8unorm' }] },
    });
    this.aoPipe = aoPipe('fsAO');
    this.blurPipe = aoPipe('fsBlur');
    // Hemisphere sample kernel, denser near the centre.
    const kernel = new Float32Array(64);
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < 16; i++) {
      let v;
      do { v = [rnd() * 2 - 1, rnd() * 2 - 1, rnd()]; } while (V3.len(v) > 1 || V3.len(v) < 0.1);
      const s = 0.15 + 0.85 * ((i + 1) / 16) ** 2;
      kernel.set(V3.scale(V3.norm(v), s * (0.4 + 0.6 * rnd())), i * 4);
    }
    this.aoKernel = kernel;

    this.shadowBuf = device.createBuffer({ size: CASCADES * 256, usage: U.UNIFORM | U.COPY_DST });
    const shadowLayout = (this.shadowLayout = device.createBindGroupLayout({ entries: [
      { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { hasDynamicOffset: true, minBindingSize: 64 } },
      { binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
    ] }));
    this.makeFrameBindGroups();
    this.shadowPipe = device.createRenderPipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [shadowLayout] }),
      vertex: { module: device.createShaderModule({ code: SHADOW_SHADER }), entryPoint: 'vsShadow',
        buffers: [{ arrayStride: 12, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }] },
          { arrayStride: 4, attributes: [{ shaderLocation: 4, offset: 0, format: 'uint32' }] }] },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: { format: DEPTH, depthWriteEnabled: true, depthCompare: 'greater', depthBias: -2, depthBiasSlopeScale: -2 },
    });

    const module = device.createShaderModule({ code: SHADER });
    const layout = device.createPipelineLayout({ bindGroupLayouts: [this.frameLayout, this.batchLayout] });
    const POS = { arrayStride: 12, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }] };
    const NRM = { arrayStride: 8, attributes: [{ shaderLocation: 1, offset: 0, format: 'snorm16x4' }] };
    const COL = { arrayStride: 4, attributes: [{ shaderLocation: 2, offset: 0, format: 'unorm8x4' }] };
    const OID = { arrayStride: 4, attributes: [{ shaderLocation: 4, offset: 0, format: 'uint32' }] };
    const POS_INST = { ...POS, stepMode: 'instance' };
    const OID_INST = { arrayStride: 4, stepMode: 'instance', attributes: [{ shaderLocation: 4, offset: 0, format: 'uint32' }] };
    const frameOnly = device.createPipelineLayout({ bindGroupLayouts: [this.frameLayout] });
    const blend = { color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha' }, alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' } };

    const mk = (vs, fs, buffers, o = {}) => device.createRenderPipeline({
      layout: o.layout || layout,
      vertex: { module, entryPoint: vs, buffers },
      fragment: { module, entryPoint: fs, targets: [{ format: o.format || this.format, blend: o.blend }] },
      primitive: { topology: o.topology || 'triangle-list', cullMode: 'none' },
      depthStencil: { format: DEPTH, depthWriteEnabled: o.write ?? true, depthCompare: o.compare || 'greater',
        depthBias: o.bias ? -2 : 0, depthBiasSlopeScale: o.bias ? -1.5 : 0 },
      multisample: { count: o.samples || MSAA },
    });

    this.pipes = {
      bg: mk('vsBg', 'fsBg', [], { write: false, compare: 'always', layout: frameOnly }),
      mesh: mk('vsMesh', 'fsMesh', [POS, NRM, OID], { bias: true }),
      meshVC: mk('vsMeshVC', 'fsMesh', [POS, NRM, COL, OID], { bias: true }),
      meshT: mk('vsMesh', 'fsMesh', [POS, NRM, OID], { bias: true, blend, write: false }),
      meshVCT: mk('vsMeshVC', 'fsMesh', [POS, NRM, COL, OID], { bias: true, blend, write: false }),
      line: mk('vsLine', 'fsLine', [POS, OID], { topology: 'line-list', compare: 'greater-equal', blend }),
      lineX: mk('vsLine', 'fsLine', [POS, OID], { topology: 'line-list', compare: 'always', blend, write: false }),
      point: mk('vsPoint', 'fsPoint', [POS_INST, OID_INST], { topology: 'triangle-strip', compare: 'greater-equal' }),
      pointX: mk('vsPoint', 'fsPoint', [POS_INST, OID_INST], { topology: 'triangle-strip', compare: 'always', write: false }),
      pick: mk('vsPick', 'fsPick', [POS, OID], { format: 'rgba32float', samples: 1, layout: frameOnly }),
      ground: mk('vsGround', 'fsGround', [], { layout: frameOnly, blend, write: false }),
      gbuf: mk('vsMesh', 'fsGbuf', [POS, NRM, OID], { format: 'rgba32float', samples: 1 }),
    };

    this.pickColor = device.createTexture({ size: [1, 1], format: 'rgba32float', usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
    this.pickDepth = device.createTexture({ size: [1, 1], format: DEPTH, usage: GPUTextureUsage.RENDER_ATTACHMENT });
    this.pickRead = device.createBuffer({ size: 256, usage: U.MAP_READ | U.COPY_DST });
    this.pickBusy = false;

    this.frameData = new Float32Array(FRAME_SIZE / 4);
  }

  resize(w, h) {
    if (w === this.width && h === this.height) return;
    this.width = w; this.height = h;
    this.canvas.width = w; this.canvas.height = h;
    for (const t of ['msaaTex', 'depthTex', 'gbufTex', 'gdepthTex', 'aoRawTex', 'aoTex']) this[t]?.destroy();
    const dev = this.device, RA = GPUTextureUsage.RENDER_ATTACHMENT, TB = GPUTextureUsage.TEXTURE_BINDING;
    this.msaaTex = dev.createTexture({ size: [w, h], format: this.format, sampleCount: MSAA, usage: RA });
    this.depthTex = dev.createTexture({ size: [w, h], format: DEPTH, sampleCount: MSAA, usage: RA });
    this.gbufTex = dev.createTexture({ size: [w, h], format: 'rgba32float', usage: RA | TB });
    this.gdepthTex = dev.createTexture({ size: [w, h], format: DEPTH, usage: RA });
    this.aoRawTex = dev.createTexture({ size: [w, h], format: 'r8unorm', usage: RA | TB });
    this.aoTex = dev.createTexture({ size: [w, h], format: 'r8unorm', usage: RA | TB | GPUTextureUsage.COPY_SRC });

    const aoView = this.aoTex.createView();
    this.makeFrameBindGroups();
    const aoEntries = (input) => [{ binding: 0, resource: { buffer: this.aoBuf } }, { binding: 1, resource: this.gbufTex.createView() }, { binding: 2, resource: input }];
    this.aoBG = dev.createBindGroup({ layout: this.aoLayout, entries: aoEntries(aoView) });        // renders into aoRawTex
    this.blurBG = dev.createBindGroup({ layout: this.aoLayout, entries: aoEntries(this.aoRawTex.createView()) }); // renders into aoTex
    this.dirty = true;
  }

  makeFrameBindGroups() {
    const dev = this.device;
    if (this.aoTex) {
      const entries = (buffer) => [{ binding: 0, resource: { buffer } }, { binding: 1, resource: this.shadowView },
        { binding: 2, resource: this.shadowCmp }, { binding: 3, resource: this.aoTex.createView() }, { binding: 4, resource: { buffer: this.objFlagsBuf } }];
      this.frameBG = dev.createBindGroup({ layout: this.frameLayout, entries: entries(this.frameBuf) });
      this.pickFrameBG = dev.createBindGroup({ layout: this.frameLayout, entries: entries(this.pickFrameBuf) });
    }
    this.shadowBG = dev.createBindGroup({ layout: this.shadowLayout, entries: [
      { binding: 0, resource: { buffer: this.shadowBuf, size: 64 } }, { binding: 1, resource: { buffer: this.objFlagsBuf } }] });
  }

  // flags: Uint32Array with one entry per object (bit 0 hidden, bit 1 selected).
  setObjectFlags(flags) {
    const bytes = Math.max(4, flags.byteLength);
    if (this.objFlagsBuf.size < bytes) {
      this.objFlagsBuf.destroy();
      this.objFlagsBuf = this.device.createBuffer({ size: bytes, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
      this.makeFrameBindGroups();
    }
    if (flags.byteLength) this.device.queue.writeBuffer(this.objFlagsBuf, 0, flags);
    this.dirty = true;
  }

  // Normal/depth prepass, SSAO, then blur into aoTex (read by the main pass).
  renderAO(enc, s) {
    const c = s.cam, a = new Float32Array(128);
    a.set(s.viewProj, 0);
    a.set([...c.eye, 0], 16); a.set([...c.forward, 0], 20); a.set([...c.right, 0], 24); a.set([...c.up, 0], 28);
    a.set([Math.tan(c.fov / 2), c.aspect, c.ortho ? 1 : 0, c.halfHeight], 32);
    a.set([0.04, s.aoMaxRadius, 2.0, 0], 36); // radius = 4% of view depth, strength exponent
    a.set([this.width, this.height, 0, 0], 40);
    a.set(this.aoKernel, 44);
    this.device.queue.writeBuffer(this.aoBuf, 0, a);

    let pass = enc.beginRenderPass({
      colorAttachments: [{ view: this.gbufTex.createView(), clearValue: { r: 0, g: 0, b: 0, a: 0 }, loadOp: 'clear', storeOp: 'store' }],
      depthStencilAttachment: { view: this.gdepthTex.createView(), depthClearValue: 0, depthLoadOp: 'clear', depthStoreOp: 'discard' },
    });
    pass.setPipeline(this.pipes.gbuf);
    pass.setBindGroup(0, this.frameBG);
    for (const b of this.batches) {
      if (!b.visible || b.kind !== 'mesh' || (s.mode === 1 && b.transparent)) continue;
      pass.setBindGroup(1, this.batchBG, [b.offset]);
      pass.setVertexBuffer(0, b.gpu.pos); pass.setVertexBuffer(1, b.gpu.nrm); pass.setVertexBuffer(2, b.gpu.oid);
      pass.setIndexBuffer(b.gpu.idx, 'uint32');
      pass.drawIndexed(b.count);
    }
    pass.end();
    for (const [pipe, bg, target] of [[this.aoPipe, this.aoBG, this.aoRawTex], [this.blurPipe, this.blurBG, this.aoTex]]) {
      pass = enc.beginRenderPass({ colorAttachments: [{ view: target.createView(), clearValue: { r: 1, g: 1, b: 1, a: 1 }, loadOp: 'clear', storeOp: 'store' }] });
      pass.setPipeline(pipe);
      pass.setBindGroup(0, bg);
      pass.draw(3);
      pass.end();
    }
  }

  clearModel() {
    for (const b of this.batches) for (const k of ['pos', 'nrm', 'col', 'idx', 'oid']) b.gpu[k]?.destroy();
    this.batchBuf?.destroy();
    this.batches = [];
  }

  // batches: output of extractModel()
  setModel(batches) {
    this.clearModel();
    const dev = this.device, U = GPUBufferUsage;
    const upload = (arr, usage) => {
      const size = Math.ceil(arr.byteLength / 4) * 4;
      const buf = dev.createBuffer({ size, usage, mappedAtCreation: true });
      new arr.constructor(buf.getMappedRange(0, size)).set(arr);
      buf.unmap();
      return buf;
    };
    this.batchBuf = dev.createBuffer({ size: Math.max(1, batches.length) * BATCH_STRIDE, usage: U.UNIFORM | U.COPY_DST });
    this.batchBG = dev.createBindGroup({ layout: this.batchLayout, entries: [{ binding: 0, resource: { buffer: this.batchBuf, size: 48 } }] });
    const ub = (this.batchData = new Float32Array(Math.max(1, batches.length) * (BATCH_STRIDE / 4)));
    batches.forEach((b, i) => {
      const o = i * (BATCH_STRIDE / 4);
      ub.set(b.color, o);
      ub.set(b.mat || [1, 1, 1, 1], o + 4);
      const gpu = { pos: upload(b.position, U.VERTEX), oid: upload(b.objectId, U.VERTEX) };
      if (b.kind === 'mesh') {
        gpu.nrm = upload(b.normal, U.VERTEX);
        gpu.idx = upload(b.index, U.INDEX);
        if (b.vc) gpu.col = upload(b.vcolor, U.VERTEX);
      }
      // Keep only metadata on the CPU side; the vertex data now lives on the GPU.
      const { position, normal, index, vcolor, objectId, ...meta } = b;
      this.batches.push({ ...meta, gpu, offset: i * BATCH_STRIDE, visible: true });
    });
    this.setMaterialRules(this.specialsOn ?? true, this.layerMaterials, this.layerColours, this.layerSpecials);
  }

  // Resolve each batch's colour and material from the per-layer settings, then upload. They
  // apply only to batches whose colour or material comes from that layer (see resolveLook in
  // extract.js), as in Rhino. specialsOn: the toolbar's Magic button.
  // layerMaterial(layerIndex): material properties set in the viewer ({ rgb?, alpha, gloss }) or null.
  // layerColour(layerIndex): display colour set in the viewer, or null.
  // layerSpecial(layerIndex): the layer's magic material (materials.js id, 0 = none).
  setMaterialRules(specialsOn, layerMaterial = this.layerMaterials, layerColour = this.layerColours, layerSpecial = this.layerSpecials) {
    Object.assign(this, { specialsOn, layerMaterials: layerMaterial, layerColours: layerColour, layerSpecials: layerSpecial });
    const ub = this.batchData;
    this.batches.forEach((b, i) => {
      const o = layerMaterial && b.mLayer >= 0 ? layerMaterial(b.mLayer) : null;
      const sp = layerSpecial && b.mLayer >= 0 ? layerSpecial(b.mLayer) : 0, type = specialsOn ? sp : 0;
      const base = i * (BATCH_STRIDE / 4);
      const c = (layerColour && b.cLayer >= 0 && layerColour(b.cLayer)) || (layerMaterial && b.cMatLayer >= 0 && layerMaterial(b.cMatLayer)?.rgb);
      ub.set(c || b.color.slice(0, 3), base);
      ub[base + 3] = SURFACE_PRIORITY[sp] || 0; // colour alpha is unused: it carries the surface priority
      // The material colour: set in the viewer, else the magic material's default, else the file's.
      const rgb = o?.rgb || (type ? SPECIAL[type].rgb : (b.mat || [1, 1, 1]).slice(0, 3));
      const alpha = o ? o.alpha : type ? 1 : b.mat ? b.mat[3] : 1;
      b.effCls = type;
      b.special = sp;
      b.transparent = b.kind === 'mesh' && type !== MAT_WATER && alpha < 1;
      ub.set([...rgb, alpha], base + 4);
      ub.set([b.vc ? 1 : 0, b.kind === 'edge' ? 1 : 0, type, o ? o.gloss : 0], base + 8);
    });
    if (this.batches.length) this.device.queue.writeBuffer(this.batchBuf, 0, ub);
    this.dirty = true;
  }

  // Is animated water on screen? (drives continuous redraw)
  hasWater(mode) {
    return (mode === 1 || mode === 2) && this.batches.some((b) => b.visible && b.kind === 'mesh' && b.effCls === MAT_WATER);
  }

  writeFrame(buf, viewProj, s) {
    const f = this.frameData;
    f.set(viewProj, 0);
    f.set([...s.eye, s.ortho ? 1 : 0], 16);
    f.set([...s.light, 0], 20);
    f.set([this.width, this.height, s.pointSize * (s.dpr || 1), s.mode], 24);
    f.set(s.edgeColor, 28);
    f.set(s.bgTop, 32);
    f.set(s.bgBot, 36);
    const sh = s.shadows;
    f.set([s.xray ? 0.22 : 0, sh ? 1 : 0, s.aoActive ? 1 : 0, sh ? sh.invRange : 0], 40);
    f.set([...s.viewDir, 0], 44);
    f.set(s.sun ? [...s.sun.dir, 1] : [0, 0, 1, 0], 48);
    f.set(s.sun ? [...s.sun.rgb, s.sun.sky] : [0, 0, 0, 1], 52);
    f.set(sh ? sh.splits : [0, 0, 0, 0], 56);
    f.set(sh ? sh.texel : [0, 0, 0, 0], 60);
    f.set(s.ground || [0, 0, 0, 0], 64);
    f.set([s.time || 0, s.metresPerUnit || 1, s.hazeStart || 0, s.hazeDensity || 0], 68);
    f.set([0, 0.25, 0.55, 1.0], 72); // highlight colour for selected objects
    const cam = s.cam;
    f.set(cam ? [...cam.right, Math.tan(cam.fov / 2)] : [1, 0, 0, 1], 76);
    f.set(cam ? [...cam.up, cam.aspect] : [0, 0, 1, 1], 80);
    const sun = s.sun, rad = Math.PI / 180;
    f.set(sun ? [...sun.glow, sun.night] : [0, 0, 0, 0], 84);
    f.set(sun ? [sun.lat * rad, sun.lst, sun.north * rad, 0] : [0, 0, 0, 0], 88);
    f.set(sun ? [...sun.moonDir, sun.moonLit] : [0, 0, -1, 0], 92);
    f.set(sun ? [...sun.sunDir, 0] : [0, 0, 1, 0], 96);
    if (sh) sh.mats.forEach((m, c) => f.set(m, 100 + c * 16));
    this.device.queue.writeBuffer(buf, 0, f);
  }

  // Render each cascade's depth map from the sun.
  renderShadows(enc, sh) {
    const data = new Float32Array(CASCADES * 64);
    sh.mats.forEach((m, c) => data.set(m, c * 64));
    this.device.queue.writeBuffer(this.shadowBuf, 0, data);
    for (let c = 0; c < CASCADES; c++) {
      const pass = enc.beginRenderPass({ colorAttachments: [],
        depthStencilAttachment: { view: this.shadowLayers[c], depthClearValue: 0, depthLoadOp: 'clear', depthStoreOp: 'store' } });
      pass.setPipeline(this.shadowPipe);
      pass.setBindGroup(0, this.shadowBG, [c * 256]);
      for (const b of this.batches) {
        if (!b.visible || b.kind !== 'mesh' || (b.mat && b.mat[3] < 0.6)) continue;
        pass.setVertexBuffer(0, b.gpu.pos); pass.setVertexBuffer(1, b.gpu.oid);
        pass.setIndexBuffer(b.gpu.idx, 'uint32');
        pass.drawIndexed(b.count);
      }
      pass.end();
    }
  }

  // s: { viewProj, eye, viewDir, light, ortho, mode, xray, showEdges, showCurves, showPoints,
  //      sun?: { dir, rgb, sky }, shadows?: output of shadowCascades(), ground?: [cx, cy, z, half] }
  draw(s) {
    if (!this.width) return;
    s.aoActive = !!(s.ao && s.cam && !s.xray);
    this.writeFrame(this.frameBuf, s.viewProj, s);
    const enc = this.device.createCommandEncoder();
    if (s.shadows) this.renderShadows(enc, s.shadows);
    if (s.aoActive) this.renderAO(enc, s);
    const pass = enc.beginRenderPass({
      colorAttachments: [{ view: this.msaaTex.createView(), resolveTarget: this.ctx.getCurrentTexture().createView(),
        clearValue: { r: 0, g: 0, b: 0, a: 1 }, loadOp: 'clear', storeOp: 'discard' }],
      depthStencilAttachment: { view: this.depthTex.createView(), depthClearValue: 0, depthLoadOp: 'clear', depthStoreOp: 'discard' },
    });
    const P = this.pipes;
    pass.setBindGroup(0, this.frameBG);
    pass.setPipeline(P.bg);
    pass.draw(3);

    const vis = this.batches.filter((b) => b.visible);
    const meshes = vis.filter((b) => b.kind === 'mesh');
    const transparentMode = (b) => s.xray || (s.mode === 1 && b.transparent);
    const drawMesh = (b) => {
      pass.setPipeline(transparentMode(b) ? (b.vc ? P.meshVCT : P.meshT) : b.vc ? P.meshVC : P.mesh);
      pass.setBindGroup(1, this.batchBG, [b.offset]);
      pass.setVertexBuffer(0, b.gpu.pos); pass.setVertexBuffer(1, b.gpu.nrm);
      if (b.vc) pass.setVertexBuffer(2, b.gpu.col);
      pass.setVertexBuffer(b.vc ? 3 : 2, b.gpu.oid);
      pass.setIndexBuffer(b.gpu.idx, 'uint32');
      pass.drawIndexed(b.count);
    };
    for (const b of meshes) if (!transparentMode(b)) drawMesh(b);
    if (s.ground && s.shadows && !s.xray) { pass.setPipeline(P.ground); pass.draw(6); }
    for (const b of vis) {
      // Edges on water and foliage are noise, so they are hidden when those materials apply.
      const softEdge = b.kind === 'edge' && ((s.mode === 1 && (b.effCls === MAT_WATER || b.effCls === MAT_VEGETATION)) || (s.mode === 2 && b.effCls === MAT_WATER));
      if ((b.kind === 'edge' && s.showEdges && !softEdge) || (b.kind === 'line' && s.showCurves)) {
        pass.setPipeline(s.xray ? P.lineX : P.line);
        pass.setBindGroup(1, this.batchBG, [b.offset]);
        pass.setVertexBuffer(0, b.gpu.pos); pass.setVertexBuffer(1, b.gpu.oid);
        pass.draw(b.count);
      } else if (b.kind === 'point' && s.showPoints) {
        pass.setPipeline(s.xray ? P.pointX : P.point);
        pass.setBindGroup(1, this.batchBG, [b.offset]);
        pass.setVertexBuffer(0, b.gpu.pos); pass.setVertexBuffer(1, b.gpu.oid);
        pass.draw(4, b.count);
      }
    }
    for (const b of meshes) if (transparentMode(b)) drawMesh(b);
    pass.end();
    this.device.queue.submit([enc.finish()]);
  }

  // Returns { p: world position (model-relative), id: object index } for the visible surface
  // under pixel (px, py), or null for empty space. Picks share one readback buffer, so
  // overlapping calls are queued and run one after another.
  pick(px, py, viewProj, s) {
    const run = () => this.pickNow(px, py, viewProj, s);
    this.pickQueue = (this.pickQueue || Promise.resolve()).then(run, run);
    return this.pickQueue;
  }

  async pickNow(px, py, viewProj, s) {
    if (!this.width) return null;
    this.pickBusy = true;
    try {
      // Post-multiply so the single pixel fills clip space.
      const cx = ((px + 0.5) / this.width) * 2 - 1, cy = 1 - ((py + 0.5) / this.height) * 2;
      const W = this.width, H = this.height, pm = new Float64Array(16);
      pm[0] = W; pm[5] = H; pm[10] = 1; pm[15] = 1; pm[12] = -W * cx; pm[13] = -H * cy;
      this.writeFrame(this.pickFrameBuf, M4.mul(pm, viewProj), s);
      const enc = this.device.createCommandEncoder();
      const pass = enc.beginRenderPass({
        colorAttachments: [{ view: this.pickColor.createView(), clearValue: { r: 0, g: 0, b: 0, a: 0 }, loadOp: 'clear', storeOp: 'store' }],
        depthStencilAttachment: { view: this.pickDepth.createView(), depthClearValue: 0, depthLoadOp: 'clear', depthStoreOp: 'store' },
      });
      pass.setPipeline(this.pipes.pick);
      pass.setBindGroup(0, this.pickFrameBG);
      for (const b of this.batches) {
        if (!b.visible || b.kind !== 'mesh') continue;
        pass.setVertexBuffer(0, b.gpu.pos); pass.setVertexBuffer(1, b.gpu.oid);
        pass.setIndexBuffer(b.gpu.idx, 'uint32');
        pass.drawIndexed(b.count);
      }
      pass.end();
      enc.copyTextureToBuffer({ texture: this.pickColor }, { buffer: this.pickRead, bytesPerRow: 256 }, [1, 1]);
      this.device.queue.submit([enc.finish()]);
      await this.pickRead.mapAsync(GPUMapMode.READ);
      const v = new Float32Array(this.pickRead.getMappedRange(0, 16)).slice();
      this.pickRead.unmap();
      return v[3] > 0.5 ? { p: [v[0], v[1], v[2]], id: Math.round(v[3]) - 1 } : null;
    } finally {
      this.pickBusy = false;
    }
  }

  // Pedestrian mode's view of its surroundings (see walk.js), drawn with the pick pipeline so each
  // texel holds the world position of the surface it sees (w = 0 for nothing):
  //  - ground: GROUND_RES² texels looking straight down over the square of half size q.half
  //    centred on (q.x, q.y), from q.top down to q.bottom: the highest surface below q.top;
  //  - walls: four WALL_W x WALL_H views looking out along +x, -x, +y and -y from (q.x, q.y),
  //    q.reach wide either side and q.reach deep, between heights q.z0 and q.z1.
  // Vegetation (by its layer's magic material, even with the Magic button off) is left out, so
  // people walk through trees. Resolves to { ground, walls } (Float32Arrays, 4 floats per texel),
  // or null at once when the previous probe has not been read back yet.
  probe(q) {
    if (this.probeBusy || !this.batches.length) return Promise.resolve(null);
    this.probeBusy = true;
    const dev = this.device, G = PROBE.ground, W = PROBE.wallW, H = PROBE.wallH, rows = G + H, U = GPUBufferUsage;
    if (!this.probeTex) {
      const RA = GPUTextureUsage.RENDER_ATTACHMENT;
      this.probeTex = dev.createTexture({ size: [G, rows], format: 'rgba32float', usage: RA | GPUTextureUsage.COPY_SRC });
      this.probeDepth = dev.createTexture({ size: [G, rows], format: DEPTH, usage: RA });
      this.probeRead = dev.createBuffer({ size: G * 16 * rows, usage: U.MAP_READ | U.COPY_DST });
      this.probeBufs = [0, 1, 2, 3, 4].map(() => dev.createBuffer({ size: FRAME_SIZE, usage: U.UNIFORM | U.COPY_DST }));
      this.probeBGs = null;
    }
    // Rebuilt when the object flags buffer is replaced (it grows with the model).
    if (!this.probeBGs || this.probeFlagsBuf !== this.objFlagsBuf) {
      this.probeFlagsBuf = this.objFlagsBuf;
      this.probeBGs = this.probeBufs.map((buffer) => dev.createBindGroup({ layout: this.frameLayout, entries: [
        { binding: 0, resource: { buffer } }, { binding: 1, resource: this.shadowView }, { binding: 2, resource: this.shadowCmp },
        { binding: 3, resource: this.aoTex.createView() }, { binding: 4, resource: { buffer: this.objFlagsBuf } }] }));
    }
    const views = [{ vp: M4.mul(M4.ortho(q.half, 1, 0, q.top - q.bottom), M4.lookAt([q.x, q.y, q.top], [q.x, q.y, q.top - 1], [0, 1, 0])), rect: [0, 0, G, G] }];
    const zm = (q.z0 + q.z1) / 2, hh = (q.z1 - q.z0) / 2;
    [[1, 0], [-1, 0], [0, 1], [0, -1]].forEach(([dx, dy], k) => {
      const eye = [q.x, q.y, zm];
      views.push({ vp: M4.mul(M4.ortho(hh, q.reach / hh, 0, q.reach), M4.lookAt(eye, [q.x + dx, q.y + dy, zm], [0, 0, 1])), rect: [k * W, G, W, H] });
    });
    views.forEach((v, i) => dev.queue.writeBuffer(this.probeBufs[i], 0, Float32Array.from(v.vp)));

    const R = Math.max(q.half, q.reach);
    const near = this.batches.filter((b) => b.visible && b.kind === 'mesh' && b.special !== MAT_VEGETATION
      && b.min[0] <= q.x + R && b.max[0] >= q.x - R && b.min[1] <= q.y + R && b.max[1] >= q.y - R && b.min[2] <= q.top && b.max[2] >= q.bottom);
    const enc = dev.createCommandEncoder();
    const pass = enc.beginRenderPass({
      colorAttachments: [{ view: this.probeTex.createView(), clearValue: { r: 0, g: 0, b: 0, a: 0 }, loadOp: 'clear', storeOp: 'store' }],
      depthStencilAttachment: { view: this.probeDepth.createView(), depthClearValue: 0, depthLoadOp: 'clear', depthStoreOp: 'store' },
    });
    pass.setPipeline(this.pipes.pick);
    views.forEach((v, i) => {
      pass.setViewport(...v.rect, 0, 1);
      pass.setScissorRect(...v.rect);
      pass.setBindGroup(0, this.probeBGs[i]);
      for (const b of near) {
        pass.setVertexBuffer(0, b.gpu.pos); pass.setVertexBuffer(1, b.gpu.oid);
        pass.setIndexBuffer(b.gpu.idx, 'uint32');
        pass.drawIndexed(b.count);
      }
    });
    pass.end();
    enc.copyTextureToBuffer({ texture: this.probeTex }, { buffer: this.probeRead, bytesPerRow: G * 16 }, [G, rows]);
    dev.queue.submit([enc.finish()]);
    return this.probeRead.mapAsync(GPUMapMode.READ).then(() => {
      // Two sets of arrays used in turn, so the previous result stays valid and nothing is
      // allocated per frame (garbage collection pauses showed as judder while walking).
      this.probeOut = this.probeOut || [0, 1].map(() => ({ all: new Float32Array(G * rows * 4), walls: new Float32Array(4 * W * H * 4) }));
      const out = this.probeOut[(this.probeFlip ^= 1)], all = out.all, walls = out.walls;
      all.set(new Float32Array(this.probeRead.getMappedRange()));
      this.probeRead.unmap();
      for (let k = 0; k < 4; k++) for (let r = 0; r < H; r++)
        walls.set(all.subarray(((G + r) * G + k * W) * 4, ((G + r) * G + (k + 1) * W) * 4), ((k * H + r) * W) * 4);
      return { ground: all.subarray(0, G * G * 4), walls };
    }, () => null).finally(() => { this.probeBusy = false; });
  }
}

const PROBE = { ground: 128, wallW: 32, wallH: 16 };
