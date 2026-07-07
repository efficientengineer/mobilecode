// engine/control/tools.js
// TOOLS — the verbs a farmer SWINGS at a tile or object: hoe, watering can, axe,
// pickaxe, scythe, fishing rod. This is the action layer that sits BETWEEN the
// player's input and the soil sim (crops.js) / world objects — where a swing costs
// energy (energy.js vitals) and then mutates whatever it hits. Pure DATA + injected
// helpers (a vitals, an rng, a plot lookup); nothing here draws, reads a clock, or
// touches Math.random, so it runs headless and sim-tests exactly.
//
// A tool DEF is data (a game's tool table):
//   { name, action:"till"|"water"|"chop"|"mine"|"cut"|"fish", energy?, tier?, area?, ... }
//   - action  = which verb this tool performs (dispatches the effect below).
//   - tier    = basic|copper|steel|gold|iridium — upgrades widen the AoE (till/water)
//               and lower the energy per swing (copper→iridium).
//   - area    = tiles across the affected square (odd; overrides the tier default).
//   - a "water" tool also carries a CAN: { capacity, fill, refill(), use(), empty() }.
// Build one with makeTool(def) or a named factory: hoe(), wateringCan(), axe()…
//
//   const can = wateringCan({ tier:'steel' });      // 3×3 sprinkle, holds 40
//   useTool(hoe(), plot, { vitals })                // tills soil, spends energy
//   useTool(can, plot, { vitals })                  // waters a tilled plot, -1 water
//   useTool(can, null, { vitals, center:[tx,tz], plotAt })  // waters the whole 3×3
//
// useTool(tool, target, ctx) -> { ok, effect }
//   - ok=false (no energy spent) when vitals is exhausted / can't afford the swing.
//   - otherwise it spends energy via ctx.vitals.spend and applies the action to the
//     target (or, when ctx.center + ctx.plotAt are given, to every tile in the AoE),
//     returning effect = { action, drops:[...], ...flags }. drops is the game's own
//     item contract: { item, qty }. Compose with inventory/economy via plain data.

// --- tier table: power (chop/mine hits), energyMul (swing cost), area (AoE) -------
const TIERS = {
  basic:   { power: 1, energyMul: 1.0, area: 1 },
  copper:  { power: 2, energyMul: 0.9, area: 1 },
  steel:   { power: 3, energyMul: 0.8, area: 3 },
  gold:    { power: 4, energyMul: 0.7, area: 3 },
  iridium: { power: 5, energyMul: 0.6, area: 5 },
};
// Base energy per swing before the tier discount (Stardew ~2 for hand tools).
const BASE_ENERGY = { till: 2, water: 2, chop: 2, mine: 2, cut: 2, fish: 8 };
const AOE_ACTIONS = { till: true, water: true };   // only these widen with tier

const clamp = (n, lo, hi) => (n < lo ? lo : n > hi ? hi : n);

// Pull a 0..1 roll off an injected rng, tolerating an rng OBJECT ({next}/{range})
// or a bare deterministic function (() => 0.5 in tests). No Math.random ever.
function rngNext(ctx) {
  const r = ctx && ctx.rng;
  if (!r) return 0.5;
  if (typeof r === 'function') return r();
  if (typeof r.next === 'function') return r.next();
  return 0.5;
}

// A watering can's water tank. refill() with no arg tops to capacity (a well/pond).
function makeCan(capacity = 40, fill) {
  return {
    capacity,
    fill: fill == null ? capacity : clamp(fill, 0, capacity),
    refill(n) { this.fill = n == null ? this.capacity : clamp(this.fill + n, 0, this.capacity); return this.fill; },
    use(n = 1) { if (this.fill < n) return false; this.fill -= n; return true; },
    empty() { return this.fill <= 0; },
  };
}

export function makeTool(def = {}) {
  // Normalize a DEF: resolve tier-derived power/area/energy and attach a can for
  // watering tools. Explicit def fields (energy/area/power/capacity) win over tier.
  const action = def.action;
  const tier = def.tier || 'basic';
  const t = TIERS[tier] || TIERS.basic;
  const tool = {
    name: def.name || action || 'tool',
    action,
    tier,
    power: def.power != null ? def.power : t.power,
    area: def.area != null ? def.area : (AOE_ACTIONS[action] ? t.area : 1),
    energy: def.energy != null ? def.energy : Math.max(1, Math.round((BASE_ENERGY[action] || 2) * t.energyMul)),
  };
  if (action === 'water') tool.can = makeCan(def.capacity != null ? def.capacity : 40, def.fill);
  if (action === 'fish') tool.fish = def.fish;         // optional default catch table
  return tool;
}

