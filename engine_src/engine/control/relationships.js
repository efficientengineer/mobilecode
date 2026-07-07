// engine/control/relationships.js
// NPC FRIENDSHIP + gifting — the SOCIAL SPINE of a life-sim (Stardew hearts).
// Every villager has one bond: a running point total you raise by TALKING each
// day, GIFTING things they like, and doing quests; leave them alone and the bond
// slips a little (decay). Points roll up into HEARTS (points / pointsPerHeart,
// capped at maxHearts) — the number the UI shows and other systems gate on
// (recipes, events, marriage). Gifts are rationed: only `giftsPerWeek` land per
// villager, and reaction depends on their taste table.
//
// Pure DATA + closures — no world/DOM/timers/Math.random, fully deterministic
// (gifting/talking need no rng). A game holds ONE relationships object, injects
// the current calendar date into dayReset/weekReset, and reads status(id) for the
// social menu. Compose with calendar.js (call dayReset each morning, weekReset
// each week-start), dialogue.js, quests.js via plain calls — never hard imports.

const clamp = (n, lo, hi) => (n < lo ? lo : n > hi ? hi : n);

// Gift point values by taste bucket — Stardew-ish magnitudes.
const GIFT = { love: 80, like: 45, neutral: 20, dislike: -20, hate: -40 };

// Classify an item against an NPC's taste table. Loved/hated win over like/dislike.
function react(item, prefs = {}) {
  if (prefs.loved && prefs.loved.includes(item)) return "love";
  if (prefs.hated && prefs.hated.includes(item)) return "hate";
  if (prefs.liked && prefs.liked.includes(item)) return "like";
  if (prefs.disliked && prefs.disliked.includes(item)) return "dislike";
  return "neutral";
}

export function makeRelationships({
  maxHearts = 10,        // heart ceiling (bond caps at maxHearts * pointsPerHeart)
  pointsPerHeart = 250,  // points that fill one heart
  giftsPerWeek = 2,      // gifts that LAND per NPC per week; extras bounce
  decay = 2,             // points idle bonds shed each day (talked/gifted are spared)
  talkBump = 20,         // friendship from the first chat of the day
} = {}) {
  const cap = maxHearts * pointsPerHeart;
  const bonds = new Map();   // npcId -> { points, giftedThisWeek, talkedToday, touchedToday }

  function bond(id) {        // lazily meet an NPC the first time they're referenced
    let b = bonds.get(id);
    if (!b) { b = { points: 0, giftedThisWeek: 0, talkedToday: false, touchedToday: false }; bonds.set(id, b); }
    return b;
  }

  const api = {
    maxHearts, pointsPerHeart, giftsPerWeek, decay,

    meet(id) { return bond(id), id; },          // register an NPC (idempotent)
    known(id) { return bonds.has(id); },
    points(id) { return bonds.has(id) ? bonds.get(id).points : 0; },
    hearts(id) { return Math.min(maxHearts, Math.floor(this.points(id) / pointsPerHeart)); },

    // Raw friendship adjustment — quests, events, cutscenes. Clamped to [0..cap].
    // Positive changes spare the NPC from today's decay (you interacted).
    add(id, n = 0) {
      const b = bond(id);
      b.points = clamp(b.points + n, 0, cap);
      if (n > 0) b.touchedToday = true;
      return b.points;
    },

    // Give an item. Reaction comes from the NPC's taste table; the delta is added
    // once, respecting the weekly cap. Over the cap -> nothing lands, reaction "none".
    gift(id, item, prefs = {}) {
      const b = bond(id);
      if (b.giftedThisWeek >= giftsPerWeek) return { delta: 0, reaction: "none" };
      const reaction = react(item, prefs);
      const delta = GIFT[reaction];
      b.points = clamp(b.points + delta, 0, cap);
      b.giftedThisWeek += 1;
      b.touchedToday = true;
      return { delta, reaction };
    },

    // A daily hello — once per day per NPC; later chats the same day do nothing.
    talk(id) {
      const b = bond(id);
      if (b.talkedToday) return { delta: 0, talked: false };
      b.talkedToday = true;
      b.touchedToday = true;
      b.points = clamp(b.points + talkBump, 0, cap);
      return { delta: talkBump, talked: true };
    },

    // Overnight slip: every KNOWN bond you didn't touch today loses `decay`, then
    // the daily flags reset. Pass exceptIds (array/Set) to spare pinned NPCs
    // (spouse, best friends). Call once each morning from the calendar.
    decayDay(exceptIds) {
      const spare = exceptIds instanceof Set ? exceptIds
        : Array.isArray(exceptIds) ? new Set(exceptIds) : null;
      for (const [id, b] of bonds) {
        if (!b.touchedToday && !(spare && spare.has(id))) {
          b.points = clamp(b.points - decay, 0, cap);
        }
        b.talkedToday = false;
        b.touchedToday = false;
      }
      return this;
    },

    // Reset just the once-a-day locks (talk) without decaying — if a game wants to
    // split "new day" from "apply decay". decayDay already does both.
    dayReset() {
      for (const b of bonds.values()) { b.talkedToday = false; b.touchedToday = false; }
      return this;
    },

    // New week: refill everyone's gift allowance. Call on the season/week rollover.
    weekReset() {
      for (const b of bonds.values()) b.giftedThisWeek = 0;
      return this;
    },

    status(id) {
      const b = bond(id);
      return {
        hearts: Math.min(maxHearts, Math.floor(b.points / pointsPerHeart)),
        points: b.points,
        giftedThisWeek: b.giftedThisWeek,
        talkedToday: b.talkedToday,
      };
    },

    // Serialization for save.js: plain data in/out.
    toJSON() {
      const out = {};
      for (const [id, b] of bonds) out[id] = { ...b };
      return out;
    },
    load(data = {}) {
      bonds.clear();
      for (const id in data) {
        const b = bond(id);
        b.points = clamp(data[id].points || 0, 0, cap);
        b.giftedThisWeek = data[id].giftedThisWeek || 0;
        b.talkedToday = !!data[id].talkedToday;
        b.touchedToday = !!data[id].touchedToday;
      }
      return this;
    },
  };
  return api;
}

export const relationships = { makeRelationships, react, GIFT };
