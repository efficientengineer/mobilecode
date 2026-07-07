// engine/control/ailments.js
// TURN / ATB STATUS AILMENTS — the battle-side status effects an FF6-style fight
// needs (poison, sleep, confuse, haste, stop, petrify…), the turn-based sibling of
// the real-time statuses.js. statuses.js rides an action-game entity and speaks in
// speedMul/stunned; THIS speaks the ATB's language: it MULTIPLIES the gauge fill
// (haste=2, slow=0.5, stop=0), ticks damage/heal OVER TIME (poison/regen/sap), and
// is CONSULTED WHEN A UNIT BECOMES READY to decide skip / forced action / blocked
// magic. Compose with battle.js (feed gaugeRate into setRate, honor skip/forceAction
// on a ready unit) and stats.js (apply the tick damage) — this file does NO hp math
// and imports nothing: units are plain stat blocks passed in, rng is never needed.
//
//   attach(unit, ailments.poison({ dps: 12 }));
//   const a = step(unit, dt);                 // { damage, gaugeRate, skip, blockMagic, reflect, out }
//   battle.setRate(unit.id, a.gaugeRate);     // haste/slow/stop drive the ATB gauge
//   if (a.damage) unit.damage(a.damage);      // poison/sap hurt, regen heals (negative)
//   // when the unit is READY to act:
//   const r = ready(unit); if (r.skip) skipTurn(); else if (r.forceAction) auto(r.forceAction);
//
// An ailment is DATA + BEHAVIOR: { kind, gaugeRate, reflect, out, duration, remaining,
// expired, curedBy, onTick(unit,dt)->{damage?}, onReady(unit)->{skip?,forceAction?,
// blockMagic?,out?} }. Per-unit ailments live on unit._ail (an array), so one preset
// factory call = one fresh ailment per victim (state in its own object, no globals).

// Build one ailment from a kind + config. gaugeRate multiplies ATB fill (default 1,
// unaffected); duration is seconds of battle time (Infinity = lasts until cured, the
// JRPG default) counted down by step(); onTick/onReady are the DoT and ready hooks.
export function makeAilment(kind, cfg = {}) {
  const dur = cfg.duration == null ? Infinity : cfg.duration;
  const a = {
    kind,
    duration: dur,                                   // full span (for refresh)
    remaining: dur,                                  // live countdown
    gaugeRate: cfg.gaugeRate == null ? 1 : cfg.gaugeRate,
    reflect: !!cfg.reflect,                           // bounce magic back at caster
    out: !!cfg.out,                                   // removed from the fight (petrify)
    curedBy: cfg.curedBy ? cfg.curedBy.slice() : [],  // remedy/item/'hit' tags that clear it
    expired: false,
    onTick(unit, dt) { return cfg.onTick ? cfg.onTick(unit, dt) : null; },
    onReady(unit) { return cfg.onReady ? cfg.onReady(unit) : null; },
    refresh(d) { a.remaining = d == null ? a.duration : d; a.expired = false; return a; },
  };
  return a;
}

// ---- Presets (sensible FF6 defaults; override any field via cfg) --------------

// DoT: flat damage per second, ticked by dt. The bread-and-butter poison.
export function poison({ dps = 12, duration = Infinity } = {}) {
  return makeAilment('poison', {
    duration, curedBy: ['antidote', 'poisona', 'remedy', 'esuna', 'dispel'],
    onTick: (u, dt) => ({ damage: dps * dt }),
  });
}

// Reverse DoT: heals over time (negative damage folds through as healing).
export function regen({ hps = 10, duration = Infinity } = {}) {
  return makeAilment('regen', {
    duration, curedBy: ['dispel'],
    onTick: (u, dt) => ({ damage: -hps * dt }),
  });
}

// Sap: percentage HP drain per second — chips even the tanky (scales with maxHp).
export function sap({ frac = 0.03, duration = Infinity } = {}) {
  return makeAilment('sap', {
    duration, curedBy: ['remedy', 'esuna', 'dispel'],
    onTick: (u, dt) => ({ damage: (u.maxHp || 0) * frac * dt }),
  });
}

// Sleep: skip every turn until woken. A hit clears it (curedBy 'hit' -> wake()).
export function sleep({ duration = Infinity } = {}) {
  return makeAilment('sleep', {
    duration, curedBy: ['hit', 'alarm', 'remedy', 'esuna'],
    onReady: () => ({ skip: true }),
  });
}

// Muddle / confuse: on your turn, auto-attack a RANDOM target (foe or friend). A
// physical hit snaps you out of it (curedBy 'hit').
export function muddle({ duration = Infinity } = {}) {
  return makeAilment('muddle', {
    duration, curedBy: ['hit', 'remedy', 'esuna'],
    onReady: () => ({ forceAction: { kind: 'attack', target: 'random' } }),
  });
}
export const confuse = muddle;                       // alias

// Berserk: rage — forced to attack a random ENEMY, no commands, no magic.
export function berserk({ duration = Infinity } = {}) {
  return makeAilment('berserk', {
    duration, curedBy: ['remedy', 'esuna'],
    onReady: () => ({ forceAction: { kind: 'attack', target: 'random-enemy' }, blockMagic: true }),
  });
}

// Silence / mute: magic commands are locked out (physical still works).
export function silence({ duration = Infinity } = {}) {
  return makeAilment('silence', {
    duration, curedBy: ['echo', 'remedy', 'esuna'],
    onReady: () => ({ blockMagic: true }),
  });
}
export const mute = silence;                          // alias

// Haste: ATB gauge fills at double rate. Cancels against slow.
export function haste({ mult = 2, duration = Infinity } = {}) {
  return makeAilment('haste', { duration, gaugeRate: mult, curedBy: ['dispel', 'slow'] });
}

