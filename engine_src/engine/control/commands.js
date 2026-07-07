// engine/control/commands.js
// BATTLE COMMAND SETS — the FF6 signature that every character owns a UNIQUE menu of
// battle commands (Fight/Magic/Item plus a personal skill: Steal, Blitz, SwdTech,
// Tools, Lore, Throw...). This is the MENU layer that sits on top of the ATB core:
// battle.js owns timing/order, formulas.js/spells.js own the numbers, and THIS owns
// "what verbs does this unit get, and what does picking one do."
//
//   const menu = commands.makeCommandSet([ commands.attack(), commands.magic(),
//                                          commands.item(), commands.steal() ]);
//   menu.list(sabin);                                  // visible+enabled verbs
//   menu.run('Fight', sabin, [goblin], { formulas, rng });   // resolve -> results[]
//
// A command is DATA + one resolver:
//   { name, kind:"fight"|"magic"|"item"|"skill", target?, mp?, enabled?(user),
//     resolve(user, targets, ctx) -> results[] }
// run() is the gate: it hides/blocks a disabled command, refuses an mp-gated one when
// the user is short, then delegates the actual EFFECT to injected resolvers on ctx
// (ctx.formulas / ctx.spells / ctx.rng / ctx.spellbook / ctx.inventory) so this file
// hard-imports NOTHING from its siblings and stays node-testable on plain objects.
// Pure, deterministic (inject rng — a () => 0.5 works), no window/DOM/timers.

// --- tiny helpers ----------------------------------------------------------
// rng may be a fn () -> 0..1 OR a core makeRng() with .next(); normalize both ways.
function roll(rng) { return !rng ? 0 : typeof rng === 'function' ? rng() : typeof rng.next === 'function' ? rng.next() : 0; }
function asRng(rng) { return !rng ? { next: () => 0 } : typeof rng.next === 'function' ? rng : typeof rng === 'function' ? { next: rng } : { next: () => 0 }; }
function has(list, x) { return x != null && (Array.isArray(list) ? list.indexOf(x) !== -1 : list && typeof list.has === 'function' ? list.has(x) : false); }
function toArr(t) { return t == null ? [] : Array.isArray(t) ? t : [t]; }
function clampInt(v, lo, hi) { v = Math.round(v || 0); return v < lo ? lo : v > hi ? hi : v; }

// Read a stat off a stats.js store (.get) OR a plain object, with a fallback.
function statOf(u, key, dflt = 0) {
  if (!u) return dflt;
  if (typeof u.get === 'function') { const v = u.get(key); return v == null ? dflt : v; }
  return u[key] != null ? u[key] : dflt;
}
function maxHpOf(u) { return u.maxHp != null ? u.maxHp : u.hpMax != null ? u.hpMax : u.hp != null ? u.hp : 0; }
function isKO(u) { return !!u && (u.isKO === true || u.dead === true || (typeof u.hp === 'number' && u.hp <= 0)); }
function mpOf(u) { return statOf(u, 'mp', 0); }

// Attach flags/props onto a results array (mirrors spells.cast's `.cast`) and return it.
function flag(arr, props) { for (const k in props) arr[k] = props[k]; return arr; }

// --- effect application (works on a stats.js store OR a plain {hp,mp} object) ----
function hurt(t, amount) {                          // + = damage, - = absorb/heal
  if (amount < 0) return healUnit(t, -amount);
  if (typeof t.damage === 'function') return t.damage(amount);
  t.hp = Math.max(0, (t.hp || 0) - amount);
  if (t.hp <= 0) t.dead = true;
  return t.hp;
}
function healUnit(t, amount) {
  if (typeof t.heal === 'function') return t.heal(amount);
  const mh = maxHpOf(t) || Infinity;
  t.hp = Math.min(mh, (t.hp || 0) + Math.max(0, amount));
  return t.hp;
}
function restoreMpUnit(t, amount) {
  if (typeof t.restoreMp === 'function') return t.restoreMp(amount);
  const mm = t.maxMp != null ? t.maxMp : Infinity;
  t.mp = Math.min(mm, (t.mp || 0) + Math.max(0, amount));
  return t.mp;
}
function spendMp(u, n) {
  if (typeof u.spendMp === 'function') return u.spendMp(n);
  u.mp = Math.max(0, (u.mp || 0) - n);
  return true;
}
// Push a rider status NAME onto target.statuses for a battle system to realize later.
function applyRider(t, status, chance, ctx) {
  if (!status) return null;
  if (roll(ctx.rng) >= (chance == null ? 1 : chance)) return null;
  (t.statuses || (t.statuses = [])).push(status);
  return status;
}

