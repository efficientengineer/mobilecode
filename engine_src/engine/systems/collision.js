// engine/systems/collision.js
// The only system that reads more than one registry — because collision is
// inherently about relationships between sets. It does circle-overlap tests
// (bullets vs enemies, enemies vs player) and ANNOUNCES hits as events. It
// applies no damage and calls no other system: health.js decides what a hit
// means.
import { on, emit } from '../core/events.js';

export function initCollision(ctx) {
  const overlap = (a, b) => {
    const dx = a.pos[0] - b.pos[0], dz = a.pos[2] - b.pos[2];
    const r = (a.radius || 0.5) + (b.radius || 0.5);
    return dx * dx + dz * dz <= r * r;
  };
  on('physics', () => {
    ctx.registries.bullets.each((b) => {
      if (b.dead) return;
      ctx.registries.enemies.each((e) => {
        if (e.dead || b.dead) return;
        if (overlap(b, e)) emit('enemy-hit', { enemy: e, bullet: b });
      });
    });
    const p = ctx.signals.player.get();
    if (p && !p.dead) {
      ctx.registries.enemies.each((e) => {
        if (!e.dead && overlap(e, p)) emit('player-hit', { enemy: e });
      });
    }
  });
}
