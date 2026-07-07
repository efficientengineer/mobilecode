// engine/control/quests.js
// QUEST / OBJECTIVE tracking — the GOALS side of a game (dialogue.js is the talky
// side, and quest flags often live in the same save bag). A quest is plain data:
//   { id, objectives:[{ id, event, need=1, count?, optional?, hidden?, match? }],
//     reward?, requires?, repeatable? }
// You feed the log EVENT NAMES (not the engine bus — you decide when to forward
// 'enemy-died', 'item-picked', 'zone-entered'), and every active objective
// listening for that name ticks toward its `need`. When all REQUIRED objectives
// of a quest are met the quest completes (fires onComplete); turnIn() then gates
// the reward behind completion + prerequisites.
//
// Pure, deterministic, headless: no world/DOM/timers/Math.random. All state lives
// in the returned closure; reward dispensing goes through an optional injected
// `grant(reward, quest)` adapter (wallet/inventory) so it stays node-safe and
// sim-testable — fire events, assert objective counts + quest completion + gating.

// --- objective / quest authoring helpers (terse, data-only) --------------------
// A counter accrues over many events; a flag trips on the first. Both are just
// objectives with a `need`, but the named builders read better at the call site.
export function counterObjective(id, event, need = 1, opts = {}) {
  return { id, event, need: Math.max(1, need | 0 || 1), ...opts };
}
export function flagObjective(id, event, opts = {}) {
  return { id, event, need: 1, ...opts };
}
export function makeQuest(id, objectives = [], opts = {}) {
  return { id, objectives, ...opts };            // opts: reward, requires, title, repeatable
}

// Normalize an authored objective into live tracking state. `count` seeds current
// progress (e.g. a restored save); `match(data)` optionally filters by event data
// so one 'enemy-died' event only ticks the "kill 5 WOLVES" objective.
function liveObjective(o, i) {
  const need = Math.max(1, (o.need | 0) || 1);
  const count = Math.max(0, Math.min(need, o.count | 0));
  return {
    id: o.id != null ? o.id : 'obj' + i,
    event: o.event,
    need,
    count,
    optional: !!o.optional,
    hidden: !!o.hidden,
    match: typeof o.match === 'function' ? o.match : null,
    desc: o.desc || '',
    done: count >= need,
  };
}

function buildRecord(quest) {
  const objectives = (quest.objectives || []).map(liveObjective);
  return {
    id: quest.id,
    title: quest.title || quest.id,
    reward: quest.reward != null ? quest.reward : null,
    requires: quest.requires != null ? quest.requires : null,
    repeatable: !!quest.repeatable,
    objectives,
    state: 'active',                             // active | complete | turnedin
  };
}

// A quest is complete when every REQUIRED (non-optional) objective is done. If a
// quest is ALL-optional (no required ones), it completes when all of them finish.
function allRequiredDone(rec) {
  const required = rec.objectives.filter((o) => !o.optional);
  const pool = required.length ? required : rec.objectives;
  return pool.length > 0 && pool.every((o) => o.done);
}

