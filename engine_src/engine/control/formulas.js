// engine/control/formulas.js
// JRPG DAMAGE / HEAL / HIT formulas — the number kernel of a turn/ATB battle core
// (FF6-flavored). This is the TURN-BASED sibling of damage.js: where damage.js is a
// real-time action pipeline (knockback, pierce, lifesteal), these are the classic
// menu-battle math a Fight/Magic/Item command runs once per action. All PURE and
// deterministic — stat blocks + an options bag + an injected rng go in, whole
// numbers come out. No window/DOM/timers/Math.random, so a headless balance sim
// gets the exact same numbers as the battle scene.
//
//   formulas.physical({ atk: 48, def: 40, power: 1, level: 10 })      -> { amount, crit }
//   formulas.magical ({ magic: 36, mdef: 30, power: 40, level: 10 })  -> { amount }
//   formulas.heal    ({ magic: 36, power: 40 })                       -> amount
//   formulas.hitChance({ accuracy: 1, evade: 0.1 })                   -> 0..1
//   formulas.rollHit(rng, chance) / critRoll(rng, chance)            -> bool
//   formulas.resolveAttack({ attacker, defender, weapon|spell, rng }) -> verdict
//
// A stat block is either a stats.js store (read through `.get(name)`) or a plain
// { vigor, magic, defense, mdefense, evade, mblock, level } object — resolveAttack
// reads both. Element interaction is optional: pass a defender `.affinity` map
// ({ fire:"weak", ice:"absorb" }) and the built-in table applies it, or inject
// `opts.resolveElement` to hand off to elements.js. Damage is signed: a NEGATIVE
// amount means the hit was absorbed and HEALS the target (drain).

// --- tiny math -------------------------------------------------------------

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
// Round to a whole number keeping sign (JRPG numbers are integers; drain stays -).
const whole = (v) => (v < 0 ? -Math.round(-v) : Math.round(v));

// Read a stat off a stats.js store (.get) OR a plain object, with a fallback.
function stat(u, key, dflt = 0) {
  if (!u) return dflt;
  if (typeof u.get === 'function') { const v = u.get(key); return v == null ? dflt : v; }
  return u[key] != null ? u[key] : dflt;
}

// Defense mitigation, FF6-style: damage is scaled by (256 - def)/256, so each point
// of defense shaves ~0.4%. Clamped to 0..1 — def>=256 fully walls, negatives can't
// amplify past 1x. Monotonically DECREASING in def (the core "more def = less dmg").
function mitigation(def) { return clamp01((256 - (def || 0)) / 256); }

// --- variance & crit -------------------------------------------------------

// variance(rng, amount, spread=0.15) -> amount jittered by ±spread. The battle
// "damage isn't flat" wobble. rng.next() in [0,1) maps to a factor in
// [1-spread, 1+spread], so the result stays within those bounds of `amount`.
// Raw (unrounded) so callers can round once at the end.
export function variance(rng, amount, spread = 0.15) {
  if (!rng || !spread) return amount;
  const factor = 1 + (rng.next() * 2 - 1) * spread;
  return amount * factor;
}

// critRoll(rng, chance=0.25) -> bool. The did-it-crit coin flip (no rng -> false).
export function critRoll(rng, chance = 0.25) {
  return rng ? rng.next() < chance : false;
}

// backRow(amount) -> halved physical damage (floored). The FF6 back-row rule: melee
// dealt to (or by) a back-row unit is cut in half; magic ignores rows.
export function backRow(amount) { return Math.floor((amount || 0) / 2); }

// --- hit chance ------------------------------------------------------------

// hitChance({ accuracy=1, evade=0 }) -> 0..1. Accuracy and evade accept either a
// fraction (0..1) or a percentage (>1, auto /100). chance = accuracy*(1-evade),
// so evade 0 always lands at full accuracy and evade -> 1 whiffs. Clamped 0..1.
export function hitChance({ accuracy = 1, evade = 0 } = {}) {
  const acc = accuracy > 1 ? accuracy / 100 : accuracy;
  const eva = evade > 1 ? evade / 100 : evade;
  return clamp01(acc * (1 - clamp01(eva)));
}

