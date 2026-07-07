// engine/control/party.js
// PARTY / ROSTER management for an FF6-style JRPG — the bookkeeping around your
// cast of characters that the battle core (battle.js) and menus both read from.
// FF6 has ~14 recruitable characters but fields at most 4; this owns WHO is in
// your roster, WHICH up-to-N are the active party, their ORDER (leader first),
// and each member's ROW (front/back). It is PURE DATA: a member is a plain object
//
//   { id, name, stats (a stats.js store), equipment?, spells? (learned), row }
//
// and party never does damage math or ATB timing — it wraps round-9 stats blocks
// and hands the active members to makeBattle as pre-shaped slots. No engine deps,
// no window/DOM/timers, no Math.random; all state lives in this closure.
//
//   const p = party.makeParty({ roster: [terra, locke, edgar, celes, sabin], activeMax: 4 });
//   p.setActive(['terra','locke','edgar','celes']);   // pick the fielded four
//   p.swap('celes', 'sabin');                          // bench Celes, field Sabin
//   p.setRow('edgar', 'back');                         // halve his physical dmg taken
//   const allies = p.formationSlots('ally');           // drop straight into makeBattle
//   if (p.wiped()) gameOver();                         // every active member KO'd

// A member is "down" when its wrapped stats block reads KO — mirror battle.js's
// tolerant check so raw stat blocks, stores and plain flags all count as dead.
function down(m) {
  const s = m && m.stats;
  if (!s) return false;
  return s.isKO === true || s.alive === false ||
         (typeof s.hp === 'number' && s.hp <= 0);
}

export function makeParty({ roster = [], activeMax = 4 } = {}) {
  const cap = Math.max(1, Math.round(activeMax));
  const members = roster.slice();                 // full cast, insertion order
  for (const m of members) if (m.row == null) m.row = 'front';  // default stance
  const byIdMap = new Map(members.map((m) => [m.id, m]));

  // The active party is an ordered list of ids (leader first); everyone else is
  // benched. Seed it with the first `cap` members so a fresh party is playable.
  let activeIds = members.slice(0, cap).map((m) => m.id);

  const has = (id) => byIdMap.has(id);
  const idx = (id) => activeIds.indexOf(id);
  // Reconcile activeIds against the roster: drop stale ids, keep order, cap length.
  function reconcile() {
    activeIds = activeIds.filter((id, i) => has(id) && activeIds.indexOf(id) === i).slice(0, cap);
  }

  const api = {
    // -------- reads ---------------------------------------------------------
    roster() { return members.slice(); },
    byId(id) { return byIdMap.get(id) || null; },
    inActive(id) { return idx(id) >= 0; },
    // The fielded members, leader first — the up-to-N that fight and show on the HUD.
    active() { return activeIds.map((id) => byIdMap.get(id)).filter(Boolean); },
    // Everyone NOT in the active party — the reserve you can swap in.
    bench() { return members.filter((m) => idx(m.id) < 0); },
    leader() { return byIdMap.get(activeIds[0]) || null; },

    // -------- roster edits --------------------------------------------------
    // Recruit a member; fills an empty active slot if the party isn't full yet.
    add(member) {
      if (!member || has(member.id)) return member;
      if (member.row == null) member.row = 'front';
      members.push(member); byIdMap.set(member.id, member);
      if (activeIds.length < cap) activeIds.push(member.id);
      return member;
    },
    // Remove a member entirely — also drops them from the active party if fielded.
    remove(id) {
      if (!has(id)) return false;
      const i = members.findIndex((m) => m.id === id);
      members.splice(i, 1); byIdMap.delete(id);
      activeIds = activeIds.filter((a) => a !== id);
      return true;
    },

    // -------- active party --------------------------------------------------
    // Choose the fielded party outright: keep the given order, skip unknown ids,
    // dedupe, and cap at activeMax. Leader = ids[0].
    setActive(ids = []) {
      const seen = new Set(); activeIds = [];
      for (const id of ids) {
        if (has(id) && !seen.has(id) && activeIds.length < cap) { activeIds.push(id); seen.add(id); }
      }
      return api;
    },
    // Swap two members by id. Both active -> reorder (change turn/leader order).
    // One active + one benched -> the bencher takes the active one's slot. Both
    // benched or unknown -> no-op. Returns whether anything moved.
    swap(idA, idB) {
      if (idA === idB || !has(idA) || !has(idB)) return false;
      const ia = idx(idA), ib = idx(idB);
      if (ia >= 0 && ib >= 0) { activeIds[ia] = idB; activeIds[ib] = idA; }
      else if (ia >= 0) activeIds[ia] = idB;          // B (bench) replaces A
      else if (ib >= 0) activeIds[ib] = idA;          // A (bench) replaces B
      else return false;
      return true;
    },

    // -------- rows ----------------------------------------------------------
    // Front/back stance (back row typically halves physical damage dealt/taken —
    // formulas.js reads member.row). Anything but "back" normalizes to "front".
    setRow(id, row) {
      const m = byIdMap.get(id);
      if (m) m.row = row === 'back' ? 'back' : 'front';
      return api;
    },
    rowOf(id) { const m = byIdMap.get(id); return m ? m.row : null; },

    // -------- combat status -------------------------------------------------
    alive() { return api.active().filter((m) => !down(m)); },
    wiped() { const a = api.active(); return a.length > 0 && a.every(down); },

    // Map the active party to BATTLE SLOTS ready for makeBattle({ allies|enemies }).
    // Each slot is a thin, live view over its member: id/name/side/row + getters
    // that delegate speed/alive/hp/isKO to the wrapped stats block, so ATB timing
    // and KO checks stay canonical. `member` and `stats` are exposed for perform().
    formationSlots(side = 'ally') {
      return api.active().map((m, slot) => ({
        id: m.id, name: m.name, side, slot, row: m.row,
        member: m, stats: m.stats,
        equipment: m.equipment, spells: m.spells,
        get speed() { const s = m.stats; return s ? (typeof s.get === 'function' ? s.get('speed') : s.speed) || 0 : 0; },
        get hp() { return m.stats ? m.stats.hp : undefined; },
        get isKO() { return down(m); },
        get alive() { return !down(m); },
      }));
    },
  };

  reconcile();
  return api;
}

export const party = { makeParty };
