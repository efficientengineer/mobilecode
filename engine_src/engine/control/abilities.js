// engine/control/abilities.js
// Reusable ABILITY components — activatable player powers with cooldowns and
// durations, swappable like weapons/movements. DISTINCT from movements.js: that is
// continuous locomotion driven every frame by the input stick; an ability is a
// DISCRETE, one-shot action (a button/tap) that fires once, then locks out for a
// cooldown and (some) run an effect for a bounded duration.
//
// Each factory returns a per-instance ability:
//   { ready(), trigger(entity, dir, ctx) -> bool, tick(entity, dt) -> state }
// - ready()                is the cooldown spent? (can I fire now?)
// - trigger(e, dir, ctx)   fire IF ready(): apply the effect, start the cooldown,
//                          return true; return false (no-op) when still cooling.
// - tick(e, dt)            advance cooldown + active timers every frame, apply any
//                          per-frame effect (dash velocity, shield/invuln countdown)
//                          and return a STATE snapshot the HUD/loop can read:
//                          { ready, cooldown, active, ... }.
// `dir` is an XZ aim vector [x,z]; when omitted/zero the ability falls back to the
// entity's facing (rot -> [sin,cos], the engine's facing convention).
//
// Per-instance state lives in the closure, so use ONE ability instance PER player
// (a shared instance would share the cooldown). Pure + node-safe: no globals, no
// Math.random, no timers — sim-test by stepping tick(dt) and asserting ready()/state.
//
// INTEGRATION: tick abilities AFTER movement.js each frame so a dash's velocity
// overrides the input-driven velocity for its brief window. Effects surface as
// plain entity fields (e.invuln, e.shield) or state (shockwave, timescale) that a
// tiny game system / the loop reads — the ability never reaches outside itself.

// Resolve an aim direction: use the passed XZ vector if it has length, else fall
// back to the entity's facing (rot). Returns a unit [x,z] (or [0,0] if truly none).
function resolveDir(e, dir) {
  const x = (dir && dir[0]) || 0, z = (dir && dir[1]) || 0;
  const l = Math.hypot(x, z);
  if (l > 1e-6) return [x / l, z / l];
  if (e && typeof e.rot === 'number') return [Math.sin(e.rot), Math.cos(e.rot)];
  return [0, 0];
}

export function dash({ distance = 6, cd = 1, dashTime = 0.15 } = {}) {
  // Burst of velocity along `dir` — a quick evasive lunge. Covers `distance` units
  // over `dashTime` seconds (speed = distance/dashTime), driving e.vel each active
  // frame so it overrides normal locomotion, then hands control back to movement.
  const speed = distance / dashTime;
  let cool = 0, active = 0, dir = [0, 0];
  return {
    ready: () => cool <= 0,
    trigger(e, aim) {
      if (cool > 0) return false;
      dir = resolveDir(e, aim);
      active = dashTime; cool = cd;
      e.vel[0] = dir[0] * speed; e.vel[1] = 0; e.vel[2] = dir[1] * speed; // instant kick
      return true;
    },
    tick(e, dt) {
      dt = dt || 0;
      if (cool > 0) cool -= dt;
      if (active > 0) {                    // keep driving the burst (wins over movement)
        e.vel[0] = dir[0] * speed; e.vel[1] = 0; e.vel[2] = dir[1] * speed;
        active -= dt;
      }
      return { ready: cool <= 0, cooldown: Math.max(0, cool), active: active > 0, dashing: active > 0 };
    },
  };
}

export function dodgeRoll({ distance = 5, iframes = 0.4, cd = 0.8, rollTime = 0.25 } = {}) {
  // A dash WITH an invulnerability window — the roll-through-the-attack dodge. Moves
  // like dash but also opens `iframes` seconds of e.invuln (a countdown the health
  // system checks before applying damage). Shorter distance, snappy cooldown.
  const speed = distance / rollTime;
  let cool = 0, active = 0, dir = [0, 0];
  return {
    ready: () => cool <= 0,
    trigger(e, aim) {
      if (cool > 0) return false;
      dir = resolveDir(e, aim);
      active = rollTime; cool = cd;
      e.invuln = Math.max(e.invuln || 0, iframes);     // open the i-frame window
      e.vel[0] = dir[0] * speed; e.vel[1] = 0; e.vel[2] = dir[1] * speed;
      return true;
    },
    tick(e, dt) {
      dt = dt || 0;
      if (cool > 0) cool -= dt;
      if (e.invuln > 0) { e.invuln -= dt; if (e.invuln < 0) e.invuln = 0; }
      if (active > 0) {
        e.vel[0] = dir[0] * speed; e.vel[1] = 0; e.vel[2] = dir[1] * speed;
        active -= dt;
      }
      return {
        ready: cool <= 0, cooldown: Math.max(0, cool),
        active: active > 0, rolling: active > 0, invuln: e.invuln || 0,
      };
    },
  };
}