// --- shared damage kernel --------------------------------------------------
// One power-based hit routed through the INJECTED formulas: prefer resolveAttack
// (full HIT->ELEMENT->CRIT->VARIANCE pipeline), fall back to physical/magical, and
// as a last resort a bare power number. `ignoreDef` (mechanical Tools) forces the
// direct branch with defense zeroed. Applies the damage and returns one result.
function powerHit(user, t, opt, ctx) {
  const { power = 50, element, magical = true, ignoreDef = false, accuracy } = opt;
  const f = ctx.formulas, rng = asRng(ctx.rng);
  let v;
  if (f && f.resolveAttack && !ignoreDef) {
    const act = { power, element, accuracy: accuracy != null ? accuracy : 1 };
    v = f.resolveAttack(magical
      ? { attacker: user, defender: t, spell: act, rng }
      : { attacker: user, defender: t, weapon: act, rng });
  } else if (f && (magical ? f.magical : f.physical)) {
    v = magical
      ? f.magical({ magic: statOf(user, 'magic', 10), mdef: ignoreDef ? 0 : statOf(t, 'mdefense', 0), power, level: statOf(user, 'level', 1), rng })
      : f.physical({ atk: statOf(user, 'vigor', 5) * 2, def: ignoreDef ? 0 : statOf(t, 'defense', 0), power, level: statOf(user, 'level', 1), rng });
    v.missed = false;
  } else {
    v = { amount: Math.max(1, power), crit: false, missed: false };
  }
  if (!v.missed) hurt(t, v.amount);
  return { target: t, amount: v.missed ? 0 : v.amount, crit: !!v.crit, missed: !!v.missed, tag: v.tag || null };
}
function powerHitAll(user, targets, opt, ctx) {
  const out = [];
  for (const t of targets) { if (isKO(t)) continue; out.push(powerHit(user, t, opt, ctx)); }
  return flag(out, { landed: true });
}
// Broaden the chosen target(s) to a whole side when a skill/tier is group-scoped and
// the caller handed a living side pool on ctx (ctx.enemies / ctx.allies).
function scope(def, targets, ctx) {
  if (def && def.target === 'all-enemies' && ctx.enemies) return ctx.enemies;
  if (def && def.target === 'all-allies' && ctx.allies) return ctx.allies;
  return targets;
}

// =====================================================================
// BASELINE COMMANDS — the three every FF6 hero shares.
// =====================================================================

// Fight — a plain physical swing through ctx.formulas. Weapon comes from opts.weapon,
// ctx.weapon, or user.weapon (else power-1 fists); pass opts.backRow for the row rule.
export function attack(opts = {}) {
  return {
    name: opts.name || 'Fight', kind: 'fight', target: opts.target || 'one-enemy',
    resolve(user, targets, ctx) {
      const f = ctx.formulas, rng = asRng(ctx.rng);
      const weapon = opts.weapon || ctx.weapon || user.weapon || { power: 1 };
      const out = [];
      for (const t of targets) {
        if (isKO(t)) continue;
        let v;
        if (f && f.resolveAttack) v = f.resolveAttack({ attacker: user, defender: t, weapon, rng, backRow: opts.backRow });
        else if (f && f.physical) { v = f.physical({ atk: weapon.atk != null ? weapon.atk : statOf(user, 'vigor', 5) * 2, def: statOf(t, 'defense', 0), power: weapon.power || 1, level: statOf(user, 'level', 1), rng }); v.missed = false; }
        else v = { amount: Math.max(1, statOf(user, 'vigor', 5) * 2 - statOf(t, 'defense', 0)), crit: false, missed: false };
        if (!v.missed) hurt(t, v.amount);
        out.push({ target: t, amount: v.missed ? 0 : v.amount, crit: !!v.crit, missed: !!v.missed, tag: v.tag || null });
      }
      return flag(out, { landed: true });
    },
  };
}

