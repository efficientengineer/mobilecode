// game/bootstrap.js  — GAME GLUE (yours to edit): the composition root.
// This is the ONE place that knows the whole game. It builds the shared assets,
// injects them into each system, and starts the loop. To change the game you
// mostly add or remove one init line here. Read this + engine/CONTRACTS.md and
// you know everything; you should not need to open the engine files.
import { makeContracts } from './contracts.js';
import { entities } from './entities.js';
import { config } from './config.js';
import { makeLoop } from '../engine/core/loop.js';
import { cameras } from '../engine/render/cameras.js';
import { movements } from '../engine/control/movements.js';
import { weapons } from '../engine/control/weapons.js';
import { aim } from '../engine/control/aim.js';

import { initInput } from '../engine/systems/input.js';
import { initMovement } from '../engine/systems/movement.js';
import { initAI } from '../engine/systems/ai.js';
import { initFire } from '../engine/systems/fire.js';
import { initSpawn } from '../engine/systems/spawn.js';
import { initCollision } from '../engine/systems/collision.js';
import { initHealth } from '../engine/systems/health.js';
import { initScore } from '../engine/systems/score.js';
import { initCleanup } from '../engine/systems/cleanup.js';
import { initGameState } from '../engine/systems/gamestate.js';
import { initHud } from '../engine/systems/hud.js';
import { initAudio } from '../engine/systems/audio.js';
import { initRender } from '../engine/systems/render.js';

export function start(canvas) {
  const ctx = makeContracts();
  ctx.entities = entities;
  ctx.config = config;
  ctx.canvas = canvas;

  // Pick the swappable components that define the feel. For a platformer you'd
  // pair cameras.sideScroller() with movements.platformer(); for a runner,
  // movements.autoRun(). Try weapons.shotgun()/burst()/radial() for a different
  // gun, or aim.autoAim({range}) for one-thumb aim assist. Defaults below make a
  // top-down twin-stick shooter.
  ctx.camera = cameras.topDown({ height: config.camHeight, back: config.camBack });
  ctx.movement = movements.twinStick({ speed: config.playerSpeed });
  ctx.weapon = weapons.single({ cooldown: config.fireCooldown });
  ctx.aim = aim.stick();

  // The systems that make up this game. Add or remove a line to change it;
  // events keep them decoupled, so order only matters within the same phase.
  initInput(ctx);
  initMovement(ctx);
  initAI(ctx);
  initFire(ctx);
  initSpawn(ctx);
  initCollision(ctx);
  initHealth(ctx);
  initScore(ctx);
  initCleanup(ctx);
  initGameState(ctx);
  initHud(ctx);
  initAudio(ctx);
  initRender(ctx);

  makeLoop({
    paused: () => ctx.signals.gameState.get() !== 'playing',
    registries: [ctx.registries.enemies, ctx.registries.bullets],
  }).start();

  return ctx;
}
