// engine/systems/spawn.js
// The wave director. On game start (and whenever the arena is cleared) it spawns
// a ring of enemies around the edge, growing each wave. It announces
// 'wave-started' / 'wave-cleared'; it doesn't kill enemies — it just watches the
// enemies registry empty out. Uses the seeded rng so waves are reproducible.
import { on, emit } from '../core/events.js';
import { spawnInto } from '../core/world.js';

export function initSpawn(ctx) {
  let wave = 0, active = false, timer = Infinity;   // idle until 'game-started'

  function startWave() {
    wave++;
    ctx.signals.wave.set(wave);
    active = true;
    const def = ctx.entities.enemy;
    const count = ctx.config.baseEnemies + wave * 2;
    const dist = ctx.config.arena * 0.85;
    for (let i = 0; i < count; i++) {
      const ang = ctx.rng.next() * Math.PI * 2;
      spawnInto(ctx.registries.enemies, 'enemy', {
        at: [Math.cos(ang) * dist, 0, Math.sin(ang) * dist],
        mesh: def.mesh, color: def.color, scale: def.scale, radius: def.radius,
        hp: def.hp, speed: def.speed,
      });
    }
    emit('wave-started', wave);
  }

  on('game-started', () => { wave = 0; active = false; timer = 0.5; });
  on('update', (dt) => {
    if (active && ctx.registries.enemies.size === 0) {
      active = false;
      timer = ctx.config.waveDelay;
      emit('wave-cleared', wave);
    }
    if (!active) { timer -= dt; if (timer <= 0) startWave(); }
  });
}
