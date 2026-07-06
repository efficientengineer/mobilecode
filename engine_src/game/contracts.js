// game/contracts.js  — GAME GLUE (yours to edit)
// This game's shared state and collections — the "nouns" every system agrees on.
// Add a signal or registry here when a new system needs shared state. The names
// are the vocabulary the engine systems expect (see engine/CONTRACTS.md).
import { signal } from '../engine/core/signals.js';
import { makeRegistry } from '../engine/core/registry.js';
import { makeRng } from '../engine/core/rng.js';

export function makeContracts() {
  return {
    signals: {
      gameState: signal('menu'),      // menu | playing | paused | over
      score: signal(0),
      wave: signal(0),
      playerHealth: signal(100),
      moveInput: signal([0, 0]),      // left stick, [-1..1] x/z
      aimInput: signal([0, 0]),       // right stick, [-1..1] x/z
      firing: signal(false),
      player: signal(null),           // the player entity, once spawned
    },
    registries: {
      enemies: makeRegistry(),
      bullets: makeRegistry(),
    },
    rng: makeRng(1337),
  };
}
