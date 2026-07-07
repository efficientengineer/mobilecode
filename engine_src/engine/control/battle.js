// engine/control/battle.js
// ACTIVE TIME BATTLE (ATB) engine — the beating heart of an FF6-style fight and
// the one place in this engine that is TURN/TIME-based instead of real-time action.
// Everything else (weapons/hazards/statuses/damage under control/) drives an arcade
// loop; this owns the JRPG cadence: gauges fill by SPEED, a full gauge makes a unit
// READY, you feed it an action, it resolves, its gauge resets, repeat until one side
// is wiped. Sibling turn-based files (stats.js, spells.js, and the ATB damage/status
// files) supply the NUMBERS; battle owns only TIMING, ORDER and win/lose FLOW.
//
//   const b = makeBattle({ allies, enemies, rng, atbSpeed: 1, perform, wait: true });
//   for (const ev of b.step(dt)) { ... }        // fill gauges, surface ready, resolve
//   b.submit(unit.id, { kind:'attack', target: foe.id });   // queue a ready unit's move
//
// Units are plain stat objects with at least { id, side:"ally"|"enemy", speed, alive }
// (wrap a stats.js block — its .speed + a live .alive/.isKO flag are all we read).
// battle NEVER does damage math: it calls the INJECTED perform(action, ctx) callback,
// which mutates units/stats and returns results; battle just watches who died. Pure,
// deterministic, dt-driven, rng injected — no Math.random, no timers, no DOM.

// A unit is out of the fight when its owner marks it so — any of these flags read as
// dead (alive:false is the contract; hp<=0 / isKO / dead cover raw stats blocks too).
function dead(u) {
  return !u || u.alive === false || u.dead === true || u.isKO === true ||
         (typeof u.hp === 'number' && u.hp <= 0);
}

