// engine/control/senses.js
// Reusable PERCEPTION helpers — the layer BELOW fsm/behaviors that answers "can I
// actually see/hear the target right now?" so an enemy reacts to what it senses,
// not to omniscient world state. A behavior/fsm asks a sense each frame and picks
// what to do with the verdict (chase, search, idle):
//   const eye = senses.vision({ fov: 90, range: 12 });
//   if (eye.canSee(e.pos, e.rot, player.pos, ctx.blocked)) mem.see(e, player.pos, dt);
//   else mem.see(e, null, dt);                    // fade the last-known fix
//   const goal = mem.lastKnown(e);                // keep searching where we saw it
//
// Everything here is PURE: positions/predicates in, booleans/numbers out — no
// world access, no DOM/timers, no Math.random. Facing convention matches the rest
// of control/*: forward = [sin(rot), cos(rot)] (behaviors.drive / pathing).
// Per-entity memory is namespaced on e._mem, so ONE memory instance serves a whole
// registry without cross-talk. Fully deterministic and sim-testable.

// --- tiny XZ helpers (y is the up axis; senses reason on the ground plane) -----
function sub2(a, b) { return [a[0] - b[0], a[2] - b[2]]; }   // XZ delta, pos->pos
function len2(x, z) { return Math.hypot(x, z); }

// Walk the segment a->b sampling `blocked(x,z)` every `step` units; returns false
// the moment a sample is blocked. Endpoints included. `blocked` missing => clear.
export function lineOfSight(a, b, blocked, step = 0.5) {
  if (typeof blocked !== 'function') return true;      // nothing occludes -> visible
  const dx = b[0] - a[0], dz = b[2] - a[2];
  const dist = len2(dx, dz);
  const n = Math.max(1, Math.ceil(dist / Math.max(step, 1e-3)));
  for (let i = 0; i <= n; i++) {                       // inclusive of both ends
    const t = i / n;
    if (blocked(a[0] + dx * t, a[2] + dz * t)) return false;
  }
  return true;
}

// Flat range test — the cheapest sense (no cone, no facing). Use for melee reach,
// aggro bubbles, "is the player close enough to notice me at all."
export function proximity(selfPos, targetPos, range) {
  if (!targetPos) return false;
  const [dx, dz] = sub2(targetPos, selfPos);
  return dx * dx + dz * dz <= range * range;
}

export function vision({ fov = 90, range = 12 } = {}) {
  // A view cone: canSee(self, facingRot, target, blocked?) is true iff the target
  // is within `range` AND inside the ±fov/2 wedge around the facing direction AND
  // (if a `blocked(x,z)->bool` sampler is given) has clear line of sight. `fov` is
  // the FULL cone angle in degrees; 360 sees all around (a spherical sensor).
  const cosHalf = Math.cos((Math.min(fov, 360) * Math.PI / 180) / 2);
  const r2 = range * range;
  return {
    fov, range,
    canSee(selfPos, facingRot, targetPos, blocked) {
      if (!targetPos) return false;
      const [dx, dz] = sub2(targetPos, selfPos);
      const d2 = dx * dx + dz * dz;
      if (d2 > r2) return false;                       // out of range
      if (fov < 360) {                                 // inside the wedge?
        const el = Math.sqrt(d2) || 1;
        const fx = Math.sin(facingRot || 0), fz = Math.cos(facingRot || 0);
        const dot = (dx / el) * fx + (dz / el) * fz;   // cos(angle off facing)
        if (dot < cosHalf) return false;               // behind / off to the side
      }
      return lineOfSight(selfPos, targetPos, blocked); // walls block if sampler given
    },
  };
}

export function hearing({ radius = 8 } = {}) {
  // An omni ear: heard(self, soundPos, loudness=1) is true iff the sound falls
  // inside a `radius*loudness` bubble — louder events (gunshots) carry, footsteps
  // (loudness<1) don't. Also exposes level(self, soundPos, loudness) -> 0..1, a
  // linear falloff (1 at the source, 0 at the edge) for graded alertness.
  return {
    radius,
    heard(selfPos, soundPos, loudness = 1) {
      if (!soundPos) return false;
      const [dx, dz] = sub2(soundPos, selfPos);
      const reach = radius * loudness;
      return dx * dx + dz * dz <= reach * reach;
    },
    level(selfPos, soundPos, loudness = 1) {
      if (!soundPos) return 0;
      const [dx, dz] = sub2(soundPos, selfPos);
      const reach = radius * loudness;
      if (reach <= 0) return 0;
      const d = len2(dx, dz);
      return d >= reach ? 0 : 1 - d / reach;
    },
  };
}

export function memory({ forget = 3 } = {}) {
  // Fading LAST-KNOWN-POSITION tracker — the reason an enemy keeps hunting where it
  // last saw you instead of instantly forgetting the instant you break line of
  // sight. Feed it every frame:
  //   see(e, targetPos, dt)  // targetPos = a live sighting, or null when lost
  // When targetPos is truthy it stamps a fresh fix (age 0); when null it just ages
  // the existing fix by dt. The fix expires after `forget` seconds. State lives on
  // e._mem so one instance drives a whole registry.
  //   lastKnown(e) -> [x,y,z] | null   the remembered spot to search (null once cold)
  //   remembers(e) -> bool             is there still a live memory?
  //   freshness(e) -> 0..1             1 = just saw it, 0 = forgotten (search urgency)
  //   visible(e)   -> bool             was the LAST update an actual sighting?
  //   clear(e)                         wipe the memory (target died / gave up)
  function mem(e) { return e._mem || (e._mem = { pos: null, age: Infinity, seen: false }); }
  return {
    forget,
    see(e, targetPos, dt = 0) {
      const m = mem(e);
      if (targetPos) {                                 // fresh sighting: stamp it
        if (m.pos) { m.pos[0] = targetPos[0]; m.pos[1] = targetPos[1] || 0; m.pos[2] = targetPos[2]; }
        else m.pos = [targetPos[0], targetPos[1] || 0, targetPos[2]];
        m.age = 0; m.seen = true;
      } else {                                         // lost sight: let it decay
        m.age += dt; m.seen = false;
        if (m.age >= forget) m.pos = null;             // gone cold — stop searching
      }
      return m.pos;
    },
    lastKnown(e) { const m = mem(e); return (m.pos && m.age < forget) ? m.pos : null; },
    remembers(e) { const m = mem(e); return !!m.pos && m.age < forget; },
    freshness(e) { const m = mem(e); return (m.pos && m.age < forget) ? 1 - m.age / forget : 0; },
    visible(e) { return mem(e).seen; },
    clear(e) { const m = mem(e); m.pos = null; m.age = Infinity; m.seen = false; },
  };
}

export const senses = { vision, hearing, proximity, lineOfSight, memory };
