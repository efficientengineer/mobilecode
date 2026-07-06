// engine/systems/health.js
// Turns hit events into consequences. A bullet hit consumes the bullet and
// damages the enemy; at zero hp the enemy dies (once — the dead guard stops a
// double kill when two bullets land the same frame). A player hit consumes the
// enemy and drains playerHealth; at zero it announces 'player-died'.
import { on, emit } from '../core/events.js';
import { despawn } from '../core/world.js';

export function initHealth(ctx) {
  on('enemy-hit', ({ enemy, bullet }) => {
    if (enemy.dead) return;                 // already killed this frame
    despawn(bullet);
    enemy.hp -= ctx.config.bulletDamage;
    if (enemy.hp <= 0) { despawn(enemy); emit('enemy-died', enemy); }
  });
  on('player-hit', ({ enemy }) => {
    const hp = ctx.signals.playerHealth;
    if (hp.get() <= 0) return;
    despawn(enemy);
    hp.set(Math.max(0, hp.get() - ctx.config.enemyDamage));
    emit('player-damaged', hp.get());
    if (hp.get() <= 0) emit('player-died');
  });
}