// Slow: ATB gauge fills at half rate. Cancels against haste.
export function slow({ mult = 0.5, duration = Infinity } = {}) {
  return makeAilment('slow', { duration, gaugeRate: mult, curedBy: ['dispel', 'haste'] });
}

// Stop: the gauge freezes (rate 0) — the unit can never become ready; also skips if
// it somehow was already ready. A hard, timed lockout in FF6.
export function stop({ duration = 6 } = {}) {
  return makeAilment('stop', {
    duration, gaugeRate: 0, curedBy: ['remedy'],
    onReady: () => ({ skip: true }),
  });
}

// Petrify / stone: turned to stone — out of the fight (gauge frozen, turns skipped)
// until cured. `out` lets a battle count petrified allies toward a party wipe.
export function petrify({ duration = Infinity } = {}) {
  return makeAilment('petrify', {
    duration, gaugeRate: 0, out: true,
    curedBy: ['goldneedle', 'softpotion', 'stona', 'remedy', 'esuna'],
    onReady: () => ({ skip: true, out: true }),
  });
}
export const stone = petrify;                         // alias

// Reflect: bounces single-target magic back at the caster — exposed as a flag the
// spell resolver reads (this file doesn't route the bounce, only advertises it).
export function reflect({ duration = Infinity } = {}) {
  return makeAilment('reflect', { duration, reflect: true, curedBy: ['dispel'] });
}

// ---- Attach / step / cure helpers (drive unit._ail) ---------------------------

// Put an ailment on a unit. No duplicate of the same KIND — a re-apply just refreshes
// the existing one's duration (FF6 re-poisoning resets the clock). Returns the live
// ailment on the unit (the refreshed one when it was already present).
export function attach(unit, ailment) {
  const list = unit._ail || (unit._ail = []);
  const existing = list.find((a) => a.kind === ailment.kind);
  if (existing) { existing.refresh(ailment.remaining); return existing; }
  list.push(ailment);
  return ailment;
}

// Advance ALL of a unit's ailments by dt and fold them into ONE verdict:
//   damage    — summed DoT this tick (negative = net healing from regen)
//   gaugeRate — PRODUCT of every rate (haste*slow, stop -> 0) for battle.setRate
//   skip / blockMagic / reflect / out — OR'd across the whole set
//   forceAction — the first forced move (confuse/berserk), if any
// Expired ailments (remaining <= 0) are DROPPED in place; `expired` lists their kinds.
export function step(unit, dt = 0) {
  const agg = { damage: 0, gaugeRate: 1, skip: false, blockMagic: false, reflect: false, out: false, forceAction: null, expired: [] };
  const list = unit._ail;
  if (!list || !list.length) return agg;
  const survivors = [];
  for (const a of list) {
    const t = a.onTick(unit, dt);
    if (t && t.damage) agg.damage += t.damage;
    agg.gaugeRate *= (a.gaugeRate == null ? 1 : a.gaugeRate);
    if (a.reflect) agg.reflect = true;
    if (a.out) agg.out = true;
    foldReady(agg, a.onReady(unit));
    a.remaining -= dt;                                // Infinity - dt stays Infinity
    if (a.remaining <= 0) { a.expired = true; agg.expired.push(a.kind); }
    else survivors.push(a);
  }
  unit._ail = survivors;
  return agg;
}

// Consult a unit's ailments AT THE MOMENT IT IS READY to act (no time passes): does
// it skip, is its command forced, is magic blocked? Same OR/first-wins fold as step
// but without ticking DoT or aging — call it exactly when the gauge fills.
export function ready(unit) {
  const agg = { skip: false, blockMagic: false, reflect: false, out: false, forceAction: null };
  const list = unit._ail;
  if (!list) return agg;
  for (const a of list) {
    if (a.reflect) agg.reflect = true;
    if (a.out) agg.out = true;
    foldReady(agg, a.onReady(unit));
  }
  return agg;
}

function foldReady(agg, r) {
  if (!r) return;
  if (r.skip) agg.skip = true;
  if (r.blockMagic) agg.blockMagic = true;
  if (r.out) agg.out = true;
  if (r.forceAction && !agg.forceAction) agg.forceAction = r.forceAction;
}

// The current gauge-rate multiplier from all ailments (product) — a shortcut when you
// only need to update the ATB rate without ticking damage. stop/petrify -> 0.
export function gaugeRate(unit) {
  const list = unit._ail;
  if (!list) return 1;
  let r = 1;
  for (const a of list) r *= (a.gaugeRate == null ? 1 : a.gaugeRate);
  return r;
}

// Cure by KIND ('sleep') or by any CURE TAG an ailment lists in curedBy ('remedy',
// 'esuna', 'dispel', 'goldneedle'…). Returns whether anything was removed.
export function cure(unit, key) {
  const list = unit._ail;
  if (!list) return false;
  const before = list.length;
  unit._ail = list.filter((a) => a.kind !== key && !a.curedBy.includes(key));
  return unit._ail.length < before;
}

// A landed physical hit wakes/snaps the unit: clear everything curedBy 'hit' (sleep,
// muddle/confuse). Returns whether anything cleared.
export function wake(unit) { return cure(unit, 'hit'); }

export function has(unit, kind) { return !!(unit._ail && unit._ail.some((a) => a.kind === kind)); }
export function get(unit, kind) { return (unit._ail && unit._ail.find((a) => a.kind === kind)) || null; }
export function list(unit) { return unit._ail ? unit._ail.slice() : []; }
export function clear(unit) { unit._ail = []; }

export const ailments = {
  makeAilment,
  poison, regen, sap, sleep, muddle, confuse, berserk, silence, mute,
  haste, slow, stop, petrify, stone, reflect,
  attach, step, ready, gaugeRate, cure, wake, has, get, list, clear,
};