// Magic — opens the spellbook. The chosen spell rides in on ctx.spell (a name resolved
// through opts.book/ctx.spellbook, or a spell def object); the effect + MP spend are
// delegated wholesale to ctx.spells.cast, so this command never touches damage math.
export function magic(opts = {}) {
  return {
    name: opts.name || 'Magic', kind: 'magic', target: opts.target || 'one-enemy',
    resolve(user, targets, ctx) {
      const bk = opts.book || ctx.spellbook;
      const sp = typeof ctx.spell === 'string' ? (bk && bk.get ? bk.get(ctx.spell) : null) : (ctx.spell || null);
      if (!sp || !ctx.spells || !ctx.spells.cast) return flag([], { landed: false, reason: 'no-spell', cast: false });
      return ctx.spells.cast(user, sp, scope(sp, targets, ctx), ctx);   // cast owns the MP gate
    },
  };
}

// Item — use a consumable. The chosen item rides in on ctx.item (a def: { heal?,
// restoreMp?, revive?, damage?, element?, cures?[] }); optionally decremented from
// ctx.inventory. Heals cap at maxHp, revive touches only the fallen, damage items hurt.
export function item(opts = {}) {
  return {
    name: opts.name || 'Item', kind: 'item', target: opts.target || 'one-ally',
    resolve(user, targets, ctx) {
      const it = ctx.item || opts.item;
      if (!it) return flag([], { landed: false, reason: 'no-item' });
      if (ctx.inventory && ctx.inventory.remove) ctx.inventory.remove(it.id || it.name || it, 1);
      const out = [];
      for (const t of targets) out.push(useConsumable(user, t, it, ctx));
      return flag(out, { landed: true });
    },
  };
}
function useConsumable(user, t, it, ctx) {
  const r = { target: t, amount: 0, healed: false, revived: false, missed: false, status: null };
  if (it.revive && isKO(t)) {
    const mh = maxHpOf(t), frac = it.revive <= 1 ? it.revive : 0.5;
    const amt = it.revive > 1 ? it.revive : Math.max(1, Math.round((mh || 1) * frac));
    if (typeof t.revive === 'function') t.revive(frac); else { t.dead = false; t.hp = Math.min(mh || amt, amt); }
    r.amount = amt; r.healed = true; r.revived = true; return r;
  }
  if (isKO(t)) { r.missed = true; return r; }        // ordinary items skip the fallen
  if (it.heal) { healUnit(t, it.heal); r.amount += it.heal; r.healed = true; }
  if (it.restoreMp) restoreMpUnit(t, it.restoreMp);
  if (it.damage) { hurt(t, it.damage); r.amount = it.damage; }
  if (it.cures && Array.isArray(t.statuses)) t.statuses = t.statuses.filter((s) => !has(it.cures, s));
  return r;
}

// =====================================================================
// FF6 UNIQUE COMMANDS — data-driven examples of the signature skills.
// =====================================================================

// Steal (Locke) — an rng-gated grab. Chance = base ± a small level edge; on success
// pull loot from target.steal (an item, a list, or { common, rare, rareChance }) and,
// if ctx.inventory is present, stow it. Returns { success, item } per target.
export function steal(opts = {}) {
  const base = opts.chance != null ? opts.chance : 0.5;
  return {
    name: opts.name || 'Steal', kind: 'skill', target: opts.target || 'one-enemy',
    resolve(user, targets, ctx) {
      const out = [];
      for (const t of targets) {
        if (isKO(t)) continue;
        const edge = (statOf(user, 'level', 1) - statOf(t, 'level', 1)) * 0.01;
        const chance = Math.max(0.05, Math.min(1, base + edge));
        const success = roll(ctx.rng) < chance;
        let stolen = null;
        if (success) {
          stolen = pickSteal(t, ctx);
          if (stolen && ctx.inventory && ctx.inventory.add) ctx.inventory.add(stolen.id || stolen.name || stolen, 1);
        }
        out.push({ target: t, success, item: stolen, missed: !success, amount: 0 });
      }
      return flag(out, { landed: true });
    },
  };
}
function pickSteal(t, ctx) {
  const s = t.steal;
  if (!s) return null;
  if (Array.isArray(s)) { if (!s.length) return null; return s[Math.min(s.length - 1, Math.floor(roll(ctx.rng) * s.length))]; }
  if (s.rare && roll(ctx.rng) < (s.rareChance != null ? s.rareChance : 0.1)) return s.rare;
  return s.common != null ? s.common : s;
}

