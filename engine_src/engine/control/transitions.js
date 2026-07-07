// engine/control/transitions.js
// Screen / scene TRANSITIONS — time-based PROGRESS producers a renderer or DOM
// overlay reads to draw a fade, wipe, iris, etc. Nothing here draws: each factory
// returns a stateful stepper
//   step(dt) -> { p (0..1 progress), done, ...visual }
// where `p` is the eased progress and the extra fields (alpha / offset / radius /
// weights…) are exactly what the overlay needs that frame. `done` flips true when
// the play head reaches the end (or the start, when reversed).
//
// Every stepper also carries control methods for juicy re-use:
//   step.replay()   restart from the beginning
//   step.reverse()  flip play direction (out<->in) and keep going
//   step.reset()    alias of replay
// and mirrors the latest { done, p } onto the function itself for convenience.
//
// Compose a full out->in scene change with pair(outT, inT, { onSwap }): it runs
// the first to completion, fires onSwap (swap the scene HERE), then runs the
// second, reporting one blended 0..1 progress across both halves.
//
// Pure, deterministic, node-safe: no DOM/WebGL/timers, no Math.random — progress
// is driven only by the dt you feed it, so a sim steps to completion and asserts
// endpoints + monotonic progress. Per-instance state (elapsed, dir) in closures.

// --- tiny math ---------------------------------------------------------------
export function clamp01(x) { return x < 0 ? 0 : x > 1 ? 1 : x; }
export function lerp(a, b, t) { return a + (b - a) * t; }

