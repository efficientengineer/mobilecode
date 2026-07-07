// engine/control/progression.js
// PROGRESSION — XP, levels and unlock/skill trees. The "how a player grows over a
// run or a career" meta-game system, a sibling of save/inventory/economy. It is
// PURE DATA: level, xp and the set of unlocked nodes live in a closure, never in
// window/localStorage/DOM, so a level-up popup, a talent screen, a loot reward and
// a headless balance sim all drive the SAME store. No Math.random, no timers.
//
//   const lvl = progression.makeLevels({ curve: progression.expCurve(100), max: 50 });
//   const r = lvl.add(320);        // -> { level, leveledUp, gained } (rolls multi-level)
//   lvl.level; lvl.xp; lvl.xpToNext; lvl.progress;   // for the HUD bar
//
//   const tree = progression.makeSkillTree(
//     [{ id:'atk1', cost:1 }, { id:'atk2', cost:2, requires:['atk1'] }],
//     { points: 3 });
//   tree.available();      // ['atk1'] — prereqs met, not yet taken
//   tree.unlock('atk2');   // false — 'atk1' not unlocked yet (gate holds)
//   tree.unlock('atk1'); tree.unlock('atk2');  // now the chain opens
//
//   const p = progression.prestige({ levels: lvl, reward: t => t * 5 });
//   if (p.ready()) p.do();  // reset levels to 1, bank prestige points for the tree
//
// A `curve(level) -> xpNeeded` decides the cost of the NEXT level; three presets
// (linearCurve/expCurve/table) cover most games and you can pass your own fn.

// -------- curve presets ---------------------------------------------------------
// Each returns curve(level) -> xp needed to climb FROM `level` to `level+1`.

export function linearCurve(base = 100) {
  // Steady arithmetic ramp: level N costs base*N. Predictable, grindy-but-fair.
  return (level) => base * level;
}

export function expCurve(base = 100, factor = 1.5) {
  // Geometric ramp: each level costs `factor`× the last. The classic RPG feel.
  return (level) => Math.round(base * Math.pow(factor, level - 1));
}

export function table(costs = []) {
  // Hand-authored per-level costs [lvl1, lvl2, ...]; clamps to the last entry for
  // any level past the table (so a finite table still feeds an open-ended climb).
  const arr = costs.slice();
  return (level) => {
    if (!arr.length) return Infinity;                 // no table = can't advance
    const i = Math.min(Math.max(1, level | 0), arr.length) - 1;
    return arr[i];
  };
}

function resolveCurve(curve) {
  if (typeof curve === 'function') return curve;
  if (Array.isArray(curve)) return table(curve);      // pass an array = a table
  return linearCurve(100);                             // sensible default
}

// -------- levels: xp accumulation + multi-level roll-over ------------------------

export function makeLevels({ curve, max = 99, level = 1, xp = 0 } = {}) {
  const need = resolveCurve(curve);
  const cap = Math.max(1, max | 0);
  let lvl = Math.min(cap, Math.max(1, level | 0));
  let bank = Math.max(0, xp || 0);          // xp banked toward the NEXT level
  let total = 0;                            // lifetime xp fed in (for stats/saves)

  const req = () => (lvl >= cap ? 0 : Math.max(0, need(lvl)));

  // Pour in `amount` xp; roll up as many levels as it buys (an overflow gift can
  // jump several at once). At max level xp stops banking. Returns what happened.
  function add(amount) {
    const gift = Math.max(0, amount || 0);
    total += gift;
    if (lvl >= cap) { bank = 0; return { level: lvl, leveledUp: false, gained: 0 }; }
    bank += gift;
    let gained = 0;
    while (lvl < cap) {
      const n = req();
      if (n <= 0 || bank < n) break;        // n<=0 guard keeps the loop finite
      bank -= n; lvl++; gained++;
    }
    if (lvl >= cap) bank = 0;               // no dangling overflow at the ceiling
    return { level: lvl, leveledUp: gained > 0, gained };
  }

  // Jump straight to a level (cheats, NG+, tests); drops any partial bank.
  function setLevel(n) {
    lvl = Math.min(cap, Math.max(1, n | 0)); bank = 0;
    return lvl;
  }

  function reset() { lvl = 1; bank = 0; total = 0; }

  return {
    add, setLevel, reset,
    get level() { return lvl; },
    get xp() { return bank; },                        // progress within this level
    get xpToNext() { return Math.max(0, req() - bank); }, // xp REMAINING to next level
    get needed() { return req(); },                   // total xp this level costs
    get progress() { const n = req(); return n > 0 ? Math.min(1, bank / n) : 1; },
    get max() { return cap; },
    get maxed() { return lvl >= cap; },
    get totalXp() { return total; },
    serialize() { return { level: lvl, xp: bank, total }; },
    restore(s) { if (s) { lvl = Math.min(cap, Math.max(1, s.level | 0)); bank = Math.max(0, s.xp || 0); total = Math.max(0, s.total || 0); } },
  };
}