// Blitz (Sabin) — a fighting-game combo move: the player enters a directional input
// (ctx.input, e.g. ['down','downRight','right']); it fires only when it matches the
// command's `input`, else it botches for no damage (results.landed === false).
export function blitz(opts = {}) {
  const want = opts.input || [];
  return {
    name: opts.name || 'Blitz', kind: 'skill', target: opts.target || 'one-enemy',
    resolve(user, targets, ctx) {
      const got = ctx.input || [];
      if (want.length && want.join('|') !== toArr(got).join('|')) return flag([], { landed: false, reason: 'input' });
      const res = powerHitAll(user, scope(opts, targets, ctx), { power: opts.power != null ? opts.power : 60, element: opts.element, magical: opts.magical !== false }, ctx);
      return res;
    },
  };
}

// SwdTech / Bushido (Cyan) — a CHARGEABLE tier attack. The charge level the player
// held is passed as ctx.tier (or ctx.charge), clamped to the tiers table; higher tiers
// hit harder and some sweep the whole enemy side. `charge` is an alias of the same.
export function swdTech(opts = {}) {
  const tiers = opts.tiers || DEFAULT_TIERS;
  return {
    name: opts.name || 'SwdTech', kind: 'skill', target: opts.target || 'one-enemy',
    resolve(user, targets, ctx) {
      const lvl = clampInt(ctx.tier != null ? ctx.tier : ctx.charge != null ? ctx.charge : 0, 0, tiers.length - 1);
      const tier = tiers[lvl] || {};
      const res = powerHitAll(user, scope(tier, targets, ctx), { power: tier.power || 50, element: tier.element, magical: tier.magical != null ? tier.magical : false }, ctx);
      return flag(res, { tier: tier.name || lvl });
    },
  };
}
export const charge = swdTech;   // Steiner's Charge / any hold-to-power skill

// Tools (Edgar) — mechanical gadgets that IGNORE defense. The chosen tool rides in on
// ctx.tool (a name into the tools map); each is fixed power, some group-scoped, some
// with a status rider (NoiseBlaster/BioBlaster). No MP — machines don't cast.
export function tools(opts = {}) {
  const set = opts.tools || DEFAULT_TOOLS;
  return {
    name: opts.name || 'Tools', kind: 'skill', target: opts.target || 'one-enemy',
    resolve(user, targets, ctx) {
      const def = pickFrom(set, ctx.tool);
      if (!def) return flag([], { landed: false, reason: 'no-tool' });
      const tg = scope(def, targets, ctx);
      const res = def.power ? powerHitAll(user, tg, { power: def.power, element: def.element, magical: false, ignoreDef: def.ignoreDef !== false }, ctx) : flag([], { landed: true });
      if (def.status) for (const t of tg) if (!isKO(t)) { const s = applyRider(t, def.status, def.statusChance, ctx); const hit = res.find((r) => r.target === t); if (hit) hit.status = s; else res.push({ target: t, amount: 0, status: s, missed: false }); }
      return res;
    },
  };
}

// Lore / Enemy Skill (Strago) — cast a learned monster spell. Like Magic but the name
// (ctx.lore/ctx.spell) must be in the known set (opts.learned or user.lore) before it
// resolves through ctx.spells.cast, which owns the MP spend.
export function lore(opts = {}) {
  return {
    name: opts.name || 'Lore', kind: 'magic', target: opts.target || 'one-enemy',
    resolve(user, targets, ctx) {
      const bk = opts.book || ctx.lorebook || ctx.spellbook;
      const pick = typeof ctx.lore === 'string' ? ctx.lore : (typeof ctx.spell === 'string' ? ctx.spell : ctx.spell);
      const known = opts.learned || user.lore;
      const nm = typeof pick === 'string' ? pick : (pick && pick.name);
      if (known && nm && !has(known, nm)) return flag([], { landed: false, reason: 'unknown', cast: false });
      const sp = typeof pick === 'string' ? (bk && bk.get ? bk.get(pick) : null) : (pick || null);
      if (!sp || !ctx.spells || !ctx.spells.cast) return flag([], { landed: false, reason: 'no-spell', cast: false });
      return ctx.spells.cast(user, sp, scope(sp, targets, ctx), ctx);
    },
  };
}

