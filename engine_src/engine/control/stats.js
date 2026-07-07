// engine/control/stats.js
// RPG CHARACTER STATS — the number spine of a turn-based JRPG (FF6-style). This is
// PURE DATA: a unit's stat block, current HP/MP pool, growth curve and equipment
// overlay live in a closure — no engine deps, no window/DOM/timers, no Math.random.
// A battle scene, a menu status screen and a headless balance sim all drive the
// SAME store, so numbers stay canonical wherever they are read.
//
//   const s = stats.makeStats({ level: 1, hp: 80, mp: 20, vigor: 24, speed: 30,
//                               stamina: 20, magic: 18, defense: 40, mdefense: 30,
//                               evade: 5, mblock: 3 });
//   s.maxHp; s.hp;                 // derived cap + current pool
//   s.damage(35);                  // -> new hp, clamped to 0 (KO)
//   s.heal(20); s.spendMp(12);     // heal clamps to max; spend fails (false) when short
//   s.setLevel(20);                // apply growth curve 1..99 (raises maxHp)
//   s.equipmentMods(weapon);       // fold flat +stat gear bonuses (round-6 equipment.stats())
//   if (s.isKO) s.revive(0.5);     // back at half HP
//
// The block splits into VITALITY seeds (hp, mp — the level-1 pool baseline) and
// combat stats (vigor/speed/stamina/magic/defense/mdefense/evade/mblock). maxHp is
// derived from the hp seed + stamina scaled by level; maxMp from mp + magic. Growth
// raises the seeds/stats per level, so the caps climb as you level. Equipment is a
// separate flat overlay folded ON TOP, so unequipping just drops the overlay.

// The canonical stat keys; anything not here is ignored by growth/equip folding.
const KEYS = ['hp', 'mp', 'vigor', 'speed', 'stamina', 'magic', 'defense', 'mdefense', 'evade', 'mblock'];

// Sensible per-level growth increments (added once per level above the base level).
// A curve fn or a partial table override these; missing keys fall back here.
const DEFAULT_GROWTH = {
  hp: 12, mp: 3, vigor: 1, speed: 0.5, stamina: 1, magic: 1,
  defense: 1, mdefense: 1, evade: 0.2, mblock: 0.2,
};

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

// Derived caps from an EFFECTIVE (grown + equipped) stat block at `level`. Both are
// strictly increasing in level and in their driving stat, so levelling always
// raises the ceiling. hp seed + stamina drives HP; mp seed + magic drives MP.
function deriveHp(eff, level) { return Math.round(eff.hp * (1 + level * 0.05) + eff.stamina * level); }
function deriveMp(eff, level) { return Math.round(eff.mp * (1 + level * 0.03) + eff.magic * level * 0.5); }

