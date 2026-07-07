// engine/systems/cleanup.js
// Housekeeping. Entities with a `life` count down and despawn; bullets that fly
// past the arena edge despawn. despawn() removes them from the scene AND their
// gameplay registry, and deferred removal makes it safe to do while iterating.
import { on } from '../core/events.js';
import { scene, despawn } from '../core/world.js';

export function initCleanup(ctx) {
  const bound = ctx.config.arena + 6;
  on('update', (dt) => {
    scene.each((e) => {
      if (e.dead) return;
      if (e.life !== undefined) {
        e.life -= dt;
        if (e.life <= 0) { despawn(e); return; }
      }
      if (e.kind === 'bullet' && (Math.abs(e.pos[0]) > bound || Math.abs(e.pos[2]) > bound)) despawn(e);
    });
  });
}
