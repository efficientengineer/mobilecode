// engine/systems/score.js
// Owns the score. It just listens for deaths and bumps the score signal; the
// HUD is subscribed to that signal, so score and display stay decoupled.
import { on } from '../core/events.js';

export function initScore(ctx) {
  on('game-started', () => ctx.signals.score.set(0));
  on('enemy-died', () => ctx.signals.score.update((s) => s + ctx.config.scorePerKill));
}
