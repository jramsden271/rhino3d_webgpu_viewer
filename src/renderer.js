// WebGPU renderer: reverse-Z depth, 4x MSAA, on-demand redraw, GPU picking for orbit/zoom
// pivots, and sun lighting with cascaded shadow maps.

const CASCADES = 4;
const AO_DIV = 2;                // the occlusion is worked out at 1/AO_DIV of the window's width and height
const SHADOW_SIZE = 2048;
const MAX_LAMPS = 8;
const LAMP_SHADOW_SIZE = 512;
const LAMP_SHADOW_LAYERS = 25;   // e.g. a torch (1) and four point lights (6 each)
const LAMP_NEAR = 0.05;          // metres
// Unit vectors across a lamp shadow view looking along d (matches lampBasis in the shader).
function lampBasis(d) {
  const up = Math.abs(d[2]) > 0.99 ? [0, 1, 0] : [0, 0, 1];
  const r = V3.norm(V3.cross(d, up));
  return [r, V3.cross(r, d)];
}
const CUBE_DIRS = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];

// Which lamps get shadows, in order, while layers last: a narrow spot takes one layer, a point
// light (or a spot wider than 60 degrees) six. Returns per lamp { layer, t, dirs } or null.
function lampShadowPlan(lamps) {
  let next = 0;
  return lamps.map((l) => {
    const cube = !l.dir || l.outer > 60, need = cube ? 6 : 1;
    if (next + need > LAMP_SHADOW_LAYERS) return null;
    const plan = { layer: next, t: cube ? 1 : Math.tan((l.outer * Math.PI) / 180), dirs: cube ? CUBE_DIRS : [V3.norm(l.dir)] };
    next += need;
    return plan;
  });
}

// Clip transform (column-major) for one lamp shadow view: from p along d, half angle atan(t),
// reversed depth near / distance.
function lampShadowMatrix(p, d, t, near) {
  const [r, u] = lampBasis(d), m = new Float32Array(16);
  const row = (k, a, w) => { m[k] = a[0]; m[4 + k] = a[1]; m[8 + k] = a[2]; m[12 + k] = w; };
  row(0, V3.scale(r, 1 / t), -V3.dot(r, p) / t);
  row(1, V3.scale(u, 1 / t), -V3.dot(u, p) / t);
  row(2, [0, 0, 0], near);
  row(3, d, -V3.dot(d, p));
  return m;
}

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
  clouds: vec4f,    // x = cloud cover (0-1), yz = how far the clouds have drifted (km), w = haze (1 clear .. 0)
  misc: vec4f,      // x = time (s), y = metres per model unit, z = haze start distance, w = haze density
  sel: vec4f,       // yzw = highlight colour for selected objects (see objFlags)
  camRight: vec4f,  // xyz camera right, w = tan(fov / 2)
  camUp: vec4f,     // xyz camera up, w = aspect ratio
  skyGlow: vec4f,   // rgb = twilight glow along the horizon towards the sun (sRGB), w = night (0 day .. 1 dark)
  stars: vec4f,     // x = latitude, y = local sidereal time, z = north angle (radians), w = 1 for a plain white background (no sky)
  moon: vec4f,      // xyz towards the moon, w = illuminated fraction
  skySun: vec4f,    // xyz towards the sun itself (sunDir is the moon when it lights the scene), w = draw the sky
  surface: vec4f,   // xyz = origin of the surface noise (model units), w = surface variation strength (0 off)
  marker: vec4f,    // where walking would start: xyz centre, w = radius (model units, 0 = none)
  shadow: array<mat4x4f, ${CASCADES}>,
  lampCount: vec4f, // x = number of lamps in use
  // Per lamp: xyz position, w = range (m); rgb = colour x power, w = cos of the spot's inner cone;
  // xyz = spot direction, w = cos of the outer cone (-2 for a point light shining all round);
  // shadow: x = first layer in lampShadowMap (-1 none), y = near plane (model units),
  // z = tan of the shadow view's half angle, w = number of views (1 along the spot, 6 cube faces).
  lamps: array<vec4f, ${MAX_LAMPS * 4}>,
};
// flags.x vertex colours, flags.y edge, flags.z material type (see materials.js), resolved on the
// CPU from the rule mode and any layer settings made in the viewer; flags.w gloss (0..1).
struct Batch { color: vec4f, mat: vec4f, flags: vec4f };

@group(0) @binding(0) var<uniform> F: Frame;
@group(0) @binding(1) var shadowMap: texture_depth_2d_array;
@group(0) @binding(2) var shadowCmp: sampler_comparison;
@group(0) @binding(3) var aoTex: texture_2d<f32>;
@group(0) @binding(4) var<storage, read> objFlags: array<u32>; // per object: bit 0 hidden, bit 1 selected
@group(0) @binding(5) var lampShadowMap: texture_depth_2d_array;
@group(0) @binding(6) var gbuf: texture_2d<f32>;   // AO prepass: face normal, view depth (1x1 dummy while it is drawn)
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

// The colour along the horizon behind the model: the sky's, or white with the Sky off.
fn horizon() -> vec3f { return select(F.bgBot.rgb, vec3f(1.0), F.stars.w > 0.5); }

// Aerial perspective: geometry beyond the orbit target fades towards the horizon colour.
fn hazeAmount(wp: vec3f) -> f32 {
  let d = length(wp - F.eye.xyz);
  return clamp(1.0 - exp(-max(d - F.misc.z, 0.0) * F.misc.w), 0.0, 0.6);
}
fn finish(lin: vec3f, wp: vec3f) -> vec3f {
  return mix(toSrgb(tonemap(lin)), horizon(), hazeAmount(wp));
}

// Value noise for the sky's features.
fn hash2(p: vec2f) -> f32 { return fract(sin(dot(p, vec2f(127.1, 311.7))) * 43758.5453); }
fn noise2(p: vec2f) -> f32 {
  let i = floor(p);
  let f = fract(p);
  let u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash2(i), hash2(i + vec2f(1.0, 0.0)), u.x), mix(hash2(i + vec2f(0.0, 1.0)), hash2(i + vec2f(1.0, 1.0)), u.x), u.y);
}

// 3D value noise for surfaces, evaluated at the point in space, so it needs no texture coordinates
// and wraps round any shape without seams or the streaks a flat projection leaves on slopes.
fn hash3(c: vec3f) -> f32 {
  let i = bitcast<vec3u>(vec3i(c));
  var h = (i.x * 0x8da6b343u) ^ (i.y * 0xd8163841u) ^ (i.z * 0xcb1ab31fu);
  h = (h ^ (h >> 15u)) * 0x2c1b3c6du;
  h = (h ^ (h >> 12u)) * 0x297a2d39u;
  h = h ^ (h >> 15u);
  return f32(h >> 8u) / 16777216.0;
}
fn noise3(p: vec3f) -> f32 {
  let i = floor(p);
  let f = p - i;
  let u = f * f * (3.0 - 2.0 * f);
  let a = mix(mix(hash3(i), hash3(i + vec3f(1.0, 0.0, 0.0)), u.x), mix(hash3(i + vec3f(0.0, 1.0, 0.0)), hash3(i + vec3f(1.0, 1.0, 0.0)), u.x), u.y);
  let b = mix(mix(hash3(i + vec3f(0.0, 0.0, 1.0)), hash3(i + vec3f(1.0, 0.0, 1.0)), u.x), mix(hash3(i + vec3f(0.0, 1.0, 1.0)), hash3(i + vec3f(1.0, 1.0, 1.0)), u.x), u.y);
  return mix(a, b, u.z);
}
// Surface noise around 0 (mostly within +-0.25): octaves from features of size metres down, each
// half the last. p in metres; px: metres per pixel there. An octave fades out as its features
// shrink towards a few pixels, so distant surfaces settle to their plain colour instead of
// shimmering as the view moves (multisampling smooths edges, not shading).
fn surfNoise(p: vec3f, size: f32, octaves: i32, px: f32) -> f32 {
  var s = 0.0;
  var a = 0.5;
  var w = size;
  var q = p / size;
  for (var i = 0; i < octaves; i++) {
    let fade = 1.0 - smoothstep(0.12, 0.35, px / w);
    if (fade <= 0.0) { break; }
    s += a * fade * (noise3(q) - 0.5);
    q = q * 2.03 + vec3f(17.1, 9.2, 4.7);
    w = w / 2.03;
    a *= 0.5;
  }
  return s;
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
  if (F.stars.w > 0.5) { return vec4f(1.0); }
  let screen = mix(F.bgBot.rgb, F.bgTop.rgb, in.ndc.y * 0.5 + 0.5);
  if (F.skySun.w < 0.5 || F.eye.w > 0.5) { return vec4f(screen, 1.0); }
  // A real sky in perspective, for the sun or the weather. Gradient by elevation of the view ray, plus the sun.
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
  let above = F.sunDir.w * smoothstep(-0.02, 0.02, L.z) * smoothstep(-0.0015, 0.0015, dir.z);   // none with the sun off
  let d = max(dot(dir, L), 0.0);
  // A low sun is orange-red, and so is the glow around it.
  let high = smoothstep(0.0, 0.25, L.z);
  let discCol = mix(vec3f(1.0, 0.42, 0.16), vec3f(1.0, 0.98, 0.92), high);
  let warm = mix(vec3f(1.0, 0.5, 0.2), vec3f(0.96, 0.95, 0.91), high);
  let glow = pow(d, 900.0) * 0.55 + pow(d, 80.0) * 0.14 + pow(d, 10.0) * 0.035;
  let disc = smoothstep(0.99985, 0.99993, d);                          // ~0.7 deg across
  let clear = mix(0.3, 1.0, F.clouds.w);                               // a hazy sun is fainter
  col = mix(col + warm * glow * above * clear, discCol, disc * above * clear);
  col = moonDisc(dir, col, sky, night);
  col = clouds(dir, col);
  col = toSrgb(tonemap(toLinear(clamp(col, vec3f(0.0), vec3f(1.0))) + lampGlow(dir, 1e30)));
  return vec4f(clamp(col, vec3f(0.0), vec3f(1.0)), 1.0);
}

