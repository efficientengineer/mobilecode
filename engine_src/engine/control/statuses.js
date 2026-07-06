// engine/control/statuses.js
// Reusable STATUS-EFFECT components — timed buffs/debuffs that ride ON an entity
// (burn, slow, freeze, poison, stun, haste, weaken), swappable like hazards or
// pickups. A status is decoupled from what causes it: a weapon, a hazard zone, a
// pickup, or a behavior can all attach the same burn().
//
// Each factory returns a status INSTANCE:
//   { kind, apply(e), tick(e, dt) -> { damage?, speedMul?, stunned?, dmgMul?, expired } }
// tick's verdict is PURE DATA — the status never mutates the entity's hp/vel; the
// calling system reads the fields (subtract damage, scale speed by speedMul, skip
// input while stunned, scale outgoing damage by dmgMul) and drops it when expired.
// apply(e) runs once on attach for any on-hit setup (e.g. refresh a stack).
//
// A game rarely ticks statuses by hand — use the helpers:
//   attach(e, statuses.burn())      // push onto e._status (creates the list)
//   const v = step(e, dt)           // tick ALL of e's statuses, drop expired,
//                                   // and AGGREGATE them into one verdict:
//   //   { damage, speedMul, stunned, dmgMul }
// speedMul/dmgMul multiply across every live status (two slows stack), damage
// sums, stunned is OR. One instance is per-entity (state lives in its closure), so
// attach a FRESH status per victim — statuses.burn() each time, not a shared one.

// --- per-instance timer helper: counts `duration` down, flips expired at 0 ---
function timed(duration) {
  let t = duration;
  return {
    step(dt) { t -= dt || 0; return t <= 0; },   // true once spent
    get left() { return t; },
    refresh(d) { if (d > t) t = d; },             // extend to the longer of the two
  };
}

export function burn({ dps = 8, duration = 3 } = {}) {
  // Damage-over-time — fire/ignite. Steady dps while it lasts, dt-scaled so it's
  // frame-rate independent. Re-applying refreshes the timer (see poison to stack).
  const clk = timed(duration);
  return {
    kind: 'burn',
    apply() {},
    tick(e, dt) {
      const expired = clk.step(dt);
      return { damage: dps * (dt || 0), expired };
    },
  };
}

export function slow({ mult = 0.5, duration = 2 } = {}) {
  // Speed debuff — a chill/mire. speedMul (0..1) the movement system multiplies in
  // for `duration` seconds. Two slows on one entity multiply (0.5 * 0.5 = 0.25).
  const clk = timed(duration);
  return {
    kind: 'slow',
    apply() {},
    tick(e, dt) { return { speedMul: mult, expired: clk.step(dt) }; },
  };
}

export function freeze({ duration = 1.5 } = {}) {
  // Hard crowd-control — frozen solid: speedMul 0 (can't move) AND stunned (can't
  // act) for the whole duration. A total lockout, shorter than a slow for balance.
  const clk = timed(duration);
  return {
    kind: 'freeze',
    apply() {},
    tick(e, dt) { return { speedMul: 0, stunned: true, expired: clk.step(dt) }; },
  };
}

export function poison({ dps = 4, duration = 5, stacks = 1 } = {}) {
  // Stacking damage-over-time — venom. Lower dps than burn but re-applying ADDS a
  // stack (up to none-capped) instead of just refreshing, so it ramps the longer a
  // fight drags. Each apply() bumps the count and refreshes the timer.
  const clk = timed(duration);
  let n = Math.max(1, stacks | 0);
  return {
    kind: 'poison',
    apply() { n += 1; clk.refresh(duration); },   // fresh hit = +1 stack, retimer
    tick(e, dt) {
      const expired = clk.step(dt);
      return { damage: dps * n * (dt || 0), expired };
    },
  };
}

export function stun({ duration = 1 } = {}) {
  // Pure lockout — knockdown/flashbang: stunned so a system skips its input/AI, but
  // NOT frozen in place (no speedMul), so knockback/momentum still slides it.
  const clk = timed(duration);
  return {
    kind: 'stun',
    apply() {},
    tick(e, dt) { return { stunned: true, expired: clk.step(dt) }; },
  };
}

export function haste({ mult = 1.5, duration = 4 } = {}) {
  // The one buff — a speed-up (rage/adrenaline). speedMul > 1 for `duration`; it
  // rides the same aggregate as slow, so a haste and a slow cancel toward 1.
  const clk = timed(duration);
  return {
    kind: 'haste',
    apply() {},
    tick(e, dt) { return { speedMul: mult, expired: clk.step(dt) }; },
  };
}

export function weaken({ mult = 0.5, duration = 3 } = {}) {
  // Offense debuff — a curse that softens the entity's OWN hits: dmgMul (0..1) the
  // weapon/health system multiplies into this entity's outgoing damage. Doesn't
  // touch speed, only what it deals out.
  const clk = timed(duration);
  return {
    kind: 'weaken',
    apply() {},
    tick(e, dt) { return { dmgMul: mult, expired: clk.step(dt) }; },
  };
}

// --- helpers -------------------------------------------------------------------

// Attach a status to an entity: run its one-time apply() and push onto e._status
// (created lazily). Returns the status so callers can hold a reference if needed.
export function attach(e, status) {
  if (!e._status) e._status = [];
  status.apply(e);
  e._status.push(status);
  return status;
}

// Tick EVERY status on an entity by dt, drop the expired ones in place, and fold
// the survivors into one verdict the caller applies once:
//   damage summed · speedMul & dmgMul multiplied · stunned OR'd.
// Safe (and cheap) on an entity with no statuses — returns the neutral verdict.
export function step(e, dt) {
  const out = { damage: 0, speedMul: 1, stunned: false, dmgMul: 1 };
  const list = e._status;
  if (!list || !list.length) return out;
  let w = 0;                                        // write index for in-place compaction
  for (let i = 0; i < list.length; i++) {
    const v = list[i].tick(e, dt) || {};
    if (v.damage) out.damage += v.damage;
    if (v.speedMul != null) out.speedMul *= v.speedMul;
    if (v.dmgMul != null) out.dmgMul *= v.dmgMul;
    if (v.stunned) out.stunned = true;
    if (!v.expired) list[w++] = list[i];            // keep the survivors
  }
  list.length = w;                                  // truncate off the expired tail
  return out;
}

export const statuses = {
  burn, slow, freeze, poison, stun, haste, weaken, attach, step,
};