// -------- skill tree: gated unlocks paid with points ----------------------------
// A node is { id, cost?, requires?:[ids] }. `requires` are prerequisite node ids
// that must be unlocked first; `cost` (default 0) is deducted from the point pool.

export function makeSkillTree(nodes = [], { points = 0 } = {}) {
  const defs = new Map();
  for (const n of nodes) {
    if (!n || n.id == null) continue;
    defs.set(n.id, {
      id: n.id,
      cost: Math.max(0, n.cost || 0),
      requires: Array.isArray(n.requires) ? n.requires.slice() : [],
    });
  }
  const taken = new Set();
  let pts = Math.max(0, points || 0);

  const unlocked = (id) => taken.has(id);

  // Are all prerequisites of `id` unlocked? (unknown/empty requires = yes.)
  function met(id) {
    const d = defs.get(id);
    if (!d) return false;
    for (const r of d.requires) if (!taken.has(r)) return false;
    return true;
  }

  // Could unlock(id) succeed right now — exists, unclaimed, prereqs met, affordable.
  function canUnlock(id) {
    const d = defs.get(id);
    return !!d && !taken.has(id) && met(id) && pts >= d.cost;
  }

  // Claim a node: only when reachable AND paid for. Deducts cost, returns success.
  function unlock(id) {
    if (!canUnlock(id)) return false;
    pts -= defs.get(id).cost;
    taken.add(id);
    return true;
  }

  // The frontier: nodes whose prereqs are satisfied but that aren't taken yet
  // (ignores affordability so a UI can show reachable-but-too-expensive nodes).
  function available() {
    const out = [];
    for (const id of defs.keys()) if (!taken.has(id) && met(id)) out.push(id);
    return out;
  }

  function grant(n) { pts = Math.max(0, pts + (n | 0)); return pts; }   // bank/skill points
  function spend(n) {                                    // manual pool debit
    const c = Math.max(0, n | 0);
    if (pts < c) return false;
    pts -= c; return true;
  }

  const spent = () => { let s = 0; for (const id of taken) s += defs.get(id).cost; return s; };

  // Respec: wipe all unlocks and refund every point spent (a talent reset item).
  function respec() { pts += spent(); taken.clear(); }

  return {
    unlock, unlocked, has: unlocked, canUnlock, met, available, grant, spend, respec,
    get points() { return pts; },
    get spent() { return spent(); },
    all: () => [...defs.keys()],
    unlockedList: () => [...taken],
    serialize() { return { points: pts, taken: [...taken] }; },
    restore(s) { if (s) { pts = Math.max(0, s.points || 0); taken.clear(); for (const id of s.taken || []) if (defs.has(id)) taken.add(id); } },
  };
}

// -------- prestige: cash a maxed run in for permanent points ---------------------
// The soft-reset loop: when a `levels` instance hits its ceiling (or a `min`
// level), `do()` resets it, bumps the prestige tier and banks `reward(tier)`
// points — feed those straight into a makeSkillTree for a meta-progression tree.

export function prestige({ levels = null, reward = (t) => t, min = null, reset = null } = {}) {
  let tier = 0;
  let points = 0;

  // Gate: default is "levels maxed"; a numeric `min` lets you prestige early.
  function ready() {
    if (min != null) return !!levels && levels.level >= min;
    return !!levels && levels.maxed;
  }

  function doPrestige() {
    if (!ready()) return 0;
    tier++;
    const gain = Math.max(0, reward(tier) || 0);
    points += gain;
    if (levels) levels.reset();
    if (typeof reset === 'function') reset(tier);       // reset other game state too
    return gain;
  }

  function spend(n) {
    const c = Math.max(0, n | 0);
    if (points < c) return false;
    points -= c; return true;
  }

  return {
    ready, do: doPrestige, spend,
    grant(n) { points = Math.max(0, points + (n | 0)); return points; },
    get tier() { return tier; },
    get points() { return points; },
    serialize() { return { tier, points }; },
    restore(s) { if (s) { tier = Math.max(0, s.tier | 0); points = Math.max(0, s.points || 0); } },
  };
}

export const progression = {
  makeLevels, linearCurve, expCurve, table, makeSkillTree, prestige,
};
