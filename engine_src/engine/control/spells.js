// engine/control/spells.js
// Reusable SPELL / ABILITY definitions + a cast resolver for TURN-BASED combat
// (ATB/menu battles), the JRPG counterpart to weapons.js. A spell is DATA:
//   { name, mp, power, element?, kind, target, status?, statusChance?, hits=1 }
//   kind    : "attack"|"magic"|"heal"|"revive"|"drain"|"buff"|"debuff"|"status"
//   target  : "one-enemy"|"all-enemies"|"one-ally"|"all-allies"|"self"|"ally-row"|"random-enemy"
//
// makeSpellbook(defs) indexes the data; targets() resolves the target scope; cast()
// spends the caster's MP (fails if short) and applies each hit's effect. The actual
// numbers come from an INJECTED resolver (ctx.resolve) so spells.js never hard-depends
// on a damage-formula module — pass your own, or lean on the sensible default below.
// Pure, deterministic (inject rng), node-testable on plain stat objects.

// --- helpers -------------------------------------------------------------
// rng may be a fn () -> 0..1 OR a core makeRng() with .next(); normalize to a roll.
function roll(rng) { return !rng ? 0 : typeof rng === 'function' ? rng() : rng.next ? rng.next() : 0; }
function has(list, x) { return Array.isArray(list) && x != null && list.indexOf(x) !== -1; }
function isKO(u) { return !!u && (u.dead === true || (u.hp != null && u.hp <= 0)); }
function isHeal(sp) { return sp.kind === 'heal'; }
function maxHpOf(u) { return u.maxHp != null ? u.maxHp : u.hpMax != null ? u.hpMax : u.hp != null ? u.hp : 0; }

// Element vs target defenses: absorb flips to healing, immune nullifies, weak x2, resist x0.5.
function elementMul(sp, target) {
  const el = sp.element;
  if (!el) return 1;
  if (has(target.absorb, el)) return -1;
  if (has(target.immune, el)) return 0;
  if (has(target.weak, el)) return 2;
  if (has(target.resist, el)) return 0.5;
  return 1;
}

// Default per-target formula when no ctx.resolve is supplied. Returns raw magnitude
// (always >= 0 except element absorb, which is negative = healing); cast() decides how
// to spend it based on spell.kind. Physical uses atk/def, magic uses mag/mdef.
export function defaultResolve(caster, sp, target, ctx = {}) {
  const rng = ctx.rng;
  const magic = sp.kind !== 'attack';
  const pow = (sp.power || 0) + (magic ? (caster.mag || caster.mat || 0) : (caster.atk || caster.str || 0));
  // Support spells never touch defense/element/miss.
  if (isHeal(sp) || sp.kind === 'buff' || sp.kind === 'debuff' || sp.kind === 'status') {
    return { amount: Math.max(0, Math.round(pow)), crit: false, missed: false };
  }
  const def = sp.kind === 'attack' ? (target.def || target.vit || 0) : (target.mdef || target.res || 0);
  let amount = Math.max(1, pow - def) * elementMul(sp, target);
  const missed = roll(rng) < (sp.missChance || 0);
  const crit = !missed && roll(rng) < (sp.crit || 0.05);
  if (crit) amount *= 2;
  return { amount: missed ? 0 : Math.round(amount), crit, missed };
}

// Roll an optional rider status (poison/blind/sleep...). Pure data: pushes the status
// NAME onto target.statuses so a battle system attaches the real timed effect later.
function applyStatus(target, sp, ctx) {
  if (!sp.status) return null;
  const chance = sp.statusChance != null ? sp.statusChance : 1;
  if (roll(ctx.rng) >= chance) return null;
  (target.statuses || (target.statuses = [])).push(sp.status);
  return sp.status;
}

// --- spellbook -----------------------------------------------------------
export function makeSpellbook(defs = SPELLS) {
  const map = new Map();
  const add = (d) => d && d.name && map.set(d.name, d);
  if (Array.isArray(defs)) defs.forEach(add); else for (const k in defs) add(defs[k]);
  return {
    get: (name) => map.get(name) || null,
    has: (name) => map.has(name),
    all: () => [...map.values()],
  };
}

// --- targeting -----------------------------------------------------------
// Resolve a spell's scope to the concrete list of units it will hit. `chosen` is the
// single unit the player picked (for one-* / ally-row); `ctx.caster` fills "self".
export function targets(sp, { allies = [], enemies = [], chosen } = {}, ctx = {}) {
  const self = ctx.caster || chosen;
  switch (sp.target) {
    case 'all-enemies': return enemies.slice();
    case 'all-allies': return allies.slice();
    case 'one-enemy': return chosen ? [chosen] : enemies.length ? [enemies[0]] : [];
    case 'one-ally': return chosen ? [chosen] : allies.length ? [allies[0]] : [];
    case 'self': return self ? [self] : [];
    case 'random-enemy': {
      if (!enemies.length) return [];
      const i = Math.min(enemies.length - 1, Math.floor(roll(ctx.rng) * enemies.length));
      return [enemies[i]];
    }
    case 'ally-row': {
      const row = chosen && chosen.row;
      return row != null ? allies.filter((a) => a.row === row) : allies.slice();
    }
    default: return chosen ? [chosen] : [];
  }
}

