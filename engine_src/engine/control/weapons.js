// engine/control/weapons.js
// Reusable WEAPON controllers — a swappable component like cameras and movements.
// A weapon owns its own firing rhythm (cooldown, burst timing) and pattern
// (single, spread, radial). Each factory returns a stateful stepper:
//   update(dt, firing, dir) -> shots[]
// where `dir` is the unit aim direction [x,z] and each returned shot is
//   { dir:[x,z], speed?, life?, damage?, scale? }  (dir is a unit XZ vector)
// — the bullets to spawn THIS tick (empty on most ticks). The fire system spawns
// whatever comes back, so the weapon is the single source of "what a shot is".
// Pick one in game/bootstrap.js:  ctx.weapon = weapons.shotgun({ pellets: 6 })

// Rotate a unit XZ vector by `a` radians (ground-plane, matches facing math).
function rot([x, z], a) {
  const c = Math.cos(a), s = Math.sin(a);
  return [x * c - z * s, x * s + z * c];
}

export function single({ cooldown = 0.2, speed, life, damage } = {}) {
  // One bullet straight along the aim, on a cooldown. The classic default gun.
  let cd = 0;
  return (dt, firing, dir) => {
    cd -= dt;
    if (!firing || cd > 0) return [];
    cd = cooldown;
    return [{ dir, speed, life, damage }];
  };
}

export function rapid({ cooldown = 0.06, speed, life, damage } = {}) {
  // A machine gun: single, but a much shorter cooldown (a stream of bullets).
  return single({ cooldown, speed, life, damage });
}

export function shotgun({ pellets = 5, spreadDeg = 30, cooldown = 0.6, speed, life, damage } = {}) {
  // A fan of pellets across `spreadDeg`, centered on the aim. Big cooldown.
  let cd = 0;
  const spread = (spreadDeg * Math.PI) / 180;
  return (dt, firing, dir) => {
    cd -= dt;
    if (!firing || cd > 0) return [];
    cd = cooldown;
    const shots = [];
    for (let i = 0; i < pellets; i++) {
      const t = pellets === 1 ? 0.5 : i / (pellets - 1);   // 0..1
      const a = (t - 0.5) * spread;
      shots.push({ dir: rot(dir, a), speed, life, damage });
    }
    return shots;
  };
}

export function burst({ count = 3, gap = 0.06, cooldown = 0.5, speed, life, damage } = {}) {
  // Fires `count` quick shots (spaced by `gap`), then a long `cooldown` before
  // the next burst — a controlled tap-fire. Only starts a burst while firing.
  let left = 0, timer = 0, rest = 0;
  return (dt, firing, dir) => {
    rest -= dt;
    if (left <= 0) {
      if (!firing || rest > 0) return [];
      left = count; timer = 0;                 // begin a burst
    }
    timer -= dt;
    if (timer > 0) return [];
    timer = gap; left -= 1;
    if (left <= 0) rest = cooldown;            // burst done → long rest
    return [{ dir, speed, life, damage }];
  };
}

export function radial({ ways = 8, cooldown = 0.5, speed, life, damage } = {}) {
  // Fires `ways` bullets evenly around a full circle (a nova / bomb) — ignores
  // the aim direction. Great for panic clears and bullet-hell enemies.
  let cd = 0;
  return (dt, firing) => {
    cd -= dt;
    if (!firing || cd > 0) return [];
    cd = cooldown;
    const shots = [];
    for (let i = 0; i < ways; i++) {
      const a = (i / ways) * Math.PI * 2;
      shots.push({ dir: [Math.sin(a), Math.cos(a)], speed, life, damage });
    }
    return shots;
  };
}

export const weapons = { single, rapid, shotgun, burst, radial };