// --- named factories (thin wrappers over makeTool) --------------------------------
export const hoe         = (o = {}) => makeTool({ name: 'Hoe',          action: 'till', ...o });
export const wateringCan = (o = {}) => makeTool({ name: 'Watering Can', action: 'water', ...o });
export const axe         = (o = {}) => makeTool({ name: 'Axe',          action: 'chop', ...o });
export const pickaxe     = (o = {}) => makeTool({ name: 'Pickaxe',      action: 'mine', ...o });
export const scythe      = (o = {}) => makeTool({ name: 'Scythe',       action: 'cut',  ...o });
export const fishingRod  = (o = {}) => makeTool({ name: 'Fishing Rod',  action: 'fish', ...o });

export function upgrade(tool, tier) {
  // Return a fresh tool at a higher tier, carrying over a can's capacity + fill.
  const next = makeTool({ name: tool.name, action: tool.action, tier, capacity: tool.can ? tool.can.capacity : undefined, fish: tool.fish });
  if (tool.can && next.can) next.can.fill = Math.min(next.can.capacity, tool.can.fill);
  return next;
}

export function energyCost(tool) {
  // What one swing costs (already tier-discounted at makeTool). Ask before acting.
  return tool && tool.energy != null ? tool.energy : 0;
}

export function areaTiles(tool, center) {
  // The square of tile coords a swing covers, centered on `center` [tx,tz]. area=1
  // is just the center; higher tiers give a 3×3 / 5×5 sprinkle. Returns [[tx,tz]…].
  const a = Math.max(1, (tool && tool.area) || 1);
  const r = (a - 1) >> 1;
  const cx = center ? center[0] : 0, cz = center ? center[1] : 0;
  const out = [];
  for (let dz = -r; dz <= r; dz++) for (let dx = -r; dx <= r; dx++) out.push([cx + dx, cz + dz]);
  return out;
}

// Which soil/objects a swing hits: the AoE tiles (via ctx.plotAt) when a center is
// given, else just the single passed target.
function resolveTargets(tool, target, ctx) {
  if (ctx && ctx.center && typeof ctx.plotAt === 'function') {
    const out = [];
    for (const [tx, tz] of areaTiles(tool, ctx.center)) {
      const p = ctx.plotAt(tx, tz);
      if (p != null) out.push(p);
    }
    return out;
  }
  return target != null ? [target] : [];
}