// Easing curves — all map 0->0 and 1->1 and are monotonic on [0,1].
export const ease = {
  linear: (t) => t,
  inQuad: (t) => t * t,
  outQuad: (t) => t * (2 - t),
  inOutQuad: (t) => (t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t),
  inCubic: (t) => t * t * t,
  outCubic: (t) => 1 - Math.pow(1 - t, 3),
  inOutCubic: (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
  smoothstep: (t) => t * t * (3 - 2 * t),
  smootherstep: (t) => t * t * t * (t * (t * 6 - 15) + 10),
};

// --- timeline: the shared play head every transition rides -------------------
// Advances an elapsed seconds counter in [0,duration], honoring a one-time start
// `delay`, a play `dir` (+1 forward / -1 reversed), and returns EASED progress.
// `done` = reached the far end for the current direction.
function timeline({ duration = 0.5, delay = 0, easing = ease.smoothstep } = {}) {
  const D = Math.max(1e-6, duration);
  let t = 0;        // elapsed seconds within [0, D]
  let waited = 0;   // start-delay countdown (forward only)
  let dir = 1;      // +1 forward, -1 reversed
  const read = () => {
    const raw = t / D;
    const done = dir > 0 ? t >= D : t <= 0;
    return { p: easing(clamp01(raw)), raw, done };
  };
  return {
    advance(dt = 0) {
      dt = dt || 0;
      if (dir > 0 && waited < delay) {          // burn the intro delay first
        waited += dt;
        if (waited < delay) return read();
        dt = waited - delay;                    // spill the remainder into play
      }
      t += dir * dt;
      if (t < 0) t = 0; else if (t > D) t = D;
      return read();
    },
    reverse() { dir = -dir; },
    reset() { t = 0; waited = 0; dir = 1; },
    peek: read,
  };
}

// Attach the shared control surface (replay/reverse/reset + live done/p mirror).
function controls(step, tl) {
  step.replay = () => { tl.reset(); step.done = false; step.p = 0; return step; };
  step.reset = step.replay;
  step.reverse = () => { tl.reverse(); return step; };
  step.done = false;
  step.p = 0;
  return step;
}

// --- fade: darken to (or lift from) a solid color --------------------------
// dir "out" = fade the scene OUT to black (alpha 0->1); "in" = fade IN from black
// (alpha 1->0). `alpha` is the overlay opacity the renderer paints over the frame.
export function fade({ duration = 0.5, dir = 'out', delay = 0, easing = ease.smoothstep } = {}) {
  const tl = timeline({ duration, delay, easing });
  const out = dir !== 'in';                     // default: fade to black
  const step = (dt = 0) => {
    const r = tl.advance(dt);
    const alpha = out ? r.p : 1 - r.p;
    step.done = r.done; step.p = r.p;
    return { p: r.p, done: r.done, alpha, dir };
  };
  return controls(step, tl);
}

// --- wipe: a hard bar sweeping across the screen ---------------------------
// `p` is how far the leading edge has crossed (0..1) along `axis` ('x' or 'y').
// The overlay fills from the start edge to p (or from p to the end when reversed).
export function wipe({ duration = 0.5, axis = 'x', delay = 0, easing = ease.linear } = {}) {
  const tl = timeline({ duration, delay, easing });
  const step = (dt = 0) => {
    const r = tl.advance(dt);
    step.done = r.done; step.p = r.p;
    return { p: r.p, done: r.done, axis };
  };
  return controls(step, tl);
}

// --- slide: push a panel on/off along an edge ------------------------------
// `offset` is the panel's NORMALIZED screen displacement [x,y] (-1..1 of a full
// screen). from="left" starts at [-1,0] and slides to [0,0] as p:0->1; likewise
// right/up/down. The renderer translates the layer by offset * screenSize.
export function slide({ duration = 0.5, from = 'left', delay = 0, easing = ease.outCubic } = {}) {
  const tl = timeline({ duration, delay, easing });
  const dirs = { left: [-1, 0], right: [1, 0], up: [0, -1], down: [0, 1] };
  const v = dirs[from] || dirs.left;
  const step = (dt = 0) => {
    const r = tl.advance(dt);
    const m = 1 - r.p;                           // distance still off-screen
    step.done = r.done; step.p = r.p;
    return { p: r.p, done: r.done, offset: [v[0] * m, v[1] * m], from };
  };
  return controls(step, tl);
}

// --- iris: a circular mask that opens or closes ----------------------------
// `radius` is the hole radius 0..1 (fraction of the screen's half-diagonal).
// dir "open" reveals (radius 0->1), "close" is the old-cartoon iris-out (1->0).
export function iris({ duration = 0.5, dir = 'open', center = [0.5, 0.5], delay = 0, easing = ease.smoothstep } = {}) {
  const tl = timeline({ duration, delay, easing });
  const open = dir !== 'close';
  const step = (dt = 0) => {
    const r = tl.advance(dt);
    const radius = open ? r.p : 1 - r.p;
    step.done = r.done; step.p = r.p;
    return { p: r.p, done: r.done, radius, center, dir };
  };
  return controls(step, tl);
}

// --- crossfade: dissolve scene A into scene B ------------------------------
// Returns the two layer weights `a` (outgoing) and `b` (incoming); a + b === 1,
// so the renderer draws A at alpha a over B at alpha b (or blends the two).
export function crossfade({ duration = 0.5, delay = 0, easing = ease.linear } = {}) {
  const tl = timeline({ duration, delay, easing });
  const step = (dt = 0) => {
    const r = tl.advance(dt);
    step.done = r.done; step.p = r.p;
    return { p: r.p, done: r.done, a: 1 - r.p, b: r.p };
  };
  return controls(step, tl);
}

// --- pixelate: block the frame down into chunky pixels ---------------------
// `amount` 0..1 is how pixelated (0 = sharp, 1 = max). dir "out" ramps UP into
// blocks, "in" ramps back to sharp. `blocks` is a convenience axis resolution
// (fewer blocks = coarser) the renderer can feed a downscale/upscale pass.
export function pixelate({ duration = 0.5, dir = 'out', max = 64, min = 4, easing = ease.inOutQuad, delay = 0 } = {}) {
  const tl = timeline({ duration, delay, easing });
  const step = (dt = 0) => {
    const r = tl.advance(dt);
    const amount = dir !== 'in' ? r.p : 1 - r.p;
    const blocks = Math.max(1, Math.round(lerp(max, min, amount)));  // coarser as amount->1
    step.done = r.done; step.p = r.p;
    return { p: r.p, done: r.done, amount, blocks, dir };
  };
  return controls(step, tl);
}

// --- none: an instant cut (no visual, completes on the first step) ---------
// A drop-in placeholder so pair()/config can request "no transition" uniformly.
export function none() {
  const step = () => { step.done = true; step.p = 1; return { p: 1, done: true }; };
  step.replay = () => { step.done = false; return step; };
  step.reset = step.replay;
  step.reverse = () => step;
  step.done = false; step.p = 1;
  return step;
}

// --- pair: compose two transitions into one out->in scene change -----------
// Plays `outT` to completion, fires onSwap ONCE (the moment to swap scenes /
// tear down the old level), then plays `inT`. Reports one blended progress:
// out half maps to 0..0.5, in half to 0.5..1. reverse() runs the whole thing
// backwards (inT reversed, then outT reversed).
export function pair(outT, inT, { onSwap } = {}) {
  let order = [outT, inT];
  let i = 0;
  let swapped = false;
  const step = (dt = 0) => {
    if (i >= order.length) { step.done = true; step.p = 1; return { p: 1, phase: 'done', done: true, out: null, in: null }; }
    const child = order[i];
    const r = child(dt);
    const half = i;                              // 0 = first half, 1 = second half
    let done = false;
    if (r.done) {
      if (i >= order.length - 1) done = true;
      else { i++; if (!swapped && onSwap) onSwap(); swapped = true; }
    }
    const p = done ? 1 : (half + r.p) / order.length;
    step.done = done; step.p = p;
    return {
      p, done,
      phase: done ? 'done' : half === 0 ? 'out' : 'in',
      out: child === outT ? r : null,
      in: child === inT ? r : null,
    };
  };
  step.replay = () => {
    order = [outT, inT]; i = 0; swapped = false;
    outT.replay(); inT.replay();
    step.done = false; step.p = 0; return step;
  };
  step.reset = step.replay;
  step.reverse = () => {                         // whole change, backwards
    outT.reverse(); inT.reverse();
    order = [order[1], order[0]]; i = 0; swapped = false;
    step.done = false; return step;
  };
  step.done = false; step.p = 0;
  return step;
}

export const transitions = {
  fade, wipe, slide, iris, crossfade, pixelate, none, pair,
  timeline, ease, lerp, clamp01,
};
