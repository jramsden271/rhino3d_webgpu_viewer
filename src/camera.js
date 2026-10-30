// Z-up orbit camera (Rhino convention). The camera is a target point, a distance, and yaw/pitch
// angles of the target->eye direction. Parallel projection uses the same state, with the view
// height derived from the distance so zooming behaves identically in both modes.

const Z_UP = [0, 0, 1];
const PITCH_LIMIT = (89.99 * Math.PI) / 180;
const DEFAULT_FOV = (40 * Math.PI) / 180;

class Camera {
  constructor() {
    this.target = [0, 0, 0];
    this.distance = 100;
    this.yaw = (-60 * Math.PI) / 180;
    this.pitch = (28 * Math.PI) / 180;
    this.fov = DEFAULT_FOV;
    this.ortho = false;
    this.center = [0, 0, 0];
    this.radius = 100;
    this.aspect = 1;
  }

  get dir() { // target -> eye
    const cp = Math.cos(this.pitch);
    return [cp * Math.cos(this.yaw), cp * Math.sin(this.yaw), Math.sin(this.pitch)];
  }
  get eye() { return V3.add(this.target, V3.scale(this.dir, this.distance)); }
  get forward() { return V3.scale(this.dir, -1); }
  get right() { return [-Math.sin(this.yaw), Math.cos(this.yaw), 0]; }
  get up() { return V3.cross(this.right, this.forward); }
  get halfHeight() { return this.distance * Math.tan(this.fov / 2); }

  viewProj() {
    const view = M4.lookAt(this.eye, this.target, this.up);
    let proj;
    if (this.ortho) {
      const R = this.radius + V3.len(V3.sub(this.target, this.center));
      proj = M4.ortho(this.halfHeight, this.aspect, this.distance - R * 1.5, this.distance + R * 1.5);
    } else {
      proj = M4.perspective(this.fov, this.aspect, Math.max(this.distance * 0.002, this.radius * 1e-6));
    }
    return M4.mul(proj, view);
  }

  // Direction towards the key light: over the viewer's left shoulder.
  lightDir() { return V3.norm(V3.add(V3.add(this.dir, V3.scale(this.up, 0.6)), V3.scale(this.right, -0.35))); }

  setBounds(min, max) {
    this.center = V3.scale(V3.add(min, max), 0.5);
    this.radius = Math.max(V3.len(V3.sub(max, min)) / 2, 1e-6);
  }

  zoomExtents(min, max) {
    const c = V3.scale(V3.add(min, max), 0.5), r = Math.max(V3.len(V3.sub(max, min)) / 2, 1e-6);
    const half = Math.min(this.fov / 2, Math.atan(Math.tan(this.fov / 2) * this.aspect));
    this.target = c;
    this.distance = (r / Math.sin(half)) * 1.05;
  }

  setView(name) {
    const deg = Math.PI / 180;
    const views = {
      perspective: [-60, 28, false],
      top: [-90, 89.99, true],
      bottom: [-90, -89.99, true],
      front: [-90, 0, true],
      back: [90, 0, true],
      right: [0, 0, true],
      left: [180, 0, true],
    };
    const [y, p, o] = views[name];
    this.yaw = y * deg; this.pitch = p * deg; this.ortho = o; this.fov = DEFAULT_FOV;
  }

  // The snapshot closest to a view saved in a Rhino file (see readNamedViews in extract.js). All of
  // Rhino's frame stays in view whatever the window's shape. This camera has no roll or lens shift:
  // a shifted frame (a two-point perspective, say) is framed by turning towards its centre instead.
  fromRhino(v) {
    const f = v.frustum, right = V3.cross(v.dir, v.up);
    const off = V3.add(V3.scale(right, (f.left + f.right) / 2), V3.scale(v.up, (f.bottom + f.top) / 2));
    const half = Math.max((f.top - f.bottom) / 2, (f.right - f.left) / 2 / this.aspect);
    const depth = V3.dot(V3.sub(v.target, v.eye), v.dir);
    const s = { ortho: v.ortho, fov: DEFAULT_FOV };
    let look = v.dir;
    if (v.ortho) {
      s.distance = half / Math.tan(DEFAULT_FOV / 2);
      s.target = V3.add(V3.add(v.eye, off), V3.scale(v.dir, depth));
    } else {
      look = V3.norm(V3.add(V3.scale(v.dir, f.near), off));
      s.fov = 2 * Math.atan(half / f.near);
      s.distance = depth > 0 ? depth : this.radius * 0.1;
      s.target = V3.add(v.eye, V3.scale(look, s.distance));
    }
    // Straight down or up, the heading comes from the view's up direction.
    const [x, y, z] = V3.scale(look, -1);
    s.pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, Math.asin(Math.max(-1, Math.min(1, z)))));
    s.yaw = Math.abs(z) < 0.9999 ? Math.atan2(y, x) : z > 0 ? Math.atan2(-v.up[1], -v.up[0]) : Math.atan2(v.up[1], v.up[0]);
    return s;
  }

  // Rotate the camera (eye and target together) about `pivot`.
  orbit(dx, dy, pivot) {
    const dYaw = -dx * 0.006;
    const newPitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, this.pitch + dy * 0.006));
    const dPitch = newPitch - this.pitch;
    pivot = pivot || this.target;
    this.target = V3.add(pivot, V3.rotate(V3.sub(this.target, pivot), Z_UP, dYaw));
    this.yaw += dYaw;
    this.target = V3.add(pivot, V3.rotate(V3.sub(this.target, pivot), this.right, -dPitch));
    this.pitch = newPitch;
  }

  // dx, dy in CSS pixels; viewHeight is the canvas height in CSS pixels.
  pan(dx, dy, viewHeight) {
    const wpp = (2 * this.halfHeight) / viewHeight;
    this.target = V3.add(this.target, V3.add(V3.scale(this.right, -dx * wpp), V3.scale(this.up, dy * wpp)));
  }

  // Point on the plane through the target (perpendicular to the view) under NDC (x, y).
  planePoint(nx, ny) {
    const h = this.halfHeight;
    return V3.add(this.target, V3.add(V3.scale(this.right, nx * h * this.aspect), V3.scale(this.up, ny * h)));
  }

  // Scale the eye-target configuration about the world point q.
  zoomAt(factor, q) {
    const minDist = this.radius * 1e-5;
    if (this.distance * factor < minDist) factor = minDist / this.distance;
    this.target = V3.add(q, V3.scale(V3.sub(this.target, q), factor));
    this.distance *= factor;
  }

  // Centre the view on q, keeping the viewing direction and the image scale at q.
  focus(q) {
    const d = V3.dot(V3.sub(q, this.eye), this.forward);
    if (d > 0 && !this.ortho) this.distance = d;
    this.target = [...q];
  }

  snapshot() { return { target: [...this.target], distance: this.distance, yaw: this.yaw, pitch: this.pitch, ortho: this.ortho, fov: this.fov }; }
  restore(s) { Object.assign(this, { target: [...s.target], distance: s.distance, yaw: s.yaw, pitch: s.pitch, ortho: s.ortho, fov: s.fov }); }
}