// Clouds: fractal noise on a plane CLOUD_KM up, drifting with the wind. More cover lowers the
// threshold the noise must pass, so the clouds grow and merge; from about 9/10 the sky closes over.
// Towards the horizon the layer thins into an even haze of its average, which also hides the
// noise's detail where it would shimmer.
//
// The layer is fixed in the model's space (km from its origin), so the shadows on the model fall
// from the clouds seen overhead, and they shift a little as the camera moves; when the camera is
// in a cloud's shadow, that cloud is over the sun. clouds.js repeats the field on the CPU (for
// the thermal comfort panel), so its noise uses an integer hash that gives the same values there
// as here, where sin-based hashing would not.
fn cloudHash(c: vec2f) -> f32 {
  let i = bitcast<vec2u>(vec2i(c));
  var h = (i.x * 0x8da6b343u) ^ (i.y * 0xd8163841u);
  h = (h ^ (h >> 15u)) * 0x2c1b3c6du;
  h = (h ^ (h >> 12u)) * 0x297a2d39u;
  h = h ^ (h >> 15u);
  return f32(h >> 8u) / 16777216.0;
}
fn cloudValue(p: vec2f) -> f32 {
  let i = floor(p);
  let f = p - i;
  let u = f * f * (3.0 - 2.0 * f);
  return mix(mix(cloudHash(i), cloudHash(i + vec2f(1.0, 0.0)), u.x), mix(cloudHash(i + vec2f(0.0, 1.0)), cloudHash(i + vec2f(1.0, 1.0)), u.x), u.y);
}
fn fbm(p: vec2f, octaves: i32) -> f32 {
  var s = 0.0;
  var a = 0.5;
  var q = p;
  for (var i = 0; i < octaves; i++) { s += a * cloudValue(q); q = q * 2.03 + vec2f(17.1, 9.2); a *= 0.5; }
  return s / (1.0 - a * 2.0);
}
// The noise at a point on the cloud layer (km), drifted with the wind; ~1 km features.
fn cloudNoise(q: vec2f, octaves: i32) -> f32 { return fbm((q - F.clouds.yz) * 0.8, octaves); }
// The level the noise exceeds over a fraction cover of the sky (fitted to fbm's distribution),
// less half the cloud edge's width, so that much of the sky is at least half cloud.
fn cloudLevel(cover: f32) -> f32 {
  let dc = cover - 0.5;
  return 0.47 - 0.37 * dc - 0.45 * dc * dc * dc;
}
// Cloud shadow on the model: 1 in the open, down to 0.1 under a cloud. The key light's ray from
// the point up to the layer, with four octaves rather than the sky's five: the shadows are soft.
fn cloudShade(wp: vec3f) -> f32 {
  let cover = F.clouds.x;
  if (cover < 0.01) { return 1.0; }
  let L = F.sunDir.xyz;
  let p = wp * (F.misc.y / 1000.0);
  let q = p.xy + L.xy / max(L.z, 0.08) * max(${CLOUD_KM} - p.z, 0.0);
  let t = cloudLevel(cover);
  let a = max(smoothstep(t - 0.02, t + 0.1, cloudNoise(q, 4)), smoothstep(0.85, 1.0, cover));
  return 1.0 - 0.9 * a;
}
fn clouds(dir: vec3f, col: vec3f) -> vec3f {
  let cover = F.clouds.x;
  if (cover < 0.01 || dir.z <= 0.0) { return col; }
  let L = F.skySun.xyz;
  let eye = F.eye.xyz * (F.misc.y / 1000.0);
  let n = cloudNoise(eye.xy + dir.xy / max(dir.z, 0.02) * max(${CLOUD_KM} - eye.z, 0.2), 5);
  let t = cloudLevel(cover);
  let detail = smoothstep(0.04, 0.3, dir.z);
  let thick = mix(cover * 0.5, smoothstep(t, t + 0.3, n), detail);
  var a = max(smoothstep(t, t + 0.06, n), smoothstep(0.85, 1.0, cover));
  a = mix(cover * 0.8, a, detail) * smoothstep(0.0, 0.04, dir.z);
  let ds = dot(dir, L);
  // Shading: white, greyer where thick and under a closed sky, bright edges towards the sun, a
  // warm underside at sunset, dimmer through twilight, and at night a little lighter than the sky.
  let day = smoothstep(-0.12, 0.2, L.z);
  var c = mix(vec3f(0.98, 0.98, 0.99), vec3f(0.56, 0.58, 0.63), clamp(thick * 0.7 + cover * 0.35, 0.0, 1.0));
  let high = smoothstep(0.0, 0.25, L.z);
  c += mix(vec3f(1.0, 0.55, 0.25), vec3f(1.0), high) * pow(max(ds, 0.0), 6.0) * 0.3 * (1.0 - thick) * day;
  c = c * mix(0.22, 1.0, day) + F.skyGlow.rgb * 1.4 * (1.0 - 0.5 * thick);
  let moonlit = F.moon.w * smoothstep(-0.02, 0.1, F.moon.z);
  c = mix(c, F.bgBot.rgb * 1.6 + vec3f(0.02, 0.022, 0.028) + vec3f(0.08, 0.085, 0.095) * moonlit, F.skyGlow.w);
  return mix(col, clamp(c, vec3f(0.0), vec3f(1.0)), a);
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
  @location(3) @interpolate(flat) seed: f32, @location(4) @interpolate(flat) oid: u32,
  @location(5) np: vec3f };   // np: position for the surface noise, in metres from F.surface.xyz
// Surface priority (B.color.a): ground-like layers are pushed very slightly away from the camera
// so roads, paving and water win where they nearly coincide with or dip into the terrain.
// The push is a fraction of the viewing distance, so it is invisible at any zoom.
fn meshClip(p: vec3f, oid: u32) -> vec4f {
  if (objFlag(oid, 1u)) { return CULLED; }
  let c = F.viewProj * vec4f(p, 1.0);
  return vec4f(c.xy, c.z * (1.0 - B.color.a * 1e-3), c.w);
}
@vertex fn vsMesh(@location(0) p: vec3f, @location(1) n: vec4f, @location(4) oid: u32) -> MOut {
  return MOut(meshClip(p, oid), n.xyz, p, vec4f(0.0), n.w, oid, (p - F.surface.xyz) * F.misc.y);
}
@vertex fn vsMeshVC(@location(0) p: vec3f, @location(1) n: vec4f, @location(2) c: vec4f, @location(4) oid: u32) -> MOut {
  return MOut(meshClip(p, oid), n.xyz, p, c, n.w, oid, (p - F.surface.xyz) * F.misc.y);
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
    if (o.vis > 0.0) { o.vis *= cloudShade(wp); }
    o.direct = F.sunColor.rgb * ndl * o.vis;
    o.ambient = mix(vec3f(0.13, 0.125, 0.12), vec3f(0.31, 0.35, 0.43), n.z * 0.5 + 0.5) * F.sunColor.w;
    o.ambient = mix(o.ambient, o.ambient * vec3f(0.62, 0.78, 1.25), F.skyGlow.w);   // blue night light
  } else {
    o.L = normalize(F.light.xyz);
    o.vis = 1.0;
    o.direct = vec3f(0.62) * max((dot(n, o.L) + wrap) / (1.0 + wrap), 0.0);
    o.ambient = mix(vec3f(0.30, 0.29, 0.28), vec3f(0.58, 0.60, 0.64), n.z * 0.5 + 0.5);
  }
  o.direct += lampLight(wp, n, wrap);
  return o;
}

// Lamps (point and spot lights): inverse-square falloff, eased to zero at each lamp's range,
// with shadows for the first few (see lampShadowPlan).
//
// A lamp's shadow views look along a direction d with a square frustum of half angle atan(t):
// one view along a spot's axis, or six cube faces (+x, -x, +y, -y, +z, -z) for a point light.
// Depth is reversed (near / distance along d), as for the sun. lampBasis matches the JS one.
fn lampBasis(d: vec3f) -> mat2x3f {
  var up = vec3f(0.0, 0.0, 1.0);
  if (abs(d.z) > 0.99) { up = vec3f(0.0, 1.0, 0.0); }
  let r = normalize(cross(d, up));
  return mat2x3f(r, cross(r, d));
}
fn lampShadow(i: u32, wp: vec3f, n: vec3f) -> f32 {
  let sh = F.lamps[i * 4u + 3u];
  if (sh.x < 0.0) { return 1.0; }
  let a = F.lamps[i * 4u].xyz;
  let s = F.lamps[i * 4u + 2u];
  var d = s.xyz;
  var layer = sh.x;
  let v0 = wp - a;
  if (sh.w > 1.5) {                                 // six cube faces
    let av = abs(v0);
    if (av.x >= av.y && av.x >= av.z) { d = vec3f(sign(v0.x), 0.0, 0.0); layer += select(1.0, 0.0, v0.x > 0.0); }
    else if (av.y >= av.z) { d = vec3f(0.0, sign(v0.y), 0.0); layer += select(3.0, 2.0, v0.y > 0.0); }
    else { d = vec3f(0.0, 0.0, sign(v0.z)); layer += select(5.0, 4.0, v0.z > 0.0); }
  }
  let t = sh.z;
  // Normal offset of ~1.5 shadow texels against acne (a texel grows with distance).
  let texel = 2.0 * t * max(dot(v0, d), sh.y) / ${LAMP_SHADOW_SIZE}.0;
  let v = v0 + n * texel * 1.5;
  let z = dot(v, d);
  if (z <= sh.y) { return 1.0; }
  let b = lampBasis(d);
  let uv = vec2f(dot(v, b[0]), -dot(v, b[1])) / (t * z) * 0.5 + 0.5;
  if (any(uv < vec2f(0.0)) || any(uv > vec2f(1.0))) { return 1.0; }
  let depthRef = sh.y / max(z - texel, sh.y);
  let px = 1.0 / ${LAMP_SHADOW_SIZE}.0;
  var sum = 0.0;
  for (var y = -1; y <= 1; y++) {
    for (var x = -1; x <= 1; x++) {
      sum += textureSampleCompareLevel(lampShadowMap, shadowCmp, uv + vec2f(f32(x), f32(y)) * px, i32(layer), depthRef);
    }
  }
  return sum / 9.0;
}
fn spotFactor(i: u32, fromLamp: vec3f) -> f32 {
  let s = F.lamps[i * 4u + 2u];
  if (s.w < -1.5) { return 1.0; }
  return smoothstep(s.w, F.lamps[i * 4u + 1u].w, dot(fromLamp, s.xyz));
}
fn lampLight(wp: vec3f, n: vec3f, wrap: f32) -> vec3f {
  var sum = vec3f(0.0);
  for (var i = 0u; i < u32(F.lampCount.x); i++) {
    let a = F.lamps[i * 4u];
    let v = a.xyz - wp;
    let L = normalize(v);
    let d = length(v) * F.misc.y;                                  // metres
    let ndl = max((dot(n, L) + wrap) / (1.0 + wrap), 0.0);
    let win = clamp(1.0 - pow(d / a.w, 4.0), 0.0, 1.0);
    let e = ndl * win * win * spotFactor(i, -L) / (d * d + 1.0);
    if (e <= 0.0) { continue; }
    sum += F.lamps[i * 4u + 1u].rgb * e * lampShadow(i, wp, n);
  }
  return sum;
}

// The lamps themselves, seen along a view ray from the eye up to maxDist (model units): a bright
// bulb and a soft halo, hidden behind anything nearer than the lamp. Linear RGB.
fn lampGlow(dir: vec3f, maxDist: f32) -> vec3f {
  var sum = vec3f(0.0);
  for (var i = 0u; i < u32(F.lampCount.x); i++) {
    let a = F.lamps[i * 4u];
    let c = F.lamps[i * 4u + 1u].rgb * spotFactor(i, normalize(F.eye.xyz - a.xyz));  // a spot seen from behind is dark
    let t = dot(a.xyz - F.eye.xyz, dir);
    if (t <= 0.0 || t > maxDist) { continue; }
    let h = length(F.eye.xyz + dir * t - a.xyz) * F.misc.y;      // miss distance, metres
    let tm = t * F.misc.y;
    let tint = c / max(max(c.r, c.g), max(c.b, 1e-6));
    let core = 1.0 - smoothstep(0.07, 0.1 + 0.0015 * tm, h);       // a ~0.15 m bulb
    let r = h / (0.04 + 0.004 * tm);
    let halo = 0.6 / (1.0 + r * r);
    sum += tint * (core * 6.0 + halo) * min(length(c) / 20.0, 2.0);
  }
  return sum;
}

// Facade materials. p: position in metres (MOut.np), n: normal, c: base colour (sRGB), px: metres
// per pixel. Fine detail fades out as it nears pixel size, leaving the average colour.

// Concrete: cloudy tonal patches (stretched downwards on walls), aggregate speckle close up, and
// faint horizontal lines on walls where each 1.2 m pour or formwork panel meets the next.
fn concrete(p: vec3f, n: vec3f, c: vec3f, px: f32) -> vec3f {
  let wall = 1.0 - abs(n.z);
  let patches = surfNoise(p * vec3f(1.0, 1.0, mix(1.0, 0.4, wall)), 4.0, 4, px);
  let speck = surfNoise(p + vec3f(13.0, 3.0, 29.0), 0.03, 2, px);
  let joint = 1.0 - smoothstep(0.004, 0.009, abs(fract(p.z / 1.2 + 0.5) - 0.5) * 1.2);
  let line = joint * wall * (1.0 - smoothstep(0.004, 0.015, px));
  return c * (1.0 + 0.45 * patches + 0.3 * speck) * (1.0 - 0.12 * line);
}

