// engine/control/weather.js
// Reusable DAILY WEATHER oracle for a farm/foraging sim — rolled each morning to
// shape the day: rain auto-waters the farm, storms add lightning, snow blankets
// winter. Swappable + node-safe like the other control components; it holds NO
// world state, only the last roll and a peeked-but-uncommitted forecast.
//
//   const wx = makeWeather({ rng, tables });   // rng: ()=>0..1 (or {next()})
//   const day = wx.roll('spring');             // -> { kind, rainsCrops, ... }
//   if (day.rainsCrops) farm.waterAll();        // rain/storm skip the watering can
//   const peek = wx.forecast('spring');        // TV forecast: next day, uncommitted
//
// Compose by PLAIN DATA: a game reads the boolean flags off the roll (or effects())
// and drives its own farm/fishing/energy systems. Deterministic given the rng, so a
// seed replays the exact same season of weather.

// Weather KINDS and the descriptive flags a game reads off each. Numbers are
// Stardew-ish: rain & storm auto-water crops and buff fishing; storms crackle with
// lightning; anything wet/cold nudges the player indoors (crafting/social bonus).
export const KINDS = ['sun', 'rain', 'storm', 'wind', 'snow'];

const EFFECTS = {
  //        rainsCrops lightning indoorsBonus fishingBonus foragingBonus wateringNeeded
  sun:   { rainsCrops: false, lightning: false, indoorsBonus: false, fishingBonus: false, foragingBonus: false, wateringNeeded: true },
  rain:  { rainsCrops: true,  lightning: false, indoorsBonus: true,  fishingBonus: true,  foragingBonus: false, wateringNeeded: false },
  storm: { rainsCrops: true,  lightning: true,  indoorsBonus: true,  fishingBonus: true,  foragingBonus: false, wateringNeeded: false },
  wind:  { rainsCrops: false, lightning: false, indoorsBonus: false, fishingBonus: false, foragingBonus: true,  wateringNeeded: true },
  snow:  { rainsCrops: false, lightning: false, indoorsBonus: true,  fishingBonus: false, foragingBonus: false, wateringNeeded: true },
};

// effects(kind) -> a FRESH copy of the flag set (non-mutating; unknown -> sun).
export function effects(kind) {
  return { ...(EFFECTS[kind] || EFFECTS.sun) };
}

// Sensible per-season weighted tables. Spring is rainy, summer bakes with the odd
// storm, fall is windy, winter snows and NEVER rains (no rain/storm entries).
export const DEFAULT_TABLES = {
  spring: [{ weight: 50, kind: 'sun' }, { weight: 30, kind: 'rain' }, { weight: 12, kind: 'wind' }, { weight: 8, kind: 'storm' }],
  summer: [{ weight: 62, kind: 'sun' }, { weight: 16, kind: 'wind' }, { weight: 14, kind: 'rain' }, { weight: 8, kind: 'storm' }],
  fall:   [{ weight: 44, kind: 'sun' }, { weight: 26, kind: 'wind' }, { weight: 22, kind: 'rain' }, { weight: 8, kind: 'storm' }],
  winter: [{ weight: 42, kind: 'snow' }, { weight: 43, kind: 'sun' }, { weight: 15, kind: 'wind' }],
};

// Normalize the injected rng to a 0..1 draw fn. Accepts a bare fn (test default
// () => 0.5), a core makeRng object ({ next() }), or nothing (deterministic 0.5).
function draw01(rng) {
  if (typeof rng === 'function') return rng;
  if (rng && typeof rng.next === 'function') return () => rng.next();
  return () => 0.5;
}

// Weighted pick over [{ weight, kind }] using one draw. Falls back to a lone 'sun'
// entry for an empty/missing table so it never returns undefined.
function pickKind(table, next) {
  const list = (table && table.length) ? table : [{ weight: 1, kind: 'sun' }];
  let total = 0;
  for (const e of list) total += (e.weight > 0 ? e.weight : 0);
  if (total <= 0) return list[0].kind;
  let r = next() * total;
  for (const e of list) {
    r -= (e.weight > 0 ? e.weight : 0);
    if (r < 0) return e.kind;
  }
  return list[list.length - 1].kind;   // rounding guard
}

export function makeWeather({ rng, tables } = {}) {
  const next = draw01(rng);
  const table = { ...DEFAULT_TABLES, ...(tables || {}) };
  let last = null;        // the last COMMITTED roll (today's weather)
  let pending = null;     // a peeked-but-uncommitted forecast: { season, day }

  // Build a full day report: the kind plus every flag spread in, so a game can read
  // day.rainsCrops / day.lightning / day.indoorsBonus (per spec) or any other flag.
  const report = (season) => {
    const kind = pickKind(table[season], next);
    return { kind, season, ...effects(kind) };
  };

  return {
    // roll(season): advance to a new day. Consumes a matching forecast so the TV
    // never lies — what you saw is what you get — else draws fresh. Sets today().
    roll(season) {
      let day;
      if (pending && pending.season === season) { day = pending.day; pending = null; }
      else { pending = null; day = report(season); }
      last = day;
      return day;
    },
    // today(): the last committed roll (null before the first roll).
    today() { return last; },
    // forecast(season): peek the NEXT day without committing. Caches the draw so a
    // repeated peek is stable and the following roll() returns this exact result.
    forecast(season) {
      if (!pending || pending.season !== season) pending = { season, day: report(season) };
      return pending.day;
    },
    effects,   // convenience passthrough
  };
}

export const weather = { makeWeather, effects, KINDS, EFFECTS, DEFAULT_TABLES };
