// engine/systems/fire.js
// The gun. While `firing` is on and the cooldown has elapsed, it spawns a bullet
// from the player in the aim direction (falling back to the facing direction),
// files it in the bullets registry, and announces 'player-fired'. It doesn't
// know what a bullet hits — collision/health handle that.
import { on, emit } from '../core/events.js';
import { spawnInto } from '../core/world.js';

export function initFire(ctx) {
  let cd = 0;
  on('update', (dt) => {
    cd -= dt;
    const p = ctx.signals.player.get();
    if (!p || p.dead || cd > 0 || !ctx.signals.firing.get()) return;
    const a = ctx.signals.aimInput.get();
    let dx = a[0], dz = a[1];
    if (!dx && !dz) { dx = Math.sin(p.rot); dz = Math.cos(p.rot); }
    const l = Math.hypot(dx, dz) || 1; dx /= l; dz /= l;
    cd = ctx.config.fireCooldown;
    const def = ctx.entities.bullet;
    const b = spawnInto(ctx.registries.bullets, 'bullet', {
      at: [p.pos[0], 0.5, p.pos[2]],
      vel: [dx * ctx.config.bulletSpeed, 0, dz * ctx.config.bulletSpeed],
      mesh: def.mesh, color: def.color, scale: def.scale, radius: def.radius,
      life: ctx.config.bulletLife,
    });
    emit('player-fired', b);
  });
}