// Throw / Hurl (Shadow) — chuck a weapon or item for one-shot, defense-piercing damage;
// the thrown item (ctx.item, carrying { power?, element?, ignoreDef? }) is consumed.
export function hurl(opts = {}) {
  return {
    name: opts.name || 'Throw', kind: 'skill', target: opts.target || 'one-enemy',
    resolve(user, targets, ctx) {
      const it = ctx.item || opts.item;
      if (!it) return flag([], { landed: false, reason: 'no-item' });
      if (ctx.inventory && ctx.inventory.remove) ctx.inventory.remove(it.id || it.name || it, 1);
      const power = it.power != null ? it.power : it.throwPower != null ? it.throwPower : 60;
      return powerHitAll(user, scope(it, targets, ctx), { power, element: it.element, magical: it.magical === true, ignoreDef: it.ignoreDef !== false }, ctx);
    },
  };
}
// Choose an entry from a { name: def } map / Map, defaulting to the first when unnamed.
function pickFrom(set, name) {
  if (!set) return null;
  if (typeof set.get === 'function' && name != null) return set.get(name) || null;
  if (name != null) return set[name] || null;
  const keys = Object.keys(set); return keys.length ? set[keys[0]] : null;
}

// --- FF6-ish default data --------------------------------------------------
const DEFAULT_TIERS = [                              // Cyan's SwdTech ladder
  { name: 'Dispatch', power: 55, target: 'one-enemy' },
  { name: 'Retort', power: 70, target: 'one-enemy' },
  { name: 'Slash', power: 95, target: 'one-enemy' },
  { name: 'QuadraSlam', power: 130, target: 'all-enemies' },
  { name: 'Cleave', power: 150, target: 'one-enemy' },
];
const DEFAULT_TOOLS = {                              // Edgar's machines (ignore defense)
  Drill: { power: 84, target: 'one-enemy', ignoreDef: true },
  AutoCrossbow: { power: 30, target: 'all-enemies', ignoreDef: true },
  NoiseBlaster: { power: 0, target: 'all-enemies', status: 'confuse', statusChance: 0.75 },
  BioBlaster: { power: 24, target: 'all-enemies', element: 'poison', status: 'poison', statusChance: 0.5 },
  Chainsaw: { power: 110, target: 'one-enemy', ignoreDef: true },
};

// =====================================================================
// THE SET — index a unit's commands and gate their use.
// =====================================================================
export function makeCommandSet(commands = []) {
  const list = commands.slice();
  const index = new Map(list.map((c) => [c.name, c]));
  const enabled = (c, user) => typeof c.enabled !== 'function' || !!c.enabled(user);

  const api = {
    // The menu: every command that is currently visible+enabled for this unit (a
    // disabled command — say, sealed by a status — drops out entirely).
    list(user) { return list.filter((c) => enabled(c, user)); },
    get(name) { return index.get(name) || null; },
    all() { return list.slice(); },
    has(name) { return index.has(name); },

    // Pick + resolve a command. Refuses unknown/disabled commands and blocks an
    // mp-gated one when the user is short (spending nothing); otherwise runs the
    // resolver and, for a self-costed command, spends its MP. Returns the resolver's
    // results[] carrying `.ok` (false when blocked) + `.reason`. Effects are delegated
    // to ctx.formulas/ctx.spells/ctx.rng — this gate never does damage math itself.
    run(name, user, targets, ctx = {}) {
      const c = index.get(name);
      if (!c) return flag([], { ok: false, reason: 'unknown' });
      if (!enabled(c, user)) return flag([], { ok: false, reason: 'disabled' });
      const cost = c.mp || 0;
      if (cost > 0 && mpOf(user) < cost) return flag([], { ok: false, reason: 'mp' });
      const res = (c.resolve ? c.resolve(user, toArr(targets), ctx) : null) || [];
      if (cost > 0 && res.cast !== false) spendMp(user, cost);         // self-costed skills
      if (res.ok === undefined) res.ok = res.cast !== false;           // cast:false => MP-short spell
      if (res.reason === undefined && res.cast === false) res.reason = 'mp';
      return res;
    },
  };
  return api;
}

// A ready-made baseline menu (Fight/Magic/Item) to spread new characters from.
export function baseCommands(extra = []) { return [attack(), magic(), item(), ...extra]; }

export const commands = {
  makeCommandSet, baseCommands,
  attack, magic, item,
  steal, blitz, swdTech, charge, tools, lore, throw: hurl, hurl,
  DEFAULT_TIERS, DEFAULT_TOOLS,
};
