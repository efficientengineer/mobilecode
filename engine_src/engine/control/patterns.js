// engine/control/patterns.js
// Reusable bullet-hell EMITTER patterns — the "danmaku brain" for an enemy or
// boss, swappable like weapons/behaviors. This is NOT the player's gun
// (weapons.js): those are input-driven ("what a shot is when the player fires");
// these are TIME-driven ("what a hostile spews on its own"). Each factory returns
// a stateful stepper:
//   step(dt, ctx) -> shots[]        // the directions to fire THIS tick (usually [])
// where each shot is  { dir:[x,z], speed? }  (dir is a unit XZ vector) and `ctx`
// may carry  ctx.aimDir  (unit vector toward the player) for player-tracking fans.
// A game gives an enemy one and steps it each frame, spawning whatever comes back:
//   e.pattern = patterns.spiral({ count: 3 });
//   const shots = e.pattern(dt, { aimDir });   // in a small fire system
// Per-instance state (angles, timers) lives in the closure, so every enemy needs
// its own instance — build one per emitter, not one shared module-wide.

// Angle → unit XZ dir. Matches weapons.radial / facing math (rot = atan2(x,z)).
function dirAt(a) { return [Math.sin(a), Math.cos(a)]; }
// Rotate a unit XZ vector by `a` radians (ground plane).
function rot([x, z], a) {
  const c = Math.cos(a), s = Math.sin(a);
  return [x * c - z * s, x * s + z * c];
}
// Base angle of ctx.aimDir (toward player), or 0 if none supplied.
function aimAngle(ctx) {
  const a = ctx && ctx.aimDir;
  return a && (a[0] || a[1]) ? Math.atan2(a[0], a[1]) : 0;
}
const DEG = Math.PI / 180;

export function ring({ count = 12, cooldown = 1, speed, offset = 0 } = {}) {
  // Full-circle burst: `count` bullets spaced evenly around 360°, every
  // `cooldown` seconds. The bread-and-butter "flower" wall. `offset` rotates the
  // whole ring so successive emitters can be staggered.
  let cd = 0;
  return (dt, ctx) => {
    cd -= dt || 0;
    if (cd > 0) return [];
    cd = cooldown;
    const base = offset + aimAngle(ctx) * 0; // ring ignores aim, but keep ctx read cheap
    const shots = [];
    for (let i = 0; i < count; i++) shots.push({ dir: dirAt(base + (i / count) * Math.PI * 2), speed });
    return shots;
  };
}

export function spiral({ count = 3, turn = 0.3, rate = 0.08, speed } = {}) {
  // Rotating streams: on each tick (every `rate` s) fire `count` evenly-spread
  // arms, then advance the base angle by `turn` radians so the arms trace
  // spinning spokes — the classic boss spiral. Small `rate` = dense; `turn`
  // controls curl (negative reverses the sweep).
  let t = 0, ang = 0;
  return (dt) => {
    t -= dt || 0;
    if (t > 0) return [];
    t = rate;
    const shots = [];
    for (let i = 0; i < count; i++) shots.push({ dir: dirAt(ang + (i / count) * Math.PI * 2), speed });
    ang += turn;
    return shots;
  };
}

export function aimedSpread({ count = 5, arcDeg = 40, cooldown = 0.8, speed } = {}) {
  // A fan of `count` bullets across `arcDeg`, centered on ctx.aimDir (the player),
  // every `cooldown` seconds. Aggressive, readable pressure that tracks you —
  // sidestep it. With no aimDir it fires straight ahead (+Z).
  let cd = 0;
  const arc = arcDeg * DEG;
  return (dt, ctx) => {
    cd -= dt || 0;
    if (cd > 0) return [];
    cd = cooldown;
    const center = dirAt(aimAngle(ctx));
    const shots = [];
    for (let i = 0; i < count; i++) {
      const f = count === 1 ? 0.5 : i / (count - 1);   // 0..1 across the arc
      shots.push({ dir: rot(center, (f - 0.5) * arc), speed });
    }
    return shots;
  };
}

export function spinner({ arms = 4, rate = 0.05, spin = 2, speed } = {}) {
  // Continuous rotating arms: `arms` spokes that sweep smoothly at `spin`
  // radians/second (time-based, unlike spiral's per-shot step), emitting a bullet
  // per arm every `rate` s. Lay a slow, hypnotic pinwheel across the arena.
  let t = 0, ang = 0;
  return (dt) => {
    dt = dt || 0;
    ang += spin * dt;               // sweep advances with real time
    t -= dt;
    if (t > 0) return [];
    t = rate;
    const shots = [];
    for (let i = 0; i < arms; i++) shots.push({ dir: dirAt(ang + (i / arms) * Math.PI * 2), speed });
    return shots;
  };
}

export function pulse({ count = 16, every = 2, pulses = 3, gap = 0.12, twist = 0.2, speed } = {}) {
  // Timed ring pulses: a SALVO of `pulses` quick rings (each `count` wide, spaced
  // by `gap` s and rotated `twist` radians from the last for an interleaved
  // flower), then a long `every`-second lull before the next salvo. Reads as a
  // heartbeat: bomp-bomp-bomp … wait … bomp-bomp-bomp.
  let rest = 0, left = 0, timer = 0, ang = 0;
  return (dt) => {
    dt = dt || 0;
    if (left <= 0) {                // resting between salvos
      rest -= dt;
      if (rest > 0) return [];
      left = Math.max(1, pulses); timer = 0;   // begin a salvo
    }
    timer -= dt;
    if (timer > 0) return [];
    timer = gap; left -= 1;
    const shots = [];
    for (let i = 0; i < count; i++) shots.push({ dir: dirAt(ang + (i / count) * Math.PI * 2), speed });
    ang += twist;
    if (left <= 0) rest = every;    // salvo done → long lull
    return shots;
  };
}

export const patterns = { ring, spiral, aimedSpread, spinner, pulse };
