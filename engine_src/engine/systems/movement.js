// engine/systems/movement.js
// Movement. Applies the active MOVEMENT CONTROLLER (a swappable component, see
// control/movements.js) to the player to set its velocity, then integrates
// velocity -> position for EVERY scene entity, so bullets fly and enemies
// advance without anyone moving them directly. Default is a top-down twin-stick;
// pick another with ctx.movement in bootstrap. Delta-timed.
import { on } from '../core/events.js';
import { scene } from '../core/world.js';
import { twinStick } from '../control/movements.js';

export function initMovement(ctx) {
  const control = ctx.movement || twinStick({ speed: ctx.config.playerSpeed });
  on('update', (dt) => {
    const p = ctx.signals.player.get();
    if (p && !p.dead) {
      control(p, {
        move: ctx.signals.moveInput.get(),
        aim: ctx.signals.aimInput.get(),
        jump: ctx.signals.firing.get(),
      }, dt);
    }
    scene.each((e) => {
      e.pos[0] += e.vel[0] * dt;
      e.pos[1] += e.vel[1] * dt;
      e.pos[2] += e.vel[2] * dt;
    });
  });
}
