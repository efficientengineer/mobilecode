// Headless test of the engine's SIM (core + gameplay systems) + the pure camera
// controllers — no DOM, no WebGL. The decoupled design is what makes this
// possible: game logic and camera math run and are asserted without a browser.
import { on, emit, clearEvents } from './engine/core/events.js';
import { signal } from './engine/core/signals.js';
import { makeRegistry } from './engine/core/registry.js';
import { makeRng } from './engine/core/rng.js';
import { spawn, spawnInto, resetWorld } from './engine/core/world.js';
import { makeLoop } from './engine/core/loop.js';
import { initMovement } from './engine/systems/movement.js';
import { initAI } from './engine/systems/ai.js';
import { initFire } from './engine/systems/fire.js';
import { initSpawn } from './engine/systems/spawn.js';
import { initCollision } from './engine/systems/collision.js';
import { initHealth } from './engine/systems/health.js';
import { initScore } from './engine/systems/score.js';
import { initCleanup } from './engine/systems/cleanup.js';
import { cameras, topDown, sideScroller, flat2D, thirdPerson } from './engine/render/cameras.js';
import { movements, twinStick, platformer, autoRun } from './engine/control/movements.js';

let pass = 0;
const check = (name, cond) => { if (!cond) { console.error('  FAIL:', name); process.exit(1); } console.log('  ok:', name); pass++; };

// ---- core primitives ----
{ let got = null; const un = on('x', d => (got = d)); emit('x', 5); check('event delivered', got === 5);
  un(); got = null; emit('x', 9); check('unsubscribe works', got === null); clearEvents(); }
{ const s = signal(1); const seen = []; s.subscribe(v => seen.push(v)); s.set(2); s.set(2); s.update(v => v + 10);
  check('signal: initial + changes, dedup', seen.join(',') === '1,2,12'); }
{ const r = makeRegistry(); const a = {}, b = {}; r.add(a); r.add(b);
  check('registry add is deferred', r.size === 0); r.flush(); check('flush applies adds', r.size === 2);
  let n = 0; r.each(e => { n++; if (e === a) r.remove(a); });
  check('remove-during-iterate is safe', n === 2 && r.size === 2);
  r.flush(); check('deferred remove applied', r.size === 1); }
{ check('seeded rng deterministic', makeRng(42).next() === makeRng(42).next()); }

// ---- camera controllers (pure) ----
{ const c = topDown({ height: 20, back: 10 })([5, 0, 3]);
  check('topDown sits above and behind focus', c.eye[0] === 5 && c.eye[1] === 20 && c.eye[2] === 13 && c.target[0] === 5 && c.target[2] === 3); }
{ const c = sideScroller({ distance: 18, height: 4 })([7, 0, 0]);
  check('sideScroller looks along +z at the focus', c.eye[2] === 18 && c.eye[0] === 7 && c.target[2] === 0); }
{ const c = flat2D({ size: 15 })([2, 0, 4]);
  check('flat2D is orthographic, top-down, ground-plane up', c.projection === 'ortho' && c.orthoSize === 15 && c.up[2] === -1 && c.eye[1] === 24); }
{ const c = thirdPerson({ distance: 10, height: 5 })([0, 0, 0], { rot: 0 });
  check('thirdPerson sits behind by facing', Math.abs(c.eye[2] - (-10)) < 1e-9 && c.eye[1] === 5); }
{ check('camera library exposes the variants', ['topDown', 'sideScroller', 'thirdPerson', 'orbit', 'fixed', 'flat2D', 'sideScroller2D'].every(k => typeof cameras[k] === 'function')); }

// ---- movement controllers (pure) ----
{ const e = { pos: [0, 0, 0], vel: [0, 0, 0], rot: 0 }; twinStick({ speed: 8 })(e, { move: [1, 0], aim: [0, 0], jump: false }, 1 / 60);
  check('twinStick drives xz from the stick', e.vel[0] === 8 && e.vel[2] === 0 && e.vel[1] === 0); }
{ const e = { pos: [0, 5, 0], vel: [0, 0, 0], rot: 0 }; platformer({ speed: 8, gravity: 40 })(e, { move: [1, 0], jump: false }, 0.1);
  check('platformer: horizontal move + gravity while airborne', e.vel[0] === 8 && e.vel[1] < 0); }
{ const e = { pos: [0, 0, 0], vel: [0, 0, 0], rot: 0 }; const p = platformer({ jump: 15, gravity: 40 });
  p(e, { move: [0, 0], jump: true }, 0.016);
  check('platformer jumps on a fresh press from the ground', e.vel[1] === 15);
  e.vel[1] = 0; e.pos[1] = 0;
  p(e, { move: [0, 0], jump: true }, 0.016);
  check('platformer jump is edge-triggered (no bunny-hop while held)', e.vel[1] === 0); }
{ const e = { pos: [0, 0, 0], vel: [0, 0, 0], rot: 0 }; autoRun({ speed: 10 })(e, { move: [0, 0], jump: false }, 0.016);
  check('autoRun runs forward constantly', e.vel[0] === 10); }
{ check('movement library exposes the variants', ['twinStick', 'eightWay', 'tank', 'platformer', 'autoRun'].every(k => typeof movements[k] === 'function')); }

// ---- gameplay sim ----
const ENT = { player: { mesh: 'cylinder', color: [0, 0, 1], scale: 1, radius: 0.6 },
  enemy: { mesh: 'sphere', color: [1, 0, 0], scale: 1, radius: 0.6, hp: 1, speed: 3 },
  bullet: { mesh: 'box', color: [1, 1, 0], scale: 0.3, radius: 0.3 } };
