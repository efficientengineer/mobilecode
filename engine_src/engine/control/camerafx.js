// engine/control/camerafx.js
// Camera EFFECT wrappers — a swappable component that DECORATES a base camera
// controller from cameras.js. A base is a pure
//   (focus, entity, dt) -> { eye, target, up?, projection?, orthoSize? }
// and each fx here returns a NEW controller of the SAME shape wrapping it:
//   fx(base, cfg) -> (focus, entity, dt) -> { eye, target, ... }
// So they COMPOSE — stack them and the innermost base still drives the view:
//   ctx.camera = cameraFx.smooth(cameraFx.shake(cameras.topDown()))
//
// Everything is pure and deterministic (no Math.random, no DOM/timers): shake
// uses a seeded counter, smooth keeps its eased state in a closure. Non-eye/target
// fields the base returns (up/projection/orthoSize) are passed straight through.

// --- tiny vec helpers (ground-plane + height, arrays are [x,y,z]) ---
function add(a, b) { return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]; }
function copy(a) { return [a[0], a[1], a[2]]; }
// carry through up/projection/orthoSize so decorators never drop camera metadata
function rest(r) {
  const o = {};
  if (r.up != null) o.up = r.up;
  if (r.projection != null) o.projection = r.projection;
  if (r.orthoSize != null) o.orthoSize = r.orthoSize;
  return o;
}

// A hashed, deterministic pseudo-random in [-1,1] from an integer counter — the
// stand-in for Math.random in the hot path (same counter -> same value).
function hashNoise(n) {
  let h = (n | 0) * 374761393 + 668265263;
  h = (h ^ (h >>> 13)) * 1274126177;
  h = h ^ (h >>> 16);
  return ((h >>> 0) / 4294967295) * 2 - 1;
}

// --- shake: additive camera trauma that decays over time -------------------
// Triggered two ways: call the returned controller's .trigger(mag?) (e.g. on a
// hit/explosion), OR set entity.shake to a magnitude and it's absorbed each frame.
// The eye jitters on a seeded counter so a replay shakes identically.
export function shake(base, { mag = 0.5, decay = 5, freq = 1 } = {}) {
  let trauma = 0;      // current shake magnitude
  let n = 0;           // deterministic counter (advances every frame)
  const fx = (focus, entity, dt = 0) => {
    const r = base(focus, entity, dt);
    // absorb an entity-driven request (take the strongest source)
    if (entity && entity.shake) { trauma = Math.max(trauma, entity.shake); entity.shake = 0; }
    if (trauma <= 0) return { eye: copy(r.eye), target: copy(r.target), ...rest(r) };
    n += 1 + (freq | 0);
    const k = trauma * mag;                    // trauma-scaled amplitude
    const ox = hashNoise(n * 2 + 1) * k;
    const oz = hashNoise(n * 2 + 7) * k;
    const oy = hashNoise(n * 2 + 13) * k * 0.5; // less vertical bounce
    trauma = Math.max(0, trauma - decay * dt); // exponential-ish falloff
    return { eye: [r.eye[0] + ox, r.eye[1] + oy, r.eye[2] + oz], target: copy(r.target), ...rest(r) };
  };
  fx.trigger = (m = 1) => { trauma = Math.max(trauma, m); };
  return fx;
}

// --- smooth: exponential ease of eye+target toward the base result ---------
// Kills camera snap/jitter. Higher stiffness = snappier (closer to raw base).
// State (last eye/target) lives in the closure; first frame latches instantly.
export function smooth(base, { stiffness = 8 } = {}) {
  let eye = null, target = null;
  return (focus, entity, dt = 0) => {
    const r = base(focus, entity, dt);
    if (!eye) { eye = copy(r.eye); target = copy(r.target); }
    // frame-rate independent lerp factor (t=1 when dt large -> snaps)
    const a = 1 - Math.exp(-stiffness * (dt || 0));
    for (let i = 0; i < 3; i++) {
      eye[i] += (r.eye[i] - eye[i]) * a;
      target[i] += (r.target[i] - target[i]) * a;
    }
    return { eye: copy(eye), target: copy(target), ...rest(r) };
  };
}

// --- lookAhead: lead the target by the entity's velocity -------------------
// Pushes the aim point (and camera framing) ahead of a moving subject so the
// player sees where they're going. Offset scales with speed via `lead` seconds.
export function lookAhead(base, { lead = 1.2, includeEye = true } = {}) {
  return (focus, entity, dt = 0) => {
    const r = base(focus, entity, dt);
    const v = entity && entity.vel ? entity.vel : [0, 0, 0];
    const off = [v[0] * lead, v[1] * lead, v[2] * lead];
    const target = add(r.target, off);
    const eye = includeEye ? add(r.eye, off) : copy(r.eye);
    return { eye, target, ...rest(r) };
  };
}

// --- zoom: scale the eye's distance from the target by a factor ------------
// Dolly in/out along the base view direction. `on(entity)->t` (0..1) picks the
// blend between min and max (e.g. speed, health, charge); default holds min.
export function zoom(base, { min = 1, max = 1.6, on } = {}) {
  return (focus, entity, dt = 0) => {
    const r = base(focus, entity, dt);
    let t = on ? on(entity) : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;             // clamp 0..1
    const f = min + (max - min) * t;           // distance multiplier
    // scale eye about target along the view ray
    const eye = [
      r.target[0] + (r.eye[0] - r.target[0]) * f,
      r.target[1] + (r.eye[1] - r.target[1]) * f,
      r.target[2] + (r.eye[2] - r.target[2]) * f,
    ];
    return { eye, target: copy(r.target), ...rest(r) };
  };
}

// --- deadzone: hold still until the focus leaves a slack box ----------------
// The camera anchor only re-centers on the focus when it drifts past `radius`
// (a box half-extent), then snaps just to the box edge — so small wobbles don't
// move the view. Anchor state lives in the closure; base is driven off it.
export function deadzone(base, { radius = 2, radiusZ } = {}) {
  const rz = radiusZ != null ? radiusZ : radius;
  let anchor = null;
  return (focus, entity, dt = 0) => {
    if (!anchor) anchor = [focus[0], focus[1], focus[2]];
    anchor[1] = focus[1];                       // follow height freely
    const dx = focus[0] - anchor[0], dz = focus[2] - anchor[2];
    if (dx > radius) anchor[0] = focus[0] - radius;
    else if (dx < -radius) anchor[0] = focus[0] + radius;
    if (dz > rz) anchor[2] = focus[2] - rz;
    else if (dz < -rz) anchor[2] = focus[2] + rz;
    return base(anchor, entity, dt);            // base frames the lagged anchor
  };
}

export const cameraFx = { shake, smooth, lookAhead, zoom, deadzone };