// --- the six verbs. Each mutates the targets and returns { action, drops, …flags }.
const ACTIONS = {
  till(tool, targets, primary, ctx) {
    // Hoe untilled soil so a seed can go in. Skips solid/occupied ground; a game
    // may gate tiles with ctx.canTill(plot) (e.g. tilemap.isSolid). Idempotent.
    let tilled = 0; const cells = [];
    for (const p of targets) {
      if (!p) continue;
      if (ctx && typeof ctx.canTill === 'function' && !ctx.canTill(p)) continue;
      if (p.crop) continue;                       // don't hoe standing crops
      if (!p.tilled) { p.tilled = true; tilled++; }
      cells.push(p);
    }
    return { action: 'till', drops: [], tilled, cells };
  },

  water(tool, targets) {
    // Sprinkle a TILLED plot; each tile drains 1 from the can, and the can can run
    // dry mid-swing (Stardew scarcity). Only tilled soil holds water.
    const can = tool.can; let watered = 0;
    for (const p of targets) {
      if (!p || !p.tilled) continue;
      if (can && can.empty()) break;              // out of water — stop here
      if (can) can.use(1);
      p.watered = true; watered++;
    }
    return { action: 'water', drops: [], watered, canFill: can ? can.fill : undefined };
  },

  chop(tool, targets) {
    // Fell a tree/stump: each hit knocks `tool.power` off its hp; when it drops to 0
    // it yields wood (obj.wood, default 8) plus any obj.drops. Bigger tools = fewer
    // swings. Returns drops only on the felling blow.
    const drops = []; let felled = 0;
    for (const o of targets) {
      if (!o || o.hp == null || o.hp <= 0) continue;
      o.hp -= tool.power;
      if (o.hp <= 0) {
        o.hp = 0; o.felled = true; felled++;
        drops.push({ item: 'wood', qty: o.wood != null ? o.wood : 8 });
        if (o.drops) for (const d of o.drops) drops.push(d);
      }
    }
    return { action: 'chop', drops, felled };
  },

  mine(tool, targets) {
    // Break a rock / ore node: same hp-over-hits model as chop. A broken node drops
    // obj.drop (default 'stone') × obj.qty, plus any obj.bonus (gems, geodes).
    const drops = []; let broken = 0;
    for (const o of targets) {
      if (!o || o.hp == null || o.hp <= 0) continue;
      o.hp -= tool.power;
      if (o.hp <= 0) {
        o.hp = 0; o.broken = true; broken++;
        drops.push({ item: o.drop || 'stone', qty: o.qty != null ? o.qty : 1 });
        if (o.bonus) for (const d of o.bonus) drops.push(d);
      }
    }
    return { action: 'mine', drops, broken };
  },

  cut(tool, targets, primary, ctx) {
    // Scythe: one swing CLEARS grass or harvests forage. Forage (or anything with a
    // .drop) yields its item; plain grass drops hay on an rng roll (hayChance, 0.5).
    // Doesn't consume durability, and a scythe never costs the felling energy of an
    // axe — it's the cheap wide sweep.
    const drops = []; let cleared = 0;
    for (const o of targets) {
      if (!o || o.cleared) continue;
      o.cleared = true; cleared++;
      if (o.drop) drops.push({ item: o.drop, qty: o.qty != null ? o.qty : 1 });
      else if (o.kind === 'grass' && rngNext(ctx) < (o.hayChance != null ? o.hayChance : 0.5)) {
        drops.push({ item: 'hay', qty: 1 });
      }
    }
    return { action: 'cut', drops, cleared };
  },

  fish(tool, targets, primary, ctx) {
    // Cast at a fishing spot: an rng roll vs catchChance decides a bite, then a
    // second roll picks from the spot's (or tool's, or ctx's) fish table. Injected
    // rng keeps it deterministic — same seed, same catch.
    const spot = primary || {};
    const table = spot.fish || tool.fish || (ctx && ctx.fish) || ['fish'];
    const chance = spot.catchChance != null ? spot.catchChance : (tool.catchChance != null ? tool.catchChance : 0.7);
    const drops = []; let caught = null;
    if (rngNext(ctx) < chance && table.length) {
      const i = clamp(Math.floor(rngNext(ctx) * table.length), 0, table.length - 1);
      caught = table[i];
      drops.push({ item: caught, qty: 1 });
    }
    return { action: 'fish', drops, caught };
  },
};

export function useTool(tool, target, ctx = {}) {
  // Swing `tool` at `target` (or the AoE around ctx.center). Energy gates the swing:
  // an exhausted / broke farmer can't act (ok:false, nothing mutated, no energy
  // spent). Otherwise pay the cost, apply the verb, and report the drops.
  if (!tool || !tool.action) return { ok: false, reason: 'no-tool', effect: null };
  const handler = ACTIONS[tool.action];
  if (!handler) return { ok: false, reason: 'unknown-action', effect: null };

  const cost = energyCost(tool);
  const vitals = ctx.vitals;
  if (vitals) {                                    // gate BEFORE mutating anything
    const broke = typeof vitals.canAfford === 'function'
      ? !vitals.canAfford(cost)
      : (vitals.energy != null && vitals.energy < cost);
    if (vitals.exhausted || broke) return { ok: false, reason: 'exhausted', effect: null };
  }

  const targets = resolveTargets(tool, target, ctx);
  const effect = handler(tool, targets, target, ctx);
  if (vitals && typeof vitals.spend === 'function') vitals.spend(cost);   // commit the swing
  effect.cost = cost;
  return { ok: true, effect };
}

export const tools = {
  makeTool, hoe, wateringCan, axe, pickaxe, scythe, fishingRod,
  upgrade, useTool, areaTiles, energyCost,
};
