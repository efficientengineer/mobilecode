// engine/control/hazards.js
// Reusable HAZARD components — environmental effect zones, swappable like
// cameras/movements/weapons/behaviors. A hazard is an area of the world (lava,
// spikes, a wind gust, a bottomless pit) that acts on any entity standing in it.
// Each factory returns:
//   affect(entity, dt, zone) -> { damage?, push?[x,z], kill?, slow? } | null
// The verdict is PURE DATA — the hazard NEVER mutates the entity; the calling
// system reads the fields and applies them (subtract damage, add push to vel,
// despawn on kill, scale speed by slow). This keeps zones sim-testable.
//
// A zone is a plain shape the game places in the world, either a circle
//   { pos:[x,y,z], radius }   or an axis-aligned box   { min:[x,z], max:[x,z] }.
// Every hazard also exposes  inside(entity, zone) -> bool  so a game can query
// membership (footstep dust, ambient sound) without applying an effect. Pick one
// per zone in game glue:  const lake = hazards.lava(); ... lake.affect(e, dt, z).
//
// Per-entity memory (spikes' "already triggered" set) lives in a WeakSet in the
// factory closure, so ONE hazard instance can guard many zones for many entities
// without leaking or cross-talk.

// Circle OR box membership on the XZ plane. Uses entity radius so a body counts
// as "inside" the moment it overlaps the zone, not only when its center enters.
function inside(e, zone) {
  if (!e || !zone) return false;
  const ex = e.pos[0], ez = e.pos[2], r = e.radius || 0;
  if (zone.min && zone.max) {                       // axis-aligned box
    const cx = Math.max(zone.min[0], Math.min(ex, zone.max[0]));
    const cz = Math.max(zone.min[1], Math.min(ez, zone.max[1]));
    return (ex - cx) * (ex - cx) + (ez - cz) * (ez - cz) <= r * r;
  }
  if (zone.pos) {                                   // circle
    const dx = ex - zone.pos[0], dz = ez - zone.pos[2];
    const rr = (zone.radius || 0) + r;
    return dx * dx + dz * dz <= rr * rr;
  }
  return false;
}

// Outward unit vector from a zone's center to the entity (for push-out / repel).
// Falls back to a stable +x nudge when the entity sits dead-center.
function outward(e, zone) {
  let cx, cz;
  if (zone.min && zone.max) {
    cx = (zone.min[0] + zone.max[0]) * 0.5;
    cz = (zone.min[1] + zone.max[1]) * 0.5;
  } else if (zone.pos) { cx = zone.pos[0]; cz = zone.pos[2]; }
  else return [1, 0];
  const dx = e.pos[0] - cx, dz = e.pos[2] - cz;
  const l = Math.hypot(dx, dz);
  return l > 1e-6 ? [dx / l, dz / l] : [1, 0];
}

export function damageZone({ dps = 10 } = {}) {
  // Steady damage-over-time while you stand in it — poison gas, fire, acid pool.
  // Damage scales with dt so it's frame-rate independent.
  return {
    inside,
    affect(e, dt, zone) {
      if (!inside(e, zone)) return null;
      return { damage: dps * (dt || 0) };
    },
  };
}

export function spikes({ damage = 20 } = {}) {
  // One-shot trap: a flat `damage` hit the instant an entity ENTERS, then nothing
  // until it leaves and steps back on. A WeakSet remembers who's currently armed
  // vs. standing, so lingering costs nothing but re-entry triggers again.
  const touching = new WeakSet();
  return {
    inside,
    affect(e, dt, zone) {
      if (!inside(e, zone)) { touching.delete(e); return null; }
      if (touching.has(e)) return null;             // already triggered this stay
      touching.add(e);
      return { damage };
    },
  };
}

export function lava({ dps = 30, slow = 0.5 } = {}) {
  // Molten: heavy damage-over-time AND bogs you down (slow is a speed multiplier
  // the movement system applies, 0..1). Punishing to cross, survivable to clip.
  return {
    inside,
    affect(e, dt, zone) {
      if (!inside(e, zone)) return null;
      return { damage: dps * (dt || 0), slow };
    },
  };
}

export function slowField({ mult = 0.5 } = {}) {
  // Pure drag — mud, tar, webbing, deep water. No damage; just a speed multiplier
  // (0 = stuck, 1 = normal) for as long as you're inside.
  return {
    inside,
    affect(e, dt, zone) {
      if (!inside(e, zone)) return null;
      return { slow: mult };
    },
  };
}

export function pit({} = {}) {
  // Bottomless fall — instant death the moment an entity is inside. The caller
  // despawns whatever it flags with kill (player death, enemy cleanup).
  return {
    inside,
    affect(e, dt, zone) {
      if (!inside(e, zone)) return null;
      return { kill: true };
    },
  };
}

export function windZone({ force = [0, 0] } = {}) {
  // A directional gust: a constant push [x,z] added to velocity while inside —
  // conveyor belts, fans, river current, gravity wells (point force outward for a
  // repulsor). Scales with dt so the shove is frame-rate independent.
  return {
    inside,
    affect(e, dt, zone) {
      if (!inside(e, zone)) return null;
      const s = dt || 0;
      return { push: [force[0] * s, force[1] * s] };
    },
    outward,     // exposed so a game can build a radial repulsor if it wants
  };
}

export const hazards = {
  damageZone, spikes, lava, slowField, pit, windZone,
};