// Red masonry: stretcher bond (225 x 75 mm brick modules) laid along each face, each brick a
// slightly different shade, over larger weathering patches. Roofs and paving take the bond in plan.
// Joints are not drawn: the mortar is blended into the colour at any distance. dx, dy: the
// screen derivatives of p. The bricks fade out as they shrink from ~3 to ~2 pixels, measured
// along and across the bond separately (a brick is 3x longer than tall), so walls seen at a
// glancing angle keep them as long as walls seen face on.
fn masonry(p: vec3f, fnrm: vec3f, c: vec3f, px: f32, dx: vec3f, dy: vec3f) -> vec3f {
  var uv = p.xy;
  var du = vec2f(dx.x, dy.x);
  var dv = vec2f(dx.y, dy.y);
  if (abs(fnrm.z) < 0.7) {
    let t = normalize(vec2f(-fnrm.y, fnrm.x));
    uv = vec2f(dot(p.xy, t), p.z);
    du = vec2f(dot(dx.xy, t), dot(dy.xy, t));
    dv = vec2f(dx.z, dy.z);
  }
  let row = floor(uv.y / 0.075);
  let col = floor(uv.x / 0.225 + 0.5 * row);
  let r = hash3(vec3f(col, row, 7.0));
  let brick = mix(c * vec3f(0.8, 0.78, 0.78), c * vec3f(1.15, 1.18, 1.2), r);
  let span = max(max(abs(du.x), abs(du.y)) / 0.225, max(abs(dv.x), abs(dv.y)) / 0.075);  // bricks per pixel
  let kb = 1.0 - smoothstep(0.3, 0.6, span);
  let weather = 1.0 + 0.3 * surfNoise(p, 6.0, 3, px);
  return mix(mix(c, brick, kb) * weather, vec3f(0.74, 0.72, 0.68), 0.17);
}

// Whitewashed concrete, nearly new: a gently uneven wash, a touch thinner in patches where the
// grey beneath shows faintly. No weathering streaks.
fn whitewash(p: vec3f, n: vec3f, c: vec3f, px: f32) -> vec3f {
  let wall = 1.0 - abs(n.z);
  let wash = surfNoise(p * vec3f(1.0, 1.0, mix(1.0, 0.6, wall)), 3.0, 4, px);
  let thin = smoothstep(0.08, 0.25, wash);
  return mix(c * (1.0 - 0.07 * wash), vec3f(0.66, 0.65, 0.62), thin * 0.12);
}

// The occlusion at a pixel, from its smaller texture: the four texels around the pixel. Where they
// differ, each counts as far as it lies on this same surface, so that shading does not bleed across
// edges. Most pixels are in even shading and do not need that look at the prepass.
fn aoAt(pos: vec2f, wp: vec3f, n: vec3f) -> f32 {
  let q = pos / ${AO_DIV}.0 - 0.5;
  let c = vec2i(floor(q));
  let f = q - floor(q);
  let lim = vec2i(textureDimensions(aoTex)) - 1;
  let t = array<vec2i, 4>(clamp(c, vec2i(0), lim), clamp(c + vec2i(1, 0), vec2i(0), lim), clamp(c + vec2i(0, 1), vec2i(0), lim), clamp(c + vec2i(1, 1), vec2i(0), lim));
  let a = vec4f(textureLoad(aoTex, t[0], 0).r, textureLoad(aoTex, t[1], 0).r, textureLoad(aoTex, t[2], 0).r, textureLoad(aoTex, t[3], 0).r);
  let w0 = vec4f((1.0 - f.x) * (1.0 - f.y), f.x * (1.0 - f.y), (1.0 - f.x) * f.y, f.x * f.y);
  if (max(max(a.x, a.y), max(a.z, a.w)) - min(min(a.x, a.y), min(a.z, a.w)) < 0.03) { return dot(a, w0); }
  let full = vec2i(textureDimensions(gbuf)) - 1;
  let d = dot(wp - F.eye.xyz, F.viewDir.xyz);
  var w = w0;
  for (var i = 0; i < 4; i++) {
    let g = textureLoad(gbuf, min(t[i] * ${AO_DIV} + vec2i(1), full), 0);
    w[i] *= exp(-abs(g.w - d) / (abs(d) * 0.02 + 1e-6)) * (max(dot(g.xyz, n), 0.0) + 0.01);
  }
  let total = w.x + w.y + w.z + w.w;
  if (total > 1e-4) { return dot(a, w) / total; }
  return dot(a, w0);
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
  var lt = lighting(in.wp, flatN, 0.0);
  if (F.sunDir.w > 0.5 && F.opts.y > 0.5 && dot(flatN, lt.L) > 0.0) {
    // Softer shadow edges than on land (light scatters in the water): four samples ~0.4 m apart.
    let r = 0.4 / F.misc.y;
    var soft = 0.0;
    for (var i = 0; i < 4; i++) {
      let a = f32(i) * 1.5707963 + 0.4;
      soft += sunVisibility(in.wp + vec3f(cos(a), sin(a), 0.0) * r, flatN);
    }
    soft *= 0.25 * cloudShade(in.wp);
    lt.direct += F.sunColor.rgb * max(dot(flatN, lt.L), 0.0) * (soft - lt.vis);
    lt.vis = soft;
  }
  let cosV = max(dot(n, V), 0.0);
  let fres = 0.02 + 0.98 * pow(1.0 - cosV, 5.0);
  let R = reflect(-V, n);
  var ao = 1.0;
  if (F.opts.z > 0.5) { ao = mix(1.0, aoAt(in.pos.xy, in.wp, flatN), 0.6); }
  // The layer's water colour. The sun term is what shows shadows: in shallow water they fall on
  // the lit floor beneath. Shade dims the reflection a little too (the caster hides some sky).
  let body = toLinear(B.mat.rgb) * (lt.ambient * 1.2 * ao + lt.direct * 0.3);
  var shade = ao;
  if (F.sunDir.w > 0.5) { shade *= mix(0.7, 1.0, lt.vis); }
  var col = mix(body, sky(R) * (0.55 + 0.45 * F.sunColor.w) * shade, fres);
  if (F.sunDir.w > 0.5) { col += F.sunColor.rgb * pow(max(dot(R, lt.L), 0.0), 600.0) * 6.0 * lt.vis; }
  return col;
}

// Soft edges: real corners are never knife-sharp, so the light rolls round them. The face normals a
// few pixels around (from the AO prepass) are averaged in where they lie on this surface or on one
// meeting it at a corner, not on something in front or behind. That rounds each corner by about
// 6 cm, at least 2 px on screen close up. Further off, where those 6 cm shrink below about a
// pixel, it fades out, or small buildings would melt into blobs. conv: + near an outside corner,
// - near an inside one.
struct Soft { n: vec3f, conv: f32 };
fn softEdge(pos: vec2f, wp: vec3f, dx: vec3f, dy: vec3f, n: vec3f) -> Soft {
  var o = Soft(n, 0.0);
  let p0 = vec2i(pos);
  let g0 = textureLoad(gbuf, p0, 0);
  let d0 = dot(wp - F.eye.xyz, F.viewDir.xyz);
  let pxw = max(length(dx), length(dy));   // model units per pixel
  if (g0.w <= 0.0 || abs(g0.w - d0) > 2.0 * pxw + abs(d0) * 1e-4) { return o; }   // another surface is in the prepass here
  let bevel = 0.06 / F.misc.y / pxw;       // the rounding, pixels
  let k = smoothstep(0.4, 1.5, bevel);
  if (k <= 0.0) { return o; }
  let r = clamp(bevel, 2.0, 5.0);
  let lim = vec2i(F.viewport.xy) - 1;
  var sum = g0.xyz;
  var cnt = 1.0;
  for (var i = 0; i < 8; i++) {
    let a = f32(i) * 0.7853982 + 0.39;
    let off = vec2i(round(vec2f(cos(a), sin(a)) * r));
    let g = textureLoad(gbuf, clamp(p0 + off, vec2i(0), lim), 0);
    let ow = dx * f32(off.x) + dy * f32(off.y);   // the offset along this face
    // Where the face would be there, were it flat; a corner bends away from that gradually.
    if (g.w <= 0.0 || abs(g.w - d0 - dot(ow, F.viewDir.xyz)) > length(ow)) { continue; }
    sum += g.xyz;
    cnt += 1.0;
    o.conv += dot(g.xyz, normalize(ow)) * k / 8.0;
  }
  o.n = normalize(n + (sum / cnt - g0.xyz) * k);
  return o;
}

@fragment fn fsMesh(in: MOut) -> @location(0) vec4f {
  let mode = F.viewport.w;
  var V = normalize(F.eye.xyz - in.wp);
  if (F.eye.w > 0.5) { V = -F.viewDir.xyz; }
  // Two-sided lighting: decide which side we see from the true face orientation, not the
  // interpolated normal (which can face away near silhouettes of smooth-shaded shapes).
  let dwx = dpdx(in.wp);
  let dwy = dpdy(in.wp);
  var faceN = cross(dwx, dwy);
  if (dot(faceN, V) < 0.0) { faceN = -faceN; }
  var n = normalize(in.n);
  if (dot(n, faceN) < 0.0) { n = -n; }
  let dnx = dpdx(in.np);
  let dny = dpdy(in.np);
  let px = max(length(dnx), length(dny));   // metres per pixel, for surfNoise

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
  // Ground types: blotches from 25 m across down to a few metres.
  var ground = 0.5;
  if (cls >= 4 && cls <= 7) { ground = clamp(0.5 + 1.6 * surfNoise(in.np, 25.0, 4, px), 0.0, 1.0); }
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
    case 8: { base = concrete(in.np, n, c, px); spec = 0.06; gloss = 10.0; }
    case 9: { base = masonry(in.np, normalize(faceN), c, px, dnx, dny); spec = 0.04; gloss = 8.0; }
    case 10: { base = whitewash(in.np, n, c, px); spec = 0.03; gloss = 8.0; }
    default: {}
  }
  // Other surfaces, in the Rendered view with magic materials on: a faint blotchy discolouration,
  // a finer grain seen close up, and highlights that break up as a real finish's do rather than
  // shining evenly. On walls the blotches stretch downwards, as weathering streaks run.
  if (cls == 0 && F.surface.w > 0.0 && F.opts.x == 0.0) {
    let wall = 1.0 - abs(n.z);
    let blotch = surfNoise(in.np * vec3f(1.0, 1.0, mix(1.0, 0.35, wall)), 8.0, 3, px);
    let grain = surfNoise(in.np + vec3f(41.0, 7.0, 23.0), 0.12, 2, px);
    base *= 1.0 + F.surface.w * (0.25 * blotch + 0.13 * grain);
    let rough = surfNoise(in.np + vec3f(5.0, 61.0, 13.0), 1.2, 3, px) * F.surface.w;
    spec *= max(1.0 + 3.0 * rough, 0.2);
    gloss *= max(1.0 - 2.0 * rough, 0.4);
  }
  let vc = B.flags.x > 0.5 && mode < 1.5;
  if (vc) { base = in.c.rgb; }

  var ao = 1.0;
  var conv = 0.0;
  if (F.opts.z > 0.5 && F.opts.x == 0.0 && alpha >= 1.0) {
    ao = aoAt(in.pos.xy, in.wp, normalize(faceN));
    if (cls != 2 && cls != 3) { let se = softEdge(in.pos.xy, in.wp, dwx, dwy, n); n = se.n; conv = se.conv; }
  }
  let lt = lighting(in.wp, n, wrap);
  let h = normalize(lt.L + V);
  let specular = pow(max(dot(n, h), 0.0), gloss) * spec * lt.vis * select(0.6, 1.0, F.sunDir.w > 0.5);
  var lit = toLinear(base) * (lt.ambient * ao + lt.direct * mix(1.0, ao, 0.3));
  lit *= 1.0 + 0.2 * max(conv, 0.0) + 0.08 * min(conv, 0.0);   // outside corners catch the light
  if (F.sunDir.w > 0.5) { lit += F.sunColor.rgb * specular; } else { lit += vec3f(specular); }
  if (cls == 2) {                                   // glass reflects the sky
    let fres = 0.08 + 0.92 * pow(1.0 - max(dot(n, V), 0.0), 4.0);
    lit = mix(lit, sky(reflect(-V, n)) * 0.9, fres * 0.8);
  }
  // Vertex colours keep an even, readable shading under the headlight; with the sun on they take
  // the scene's light like any other surface (so they darken at dusk and night).
  if (vc && F.sunDir.w < 0.5) { lit = toLinear(base) * (0.55 + 0.45 * max(dot(n, lt.L), 0.0) * lt.vis) * mix(1.0, ao, 0.5); }
  if (F.opts.x > 0.0) { alpha = F.opts.x; }
  if (F.eye.w < 0.5) { lit += lampGlow(-V, length(F.eye.xyz - in.wp)); }
  var col = highlight(finish(lit, in.wp), in.oid);
  // Choosing where to start walking: a soft-edged translucent disc on the surface under the cursor.
  if (F.marker.w > 0.0) {
    let d = length(in.wp - F.marker.xyz) / F.marker.w;
    col = mix(col, vec3f(0.95, 0.69, 0.0), (1.0 - smoothstep(0.5, 1.0, d)) * 0.55);
  }
  return vec4f(col, alpha);
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
  if (B.flags.y > 0.5) {
    // In the Rendered view, edges thin out further off, where they would crowd together.
    var far = 1.0;
    if (F.viewport.w > 0.5 && F.viewport.w < 1.5 && F.eye.w < 0.5) {
      let mpp = dot(in.wp - F.eye.xyz, F.viewDir.xyz) * 2.0 * F.camRight.w / F.viewport.y * F.misc.y;   // metres per pixel
      far = mix(1.0, 0.3, smoothstep(0.08, 0.4, mpp));
    }
    return vec4f(F.edge.rgb, F.edge.a * fade * far);
  }
  return vec4f(mix(horizon(), B.color.rgb * min(F.sunColor.w * 1.5, 1.0), fade), 1.0);   // dimmer at dusk and night
}

