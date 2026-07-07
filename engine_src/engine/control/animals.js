// engine/control/animals.js
// FARM ANIMALS — the coop/barn husbandry loop (Stardew: chickens/cows/sheep/…),
// the livestock sibling of crops.js. Where crops turn watered soil into produce,
// animals turn HAY + AFFECTION into produce overnight: feed them, pet them, keep
// them housed on stormy nights, and a content, grown animal lays an egg / fills a
// pail with milk / grows wool by morning. Pure DATA + closures, no world/DOM/clock/
// Math.random — you hand dayPass the day's facts (was it fed, was it housed, what's
// the weather) and it advances one animal one night, deterministically.
//
// An ANIMAL is plain data:
//   { id, kind, name, age, happiness, fed, pettedToday, produce, produceReady, recipe }
//   - age          = days owned (babies < recipe.matures don't produce yet).
//   - happiness    = 0..maxHappiness affection; drives produce QUALITY and gates it.
//   - fed          = fed TODAY (set by feed/feedAll, cleared each dayPass).
//   - pettedToday  = petted TODAY (pet's once/day happiness bump; cleared nightly).
//   - produce      = the item waiting in the coop { item, qty, quality, needsTool? }
//                    or null; produceReady mirrors it for quick HUD checks.
//   - recipe       = what this kind makes (see KINDS) — carried per-animal so a game
//                    can mod one animal without touching the shared table.
//
// A BARN (also a coop — same model) holds animals up to capacity:
//   const barn = makeBarn({ capacity: 8 });
//   barn.add(makeAnimal({ id:'c1', kind:'chicken', name:'Cluck' }));
// Typical day: feedAll(barn, hay) in the morning, pet each animal once, then at
// nightfall dayPass(a, { fed, housed, weather }) per animal; next morning collect(a).
// Compose with inventory/economy (drops are plain {item,qty,quality}) and calendar/
// weather via plain params, never hard imports.

const clamp = (n, lo, hi) => (n < lo ? lo : n > hi ? hi : n);
const MAX_HAPPINESS = 100;

// --- produce recipes per kind -----------------------------------------------------
//   item      = what it drops · qty = units per collection
//   needsTool = a tool the game must have to COLLECT (milk needs a pail, wool shears)
//   matures   = days owned before the FIRST produce (babies grow up first)
//   interval  = days between produce after that (1 = daily egg; wool is slower)
export const KINDS = {
  chicken: { item: 'egg',      qty: 1, matures: 1, interval: 1 },
  duck:    { item: 'duckEgg',  qty: 1, matures: 2, interval: 2 },
  rabbit:  { item: 'wool',     qty: 1, matures: 2, interval: 4, needsTool: 'shears' },
  cow:     { item: 'milk',     qty: 1, matures: 4, interval: 1, needsTool: 'pail' },
  goat:    { item: 'goatMilk', qty: 1, matures: 4, interval: 2, needsTool: 'pail' },
  sheep:   { item: 'wool',     qty: 1, matures: 4, interval: 3, needsTool: 'shears' },
  pig:     { item: 'truffle',  qty: 1, matures: 8, interval: 1 },  // forages when housed=false in fair weather
};

// A stormy/snowy night outside is what harms an animal; rain/sun are fine. Accepts a
// weather STRING (weather.js kind) or an object flag ({ bad } / { storm } / { snow }).
function isBadWeather(w) {
  if (!w) return false;
  if (typeof w === 'object') return !!(w.bad || w.storm || w.snow || w.blizzard);
  return w === 'storm' || w === 'snow' || w === 'blizzard' || w === 'thunder' || w === 'lightning';
}

function hmax(a) { return a.maxHappiness != null ? a.maxHappiness : MAX_HAPPINESS; }

// Affection -> produce quality. Monotone in happiness (a well-loved animal lays
// gold-star eggs); a mature animal gets a small maturity nudge on top.
function produceQuality(a) {
  let q = hmax(a) > 0 ? a.happiness / hmax(a) : 0;
  if (a.age >= 40) q += 0.08;                 // seasoned livestock trend higher
  if (q >= 0.85) return 'gold';
  if (q >= 0.55) return 'silver';
  return 'regular';
}

// A word for the HUD — mirrors the happiness fraction.
function moodOf(a) {
  const f = hmax(a) > 0 ? a.happiness / hmax(a) : 0;
  return f >= 0.85 ? 'thriving' : f >= 0.55 ? 'happy' : f >= 0.25 ? 'content' : 'sad';
}

export function makeAnimal(def = {}) {
  // Build one animal, stamping its kind's recipe (def overrides win). A fresh animal
  // starts at neutral happiness with no produce; produceIn counts down to first drop.
  const kind = def.kind || 'chicken';
  const base = KINDS[kind] || KINDS.chicken;
  const recipe = {
    item: base.item, qty: base.qty, matures: base.matures, interval: base.interval,
    needsTool: base.needsTool, ...(def.recipe || {}),
  };
  return {
    id: def.id,
    kind,
    name: def.name || kind,
    age: def.age != null ? def.age : 0,
    happiness: def.happiness != null ? clamp(def.happiness, 0, def.maxHappiness || MAX_HAPPINESS) : 50,
    maxHappiness: def.maxHappiness != null ? def.maxHappiness : MAX_HAPPINESS,
    fed: !!def.fed,
    pettedToday: !!def.pettedToday,
    produce: def.produce != null ? def.produce : null,
    produceReady: !!def.produceReady,
    recipe,
    // days until the next produce is ready; starts at matures (first drop after that)
    produceIn: def.produceIn != null ? def.produceIn : (recipe.matures != null ? recipe.matures : 1),
  };
}