export function makeBattle({
  allies = [], enemies = [], rng, atbSpeed = 1, perform,
  wait = false,          // WAIT mode: freeze all gauges while a unit awaits a command
  threshold = 1,         // gauge value that counts as full/ready
} = {}) {
  const units = allies.concat(enemies);
  const byId = new Map(units.map((u) => [u.id, u]));
  // Per-unit ATB state lives in this closure Map (never on module globals):
  //   gauge 0..threshold · ready · rate (haste/slow multiplier) · action (queued) · seq
  const st = new Map(units.map((u) => [u, { gauge: 0, ready: false, rate: 1, action: null, seq: 0 }]));
  const koSet = new Set(units.filter(dead));   // already-dead units don't re-announce
  const pending = [];                          // terminal events queued out-of-step (escape)
  let over = false, result = null, paused = false, seq = 0;

  const living = (list) => list.filter((u) => !dead(u));
  const foesOf = (u) => living(u.side === 'ally' ? enemies : allies);
  const alliesOf = (u) => living(u.side === 'ally' ? allies : enemies);
  const awaiting = () => units.some((u) => !dead(u) && st.get(u).ready && st.get(u).action == null);

  // Announce freshly-dead units once, and strip their gauge/queued action.
  function scanKo(ev) {
    for (const u of units) {
      if (dead(u) && !koSet.has(u)) {
        koSet.add(u);
        const s = st.get(u); s.ready = false; s.action = null; s.gauge = 0;
        ev.push({ type: 'ko', unit: u });
      }
    }
  }
  // Wipe check — first side fully down ends it (enemies down = victory).
  function checkEnd(ev) {
    if (over) return;
    if (!enemies.some((u) => !dead(u))) { over = true; result = 'victory'; ev.push({ type: 'victory' }); }
    else if (!allies.some((u) => !dead(u))) { over = true; result = 'defeat'; ev.push({ type: 'defeat' }); }
  }

  const api = {
    // Advance the battle by dt: fill gauges, surface newly-ready units, resolve any
    // queued actions in readiness order, and settle KO / win / lose. Returns events.
    step(dt = 0) {
      const ev = [];
      while (pending.length) ev.push(pending.shift());   // flush a prior escape/terminal
      if (over) return ev;
      scanKo(ev); checkEnd(ev);
      if (over) return ev;

      // Fill gauges unless paused (menu open) or WAIT mode is holding for a command.
      const frozen = paused || (wait && awaiting());
      if (!frozen) {
        for (const u of units) {
          if (dead(u)) continue;
          const s = st.get(u);
          if (s.ready) continue;
          s.gauge += (u.speed || 0) * dt * atbSpeed * s.rate;
          if (s.gauge >= threshold) {
            s.gauge = threshold; s.ready = true; s.seq = seq++;
            ev.push({ type: 'gaugeFull', unit: u });
          }
        }
      }

      // Resolve queued actions oldest-ready first (whoever filled earliest acts first).
      const acting = units
        .filter((u) => !dead(u) && st.get(u).ready && st.get(u).action != null)
        .sort((a, b) => st.get(a).seq - st.get(b).seq);
      for (const u of acting) {
        if (over) break;
        const s = st.get(u);
        if (dead(u) || !s.ready || s.action == null) continue;   // may have died mid-round
        const action = s.action; s.action = null;
        const results = perform ? perform(action, api.ctx(u)) : null;
        s.ready = false; s.gauge = 0;
        ev.push({ type: 'acted', unit: u, action, results });
        scanKo(ev); checkEnd(ev);
      }
      return ev;
    },

    // The context handed to perform(action, ctx): the actor, the rng, and pre-filtered
    // LIVING target pools so damage code never picks a corpse. perform owns the math.
    ctx(actor) {
      return {
        actor, rng, battle: api,
        allies, enemies, units,
        foes: foesOf(actor), party: alliesOf(actor),
        foesOf, alliesOf, unit: (id) => byId.get(id),
      };
    },

    // Queue the chosen action for a READY unit; false if it isn't ready / is dead.
    submit(unitId, action) {
      const u = byId.get(unitId);
      if (!u || dead(u)) return false;
      const s = st.get(u);
      if (!s.ready) return false;
      s.action = action;
      return true;
    },

    ready() { return units.filter((u) => !dead(u) && st.get(u).ready && st.get(u).action == null); },
    isReady(id) { const u = byId.get(id); return !!u && !dead(u) && st.get(u).ready; },

    // Predicted turn order: living units soonest-to-ready first (ready = now = 0s).
    order() {
      const eta = (u) => {
        const s = st.get(u);
        if (s.ready) return 0;
        const r = (u.speed || 0) * atbSpeed * s.rate;
        return r > 0 ? (threshold - s.gauge) / r : Infinity;
      };
      return living(units).slice().sort((a, b) => eta(a) - eta(b));
    },
    next() { return api.order()[0] || null; },
    gauge(id) { const u = byId.get(id); return u ? st.get(u).gauge : 0; },

    // Haste/slow: a per-unit gauge-rate multiplier (>1 faster, <1 slower). Statuses
    // toggle this so a hasted unit's gauge climbs quicker without touching its speed.
    setRate(id, mult = 1) { const u = byId.get(id); if (u) st.get(u).rate = mult; return api; },
    rate(id) { const u = byId.get(id); return u ? st.get(u).rate : 1; },
    haste(id, mult = 2) { return api.setRate(id, mult); },
    slow(id, mult = 0.5) { return api.setRate(id, mult); },

    // Pause/resume gauge fill while a menu is open (events still flush on step).
    pause() { paused = true; return api; },
    resume() { paused = false; return api; },
    isPaused() { return paused; },

    // Flee attempt: roll rng.next() < chance; on success the party escapes and the
    // fight ends (a 'fled' event surfaces on the next step). Returns whether it worked.
    escape(r = rng, chance = 0.5) {
      if (over) return false;
      const roll = r && r.next ? r.next() : 1;
      if (roll < chance) { over = true; result = 'fled'; pending.push({ type: 'fled' }); return true; }
      return false;
    },

    isOver() { return over; },
    result() { return result; },
    units, allies, enemies,
  };
  return api;
}

export const battle = { makeBattle };