export function makeStats(base = {}, opts = {}) {
  // base = the level-`base.level` (default 1) stat block. opts.growth is either a
  // curve fn (baseBlock, level) -> grownBlock, or a partial per-stat increment table.
  const baseLevel = base.level != null ? base.level : 1;
  const seed = {};                                   // frozen copy of the input block
  for (const k of KEYS) seed[k] = base[k] != null ? base[k] : (k === 'hp' ? 40 : k === 'mp' ? 10 : 0);

  const growthFn = typeof opts.growth === 'function' ? opts.growth : null;
  const growTable = (!growthFn && opts.growth) ? { ...DEFAULT_GROWTH, ...opts.growth } : DEFAULT_GROWTH;
  const maxLevel = opts.maxLevel != null ? opts.maxLevel : 99;

  let level = clamp(Math.round(baseLevel), 1, maxLevel);
  let grown = {};                                    // seed after growth to `level`
  const equip = {};                                  // flat gear overlay, key -> bonus
  let maxHp = 0, maxMp = 0;
  const cur = { hp: 0, mp: 0 };                      // the live pool

  // Grow the seed block up to `level` using the curve fn or the increment table.
  function computeGrown() {
    if (growthFn) { grown = { ...seed, ...growthFn(seed, level) }; return; }
    const steps = level - clamp(Math.round(baseLevel), 1, maxLevel);
    grown = {};
    for (const k of KEYS) grown[k] = seed[k] + (growTable[k] || 0) * steps;
  }

  // Effective value = grown stat + equipment overlay (never below 0).
  function eff(k) { return Math.max(0, (grown[k] || 0) + (equip[k] || 0)); }
  function effBlock() { const o = {}; for (const k of KEYS) o[k] = eff(k); return o; }

  // Recompute caps and re-clamp the live pool into [0, max] (equip/level changes).
  function recompute(fill) {
    const e = effBlock();
    maxHp = Math.max(1, deriveHp(e, level));
    maxMp = Math.max(0, deriveMp(e, level));
    if (fill) { cur.hp = maxHp; cur.mp = maxMp; }
    else { cur.hp = clamp(cur.hp, 0, maxHp); cur.mp = clamp(cur.mp, 0, maxMp); }
  }

  computeGrown();
  recompute(true);                                   // start full

  const api = {
    // -------- reads ----------------------------------------------------------
    get level() { return level; },
    get hp() { return cur.hp; },
    get mp() { return cur.mp; },
    get maxHp() { return maxHp; },
    get maxMp() { return maxMp; },
    get isKO() { return cur.hp <= 0; },
    get alive() { return cur.hp > 0; },

    // Effective stat by name (folds growth + equipment); also serves the derived
    // and pool fields so a HUD can read everything through one accessor.
    get(name) {
      if (name === 'level') return level;
      if (name === 'hp') return cur.hp;
      if (name === 'mp') return cur.mp;
      if (name === 'maxHp') return maxHp;
      if (name === 'maxMp') return maxMp;
      return eff(name);
    },

    // Overwrite a BASE seed stat (menus/cheats/story boosts), then recompute caps.
    set(name, value) {
      if (name === 'level') return api.setLevel(value);
      if (name === 'hp') { cur.hp = clamp(value, 0, maxHp); return api; }
      if (name === 'mp') { cur.mp = clamp(value, 0, maxMp); return api; }
      if (KEYS.indexOf(name) >= 0) { seed[name] = value; computeGrown(); recompute(false); }
      return api;
    },

    // -------- pool ----------------------------------------------------------
    damage(n) { cur.hp = clamp(cur.hp - Math.max(0, n || 0), 0, maxHp); return cur.hp; },
    heal(n) { if (cur.hp > 0) cur.hp = clamp(cur.hp + Math.max(0, n || 0), 0, maxHp); return cur.hp; },
    spendMp(n) { n = Math.max(0, n || 0); if (cur.mp < n) return false; cur.mp -= n; return true; },
    restoreMp(n) { cur.mp = clamp(cur.mp + Math.max(0, n || 0), 0, maxMp); return cur.mp; },

    // Raise a KO'd unit to `frac` of maxHp (never below 1); no-op if already alive.
    revive(frac = 0.5) {
      if (cur.hp > 0) return cur.hp;
      cur.hp = Math.max(1, Math.round(maxHp * clamp(frac, 0, 1)));
      return cur.hp;
    },
    full() { cur.hp = maxHp; cur.mp = maxMp; return api; },   // inn / rest

    // -------- growth --------------------------------------------------------
    levelUp() { return api.setLevel(level + 1); },
    setLevel(n) {
      const missHp = maxHp - cur.hp, missMp = maxMp - cur.mp;   // keep damage taken
      level = clamp(Math.round(n), 1, maxLevel);
      computeGrown(); recompute(false);
      cur.hp = clamp(maxHp - missHp, 0, maxHp);                 // grow the cap, not the wound
      cur.mp = clamp(maxMp - missMp, 0, maxMp);
      return api;
    },

    // Fold a gear stats object (plain {vigor:+5,...} or anything with a .stats()
    // method, e.g. round-6 equipment) as the flat overlay, REPLACING the last one.
    equipmentMods(bag) {
      for (const k of KEYS) equip[k] = 0;
      const mods = bag && typeof bag.stats === 'function' ? bag.stats() : (bag || {});
      for (const k in mods) if (KEYS.indexOf(k) >= 0) equip[k] = (equip[k] || 0) + (mods[k] || 0);
      recompute(false);
      return api;
    },

    // Full save/restore blob — feed straight back to makeStats via opts if desired.
    snapshot() {
      return {
        level, hp: cur.hp, mp: cur.mp, maxHp, maxMp,
        seed: { ...seed }, equip: { ...equip }, stats: effBlock(),
      };
    },
  };
  return api;
}

export const stats = { makeStats };