export function makeBarn({ capacity = 4 } = {}) {
  // A coop/barn: a bounded roster of animals keyed by id. Holds refs (the same
  // objects feed/pet/dayPass mutate); list() returns a shallow COPY so callers can
  // iterate while adding/removing.
  const animals = [];
  return {
    capacity,
    add(a) {
      if (!a || a.id == null) return false;
      if (animals.length >= capacity) return false;           // barn is full
      if (animals.some((x) => x.id === a.id)) return false;    // no duplicate ids
      animals.push(a);
      return true;
    },
    remove(id) {                                              // -> the removed animal or null
      const i = animals.findIndex((a) => a.id === id);
      return i < 0 ? null : animals.splice(i, 1)[0];
    },
    get(id) { return animals.find((a) => a.id === id) || null; },
    list() { return animals.slice(); },
    get count() { return animals.length; },
    isFull() { return animals.length >= capacity; },
  };
}

export function feed(animal, { ration = 1 } = {}) {
  // Give one animal its daily ration (the game already deducted the hay). Idempotent
  // within a day — feeding twice doesn't double anything. Returns whether it ate now.
  if (!animal || animal.fed) return false;
  animal.fed = true;
  animal._ration = ration;
  return true;
}

export function feedAll(barn, hay = 0) {
  // Ration the whole barn from a HAY stockpile (a plain count). Feeds each still-
  // hungry animal 1 hay until the pile runs out. Returns { fed, hayLeft } — store the
  // remaining hay back on the game's silo.
  let left = hay, fed = 0;
  for (const a of barn.list()) {
    if (a.fed) continue;
    if (left <= 0) break;                                    // out of hay — the rest go hungry
    a.fed = true; left -= 1; fed += 1;
  }
  return { fed, hayLeft: left };
}

export function pet(animal, { bump = 5 } = {}) {
  // A once-a-day affection bump (petting/brushing). Returns false if already petted
  // today, so a game can't farm happiness by spamming the button.
  if (!animal || animal.pettedToday) return false;
  animal.pettedToday = true;
  animal.happiness = clamp(animal.happiness + bump, 0, hmax(animal));
  return true;
}

// Happiness deltas applied each night (Stardew-scaled: hunger/exposure sting, a
// tended animal drifts up, neglect nibbles down).
const FED_BONUS = 2;         // fed & sheltered — a good day
const HUNGER_PENALTY = 20;   // no food in the trough
const EXPOSURE_PENALTY = 20; // left outside through a storm/snow
const NEGLECT_PENALTY = 4;   // not petted today

export function dayPass(animal, { fed, housed = true, weather } = {}) {
  // Advance ONE animal one night. Reads the day's facts (fed can be passed or taken
  // from animal.fed; housed=false means left outdoors; weather is the night's roll),
  // adjusts happiness, ages the animal, and — if it was fed, sheltered, and grown —
  // makes produce for the morning. Unfed or storm-exposed animals lose happiness and
  // skip produce entirely. Clears the daily fed/pettedToday flags on the way out.
  const wasFed = fed != null ? fed : animal.fed;
  const exposed = housed === false && isBadWeather(weather);

  let dh = 0;
  if (wasFed) dh += FED_BONUS; else dh -= HUNGER_PENALTY;
  if (exposed) dh -= EXPOSURE_PENALTY;
  if (!animal.pettedToday) dh -= NEGLECT_PENALTY;
  animal.happiness = clamp(animal.happiness + dh, 0, hmax(animal));

  animal.age += 1;                                           // one day older

  let produced = null;
  const canProduce = wasFed && !exposed && !animal.produceReady;
  if (canProduce) {
    if (animal.produceIn > 0) animal.produceIn -= 1;         // grow up / count the cadence
    if (animal.produceIn <= 0) {
      const r = animal.recipe;
      produced = {
        item: r.item,
        qty: r.qty != null ? r.qty : 1,
        quality: produceQuality(animal),
        ...(r.needsTool ? { needsTool: r.needsTool } : {}),
      };
      animal.produce = produced;
      animal.produceReady = true;
      animal.produceIn = r.interval != null ? r.interval : 1; // wait before the next one
    }
  }

  // New day: yesterday's feeding and petting don't carry over.
  animal.fed = false;
  animal.pettedToday = false;

  return { produced, mood: moodOf(animal) };
}

export function collect(animal, { tools } = {}) {
  // Take the ready produce out of the coop, clearing it. If the produce needsTool and
  // the game passes a `tools` set/array that LACKS it, collection fails (null) and the
  // produce stays put — you need the pail/shears first. With no `tools` arg it's
  // permissive (the game vouches for the tool). Returns { item, qty, quality[, needsTool] }.
  if (!animal || !animal.produceReady || !animal.produce) return null;
  const p = animal.produce;
  if (p.needsTool && tools != null && !hasTool(tools, p.needsTool)) return null;
  animal.produce = null;
  animal.produceReady = false;
  return p;
}

function hasTool(tools, name) {
  if (!tools) return false;
  if (typeof tools.has === 'function') return tools.has(name);   // a Set
  if (Array.isArray(tools)) return tools.includes(name);
  return !!tools[name];                                          // a plain flag map
}

export const animals = {
  makeBarn, makeAnimal, feed, feedAll, pet, dayPass, collect, KINDS,
};
