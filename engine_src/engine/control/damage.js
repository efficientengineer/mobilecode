// engine/control/damage.js
// Reusable DAMAGE RESOLUTION — the layer between "a hit landed" and the raw hp
// subtraction the health system does. A game composes a handful of MODIFIERS into
// one policy and asks it what a hit is actually worth:
//   resolve(base, cfg, ctx) -> { amount, crit, knockback:[x,z]|null, tags, heal, pierce }
// `base` is the nominal damage (weapon/enemy stat), `cfg` is a composed modifier
// (or an array / single modifier), and `ctx` carries the encounter: attacker &
// target positions and an rng. The verdict is PURE DATA — resolve never touches
// the entities; the caller subtracts `amount`, adds `knockback` to the target's
// vel, heals the attacker by `heal`, and lets the bullet survive `pierce-1` more
// hits. Pick a game-wide policy in bootstrap, or one per weapon:
//   ctx.damage = damage.compose(damage.crit(), damage.armor({ resist: 0.2 }))
//
// Deterministic: every random branch draws from ctx.rng, so a sim seeds it and
// asserts exact numbers. No globals, no timers, no Math.random.

const num = (v, d) => (typeof v === 'number' && !isNaN(v) ? v : d);
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

// Read a ground-plane [x,z] from an entity, a [x,y,z], or a [x,z]. Entities store
// pos as [x,y,z]; a bare 2-vector is taken as [x,z].
function xz(p) {
  if (!p) return null;
  const a = p.pos || p;                       // accept an entity or a raw array
  if (!a || a.length == null) return null;
  return a.length >= 3 ? [a[0], a[2]] : [a[0], a[1]];
}
// The attacker->target endpoints, from either explicit ctx.from/ctx.to or entities.
function ends(ctx) {
  const from = xz(ctx.from) || xz(ctx.attacker);
  const to = xz(ctx.to) || xz(ctx.target);
  return { from, to };
}
function tag(res, t) { if (res.tags.indexOf(t) < 0) res.tags.push(t); }

// A MODIFIER is (res, ctx) => void, mutating the running verdict. Each factory
// below returns one. They are order-sensitive (compose applies left to right):
// put multipliers (crit, falloff) before reducers (armor), and lifesteal last so
// it reads the final dealt amount.

export function crit({ chance = 0.15, mult = 2 } = {}) {
  // Random critical hit: roll ctx.rng, and on success multiply the damage and
  // flag it (for a bigger number / louder sound). No rng -> never crits.
  return (res, ctx) => {
    const r = ctx.rng;
    if (!r || res.crit) return;                // already crit or nothing to roll
    if (r.next() < clamp(chance, 0, 1)) { res.amount *= mult; res.crit = true; tag(res, 'crit'); }
  };
}

export function armor({ flat = 0, resist = 0 } = {}) {
  // Target's defense: subtract `flat` then scale by (1-`resist`) (0..1). Never
  // drops below zero. Models plate (flat) vs. damage-type resistance (percent).
  return (res) => {
    const before = res.amount;
    res.amount = Math.max(0, (res.amount - flat) * (1 - clamp(resist, 0, 1)));
    if (res.amount < before) tag(res, 'armored');
  };
}

export function knockback({ force = 6 } = {}) {
  // Shove the target away from the attacker: a unit push from `from` to `to`,
  // scaled by `force`. Reports [x,z] the caller adds to the target's velocity.
  return (res, ctx) => {
    const { from, to } = ends(ctx);
    if (!from || !to) return;
    let dx = to[0] - from[0], dz = to[1] - from[1];
    const l = Math.hypot(dx, dz);
    if (!l) return;                            // stacked on top of each other
    res.knockback = [(dx / l) * force, (dz / l) * force];
    tag(res, 'knockback');
  };
}

export function falloff({ near = 0, far = 20, min = 0 } = {}) {
  // Range attenuation: full damage within `near`, fading to `min` fraction at
  // `far` and beyond. Needs attacker & target positions; a no-op without them.
  const lo = num(near, 0), hi = Math.max(lo + 1e-6, num(far, 20)), floor = clamp(min, 0, 1);
  return (res, ctx) => {
    const { from, to } = ends(ctx);
    if (!from || !to) return;
    const d = Math.hypot(to[0] - from[0], to[1] - from[1]);
    const t = clamp((d - lo) / (hi - lo), 0, 1);   // 0 near -> 1 far
    const k = 1 - t * (1 - floor);
    if (k < 1) { res.amount *= k; tag(res, 'falloff'); }
  };
}

export function lifesteal({ frac = 0.5 } = {}) {
  // Heal the attacker for a fraction of damage actually dealt. Reports `heal`;
  // the caller adds it to the attacker's hp. Best placed LAST so it sees armor.
  return (res) => {
    const h = res.amount * Math.max(0, frac);
    if (h > 0) { res.heal += h; tag(res, 'lifesteal'); }
  };
}

export function pierce({ count = 1 } = {}) {
  // Declare how many targets one hit passes through (a spear/rail shot). The
  // caller keeps the projectile alive for `pierce-1` further collisions.
  const n = Math.max(1, Math.floor(num(count, 1)));
  return (res) => { res.pierce = n; if (n > 1) tag(res, 'pierce'); };
}

// Fold modifiers into one policy. Accepts modifiers, arrays of them, or nested
// composes; flattens and skips falsy so `compose(a, cond && b)` is safe.
export function compose(...mods) {
  const flat = [];
  const push = (m) => { if (!m) return; Array.isArray(m) ? m.forEach(push) : flat.push(m); };
  mods.forEach(push);
  const fn = (res, ctx) => { for (const m of flat) m(res, ctx); };
  fn.mods = flat;                              // let resolve/compose see the chain
  return fn;
}

// The one call a game makes. `cfg` may be a composed policy, an array of
// modifiers, a single modifier, or null (base damage passes straight through).
export function resolve(base, cfg, ctx = {}) {
  const res = { amount: num(base, 0), crit: false, knockback: null, tags: [], heal: 0, pierce: 1 };
  const mods = !cfg ? [] : (typeof cfg === 'function' ? (cfg.mods || [cfg]) : (Array.isArray(cfg) ? cfg : [cfg]));
  for (const m of mods) if (typeof m === 'function') m(res, ctx);
  res.amount = Math.max(0, res.amount);        // hits never heal the target
  return res;
}

export const damage = { resolve, compose, crit, armor, knockback, falloff, lifesteal, pierce };
