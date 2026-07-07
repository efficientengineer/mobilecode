// engine/control/melee.js
// Reusable MELEE attack hitboxes — the sword-swing gap weapons.js leaves open
// (that one only spawns projectiles). A melee attack is EDGE-TRIGGERED: press the
// button, a cooldown gates the next press, and a brief ACTIVE window opens during
// which a hitbox in front of the attacker sweeps the world and damages whatever it
// overlaps. Swappable like weapons/abilities — give the player (or an enemy) ONE
// instance and wire it to a button.
//
//   const sword = melee.arc({ range: 1.8, cd: 0.4 });
//   if (attackPressed) sword.trigger();                 // edge: starts a swing if ready
//   for (const h of sword.step(player, dt, enemies, ctx)) // each frame
//     applyDamage(h.target, 10, h.dir);                 // caller owns damage.js
//
// step advances the cooldown + active timers and, WHILE ACTIVE, tests the hitbox
// against `targets` (an array, a registry with .each, or any iterable of entities
// with pos + radius), returning the ones NEWLY hit this swing. Each target is hit
// once per swing (a per-swing Set), so a wide arc can't double-dip on one frame or
// across the active window. The verdict is PURE DATA (like hazards/damage): a hit
// is { target, dir:[x,z], dist, knockback:[x,z] } — melee never mutates the target,
// the caller subtracts hp and adds `knockback` (or `dir`) to the target's velocity.
//
// Facing is the attacker's rot: forward = [sin(rot), cos(rot)] (matches behaviors /
// senses / pathing). Ground plane is XZ. Geometry only — no world/DOM/timers/rng —
// so a sim triggers, steps dt, and asserts who got hit.

const DEG = Math.PI / 180;

// Walk targets whether it's an array, a registry (.each), or any iterable.
function eachTarget(targets, fn) {
  if (!targets) return;
  if (typeof targets.each === 'function') targets.each(fn);
  else if (typeof targets[Symbol.iterator] === 'function') for (const t of targets) fn(t);
}

// Cone/radial test: hit iff within `reach` and inside the ±half wedge (cosHalf =
// cos(half-angle); 360° arc -> cosHalf = -1 so it hits every side). Returns the
// relative distance on a hit, or -1 on a miss.
function coneHit(rx, rz, tr, fx, fz, reach, cosHalf) {
  const d = Math.hypot(rx, rz);
  if (d > reach + tr) return -1;
  if (d < 1e-6) return 0;                       // target sitting on the attacker
  const dot = (rx / d) * fx + (rz / d) * fz;    // cos(angle) between facing and target
  if (dot < cosHalf) return -1;
  return d;
}

// Box test: a narrow forward stab/lane. fwd = projection along facing, side =
// signed perpendicular (right vector = [fz,-fx]). Hit iff in front within reach and
// within the half-width, both padded by the target radius.
function boxHit(rx, rz, tr, fx, fz, reach, halfW) {
  const fwd = rx * fx + rz * fz;
  if (fwd < -tr || fwd > reach + tr) return -1;
  const side = rx * fz - rz * fx;
  if (Math.abs(side) > halfW + tr) return -1;
  return Math.max(0, fwd);
}

// The general factory. cfg.shape picks the hitbox; the named variants below are
// just make() with tuned defaults. Timers: cd gates re-trigger, active is the
// live-hitbox window, delay (slam) is a wind-up before the window opens.
export function make(cfg = {}) {
  const shape = cfg.shape || 'arc';
  const cd = cfg.cd != null ? cfg.cd : 0.4;
  const active = cfg.active != null ? cfg.active : 0.12;
  const delay = cfg.delay != null ? cfg.delay : 0;
  const force = cfg.knockback != null ? cfg.knockback : (shape === 'slam' ? 10 : 6);
  // Geometry params (only the ones the shape uses matter).
  const range = cfg.range != null ? cfg.range : (shape === 'slam' ? 2.5 : 1.8);
  const reach = shape === 'slam' ? (cfg.radius != null ? cfg.radius : range) : range;
  const cosHalf = shape === 'spin' || shape === 'slam'
    ? -1                                        // full 360° whirl / shockwave
    : Math.cos(((cfg.arcDeg != null ? cfg.arcDeg : 100) / 2) * DEG);
  const halfW = (cfg.width != null ? cfg.width : 0.6) / 2;
  const isBox = shape === 'thrust';

  let cool = 0;      // cooldown remaining (0 = ready)
  let win = 0;       // active-window remaining
  let wind = 0;      // wind-up remaining before the window opens
  let hitSet = null; // targets already struck THIS swing

  function trigger() {
    if (cool > 0 || win > 0 || wind > 0) return false;  // gated: cooling or mid-swing
    cool = cd;
    hitSet = new Set();
    if (delay > 0) wind = delay; else win = active;
    return true;
  }

  function step(attacker, dt, targets, ctx) {
    dt = dt || 0;
    if (cool > 0) cool = Math.max(0, cool - dt);
    if (wind > 0) { wind -= dt; if (wind <= 0) win = active; }  // wind-up -> live
    if (win <= 0 || !attacker) return [];

    const rot = attacker.rot || 0;
    const fx = Math.sin(rot), fz = Math.cos(rot);
    const ax = attacker.pos[0], az = attacker.pos[2];
    const hits = [];
    eachTarget(targets, (t) => {
      if (!t || t === attacker || t.dead || !t.pos || hitSet.has(t)) return;
      const rx = t.pos[0] - ax, rz = t.pos[2] - az, tr = t.radius || 0;
      const d = isBox
        ? boxHit(rx, rz, tr, fx, fz, reach, halfW)
        : coneHit(rx, rz, tr, fx, fz, reach, cosHalf);
      if (d < 0) return;
      hitSet.add(t);
      const l = Math.hypot(rx, rz) || 1;
      const dir = l > 1e-6 ? [rx / l, rz / l] : [fx, fz];  // push out; facing if on top
      hits.push({ target: t, dir, dist: d, knockback: [dir[0] * force, dir[1] * force] });
    });
    win -= dt;
    return hits;
  }

  // Introspection for HUD / gating (cooldown ring, "is the blade live?").
  step.ready = trigger.ready = () => cool <= 0 && win <= 0 && wind <= 0;
  return { trigger, step, ready: step.ready };
}

// The classic sword slash: a cone in the facing direction. Wide enough to catch a
// target you're roughly pointing at, brief enough to demand timing.
export function arc({ range = 1.6, arcDeg = 100, cd = 0.4, active = 0.12, knockback } = {}) {
  return make({ shape: 'arc', range, arcDeg, cd, active, knockback });
}

// A narrow forward stab/spear — long reach, thin lane. Rewards lining the enemy up;
// misses anything off to the side.
export function thrust({ range = 2.2, width = 0.6, cd = 0.4, active = 0.12, knockback } = {}) {
  return make({ shape: 'thrust', range, width, cd, active, knockback });
}

// The spin attack: a 360° whirl hitting everything around the attacker within
// `range`. Long cooldown — a crowd-clearing panic button.
export function spin({ range = 1.8, cd = 0.8, active = 0.15, knockback } = {}) {
  return make({ shape: 'spin', range, cd, active, knockback });
}

// Ground slam: a radial shockwave that lands AFTER a `delay` wind-up (the leap /
// hammer-raise telegraph), then flattens everyone in `radius`. Big knockback.
export function groundSlam({ radius = 2.5, delay = 0.2, active = 0.12, cd = 1, knockback } = {}) {
  return make({ shape: 'slam', radius, delay, active, cd, knockback });
}

export const melee = { make, arc, thrust, spin, groundSlam };
