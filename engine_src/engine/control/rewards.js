// engine/control/rewards.js
// POST-BATTLE REWARDS / loot — the spoils half of an FF6-style fight, the turn-based
// sibling of the field-layer economy/inventory/progression systems. When a battle
// (battle.js) ends in victory, this turns the fallen enemy defs into XP / gil / AP
// and a bag of item drops, then splits the XP across the party and pushes anyone
// past a level threshold through the round-9 progression/stats stores. It also owns
// the Thief command (steal) and end-of-fight victory BONUSES (no-death, etc).
//
// PURE DATA + INJECTED rng — no engine deps, no window/DOM/timers, no Math.random,
// so a battle scene, a results screen and a headless balance sim all get the SAME
// numbers. Compose it with the battle core via plain data: hand it the defeated
// enemy defs and your live party, and it drives whatever stat/level stores the
// members carry (a stats.js block, a progression.makeLevels, or a bare {level}).
//
//   const spoils = rewards.computeRewards(deadEnemies, { rng });
//   //   -> { xp: 420, gil: 180, ap: 6, drops: ['potion','ether'] }
//   const gained = rewards.distribute(spoils.xp, party, { rng });
//   //   -> [{ id:'terra', gained:210, from:5, to:6, leveledUp:true, levels:1 }, ...]
//   const swipe  = rewards.steal(goblin, rng, { rate: 0.5 });  // Thief command
//   const bonus  = rewards.bonusFor({ noDeath: true });        // victory bonus muls
//
// An ENEMY def is plain data: { xp, gil, ap, drops:[{item,chance}], steal:[{item,chance}] }.
// A PARTY MEMBER is plain data too — it just needs an id and SOME way to hold a
// level: a `levels` (progression.makeLevels) store, a `stats` (stats.js) store, or
// a bare `level` number. distribute reads the level, banks the XP and, on a
// level-up, re-derives the stats block via `stats.setLevel` so maxHp climbs.

// -------- rng plumbing ----------------------------------------------------------
// Accept EITHER a bare `() => 0..1` fn (a deterministic `() => 0.5` in tests) OR a
// core makeRng() `{ next() }`; everything below draws through this one adapter.
function roller(rng) {
  if (typeof rng === 'function') return rng;
  if (rng && typeof rng.next === 'function') return () => rng.next();
  return () => 0.5;                                  // deterministic fallback
}

const num = (v) => (typeof v === 'number' && isFinite(v) ? Math.max(0, Math.floor(v)) : 0);

// -------- loot tables -----------------------------------------------------------
// A weighted/independent chance table shared by enemy DROPS and the STEAL command.
// entries = [{ item, chance }] where `chance` is a probability 0..1 (>=1 = always).
//   rollAll(rng) -> items[]   // INDEPENDENT: each entry rolled on its own chance
//   rollOne(rng) -> item|null // WEIGHTED single pick, chance used as relative weight
export function lootTable(entries = []) {
  const list = (Array.isArray(entries) ? entries : [entries])
    .filter((e) => e && e.item != null)
    .map((e) => ({ item: e.item, chance: e.chance == null ? 1 : e.chance }));

  return {
    entries: list,
    // Roll every slot on its own chance — an enemy can drop 0, 1 or many items.
    rollAll(rng) {
      const r = roller(rng);
      const out = [];
      for (const e of list) if (r() < e.chance) out.push(e.item);
      return out;
    },
    // Pick exactly one item, weighted by `chance` (common vs rare) — for steal.
    rollOne(rng) {
      const r = roller(rng);
      let total = 0;
      for (const e of list) total += Math.max(0, e.chance);
      if (total <= 0) return null;
      let x = r() * total;
      for (const e of list) { x -= Math.max(0, e.chance); if (x < 0) return e.item; }
      return list[list.length - 1].item;             // fp guard
    },
  };
}

// -------- compute rewards -------------------------------------------------------
// Fold a list of defeated enemy defs into the total spoils. SUMS xp/gil/ap and rolls
// each enemy's drop table independently, collecting whatever fell. Pass a victory
// `bonus` (a bonusFor() result or a raw conditions bag) to scale the totals.
export function computeRewards(defeated = [], opts = {}) {
  const list = Array.isArray(defeated) ? defeated : [defeated];
  const r = roller(opts.rng);
  let xp = 0, gil = 0, ap = 0;
  const drops = [];
  for (const e of list) {
    if (!e) continue;
    xp += num(e.xp);
    gil += num(e.gil != null ? e.gil : e.gold);
    ap += num(e.ap);
    for (const it of lootTable(e.drops || []).rollAll(r)) drops.push(it);
  }
  const out = { xp, gil, ap, drops };
  if (opts.bonus) applyBonus(out, opts.bonus);       // fold a victory bonus, if any
  return out;
}

// -------- distribute XP + level-ups ---------------------------------------------
// Split `xp` across the party and bank it through each member's growth store,
// returning WHO leveled. By default only SURVIVORS share (FF6: KO'd members earn
// nothing) and the pool is divided evenly (opts.split=false = everyone gets full).
// opts.all / opts.survivorsOnly:false lets the fallen share too. When a member has
// no growth store, pass opts.curve (level -> xpNeeded) to accumulate on member.xp.
export function distribute(xp, party, opts = {}) {
  const members = Array.isArray(party) ? party : (party && party.members) || [];
  const survivorsOnly = opts.all ? false : opts.survivorsOnly !== false;
  const recipients = members.filter((m) => m && (!survivorsOnly || isAlive(m)));
  const n = recipients.length;
  const total = num(xp);
  const split = opts.split !== false;                // default: even split
  const base = split && n ? Math.floor(total / n) : total;
  let rem = split && n ? total - base * n : 0;       // spread remainder to the first few

  const out = [];
  for (const m of recipients) {
    let share = base;
    if (split && rem > 0) { share += 1; rem--; }
    out.push(grantXp(m, share, opts));
  }
  return out;
}

