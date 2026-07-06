// engine/control/pickups.js
// Reusable PICKUP effects — a swappable component like cameras/movements/weapons.
// A pickup owns ONE thing: what happens when the player collects the item. Each
// factory returns a small object made by makePickup:
//   { kind, apply(ctx, player) -> tag }
// apply() mutates the game's signals (playerHealth, score, lives) and/or stashes
// timed buffs on the player entity (shield, speedMult, magnetRadius) that other
// systems read, then returns a short effect tag string ('heal', 'shield', ...) so
// the caller can pop a label / play a sound. Pick what an item drops in game glue:
//   entities.medkit.pickup = pickups.health({ amount: 50 })
//   onCollect: (item, player) => emit('pickup', { tag: item.pickup.apply(ctx, player) })
//
// Buffs are stored as seconds-remaining on the player (player.shield, player.speed-
// Mult+player.speedTimer, player.magnetRadius+player.magnetTimer); a tiny game
// system counts them down each frame and clears them — pure data, no globals here.

// Read/adjust a signal only if the game defined it (guards partial ctx in tests).
function bump(sig, fn) { if (sig && sig.get) sig.set(fn(sig.get())); }
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// Wrap an effect fn as a tagged pickup. `kind` names the drop; `apply` does the work.
export function makePickup(kind, apply) {
  return { kind, apply };
}

export function health({ amount = 25, cap = 100 } = {}) {
  // Restore HP, never past `cap`. The classic medkit / health orb.
  return makePickup('health', (ctx, player) => {
    bump(ctx.signals && ctx.signals.playerHealth, (hp) => clamp(hp + amount, 0, cap));
    return 'heal';
  });
}

export function shield({ duration = 5 } = {}) {
  // Grant temporary invulnerability: a countdown the health system checks before
  // applying damage. Stacks by taking the longer of current/new remaining time.
  return makePickup('shield', (ctx, player) => {
    if (player) player.shield = Math.max(player.shield || 0, duration);
    return 'shield';
  });
}

export function scoreBonus({ points = 100 } = {}) {
  // Pure points — coins, gems, treasure. Bumps the score signal.
  return makePickup('score', (ctx) => {
    bump(ctx.signals && ctx.signals.score, (s) => s + points);
    return 'score';
  });
}

export function speedBoost({ mult = 1.5, duration = 4 } = {}) {
  // Timed haste: stash a multiplier the movement system multiplies into speed,
  // plus a countdown. Refreshes duration and keeps the stronger multiplier.
  return makePickup('speed', (ctx, player) => {
    if (player) {
      player.speedMult = Math.max(player.speedMult || 1, mult);
      player.speedTimer = Math.max(player.speedTimer || 0, duration);
    }
    return 'speed';
  });
}

export function weaponSwap({ weapon } = {}) {
  // Change the active gun: drop a new weapon controller into ctx.weapon (same
  // object the fire system already steps). Use with a weapons.* factory.
  return makePickup('weapon', (ctx) => {
    if (ctx && weapon) ctx.weapon = weapon;
    return 'weapon';
  });
}

export function magnet({ radius = 6, duration = 5 } = {}) {
  // Timed loot vacuum: stash a pull radius + countdown on the player for a pickup
  // system to read (draw nearby drops toward the player). Keeps the larger radius.
  return makePickup('magnet', (ctx, player) => {
    if (player) {
      player.magnetRadius = Math.max(player.magnetRadius || 0, radius);
      player.magnetTimer = Math.max(player.magnetTimer || 0, duration);
    }
    return 'magnet';
  });
}

export function extraLife({ refill = true, cap = 100 } = {}) {
  // One more try: bump the lives signal (or player.lives), optionally topping off
  // health. For games with a lives counter rather than one-and-done.
  return makePickup('life', (ctx, player) => {
    const sig = ctx.signals || {};
    if (sig.lives && sig.lives.get) sig.lives.set(sig.lives.get() + 1);
    else if (player) player.lives = (player.lives || 0) + 1;
    if (refill) bump(sig.playerHealth, () => cap);
    return 'life';
  });
}

export const pickups = {
  health, shield, scoreBonus, speedBoost, weaponSwap, magnet, extraLife, makePickup,
};