// Result lines, each vertex with its own colour; not picked, and not faded by the haze.
struct ResultOut { @builtin(position) pos: vec4f, @location(0) col: vec3f };
@vertex fn vsResultLine(@location(0) p: vec3f, @location(2) col: vec4f) -> ResultOut {
  let c = F.viewProj * vec4f(p, 1.0);
  return ResultOut(vec4f(c.xy, min(c.z * LINE_PULL, c.w), c.w), col.rgb);
}
@fragment fn fsResultLine(in: ResultOut) -> @location(0) vec4f { return vec4f(in.col, 1.0); }

// The sun path diagram, on the sky: directions, so it stays with the sky however the camera moves.
// Drawn straight after the background, so everything in the model is in front of it.
struct SkyLineOut { @builtin(position) pos: vec4f, @location(0) col: vec4f, @location(1) e: f32, @location(2) w: vec2f };
@vertex fn vsSkyLine(@builtin(vertex_index) i: u32, @location(0) a: vec3f, @location(1) b: vec3f, @location(2) col: vec4f, @location(3) w: vec2f) -> SkyLineOut {
  var ca = F.viewProj * vec4f(a, 0.0);
  var cb = F.viewProj * vec4f(b, 0.0);
  const FRONT = 0.02;
  if (ca.w < FRONT && cb.w < FRONT) { return SkyLineOut(vec4f(0.0), col, 0.0, w); }
  if (ca.w < FRONT) { ca = mix(ca, cb, (FRONT - ca.w) / (cb.w - ca.w)); }
  if (cb.w < FRONT) { cb = mix(cb, ca, (FRONT - cb.w) / (ca.w - cb.w)); }
  let along = (cb.xy / cb.w - ca.xy / ca.w) * F.viewport.xy;
  let d = along / max(length(along), 1e-6);
  let side = f32(i & 2u) - 1.0;
  let c = select(ca, cb, (i & 1u) == 1u);
  return SkyLineOut(vec4f(c.xy + vec2f(-d.y, d.x) * side * w.y * 2.0 / F.viewport.xy * c.w, 0.0, c.w), col, side * w.y, w);
}
// A dark edge keeps it readable on any sky. w: half widths of the line and of it with its edge (px).
@fragment fn fsSkyLine(in: SkyLineOut) -> @location(0) vec4f {
  let d = abs(in.e);
  let core = 1.0 - smoothstep(in.w.x - 0.5, in.w.x + 0.5, d);
  let edge = (1.0 - smoothstep(in.w.y - 1.0, in.w.y, d)) * 0.35;
  return vec4f(mix(vec3f(0.04, 0.06, 0.1), in.col.rgb, core), max(core, edge) * in.col.a);
}
@group(1) @binding(7) var skyAtlas: texture_2d<f32>;
@group(1) @binding(8) var skySampler: sampler;
struct SkySpriteOut { @builtin(position) pos: vec4f, @location(0) uv: vec2f };
@vertex fn vsSkySprite(@builtin(vertex_index) i: u32, @location(0) dir: vec3f, @location(1) box: vec4f, @location(2) uv: vec4f) -> SkySpriteOut {
  let c = F.viewProj * vec4f(dir, 0.0);
  let at = vec2f(f32(i & 1u), f32((i >> 1u) & 1u));
  let t = mix(uv.xy, uv.zw, at);
  if (c.w < 0.02) { return SkySpriteOut(vec4f(0.0), t); }
  let px = box.xy + (vec2f(at.x, 1.0 - at.y) - 0.5) * box.zw;   // box: centre (from the point, y up) and size, in pixels
  return SkySpriteOut(vec4f(c.xy / c.w + px * 2.0 / F.viewport.xy, 0.0, 1.0), t);
}
@fragment fn fsSkySprite(in: SkySpriteOut) -> @location(0) vec4f { return textureSample(skyAtlas, skySampler, in.uv); }

