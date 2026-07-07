// engine/control/encounters.js
// RANDOM ENCOUNTER director — the field-exploration bridge INTO the ATB battle core
// (battle.js). Where spawners.js decides "when/what to spawn" for a real-time arena,
// this is its turn-based cousin: as the player walks a zone it fills a THREAT meter and
// rolls it against an encounter rate, and when it trips it weight-picks an enemy
// FORMATION and rolls the FF6 first-strike flags (preemptive / back attack). It owns
// only the "do we fight, and against whom" decision — the game then hands the chosen
// formation to makeBattle() and reads preemptive/backAttack to pre-fill ATB gauges.
//
//   const enc = makeEncounters({ rate: 0.08, tables: {
//     field:  [{ weight: 3, formation: 'goblins' }, { weight: 1, formation: 'wolves' }],
//     cave:   [{ weight: 2, formation: 'bats' }, { weight: 1, formation: 'ogre', minLevel: 8 }],
//   }, rng });                                     // rng = a () => 0..1 fn (or {next})
//   const hit = enc.step('field', moved, { level: party.level });   // per field step
//   if (hit) startBattle(hit.formation, hit.preemptive, hit.backAttack);
//   // ...after the fight:  enc.reset();           // arm a short safe grace
//
// PURE + deterministic: no world/DOM/timers/Math.random — the rng is injected and all
// state (threat meter, grace, rate, danger) lives in the closure, so a headless sim
// gets the same encounters as the field scene. Node-testable: a higher rate yields more
// encounters over N steps, the post-battle grace suppresses an instant re-ambush, the
// weighted pick honours weights, and escapeChance rises with repeated attempts.

// Normalize an injected rng into a plain () => 0..1 roller. Accepts a bare function
// (the documented default), a core makeRng()-style { next } object, or nothing (a
// deterministic 0.5 so tests without an rng still behave predictably).
function roller(rng) {
  if (typeof rng === 'function') return rng;
  if (rng && typeof rng.next === 'function') return () => rng.next();
  return () => 0.5;
}

export function makeEncounters({
  rate = 0.08,          // base per-step encounter chance (the threat the meter gains)
  tables = {},          // zoneId -> [{ weight, formation, minLevel? }, ...]
  rng,                  // injected () => 0..1 (or { next })
  danger = 1,           // global scary/safe multiplier on the rate (setters below)
  grace = 3,            // safe distance/steps after a battle before the meter re-arms
  preemptive: preemptiveChance = 0.06,   // small chance the party gets the first strike
  backAttack: backAttackChance = 0.06,   // small chance the enemies ambush from behind
  cap = 1,              // meter value that GUARANTEES an encounter (hard pity ceiling)
} = {}) {
  const roll = roller(rng);
  let base = Math.max(0, rate);
  let mult = Math.max(0, danger);
  let threat = 0;               // rising encounter meter (0..cap), reset on a fight
  let safe = 0;                 // remaining grace distance where steps can't encounter

  // Weight-select a formation for a zone, honouring an optional party level gate.
  // Entries whose minLevel exceeds `level` are filtered out; if that empties the pool
  // (or no level was given) we fall back to the whole list so a zone always yields one.
  function pick(zoneId, level) {
    const list = tables[zoneId] || [];
    if (!list.length) return null;
    const usable = (level == null)
      ? list
      : list.filter((e) => e.minLevel == null || level >= e.minLevel);
    const pool = usable.length ? usable : list;
    let total = 0;
    for (const e of pool) total += e.weight > 0 ? e.weight : 0;
    if (total <= 0) return pool[0].formation;      // all weightless -> first entry
    let r = roll() * total;
    for (const e of pool) {
      r -= e.weight > 0 ? e.weight : 0;
      if (r < 0) return e.formation;
    }
    return pool[pool.length - 1].formation;        // fp slack -> last
  }

  // Roll the first-strike flags once an encounter is confirmed. Preemptive wins over
  // back attack (you can't be simultaneously ambushed and ambushing); the game reads
  // these to grant the party (preemptive) or the enemies (backAttack) a gauge lead.
  function ambush() {
    const preemptive = roll() < preemptiveChance;
    const backAttack = !preemptive && roll() < backAttackChance;
    return { preemptive, backAttack };
  }

  const api = {
    // Advance exploration by `moved` (a distance, or 1 per tile step). Bleeds off any
    // post-battle grace first, then adds rate*danger*moved to the threat meter and rolls
    // the meter: a hit returns the encounter and clears the meter, otherwise null. The
    // meter's steady climb means a dry streak can't last forever (it pities out at `cap`).
    step(zoneId, moved = 1, opts = {}) {
      const dist = moved > 0 ? moved : 0;
      if (safe > 0) { safe -= dist; return null; }   // fresh out of a fight — walk it off
      threat = Math.min(cap, threat + base * mult * dist);
      if (threat <= 0) return null;                  // rate 0 / danger 0 -> a safe zone
      if (roll() < threat || threat >= cap) {
        const formation = pick(zoneId, opts.level);
        threat = 0;
        if (formation == null) return null;          // no table for this zone -> no fight
        return { formation, zone: zoneId, ...ambush() };
      }
      return null;
    },

    pick,                      // weight-select a formation without stepping the meter
    ambush,                    // roll first-strike flags standalone (scripted fights)

    // Escape odds for the battle menu's Run command, rising with repeated ATTEMPTS so a
    // cornered party eventually breaks free. Faster parties flee more reliably (speed
    // share of the room), and each prior failed try adds a flat bump. Clamped 0..1.
    escapeChance({ partySpeed = 1, enemySpeed = 1, attempts = 0 } = {}) {
      const share = partySpeed / (partySpeed + enemySpeed || 1);  // 0..1 speed advantage
      const chance = 0.25 + 0.5 * share + 0.25 * Math.max(0, attempts);
      return chance < 0 ? 0 : chance > 1 ? 1 : chance;
    },

    // Zone tuning: setRate swaps the base encounter chance (a calm town vs a deep dungeon),
    // danger scales it (a curse/repel item, a bestiary-thinned area). Both chainable.
    setRate(r) { base = Math.max(0, r); return api; },
    danger(m) { mult = Math.max(0, m); return api; },

    // Call ONCE after a battle resolves: clear the meter and arm the safe grace so the
    // very next step can't instantly re-ambush the party. Optional override grace.
    reset(g = grace) { threat = 0; safe = Math.max(0, g); return api; },

    // Introspection for a HUD/debugger (danger meter, "you feel safe" grace tell).
    threat() { return threat; },
    grace() { return safe; },
    rate() { return base; },
  };
  return api;
}

export const encounters = { makeEncounters };