// rollHit(rng, chance) -> bool — true = the attack CONNECTS. chance>=1 always hits;
// with no rng it can't miss (deterministic auto-hit).
export function rollHit(rng, chance) {
  if (chance >= 1) return true;
  if (chance <= 0) return false;
  return rng ? rng.next() < chance : true;
}

// --- core damage / heal ----------------------------------------------------

// physical({ atk, def, power=1, level=1, variance, crit, rng }) -> { amount, crit }.
// Scales with effective attack (vigor*2 + weapon), weapon `power` multiplier and
// level; mitigated by defense. Optional crit multiplier (crit:true -> x2, or a
// number for the exact multiplier). Pass `rng` to fold in ±`variance` spread here;
// resolveAttack leaves it off and applies variance itself so the order stays
// hit->base->element->crit->variance.
export function physical({ atk = 10, def = 0, power = 1, level = 1, variance: spread = 0.15, crit = false, rng } = {}) {
  // Core: weapon power * (attack*4 + a level*attack growth term). Grows with all
  // three inputs, so a leveled hero with a strong weapon hits far harder.
  let base = power * (atk * 4 + Math.floor((atk * level) / 16));
  let amount = base * mitigation(def);
  const didCrit = crit ? true : false;
  if (didCrit) amount *= (typeof crit === 'number' ? crit : 2);   // crit multiplier
  if (rng && spread) amount = variance(rng, amount, spread);
  return { amount: Math.max(0, whole(amount)), crit: didCrit };
}

// magical({ magic, mdef, power, level=1, variance, rng }) -> { amount }. Spell `power`
// is the dominant term (each spell has its own), boosted by caster magic + level and
// mitigated by magic defense. No crit by default (FF6 magic doesn't crit).
export function magical({ magic = 10, mdef = 0, power = 20, level = 1, variance: spread = 0.15, rng } = {}) {
  let base = power * 4 + Math.floor(power * (magic * 2 + level) / 32);
  let amount = base * mitigation(mdef);
  if (rng && spread) amount = variance(rng, amount, spread);
  return { amount: Math.max(0, whole(amount)) };
}

// heal({ magic, power, level=1, variance, rng }) -> amount (a POSITIVE number of HP).
// Cure math: spell power + caster magic, no defense in the way. Optional variance.
export function heal({ magic = 10, power = 20, level = 1, variance: spread = 0, rng } = {}) {
  let amount = power * 4 + Math.floor(power * (magic * 2 + level) / 24);
  if (rng && spread) amount = variance(rng, amount, spread);
  return Math.max(0, whole(amount));
}

// --- element (built-in, decoupled from elements.js) ------------------------

// The classic four verdicts + none, mirrored here so formulas.js stands alone. A
// defender's `.affinity` map reads { fire:"weak", water:"absorb", ... }. absorb is
// -1 (drain -> heal), null 0 (immune), resist 0.5, weak 2, anything else 1.
const VERDICT = { weak: 2, resist: 0.5, null: 0, absorb: -1, none: 1 };
function elementMult(element, affinity) {
  if (element == null || !affinity) return 1;
  const v = affinity[element];
  const m = v == null ? 1 : VERDICT[v];
  return m == null ? 1 : m;
}
// Fold several elements against a defender, attacker-favouring (biggest multiplier
// wins — a weakness on any component beats a partial resist). Matches elements.js.
function elementsMult(list, affinity) {
  let m = -Infinity;
  for (const el of list) m = Math.max(m, elementMult(el, affinity));
  return m === -Infinity ? 1 : m;
}

// --- compose: resolve a whole attack ---------------------------------------

