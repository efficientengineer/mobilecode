// engine/systems/ai.js
// Enemy brains. Each frame every enemy steers toward the player and faces it.
// It reads the player from the shared signal — it never imports the player
// system — and only sets velocity; movement.js does the actual moving.
import { on } from '../core/events.js';

export function initAI(ctx) {
  on('update', () => {
    const p = ctx.signals.player.get();
    if (!p || p.dead) return;
    ctx.registries.enemies.each((e) => {
      const dx = p.pos[0] - e.pos[0], dz = p.pos[2] - e.pos[2];
      const l = Math.hypot(dx, dz) || 1;
      e.vel[0] = dx / l * e.speed;
      e.vel[2] = dz / l * e.speed;
      e.rot = Math.atan2(dx, dz);
    });
  });
}
