// engine/systems/gamestate.js
// The lifecycle owner. Holds gameState ('menu' | 'playing' | 'paused' | 'over').
// A tap starts or restarts: it clears the world and registries, resets the
// signals, spawns the player from the entity catalog, and announces
// 'game-started'. It flips to 'over' on 'player-died', and to 'paused' when the
// tab is hidden. The loop reads gameState to decide whether to run the sim.
import { on, emit } from '../core/events.js';
import { spawn, resetWorld } from '../core/world.js';

export function initGameState(ctx) {
  const st = ctx.signals.gameState;

  function start() {
    resetWorld();
    ctx.registries.enemies.clear();
    ctx.registries.bullets.clear();
    ctx.signals.playerHealth.set(ctx.config.playerHp);
    const def = ctx.entities.player;
    const p = spawn('player', { at: [0, 0, 0], mesh: def.mesh, color: def.color, scale: def.scale, radius: def.radius });
    ctx.signals.player.set(p);
    st.set('playing');
    emit('game-started');
  }

  on('player-died', () => { st.set('over'); emit('game-over'); });

  window.addEventListener('pointerdown', () => {
    const s = st.get();
    if (s === 'menu' || s === 'over') start();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && st.get() === 'playing') st.set('paused');
    else if (!document.hidden && st.get() === 'paused') st.set('playing');
  });

  st.set('menu');
}