// resolveAttack({ attacker, defender, weapon, spell, rng, element, elements,
//                 backRow, resolveElement }) -> { amount, crit, missed, element, tag }
//   Runs the full menu-battle pipeline in FF6 order:
//     1. HIT      — hitChance(accuracy, evade) then rollHit(rng); a miss short-circuits.
//     2. BASE     — physical() for a weapon action, magical() for a spell.
//     3. ELEMENT  — apply the defender's affinity (built-in table, or opts.resolveElement).
//     4. CRIT     — physical only: critRoll(rng, chance) -> multiply (default x2).
//     5. VARIANCE — ±spread wobble, applied last, then round to a whole number.
//   `amount` is signed: negative = absorbed (heal the target). `tag` labels the
//   element result ('weak'|'resist'|'null'|'absorb'|'normal') for a floater/log.
export function resolveAttack(opts = {}) {
  const { attacker, defender, weapon, spell, rng } = opts;
  const action = spell || weapon || {};
  const isSpell = !!spell;
  const level = stat(attacker, 'level', 1);

  // --- 1. HIT ---------------------------------------------------------------
  const accuracy = action.accuracy != null ? action.accuracy : 1;
  const evade = isSpell ? stat(defender, 'mblock', 0) : stat(defender, 'evade', 0);
  const chance = hitChance({ accuracy, evade });
  const el = opts.element != null ? opts.element : action.element;
  const elList = opts.elements || action.elements ||
    (el != null ? [el] : null);
  if (!rollHit(rng, chance)) {
    return { amount: 0, crit: false, missed: true, element: el != null ? el : null, tag: 'miss' };
  }

  // --- 2. BASE --------------------------------------------------------------
  const power = action.power != null ? action.power : (isSpell ? 20 : 1);
  const spread = action.variance != null ? action.variance : 0.15;
  let amount, didCrit = false;
  if (isSpell) {
    amount = magical({
      magic: stat(attacker, 'magic', 10), mdef: stat(defender, 'mdefense', 0),
      power, level, variance: 0,          // variance applied at step 5
    }).amount;
  } else {
    // Effective attack: explicit weapon.atk, else vigor*2 (FF6 doubles vigor).
    const atk = action.atk != null ? action.atk : stat(attacker, 'vigor', 5) * 2;
    amount = physical({
      atk, def: stat(defender, 'defense', 0), power, level, variance: 0, crit: false,
    }).amount;
    if (opts.backRow) amount = backRow(amount);   // melee halved from/into the back row
  }

  // --- 3. ELEMENT -----------------------------------------------------------
  let mult = 1;
  if (elList && elList.length) {
    if (typeof opts.resolveElement === 'function') {
      const r = opts.resolveElement(elList, defender && defender.affinity, amount);
      // Accept either a plain number (the post-affinity amount) or {amount}.
      amount = typeof r === 'number' ? r : (r && r.amount != null ? r.amount : amount);
      mult = amount === 0 ? 0 : 1;                 // tag inferred below from sign
    } else {
      mult = elementsMult(elList, defender && defender.affinity);
      amount = amount * mult;
    }
  }
  let tag = mult < 0 ? 'absorb' : mult === 0 ? 'null' : mult > 1 ? 'weak' : mult < 1 ? 'resist' : 'normal';

  // --- 4. CRIT (physical only) ---------------------------------------------
  if (!isSpell && amount > 0) {
    const critChance = action.crit != null ? action.crit : 0;
    if (critChance && critRoll(rng, critChance)) {
      amount *= (action.critMult != null ? action.critMult : 2);
      didCrit = true;
    }
  }

  // --- 5. VARIANCE + round --------------------------------------------------
  if (rng && spread) amount = variance(rng, amount, spread);
  return {
    amount: whole(amount), crit: didCrit, missed: false,
    element: el != null ? el : (elList ? elList.slice() : null), tag,
  };
}

export const formulas = {
  physical, magical, heal,
  hitChance, rollHit, critRoll, variance, backRow,
  resolveAttack,
};