export function makeQuestLog(opts = {}) {
  const { onStart, onProgress, onComplete, onTurnIn, grant } = opts;
  const quests = new Map();                       // id -> record (active/complete/turnedin)
  const turnedIn = new Set();                     // ids fully turned in (prereq ledger)

  // Public read-only view of a quest; hidden objectives stay secret until revealed
  // (any progress or completion) so a HUD can list them without spoiling.
  function view(rec, includeHidden = false) {
    if (!rec) return null;
    const objectives = rec.objectives
      .filter((o) => includeHidden || !o.hidden || o.count > 0 || o.done)
      .map((o) => ({
        id: o.id, desc: o.desc, event: o.event,
        count: o.count, need: o.need, done: o.done, optional: o.optional, hidden: o.hidden,
      }));
    return {
      id: rec.id, title: rec.title, state: rec.state,
      complete: rec.state !== 'active', turnedIn: rec.state === 'turnedin',
      reward: rec.reward, objectives,
    };
  }

  // The tiny query surface a `requires` predicate gets, so prerequisites can be
  // "quest A turned in", an array of ids, or arbitrary logic over the log.
  const query = {
    turnedIn: (id) => turnedIn.has(id),
    completed: (id) => isCompleted(id),
    active: (id) => { const r = quests.get(id); return !!r && r.state !== 'turnedin'; },
  };
  function requiresMet(requires) {
    if (!requires) return true;
    if (typeof requires === 'function') return !!requires(query);
    if (Array.isArray(requires)) return requires.every((id) => turnedIn.has(id));
    return turnedIn.has(requires);
  }

  function isCompleted(id) {
    if (turnedIn.has(id)) return true;
    const r = quests.get(id);
    return !!r && (r.state === 'complete' || r.state === 'turnedin');
  }

  function checkComplete(rec) {                    // promote active -> complete once
    if (rec.state === 'active' && allRequiredDone(rec)) {
      rec.state = 'complete';
      if (onComplete) onComplete(view(rec, true), api);
      return true;
    }
    return false;
  }

  const api = {
    // Begin tracking a quest. No-op (returns null) if it's already in the log, if a
    // non-repeatable quest was already turned in, or if `requires` isn't satisfied.
    // A quest whose objectives are already met (preseeded counts) completes at once.
    start(quest) {
      if (!quest || quest.id == null) return null;
      const id = quest.id;
      const existing = quests.get(id);
      if (existing) {                              // already in the log...
        if (quest.repeatable && existing.state === 'turnedin') quests.delete(id);
        else return null;                          // ...and not a claimed repeatable
      }
      if (turnedIn.has(id) && !quest.repeatable) return null;
      if (!requiresMet(quest.requires)) return null;
      if (quest.repeatable) turnedIn.delete(id);
      const rec = buildRecord(quest);
      quests.set(id, rec);
      if (onStart) onStart(view(rec, true), api);
      checkComplete(rec);
      return view(rec, true);
    },

    // Feed an event name; advance every ACTIVE objective listening for it (by
    // `amount`, clamped to `need`, filtered by optional `match(data)`). Returns the
    // ids of quests that COMPLETED on this call (also surfaced via onComplete).
    progress(eventName, amount = 1, data) {
      const step = amount == null ? 1 : amount;
      const completedNow = [];
      for (const rec of quests.values()) {
        if (rec.state === 'turnedin') continue;    // finished quests still tick optional/bonus goals
        let advanced = false;
        for (const o of rec.objectives) {
          if (o.done || o.event !== eventName) continue;
          if (o.match && !o.match(data)) continue;
          o.count = Math.max(0, Math.min(o.need, o.count + step));
          if (o.count >= o.need) o.done = true;
          advanced = true;
          if (onProgress) onProgress(view(rec, true), o, api);
        }
        if (advanced && checkComplete(rec)) completedNow.push(rec.id);
      }
      return completedNow;
    },

    // Claim a finished quest's reward — gated behind completion AND prerequisites.
    // Marks it turned in (a prereq for later quests), dispenses via the injected
    // `grant` adapter if any, and returns the reward (or null if not claimable).
    turnIn(id) {
      const rec = quests.get(id);
      if (!rec || rec.state !== 'complete') return null;
      if (!requiresMet(rec.requires)) return null;
      rec.state = 'turnedin';
      turnedIn.add(id);
      const reward = rec.reward;
      if (grant && reward != null) grant(reward, view(rec, true), api);
      if (onTurnIn) onTurnIn(view(rec, true), reward, api);
      return reward != null ? reward : null;
    },

    completed: (id) => isCompleted(id),            // all required objectives met?
    canStart: (quest) => !!quest && quest.id != null
      && !quests.has(quest.id) && (!turnedIn.has(quest.id) || !!quest.repeatable)
      && requiresMet(quest.requires),
    canTurnIn: (id) => { const r = quests.get(id); return !!r && r.state === 'complete' && requiresMet(r.requires); },

    // Quests still in the log (in progress OR finished but not yet claimed).
    active: () => {
      const out = [];
      for (const rec of quests.values()) if (rec.state !== 'turnedin') out.push(view(rec, false));
      return out;
    },
    all: () => Array.from(quests.values(), (r) => view(r, true)),
    get: (id, includeHidden = true) => view(quests.get(id), includeHidden),
    has: (id) => quests.has(id),
    // Drop an unfinished quest from the log (fails/aborts). Returns whether it left.
    abandon: (id) => quests.delete(id),

    // --- persistence: serialize progress into a save bag and rehydrate later ----
    // snapshot() is plain JSON; restore() rebuilds live objectives from a catalog
    // (id -> quest def) so counts survive a reload (pairs with save.js).
    snapshot() {
      return {
        quests: Array.from(quests.values(), (r) => ({
          id: r.id, state: r.state,
          counts: r.objectives.reduce((m, o) => { m[o.id] = o.count; return m; }, {}),
        })),
        turnedIn: Array.from(turnedIn),
      };
    },
    restore(state, catalog = {}) {
      if (!state) return api;
      quests.clear(); turnedIn.clear();
      for (const id of state.turnedIn || []) turnedIn.add(id);
      for (const q of state.quests || []) {
        const def = catalog[q.id];
        if (!def) continue;
        const rec = buildRecord(def);
        const counts = q.counts || {};
        for (const o of rec.objectives) {
          if (counts[o.id] != null) {
            o.count = Math.max(0, Math.min(o.need, counts[o.id] | 0));
            o.done = o.count >= o.need;
          }
        }
        rec.state = q.state === 'turnedin' || q.state === 'complete' ? q.state : 'active';
        quests.set(q.id, rec);
      }
      return api;
    },
  };
  return api;
}

export const quests = {
  makeQuestLog, makeQuest, counterObjective, flagObjective,
};