// Bank `amount` XP into one member and sync a level-up into its stats block.
function grantXp(member, amount, opts) {
  amount = num(amount);
  const from = memberLevel(member);
  let to = from, leveledUp = false, levels = 0;
  const store = member.levels || member.progression;

  if (store && typeof store.add === 'function') {    // preferred: a progression store
    const res = store.add(amount);
    to = res.level; leveledUp = !!res.leveledUp; levels = res.gained || 0;
  } else if (typeof opts.curve === 'function') {     // fallback: curve on member.xp
    member.xp = num(member.xp) + amount;
    let lvl = from;
    for (;;) {
      const need = opts.curve(lvl);
      if (!(need > 0) || member.xp < need) break;    // finite-loop guard
      member.xp -= need; lvl++; levels++;
    }
    to = lvl; leveledUp = levels > 0;
  }

  if (leveledUp) syncStats(member, to);              // re-derive maxHp/stats at new level
  return { id: member.id, gained: amount, from, to, leveledUp, levels };
}

// Read a member's current level from whatever store it carries.
function memberLevel(m) {
  if (m.levels && m.levels.level != null) return m.levels.level;
  if (m.progression && m.progression.level != null) return m.progression.level;
  if (m.stats && m.stats.level != null) return m.stats.level;
  if (m.level != null) return m.level;
  return 1;
}

// Push a new level into the member's stats.js block (grows caps, keeps the wound).
function syncStats(m, level) {
  const s = m.stats;
  if (s && typeof s.setLevel === 'function') { if (s.level !== level) s.setLevel(level); }
  else if (typeof m.setLevel === 'function') m.setLevel(level);
  else m.level = level;
}

// Is this member eligible to share XP? Reads a stats.js `alive`/`isKO`, then plain
// entity flags, defaulting to alive so bare `{ id }` members still earn.
function isAlive(m) {
  if (m.stats && typeof m.stats.alive === 'boolean') return m.stats.alive;
  if (m.stats && typeof m.stats.isKO === 'boolean') return !m.stats.isKO;
  if (typeof m.alive === 'boolean') return m.alive;
  if (typeof m.isKO === 'boolean') return !m.isKO;
  return !m.dead;
}

// -------- steal (the Thief command) ---------------------------------------------
// Roll a steal attempt against `rate`; on success, pick one item from the target's
// `steal` table (weighted, common vs rare). Returns { success, item } — success can
// be true with a null item when the target has nothing left to take.
export function steal(target, rng, opts = {}) {
  const r = roller(rng);
  const rate = opts.rate != null ? opts.rate : 0.5;
  const list = (target && (target.steal || target.steals)) || [];
  const success = r() < rate;
  if (!success) return { success: false, item: null };
  return { success: true, item: lootTable(list).rollOne(r) };
}

// -------- victory bonuses -------------------------------------------------------
// Named end-of-fight conditions -> stacking reward multipliers. Fold any active
// conditions into { xp, gil, ap, tags } and multiply into the spoils (via applyBonus
// or computeRewards' opts.bonus). Override/extend the table per game.
const DEFAULT_BONUS = {
  noDeath:     { xp: 1.5,  gil: 1,   ap: 1.5 },      // whole party survived
  flawless:    { xp: 1.25, gil: 1.5, ap: 1.25 },     // took no damage
  overkill:    { xp: 1,    gil: 2,   ap: 1 },        // heavy finishing blow
  quick:       { xp: 1.25, gil: 1,   ap: 1.5 },      // won inside N turns
  preemptive:  { xp: 1,    gil: 1.5, ap: 1 },        // ambush / first strike
  noItems:     { xp: 1,    gil: 1.25, ap: 1.25 },    // won without consumables
};

export function bonusFor(conditions = {}, table = DEFAULT_BONUS) {
  const t = { ...DEFAULT_BONUS, ...table };
  const out = { xp: 1, gil: 1, ap: 1, tags: [] };
  for (const key in conditions) {
    if (!conditions[key]) continue;                  // falsy = condition not met
    const b = t[key]; if (!b) continue;
    out.xp *= b.xp != null ? b.xp : 1;
    out.gil *= b.gil != null ? b.gil : 1;
    out.ap *= b.ap != null ? b.ap : 1;
    out.tags.push(key);
  }
  return out;
}

// Scale a rewards bag in place by a bonus. `bonus` is either a bonusFor() result
// ({xp,gil,ap}) or a raw conditions bag ({noDeath:true}) run through bonusFor.
export function applyBonus(rewards, bonus) {
  if (!rewards || !bonus) return rewards;
  const m = (bonus.xp != null || bonus.gil != null || bonus.ap != null) ? bonus : bonusFor(bonus);
  rewards.xp = Math.floor(rewards.xp * (m.xp != null ? m.xp : 1));
  rewards.gil = Math.floor(rewards.gil * (m.gil != null ? m.gil : 1));
  rewards.ap = Math.floor(rewards.ap * (m.ap != null ? m.ap : 1));
  return rewards;
}

export const rewards = {
  computeRewards, distribute, lootTable, steal, bonusFor, applyBonus,
};
