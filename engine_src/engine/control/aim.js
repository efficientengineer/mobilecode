// engine/control/aim.js
// Reusable AIM controllers — a swappable component like cameras and movements.
// An aimer decides which way shots go, given the raw aim stick and the world.
// Each factory returns:  resolve(player, raw, ctx) -> [x,z]  (a unit XZ vector)
// The fire system asks the aimer for a direction every time it shoots, so you
// change how a game aims — twin-stick, auto-assist, shoot-where-you-move — by
// swapping one line in game/bootstrap.js:  ctx.aim = aim.autoAim({ range: 12 })

// Facing direction from an entity's rotation (matches movement/fire math).
function facingOf(p) {
  return [Math.sin(p.rot || 0), Math.cos(p.rot || 0)];
}
function norm([x, z]) {
  const l = Math.hypot(x, z) || 1;
  return [x / l, z / l];
}

export function stick() {
  // Twin-stick: aim exactly where the right stick points; if it's centered,
  // shoot where the player faces. The straightforward default.
  return (p, raw) => {
    const x = raw[0], z = raw[1];
    return (x || z) ? norm([x, z]) : facingOf(p);
  };
}

export function facing() {
  // One-stick / auto-fire games: always shoot where the player is facing
  // (i.e. the move direction). The aim stick is ignored.
  return (p) => facingOf(p);
}

export function manual() {
  // Sticky aim for touch: a flick sets the aim and it HOLDS after you let go,
  // so both thumbs are free. Starts pointed where the player faces.
  let held = null;
  return (p, raw) => {
    if (raw[0] || raw[1]) held = norm([raw[0], raw[1]]);
    return held || facingOf(p);
  };
}

export function autoAim({ range = Infinity } = {}) {
  // Aim assist: lock onto the nearest enemy within `range`. Falls back to the
  // raw stick, then facing, when nothing is in range — great for one-stick
  // shooters and mobile, where precise aiming is hard.
  return (p, raw, ctx) => {
    const enemies = ctx && ctx.registries && ctx.registries.enemies;
    let best = null, bestD = range * range;
    if (enemies) {
      enemies.each((e) => {
        if (e.dead) return;
        const dx = e.pos[0] - p.pos[0], dz = e.pos[2] - p.pos[2];
        const d = dx * dx + dz * dz;
        if (d < bestD) { bestD = d; best = [dx, dz]; }
      });
    }
    if (best) return norm(best);
    return (raw[0] || raw[1]) ? norm([raw[0], raw[1]]) : facingOf(p);
  };
}

export const aim = { stick, facing, manual, autoAim };
