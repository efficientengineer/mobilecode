// engine/control/schedules.js
// NPC DAILY SCHEDULES — where every villager is at each minute of the day, the
// thing that makes a town feel LIVED-IN (Stardew's "everyone has somewhere to
// be"). A schedule is plain DATA tied to calendar.js time: a list of timed
// entries, plus optional variants that swap the whole day out on a rainy Tuesday
// in winter once you're good friends. Nothing here paths or renders — it just
// answers "who should be where, now?" so a game can walk NPCs to entry.pos.
//
//   const s = makeSchedule({ npcId:'abigail', entries:[
//     { at:'06:00', place:'bedroom',  pos:[2,3] },
//     { at:'10:00', place:'shop',     pos:[8,1], action:'browse' },
//     { at:'22:00', place:'bedroom',  pos:[2,3], action:'sleep' } ],
//     variants:[ { weather:'rain', entries:[ { at:'06:00', place:'home', pos:[2,3] } ] } ] });
//   const t = cal.clock().hour*60 + cal.clock().minute;   // minutes-of-day
//   s.at(t, { weather:'rain' });   // -> the active block right now
//
//   const dir = makeDirector([s, ...]);
//   for (const m of dir.update(t, ctx)) walkNpc(m.npcId, m.entry.pos);  // only movers
//
// Time is MINUTES-OF-DAY (0..1439), the same hour*60+minute calendar.js reports;
// entries wrap, so before the first block an NPC is still at the last (overnight)
// one. Pure, deterministic, node-safe: no Date/DOM/timers/Math.random, all state
// in closures. ctx carries the day's facts { dayOfWeek, season, weather, hearts }
// (hearts may be a number or a { npcId: n } map so one director serves everyone).

const MINS = 1440;
const wrap = (t) => (((t % MINS) + MINS) % MINS);

// "HH:MM" | minutes -> minutes-of-day. Bare numbers pass through (already mins).
function toMin(at) {
  if (typeof at === 'number') return wrap(at | 0);
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(at).trim());
  return m ? wrap((+m[1]) * 60 + (+m[2])) : 0;
}

// Normalize + sort a raw entry list into an immutable, time-ordered block list.
function compile(entries) {
  return (entries || [])
    .map((e) => ({ ...e, min: toMin(e.at) }))
    .sort((a, b) => a.min - b.min);
}

// hearts in ctx is either a flat number (single subject) or a per-npc map.
function heartsOf(ctx, npcId) {
  const h = ctx && ctx.hearts;
  if (h == null) return 0;
  return typeof h === 'number' ? h : (h[npcId] || 0);
}

// Does a variant's guard match today? Every declared key must agree; `hearts` is
// a MINIMUM (friendship gate). Unspecified keys are wildcards. Returns a
// specificity score (# of matched conditions) so the tightest match wins, or -1.
function matchScore(v, ctx, npcId) {
  let score = 0;
  if (v.dayOfWeek != null) { if (ctx.dayOfWeek !== v.dayOfWeek) return -1; score++; }
  if (v.season != null)    { if (ctx.season !== v.season) return -1; score++; }
  if (v.weather != null)   { if (ctx.weather !== v.weather) return -1; score++; }
  if (v.hearts != null)    { if (heartsOf(ctx, npcId) < v.hearts) return -1; score++; }
  return score;
}

export function makeSchedule(def = {}) {
  const npcId = def.npcId;
  const base = compile(def.entries);
  // Pre-compile each variant's day once; keep declaration order for tie-breaks.
  const variants = (def.variants || []).map((v) => ({ guard: v, entries: compile(v.entries) }));

  // Choose the day's block list for this ctx: the highest-specificity matching
  // variant, else the default. Earliest declaration wins ties.
  function dayFor(ctx) {
    if (!ctx || !variants.length) return base;
    let best = base, bestScore = 0;
    for (const v of variants) {
      const s = matchScore(v.guard, ctx, npcId);
      if (s > bestScore) { bestScore = s; best = v.entries; }
    }
    return best;
  }

  // Latest block whose start time has passed; before the first, wrap to the last
  // (the NPC is still where it spent the night).
  function at(time, ctx) {
    const list = dayFor(ctx);
    if (!list.length) return null;
    const t = wrap(time);
    let cur = list[list.length - 1];   // overnight fallback
    for (const e of list) { if (e.min <= t) cur = e; else break; }
    return cur;
  }

  // The upcoming block after `time` (wraps to the first block of tomorrow).
  function next(time, ctx) {
    const list = dayFor(ctx);
    if (!list.length) return null;
    const t = wrap(time);
    for (const e of list) if (e.min > t) return e;
    return list[0];
  }

  const place = (time, ctx) => { const e = at(time, ctx); return e ? e.place : null; };
  const posAt = (time, ctx) => { const e = at(time, ctx); return e ? e.pos : null; };

  return { npcId, entries: base, at, place, posAt, next, dayFor };
}

export function makeDirector(schedules = []) {
  const list = Array.isArray(schedules) ? schedules.slice() : [schedules];
  let last = new Map();   // npcId -> last active entry object (identity = same block)

  const api = {
    // Advance to `time`; return ONLY the NPCs whose active block just changed
    // (moved:true), so a game paths those to entry.pos and leaves the rest be.
    // The first update reports everyone (initial placement).
    update(time, ctx) {
      const out = [];
      for (const s of list) {
        const entry = s.at(time, ctx);
        if (!entry) continue;
        if (last.get(s.npcId) !== entry) {
          last.set(s.npcId, entry);
          out.push({ npcId: s.npcId, entry, moved: true });
        }
      }
      return out;
    },

    // Every NPC's current block right now, movers or not — for a full snapshot
    // (initial spawn, save/load, debug overlay). Does not touch change-tracking.
    positions(time, ctx) {
      return list.map((s) => ({ npcId: s.npcId, entry: s.at(time, ctx) }))
        .filter((r) => r.entry);
    },

    add(s) { list.push(s); return api; },
    reset() { last = new Map(); return api; },   // re-emit everyone on next update
    get schedules() { return list; },
  };
  return api;
}

export const schedules = { makeSchedule, makeDirector };