// Result maps: each vertex holds a value, looked up in the map's colour table for each pixel, so that
// the edges of grouped scales stay sharp. A huge value means there is none, and hides the triangle.
struct MapUniform { z: f32, lo: f32, hi: f32, index: f32 };
@group(1) @binding(5) var<uniform> MU: MapUniform;
@group(1) @binding(6) var mapRamp: texture_2d<f32>;
struct MapOut { @builtin(position) pos: vec4f, @location(0) v: f32, @location(1) wp: vec3f };
@vertex fn vsMap(@location(0) p: vec3f, @location(2) v: f32) -> MapOut {
  let q = p + vec3f(0.0, 0.0, MU.z);
  return MapOut(F.viewProj * vec4f(q, 1.0), v, q);
}
@fragment fn fsMap(in: MapOut) -> @location(0) vec4f {
  if (abs(in.v) > 1e20) { discard; }
  let n = i32(textureDimensions(mapRamp).x);
  let i = clamp(i32(floor((in.v - MU.lo) / (MU.hi - MU.lo) * f32(n))), 0, n - 1);
  return vec4f(textureLoad(mapRamp, vec2i(i, 0), 0).rgb, 1.0);
}
@fragment fn fsMapPick(in: MapOut) -> @location(0) vec4f {
  if (abs(in.v) > 1e20) { discard; }
  return vec4f(in.wp, -MU.index - 1.0);
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
  size: vec4f,    // width, height of the window (and of the prepass)
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

// The prepass (window sized) under a texel of the smaller textures these passes draw into.
fn prepass(p: vec2i) -> vec4f { return textureLoad(gbuf, min(p * ${AO_DIV} + vec2i(1), vec2i(A.size.xy) - 1), 0); }

@fragment fn fsAO(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  let g = prepass(vec2i(pos.xy));
  if (g.w <= 0.0) { return vec4f(1.0); }
  let n = g.xyz;
  let P = worldPos(pos.xy * ${AO_DIV}.0, g.w);
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
  let g = prepass(p);
  if (g.w <= 0.0) { return vec4f(1.0); }
  let lim = vec2i(textureDimensions(aoIn)) - 1;
  var sum = 0.0;
  var wsum = 0.0;
  for (var y = -2; y <= 2; y++) {
    for (var x = -2; x <= 2; x++) {
      let q = clamp(p + vec2i(x, y), vec2i(0), lim);
      let gq = prepass(q);
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

// Sun exposure (exposure.js): for one view from the sun (a depth map drawn with SHADOW_SHADER),
// adds to each point how much it sees the sun, in sixteenths: the share of the four texels round it
// that see the sun, blended by where it falls between them. A point facing away from the sun, or
// outside the part of the map that is its tile, gets nothing.
const EXPOSURE_SIZE = 4096, EXPOSURE_MARGIN = 4; // texels round a tile, so the four stay on the map
const EXPOSURE_FULL = 16; // what one view adds to a point in full sun
const EXPOSURE_SHADER = /* wgsl */ `
struct ExposureUniform { m: mat4x4f, sun: vec4f, p: vec4f };  // p: texel size (model units), depth bias, points, margin (uv)
@group(0) @binding(0) var<uniform> E: ExposureUniform;
@group(0) @binding(1) var<storage, read> pts: array<vec4f>;
@group(0) @binding(2) var<storage, read> nrm: array<vec4f>;
@group(0) @binding(3) var<storage, read_write> lit: array<u32>;
@group(0) @binding(4) var depthMap: texture_depth_2d;
@group(0) @binding(5) var cmp: sampler_comparison;
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) g: vec3u) {
  let i = g.x;
  if (i >= u32(E.p.z)) { return; }
  let n = nrm[i].xyz;
  let c = dot(n, E.sun.xyz);
  if (c <= 0.0) { return; }
  // Off the surface by a texel or two (more at a grazing angle), clear of its own depth.
  let p = pts[i].xyz + n * E.p.x * (0.6 + 1.5 * sqrt(max(1.0 - c * c, 0.0)));
  let s = E.m * vec4f(p, 1.0);
  let uv = vec2f(s.x * 0.5 + 0.5, 0.5 - s.y * 0.5);
  if (any(uv < vec2f(E.p.w)) || any(uv >= vec2f(1.0 - E.p.w))) { return; }
  lit[i] += u32(round(textureSampleCompareLevel(depthMap, cmp, uv, s.z + E.p.y) * ${EXPOSURE_FULL}.0));
}
`;

const FRAME_SIZE = 1280;
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

// The parts of the sun path diagram: colour, half width of a line, and label size and lift, in CSS pixels.
const SUN_PATH_STYLE = {
  month: { rgba: [1, 1, 1, 0.85], width: 0.7, font: 11, lift: 0 },
  hour: { rgba: [1, 1, 1, 0.5], width: 0.5, font: 11, lift: 9 },
  horizon: { rgba: [1, 1, 1, 0.85], width: 0.7, font: 14, lift: 18 },
  day: { rgba: [1, 0.784, 0.2, 1], width: 1.4, font: 13, lift: 14 },
};

class Renderer {
  static async create(canvas) {
    if (!navigator.gpu) throw new Error('NO_WEBGPU');
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) throw new Error('NO_ADAPTER');
    const lim = adapter.limits;
    const device = await adapter.requestDevice({ requiredLimits: { maxBufferSize: lim.maxBufferSize } });
    const r = new Renderer(canvas, device);
    r.adapterInfo = adapter.info || null; // for the developer diagnostics
    return r;
  }

  constructor(canvas, device) {
    this.canvas = canvas;
    this.device = device;
    this.ctx = canvas.getContext('webgpu');
    this.format = navigator.gpu.getPreferredCanvasFormat();
    this.ctx.configure({ device, format: this.format, alphaMode: 'opaque' });
    this.batches = [];
    this.stats = { triangles: 0, vertices: 0, bytes: 0 }; // the model on the GPU, for the developer diagnostics
    this.cells = new Float32Array(0);
    this.cellVis = new Uint8Array(0);
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
      { binding: 5, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'depth', viewDimension: '2d-array' } },
      { binding: 6, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'unfilterable-float' } },
    ] });
    // Stands in for the AO prepass texture in passes that draw into it or never read it.
    this.noGbuf = device.createTexture({ size: [1, 1], format: 'rgba32float', usage: GPUTextureUsage.TEXTURE_BINDING });
    this.objFlagsBuf = device.createBuffer({ size: 4, usage: U.STORAGE | U.COPY_DST });
    this.batchLayout = device.createBindGroupLayout({ entries: [{ binding: 0, visibility: VF, buffer: { hasDynamicOffset: true, minBindingSize: 48 } }] });

    // Shadow maps: one depth layer per cascade, rendered from the sun.
    this.shadowTex = device.createTexture({ size: [SHADOW_SIZE, SHADOW_SIZE, CASCADES], format: DEPTH,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING });
    this.shadowLayers = [...Array(CASCADES).keys()].map((c) => this.shadowTex.createView({ dimension: '2d', baseArrayLayer: c, arrayLayerCount: 1 }));
    this.shadowView = this.shadowTex.createView({ dimension: '2d-array' });
    this.shadowCmp = device.createSampler({ compare: 'greater-equal', magFilter: 'linear', minFilter: 'linear' });
    // Lamp shadow maps: one layer per spot light, six per point light (see lampShadowPlan). Each
    // layer is kept until its lamp moves or what is shown changes (lampShadowKeys).
    this.lampShadowTex = device.createTexture({ size: [LAMP_SHADOW_SIZE, LAMP_SHADOW_SIZE, LAMP_SHADOW_LAYERS], format: DEPTH,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING });
    this.lampShadowLayers = [...Array(LAMP_SHADOW_LAYERS).keys()].map((c) => this.lampShadowTex.createView({ dimension: '2d', baseArrayLayer: c, arrayLayerCount: 1 }));
    this.lampShadowView = this.lampShadowTex.createView({ dimension: '2d-array' });
    this.lampShadowBuf = device.createBuffer({ size: LAMP_SHADOW_LAYERS * 256, usage: U.UNIFORM | U.COPY_DST });
    this.lampShadowKeys = [];
    this.geomVersion = 0;
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

    this.mapLayout = device.createBindGroupLayout({ entries: [
      { binding: 5, visibility: VF, buffer: {} },
      { binding: 6, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'unfilterable-float' } },
    ] });
    const mapPipes = device.createPipelineLayout({ bindGroupLayouts: [this.frameLayout, this.mapLayout] });
    const VAL = { arrayStride: 4, attributes: [{ shaderLocation: 2, offset: 0, format: 'float32' }] };
    this.skyLayout = device.createBindGroupLayout({ entries: [
      { binding: 7, visibility: GPUShaderStage.FRAGMENT, texture: {} },
      { binding: 8, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
    ] });
    this.skySampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear' });
    const skyPipes = device.createPipelineLayout({ bindGroupLayouts: [this.frameLayout, this.skyLayout] });
    const SKY_LINE = { arrayStride: 48, stepMode: 'instance', attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }, { shaderLocation: 1, offset: 12, format: 'float32x3' },
      { shaderLocation: 2, offset: 24, format: 'float32x4' }, { shaderLocation: 3, offset: 40, format: 'float32x2' }] };
    const SKY_SPRITE = { arrayStride: 44, stepMode: 'instance', attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }, { shaderLocation: 1, offset: 12, format: 'float32x4' },
      { shaderLocation: 2, offset: 28, format: 'float32x4' }] };
    const premultiplied = { color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' }, alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' } };
    this.pipes = {
      skyLine: mk('vsSkyLine', 'fsSkyLine', [SKY_LINE], { topology: 'triangle-strip', compare: 'always', write: false, blend, layout: frameOnly }),
      skySprite: mk('vsSkySprite', 'fsSkySprite', [SKY_SPRITE], { topology: 'triangle-strip', compare: 'always', write: false, blend: premultiplied, layout: skyPipes }),
      map: mk('vsMap', 'fsMap', [POS, VAL], { layout: mapPipes }),
      mapX: mk('vsMap', 'fsMap', [POS, VAL], { layout: mapPipes, compare: 'always', write: false }),
      mapPick: mk('vsMap', 'fsMapPick', [POS, VAL], { format: 'rgba32float', samples: 1, layout: mapPipes }),
      bg: mk('vsBg', 'fsBg', [], { write: false, compare: 'always', layout: frameOnly }),
      mesh: mk('vsMesh', 'fsMesh', [POS, NRM, OID], { bias: true }),
      meshVC: mk('vsMeshVC', 'fsMesh', [POS, NRM, COL, OID], { bias: true }),
      meshT: mk('vsMesh', 'fsMesh', [POS, NRM, OID], { bias: true, blend, write: false }),
      meshVCT: mk('vsMeshVC', 'fsMesh', [POS, NRM, COL, OID], { bias: true, blend, write: false }),
      line: mk('vsLine', 'fsLine', [POS, OID], { topology: 'line-list', compare: 'greater-equal', blend }),
      lineX: mk('vsLine', 'fsLine', [POS, OID], { topology: 'line-list', compare: 'always', blend, write: false }),
      resultLine: mk('vsResultLine', 'fsResultLine', [POS, COL], { topology: 'line-list', compare: 'greater-equal', layout: frameOnly }),
      resultLineX: mk('vsResultLine', 'fsResultLine', [POS, COL], { topology: 'line-list', compare: 'always', write: false, layout: frameOnly }),
      point: mk('vsPoint', 'fsPoint', [POS_INST, OID_INST], { topology: 'triangle-strip', compare: 'greater-equal' }),
      pointX: mk('vsPoint', 'fsPoint', [POS_INST, OID_INST], { topology: 'triangle-strip', compare: 'always', write: false }),
      pick: mk('vsPick', 'fsPick', [POS, OID], { format: 'rgba32float', samples: 1, layout: frameOnly }),
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
    // The soft edges read the prepass, so it stays the window's size; the occlusion itself need not.
    const ao = [Math.ceil(w / AO_DIV), Math.ceil(h / AO_DIV)];
    this.aoRawTex = dev.createTexture({ size: ao, format: 'r8unorm', usage: RA | TB });
    this.aoTex = dev.createTexture({ size: ao, format: 'r8unorm', usage: RA | TB | GPUTextureUsage.COPY_SRC });

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
      const entries = (buffer, gbuf) => [{ binding: 0, resource: { buffer } }, { binding: 1, resource: this.shadowView },
        { binding: 2, resource: this.shadowCmp }, { binding: 3, resource: this.aoTex.createView() }, { binding: 4, resource: { buffer: this.objFlagsBuf } },
        { binding: 5, resource: this.lampShadowView }, { binding: 6, resource: gbuf.createView() }];
      this.frameBG = dev.createBindGroup({ layout: this.frameLayout, entries: entries(this.frameBuf, this.gbufTex) });
      this.gbufFrameBG = dev.createBindGroup({ layout: this.frameLayout, entries: entries(this.frameBuf, this.noGbuf) }); // draws into gbufTex
      this.pickFrameBG = dev.createBindGroup({ layout: this.frameLayout, entries: entries(this.pickFrameBuf, this.noGbuf) });
    }
    this.shadowBG = dev.createBindGroup({ layout: this.shadowLayout, entries: [
      { binding: 0, resource: { buffer: this.shadowBuf, size: 64 } }, { binding: 1, resource: { buffer: this.objFlagsBuf } }] });
    this.lampShadowBG = dev.createBindGroup({ layout: this.shadowLayout, entries: [
      { binding: 0, resource: { buffer: this.lampShadowBuf, size: 64 } }, { binding: 1, resource: { buffer: this.objFlagsBuf } }] });
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
    this.geomVersion++;   // hidden objects stop casting lamp shadows
    this.dirty = true;
  }

  // Normal/depth prepass, SSAO, then blur into aoTex (read by the main pass). Like the sun's
  // shadow maps, skipped when the view, the window size and the geometry are as last time.
  renderAO(enc, s, geom) {
    const key = `${geom}|${Array.prototype.join.call(s.viewProj)}|${this.width}x${this.height}|${s.mode}|${s.aoMaxRadius}`;
    if (this.aoKey === key) return;
    this.aoKey = key;
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
    pass.setBindGroup(0, this.gbufFrameBG);
    this.cull(s.viewProj);
    for (const b of this.batches) {
      if (!b.visible || b.kind !== 'mesh' || (s.mode === 1 && b.transparent) || !this.seen(b)) continue;
      pass.setBindGroup(1, this.batchBG, [b.offset]);
      pass.setVertexBuffer(0, b.gpu.pos); pass.setVertexBuffer(1, b.gpu.nrm); pass.setVertexBuffer(2, b.gpu.oid);
      pass.setIndexBuffer(b.gpu.idx, 'uint32');
      this.drawCells(pass, b);
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

  // Decides which cells of the model (see Batcher.finish) the view m can see, for the draws that
  // follow. depth: test against the near and far planes too (not for the main view: edges are pulled
  // towards the eye, and nothing much lies only beyond those planes).
  cull(m, depth = false) {
    const box = this.cells, vis = this.cellVis, n = depth ? 6 : 4;
    // Planes from the matrix's rows: -w <= x <= w, -w <= y <= w, 0 <= z <= w.
    const P = [m[3] + m[0], m[7] + m[4], m[11] + m[8], m[15] + m[12], m[3] - m[0], m[7] - m[4], m[11] - m[8], m[15] - m[12],
      m[3] + m[1], m[7] + m[5], m[11] + m[9], m[15] + m[13], m[3] - m[1], m[7] - m[5], m[11] - m[9], m[15] - m[13],
      m[2], m[6], m[10], m[14], m[3] - m[2], m[7] - m[6], m[11] - m[10], m[15] - m[14]];
    for (let c = 0, b = 0; c < vis.length; c++, b += 6) {
      let inside = 1;
      for (let i = 0, p = 0; i < n; i++, p += 4) {
        const x = P[p] > 0 ? box[b + 3] : box[b], y = P[p + 1] > 0 ? box[b + 4] : box[b + 1], z = P[p + 2] > 0 ? box[b + 5] : box[b + 2];
        if (P[p] * x + P[p + 1] * y + P[p + 2] * z + P[p + 3] < 0) { inside = 0; break; }
      }
      vis[c] = inside;
    }
  }

  // Does the last cull() leave anything of this batch to draw?
  seen(b) {
    const r = b.ranges, vis = this.cellVis;
    for (let i = 2; i < r.length; i += 3) if (vis[r[i]]) return true;
    return false;
  }

  // Draws what the last cull() left of a batch, as few draws as neighbouring cells allow.
  drawCells(pass, b) {
    const r = b.ranges, vis = this.cellVis, indexed = b.kind === 'mesh';
    let first = 0, n = 0;
    for (let i = 0; i < r.length; i += 3) {
      if (!vis[r[i + 2]]) continue;
      if (n && first + n === r[i]) { n += r[i + 1]; continue; }
      if (n) { if (indexed) pass.drawIndexed(n, 1, first); else pass.draw(n, 1, first); }
      first = r[i]; n = r[i + 1];
    }
    if (n) { if (indexed) pass.drawIndexed(n, 1, first); else pass.draw(n, 1, first); }
  }

  clearModel() {
    for (const b of this.batches) for (const k of ['pos', 'nrm', 'col', 'idx', 'oid']) b.gpu[k]?.destroy();
    this.batchBuf?.destroy();
    this.batches = [];
  }

  // batches: output of extractModel()
  setModel(batches) {
    this.clearModel();
    this.geomVersion++;
    this.cells = batches.cells;
    this.cellVis = new Uint8Array(batches.cells.length / 6);
    const dev = this.device, U = GPUBufferUsage;
    const stats = (this.stats = { triangles: 0, vertices: 0, bytes: 0 });
    const upload = (arr, usage) => {
      const size = Math.ceil(arr.byteLength / 4) * 4;
      stats.bytes += size;
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
      stats.vertices += b.position.length / 3;
      if (b.kind === 'mesh') stats.triangles += b.index.length / 3;
      if (b.kind === 'mesh') {
        gpu.nrm = upload(b.normal, U.VERTEX);
        gpu.idx = upload(b.index, U.INDEX);
        if (b.vc) gpu.col = upload(b.vcolor, U.VERTEX);
      }
      // Keep only metadata on the CPU side; the vertex data now lives on the GPU.
      const { position, normal, index, vcolor, objectId, ...meta } = b;
      this.batches.push({ ...meta, gpu, offset: i * BATCH_STRIDE, visible: true });
    });
    const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
    for (const b of this.batches) for (let k = 0; k < 3; k++) { mn[k] = Math.min(mn[k], b.min[k]); mx[k] = Math.max(mx[k], b.max[k]); }
    this.noiseOrigin = isFinite(mn[0]) ? mn.map((v, k) => (v + mx[k]) / 2) : [0, 0, 0];
    this.setMaterialRules(this.specialsOn ?? true, this.layerMaterials, this.layerColours, this.layerSpecials);
  }

  // Resolve each batch's colour and material from the per-layer settings, then upload. They
  // apply only to batches whose colour or material comes from that layer (see resolveLook in
  // extract.js), as in Rhino. specialsOn: the render mode menu's Magic item.
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
      // Casts a shadow unless over 40% transparent. Water and Glass go by the file's material: their
      // alpha above is 1 unless set in the viewer, however clear the file makes them.
      b.castsShadow = (type === MAT_WATER || type === MAT_GLASS ? (b.mat ? b.mat[3] : 1) : alpha) >= 0.6;
      ub.set([...rgb, alpha], base + 4);
      ub.set([b.vc ? 1 : 0, b.kind === 'edge' ? 1 : 0, type, o ? o.gloss : 0], base + 8);
    });
    if (this.batches.length) this.device.queue.writeBuffer(this.batchBuf, 0, ub);
    this.geomVersion++;   // transparency decides what casts shadows and what ambient occlusion sees
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
    const cl = s.clouds;
    f.set(cl ? [cl.cover, cl.drift[0] / 1000, cl.drift[1] / 1000, cl.haze] : [0, 0, 0, 1], 64);
    f.set([s.time || 0, s.metresPerUnit || 1, s.hazeStart || 0, s.hazeDensity || 0], 68);
    f.set([0, 0.25, 0.55, 1.0], 72); // highlight colour for selected objects
    const cam = s.cam;
    f.set(cam ? [...cam.right, Math.tan(cam.fov / 2)] : [1, 0, 0, 1], 76);
    f.set(cam ? [...cam.up, cam.aspect] : [0, 0, 1, 1], 80);
    const sky = s.backdrop, rad = Math.PI / 180;
    f.set(sky ? [...sky.glow, sky.night] : [0, 0, 0, 0], 84);
    f.set(sky ? [sky.lat * rad, sky.lst, sky.north * rad, s.plainBg ? 1 : 0] : [0, 0, 0, s.plainBg ? 1 : 0], 88);
    f.set(sky ? [...sky.moonDir, sky.moonLit] : [0, 0, -1, 0], 92);
    f.set(sky ? [...sky.sunDir, 1] : [0, 0, 1, 0], 96);
    // The noise is worked out from the model's centre, snapped to a kilometre so it stays put:
    // far from the file's origin (map coordinates), float precision would break up fine grain.
    const step = 1000 / (s.metresPerUnit || 1), o = this.noiseOrigin || [0, 0, 0];
    f.set([...o.map((v) => Math.round(v / step) * step), s.mode === 1 && s.specials ? 1 : 0], 100);
    f.set(s.walkMarker ? [...s.walkMarker.p, s.walkMarker.r] : [0, 0, 0, 0], 104);
    if (sh) sh.mats.forEach((m, c) => f.set(m, 108 + c * 16));
    const lamps = (s.lamps || []).slice(0, MAX_LAMPS), L0 = 108 + CASCADES * 16;
    const plan = s.xray ? [] : lampShadowPlan(lamps), near = LAMP_NEAR / (s.metresPerUnit || 1);
    f.fill(0, L0, L0 + 4 + MAX_LAMPS * 16);
    f[L0] = lamps.length;
    lamps.forEach((l, i) => {
      const o = L0 + 4 + i * 16, cos = (deg) => Math.cos((deg * Math.PI) / 180), sp = plan[i];
      f.set([...l.p, l.range], o);
      f.set([...l.rgb.map((v) => v * l.power), l.dir ? cos(l.inner) : 1], o + 4);
      f.set(l.dir ? [...l.dir, cos(l.outer)] : [0, 0, -1, -2], o + 8);
      f.set(sp ? [sp.layer, near, sp.t, sp.dirs.length] : [-1, 0, 1, 0], o + 12);
    });
    this.device.queue.writeBuffer(buf, 0, f);
  }

  // Render each cascade's depth map from the sun, skipping any whose matrix and geometry are as last
  // time. The clouds can drift without any being redrawn, and walking usually redraws only the
  // nearest, since the matrices snap to whole texels and the far ones have large texels.
  renderShadows(enc, sh, geom) {
    const keys = sh.mats.map((m) => `${geom}|${Array.prototype.join.call(m)}`), old = this.shadowKeys || [];
    if (keys.every((k, c) => k === old[c])) return;
    this.shadowKeys = keys;
    const data = new Float32Array(CASCADES * 64);
    sh.mats.forEach((m, c) => data.set(m, c * 64));
    this.device.queue.writeBuffer(this.shadowBuf, 0, data);
    for (let c = 0; c < CASCADES; c++) {
      if (keys[c] === old[c]) continue;
      this.cull(sh.mats[c]);
      const pass = enc.beginRenderPass({ colorAttachments: [],
        depthStencilAttachment: { view: this.shadowLayers[c], depthClearValue: 0, depthLoadOp: 'clear', depthStoreOp: 'store' } });
      pass.setPipeline(this.shadowPipe);
      pass.setBindGroup(0, this.shadowBG, [c * 256]);
      for (const b of this.batches) {
        if (!b.visible || b.kind !== 'mesh' || !b.castsShadow || !this.seen(b)) continue;
        pass.setVertexBuffer(0, b.gpu.pos); pass.setVertexBuffer(1, b.gpu.oid);
        pass.setIndexBuffer(b.gpu.idx, 'uint32');
        this.drawCells(pass, b);
      }
      pass.end();
    }
  }

  // Depth maps from the lamps that have shadows. A layer is redrawn only when its lamp has moved,
  // or the shown geometry has changed, since it was last drawn; only meshes within the lamp's
  // range are drawn into it.
  renderLampShadows(enc, s) {
    const lamps = (s.lamps || []).slice(0, MAX_LAMPS);
    if (s.xray || !lamps.length) return;
    const mpu = s.metresPerUnit || 1, near = LAMP_NEAR / mpu;
    const casters = this.batches.filter((b) => b.visible && b.kind === 'mesh' && b.castsShadow);
    let geom = this.geomVersion;
    for (const b of casters) geom = (geom * 31 + b.offset + 1) | 0;
    const plan = lampShadowPlan(lamps), jobs = [];
    plan.forEach((sp, i) => {
      if (!sp) return;
      const l = lamps[i], R = l.range / mpu;
      sp.dirs.forEach((d, k) => {
        const layer = sp.layer + k, key = `${geom}|${l.p}|${d}|${sp.t}|${R}`;
        if (this.lampShadowKeys[layer] === key) return;
        this.lampShadowKeys[layer] = key;
        jobs.push({ layer, m: lampShadowMatrix(l.p, d, sp.t, near), p: l.p, R });
      });
    });
    if (!jobs.length) return;
    const data = new Float32Array(LAMP_SHADOW_LAYERS * 64);
    jobs.forEach((j) => data.set(j.m, j.layer * 64));
    this.device.queue.writeBuffer(this.lampShadowBuf, 0, data);
    for (const j of jobs) {
      const pass = enc.beginRenderPass({ colorAttachments: [],
        depthStencilAttachment: { view: this.lampShadowLayers[j.layer], depthClearValue: 0, depthLoadOp: 'clear', depthStoreOp: 'store' } });
      pass.setPipeline(this.shadowPipe);
      pass.setBindGroup(0, this.lampShadowBG, [j.layer * 256]);
      const [x, y, z] = j.p;
      this.cull(j.m);
      for (const b of casters) {
        if (b.min[0] > x + j.R || b.max[0] < x - j.R || b.min[1] > y + j.R || b.max[1] < y - j.R || b.min[2] > z + j.R || b.max[2] < z - j.R || !this.seen(b)) continue;
        pass.setVertexBuffer(0, b.gpu.pos); pass.setVertexBuffer(1, b.gpu.oid);
        pass.setIndexBuffer(b.gpu.idx, 'uint32');
        this.drawCells(pass, b);
      }
      pass.end();
    }
  }

  // s: { viewProj, eye, viewDir, light, ortho, mode, xray, showEdges, showCurves, showPoints,
  //      sun?: { dir, rgb, sky }, shadows?: output of shadowCascades(),
  //      clouds?: { cover, drift: [x, y] (m), haze } }
  draw(s) {
    if (!this.width) return;
    s.aoActive = !!(s.ao && s.cam && !s.xray);
    this.writeFrame(this.frameBuf, s.viewProj, s);
    const enc = this.device.createCommandEncoder();
    // What is shown: the geometry version and which batches are visible.
    let geom = this.geomVersion;
    for (const b of this.batches) if (b.visible) geom = (geom * 31 + b.offset + 1) | 0;
    if (s.shadows) this.renderShadows(enc, s.shadows, geom);
    this.renderLampShadows(enc, s);
    if (s.aoActive) this.renderAO(enc, s, geom);
    else this.aoKey = null;
    const pass = enc.beginRenderPass({
      colorAttachments: [{ view: this.msaaTex.createView(), resolveTarget: this.ctx.getCurrentTexture().createView(),
        clearValue: { r: 0, g: 0, b: 0, a: 1 }, loadOp: 'clear', storeOp: 'discard' }],
      depthStencilAttachment: { view: this.depthTex.createView(), depthClearValue: 0, depthLoadOp: 'clear', depthStoreOp: 'discard' },
    });
    const P = this.pipes;
    pass.setBindGroup(0, this.frameBG);
    pass.setPipeline(P.bg);
    pass.draw(3);
    if (s.sunPath && this.sunPath) this.drawSunPath(pass, s);
    this.cull(s.viewProj);

    const vis = this.batches.filter((b) => b.visible);
    const meshes = vis.filter((b) => b.kind === 'mesh');
    const transparentMode = (b) => s.xray || (s.mode === 1 && b.transparent);
    const drawMesh = (b) => {
      if (!this.seen(b)) return;
      pass.setPipeline(transparentMode(b) ? (b.vc ? P.meshVCT : P.meshT) : b.vc ? P.meshVC : P.mesh);
      pass.setBindGroup(1, this.batchBG, [b.offset]);
      pass.setVertexBuffer(0, b.gpu.pos); pass.setVertexBuffer(1, b.gpu.nrm);
      if (b.vc) pass.setVertexBuffer(2, b.gpu.col);
      pass.setVertexBuffer(b.vc ? 3 : 2, b.gpu.oid);
      pass.setIndexBuffer(b.gpu.idx, 'uint32');
      this.drawCells(pass, b);
    };
    for (const b of meshes) if (!transparentMode(b)) drawMesh(b);
    for (const b of vis) {
      // Edges on water and foliage are noise, so they are hidden when those materials apply.
      const softEdge = b.kind === 'edge' && ((s.mode === 1 && (b.effCls === MAT_WATER || b.effCls === MAT_VEGETATION)) || (s.mode === 2 && b.effCls === MAT_WATER));
      if ((b.kind === 'edge' && s.showEdges && !softEdge) || (b.kind === 'line' && s.showCurves)) {
        if (!this.seen(b)) continue;
        pass.setPipeline(s.xray ? P.lineX : P.line);
        pass.setBindGroup(1, this.batchBG, [b.offset]);
        pass.setVertexBuffer(0, b.gpu.pos); pass.setVertexBuffer(1, b.gpu.oid);
        this.drawCells(pass, b);
      } else if (b.kind === 'point' && s.showPoints) {
        pass.setPipeline(s.xray ? P.pointX : P.point);
        pass.setBindGroup(1, this.batchBG, [b.offset]);
        pass.setVertexBuffer(0, b.gpu.pos); pass.setVertexBuffer(1, b.gpu.oid);
        pass.draw(4, b.count);
      }
    }
    if (s.resultMaps?.length) {
      pass.setPipeline(s.xray ? P.mapX : P.map);
      this.drawResultMaps(pass, s);
    }
    if (s.exposureMap && this.exposureMap) {
      pass.setPipeline(s.xray ? P.mapX : P.map);
      this.drawMap(pass, this.exposureMap, 0);
    }
    if (this.resultLines && s.resultRanges?.length) {
      pass.setPipeline(s.xray ? P.resultLineX : P.resultLine);
      pass.setVertexBuffer(0, this.resultLines.pos); pass.setVertexBuffer(1, this.resultLines.col);
      for (const r of s.resultRanges) pass.draw(r.count, 1, r.first);
    }
    for (const b of meshes) if (transparentMode(b)) drawMesh(b);
    pass.end();
    this.device.queue.submit([enc.finish()]);
  }

  // The sun path diagram to draw (sunPathDiagram), or null. scale: device pixels per CSS pixel. Each
  // frame's s.sunPath says whether it is shown, and s.sunPathMark where the sun is, if it is up.
  setSunPath(d, scale) {
    const old = this.sunPath;
    old?.lines.destroy(); old?.sprites.destroy(); old?.atlas.destroy();
    this.sunPath = null;
    if (!d) return;
    const dev = this.device, make = (arr) => {
      const buf = dev.createBuffer({ size: arr.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
      dev.queue.writeBuffer(buf, 0, arr);
      return buf;
    };
    const lines = new Float32Array(d.segments.length * 12);
    d.segments.forEach(({ a, b, kind }, i) => {
      const { rgba, width } = SUN_PATH_STYLE[kind], w = width * scale;
      lines.set([...a, ...b, ...rgba, w, w + 1.5 * scale], i * 12);
    });
    // The labels go on one texture, after the ring that marks the sun.
    const canvas = new OffscreenCanvas(512 * scale, 256 * scale), g = canvas.getContext('2d');
    const pad = 3 * scale, rowH = Math.ceil(20 * scale), mark = rowH;
    const sprites = new Float32Array((d.labels.length + 1) * 11);
    sprites.set([0, 0, 1, 0, 0, mark, mark, 0, 0, mark / canvas.width, mark / canvas.height], 0);
    g.beginPath(); g.arc(mark / 2, mark / 2, 6 * scale, 0, 2 * Math.PI);
    g.fillStyle = 'rgba(255, 200, 51, 0.25)'; g.fill();
    g.lineWidth = 3.5 * scale; g.strokeStyle = 'rgba(10, 14, 20, 0.6)'; g.stroke();
    g.lineWidth = 2 * scale; g.strokeStyle = '#FFC833'; g.stroke();
    let x = mark, y = 0;
    g.textBaseline = 'middle'; g.lineJoin = 'round';
    d.labels.forEach(({ dir, text, kind }, i) => {
      const st = SUN_PATH_STYLE[kind];
      g.font = `${kind === 'hour' ? 500 : 700} ${st.font * scale}px system-ui, sans-serif`;
      const w = Math.ceil(g.measureText(text).width) + 2 * pad;
      if (x + w > canvas.width) { x = 0; y += rowH; }
      g.lineWidth = 3 * scale; g.strokeStyle = 'rgba(10, 14, 20, 0.7)';
      g.strokeText(text, x + pad, y + rowH / 2);
      g.fillStyle = `rgb(${st.rgba.slice(0, 3).map((v) => Math.round(v * 255)).join(' ')})`;
      g.fillText(text, x + pad, y + rowH / 2);
      sprites.set([...dir, 0, st.lift * scale, w, rowH, x / canvas.width, y / canvas.height, (x + w) / canvas.width, (y + rowH) / canvas.height], (i + 1) * 11);
      x += w;
    });
    const atlas = dev.createTexture({ size: [canvas.width, canvas.height], format: 'rgba8unorm', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT });
    dev.queue.copyExternalImageToTexture({ source: canvas }, { texture: atlas, premultipliedAlpha: true }, [canvas.width, canvas.height]);
    this.sunPath = { lines: make(lines), lineCount: d.segments.length, sprites: make(sprites), spriteCount: d.labels.length + 1, atlas,
      bg: dev.createBindGroup({ layout: this.skyLayout, entries: [{ binding: 7, resource: atlas.createView() }, { binding: 8, resource: this.skySampler }] }) };
  }

  drawSunPath(pass, s) {
    const d = this.sunPath, P = this.pipes;
    pass.setPipeline(P.skyLine);
    pass.setVertexBuffer(0, d.lines);
    pass.draw(4, d.lineCount);
    if (s.sunPathMark) this.device.queue.writeBuffer(d.sprites, 0, new Float32Array(s.sunPathMark));
    pass.setPipeline(P.skySprite);
    pass.setBindGroup(1, d.bg);
    pass.setVertexBuffer(0, d.sprites);
    pass.draw(4, s.sunPathMark ? d.spriteCount : d.spriteCount - 1, 0, s.sunPathMark ? 0 : 1);
  }

  // Result maps to draw: [{ pos: Float32Array, indices: Uint32Array }]. setMapResult gives one its
  // values and colour table, and each frame's s.resultMaps says which are shown, s.resultMapZ how
  // far they are moved up.
  setResultMaps(list) {
    for (const m of this.resultMaps || []) { m.pos.destroy(); m.idx.destroy(); m.val.destroy(); m.uni.destroy(); m.ramp?.destroy(); }
    this.resultMaps = list.map(({ pos, indices }, index) => this.makeMap(pos, indices, index));
  }

  makeMap(pos, indices, index) {
    const dev = this.device, U = GPUBufferUsage;
    const make = (arr, usage) => {
      const buf = dev.createBuffer({ size: arr.byteLength, usage: usage | U.COPY_DST });
      dev.queue.writeBuffer(buf, 0, arr);
      return buf;
    };
    return { index, count: indices.length, lo: 0, hi: 1, pos: make(pos, U.VERTEX), idx: make(indices, U.INDEX),
      val: dev.createBuffer({ size: pos.length / 3 * 4, usage: U.VERTEX | U.COPY_DST }), uni: dev.createBuffer({ size: 16, usage: U.UNIFORM | U.COPY_DST }) };
  }

  // values: Float32Array, one per vertex. ramp: { lo, hi, data } (ColourScales.ramp).
  setMapResult(i, values, ramp) { this.fillMap(this.resultMaps[i], values, ramp); }

  fillMap(m, values, ramp) {
    const dev = this.device, n = ramp.data.length / 4;
    dev.queue.writeBuffer(m.val, 0, values);
    Object.assign(m, { lo: ramp.lo, hi: ramp.hi });
    if (!m.ramp || m.ramp.width !== n) {
      m.ramp?.destroy();
      m.ramp = dev.createTexture({ size: [n, 1], format: 'rgba8unorm', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
      m.bg = dev.createBindGroup({ layout: this.mapLayout, entries: [{ binding: 5, resource: { buffer: m.uni } }, { binding: 6, resource: m.ramp.createView() }] });
    }
    dev.queue.writeTexture({ texture: m.ramp }, ramp.data, { bytesPerRow: n * 4 }, [n, 1]);
  }

  drawResultMaps(pass, s) {
    for (const i of s.resultMaps) this.drawMap(pass, this.resultMaps[i], s.resultMapZ || 0);
  }

  drawMap(pass, m, z) {
    if (!m?.bg) return;
    this.device.queue.writeBuffer(m.uni, 0, new Float32Array([z, m.lo, m.hi, m.index]));
    pass.setBindGroup(1, m.bg);
    pass.setVertexBuffer(0, m.pos); pass.setVertexBuffer(1, m.val);
    pass.setIndexBuffer(m.idx, 'uint32');
    pass.drawIndexed(m.count);
  }

  // The sun exposure results drawn while each frame's s.exposureMap is set: a surface
  // ({ shown, idx } from exposureSurface) with a value at each point, or null for none.
  setExposureMap(surface, values, ramp) {
    const old = this.exposureMap;
    if (old) for (const k of ['pos', 'idx', 'val', 'uni']) old[k].destroy();
    old?.ramp?.destroy();
    this.exposureMap = surface ? this.makeMap(surface.shown, surface.idx, -1) : null;
    if (surface) this.fillMap(this.exposureMap, values, ramp);
  }

  // Sun exposure: the points to test (exposureSurface's pos and nrm), kept on the GPU for
  // exposureRun. Null frees them.
  setExposurePoints(surface) {
    const X = this.exposure;
    if (X) for (const k of ['pts', 'nrm', 'lit', 'read']) X[k].destroy();
    this.exposure = null;
    if (!surface) return;
    const dev = this.device, U = GPUBufferUsage, n = surface.pos.length / 3;
    const vec4s = (a) => {
      const out = new Float32Array(n * 4);
      for (let i = 0; i < n; i++) out.set(a.subarray(i * 3, i * 3 + 3), i * 4);
      const buf = dev.createBuffer({ size: out.byteLength, usage: U.STORAGE | U.COPY_DST });
      dev.queue.writeBuffer(buf, 0, out);
      return buf;
    };
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < surface.pos.length; i++) { const k = i % 3; lo[k] = Math.min(lo[k], surface.pos[i]); hi[k] = Math.max(hi[k], surface.pos[i]); }
    if (!this.exposurePipe) {
      this.exposurePipe = dev.createComputePipeline({ layout: 'auto', compute: { module: dev.createShaderModule({ code: EXPOSURE_SHADER }), entryPoint: 'main' } });
      const size = Math.min(EXPOSURE_SIZE, dev.limits.maxTextureDimension2D);
      this.exposureDepth = dev.createTexture({ size: [size, size], format: DEPTH, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING });
      this.exposureUni = dev.createBuffer({ size: 256, usage: U.UNIFORM | U.COPY_DST });
      this.exposureShadowBuf = dev.createBuffer({ size: 256, usage: U.UNIFORM | U.COPY_DST });
      this.exposureCmp = dev.createSampler({ compare: 'greater-equal', magFilter: 'linear', minFilter: 'linear' });
    }
    this.exposure = { n, lo, hi, pts: vec4s(surface.pos), nrm: vec4s(surface.nrm),
      lit: dev.createBuffer({ size: n * 4, usage: U.STORAGE | U.COPY_SRC | U.COPY_DST }),
      read: dev.createBuffer({ size: n * 4, usage: U.MAP_READ | U.COPY_DST }) };
    this.exposure.bg = dev.createBindGroup({ layout: this.exposurePipe.getBindGroupLayout(0), entries: [
      { binding: 0, resource: { buffer: this.exposureUni } }, { binding: 1, resource: { buffer: this.exposure.pts } },
      { binding: 2, resource: { buffer: this.exposure.nrm } }, { binding: 3, resource: { buffer: this.exposure.lit } },
      { binding: 4, resource: this.exposureDepth.createView() }, { binding: 5, resource: this.exposureCmp }] });
  }

  // Tests the points from setExposurePoints against the shown model, from each of the sun
  // directions dirs (model space, towards the sun). texel: the size of a depth map texel to aim for
  // (model units): an area too big for 4 x 4 maps of it gets coarser ones. Resolves to how much
  // each point saw the sun, summed over dirs (Uint32Array; EXPOSURE_FULL for each view in full
  // sun), or null if stop() turned true. progress(f) is told how far it has got.
  async exposureRun({ dirs, texel, stop, progress }) {
    const X = this.exposure, dev = this.device;
    if (!X) return null;
    const size = this.exposureDepth.width, inner = size - 2 * EXPOSURE_MARGIN;
    // Everything that can cast a shadow, along each direction.
    const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
    for (const b of this.batches) for (let k = 0; k < 3; k++) { mn[k] = Math.min(mn[k], b.min[k]); mx[k] = Math.max(mx[k], b.max[k]); }
    for (let k = 0; k < 3; k++) { mn[k] = Math.min(mn[k], X.lo[k]); mx[k] = Math.max(mx[k], X.hi[k]); }
    const centre = V3.scale(V3.add(mn, mx), 0.5), radius = Math.max(V3.len(V3.sub(mx, mn)) / 2, 1e-6) * 1.02;
    const corners = [];
    for (let c = 0; c < 8; c++) corners.push([c & 1 ? X.hi[0] : X.lo[0], c & 2 ? X.hi[1] : X.lo[1], c & 4 ? X.hi[2] : X.lo[2]]);
    const clear = dev.createCommandEncoder();
    clear.clearBuffer(X.lit);
    dev.queue.submit([clear.finish()]);
    let last = performance.now();
    for (let di = 0; di < dirs.length; di++) {
      const L = dirs[di];
      let lx = V3.cross([0, 0, 1], L);
      if (V3.len(lx) < 1e-4) lx = [1, 0, 0];
      lx = V3.norm(lx);
      const ly = V3.cross(L, lx);
      // The points' extent across the sun's view, in tiles of inner texels.
      const xs = corners.map((p) => V3.dot(p, lx)), ys = corners.map((p) => V3.dot(p, ly));
      const x0 = Math.min(...xs), y0 = Math.min(...ys), w = Math.max(...xs) - x0, h = Math.max(...ys) - y0;
      const t = Math.max(texel, w / (inner * 4), h / (inner * 4), 1e-9);
      const nx = Math.max(1, Math.ceil(w / (t * inner))), ny = Math.max(1, Math.ceil(h / (t * inner)));
      const sc = V3.dot(centre, L), sMin = sc - radius, range = 2 * radius, r = (t * size) / 2;
      for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
        const cx = x0 + (i + 0.5) * t * inner, cy = y0 + (j + 0.5) * t * inner, m = new Float32Array(16);
        m[0] = lx[0] / r; m[4] = lx[1] / r; m[8] = lx[2] / r; m[12] = -cx / r;
        m[1] = ly[0] / r; m[5] = ly[1] / r; m[9] = ly[2] / r; m[13] = -cy / r;
        m[2] = L[0] / range; m[6] = L[1] / range; m[10] = L[2] / range; m[14] = -sMin / range;
        m[15] = 1;
        const uni = new Float32Array(24);
        uni.set(m); uni.set([L[0], L[1], L[2], 0], 16); uni.set([t, (1.5 * t) / range, X.n, EXPOSURE_MARGIN / size], 20);
        dev.queue.writeBuffer(this.exposureShadowBuf, 0, m);
        dev.queue.writeBuffer(this.exposureUni, 0, uni);
        if (this.exposureShadowBG?.flags !== this.objFlagsBuf) {
          this.exposureShadowBG = dev.createBindGroup({ layout: this.shadowLayout, entries: [
            { binding: 0, resource: { buffer: this.exposureShadowBuf, size: 64 } }, { binding: 1, resource: { buffer: this.objFlagsBuf } }] });
          this.exposureShadowBG.flags = this.objFlagsBuf;
        }
        const enc = dev.createCommandEncoder();
        const pass = enc.beginRenderPass({ colorAttachments: [],
          depthStencilAttachment: { view: this.exposureDepth.createView(), depthClearValue: 0, depthLoadOp: 'clear', depthStoreOp: 'store' } });
        pass.setPipeline(this.shadowPipe);
        pass.setBindGroup(0, this.exposureShadowBG, [0]);
        this.cull(m);
        for (const b of this.batches) {
          if (!b.visible || b.kind !== 'mesh' || !b.castsShadow || !this.seen(b)) continue;
          pass.setVertexBuffer(0, b.gpu.pos); pass.setVertexBuffer(1, b.gpu.oid);
          pass.setIndexBuffer(b.gpu.idx, 'uint32');
          this.drawCells(pass, b);
        }
        pass.end();
        const cp = enc.beginComputePass();
        cp.setPipeline(this.exposurePipe);
        cp.setBindGroup(0, X.bg);
        cp.dispatchWorkgroups(Math.ceil(X.n / 64));
        cp.end();
        dev.queue.submit([enc.finish()]);
      }
      // Let the GPU catch up, and the page draw, now and then.
      if (performance.now() - last > 30 || di === dirs.length - 1) {
        await dev.queue.onSubmittedWorkDone();
        await new Promise((res) => setTimeout(res, 0));
        if (stop() || this.exposure !== X) return null;
        progress?.((di + 1) / dirs.length);
        last = performance.now();
      }
    }
    const enc = dev.createCommandEncoder();
    enc.copyBufferToBuffer(X.lit, 0, X.read, 0, X.n * 4);
    dev.queue.submit([enc.finish()]);
    await X.read.mapAsync(GPUMapMode.READ);
    const out = new Uint32Array(X.read.getMappedRange()).slice();
    X.read.unmap();
    return stop() || this.exposure !== X ? null : out;
  }

  // Result lines to draw: { pos: Float32Array, col: Uint8Array } (line-list vertices), or null for
  // none. Each frame's s.resultRanges says which { first, count } of them are shown.
  setResultLines(lines) {
    this.resultLines?.pos.destroy();
    this.resultLines?.col.destroy();
    this.resultLines = null;
    if (!lines?.pos.length) return;
    const make = (arr) => {
      const buf = this.device.createBuffer({ size: arr.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
      this.device.queue.writeBuffer(buf, 0, arr);
      return buf;
    };
    this.resultLines = { pos: make(lines.pos), col: make(lines.col) };
  }

  // Returns { p: world position (model-relative), id: object index } for the visible surface
  // under pixel (px, py), or null for empty space. With s.pickMaps it can also be
  // { p, map: index } for a result map from s.resultMaps. Picks share one readback buffer, so
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
      const vp = M4.mul(pm, viewProj);
      this.writeFrame(this.pickFrameBuf, vp, s);
      const enc = this.device.createCommandEncoder();
      const pass = enc.beginRenderPass({
        colorAttachments: [{ view: this.pickColor.createView(), clearValue: { r: 0, g: 0, b: 0, a: 0 }, loadOp: 'clear', storeOp: 'store' }],
        depthStencilAttachment: { view: this.pickDepth.createView(), depthClearValue: 0, depthLoadOp: 'clear', depthStoreOp: 'store' },
      });
      pass.setPipeline(this.pipes.pick);
      pass.setBindGroup(0, this.pickFrameBG);
      this.cull(vp, true);
      for (const b of this.batches) {
        if (!b.visible || b.kind !== 'mesh' || !this.seen(b)) continue;
        pass.setVertexBuffer(0, b.gpu.pos); pass.setVertexBuffer(1, b.gpu.oid);
        pass.setIndexBuffer(b.gpu.idx, 'uint32');
        this.drawCells(pass, b);
      }
      if (s.pickMaps && s.resultMaps?.length) {
        pass.setPipeline(this.pipes.mapPick);
        this.drawResultMaps(pass, s);
      }
      pass.end();
      enc.copyTextureToBuffer({ texture: this.pickColor }, { buffer: this.pickRead, bytesPerRow: 256 }, [1, 1]);
      this.device.queue.submit([enc.finish()]);
      await this.pickRead.mapAsync(GPUMapMode.READ);
      const v = new Float32Array(this.pickRead.getMappedRange(0, 16)).slice();
      this.pickRead.unmap();
      if (v[3] < -0.5) return { p: [v[0], v[1], v[2]], map: Math.round(-v[3]) - 1 };
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
  // or null at once when the previous probe has not been read back yet (or later, if the GPU
  // rejected this one).
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
      this.probeBGs = this.probeBufs.map((buffer) => this.probeBindGroup(buffer));
    }
    const views = [{ vp: M4.mul(M4.ortho(q.half, 1, 0, q.top - q.bottom), M4.lookAt([q.x, q.y, q.top], [q.x, q.y, q.top - 1], [0, 1, 0])), rect: [0, 0, G, G] }];
    const zm = (q.z0 + q.z1) / 2, hh = (q.z1 - q.z0) / 2;
    [[1, 0], [-1, 0], [0, 1], [0, -1]].forEach(([dx, dy], k) => {
      const eye = [q.x, q.y, zm];
      views.push({ vp: M4.mul(M4.ortho(hh, q.reach / hh, 0, q.reach), M4.lookAt(eye, [q.x + dx, q.y + dy, zm], [0, 0, 1])), rect: [k * W, G, W, H] });
    });
    views.forEach((v, i) => dev.queue.writeBuffer(this.probeBufs[i], 0, Float32Array.from(v.vp)));

    const solid = this.batches.filter((b) => b.visible && b.kind === 'mesh' && b.special !== MAT_VEGETATION);
    // Should the GPU reject this work, the read-back buffer still holds the previous result (for
    // somewhere else): resolve null then, so the walker asks again rather than trusting it.
    dev.pushErrorScope('validation');
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
      this.cull(v.vp, true);
      for (const b of solid) {
        if (!this.seen(b)) continue;
        pass.setVertexBuffer(0, b.gpu.pos); pass.setVertexBuffer(1, b.gpu.oid);
        pass.setIndexBuffer(b.gpu.idx, 'uint32');
        this.drawCells(pass, b);
      }
    });
    pass.end();
    enc.copyTextureToBuffer({ texture: this.probeTex }, { buffer: this.probeRead, bytesPerRow: G * 16 }, [G, rows]);
    dev.queue.submit([enc.finish()]);
    const failed = dev.popErrorScope();
    return this.probeRead.mapAsync(GPUMapMode.READ).then(async () => {
      if (await failed) { this.probeRead.unmap(); return null; }
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

  // The screen-sized textures are not bound (the pick pipeline reads neither): a resize destroys
  // them, and a bind group still holding one made every probe fail, leaving the walker with a stale map.
  probeBindGroup(buffer) {
    const none = this.noGbuf.createView();
    return this.device.createBindGroup({ layout: this.frameLayout, entries: [
      { binding: 0, resource: { buffer } }, { binding: 1, resource: this.shadowView }, { binding: 2, resource: this.shadowCmp },
      { binding: 3, resource: none }, { binding: 4, resource: { buffer: this.objFlagsBuf } },
      { binding: 5, resource: this.lampShadowView }, { binding: 6, resource: none }] });
  }

  // The ground below many points at once, by the same rules as probe(): the highest visible surface
  // below each point ({ x, y, top }), down to `bottom`, leaving out vegetation and any batch `skip`
  // says to. Each point looks straight down through one texel of half size `half`. Resolves to an
  // array of heights, null where there is nothing (or if the GPU rejected the work).
  groundBelow(points, bottom, half, skip) {
    const run = async () => {
      const out = new Array(points.length).fill(null);
      if (!this.batches.length) return out;
      const dev = this.device, S = PROBE.groundBatch, U = GPUBufferUsage;
      if (!this.groundTex) {
        const RA = GPUTextureUsage.RENDER_ATTACHMENT;
        this.groundTex = dev.createTexture({ size: [S, S], format: 'rgba32float', usage: RA | GPUTextureUsage.COPY_SRC });
        this.groundDepth = dev.createTexture({ size: [S, S], format: DEPTH, usage: RA });
        this.groundRead = dev.createBuffer({ size: S * S * 16, usage: U.MAP_READ | U.COPY_DST });
        this.groundBuf = dev.createBuffer({ size: FRAME_SIZE, usage: U.UNIFORM | U.COPY_DST });
      }
      const solid = this.batches.filter((b) => b.visible && b.kind === 'mesh' && b.special !== MAT_VEGETATION && !skip(b));
      const group = this.probeBindGroup(this.groundBuf), color = this.groundTex.createView(), depth = this.groundDepth.createView();
      for (let from = 0; from < points.length; from += S * S) {
        const n = Math.min(S * S, points.length - from);
        dev.pushErrorScope('validation');
        for (let i = 0; i < n; i++) {
          const p = points[from + i], vp = M4.mul(M4.ortho(half, 1, 0, Math.max(p.top - bottom, half)), M4.lookAt([p.x, p.y, p.top], [p.x, p.y, p.top - 1], [0, 1, 0]));
          dev.queue.writeBuffer(this.groundBuf, 0, Float32Array.from(vp));
          const enc = dev.createCommandEncoder(), load = i ? 'load' : 'clear';
          const pass = enc.beginRenderPass({
            colorAttachments: [{ view: color, clearValue: { r: 0, g: 0, b: 0, a: 0 }, loadOp: load, storeOp: 'store' }],
            depthStencilAttachment: { view: depth, depthClearValue: 0, depthLoadOp: load, depthStoreOp: 'store' },
          });
          pass.setPipeline(this.pipes.pick);
          pass.setViewport(i % S, Math.floor(i / S), 1, 1, 0, 1);
          pass.setScissorRect(i % S, Math.floor(i / S), 1, 1);
          pass.setBindGroup(0, group);
          this.cull(vp, true);
          for (const b of solid) {
            if (!this.seen(b)) continue;
            pass.setVertexBuffer(0, b.gpu.pos); pass.setVertexBuffer(1, b.gpu.oid);
            pass.setIndexBuffer(b.gpu.idx, 'uint32');
            this.drawCells(pass, b);
          }
          pass.end();
          if (i === n - 1) enc.copyTextureToBuffer({ texture: this.groundTex }, { buffer: this.groundRead, bytesPerRow: S * 16 }, [S, S]);
          dev.queue.submit([enc.finish()]);
        }
        const failed = await dev.popErrorScope();
        await this.groundRead.mapAsync(GPUMapMode.READ);
        const v = new Float32Array(this.groundRead.getMappedRange());
        if (!failed) for (let i = 0; i < n; i++) if (v[i * 4 + 3] > 0) out[from + i] = v[i * 4 + 2];
        this.groundRead.unmap();
      }
      return out;
    };
    this.groundQueue = (this.groundQueue || Promise.resolve()).then(run, run);
    return this.groundQueue;
  }
}

const PROBE = { ground: 128, wallW: 32, wallH: 16, groundBatch: 64 };
