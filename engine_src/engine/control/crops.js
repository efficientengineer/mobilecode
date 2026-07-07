// engine/control/crops.js
// FARMING / crops — the Stardew-style daily plant → water → grow → harvest loop,
// as a PURE soil sim the rest of the game drives. Nothing here draws, reads the
// clock, or touches Math.random; you feed it the day's facts (season + whether it
// rained) and it advances the plants one day. Compose it with the world/economy/
// inventory/save layers via PLAIN DATA, not imports.
//
// A crop DEF is data (a game's crop table, e.g. from JSON):
//   { id, name, seasons:['spring'], stages:[1,1,1,2], produce:'parsnip',
//     regrow?, yield?, seedPrice?, sellPrice? }
//   - stages   = days spent in each growth stage; total days = sum(stages).
//   - regrow   = days to ripen AGAIN after each harvest (omit = one-shot crop).
//   - yield    = units per harvest (default 1); produce = the item id it drops.
//
// A PLOT is the soil model (make one per farmable tile):
//   { tilled, crop, stage, dayInStage, watered, dead, readyToHarvest, regrowLeft }
//   - crop points at the live DEF (null = empty soil); stage/dayInStage track
//     progress; watered is today's flag (cleared each morning by endOfDayReset).
//
// Typical day: player tills + plants in the morning, waters watered plots, then at
// nightfall the game calls growDay(plot, { season, rained }) for every plot and
// endOfDayReset(plot) to clear the water. Deterministic and headless.

export function makePlot() {
  // Fresh untilled soil. A game keeps one plot per farmable tile (index by tile
  // coord from tilemap.worldToTile) and never shares refs between tiles.
  return { tilled: false, crop: null, stage: 0, dayInStage: 0, watered: false, dead: false, readyToHarvest: false, regrowLeft: 0 };
}

export function makeCropbook(defs = []) {
  // Index a crop table for lookup + season queries. `defs` is a plain array of
  // crop DEFs; the book never mutates them.
  const byId = new Map();
  for (const d of defs) if (d && d.id != null) byId.set(d.id, d);
  return {
    get: (id) => byId.get(id) || null,
    all: () => [...byId.values()],
    inSeason: (id, season) => {                 // is this crop plantable this season?
      const d = byId.get(id);
      return !!d && seasonOk(d, season);
    },
  };
}

// A crop with no `seasons` list grows year-round; otherwise the season must match.
function seasonOk(def, season) {
  return season == null || !def.seasons || !def.seasons.length || def.seasons.includes(season);
}

export function till(plot) {
  // Hoe the soil so something can be planted. Idempotent; leaves any standing crop
  // untouched (re-tilling watered/planted ground is a no-op in Stardew too).
  plot.tilled = true;
  return plot;
}

export function plant(plot, cropDef, season) {
  // Sow a seed. Fails (returns false) on untilled soil, an occupied plot, or an
  // off-season crop. On success the plot holds the DEF and starts at stage 0.
  if (!plot.tilled || plot.crop || !cropDef) return false;
  if (!seasonOk(cropDef, season)) return false;
  plot.crop = cropDef;
  plot.stage = 0; plot.dayInStage = 0;
  plot.watered = false; plot.dead = false; plot.readyToHarvest = false; plot.regrowLeft = 0;
  return true;
}

export function water(plot) {
  // Mark the plot watered for today. Only tilled soil holds water; the flag is
  // what growDay reads and endOfDayReset clears each morning.
  if (plot.tilled) plot.watered = true;
  return plot;
}

export function growDay(plot, { season, rained = false } = {}) {
  // Advance the plant ONE day. A live crop out of its season dies at the day roll.
  // Growth only happens if the plot was watered or it rained — otherwise the crop
  // stalls (loses no progress, just waits). Ripe crops sit ready until harvested.
  if (!plot.crop || plot.dead) return plot;
  const def = plot.crop;
  if (!seasonOk(def, season)) {                 // wrong season = withers overnight
    plot.dead = true; plot.readyToHarvest = false;
    return plot;
  }
  if (plot.readyToHarvest) return plot;         // fully ripe, awaiting harvest
  if (!plot.watered && !rained) return plot;    // thirsty — no growth today

  const stages = def.stages || [];
  if (plot.stage < stages.length) {             // first maturation: walk the stages
    plot.dayInStage += 1;
    while (plot.stage < stages.length && plot.dayInStage >= stages[plot.stage]) {
      plot.dayInStage -= stages[plot.stage];
      plot.stage += 1;
    }
    if (plot.stage >= stages.length) plot.readyToHarvest = true;
  } else if (def.regrow && plot.regrowLeft > 0) { // re-ripening a regrow crop
    plot.regrowLeft -= 1;
    if (plot.regrowLeft <= 0) plot.readyToHarvest = true;
  }
  return plot;
}

export function harvest(plot) {
  // Reap a ripe plot -> { produce, qty }, or null if nothing's ready. A regrow crop
  // resets to its regrow timer and keeps its roots (produces again); a one-shot
  // crop is pulled, leaving tilled soil ready to replant.
  if (!plot.crop || !plot.readyToHarvest) return null;
  const def = plot.crop;
  const drop = { produce: def.produce, qty: def.yield != null ? def.yield : 1 };
  plot.readyToHarvest = false;
  if (def.regrow) {
    plot.regrowLeft = def.regrow;               // stage stays past the last; ripen anew
  } else {
    plot.crop = null; plot.stage = 0; plot.dayInStage = 0; plot.regrowLeft = 0;
  }
  return drop;
}

export function endOfDayReset(plot) {
  // Morning bookkeeping: yesterday's water evaporates. Call on every plot at the
  // start of each day, before the player re-waters.
  plot.watered = false;
  return plot;
}

export const crops = { makePlot, makeCropbook, till, plant, water, growDay, harvest, endOfDayReset };