// --- casting -------------------------------------------------------------
export function canCast(caster, sp) { return (caster.mp || 0) >= (sp.mp || 0); }

// Spend MP (blocking the whole cast if short) then apply the spell to every target.
// Returns results[] ({ target, amount, healed, crit, missed, status }); the array also
// carries `.cast` (false = MP too low, nothing happened). Each target's effect comes
// from ctx.resolve || defaultResolve; multi-hit spells resolve `hits` times and sum.
export function cast(caster, sp, targetsList = [], ctx = {}) {
  const results = [];
  if (!canCast(caster, sp)) { results.cast = false; return results; }   // insufficient MP → no-op
  caster.mp = (caster.mp || 0) - (sp.mp || 0);
  results.cast = true;

  const resolve = ctx.resolve || defaultResolve;
  const hits = Math.max(1, sp.hits || 1);

  for (const target of targetsList) {
    if (!target) continue;
    const ko = isKO(target);

    // Revive ONLY touches the fallen; ordinary heals/attacks SKIP the fallen.
    if (sp.kind === 'revive') {
      if (!ko) { results.push({ target, amount: 0, healed: false, revived: false, crit: false, missed: true, status: null }); continue; }
      const mh = maxHpOf(target) || Math.round((sp.power || 1) > 1 ? sp.power : 100 * (sp.power || 0.25));
      const amt = sp.power && sp.power <= 1 ? Math.max(1, Math.round(mh * sp.power)) : Math.max(1, Math.round(sp.power || mh * 0.25));
      target.hp = Math.min(mh, amt); target.dead = false;
      results.push({ target, amount: amt, healed: true, revived: true, crit: false, missed: false, status: null });
      continue;
    }
    if (ko) { results.push({ target, amount: 0, healed: false, crit: false, missed: true, status: null }); continue; }

    // Accumulate the hit(s).
    let total = 0, crit = false, missedAll = true;
    for (let h = 0; h < hits; h++) {
      const r = resolve(caster, sp, target, ctx) || {};
      if (!r.missed) missedAll = false;
      total += r.amount || 0;
      crit = crit || !!r.crit;
    }

    if (isHeal(sp)) {
      const mh = maxHpOf(target);
      target.hp = Math.min(mh, (target.hp || 0) + total);
      results.push({ target, amount: total, healed: true, crit, missed: false, status: applyStatus(target, sp, ctx) });
      continue;
    }
    if (sp.kind === 'buff' || sp.kind === 'debuff' || sp.kind === 'status') {
      const status = applyStatus(target, sp, ctx);
      results.push({ target, amount: total, healed: false, crit: false, missed: sp.status ? status === null : false, status });
      continue;
    }
    if (missedAll) { results.push({ target, amount: 0, healed: false, crit: false, missed: true, status: null }); continue; }

    if (sp.kind === 'drain') {
      const before = target.hp || 0;
      target.hp = Math.max(0, before - Math.max(0, total));
      if (target.hp <= 0) target.dead = true;
      const drained = before - target.hp;
      const cm = maxHpOf(caster);
      caster.hp = Math.min(cm || (caster.hp || 0) + drained, (caster.hp || 0) + drained);
      results.push({ target, amount: total, healed: false, drained, crit, missed: false, status: applyStatus(target, sp, ctx) });
      continue;
    }
    // attack / magic — negative total means element ABSORB (target is healed).
    if (total < 0) {
      const mh = maxHpOf(target);
      target.hp = Math.min(mh, (target.hp || 0) - total);
      results.push({ target, amount: total, healed: true, crit, missed: false, status: null });
      continue;
    }
    target.hp = Math.max(0, (target.hp || 0) - total);
    if (target.hp <= 0) target.dead = true;
    results.push({ target, amount: total, healed: false, crit, missed: false, status: applyStatus(target, sp, ctx) });
  }
  return results;
}

// --- sample spells (sensible FF6-ish defaults) ---------------------------
export const SPELLS = {
  Fire:    { name: 'Fire',    mp: 4,  power: 21, element: 'fire',    kind: 'magic',  target: 'one-enemy' },
  Firaga:  { name: 'Firaga',  mp: 22, power: 60, element: 'fire',    kind: 'magic',  target: 'all-enemies' },
  Bolt:    { name: 'Bolt',    mp: 5,  power: 22, element: 'thunder', kind: 'magic',  target: 'one-enemy' },
  Ice:     { name: 'Ice',     mp: 5,  power: 22, element: 'ice',     kind: 'magic',  target: 'one-enemy' },
  Poison:  { name: 'Poison',  mp: 3,  power: 14, element: 'poison',  kind: 'magic',  target: 'one-enemy', status: 'poison', statusChance: 0.6 },
  Cure:    { name: 'Cure',    mp: 5,  power: 32, kind: 'heal',   target: 'one-ally' },
  Cura:    { name: 'Cura',    mp: 12, power: 45, kind: 'heal',   target: 'all-allies' },
  Drain:   { name: 'Drain',   mp: 15, power: 26, element: 'dark', kind: 'drain', target: 'one-enemy' },
  Life:    { name: 'Life',    mp: 30, power: 0.5, kind: 'revive', target: 'one-ally' }, // restore 50% max HP
};

export const spells = { makeSpellbook, targets, cast, canCast, defaultResolve, SPELLS };
