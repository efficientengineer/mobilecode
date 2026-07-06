// engine/systems/movement.js
// Movement. Sets the player's velocity from moveInput (and faces it that way),
// then integrates velocity -> position for EVERY scene entity, so bullets fly
// and enemies advance without anyone moving them directly. Delta-timed, so
// speed is identical on any device.
import { on } from '../core/events.js';
import { scene } from '../core/world.js';

export function initMovement(ctx) {
  on('update', (dt) => {
    const p = ctx.signals.player.get();
    if (p && !p.dead) {
      const m = ctx.signals.moveInput.get();
      const s = ctx.config.playerSpeed;
      p.vel[0] = m[0] * s;
      p.vel[2] = m[1] * s;
      if (m[0] || m[1]) p.rot = Math.atan2(m[0], m[1]);
    }
    scene.each((e) => {
      e.pos[0] += e.vel[0] * dt;
      e.pos[1] += e.vel[1] * dt;
      e.pos[2] += e.vel[2] * dt;
    });
  });
}
