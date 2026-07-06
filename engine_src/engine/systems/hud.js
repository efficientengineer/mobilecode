// engine/systems/hud.js
// The heads-up display. It subscribes to the score / health / wave / gameState
// signals and re-renders a DOM overlay when any of them change. It is completely
// decoupled from combat — it only knows the signals. Remove this system and the
// game still runs, just without a readout.
export function initHud(ctx) {
  const el = document.getElementById('hud');
  if (!el) return;
  const { score, playerHealth, wave, gameState } = ctx.signals;
  function render() {
    const st = gameState.get();
    const banner =
      st === 'menu' ? 'TWIN-STICK — tap to start' :
      st === 'over' ? 'GAME OVER — tap to restart' :
      st === 'paused' ? 'PAUSED' : '';
    el.innerHTML =
      '<div class="stat">Score ' + score.get() + '</div>' +
      '<div class="stat">HP ' + Math.max(0, Math.round(playerHealth.get())) + '</div>' +
      '<div class="stat">Wave ' + wave.get() + '</div>' +
      (banner ? '<div class="banner">' + banner + '</div>' : '');
  }
  score.subscribe(render);
  playerHealth.subscribe(render);
  wave.subscribe(render);
  gameState.subscribe(render);
}
