// engine/systems/ai.js
// Enemy/NPC brains. Each frame every entity in the enemies registry runs its
// BEHAVIOR (a swappable component, see control/behaviors.js) to set its velocity;
// movement.js does the actual moving. Priority: the entity's own e.behavior, else
// the game-wide ctx.behavior, else plain chase. Behaviors read the player from
// the shared signal (never imported) — pass null when the player is gone so NPC
// behaviors (patrol/wander) keep going while chasers idle.
import { on } from '../core/events.js';
import { chase } from '../control/behaviors.js';

export function initAI(ctx) {
  const brain = ctx.behavior || chase();
  on('update', (dt) => {
    const p = ctx.signals.player.get();
    const target = (p && !p.dead) ? p : null;
    ctx.registries.enemies.each((e) => {
      (e.behavior || brain)(e, target, dt, ctx);
    });
  });
}
