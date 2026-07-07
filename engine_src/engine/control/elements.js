// engine/control/elements.js
// ELEMENTAL AFFINITY table for a turn/ATB battle core (FF6-style) — the pure
// lookup that turns "a fire spell hit this defender" into a signed number.
// A defender carries an affinity map, one verdict per element:
//   e.affinity = { fire:"weak", ice:"resist", water:"absorb", poison:"null" }
// and a spell/attack carries one or more elements. This file answers only
// "how does the element interact with the defender?" — it never rolls damage,
// reads stats, or mutates anyone; damage.js / a battle resolver owns the rest.
//
// Verdicts and what they mean (the classic JRPG four, plus the implicit none):
//   "weak"   -> x2      take double        (hit the weakness)
//   "resist" -> x0.5    take half          (halved / "strong")
//   "null"   -> x0      no effect          (immune / voided)
//   "absorb" -> x-1     HEALED, not hurt   (drain — signed negative)
//   (unlisted / "none") -> x1  normal.
//
// Everything here is pure and deterministic (no rng needed — affinity is a
// lookup, not a roll), so a sim asserts exact multipliers.

// --- constants -------------------------------------------------------------

// The canonical element list. A spell's `element` is one of these strings (or
// null for non-elemental). Games can add their own — the table is open, the
// helpers only special-case the four verdicts, never the element names.
export const ELEMENTS = Object.freeze([
  'fire', 'ice', 'bolt', 'water', 'wind', 'earth', 'holy', 'poison',
]);

// The verdict multipliers. `absorb` is -1 so downstream math flips the sign of
// the amount into a heal; `null` fully voids; unlisted defaults to NONE (x1).
export const AFFINITY = Object.freeze({
  weak: 2, resist: 0.5, null: 0, absorb: -1, none: 1,
});

// --- core ------------------------------------------------------------------

// multiplier(element, affinity) -> number
//   `affinity` is EITHER a defender's affinity map ({fire:"weak",...}) OR a bare
//   verdict string ("weak"). Non-elemental (element null/undefined) is always
//   x1 — non-elemental damage ignores the whole table. Unknown/absent -> x1.
export function multiplier(element, affinity) {
  if (element == null) return 1;                       // non-elemental: bypass
  let verdict = affinity;
  if (affinity && typeof affinity === 'object') verdict = affinity[element];
  if (verdict == null) return 1;                       // element not listed
  const m = AFFINITY[verdict];
  return m == null ? 1 : m;                             // unknown verdict -> none
}

// resolve(element, defenderAffinity, amount) -> { amount, tag, mult, element }
//   Apply the affinity to a positive `amount` of would-be damage. The returned
//   `amount` is SIGNED: negative means the hit HEALED the defender (absorb).
//   `tag` is a short label for a floater/log ('weak'|'resist'|'null'|'absorb'|
//   'normal'|'heal'). Rounds to an integer (JRPG damage is whole numbers);
//   pass {round:false} in opts to keep it raw.
export function resolve(element, defenderAffinity, amount = 0, opts = {}) {
  const mult = multiplier(element, defenderAffinity);
  let out = amount * mult;
  if (opts.round !== false) out = Math.trunc(out);     // toward zero, keeps sign
  let tag;
  if (mult < 0) tag = 'absorb';                        // healed
  else if (mult === 0) tag = 'null';
  else if (mult > 1) tag = 'weak';
  else if (mult < 1) tag = 'resist';
  else tag = 'normal';
  return { amount: out, tag, mult, element: element == null ? null : element };
}

// --- helpers ---------------------------------------------------------------

// makeAffinity(overrides) -> a fresh affinity map. Every listed ELEMENT starts
// unset (x1 / "none"); spread your overrides on top. A defensive COPY, so shared
// enemy templates don't alias one table.
export function makeAffinity(overrides = {}) {
  const a = {};
  for (const el of ELEMENTS) a[el] = 'none';
  for (const k in overrides) a[k] = overrides[k];
  return a;
}

// isImmune(element, affinity) -> bool — true when the hit does exactly nothing
// (null verdict). Absorb is NOT immune (it heals); use it for "wall of fire"
// checks or to skip an attack entirely.
export function isImmune(element, affinity) {
  return multiplier(element, affinity) === 0;
}

// absorbs(element, affinity) -> bool — true when the hit heals instead of hurts.
export function absorbs(element, affinity) {
  return multiplier(element, affinity) < 0;
}

// combine(a, b, mode) -> a merged VERDICT for a multi-element attack, so a
// fire+ice spell resolves against a defender's two affinities in one number.
// Pass verdict strings (or the multipliers) for the SAME defender:
//   mode 'best'  (default, attacker-favouring): pick the biggest multiplier —
//     absorb(-1) < null(0) < resist(0.5) < none(1) < weak(2), so weakness wins
//     and you never accidentally heal a foe who only partly absorbs.
//   mode 'worst' (defender-favouring): pick the smallest — an absorb or null on
//     ANY component saves the defender (drain/immunity dominates).
//   mode 'product': multiply the two (stacked resistances compound).
// Returns a verdict string when the result maps to a known one, else the raw
// number under {mult}. Use with two multiplier() lookups for real defenders.
export function combine(a, b, mode = 'best') {
  const ma = typeof a === 'number' ? a : (AFFINITY[a] ?? 1);
  const mb = typeof b === 'number' ? b : (AFFINITY[b] ?? 1);
  let m;
  if (mode === 'worst') m = Math.min(ma, mb);
  else if (mode === 'product') m = ma * mb;
  else m = Math.max(ma, mb);                            // 'best'
  // Map back to a named verdict when it lands on one (nice for tags/logging).
  for (const name in AFFINITY) if (AFFINITY[name] === m) return name;
  return m;                                             // raw multiplier (e.g. product)
}

// resolveMulti(elements, defenderAffinity, amount, opts) -> resolve() verdict for
// an attack that carries SEVERAL elements. Looks up each element on the defender,
// folds them with combine(mode), then applies the merged multiplier to `amount`.
// `opts.mode` picks the fold ('best'|'worst'|'product'); default 'best'.
export function resolveMulti(elements = [], defenderAffinity, amount = 0, opts = {}) {
  const list = Array.isArray(elements) ? elements : [elements];
  if (!list.length) return resolve(null, defenderAffinity, amount, opts);
  const mode = opts.mode || 'best';
  let mult = multiplier(list[0], defenderAffinity);
  for (let i = 1; i < list.length; i++) {
    const merged = combine(mult, multiplier(list[i], defenderAffinity), mode);
    mult = typeof merged === 'number' ? merged : AFFINITY[merged];
  }
  let out = amount * mult;
  if (opts.round !== false) out = Math.trunc(out);
  let tag;
  if (mult < 0) tag = 'absorb'; else if (mult === 0) tag = 'null';
  else if (mult > 1) tag = 'weak'; else if (mult < 1) tag = 'resist'; else tag = 'normal';
  return { amount: out, tag, mult, element: list.slice() };
}

export const elements = {
  ELEMENTS, AFFINITY,
  multiplier, resolve, resolveMulti,
  makeAffinity, isImmune, absorbs, combine,
};