const CFG = { playerSpeed: 8, playerHp: 100, fireCooldown: 0.1, bulletSpeed: 20, bulletLife: 1, bulletDamage: 1,
  enemyDamage: 10, scorePerKill: 10, baseEnemies: 2, waveDelay: 1, arena: 20, camHeight: 20, camBack: 12 };
const makeCtx = () => ({ signals: { gameState: signal('playing'), score: signal(0), wave: signal(0), playerHealth: signal(100),
    moveInput: signal([0, 0]), aimInput: signal([1, 0]), firing: signal(false), player: signal(null) },
  registries: { enemies: makeRegistry(), bullets: makeRegistry() }, entities: ENT, config: CFG, rng: makeRng(1) });
const sim = (ctx) => { initMovement(ctx); initAI(ctx); initFire(ctx); initSpawn(ctx); initCollision(ctx); initHealth(ctx); initScore(ctx); initCleanup(ctx);
  return makeLoop({ paused: () => ctx.signals.gameState.get() !== 'playing', registries: [ctx.registries.enemies, ctx.registries.bullets] }); };

{ clearEvents(); resetWorld(); const ctx = makeCtx(); const loop = sim(ctx);
  ctx.signals.player.set(spawn('player', { at: [0, 0, 0], radius: 0.6 })); emit('game-started');
  for (let i = 0; i < 45; i++) loop.step(1 / 60);
  check('spawn director created a wave', ctx.registries.enemies.size > 0);
  ctx.signals.firing.set(true); ctx.signals.aimInput.set([1, 0]); loop.step(1 / 60);
  check('firing produced a bullet', ctx.registries.bullets.size > 0); }

{ clearEvents(); resetWorld(); const ctx = makeCtx(); const loop = sim(ctx);
  const p = spawn('player', { at: [0, 0, 0], radius: 0.6 }); ctx.signals.player.set(p);
  const e = spawnInto(ctx.registries.enemies, 'enemy', { at: [10, 0, 0], radius: 0.6, hp: 99, speed: 3 });
  ctx.registries.enemies.flush(); const x0 = e.pos[0]; loop.step(1 / 60); loop.step(1 / 60);
  check('enemy advances toward player', e.pos[0] < x0); }

{ clearEvents(); resetWorld(); const ctx = makeCtx(); const loop = sim(ctx);
  ctx.signals.player.set(spawn('player', { at: [-5, 0, 0], radius: 0.6 }));
  const e = spawnInto(ctx.registries.enemies, 'enemy', { at: [3, 0, 0], radius: 0.6, hp: 1, speed: 0 });
  spawnInto(ctx.registries.bullets, 'bullet', { at: [3, 0, 0], radius: 0.3, vel: [0, 0, 0] });
  ctx.registries.enemies.flush(); ctx.registries.bullets.flush();
  let died = false; on('enemy-died', () => (died = true)); loop.step(1 / 60);
  check('bullet hit killed the enemy', died && e.dead);
  check('score went up on kill', ctx.signals.score.get() === CFG.scorePerKill);
  check('dead enemy removed from registry', ctx.registries.enemies.size === 0); }

{ clearEvents(); resetWorld(); const ctx = makeCtx(); const loop = sim(ctx);
  ctx.signals.player.set(spawn('player', { at: [-5, 0, 0], radius: 0.6 }));
  spawnInto(ctx.registries.enemies, 'enemy', { at: [3, 0, 0], radius: 0.6, hp: 1, speed: 0 });
  spawnInto(ctx.registries.bullets, 'bullet', { at: [3, 0, 0], radius: 0.3, vel: [0, 0, 0] });
  spawnInto(ctx.registries.bullets, 'bullet', { at: [3, 0, 0], radius: 0.3, vel: [0, 0, 0] });
  ctx.registries.enemies.flush(); ctx.registries.bullets.flush();
  let deaths = 0; on('enemy-died', () => deaths++); loop.step(1 / 60);
  check('two hits same frame = one death', deaths === 1 && ctx.signals.score.get() === CFG.scorePerKill); }

{ clearEvents(); resetWorld(); const ctx = makeCtx(); const loop = sim(ctx);
  ctx.signals.player.set(spawn('player', { at: [0, 0, 0], radius: 0.6 }));
  spawnInto(ctx.registries.enemies, 'enemy', { at: [0, 0, 0], radius: 0.6, hp: 99, speed: 0 });
  ctx.registries.enemies.flush(); loop.step(1 / 60);
  check('player-hit drained health', ctx.signals.playerHealth.get() === 100 - CFG.enemyDamage); }

{ clearEvents(); resetWorld(); const ctx = makeCtx(); const loop = sim(ctx);
  ctx.signals.player.set(spawn('player', { at: [0, 0, 0], radius: 0.6 }));
  const e = spawnInto(ctx.registries.enemies, 'enemy', { at: [10, 0, 0], radius: 0.6, hp: 99, speed: 5 });
  ctx.registries.enemies.flush(); ctx.signals.gameState.set('paused');
  const x0 = e.pos[0]; for (let i = 0; i < 5; i++) loop.step(1 / 60);
  check('paused: sim skipped, nothing moves', e.pos[0] === x0); }

console.log('\nENGINE: ALL ' + pass + ' CHECKS PASSED');
