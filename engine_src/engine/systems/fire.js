// engine/systems/fire.js
// The gun. It delegates two decisions to swappable components: the WEAPON
// (control/weapons.js) owns the firing rhythm + pattern and returns the shots to
// spawn this tick; the AIMER (control/aim.js) picks the base direction. This
// system just resolves aim, asks the weapon for shots, spawns a bullet per shot,
// and announces 'player-fired'. It doesn't know what a bullet hits.
import { on, emit } from '../core/events.js';
import { spawnInto } from '../core/world.js';
import { single } from '../control/weapons.js';
import { stick } from '../control/aim.js';

export function initFire(ctx) {
  const weapon = ctx.weapon || single({ cooldown: ctx.config.fireCooldown });
  const aimer = ctx.aim || stick();
  on('update', (dt) => {
    const p = ctx.signals.player.get();
    const firing = !!(p && !p.dead && ctx.signals.firing.get());
    const dir = p ? aimer(p, ctx.signals.aimInput.get(), ctx) : [0, 1];
    const shots = weapon(dt, firing, dir);
    if (!shots.length || !p) return;
    const def = ctx.entities.bullet;
    let last = null;
    for (const s of shots) {
      const d = s.dir, l = Math.hypot(d[0], d[1]) || 1;
      const speed = s.speed || ctx.config.bulletSpeed;
      last = spawnInto(ctx.registries.bullets, 'bullet', {
        at: [p.pos[0], 0.5, p.pos[2]],
        vel: [(d[0] / l) * speed, 0, (d[1] / l) * speed],
        mesh: def.mesh, color: def.color, scale: s.scale || def.scale, radius: def.radius,
        life: s.life || ctx.config.bulletLife,
        damage: s.damage,          // per-shot override; health falls back to config
      });
    }
    emit('player-fired', last);
  });
}
