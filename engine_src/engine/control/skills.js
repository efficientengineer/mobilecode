// engine/control/skills.js
// SKILLS — the Stardew life-sim skill layer: five (or your own) skills that each
// climb their own XP curve to a level cap, unlocking PERKS along the way and
// branching PROFESSIONS at the milestone tiers (level 5, level 10). A sibling of
// progression.js (one open-ended level bar) but shaped for a FARM life-sim: many
// parallel tracks, auto perks that just "turn on" at a level, and mutually
// exclusive career picks. Pure DATA — every skill's xp/level and every profession
// pick lives in a closure, so a HUD bar, a level-up popup, a perk-select screen
// and a headless balance sim all drive the SAME store. No Math.random, no timers.
//
//   const sk = skills.makeSkills();                 // farming/mining/foraging/fishing/combat, cap 10
//   sk.addXp('fishing', 500);   // -> { level, leveledUp, gained }  (rolls multi-level)
//   sk.level('fishing'); sk.xp('fishing'); sk.progress('fishing');  // 0..1 to next
//   sk.totalLevel();            // sum across all skills (gates events/marriage/etc.)
//
//   sk.definePerks('fishing', [
//     { level: 1, id: 'bait' },                               // AUTO — on at lvl 1
//     { level: 5, id: 'fisher',  choice: true },              // tier-5 profession...
//     { level: 5, id: 'trapper', choice: true },              // ...pick ONE
//     { level: 10, id: 'angler',  choice: true, requires: 'fisher' },  // branch off it
//     { level: 10, id: 'pirate',  choice: true, requires: 'fisher' },
//   ]);
//   sk.choose('fishing', 5, 'fisher');   // exclusive at that tier (replaces any prior pick)
//   sk.has('bait');    // true once fishing hits lvl 1  (earned + chosen)
//   sk.has('fisher');  // true once chosen
//   sk.earned();       // auto perks whose level is reached   sk.chosen() — professions picked
//
// A `curve(level) -> xp needed to climb FROM level to level+1` sets the pace; the
// default is the Stardew skill table (100 to reach lvl 1 ... 5000 to reach lvl 10).

// -------- curve presets ---------------------------------------------------------

export function stardewCurve() {
  // Stardew's per-skill xp table: incremental cost to reach each next level
  // (cumulative 100/380/770/1300/2150/3300/4800/6900/10000/15000). Clamps past 10.
  const inc = [100, 280, 390, 530, 850, 1150, 1500, 2100, 3100, 5000];
  return (level) => inc[Math.min(Math.max(0, level | 0), inc.length - 1)];
}

export function linearSkillCurve(base = 100) {
  // Steady arithmetic ramp: level N costs base*(N+1). Predictable and grindy.
  return (level) => base * (level + 1);
}

// -------- the store -------------------------------------------------------------

