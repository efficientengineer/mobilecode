// engine/control/tweens.js
// Reusable TWEENING + interpolation — the pure math of "animate a value from A to
// B over `duration`, shaped by an easing curve." A sibling of the other control
// libraries: it PRODUCES values (a popup's scale, a fade alpha, a color, a camera
// dolly) that a game reads each frame; it never draws or touches the DOM.
//
//   const pop = tween(0, 1, 0.3, 'easeOutBack');   // scale 0 -> 1 with overshoot
//   const s = pop(dt);   // -> { value, done, t }   (state lives in the closure)
//   entity.scale = s.value;
//
// A tweened value is a NUMBER or an ARRAY (lerped componentwise — positions,
// colors, offsets). Everything is deterministic and node-safe: no Math.random, no
// timers, no globals; per-instance progress is captured in each closure, so one
// factory call drives exactly one animation.

// ---- interpolation primitives ----------------------------------------------

// Linear blend a->b by t. Arrays interpolate per component (a defines the shape);
// t may sit outside 0..1 (overshoot eases extrapolate, which is the point).
export function lerp(a, b, t) {
  if (Array.isArray(a)) { const o = new Array(a.length); for (let i = 0; i < a.length; i++) o[i] = a[i] + (b[i] - a[i]) * t; return o; }
  return a + (b - a) * t;
}

// Frame-rate-INDEPENDENT exponential smoothing: ease `cur` toward `target` by a
// rate `lambda` (bigger = snappier), correct for any dt. Drop-in for the naive
// `cur += (target-cur)*k` that secretly depends on framerate. Number or array.
export function damp(cur, target, lambda = 8, dt = 0) {
  return lerp(cur, target, 1 - Math.exp(-lambda * Math.max(0, dt)));
}

// Fold t onto a 0->1->0 triangle wave of period 2 (t=0->0, 1->1, 2->0, 3->1 ...).
// Feed it a rising clock to bounce a value back and forth forever.
export function pingPongT(t) {
  const m = ((t % 2) + 2) % 2;            // wrap into [0,2), negatives too
  return m <= 1 ? m : 2 - m;
}

const clamp01 = t => (t < 0 ? 0 : t > 1 ? 1 : t);

// ---- easing curves (each maps 0..1 -> ~0..1) --------------------------------
// Overshoot curves (Back/Elastic) leave the unit range mid-flight but land exactly
// on 1 at t=1, so endpoints are always clean. Named for lookup in `tween`.

const BACK = 1.70158, BACK3 = BACK + 1;   // back-ease overshoot constants
const ELASTIC = (2 * Math.PI) / 3;

function easeOutBounce(t) {                // decaying ball-drop bounces
  const n = 7.5625, d = 2.75;
  if (t < 1 / d) return n * t * t;
  if (t < 2 / d) { t -= 1.5 / d; return n * t * t + 0.75; }
  if (t < 2.5 / d) { t -= 2.25 / d; return n * t * t + 0.9375; }
  t -= 2.625 / d; return n * t * t + 0.984375;
}

export const ease = {
  linear: t => t,
  easeIn: t => t * t,                                   // quadratic accel
  easeOut: t => t * (2 - t),                            // quadratic decel
  easeInOut: t => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) * (-2 * t + 2) / 2),
  easeOutBack: t => 1 + BACK3 * Math.pow(t - 1, 3) + BACK * Math.pow(t - 1, 2), // overshoot then settle
  easeOutElastic: t => (t === 0 || t === 1 ? t : Math.pow(2, -10 * t) * Math.sin((t * 10 - 0.75) * ELASTIC) + 1), // springy
  easeOutBounce,
  smoothstep: t => { t = clamp01(t); return t * t * (3 - 2 * t); }, // Hermite S-curve, flat at both ends
};

const resolveEase = e => (typeof e === 'function' ? e : ease[e]) || ease.linear;

// ---- tween ------------------------------------------------------------------

// Animate `from` -> `to` over `duration` seconds shaped by `ease` (a curve name or
// your own fn). Returns a stepper `step(dt) -> { value, done, t }`, where `value`
// is the eased interpolation, `t` is RAW linear progress 0..1 (assert monotonic /
// endpoints in tests), and `done` latches once t hits 1. `duration<=0` snaps to
// `to` instantly. `step.reset()` rewinds it; `step.duration` exposes the length
// (used by `sequence`). All progress is held in the closure — reuse per animation.
export function tween(from, to, duration = 1, easing = 'linear') {
  const fn = resolveEase(easing);
  const dur = Math.max(0, duration);
  let elapsed = 0;
  const step = (dt = 0) => {
    elapsed += dt;
    const t = dur > 0 ? clamp01(elapsed / dur) : 1;
    return { value: lerp(from, to, fn(t)), done: t >= 1, t };
  };
  step.reset = () => { elapsed = 0; };
  step.duration = dur;
  return step;
}

// Play a list of tweens back to back as one animation. Returns the same
// `step(dt) -> { value, done, t }` shape (so sequences NEST), where `t` is overall
// progress across the whole chain. Time is accounted globally and mapped into the
// active segment, so long frames spill accurately into the next tween instead of
// stalling on a boundary. Empty chain is instantly done.
export function sequence(steps = []) {
  const durs = steps.map(s => Math.max(0, (s && s.duration) || 0));
  const total = durs.reduce((a, b) => a + b, 0);
  let elapsed = 0;
  const step = (dt = 0) => {
    if (!steps.length) return { value: undefined, done: true, t: 1 };
    elapsed += dt;
    let acc = 0, i = 0;
    while (i < steps.length - 1 && elapsed > acc + durs[i]) { acc += durs[i]; i++; }
    steps[i].reset();                       // re-drive the active segment from its start
    const seg = steps[i](elapsed - acc);    // ... by absolute local time (keeps it pure)
    return { value: seg.value, done: elapsed >= total, t: total > 0 ? clamp01(elapsed / total) : 1 };
  };
  step.reset = () => { elapsed = 0; steps.forEach(s => s.reset && s.reset()); };
  step.duration = total;
  return step;
}

export const tweens = { tween, sequence, ease, lerp, damp, pingPongT };