export function blink({ range = 8, cd = 3 } = {}) {
  // Instant teleport by dir*range — no travel, no i-frames, just gone-and-there.
  // A long cooldown balances the raw repositioning power. Mutates e.pos on trigger.
  let cool = 0;
  return {
    ready: () => cool <= 0,
    trigger(e, aim) {
      if (cool > 0) return false;
      const d = resolveDir(e, aim);
      e.pos[0] += d[0] * range; e.pos[2] += d[1] * range;
      cool = cd;
      return true;
    },
    tick(e, dt) {
      dt = dt || 0;
      if (cool > 0) cool -= dt;
      return { ready: cool <= 0, cooldown: Math.max(0, cool), active: false };
    },
  };
}

export function shieldAbility({ duration = 3, cd = 6 } = {}) {
  // Raise a temporary shield — sets e.shield to a seconds-remaining timer the health
  // system reads before applying damage (like the shield pickup, but on a cooldown
  // you control). tick counts e.shield down and clears it when the duration ends.
  let cool = 0, active = 0;
  return {
    ready: () => cool <= 0,
    trigger(e) {
      if (cool > 0) return false;
      active = duration; cool = cd;
      e.shield = Math.max(e.shield || 0, duration);
      return true;
    },
    tick(e, dt) {
      dt = dt || 0;
      if (cool > 0) cool -= dt;
      if (active > 0) {
        active -= dt;
        e.shield = Math.max(0, active);
      }
      return { ready: cool <= 0, cooldown: Math.max(0, cool), active: active > 0, shield: e.shield || 0 };
    },
  };
}

export function groundPound({ cd = 2, radius = 5, force = 12, damage = 20 } = {}) {
  // Slam the ground and MARK a shockwave request — the ability itself is pure, so it
  // just describes the blast ({ pos, radius, force, damage }); the game reads it off
  // the tick state ONCE (surfaced the frame after trigger, then cleared) and does
  // the AoE (knock enemies out by `force`, deal `damage` inside `radius`).
  let cool = 0, pending = null;
  return {
    ready: () => cool <= 0,
    trigger(e) {
      if (cool > 0) return false;
      cool = cd;
      pending = { pos: [e.pos[0], e.pos[1], e.pos[2]], radius, force, damage };
      return true;
    },
    tick(e, dt) {
      dt = dt || 0;
      if (cool > 0) cool -= dt;
      const shockwave = pending; pending = null;     // hand off the request exactly once
      return { ready: cool <= 0, cooldown: Math.max(0, cool), active: false, shockwave };
    },
  };
}

export function timeSlow({ factor = 0.4, duration = 2, cd = 8 } = {}) {
  // Bullet-time — REPORT a timescale (0..1) the loop multiplies into the sim's dt
  // while active, then back to 1. The ability owns only the timer + verdict; the
  // loop decides what to scale. Tick this with REAL dt (not the slowed dt) so the
  // cooldown runs in wall time.
  let cool = 0, active = 0;
  return {
    ready: () => cool <= 0,
    trigger(e) {
      if (cool > 0) return false;
      active = duration; cool = cd;
      return true;
    },
    tick(e, dt) {
      dt = dt || 0;
      if (cool > 0) cool -= dt;
      if (active > 0) active -= dt;
      const on = active > 0;
      return { ready: cool <= 0, cooldown: Math.max(0, cool), active: on, timescale: on ? factor : 1 };
    },
  };
}

export const abilities = {
  dash, dodgeRoll, blink, shieldAbility, groundPound, timeSlow,
};