export function makeSkills({
  skills = ['farming', 'mining', 'foraging', 'fishing', 'combat'],
  curve = stardewCurve(),
  maxLevel = 10,
} = {}) {
  const names = skills.slice();
  const state = {};   // skill -> { xp (lifetime), into (xp into current level), level }
  const perks = {};   // skill -> [ {level, id, choice?, requires?} ]
  const picks = {};   // skill -> { [level]: chosen perkId }   (one pick per tier)
  for (const s of names) { state[s] = { xp: 0, into: 0, level: 0 }; perks[s] = []; picks[s] = {}; }

  const has_ = (s) => Object.prototype.hasOwnProperty.call(state, s);

  function xp(skill) { return has_(skill) ? state[skill].xp : 0; }
  function level(skill) { return has_(skill) ? state[skill].level : 0; }

  function progress(skill) {
    // Fraction 0..1 from the current level to the next (1 when maxed).
    const st = state[skill];
    if (!st || st.level >= maxLevel) return 1;
    const need = curve(st.level) || 1;
    return Math.max(0, Math.min(1, st.into / need));
  }

  function xpToNext(skill) {
    const st = state[skill];
    if (!st || st.level >= maxLevel) return 0;
    return Math.max(0, (curve(st.level) || 0) - st.into);
  }

  function addXp(skill, n) {
    // Add xp to ONE skill, rolling as many level-ups as it earns; caps at maxLevel.
    const st = state[skill];
    n = +n || 0;
    if (!st || n <= 0) return { level: st ? st.level : 0, leveledUp: 0, gained: 0 };
    st.xp += n; st.into += n;
    let leveledUp = 0;
    while (st.level < maxLevel && st.into >= curve(st.level)) {
      st.into -= curve(st.level); st.level++; leveledUp++;
    }
    if (st.level >= maxLevel) st.into = 0;         // no dangling overflow at the cap
    return { level: st.level, leveledUp, gained: n };
  }

  function totalLevel() {
    let t = 0; for (const s of names) t += state[s].level; return t;
  }

  // -------- perks / professions -------------------------------------------------

  function definePerks(skill, defs = []) {
    // Register a skill's unlock table. A def is { level, id, choice?, requires? }:
    //   no `choice`  -> AUTO perk, earned the moment level >= its level.
    //   `choice`     -> a PROFESSION option at its tier; pick one via choose().
    //   `requires`   -> gate a later pick on an earlier perk id (Stardew branching).
    if (!has_(skill)) return api;
    for (const d of defs) perks[skill].push({ level: d.level | 0, id: d.id, choice: !!d.choice, requires: d.requires || null });
    return api;                                     // chainable
  }

  function choices(skill, lvl) {
    // The profession options offered at a tier (for a perk-select screen).
    return (perks[skill] || []).filter((p) => p.choice && p.level === lvl);
  }

  function choose(skill, lvl, perkId) {
    // Pick ONE profession at a tier — exclusive (overwrites any prior pick at that
    // level). Fails if the level isn't reached or a `requires` gate isn't met.
    const st = state[skill]; if (!st) return false;
    const opt = (perks[skill] || []).find((p) => p.id === perkId && p.level === lvl && p.choice);
    if (!opt || st.level < lvl) return false;
    if (opt.requires && !has(opt.requires)) return false;
    picks[skill][lvl] = perkId;
    return true;
  }

  function earned() {
    // Auto perks whose level has been reached, across every skill.
    const out = [];
    for (const s of names) for (const p of perks[s]) if (!p.choice && state[s].level >= p.level) out.push(p.id);
    return out;
  }

  function chosen() {
    // Professions the player has actively picked, across every skill.
    const out = [];
    for (const s of names) for (const lvl in picks[s]) out.push(picks[s][lvl]);
    return out;
  }

  function has(perkId) {
    // The gameplay query: does the player have this perk? (auto-earned OR chosen)
    if (perkId == null) return false;
    for (const s of names) {
      for (const p of perks[s]) if (!p.choice && p.id === perkId && state[s].level >= p.level) return true;
      for (const lvl in picks[s]) if (picks[s][lvl] === perkId) return true;
    }
    return false;
  }

  // -------- save integration (compose with save.js) -----------------------------

  function toJSON() {
    const o = { skills: {}, picks: {} };
    for (const s of names) { o.skills[s] = { xp: state[s].xp, into: state[s].into, level: state[s].level }; o.picks[s] = { ...picks[s] }; }
    return o;
  }

  function load(data) {
    if (!data) return api;
    for (const s of names) {
      const d = data.skills && data.skills[s];
      if (d) { state[s].xp = +d.xp || 0; state[s].into = +d.into || 0; state[s].level = Math.min(maxLevel, d.level | 0); }
      const p = data.picks && data.picks[s];
      if (p) picks[s] = { ...p };
    }
    return api;
  }

  const api = {
    xp, level, progress, xpToNext, addXp, totalLevel,
    definePerks, choices, choose, earned, chosen, has,
    list() { return names.slice(); },
    maxLevel,
    toJSON, load,
  };
  return api;
}

export const skills = { makeSkills, stardewCurve, linearSkillCurve };
