// engine/control/interact.js
// INTERACTION system — the Zelda overworld staple: walk up to a chest / sign /
// NPC / lever, see a button hint, press A. A game registers interactables (either
// a live entity that already has {pos, prompt, onInteract, ...} or a plain spec),
// then each frame asks `nearest(playerPos, playerFacing)` for the one the player
// is standing in front of, shows `prompt()` as a hint, and calls `trigger()` on
// the button press. One-shot chests open once; levers re-fire; a `hold` field
// turns any of them into a hold-to-open via `hold(player, dt)`.
//
// Pure and node-safe: no world/DOM/timers/Math.random. Positions and facing come
// in as inputs ([x,y,z] and an XZ vector), so it sim-tests with fake data. The
// FRONT-OF-YOU test is a dot product: `dot(playerFacing, dirToTarget) >= facingDot`
// so you grab what you look at, never what's behind you. Live entities are held by
// reference — read `it.of.pos` each query — so moving NPCs stay interactable.

function norm2(x, z) {                          // unit XZ vector (0,0 stays 0,0)
  const l = Math.hypot(x, z);
  return l ? [x / l, z / l] : [0, 0];
}
function facingOf(o) {                           // an XZ look vector from an actor
  if (!o) return [0, 0];
  if (o.facing) return norm2(o.facing[0], o.facing[1]);
  if (o.rot != null) return [Math.sin(o.rot), Math.cos(o.rot)]; // engine convention
  return [0, 0];
}
const val = (v, ...a) => (typeof v === 'function' ? v(...a) : v); // prompt/text may be a fn

export function makeInteractions(defaults = {}) {
  // defaults: { range=1.5, needFacing=true, facingDot=0.35 (~cos70°) } — per-call
  // opts to nearest() override these; per-item `radius`/`facing`/`once`/`hold` win
  // over them for that item.
  const D = {
    range: defaults.range != null ? defaults.range : 1.5,
    needFacing: defaults.needFacing !== false,
    facingDot: defaults.facingDot != null ? defaults.facingDot : 0.35,
  };
  const items = [];
  let current = null;                            // last nearest() result (for prompt/trigger)
  let lastOpts = D;                              // last query opts (so trigger reuses them)
  let holdOf = null, holdT = 0;                  // hold-to-interact accumulator

  function make(x) {
    // Wrap an entity OR a spec into a record. Fields are READ from the passed
    // object (an entity carries chest.prompt / chest.onInteract on itself); pos is
    // taken live from `of.pos` each query so movers work.
    return {
      of: x,                                     // the entity/spec (source of pos + fields)
      radius: x.radius != null ? x.radius : null,
      prompt: x.prompt != null ? x.prompt : null,
      facing: x.facing || null,                  // the item's OWN front (a sign to read)
      once: !!x.once,
      hold: x.hold || 0,
      onInteract: x.onInteract || null,
      used: false,                               // set true after a `once` fires
    };
  }
  function posOf(it) { return it.of.pos || [0, 0, 0]; }

  const api = {
    add(x) {                                     // returns a handle (the record)
      const it = make(x);
      items.push(it);
      return it;
    },
    remove(h) {                                  // accepts the handle OR the original object
      const i = items.findIndex((it) => it === h || it.of === h);
      if (i < 0) return false;
      const it = items[i];
      items.splice(i, 1);
      if (current === it) current = null;
      if (holdOf === it) { holdOf = null; holdT = 0; }
      return true;
    },
    all() { return items.slice(); },
    get size() { return items.length; },

    nearest(playerPos, playerFacing, opts = {}) {
      // Closest interactable within range that is (if needFacing) in the arc the
      // player looks at, and (if the item has its own `facing`) approached from
      // its front. Spent one-shots are skipped so their prompt vanishes.
      const o = {
        range: opts.range != null ? opts.range : D.range,
        needFacing: opts.needFacing != null ? opts.needFacing : D.needFacing,
        facingDot: opts.facingDot != null ? opts.facingDot : D.facingDot,
      };
      lastOpts = o;
      const pf = playerFacing ? norm2(playerFacing[0], playerFacing[1]) : [0, 0];
      const hasFace = pf[0] !== 0 || pf[1] !== 0;
      let best = null, bestD = Infinity;
      for (const it of items) {
        if (it.once && it.used) continue;
        const p = posOf(it);
        const dx = p[0] - playerPos[0], dz = p[2] - playerPos[2];
        const d = Math.hypot(dx, dz);
        const r = it.radius != null ? it.radius : o.range;
        if (d > r) continue;
        const l = d || 1, ux = dx / l, uz = dz / l;
        if (o.needFacing && hasFace && pf[0] * ux + pf[1] * uz < o.facingDot) continue;
        if (it.facing) {                         // player must be on the item's front side
          const f = norm2(it.facing[0], it.facing[1]);
          if (f[0] * -ux + f[1] * -uz < o.facingDot) continue;
        }
        if (d < bestD) { bestD = d; best = it; }
      }
      current = best;
      return best;
    },

    prompt() {                                   // button-hint text for the current nearest
      return current ? val(current.prompt, current.of) : null;
    },

    trigger(player, ctx = {}) {
      // Fire the nearest's onInteract (respecting `once`). If a live `player` is
      // passed it re-resolves the nearest from that player (so the press always
      // acts on what's in front right now); otherwise it uses the cached nearest.
      let it = current;
      if (player && player.pos) it = api.nearest(player.pos, facingOf(player), lastOpts);
      if (!it || (it.once && it.used)) return null;
      if (it.once) it.used = true;
      const result = it.onInteract ? it.onInteract(it.of, player, ctx) : undefined;
      return { interactable: it, result };
    },

    hold(player, dt = 0, ctx = {}) {
      // Hold-to-interact: call every frame while the button is held. Accumulates
      // time on the nearest item and fires once it reaches `it.hold` seconds;
      // resets when the target changes or is lost. Items with no `hold` fire
      // instantly (progress 1) so the same button works for tap and hold gear.
      let it = current;
      if (player && player.pos) it = api.nearest(player.pos, facingOf(player), lastOpts);
      if (!it || (it.once && it.used)) { holdOf = null; holdT = 0; return { progress: 0, fired: false, interactable: null }; }
      const need = it.hold || 0;
      if (holdOf !== it) { holdOf = it; holdT = 0; }
      if (need <= 0) {                           // no hold configured → tap behaviour
        if (it.once) it.used = true;
        const result = it.onInteract ? it.onInteract(it.of, player, ctx) : undefined;
        holdOf = null; holdT = 0;
        return { progress: 1, fired: true, interactable: it, result };
      }
      holdT += dt;
      if (holdT >= need) {
        if (it.once) it.used = true;
        const result = it.onInteract ? it.onInteract(it.of, player, ctx) : undefined;
        holdOf = null; holdT = 0;
        return { progress: 1, fired: true, interactable: it, result };
      }
      return { progress: holdT / need, fired: false, interactable: it };
    },

    releaseHold() { holdOf = null; holdT = 0; }, // button let go before the fill completed
    clear() { items.length = 0; current = null; holdOf = null; holdT = 0; },
  };
  return api;
}

export const interact = { makeInteractions };
