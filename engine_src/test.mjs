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
import { weapons, single, shotgun, burst, radial } from './engine/control/weapons.js';
import { aim } from './engine/control/aim.js';
import { behaviors, chase, flee, orbit, keepDistance, patrol, follow, guard } from './engine/control/behaviors.js';
import { spawners } from './engine/control/spawners.js';
import { pickups } from './engine/control/pickups.js';
import { hazards } from './engine/control/hazards.js';
import { difficulty } from './engine/control/difficulty.js';
import { steering } from './engine/control/steering.js';
import { projectiles } from './engine/control/projectiles.js';
import { patterns } from './engine/control/patterns.js';
import { targeting } from './engine/control/targeting.js';
import { statuses } from './engine/control/statuses.js';
import { damage } from './engine/control/damage.js';
import { abilities } from './engine/control/abilities.js';
import { vehicles } from './engine/control/vehicles.js';
import { formations } from './engine/control/formations.js';
import { pathing } from './engine/control/pathing.js';
import { cameraFx } from './engine/control/camerafx.js';
import { tweens } from './engine/control/tweens.js';
import { effects } from './engine/control/effects.js';
import { particles } from './engine/control/particles.js';
import { transitions } from './engine/control/transitions.js';
import { palettes } from './engine/control/palettes.js';
import { fsm } from './engine/control/fsm.js';
import { senses } from './engine/control/senses.js';
import { squad } from './engine/control/squad.js';
import { dialogue } from './engine/control/dialogue.js';
import { utility } from './engine/control/utility.js';
import { save } from './engine/control/save.js';
import { inventory } from './engine/control/inventory.js';
import { progression } from './engine/control/progression.js';
import { quests } from './engine/control/quests.js';
import { economy } from './engine/control/economy.js';
import { gestures } from './engine/control/gestures.js';
import { hudkit } from './engine/control/hudkit.js';
import { menus } from './engine/control/menus.js';
import { touchlayout } from './engine/control/touchlayout.js';
import { tutorial } from './engine/control/tutorial.js';

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

// ---- weapon controllers (pure) ----
{ const g = single({ speed: 20, cooldown: 0.2 });
  check('single fires one shot on the first tick', g(0.016, true, [0, 1]).length === 1);
  check('single respects cooldown', g(0.016, true, [0, 1]).length === 0);
  check('weapon holds fire when the trigger is up', single({})(0.5, false, [0, 1]).length === 0); }
{ const sh = shotgun({ pellets: 5, spreadDeg: 30, cooldown: 0.6 })(0.7, true, [0, 1]);
  check('shotgun fires every pellet', sh.length === 5);
  check('shotgun center pellet points along the aim', Math.abs(sh[2].dir[0]) < 1e-9 && Math.abs(sh[2].dir[1] - 1) < 1e-9);
  check('shotgun fans symmetrically', Math.abs(sh[0].dir[0] + sh[4].dir[0]) < 1e-9); }
{ const w = burst({ count: 3, gap: 0.05, cooldown: 0.5 }); let n = 0;
  for (let i = 0; i < 3; i++) n += w(0.05, true, [0, 1]).length;
  check('burst fires exactly count shots', n === 3);
  check('burst then rests', w(0.05, true, [0, 1]).length === 0); }
{ const r = radial({ ways: 8, cooldown: 0.5 });
  check('radial fires ways bullets at once', r(0.6, true, [0, 1]).length === 8);
  check('radial respects cooldown', r(0.1, true, [0, 1]).length === 0); }
{ check('weapon library exposes the variants', ['single', 'rapid', 'shotgun', 'burst', 'radial'].every(k => typeof weapons[k] === 'function')); }

// ---- aim controllers ----
{ check('aim.stick uses the raw stick', aim.stick()({ pos: [0, 0, 0], rot: 0 }, [1, 0], {}).join(',') === '1,0');
  check('aim.stick falls back to facing when centered', aim.stick()({ pos: [0, 0, 0], rot: 0 }, [0, 0], {})[1] === 1); }
{ const m = aim.manual(); m({ pos: [0, 0, 0], rot: 0 }, [1, 0], {});
  check('aim.manual holds the last aim after release', m({ pos: [0, 0, 0], rot: 0 }, [0, 0], {}).join(',') === '1,0'); }
{ const enemies = makeRegistry(); enemies.add({ pos: [3, 0, 0], dead: false }); enemies.add({ pos: [0, 0, 10], dead: false }); enemies.flush();
  const d = aim.autoAim({ range: 20 })({ pos: [0, 0, 0], rot: 0 }, [0, 0], { registries: { enemies } });
  check('aim.autoAim locks the nearest enemy', d[0] === 1 && d[1] === 0); }
{ check('aim library exposes the variants', ['stick', 'facing', 'manual', 'autoAim'].every(k => typeof aim[k] === 'function')); }

// ---- behavior controllers (enemy/NPC brains) ----
const mkE = (x, z, extra = {}) => ({ kind: 'enemy', pos: [x, 0, z], vel: [0, 0, 0], rot: 0, speed: 3, ...extra });
const player = { pos: [0, 0, 0] };
{ const e = mkE(5, 0); chase()(e, player, 1 / 60);
  check('chase drives toward the target', e.vel[0] < 0 && Math.abs(e.vel[2]) < 1e-9); }
{ const e = mkE(5, 0); flee()(e, player, 1 / 60);
  check('flee drives away from the target', e.vel[0] > 0); }
{ const e = mkE(5, 0); chase()(e, null, 1 / 60);
  check('no target → idle', e.vel[0] === 0 && e.vel[2] === 0); }
{ const e = mkE(10, 0); keepDistance({ min: 5, max: 9 })(e, player, 1 / 60);
  check('keepDistance approaches when too far', e.vel[0] < 0);
  const near = mkE(3, 0); keepDistance({ min: 5, max: 9 })(near, player, 1 / 60);
  check('keepDistance backs off when too close', near.vel[0] > 0);
  const ok = mkE(7, 0); keepDistance({ min: 5, max: 9 })(ok, player, 1 / 60);
  check('keepDistance holds in the band', ok.vel[0] === 0 && ok.vel[2] === 0); }
{ const e = mkE(6, 0); const spd0 = 3; orbit({ radius: 6, dir: 1 })(e, player, 1 / 60);
  check('orbit moves mostly tangentially at radius', Math.abs(e.vel[0]) < 0.5 && Math.abs(e.vel[2]) > 2); }
{ const e = mkE(0, 0); patrol({ points: [[0, 5], [0, -5]] })(e, null, 1 / 60);
  check('patrol heads to the first waypoint', e.vel[2] > 0); }
{ const e = mkE(2, 0); follow({ distance: 3 })(e, player, 1 / 60);
  check('follow holds inside its distance', e.vel[0] === 0 && e.vel[2] === 0);
  const far = mkE(6, 0); follow({ distance: 3 })(far, player, 1 / 60);
  check('follow closes when beyond its distance', far.vel[0] < 0); }
{ const e = mkE(1, 0); const g = guard({ radius: 6 }); g(e, player, 1 / 60);
  check('guard chases an intruder in range', e.vel[0] < 0);
  const home = mkE(0, 0); const g2 = guard({ radius: 3 }); g2(home, null, 1 / 60);   // sets home
  home.pos[0] = 4; g2(home, null, 1 / 60);
  check('guard returns home when alone', home.vel[0] < 0); }
{ const disp = behaviors.byKind({ enemy: flee(), default: chase() });
  const e = mkE(5, 0); disp(e, player, 1 / 60);
  check('byKind dispatches on entity kind', e.vel[0] > 0); }
{ check('behavior library exposes the variants', ['chase', 'flee', 'orbit', 'keepDistance', 'zigzag', 'charger', 'wander', 'patrol', 'follow', 'guard', 'byKind'].every(k => typeof behaviors[k] === 'function')); }

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

{ clearEvents(); resetWorld(); const ctx = makeCtx(); ctx.weapon = shotgun({ pellets: 4, cooldown: 0.3 }); const loop = sim(ctx);
  ctx.signals.player.set(spawn('player', { at: [0, 0, 0], radius: 0.6 }));
  ctx.signals.aimInput.set([1, 0]); ctx.signals.firing.set(true); loop.step(1 / 60);
  check('weapon component spawns a bullet per pellet', ctx.registries.bullets.size === 4); }

{ clearEvents(); resetWorld(); const ctx = makeCtx(); const loop = sim(ctx);
  const p = spawn('player', { at: [0, 0, 0], radius: 0.6 }); ctx.signals.player.set(p);
  const e = spawnInto(ctx.registries.enemies, 'enemy', { at: [10, 0, 0], radius: 0.6, hp: 99, speed: 3 });
  ctx.registries.enemies.flush(); const x0 = e.pos[0]; loop.step(1 / 60); loop.step(1 / 60);
  check('enemy advances toward player', e.pos[0] < x0); }

{ clearEvents(); resetWorld(); const ctx = makeCtx(); ctx.behavior = flee(); const loop = sim(ctx);
  ctx.signals.player.set(spawn('player', { at: [0, 0, 0], radius: 0.6 }));
  const e = spawnInto(ctx.registries.enemies, 'enemy', { at: [3, 0, 0], radius: 0.6, hp: 99, speed: 3 });
  ctx.registries.enemies.flush(); const x0 = e.pos[0]; loop.step(1 / 60); loop.step(1 / 60);
  check('behavior component: flee retreats from the player', e.pos[0] > x0); }

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


// ===== Round 1 components: spawners / pickups / hazards / difficulty / steering =====

{
  const { waves, endless, burst, boss, timed, chain } = spawners;
// --- spawners (spawn directors) ---
{
  const mkApi = (liveRef) => {
    const rec = { spawns: [], waves: [], cbs: [] };
    return { rec,
      count: () => liveRef.n,
      spawn: (o) => rec.spawns.push(o),
      setWave: (n) => { rec.waves.push(n); for (const c of rec.cbs) c(n); },
      onWave: (cb) => rec.cbs.push(cb),
      rng: { next: () => 0.5, range: (a, b) => (a + b) / 2, int: (a) => a } };
  };

  // waves: base batch on start, escalate when clear after delay
  {
    const live = { n: 0 }; const api = mkApi(live);
    const d = waves({ base: 3, growth: 2, delay: 2 });
    d(0.1, api);
    check('waves spawns base on start', api.rec.spawns.length === 3);
    check('waves announces wave 1', api.rec.waves[0] === 1);
    live.n = 3; d(1, api);
    check('waves holds while enemies alive', api.rec.spawns.length === 3);
    live.n = 0; d(1, api);
    check('waves waits out the delay', api.rec.spawns.length === 3);
    d(1.5, api);
    check('waves advances to wave 2', api.rec.waves[1] === 2);
    check('waves wave2 size = base+growth', api.rec.spawns.length === 3 + 5);
  }

  // endless: rate trickle + long-frame catch-up + max cap
  {
    const live = { n: 0 }; const api = mkApi(live);
    const d = endless({ rate: 2 });
    d(0.4, api); check('endless waits for interval', api.rec.spawns.length === 0);
    d(0.2, api); check('endless spawns at interval', api.rec.spawns.length === 1);
    d(1.0, api); check('endless catches up long frame', api.rec.spawns.length === 3);
    const live2 = { n: 5 }; const api2 = mkApi(live2);
    endless({ rate: 100, max: 5 })(1, api2);
    check('endless respects max', api2.rec.spawns.length === 0);
  }

  // burst: periodic clumps
  {
    const live = { n: 0 }; const api = mkApi(live);
    const d = burst({ size: 4, every: 3 });
    d(2.9, api); check('burst holds before period', api.rec.spawns.length === 0);
    d(0.2, api); check('burst fires a clump', api.rec.spawns.length === 4);
    d(3, api); check('burst fires again', api.rec.spawns.length === 8);
  }

  // timed: absolute schedule
  {
    const live = { n: 0 }; const api = mkApi(live);
    const d = timed({ schedule: [{ at: 0, make: 'a' }, { at: 2, count: 3, make: 'b' }] });
    d(0, api); check('timed fires at t=0', api.rec.spawns.length === 1);
    d(1, api); check('timed idle before next cue', api.rec.spawns.length === 1);
    d(1.5, api); check('timed fires batch at t>=2', api.rec.spawns.length === 4);
    check('timed forwards make', api.rec.spawns[1].make === 'b');
  }

  // boss: gated on wave via onWave, one-shot
  {
    const live = { n: 0 }; const api = mkApi(live);
    const d = boss({ atWave: 3, make: 'BOSS', escort: 2 });
    d(0, api);
    api.setWave(1); d(0, api); check('boss waits for atWave', api.rec.spawns.length === 0);
    api.setWave(3); d(0, api);
    check('boss spawns boss+escort', api.rec.spawns.length === 3);
    check('boss marks the boss', api.rec.spawns[0].boss === true && api.rec.spawns[0].make === 'BOSS');
    d(0, api); check('boss spawns only once', api.rec.spawns.length === 3);
  }

  // chain: waves drives, boss watches the forwarded wave
  {
    const live = { n: 0 }; const api = mkApi(live);
    const d = chain(waves({ base: 2, growth: 0, delay: 0 }), boss({ atWave: 2, make: 'B' }));
    d(0, api); check('chain runs its child directors', api.rec.spawns.length === 2);
    live.n = 0; d(0.1, api);
    check('chain forwards wave to a boss', api.rec.spawns.some((s) => s.boss));
  }

  check('spawners bundle exports every director', ['waves', 'endless', 'burst', 'boss', 'timed', 'chain'].every((k) => typeof spawners[k] === 'function'));
}
}

{
  // pickups.js — effect components mutate signals/player and return a tag
  const sig = (v) => { let x = v; return { get: () => x, set: (n) => { x = n; }, update(fn){ x = fn(x); } }; };

  // health raises playerHealth, capped at 100
  const hctx = { signals: { playerHealth: sig(90) } };
  const htag = pickups.health({ amount: 25 }).apply(hctx, {});
  check('pickups.health caps at 100', hctx.signals.playerHealth.get() === 100 && htag === 'heal');

  // shield stashes a timer on the player, stacking by max
  const sp = {};
  pickups.shield({ duration: 5 }).apply({}, sp);
  pickups.shield({ duration: 3 }).apply({}, sp);
  check('pickups.shield keeps longer timer', sp.shield === 5);

  // scoreBonus bumps the score signal
  const cctx = { signals: { score: sig(50) } };
  check('pickups.scoreBonus adds points', pickups.scoreBonus({ points: 100 }).apply(cctx, {}) === 'score' && cctx.signals.score.get() === 150);

  // speedBoost stashes mult + timer for movement to read
  const bp = {};
  pickups.speedBoost({ mult: 2, duration: 4 }).apply({}, bp);
  check('pickups.speedBoost stashes buff', bp.speedMult === 2 && bp.speedTimer === 4);

  // weaponSwap swaps ctx.weapon
  const wctx = { weapon: null }; const gun = { id: 1 };
  pickups.weaponSwap({ weapon: gun }).apply(wctx, {});
  check('pickups.weaponSwap sets ctx.weapon', wctx.weapon === gun);

  // magnet stashes radius + timer
  const mp = {};
  pickups.magnet({ radius: 6, duration: 5 }).apply({}, mp);
  check('pickups.magnet stashes radius', mp.magnetRadius === 6 && mp.magnetTimer === 5);

  // extraLife bumps a lives signal and refills health
  const lctx = { signals: { lives: sig(2), playerHealth: sig(10) } };
  check('pickups.extraLife adds life + refills', pickups.extraLife().apply(lctx, {}) === 'life' && lctx.signals.lives.get() === 3 && lctx.signals.playerHealth.get() === 100);

  // makePickup helper wraps a tagged effect; partial ctx is safe
  check('pickups.makePickup shape', pickups.makePickup('x', () => 't').kind === 'x');
  check('pickups safe on partial ctx', (() => { try { pickups.health().apply({}, undefined); return true; } catch { return false; } })());
}

// --- hazards (environmental effect zones) ---
{
  const ent = (x, z, r = 0) => ({ pos: [x, 0, z], radius: r, vel: [0, 0, 0] });
  const circle = { pos: [0, 0, 0], radius: 5 };
  const box = { min: [-2, -2], max: [2, 2] };

  const dz = hazards.damageZone({ dps: 10 });
  check('hazards inside circle center', dz.inside(ent(0, 0), circle));
  check('hazards outside circle', !dz.inside(ent(6, 0), circle));
  check('hazards radius overlap counts', dz.inside(ent(5.5, 0, 1), circle));
  check('hazards inside box', dz.inside(ent(1, 1), box));
  check('hazards outside box', !dz.inside(ent(3, 3), box));
  check('hazards null zone safe', !dz.inside(ent(0, 0), null));
  check('hazards damageZone dt-scaled', Math.abs(dz.affect(ent(0, 0), 0.5, circle).damage - 5) < 1e-9);
  check('hazards damageZone outside null', dz.affect(ent(9, 0), 1, circle) === null);

  const dzE = ent(0, 0);
  dz.affect(dzE, 1, circle);
  check('hazards affect no mutation', dzE.vel[0] === 0 && dzE.pos[0] === 0);

  const sp = hazards.spikes({ damage: 20 });
  const s1 = ent(0, 0);
  check('hazards spikes hit on entry', sp.affect(s1, 0.1, circle).damage === 20);
  check('hazards spikes silent while staying', sp.affect(s1, 0.1, circle) === null);
  s1.pos = [9, 0, 0];
  check('hazards spikes leave = null', sp.affect(s1, 0.1, circle) === null);
  s1.pos = [0, 0, 0];
  check('hazards spikes re-trigger on re-entry', sp.affect(s1, 0.1, circle).damage === 20);
  const s2 = ent(0, 0);
  check('hazards spikes per-entity independent', sp.affect(s2, 0.1, circle).damage === 20);

  const lv = hazards.lava({ dps: 30, slow: 0.5 }).affect(ent(0, 0), 1, circle);
  check('hazards lava damage + slow', Math.abs(lv.damage - 30) < 1e-9 && lv.slow === 0.5);

  check('hazards slowField mult', hazards.slowField({ mult: 0.3 }).affect(ent(0, 0), 1, circle).slow === 0.3);
  check('hazards pit kills inside', hazards.pit().affect(ent(0, 0), 1, circle).kill === true);
  check('hazards pit outside null', hazards.pit().affect(ent(99, 0), 1, circle) === null);

  const wz = hazards.windZone({ force: [4, -2] });
  const w = wz.affect(ent(0, 0), 0.5, circle);
  check('hazards windZone push dt-scaled', Math.abs(w.push[0] - 2) < 1e-9 && Math.abs(w.push[1] + 1) < 1e-9);
  check('hazards windZone outside null', wz.affect(ent(99, 0), 0.5, circle) === null);
  check('hazards windZone outward is unit', Math.abs(Math.hypot(...wz.outward(ent(3, 0), circle)) - 1) < 1e-9);

  check('hazards bundle complete', ['damageZone','spikes','lava','slowField','pit','windZone'].every(k => typeof hazards[k] === 'function'));
}

{
  const { linear, stepped, waveBased, adaptive, flat, compose } = difficulty;
// --- difficulty.js ---
{
  const keys = m => ['speedMul','hpMul','rateMul','damageMul'].every(k => typeof m[k] === 'number');
  check('difficulty bundle', Object.keys(difficulty).length === 6 && difficulty.linear === linear && difficulty.adaptive === adaptive);

  // flat: fixed multipliers forever
  const f = flat({ hp: 0.5 });
  check('difficulty flat fixed', f({ time: 999 }).hpMul === 0.5 && f({}).speedMul === 1);

  // linear: base at 0, grows with time, deterministic, capped
  const l = linear({ per: 0.1, unit: 60, cap: 3 });
  check('difficulty linear keys', keys(l({ time: 0 })));
  check('difficulty linear base', l({ time: 0 }).hpMul === 1);
  check('difficulty linear grows', l({ time: 600 }).hpMul > l({ time: 60 }).hpMul);
  check('difficulty linear deterministic', l({ time: 60 }).hpMul === l({ time: 60 }).hpMul);
  check('difficulty linear cap', l({ time: 1e9 }).hpMul <= 3);

  // stepped: discrete plateaus then jumps
  const s = stepped({ every: 30, step: 0.25 });
  check('difficulty stepped plateau', s({ time: 0 }).hpMul === s({ time: 29 }).hpMul);
  check('difficulty stepped jump', s({ time: 30 }).hpMul > s({ time: 29 }).hpMul);

  // waveBased: wave 1 = base, ramps per wave
  const w = waveBased({ perWave: 0.15 });
  check('difficulty wave base', w({ wave: 1 }).hpMul === 1);
  check('difficulty wave grows', w({ wave: 5 }).hpMul > w({ wave: 2 }).hpMul);

  // adaptive: eases up when winning, down (bounded by floor) when losing
  const a = adaptive({ up: 0.2, down: 0.1 });
  let hi; for (let i = 0; i < 6; i++) hi = a({ performance: 1 });
  check('difficulty adaptive up', hi.hpMul > 1);
  const a2 = adaptive({ floor: 0.5 });
  let lo; for (let i = 0; i < 6; i++) lo = a2({ performance: 0 });
  check('difficulty adaptive down', lo.hpMul <= 1 && lo.hpMul >= 0.5 - 1e-9);

  // compose: multiplies curves
  const c = compose(flat({ hp: 2 }), flat({ hp: 3 }));
  check('difficulty compose', Math.abs(c({}).hpMul - 6) < 1e-9);

  // robust to bad/missing state
  check('difficulty nan safe', keys(l({ time: NaN })) && l({}).hpMul === 1);
}
}

{
  const { seek, flee, arrive, pursue, evade, separation, wander, combine } = steering;
{
  const L = (w) => Math.hypot(w[0], w[2]);
  const near = (a, b, e = 1e-6) => Math.abs(a - b) < e;

  // seek/flee are mirror unit*speed vectors on the ground plane (y===0)
  let v = seek([0,0,0], [10,0,0], 5);
  check('steering.seek dir+speed', near(v[0], 5) && v[1] === 0 && near(v[2], 0));
  v = flee([0,0,0], [10,0,0], 5);
  check('steering.flee is mirror', near(v[0], -5));
  check('steering.seek degenerate zero', (() => { const w = seek([2,0,2],[2,0,2],5); return w[0]===0 && w[2]===0; })());

  // arrive: full speed far out, ramps inside slowRadius, zero at goal
  check('steering.arrive full far', near(L(arrive([0,0,0],[10,0,0],4,3)), 4));
  check('steering.arrive half ramp', near(L(arrive([0,0,0],[1.5,0,0],4,3)), 2));
  check('steering.arrive at goal zero', (() => { const w = arrive([5,0,5],[5,0,5],4,3); return w[0]===0 && w[2]===0; })());

  // pursue leads a mover; degrades to seek when target is still
  v = pursue({ pos:[0,0,0], vel:[0,0,0] }, { pos:[10,0,0], vel:[0,0,10] }, 5);
  check('steering.pursue leads target', v[2] > 0 && near(L(v), 5));
  v = pursue({ pos:[0,0,0], vel:[0,0,0] }, { pos:[10,0,0], vel:[0,0,0] }, 5);
  check('steering.pursue stationary==seek', near(v[0], 5) && near(v[2], 0));

  // evade flees the interception point
  v = evade({ pos:[0,0,0], vel:[0,0,0] }, { pos:[10,0,0], vel:[0,0,10] }, 5);
  check('steering.evade dodges lead', v[0] < 0 && v[2] < 0);

  // separation: repel from crowd, zero when clear
  v = separation([0,0,0], [[1,0,0],[0,0,1]], 3, 4);
  check('steering.separation pushes off crowd', v[0] < 0 && v[2] < 0 && near(L(v), 4));
  check('steering.separation clear==zero', (() => { const w = separation([0,0,0], [[20,0,20]], 3, 4); return w[0]===0 && w[2]===0; })());

  // wander: bounded speed, deterministic with an rng, mutates heading
  let st = { heading: 0, rng: { next: () => 1 } };
  v = wander(st, { speed: 3 });
  check('steering.wander speed clamp', near(L(v), 3) && st.heading !== 0);

  // combine: weighted blend then clamp to maxSpeed
  v = combine([{ v:[3,0,0], weight:1 }, { v:[0,0,4], weight:1 }]);
  check('steering.combine sums', near(v[0], 3) && near(v[2], 4));
  check('steering.combine clamps', near(L(combine([{v:[3,0,0]},{v:[0,0,4]}], 2.5)), 2.5));
  check('steering.combine empty zero', (() => { const w = combine([]); return w[0]===0 && w[2]===0; })());

  check('steering bundle complete', ['seek','flee','arrive','pursue','evade','separation','wander','combine'].every(k => typeof steering[k] === 'function'));
}
}


// ===== Round 2 components: projectiles / patterns / targeting / statuses / damage =====

// ---- projectile motion controllers (pure) ----
{
  const mkB = (vx, vy, vz, x = 0, y = 0, z = 0) => ({ kind: 'bullet', pos: [x, y, z], vel: [vx, vy, vz] });
  const near = (a, b, e = 1e-6) => Math.abs(a - b) < e;
  const Lp = (v) => Math.hypot(v[0], v[2]);

  // straight: constant velocity
  { const b = mkB(5, 0, 0); projectiles.straight()(b, 0.1, {});
    check('projectiles.straight keeps velocity', b.vel[0] === 5 && b.vel[2] === 0); }

  // homing: turns toward target holding speed; straight & safe without one
  { const ctx = { target: () => ({ pos: [10, 0, 0] }) };
    const b = mkB(0, 0, 5); const h = projectiles.homing({ turn: 4 });
    h(b, 0.1, ctx);
    check('projectiles.homing keeps speed', near(Lp(b.vel), 5));
    check('projectiles.homing steers toward target', b.vel[0] > 0);
    const b2 = mkB(0, 0, 5); projectiles.homing({})(b2, 0.1, {});
    check('projectiles.homing flies straight without a target', near(b2.vel[0], 0) && near(Lp(b2.vel), 5));
    const b3 = mkB(0, 0, 5); projectiles.homing({ turn: 1 })(b3, 0.1, ctx);
    check('projectiles.homing clamps to max turn rate', near(Math.atan2(b3.vel[0], b3.vel[2]), 0.1)); }

  // boomerang: out to range, back to owner, dies home
  { const b = mkB(6, 0, 0); const bm = projectiles.boomerang({ range: 8, speed: 6 });
    bm(b, 0.1, {});
    check('projectiles.boomerang starts outbound', b._m.phase === 'out' && b.vel[0] > 0);
    b.pos[0] = 9; bm(b, 0.1, {});
    check('projectiles.boomerang returns past range', b._m.phase === 'back' && b.vel[0] < 0);
    b.pos[0] = 0.2; bm(b, 0.1, {});
    check('projectiles.boomerang self-destructs when home', b.dead === true); }

  // wave: weaves both sides, still advances, bounded by amp
  { const b = mkB(0, 0, 4); const wv = projectiles.wave({ amp: 3, freq: 6 });
    let minX = 0, maxX = 0;
    for (let i = 0; i < 300; i++) { wv(b, 1 / 60, {}); b.pos[0] += b.vel[0] / 60; b.pos[2] += b.vel[2] / 60; minX = Math.min(minX, b.pos[0]); maxX = Math.max(maxX, b.pos[0]); }
    check('projectiles.wave weaves both sides within amp', minX < -1 && maxX > 1 && maxX < 3.5 && minX > -3.5);
    check('projectiles.wave still advances forward', b.pos[2] > 15); }

  // arc: gravity on vel[1], horizontal untouched
  { const b = mkB(5, 8, 0); projectiles.arc({ gravity: 30 })(b, 0.5, {});
    check('projectiles.arc applies downward accel', near(b.vel[1], 8 - 15) && b.vel[0] === 5); }

  // accelerate: ramps along heading, caps, decays without reversing
  { const b = mkB(3, 0, 4); projectiles.accelerate({ accel: 50 })(b, 0.1, {});
    check('projectiles.accelerate ramps speed along heading', near(Lp(b.vel), 10) && near(b.vel[0] / b.vel[2], 3 / 4));
    const c = mkB(6, 0, 0); projectiles.accelerate({ accel: 50, max: 8 })(c, 1, {});
    check('projectiles.accelerate caps at max', near(Lp(c.vel), 8));
    const d = mkB(2, 0, 0); projectiles.accelerate({ accel: -100 })(d, 1, {});
    check('projectiles.accelerate decays without reversing', d.vel[0] === 0); }

  check('projectiles bundle complete', ['straight', 'homing', 'boomerang', 'wave', 'arc', 'accelerate'].every(k => typeof projectiles[k] === 'function'));
}

// ---- patterns (bullet-hell emitters) ----
{ const unit = s => Math.abs(Math.hypot(s.dir[0], s.dir[1]) - 1) < 1e-9;
  // ring: fires on first tick, symmetric full circle, then gated by cooldown
  const r = patterns.ring({ count: 8, cooldown: 1 });
  const rb = r(0.1, {});
  check('patterns.ring fires count', rb.length === 8 && rb.every(unit));
  const rsx = rb.reduce((s, x) => s + x.dir[0], 0), rsz = rb.reduce((s, x) => s + x.dir[1], 0);
  check('patterns.ring symmetric', Math.abs(rsx) < 1e-9 && Math.abs(rsz) < 1e-9);
  check('patterns.ring gated by cooldown', r(0.5, {}).length === 0);
  // spiral: advances base angle by `turn` each fire, respects `rate`
  const sp = patterns.spiral({ count: 1, turn: 0.5, rate: 0.1 });
  const s1 = sp(0.1)[0].dir, s2 = sp(0.1)[0].dir;
  const da = Math.atan2(s2[0], s2[1]) - Math.atan2(s1[0], s1[1]);
  check('patterns.spiral advances by turn', Math.abs(da - 0.5) < 1e-9);
  check('patterns.spiral respects rate', sp(0.05).length === 0);
  // aimedSpread: center bullet aligns with aimDir
  const as = patterns.aimedSpread({ count: 3, arcDeg: 60, cooldown: 0.5 })(0.5, { aimDir: [1, 0] });
  check('patterns.aimedSpread count + centered on aim',
    as.length === 3 && as.every(unit) && Math.abs(as[1].dir[0] - 1) < 1e-9 && Math.abs(as[1].dir[1]) < 1e-9);
  // spinner: sweeps with real time (spin*dt) independent of fire cadence
  const sn = patterns.spinner({ arms: 1, rate: 0.05, spin: 2 });
  const n1 = sn(0.05)[0].dir, n2 = sn(0.05)[0].dir;
  check('patterns.spinner sweeps with time',
    Math.abs((Math.atan2(n2[0], n2[1]) - Math.atan2(n1[0], n1[1])) - 0.1) < 1e-6);
  // pulse: salvo of `pulses` rings, then a long lull
  const pl = patterns.pulse({ count: 4, every: 2, pulses: 3, gap: 0.1 });
  let rings = 0; for (let i = 0; i < 5; i++) if (pl(0.1).length) rings++;
  check('patterns.pulse fires a salvo then rests', rings === 3 && pl(0.1).length === 0); }

// --- targeting.js ---
{
  const E = (x, z, hp) => ({ pos: [x, 0, z], hp });
  const from = [0, 0, 0];
  const c = [E(10, 0, 5), E(2, 0, 3), E(5, 0, 9)];
  check('targeting.nearest', targeting.nearest()(from, c) === c[1]);
  check('targeting.farthest', targeting.farthest()(from, c) === c[0]);
  check('targeting.lowestHp', targeting.lowestHp()(from, c) === c[1]);
  check('targeting.highestHp', targeting.highestHp()(from, c) === c[2]);
  check('targeting.empty-array', targeting.nearest()(from, []) === null);
  check('targeting.empty-null', targeting.nearest()(from, null) === null);
  check('targeting.all-dead', targeting.nearest()(from, [{ pos: [1, 0, 1], dead: true }]) === null);
  const reg = { each(fn) { c.forEach(fn); } };
  check('targeting.registry-each', targeting.nearest()(from, reg) === c[1]);
  let seq = [0.9, 0.1, 0.9], i = 0;
  const rng = { next: () => seq[i++ % seq.length] };
  check('targeting.random-in-set', c.includes(targeting.random({ rng })(from, c)));
  check('targeting.random-no-rng', targeting.random()(from, c) === c[0]);
  const coneSet = [E(0, 10, 1), E(0, -10, 1), E(50, 1, 1)];
  check('targeting.inCone-ahead', targeting.inCone({ dir: [0, 1], arcDeg: 90, range: 100 })(from, coneSet) === coneSet[0]);
  check('targeting.inCone-range', targeting.inCone({ dir: [0, 1], arcDeg: 90, range: 5 })(from, coneSet) === null);
  check('targeting.inCone-aimDir', targeting.inCone({ dir: [0, 1], arcDeg: 90 })(from, coneSet, { aimDir: [0, -1] }) === coneSet[1]);
  const cluster = [E(20, 20, 1), E(21, 20, 1), E(20, 21, 1), E(-50, -50, 1)];
  check('targeting.mostClustered', [cluster[0], cluster[1], cluster[2]].includes(targeting.mostClustered({ radius: 3 })(from, cluster)));
  const a = E(1, 0, 1), b = E(2, 0, 1), lr = targeting.leastRecent();
  check('targeting.leastRecent-1', lr(from, [a, b]) === a);
  check('targeting.leastRecent-2', lr(from, [a, b]) === b);
  check('targeting.leastRecent-reset', lr(from, [a, b]) === a);
  check('targeting.leastRecent-empty', targeting.leastRecent()(from, []) === null);
}

// --- statuses (control/statuses.js) ---
{
  // burn: dt-scaled DoT that expires after its duration
  const e = {};
  statuses.attach(e, statuses.burn({ dps: 10, duration: 1 }));
  check('statuses.burn dot', Math.abs(statuses.step(e, 0.5).damage - 5) < 1e-9);
  statuses.step(e, 0.6); // crosses 1.0s -> expired
  check('statuses.burn expires', e._status.length === 0);

  // slow stacks multiplicatively into speedMul
  const s = {};
  statuses.attach(s, statuses.slow({ mult: 0.5, duration: 5 }));
  statuses.attach(s, statuses.slow({ mult: 0.5, duration: 5 }));
  check('statuses.slow stack', Math.abs(statuses.step(s, 0.1).speedMul - 0.25) < 1e-9);

  // freeze = speedMul 0 + stunned
  const f = {};
  statuses.attach(f, statuses.freeze({ duration: 1 }));
  const fv = statuses.step(f, 0.1);
  check('statuses.freeze locks', fv.speedMul === 0 && fv.stunned === true);

  // poison gains a stack on re-apply (base 1 -> attach +1 -> apply +1 = 3)
  const p = {};
  const venom = statuses.poison({ dps: 4, duration: 5, stacks: 1 });
  statuses.attach(p, venom);
  venom.apply(p);
  check('statuses.poison stacks', Math.abs(statuses.step(p, 1).damage - 12) < 1e-9);

  // stun is a lockout without a speed change
  const st = {};
  statuses.attach(st, statuses.stun({ duration: 0.5 }));
  const sv = statuses.step(st, 0.1);
  check('statuses.stun', sv.stunned === true && sv.speedMul === 1);

  // haste and slow cancel toward 1
  const h = {};
  statuses.attach(h, statuses.haste({ mult: 2, duration: 5 }));
  statuses.attach(h, statuses.slow({ mult: 0.5, duration: 5 }));
  check('statuses.haste cancels slow', Math.abs(statuses.step(h, 0.1).speedMul - 1) < 1e-9);

  // weaken softens outgoing damage via dmgMul
  const w = {};
  statuses.attach(w, statuses.weaken({ mult: 0.5, duration: 3 }));
  check('statuses.weaken dmgMul', Math.abs(statuses.step(w, 0.1).dmgMul - 0.5) < 1e-9);

  // empty entity yields the neutral verdict; expiry compacts survivors
  const z = {};
  const zr = statuses.step(z, 0.1);
  check('statuses.step neutral', zr.damage === 0 && zr.speedMul === 1 && zr.dmgMul === 1 && !zr.stunned);
  const m = {};
  statuses.attach(m, statuses.burn({ dps: 1, duration: 0.05 }));
  statuses.attach(m, statuses.slow({ mult: 0.5, duration: 10 }));
  statuses.step(m, 0.1);
  check('statuses.step compacts', m._status.length === 1 && m._status[0].kind === 'slow');
}

// ---- damage resolution (compose modifiers over raw hp math) ----
{
  const rng0 = { next: () => 0 }, rng9 = { next: () => 0.99 };
  // base passthrough
  { const r = damage.resolve(10, null, {});
    check('damage base passthrough', r.amount === 10 && r.crit === false && r.knockback === null && r.pierce === 1 && r.heal === 0); }
  // crit: rng-gated multiplier, no-op without rng
  { const r = damage.resolve(10, damage.crit({ chance: 0.15, mult: 2 }), { rng: rng0 });
    check('damage crit hits on low roll', r.amount === 20 && r.crit === true && r.tags.includes('crit'));
    check('damage crit misses on high roll', damage.resolve(10, damage.crit({ chance: 0.15 }), { rng: rng9 }).amount === 10);
    check('damage crit no-op without rng', damage.resolve(10, damage.crit(), {}).crit === false); }
  // armor: flat then resist, floored at 0
  { check('damage armor flat+resist', Math.abs(damage.resolve(10, damage.armor({ flat: 2, resist: 0.5 }), {}).amount - 4) < 1e-9);
    check('damage armor floors at 0', damage.resolve(3, damage.armor({ flat: 99 }), {}).amount === 0); }
  // knockback: unit push attacker->target, null when degenerate/missing
  { const r = damage.resolve(5, damage.knockback({ force: 6 }), { from: [0, 0, 0], to: [10, 0, 0] });
    check('damage knockback pushes toward target', Math.abs(r.knockback[0] - 6) < 1e-9 && Math.abs(r.knockback[1]) < 1e-9);
    check('damage knockback reads entity pos', Math.abs(damage.resolve(5, damage.knockback({ force: 2 }), { attacker: { pos: [0, 0, 0] }, target: { pos: [0, 0, 5] } }).knockback[1] - 2) < 1e-9);
    check('damage knockback null when stacked', damage.resolve(5, damage.knockback(), { from: [0, 0, 0], to: [0, 0, 0] }).knockback === null);
    check('damage knockback null without positions', damage.resolve(5, damage.knockback(), {}).knockback === null); }
  // falloff: full inside near, min at far, no-op without positions
  { check('damage falloff full inside near', damage.resolve(10, damage.falloff({ near: 2, far: 12 }), { from: [0, 0, 0], to: [1, 0, 0] }).amount === 10);
    check('damage falloff zero at far', damage.resolve(10, damage.falloff({ near: 2, far: 12, min: 0 }), { from: [0, 0, 0], to: [12, 0, 0] }).amount === 0);
    check('damage falloff halves at midpoint', Math.abs(damage.resolve(10, damage.falloff({ near: 0, far: 10, min: 0 }), { from: [0, 0, 0], to: [5, 0, 0] }).amount - 5) < 1e-9);
    check('damage falloff no-op without positions', damage.resolve(10, damage.falloff({ far: 5 }), {}).amount === 10); }
  // lifesteal reports heal; pierce declares carry-through
  { check('damage lifesteal reports heal', Math.abs(damage.resolve(20, damage.lifesteal({ frac: 0.25 }), {}).heal - 5) < 1e-9);
    check('damage pierce count', damage.resolve(5, damage.pierce({ count: 3 }), {}).pierce === 3);
    check('damage pierce 1 untagged', !damage.resolve(5, damage.pierce({ count: 1 }), {}).tags.includes('pierce')); }
  // compose: folds left-to-right (crit *2 -> armor *0.5 -> lifesteal reads final), flattens + skips falsy
  { const policy = damage.compose(damage.crit({ chance: 1, mult: 2 }), damage.armor({ resist: 0.5 }), damage.lifesteal({ frac: 0.5 }));
    const r = damage.resolve(10, policy, { rng: rng0 });
    check('damage compose order crit->armor->lifesteal', r.amount === 10 && r.crit === true && Math.abs(r.heal - 5) < 1e-9);
    check('damage compose flattens + skips falsy', damage.resolve(10, damage.compose([damage.armor({ flat: 1 })], false, damage.armor({ flat: 1 })), {}).amount === 8);
    check('damage resolve accepts a raw mod array', damage.resolve(10, [damage.armor({ flat: 3 })], {}).amount === 7); }
  check('damage bundle complete', ['resolve', 'compose', 'crit', 'armor', 'knockback', 'falloff', 'lifesteal', 'pierce'].every(k => typeof damage[k] === 'function'));
}


// ===== Round 3 components: abilities / vehicles / formations / pathing / cameraFx =====

// --- abilities: cooldown + duration lifecycle ---
{
  const mkE = () => ({ pos: [0, 0, 0], vel: [0, 0, 0], rot: 0 });

  // dash: burst of velocity + cooldown lockout
  const d = abilities.dash({ distance: 6, cd: 1, dashTime: 0.15 });
  const e1 = mkE();
  check('dash ready initially', d.ready());
  check('dash fires when ready', d.trigger(e1, [0, 1]) === true);
  check('dash sets velocity along dir', e1.vel[2] > 0);
  check('dash locked after fire', !d.ready() && d.trigger(e1, [0, 1]) === false);
  let ds;
  for (let i = 0; i < 25; i++) ds = d.tick(e1, 0.05);
  check('dash recharges after cd', d.ready() && ds.ready && !ds.active);

  // dodgeRoll: opens e.invuln i-frame window
  const r = abilities.dodgeRoll({ distance: 5, iframes: 0.4, cd: 0.8 });
  const e2 = mkE();
  r.trigger(e2, [1, 0]);
  check('roll opens invuln window', e2.invuln > 0.39);
  for (let i = 0; i < 5; i++) r.tick(e2, 0.1);
  check('roll invuln decays away', (e2.invuln || 0) <= 0.0001);

  // blink: instant teleport, no velocity
  const b = abilities.blink({ range: 8, cd: 3 });
  const e3 = mkE();
  b.trigger(e3, [1, 0]);
  check('blink teleports by range', Math.abs(e3.pos[0] - 8) < 1e-6 && e3.vel[0] === 0);

  // shieldAbility: e.shield timer
  const sh = abilities.shieldAbility({ duration: 3, cd: 6 });
  const e4 = mkE();
  sh.trigger(e4);
  check('shield timer set on trigger', e4.shield > 2.9);
  let ss;
  for (let i = 0; i < 35; i++) ss = sh.tick(e4, 0.1);
  check('shield expires', (e4.shield || 0) < 0.0001 && !ss.active);

  // groundPound: shockwave request surfaced exactly once
  const gp = abilities.groundPound({ cd: 2, radius: 5 });
  const e5 = mkE(); e5.pos = [3, 0, 4];
  gp.trigger(e5);
  const gs1 = gp.tick(e5, 0.016);
  check('groundPound emits shockwave once', gs1.shockwave && gs1.shockwave.radius === 5);
  check('shockwave cleared next tick', !gp.tick(e5, 0.016).shockwave);

  // timeSlow: reports a timescale the loop reads
  const ts = abilities.timeSlow({ factor: 0.4, duration: 2, cd: 8 });
  const e6 = mkE();
  ts.trigger(e6);
  check('timeSlow reports factor while active', ts.tick(e6, 0.1).timescale === 0.4);
  let tss;
  for (let i = 0; i < 25; i++) tss = ts.tick(e6, 0.1);
  check('timeSlow returns to 1', tss.timescale === 1 && !tss.active);
}

{
  const ent = () => ({ pos: [0,0,0], vel: [0,0,0], rot: 0 });
  const noI = { move: [0,0], aim: [0,0], jump: false };
  const run = (u, e, input, n = 60, dt = 1/60) => { for (let i=0;i<n;i++){ u(e, input, dt); e.pos[0]+=e.vel[0]*dt; e.pos[1]+=e.vel[1]*dt; e.pos[2]+=e.vel[2]*dt; } };

  check('vehicles bundle complete', ['car','boat','hover','flyer','heavyTank'].every(k => typeof vehicles[k] === 'function'));

  // car: throttle drives +Z, top speed capped, no steer while stopped, drifts when turning
  { const u=vehicles.car({topSpeed:10}); const e=ent(); run(u,e,{move:[0,-1],aim:[0,0]},120);
    check('car drives forward', e.pos[2]>1);
    check('car respects top speed', Math.hypot(e.vel[0],e.vel[2])<=10+1e-6); }
  { const u=vehicles.car(); const e=ent(); u(e,{move:[1,0],aim:[0,0]},1/60); check('car no steer at standstill', Math.abs(e.rot)<1e-9); }
  { const u=vehicles.car({grip:2}); const e=ent(); run(u,e,{move:[1,-1],aim:[0,0]},120); check('car steers under throttle', Math.abs(e.rot)>0.1); }

  // boat: momentum then water drag glides it back down
  { const u=vehicles.boat(); const e=ent(); run(u,e,{move:[0,-1],aim:[0,0]},60); const s0=Math.hypot(e.vel[0],e.vel[2]); check('boat gains momentum',s0>0.5); run(u,e,noI,300); check('boat drags to stop', Math.hypot(e.vel[0],e.vel[2])<s0*0.3); }

  // hover: omni-directional, faces travel
  { const u=vehicles.hover(); const e=ent(); run(u,e,{move:[1,0],aim:[0,0]},30); check('hover thrusts +x', e.pos[0]>0.5 && Math.abs(e.pos[2])<1e-6); check('hover faces travel', Math.abs(e.rot-Math.PI/2)<0.05); }

  // flyer: aim climbs, move[1] thrusts forward, move[0] banks heading
  { const u=vehicles.flyer(); const e=ent(); run(u,e,{move:[0,-1],aim:[0,-1]},30); check('flyer climbs on aim', e.pos[1]>0.5); check('flyer thrusts forward', e.pos[2]>0.5); }
  { const u=vehicles.flyer(); const e=ent(); u(e,{move:[1,0],aim:[0,0]},1/60); check('flyer banks heading', e.rot>0 && e._veh.bank<0); }

  // heavyTank: pivots in place stopped, slow inertial stop
  { const u=vehicles.heavyTank(); const e=ent(); u(e,{move:[1,0],aim:[0,0]},1/60); check('tank pivots in place', e.rot>0); }
  { const u=vehicles.heavyTank(); const e=ent(); run(u,e,{move:[0,-1],aim:[0,0]},60); const s0=Math.hypot(e.vel[0],e.vel[2]); check('tank builds speed',s0>0.3); run(u,e,noI,180); check('tank grinds to stop', Math.hypot(e.vel[0],e.vel[2])<s0*0.3); }

  // node-safe: finite state, ground vehicles keep vel[1]=0
  { for (const k of ['car','boat','hover','heavyTank']){ const e=ent(); const u=vehicles[k](); run(u,e,{move:[0.5,-0.7],aim:[0.3,0.2]},60); check('finite state '+k, Number.isFinite(e.pos[0])&&Number.isFinite(e.rot)); check('grounded '+k, e.vel[1]===0); } }
}

{
  const near = (a, b, e = 1e-6) => Math.abs(a - b) <= e;
  const L = [10, 0, 20];

  // line: centered on leader, symmetric spread, no forward offset
  const ln = formations.line({ gap: 2 });
  const l0 = ln(0, 3, L, 0), l1 = ln(1, 3, L, 0), l2 = ln(2, 3, L, 0);
  check('formations line middle slot on leader', near(l1[0], 10) && near(l1[2], 20));
  check('formations line symmetric flanks', near(l0[0], 8) && near(l2[0], 12));
  check('formations line target y is 0', l0[1] === 0);

  // column: single file straight back at rot=0
  const col = formations.column({ gap: 2 });
  const c0 = col(0, 4, L, 0), c2 = col(2, 4, L, 0);
  check('formations column slot0 one gap back', near(c0[0], 10) && near(c0[2], 18));
  check('formations column deepens', near(c2[2], 14));
  // rotation: facing +x (rot=90deg) => behind is -x
  const cr = col(0, 4, L, Math.PI / 2);
  check('formations column rotates with leader', near(cr[0], 8) && near(cr[2], 20));

  // wedge: alternating flanks, deepening, all behind tip
  const wd = formations.wedge({ gap: 2, angleDeg: 45 });
  const w0 = wd(0, 4, L, 0), w1 = wd(1, 4, L, 0), w3 = wd(3, 4, L, 0);
  check('formations wedge slot0 left of tip', w0[0] < 10);
  check('formations wedge slot1 right of tip', w1[0] > 10);
  check('formations wedge mirrors x', near(w0[0] - 10, -(w1[0] - 10)));
  check('formations wedge behind tip and deepens', w0[2] < 20 && w3[2] < w1[2]);

  // circle: all on ring, slot0 at front
  const ci = formations.circle({ radius: 4 });
  let onRing = true;
  for (let i = 0; i < 4; i++) { const s = ci(i, 4, L, 0); if (!near(Math.hypot(s[0]-10, s[2]-20), 4)) onRing = false; }
  check('formations circle all on ring', onRing);
  const ci0 = ci(0, 4, L, 0);
  check('formations circle slot0 at front', near(ci0[0], 10) && near(ci0[2], 24));

  // grid: centered columns trailing back
  const gr = formations.grid({ cols: 3, gap: 2 });
  const g0 = gr(0, 6, L, 0), g2 = gr(2, 6, L, 0), g3 = gr(3, 6, L, 0);
  check('formations grid row0 centered', near(g0[0], 8) && near(g2[0], 12) && near(g0[2], 20));
  check('formations grid row1 trails back', near(g3[0], 8) && near(g3[2], 18));

  // echelon: diagonal stagger
  const ec = formations.echelon({ gap: 2 });
  const e0 = ec(0, 3, L, 0), e1 = ec(1, 3, L, 0);
  check('formations echelon diagonal', near(e0[0], 12) && near(e0[2], 18));
  check('formations echelon extends diagonally', near(e1[0], 14) && near(e1[2], 16));
}

// --- pathing.js ---
{
  const ent = (x, z) => ({ pos: [x, 0, z], vel: [0, 0, 0], rot: 0 });

  // followPath: drives toward wp0, advances near it, parks at end (no loop)
  const fp = pathing.followPath({ points: [[10, 0], [10, 10]], loop: false, speed: 4 });
  const e1 = ent(0, 0);
  const v1 = fp(e1, 0.1);
  check('followPath drives +x', v1[0] > 3.9 && Math.abs(v1[2]) < 1e-6);
  check('followPath writes vel', e1.vel[0] === v1[0]);
  e1.pos = [10, 0, 0]; const v1b = fp(e1, 0.1);
  check('followPath advances waypoint', v1b[2] > 3.9);
  e1.pos = [10, 0, 10]; fp(e1, 0.1); const v1c = fp(e1, 0.1);
  check('followPath parks at end', v1c[0] === 0 && v1c[2] === 0 && e1._path.done);

  // followPath loop wraps to start
  const fpl = pathing.followPath({ points: [[5, 0], [5, 5]], loop: true, speed: 2 });
  const el = ent(5, 5); fpl(el, 0.1);
  check('followPath loops to 0', el._path.i === 0);

  // pingPong bounces off the far end
  const pp = pathing.pingPong({ points: [[0, 0], [10, 0]], speed: 5 });
  const ep = ent(0, 0); pp(ep, 0.1);
  check('pingPong advances forward', ep._path.dir === 1 && ep._path.i === 1);
  ep.pos = [10, 0, 0]; pp(ep, 0.1);
  check('pingPong reverses at end', ep._path.dir === -1 && ep._path.i === 0);

  // patrolPath halts and waits at each stop
  const pa = pathing.patrolPath({ points: [[3, 0], [3, 6]], wait: 1, speed: 3 });
  const ea = ent(3, 0);
  const va = pa(ea, 0.1);
  check('patrol halts on arrival', va[0] === 0 && va[2] === 0 && ea._path.wait > 0);
  pa(ea, 0.5); check('patrol still waiting', ea._path.wait > 0);
  pa(ea, 0.6); const vam = pa(ea, 0.1);
  check('patrol moves after wait', vam[2] > 2.9);

  // lerpTo eases toward moving goal and settles when close
  const lt = pathing.lerpTo({ speed: 5 });
  const vl = lt(ent(0, 0), [10, 0, 0], 0.1);
  check('lerpTo moves toward goal', vl[0] > 0 && vl[0] < 100);
  const vls = lt(ent(0, 0), [0.01, 0, 0], 0.1);
  check('lerpTo settles near goal', vls[0] === 0 && vls[2] === 0);

  // gridNav: pure greedy planner avoids blocked cells and returns cell centers
  const nav = pathing.gridNav({ cell: 1, passable: (cx, cz) => !(cx === 1 && cz !== 2) });
  const gn = nav.stepToward([0.5, 0, 0.5], [4.5, 0, 0.5]);
  check('gridNav avoids blocked cell', !(Math.floor(gn[0]) === 1 && Math.floor(gn[1]) === 0));
  check('gridNav returns cell center', Math.abs((gn[0] % 1) - 0.5) < 1e-9);
  const navOpen = pathing.gridNav({ cell: 1, passable: () => true });
  check('gridNav arrived returns goal', (() => { const n = navOpen.stepToward([2.5, 0, 2.5], [2.7, 0, 2.4]); return n[0] === 2.5 && n[1] === 2.5; })());
  const navBox = pathing.gridNav({ cell: 1, passable: (cx, cz) => cx === 0 && cz === 0 });
  check('gridNav boxed holds position', (() => { const n = navBox.stepToward([0.5, 0, 0.5], [9, 0, 9]); return n[0] === 0.5 && n[1] === 0.5; })());
}

{
  // fake base camera: eye above/behind focus, target at focus, carries metadata
  const base = (f) => ({ eye: [f[0], 20, f[2] + 10], target: [f[0], 0, f[2]], up: [0, 0, -1], projection: 'ortho', orthoSize: 12 });

  // metadata + array passthrough
  const sm = cameraFx.smooth(base);
  const r = sm([1, 0, 1], {}, 0.016);
  check('cameraFx smooth returns eye/target arrays', Array.isArray(r.eye) && r.eye.length === 3 && Array.isArray(r.target));
  check('cameraFx passes metadata through', r.projection === 'ortho' && r.orthoSize === 12 && r.up[2] === -1);

  // shake: idle == base; trigger offsets deterministically; decays
  const idle = cameraFx.shake(base, { mag: 1 })([0, 0, 0], {}, 0.016);
  check('cameraFx shake idle == base', idle.eye[0] === 0 && idle.eye[2] === 10);
  const c1 = cameraFx.shake(base, { mag: 1, decay: 5 });
  const c2 = cameraFx.shake(base, { mag: 1, decay: 5 });
  c1.trigger(1); c2.trigger(1);
  const a1 = c1([0, 0, 0], {}, 0.016), a2 = c2([0, 0, 0], {}, 0.016);
  check('cameraFx shake offsets eye', a1.eye[0] !== 0 || a1.eye[2] !== 10);
  check('cameraFx shake deterministic', a1.eye[0] === a2.eye[0] && a1.eye[2] === a2.eye[2]);
  const c3 = cameraFx.shake(base, { mag: 1, decay: 100 }); c3.trigger(1); c3([0, 0, 0], {}, 1);
  const rest = c3([0, 0, 0], {}, 0.016);
  check('cameraFx shake decays to rest', rest.eye[0] === 0 && rest.eye[2] === 10);
  const e = { shake: 1 };
  const es = cameraFx.shake(base, { mag: 1 })([0, 0, 0], e, 0.016);
  check('cameraFx shake consumes entity.shake', e.shake === 0 && (es.eye[0] !== 0 || es.eye[2] !== 10));

  // smooth: latch then ease then converge
  const s = cameraFx.smooth(base, { stiffness: 8 });
  check('cameraFx smooth latches frame 1', s([0, 0, 0], {}, 0.016).eye[0] === 0);
  const s1 = s([10, 0, 0], {}, 0.016);
  check('cameraFx smooth eases partway', s1.eye[0] > 0 && s1.eye[0] < 10);
  let last; for (let i = 0; i < 500; i++) last = s([10, 0, 0], {}, 0.016);
  check('cameraFx smooth converges', Math.abs(last.eye[0] - 10) < 0.01);

  // lookAhead: leads by vel*lead
  const la = cameraFx.lookAhead(base, { lead: 2 })([0, 0, 0], { vel: [3, 0, -1] }, 0.016);
  check('cameraFx lookAhead leads target', Math.abs(la.target[0] - 6) < 1e-9 && Math.abs(la.target[2] + 2) < 1e-9);
  check('cameraFx lookAhead no-vel == base', cameraFx.lookAhead(base)([0, 0, 0], {}, 0.016).target[0] === 0);

  // zoom: scales eye distance, clamps, target fixed
  const z = cameraFx.zoom(base, { min: 1, max: 2, on: (en) => en.t });
  check('cameraFx zoom t=0 unchanged', Math.abs(z([0, 0, 0], { t: 0 }, 0.016).eye[2] - 10) < 1e-9);
  const z1 = z([0, 0, 0], { t: 1 }, 0.016);
  check('cameraFx zoom t=1 doubles distance', Math.abs(z1.eye[2] - 20) < 1e-9 && z1.target[2] === 0);
  check('cameraFx zoom clamps t>1', Math.abs(z([0, 0, 0], { t: 5 }, 0.016).eye[2] - 20) < 1e-9);

  // deadzone: ignore within box, follow past edge
  const dz = cameraFx.deadzone(base, { radius: 3 });
  dz([0, 0, 0], {}, 0.016);
  check('cameraFx deadzone ignores small move', dz([2, 0, 0], {}, 0.016).eye[0] === 0);
  check('cameraFx deadzone follows past edge', Math.abs(dz([5, 0, 0], {}, 0.016).eye[0] - 2) < 1e-9);
}


// ===== Round 4 components: tweens / effects / particles / transitions / palettes =====

// ---- tweens (interpolation + easing) ----
{ const ap = (a, b, e = 1e-9) => Math.abs(a - b) <= e;
  check('tweens.lerp number + array', tweens.lerp(0, 10, 0.5) === 5 && JSON.stringify(tweens.lerp([0,0,0],[2,4,6],0.5)) === '[1,2,3]');
  // damp: two half-steps equal one full step (frame-rate independent)
  const d2 = tweens.damp(tweens.damp(0, 10, 5, 0.1), 10, 5, 0.1), d1 = tweens.damp(0, 10, 5, 0.2);
  check('tweens.damp frame-rate independent', ap(d2, d1));
  check('tweens.pingPongT triangle', tweens.pingPongT(0) === 0 && tweens.pingPongT(1) === 1 && tweens.pingPongT(2) === 0 && tweens.pingPongT(1.5) === 0.5);
  // every easing lands cleanly on both endpoints
  let ends = true; for (const k of Object.keys(tweens.ease)) { if (!ap(tweens.ease[k](0), 0) || !ap(tweens.ease[k](1), 1)) ends = false; }
  check('tweens.ease endpoints exact', ends);
  check('tweens.ease overshoot curves exceed 1 mid-flight', tweens.ease.easeOutBack(0.7) > 1 && tweens.ease.easeOutElastic(0.13) > 1);
  check('tweens.ease smoothstep flat at start', tweens.ease.smoothstep(0.001) < 0.001);
  // tween: raw t monotonic 0..1, value lands on `to`, done latches
  const tw = tweens.tween(0, 10, 1, 'linear'); let prev = -1, last;
  for (let i = 0; i < 10; i++) { const s = tw(0.1); if (s.t < prev) prev = NaN; else prev = s.t; last = s.value; }
  check('tween t monotonic to 1, value -> to', ap(prev, 1) && ap(last, 10));
  check('tween done latches past end', tw(0.01).done === true);
  // array tween
  const tv = tweens.tween([0,0,0], [1,0.5,0], 1)(0.5).value;
  check('tween interpolates arrays', ap(tv[0], 0.5) && ap(tv[1], 0.25));
  check('tween zero duration snaps done', (() => { const z = tweens.tween(3, 9, 0)(0); return z.done && z.value === 9; })());
  // sequence: back-to-back, overall t, long-frame spillover, nesting
  const seq = tweens.sequence([tweens.tween(0, 10, 1, 'linear'), tweens.tween(10, 20, 1, 'linear')]);
  seq(0.5); const mid = seq(1.0); const end = seq(0.5);
  check('sequence spills across segments and finishes', ap(mid.value, 15) && ap(mid.t, 0.75) && ap(end.value, 20) && end.done);
  const nest = tweens.sequence([tweens.sequence([tweens.tween(0, 1, 1), tweens.tween(1, 2, 1)]), tweens.tween(2, 3, 1)]);
  check('sequence nests and reports total duration', nest.duration === 3 && ap(nest(2.5).value, 2.5));
  check('empty sequence is instantly done', tweens.sequence([])(1).done === true);
}

{
  // effects: FEEL signal state machines — trigger then step(dt) -> value
  const sh = effects.screenShake({ mag: 1, duration: 0.4, decay: 6 });
  check('effects.screenShake idle zero', sh.step(0.016)[0] === 0 && !sh.active);
  sh.trigger();
  check('effects.screenShake active', sh.active);
  let mx = 0;
  for (let i = 0; i < 30; i++) { const [x, y] = sh.step(0.016); mx = Math.max(mx, Math.abs(x), Math.abs(y)); }
  check('effects.screenShake offset then settles', mx > 0 && !sh.active);
  const A = effects.screenShake({ mag: 1 }); A.trigger();
  const B = effects.screenShake({ mag: 1 }); B.trigger();
  let same = true;
  for (let i = 0; i < 20; i++) { const a = A.step(0.02), b = B.step(0.02); if (a[0] !== b[0] || a[1] !== b[1]) same = false; }
  check('effects.screenShake deterministic', same);

  const hs = effects.hitStop({ duration: 0.06 });
  check('effects.hitStop normal=1', hs.step(0.016) === 1);
  hs.trigger();
  check('effects.hitStop frozen=0', hs.step(0.016) === 0 && hs.active);
  hs.step(0.05);
  check('effects.hitStop resumes', hs.step(0.016) === 1 && !hs.active);

  const fl = effects.flash({ color: [1, 0.8, 0.2], duration: 0.2 });
  check('effects.flash idle 0', fl.step(0.01) === 0);
  fl.trigger();
  check('effects.flash color', fl.color[0] === 1 && fl.color[1] === 0.8);
  const f1 = fl.step(0.05), f2 = fl.step(0.05);
  check('effects.flash fades', f1 > f2 && f1 <= 1 && f2 >= 0);

  const zp = effects.zoomPunch({ amount: 0.15, duration: 0.25 });
  check('effects.zoomPunch idle 1', zp.step(0.016) === 1);
  zp.trigger();
  let pk = 1;
  for (let i = 0; i < 20; i++) pk = Math.max(pk, zp.step(0.016));
  check('effects.zoomPunch spikes in', pk > 1 && pk <= 1.15 + 1e-9);
  check('effects.zoomPunch back to ~1', Math.abs(zp.step(0.016) - 1) < 1e-6 && !zp.active);

  const vp = effects.vignettePulse({ duration: 0.6, peak: 1 });
  check('effects.vignettePulse idle 0', vp.step(0.016) === 0);
  vp.trigger();
  let prev = vp.step(0.1), mono = prev > 0;
  for (let i = 0; i < 30; i++) { const v = vp.step(0.05); if (v > prev + 1e-9) mono = false; prev = v; }
  check('effects.vignettePulse rises then ebbs', mono && !vp.active);
  const vh = effects.vignettePulse({ duration: 0.4, peak: 1, hold: 1 }); vh.trigger();
  check('effects.vignettePulse holds peak', vh.step(0.3) === 1 && vh.step(0.3) === 1);
}

// ---- particles (emitter sim) ----
{ const sys = particles.makeSystem(); const n = sys.emit(particles.burst({ count: 20 }), { pos: [1, 0, 2], rng: makeRng(1) });
  check('particles: burst emits count at pos', n === 20 && sys.count === 20 && sys.particles[0].pos[0] === 1 && sys.particles[0].pos[2] === 2);
  check('particles: particle shape', sys.particles[0].age === 0 && sys.particles[0].life > 0 && sys.particles[0].color.length === 3); }
{ const sys = particles.makeSystem({ gravity: 0 });
  for (let i = 0; i < 10; i++) sys.emit((add) => add({ vel: [0, 0, 0], life: 0.5, drag: 0 }), {});
  check('particles: alive before life', sys.step(0.4) === 10);
  check('particles: dropped past life', sys.step(0.2) === 0 && sys.count === 0); }
{ const sys = particles.makeSystem({ gravity: 0 });
  sys.emit((add) => add({ vel: [2, 0, 0], life: 10, drag: 0 }), { pos: [0, 0, 0] }); sys.step(0.5);
  check('particles: integrates pos=vel*dt', Math.abs(sys.particles[0].pos[0] - 1) < 1e-9); }
{ const sys = particles.makeSystem({ gravity: -10 });
  sys.emit((add) => add({ vel: [0, 0, 0], life: 10, drag: 0 }), {}); sys.step(1);
  check('particles: gravity accelerates down', Math.abs(sys.particles[0].vel[1] + 10) < 1e-9); }
{ const sys = particles.makeSystem(); const f = particles.fountain({ rate: 30 }); let total = 0; const rng = makeRng(7);
  for (let i = 0; i < 10; i++) total += sys.emit(f, { dt: 0.1, rng });
  check('particles: fountain rate ~ rate*time', total === 30); }
{ const a = particles.makeSystem(); const b = particles.makeSystem();
  a.emit(particles.sparks({ count: 8 }), { rng: makeRng(42) }); b.emit(particles.sparks({ count: 8 }), { rng: makeRng(42) });
  check('particles: deterministic given seed', a.particles.every((p, i) => p.vel[1] === b.particles[i].vel[1])); }
{ const sys = particles.makeSystem(); sys.emit(particles.trail({ jitter: 0 }), { pos: [5, 1, 5], dt: 0.016, rng: makeRng(2) });
  check('particles: trail breadcrumb at pos', sys.count === 1 && sys.particles[0].pos[0] === 5 && sys.particles[0].vel[0] === 0); }
{ const sys = particles.makeSystem({ max: 5 });
  check('particles: max caps live count', sys.emit(particles.burst({ count: 50 }), { rng: makeRng(9) }) === 5 && sys.count === 5); }

// ---- transitions (scene/screen progress producers) ----
{ const drain = (step, dt = 0.1, cap = 1000) => { let last = -1, mono = true, r, n = 0;
    do { r = step(dt); if (r.p < last - 1e-9) mono = false; last = r.p; } while (!r.done && ++n < cap);
    return { r, mono }; };
  const f = transitions.fade({ duration: 0.5 });
  check('transitions.fade starts clear', Math.abs(f(0).alpha) < 1e-9);
  { const { r, mono } = drain(f); check('transitions.fade reaches black + monotonic', r.done && Math.abs(r.alpha - 1) < 1e-9 && mono); }
  const fi = transitions.fade({ duration: 0.5, dir: 'in' });
  check('transitions.fade dir=in starts opaque', Math.abs(fi(0).alpha - 1) < 1e-9);
  check('transitions.fade delay holds progress', transitions.fade({ duration: 0.5, delay: 0.3 })(0.2).p === 0);
  check('transitions.wipe passes axis', transitions.wipe({ duration: 0.4, axis: 'y' })(0).axis === 'y');
  { const sl = transitions.slide({ duration: 0.5, from: 'left' });
    check('transitions.slide starts off-screen', Math.abs(sl(0).offset[0] + 1) < 1e-9);
    check('transitions.slide ends centered', drain(sl).r.offset[0] < 1e-9); }
  { const ir = transitions.iris({ duration: 0.5 });
    check('transitions.iris opens 0->1', Math.abs(ir(0).radius) < 1e-9 && Math.abs(drain(ir).r.radius - 1) < 1e-9); }
  check('transitions.iris close starts full', Math.abs(transitions.iris({ duration: 0.5, dir: 'close' })(0).radius - 1) < 1e-9);
  { const c = transitions.crossfade({ duration: 0.5 }); const m = c(0.25);
    check('transitions.crossfade weights sum to 1', Math.abs(m.a + m.b - 1) < 1e-9 && Math.abs(drain(c).r.b - 1) < 1e-9); }
  { const px = transitions.pixelate({ duration: 0.5, max: 64, min: 4 });
    check('transitions.pixelate starts sharp', Math.abs(px(0).amount) < 1e-9);
    const r = drain(px).r; check('transitions.pixelate ends coarse', r.done && Math.abs(r.amount - 1) < 1e-9 && r.blocks === 4); }
  check('transitions.none is an instant cut', transitions.none()(0.016).done);
  { const g = transitions.fade({ duration: 0.3 }); drain(g); g.replay();
    check('transitions replay restarts', g.done === false && Math.abs(g(0).alpha) < 1e-9); }
  { const g = transitions.fade({ duration: 0.3 }); drain(g); g.reverse();
    let r, last = 2, mono = true; do { r = g(0.1); if (r.p > last + 1e-9) mono = false; last = r.p; } while (!r.done);
    check('transitions reverse plays back to start', Math.abs(r.p) < 1e-9 && mono); }
  { let swaps = 0;
    const p = transitions.pair(transitions.fade({ duration: 0.4, dir: 'out' }),
                               transitions.fade({ duration: 0.4, dir: 'in' }), { onSwap: () => swaps++ });
    const seen = []; let r, n = 0; do { r = p(0.1); seen.push(r); } while (!r.done && ++n < 1000);
    let mono = true, last = -1; for (const s of seen) { if (s.p < last - 1e-9) mono = false; last = s.p; }
    check('transitions.pair out->in swaps once', swaps === 1);
    check('transitions.pair blended progress monotonic to done', r.done && Math.abs(r.p - 1) < 1e-9 && mono &&
      seen.some(s => s.phase === 'out') && seen.some(s => s.phase === 'in')); }
  check('transitions bundle complete', typeof transitions.ease.smoothstep === 'function' && transitions.clamp01(2) === 1 && transitions.lerp(0, 10, 0.5) === 5);
}

{
  const near = (a, b, e = 1e-6) => Math.abs(a - b) <= e;
  const col = (c) => Array.isArray(c) && c.length === 3 && c.every(v => v >= 0 && v <= 1);
  for (const [k, p] of Object.entries(palettes.PALETTES)) {
    check('palettes ' + k + ' shape', p.length >= 5 && p.length <= 7 && p.every(col));
  }
  check('palettes palette copy safe', (() => { const p = palettes.palette('lava'); p[0][0] = 9; return palettes.PALETTES.lava[0][0] !== 9; })());
  check('palettes lerpColor mid', palettes.lerpColor([0,0,0],[1,0.5,0.2],0.5).every((v,i)=>near(v,[0.5,0.25,0.1][i])));
  check('palettes lerpColor clamps', palettes.lerpColor([0,0,0],[1,1,1],5).every(v=>v===1));
  check('palettes lighten to white', palettes.lighten([0,0,0],1).every(v=>v===1));
  check('palettes darken to black', palettes.darken([1,1,1],1).every(v=>v===0));
  check('palettes grayscale flat', (()=>{const g=palettes.grayscale([0.2,0.7,0.1]);return near(g[0],g[1])&&near(g[1],g[2]);})());
  check('palettes saturate -1 == gray', (()=>{const g=palettes.saturate([0.2,0.7,0.1],-1),y=palettes.grayscale([0.2,0.7,0.1]);return near(g[0],y[0]);})());
  check('palettes hueShift 360 identity', (()=>{const c=[0.8,0.2,0.3],s=palettes.hueShift(c,360);return near(s[0],c[0])&&near(s[2],c[2]);})());
  check('palettes hueShift red->green', (()=>{const s=palettes.hueShift([1,0,0],120);return s[1]>0.9&&s[0]<0.1;})());
  check('palettes hueShift negative wraps', col(palettes.hueShift([0.3,0.6,0.9],-450)));
  check('palettes damageFlash t0 white', palettes.damageFlash([0.2,0.3,0.4],0).every(v=>near(v,1)));
  check('palettes damageFlash t1 base', palettes.damageFlash([0.2,0.3,0.4],1).every((v,i)=>near(v,[0.2,0.3,0.4][i])));
  check('palettes damageFlash eases down', (()=>{const b=[0.2,0.2,0.2];return palettes.damageFlash(b,0.2)[0] > palettes.damageFlash(b,0.6)[0];})());
  check('palettes teamColor distinct', (()=>{const a=palettes.teamColor(0),b=palettes.teamColor(1);return !(near(a[0],b[0])&&near(a[1],b[1]));})());
  check('palettes teamColor wraps', col(palettes.teamColor(99)) && col(palettes.teamColor(-1)));
  check('palettes gradient endpoints', palettes.gradient('ice',0).every((v,i)=>near(v,palettes.PALETTES.ice[0][i])) && (()=>{const p=palettes.PALETTES.ice,l=p[p.length-1];return palettes.gradient('ice',1).every((v,i)=>near(v,l[i]));})());
  check('palettes gradient node exact', near(palettes.gradient([[0,0,0],[0.5,0.5,0.5],[1,1,1]],0.5)[0], 0.5));
  check('palettes pick index wrap', palettes.pick('lava',-1).every((v,i)=>near(v,palettes.PALETTES.lava[palettes.PALETTES.lava.length-1][i])));
  check('palettes pick rng', palettes.pick('neon',{int:(a,b)=>a}).every((v,i)=>near(v,palettes.PALETTES.neon[0][i])));
  check('palettes toHex clamps', palettes.toHex([2,-1,0.5])==='#ff0080');
  check('palettes fromHex roundtrip', palettes.toHex(palettes.fromHex('#ff8000'))==='#ff8000');
  check('palettes fromHex short+nohash', palettes.fromHex('f00').every((v,i)=>near(v,[1,0,0][i])) && palettes.fromHex('00ff00').every((v,i)=>near(v,[0,1,0][i])));
  check('palettes fromHex bad -> black', palettes.fromHex('xyz123zz').every(v=>v===0));
}


// ===== Round 5 components: fsm / senses / squad / dialogue / utility =====

{
  // fsm: layered idle->alert->attack->flee->search state machine over a fake entity.
  const brain = fsm.makeFsm({
    initial: 'idle',
    states: {
      idle:   { enter: (e) => { e._entered = true; },
                update: fsm.when((e, dt, ctx) => ctx.dist < 10, 'alert') },
      alert:  { update: fsm.after(0.5, 'attack') },
      attack: { update: fsm.any([
                  (e) => { e.acted = (e.acted || 0) + 1; return null; },   // action leg
                  fsm.when((e) => e.hp < 30, 'flee'),
                  fsm.when((e, dt, ctx) => ctx.dist > 15, 'search'),
                ]) },
      flee:   { enter: (e) => { e.fleeing = true; },
                exit:  (e) => { e.fleeing = false; },
                update: fsm.when((e) => e.hp > 60, 'idle') },
      search: { update: fsm.after(1, 'idle') },
    },
  });
  const e = { hp: 100 };

  brain(e, 0.1, { dist: 5 });
  check('fsm lazy initial enter fired', e._entered === true);
  check('fsm idle->alert on proximity', fsm.is(e, 'alert'));
  check('fsm timer resets on enter', fsm.elapsed(e) === 0);

  brain(e, 0.3, { dist: 5 });
  check('fsm alert holds before timer', fsm.is(e, 'alert'));
  brain(e, 0.3, { dist: 5 });                 // 0.6s total in alert
  check('fsm alert->attack after 0.5s', fsm.is(e, 'attack'));

  brain(e, 0.1, { dist: 5 });
  brain(e, 0.1, { dist: 5 });
  check('fsm action leg runs each step', e.acted === 2);
  check('fsm stays in attack while healthy+near', fsm.is(e, 'attack'));

  brain(e, 0.1, { dist: 20 });
  check('fsm attack->search when target flees', fsm.is(e, 'search'));
  brain(e, 0.6, { dist: 20 });
  check('fsm search holds before timer', fsm.is(e, 'search'));
  brain(e, 0.6, { dist: 20 });
  check('fsm search->idle after 1s', fsm.is(e, 'idle'));

  brain(e, 0.1, { dist: 5 });                 // idle->alert
  brain(e, 0.6, { dist: 5 });                 // alert->attack
  e.hp = 10;
  brain(e, 0.1, { dist: 5 });                 // attack->flee (guard fires after action leg)
  check('fsm attack->flee on low hp', fsm.is(e, 'flee'));
  check('fsm flee enter set flag', e.fleeing === true);
  e.hp = 80;
  brain(e, 0.1, { dist: 5 });                 // flee->idle
  check('fsm flee->idle on heal', fsm.is(e, 'idle'));
  check('fsm flee exit cleared flag', e.fleeing === false);

  // one transition per step: huge dt still only steps idle->alert, not through to attack.
  fsm.reset(e);
  check('fsm reset clears state', e._fsm.state === null);
  brain(e, 5.0, { dist: 5 });
  check('fsm one transition per step', fsm.is(e, 'alert'));

  // determinism: identical drive over two entities yields identical state.
  const mk = () => fsm.makeFsm({ initial: 'a', states: { a: fsm.after(1, 'b'), b: fsm.after(1, 'c'), c: {} } });
  const run = (x) => { const b = mk(); b(x, 0.5, {}); b(x, 0.6, {}); b(x, 1.0, {}); return x._fsm.state; };
  const x1 = {}, x2 = {};
  check('fsm deterministic', run(x1) === 'c' && run(x2) === 'c');

  // bare-function state shorthand.
  const b2 = fsm.makeFsm({ initial: 's0', states: { s0: fsm.when(() => true, 's1'), s1: {} } });
  const y = {};
  b2(y, 0, {});
  check('fsm bare-fn state shorthand', y._fsm.state === 's1');
}

{
  const eye = senses.vision({ fov: 90, range: 10 });
  check('senses: sees straight ahead', eye.canSee([0,0,0], 0, [0,0,5]));
  check('senses: out of range', !eye.canSee([0,0,0], 0, [0,0,20]));
  check('senses: behind not seen', !eye.canSee([0,0,0], 0, [0,0,-5]));
  check('senses: off-side outside 90 cone', !eye.canSee([0,0,0], 0, [5,0,0]));
  check('senses: rotated facing +x', senses.vision({fov:90,range:10}).canSee([0,0,0], Math.PI/2, [5,0,0]));
  check('senses: 360 sees behind', senses.vision({fov:360,range:10}).canSee([0,0,0], 0, [0,0,-5]));
  const wall = (x) => x > 2 && x < 3;
  check('senses: LOS blocked by wall', !eye.canSee([0,0,0], Math.PI/2, [5,0,0], wall));
  check('senses: lineOfSight clear no sampler', senses.lineOfSight([0,0,0],[5,0,5]));
  check('senses: lineOfSight blocked', !senses.lineOfSight([0,0,0],[5,0,0], wall, 0.5));
  const ear = senses.hearing({ radius: 8 });
  check('senses: hears close', ear.heard([0,0,0],[0,0,5]));
  check('senses: too far to hear', !ear.heard([0,0,0],[0,0,20]));
  check('senses: loud carries', ear.heard([0,0,0],[0,0,12], 2));
  check('senses: quiet muffled', !ear.heard([0,0,0],[0,0,5], 0.5));
  check('senses: level mid 0.5', Math.abs(ear.level([0,0,0],[0,0,4]) - 0.5) < 1e-9);
  check('senses: proximity in', senses.proximity([0,0,0],[1,0,1],2));
  check('senses: proximity out', !senses.proximity([0,0,0],[3,0,3],2));
  const mem = senses.memory({ forget: 3 });
  const e = { pos: [0,0,0] };
  mem.see(e, [5,0,5], 0.1);
  check('senses: remembers sighting', mem.remembers(e) && mem.lastKnown(e)[0] === 5);
  check('senses: visible flag true', mem.visible(e));
  mem.see(e, null, 1.5);
  check('senses: still remembers mid-decay', mem.remembers(e) && !mem.visible(e));
  check('senses: freshness halved', Math.abs(mem.freshness(e) - 0.5) < 1e-9);
  mem.see(e, null, 2);
  check('senses: forgotten after timeout', !mem.remembers(e) && mem.lastKnown(e) === null);
  mem.see(e, [1,0,2], 0);
  check('senses: re-sight revives', mem.remembers(e) && mem.lastKnown(e)[0] === 1);
  mem.clear(e);
  check('senses: clear wipes', !mem.remembers(e));
}

{
  const ent = (x, z, hp = 10) => ({ kind: 'grunt', pos: [x, 0, z], vel: [0, 0, 0], hp, dead: false });
  // centroid
  const c = squad.centroid([ent(0, 0), ent(4, 0), ent(2, 6)]);
  check('squad.centroid averages living members', Math.abs(c[0] - 2) < 1e-9 && Math.abs(c[2] - 2) < 1e-9);
  check('squad.centroid empty -> origin', squad.centroid([])[0] === 0);
  // focusTarget: lowestHp is unanimous; nearest follows the majority
  const weak = ent(-20, 0, 5), strong = ent(20, 0, 30);
  check('squad.focusTarget lowestHp finishes the weak', squad.focusTarget([ent(0, 0), ent(1, 1)], [strong, weak], 'lowestHp') === weak);
  check('squad.focusTarget null on no candidates', squad.focusTarget([ent(0, 0)], [], 'lowestHp') === null);
  const cluster = [ent(18, 0), ent(19, 1), ent(21, 0), ent(-19, 0)];
  check('squad.focusTarget nearest follows majority', squad.focusTarget(cluster, [strong, weak], 'nearest') === strong);
  // assignRoles: farthest become flankers on opposite sides, pressers get angle 0
  const pk = [ent(1, 0), ent(2, 0), ent(8, 0), ent(9, 0)];
  const rr = squad.assignRoles(pk, { flankers: 0.5, spreadDeg: 60, target: ent(0, 0, 100) });
  check('squad.assignRoles splits 2/2', rr.flankers === 2 && rr.pressers === 2);
  const fl = pk.filter(e => e._squad.role === 'flank');
  check('squad.assignRoles flankers are farthest', fl.every(e => Math.abs(e.pos[0]) >= 8));
  check('squad.assignRoles flanks mirror sides', fl[0]._squad.angle === -fl[1]._squad.angle && fl[0]._squad.angle !== 0);
  check('squad.assignRoles pressers angle 0', pk.filter(e => e._squad.role === 'press').every(e => e._squad.angle === 0));
  // makeSquad update: staggered engage cap + slot stand-off + spacing separation
  const sq = squad.makeSquad({ maxAttackers: 2, engageRange: 2, waitRange: 8, spacing: 3 });
  const gr = [ent(3, 0), ent(0, 3), ent(-3, 0), ent(0, -3), ent(10, 10)];
  gr.forEach(g => sq.join(g));
  const player = ent(0, 0, 40);
  check('squad.update returns focused target', sq.update(gr, player, 0.016) === player);
  const eng = gr.filter(g => g._squad.engage);
  check('squad staggers to maxAttackers', eng.length === 2 && eng.every(g => Math.hypot(g.pos[0], g.pos[2]) < 5));
  check('squad engaged slots stand off at engageRange', eng.every(g => Math.abs(Math.hypot(g._squad.slot[0], g._squad.slot[2]) - 2) < 1e-6));
  check('squad benched slots circle at waitRange', gr.filter(g => !g._squad.engage).every(g => Math.abs(Math.hypot(g._squad.slot[0], g._squad.slot[2]) - 8) < 1e-6));
  const a = ent(0, 0), b = ent(0.5, 0);
  squad.makeSquad({ spacing: 3 }).update([a, b], ent(50, 0), 0.016);
  check('squad spacing pushes stacked bodies apart', a._squad.spacing[0] < 0 && b._squad.spacing[0] > 0);
  const rg = [ent(0, 0), ent(6, 0)];
  check('squad no-target regroups on centroid', squad.makeSquad().update(rg, null, 0.016) === null && Math.abs(rg[0]._squad.slot[0] - 3) < 1e-9 && !rg[0]._squad.engage);
  sq.leave(gr[0]);
  check('squad.leave clears the order', gr[0]._squad === undefined);
}

{
  const { run, set, has, missing, gte, all, inc } = dialogue;
  const tree = {
    start: {
      speaker: 'Elder', text: 'Will you help us?', effect: set('met'),
      choices: [
        { label: 'Yes', next: 'quest', effect: set('accepted') },
        { label: 'No', next: 'refuse' },
        { label: 'Reward', cond: has('doneQuest'), next: 'reward' },
      ],
    },
    quest: { text: 'Bring me 3 herbs.', next: 'start' },
    refuse: { text: 'A pity.' },
    reward: { text: (v) => `Gold: ${v.gold}`, effect: (v) => { v.gold = (v.gold || 0) + 100; } },
  };
  const d = run(tree, { start: 'start', vars: {} });
  check('dialogue: entry effect fired', d.vars.met === true);
  check('dialogue: cond gates hidden choice', d.node().choices.length === 2);
  check('dialogue: not done at branch', d.done() === false);
  check('dialogue: choose runs effect', d.choose(0) === true && d.vars.accepted === true);
  check('dialogue: followed next to linear node', d.id() === 'quest');
  check('dialogue: advance walks linear line', d.advance() === true && d.id() === 'start');
  d.vars.doneQuest = true;
  check('dialogue: choice unlocks on flag', d.node().choices.length === 3);
  check('dialogue: out-of-range choose is no-op', d.choose(9) === false);
  d.choose(2);
  check('dialogue: effect mutated vars', d.vars.gold === 100);
  check('dialogue: dynamic text reads vars', d.node().text === 'Gold: 100');
  check('dialogue: leaf node is an ending', d.done() === true && d.advance() === false);
  const d2 = run(tree, { vars: {} });
  d2.choose(1);
  check('dialogue: reached leaf ending', d2.id() === 'refuse' && d2.done() === true);
  check('dialogue: cond helpers', has('x')({ x: 1 }) && missing('x')({}) && gte('n', 3)({ n: 5 }) && all(has('a'), has('b'))({ a: 1, b: 1 }));
  const v = {}; inc('c', 2)(v); inc('c', 2)(v);
  check('dialogue: inc helper accumulates', v.c === 4);
}

{
  const { makeReasoner, inverse, threshold, bell, expo, combine, linearC, dist } = utility;
  check('utility.linearC clamps', linearC(2) === 1 && linearC(-1) === 0);
  check('utility.inverse', inverse(0) === 1 && inverse(1) === 0);
  check('utility.threshold hard gate', threshold(0.5)(0.4) === 0 && threshold(0.5)(0.6) === 1);
  check('utility.threshold soft midpoint', Math.abs(threshold(0.5, 0.5)(0.5) - 0.5) < 1e-9);
  check('utility.bell peaks at center', bell(0.5, 0.5)(0.5) === 1 && bell(0.5, 0.5)(0) < 0.1);
  check('utility.expo urgency', expo(2)(0.5) > 0.5);
  check('utility.combine mult veto', combine([1, 0.01], 'mult') < 0.02);
  check('utility.combine avg', Math.abs(combine([1, 0], 'avg') - 0.5) < 1e-9);
  check('utility.combine max', combine([0.2, 0.9], 'max') === 0.9);
  check('utility.combine min', combine([0.2, 0.9], 'min') === 0.2);

  const brain = makeReasoner([
    { name: 'flee', score: (e) => inverse(e.hp / e.maxHp) },
    { name: 'attack', considerations: [
        (e) => threshold(0.4)(e.hp / e.maxHp),
        (e) => inverse(dist(e, e.target) / 12),
    ] },
    { name: 'idle', score: () => 0.05 },
  ]);
  const near = { pos: [0, 0, 0] };
  const far = { pos: [0, 0, 30] };
  check('utility low hp -> flee', brain.decide({ hp: 10, maxHp: 100, pos: [0,0,0], target: near }) === 'flee');
  check('utility full+near -> attack', brain.decide({ hp: 100, maxHp: 100, pos: [0,0,0], target: near }) === 'attack');
  check('utility full+far -> idle', brain.decide({ hp: 100, maxHp: 100, pos: [0,0,0], target: far }) === 'idle');

  const e = { hp: 100, maxHp: 100, pos: [0,0,0], target: near };
  check('utility starts attack', brain.decide(e) === 'attack');
  e.hp = 5;
  check('utility flips to flee', brain.decide(e) === 'flee');

  const tie = makeReasoner([{ name: 'a', score: () => 0.5 }, { name: 'b', score: () => 0.5 }]);
  check('utility tie-break by order', tie.decide({}) === 'a');

  let ran = null;
  const acter = makeReasoner([{ name: 'go', score: () => 1, run: (x) => { ran = x.id; } }]);
  acter.act({ id: 7 });
  check('utility.act fires run()', ran === 7);

  const hys = makeReasoner([{ name: 'x', score: () => 0.50 }, { name: 'y', score: () => 0.52 }], { commit: 0.1 });
  const he = {};
  hys.decide(he);
  check('utility commit holds pick', hys.decide(he) === 'y');

  const ent = { hp: 100, maxHp: 100, pos: [0,0,0], target: near };
  const rows = brain.evaluate(ent);
  check('utility.evaluate sorted', rows[0].score >= rows[1].score);
  brain.decide(ent);
  check('utility scratch on e._util', ent._util.action === rows[0].name);
}


// ===== Round 6 components: save / inventory / progression / quests / economy =====

{
  const { makeSave, autosave, memoryStore } = save;
  // roundtrip + list + clear through an in-RAM adapter
  const store = memoryStore();
  const s = makeSave({ store, version: 1 });
  check('save load fallback', s.load('a', { hp: 5 }).hp === 5);
  s.save('a', { hp: 10, name: 'x' });
  check('save roundtrip', s.load('a').hp === 10 && s.load('a').name === 'x');
  check('save has', s.has('a') === true);
  s.save('b', { hp: 1 });
  check('save list', s.list().length === 2 && s.list().includes('b'));
  s.clear('a');
  check('save clear', s.has('a') === false && s.list().length === 1);
  // serialized, not referenced
  const src = { arr: [1, 2] }; s.save('c', src); src.arr.push(3);
  check('save deep copy', s.load('c').arr.length === 2);
  // version migration v1 -> v2
  const store2 = memoryStore();
  makeSave({ store: store2, version: 1 }).save('slot', { gold: 100 });
  const v2 = makeSave({ store: store2, version: 2, migrate: (old, from) => (from < 2 ? { coins: old.gold } : old) });
  check('save migrate', v2.load('slot').coins === 100);
  check('save meta stale', v2.meta('slot').stale === true);
  // corrupt json -> fallback
  store2.set('save:bad', '{nope');
  check('save corrupt fallback', v2.load('bad', 'FB') === 'FB');
  // autosave on interval
  let st = { tick: 0 };
  const as = makeSave({ store: memoryStore(), version: 1 });
  const step = autosave(() => ({ ...st }), { save: as, slot: 'auto', everyMs: 1000 });
  check('autosave waits', step(0.5) === false && as.has('auto') === false);
  st.tick = 1;
  check('autosave fires', step(0.6) === true && as.load('auto').tick === 1);
  st.tick = 2; step.flush();
  check('autosave flush', as.load('auto').tick === 2);
}

// ---- inventory (slots + stacking, equipment) ----
{ const bag = inventory.makeInventory({ slots: 3, stackSize: 10 });
  check('inv: add fits -> 0 leftover', bag.add('potion', 5) === 0 && bag.count('potion') === 5);
  check('inv: add past stack -> new slot', bag.add('potion', 8) === 0 && bag.count('potion') === 13 && bag.slotsUsed === 2);
  check('inv: first slot capped', bag.items()[0].qty === 10 && bag.items()[1].qty === 3); }
{ const bag = inventory.makeInventory({ slots: 2, stackSize: 10 });
  check('inv: overflow leftover', bag.add('ore', 25) === 5 && bag.count('ore') === 20 && bag.free === 0); }
{ const bag = inventory.makeInventory({ slots: 5, stackSize: 99, catalog: { sword: { stack: 1 } } });
  bag.add('sword', 3);
  check('inv: catalog per-item stack', bag.slotsUsed === 3 && bag.count('sword') === 3); }
{ const bag = inventory.makeInventory({ slots: 3, stackSize: 10 });
  bag.add('gem', 15);
  check('inv: remove returns removed', bag.remove('gem', 12) === 12 && bag.count('gem') === 3);
  check('inv: remove clamps', bag.remove('gem', 99) === 3 && !bag.has('gem')); }
{ const bag = inventory.makeInventory({ slots: 4, stackSize: 10 });
  bag.add('a', 6); bag.add('b', 4);
  check('inv: move into empty', bag.move(0, 3) && bag.items()[3].id === 'a' && bag.items()[0] === null);
  check('inv: move swaps different', bag.move(1, 3) && bag.items()[1].id === 'a' && bag.items()[3].id === 'b');
  const b4 = inventory.makeInventory({ slots: 2, stackSize: 10 });
  b4.add('y', 10); b4.add('y', 5);
  check('inv: partial merge leaves overflow', b4.move(0, 1) && b4.items()[1].qty === 10 && b4.items()[0].qty === 5); }
{ const gear = inventory.makeEquipment({ slots: ['weapon', 'armor', 'trinket'] });
  check('equip: empty slot returns null', gear.equip({ id: 'sword', slot: 'weapon', stats: { atk: 5 } }) === null);
  gear.equip({ id: 'mail', slot: 'armor', stats: { def: 3, atk: 1 } });
  check('equip: stats summed', gear.stats().atk === 6 && gear.stats().def === 3);
  const old = gear.equip({ id: 'axe', slot: 'weapon', stats: { atk: 9 } });
  check('equip: swap returns old + resums', old.id === 'sword' && gear.stats().atk === 10);
  check('equip: unequip drops stats', gear.unequip('armor').id === 'mail' && gear.get('armor') === null && gear.stats().def === undefined);
  check('equip: invalid slot no-op', gear.equip({ id: 'ring', slot: 'nope' }) === null); }

{
  // --- levels: single + multi-level overflow ---
  const L = progression.makeLevels({ curve: progression.linearCurve(100), max: 10 });
  check('prog: start lvl1 xpToNext100', L.level === 1 && L.xpToNext === 100);
  const r1 = L.add(100);
  check('prog: level up to 2', L.level === 2 && r1.gained === 1 && r1.leveledUp && L.xp === 0);
  const M = progression.makeLevels({ curve: progression.linearCurve(100), max: 10 });
  const r2 = M.add(350); // lvl1=100 + lvl2=200 = 300 -> lvl3, 50 banked
  check('prog: multi-level overflow', M.level === 3 && r2.gained === 2 && M.xp === 50);
  check('prog: progress fraction', Math.abs(M.progress - 50 / 300) < 1e-9);

  // --- curves ---
  const E = progression.makeLevels({ curve: progression.expCurve(100, 1.5), max: 5 });
  check('prog: exp lvl1 needs 100', E.needed === 100);
  E.add(100);
  check('prog: exp lvl2 needs 150', E.needed === 150);
  const T = progression.makeLevels({ curve: progression.table([50, 60]), max: 3 });
  T.add(1000);
  check('prog: table capped at max, no overflow', T.level === 3 && T.maxed && T.xp === 0 && T.progress === 1);
  const A = progression.makeLevels({ curve: [30, 40, 50], max: 9 });
  A.add(30);
  check('prog: array curve = table', A.level === 2);

  // --- skill tree: gate on prereq + points ---
  const tree = progression.makeSkillTree(
    [{ id: 'a', cost: 1 }, { id: 'b', cost: 2, requires: ['a'] }, { id: 'c', cost: 1, requires: ['b'] }],
    { points: 3 });
  check('prog: gated unlock blocked', tree.unlock('b') === false && tree.available().join() === 'a');
  check('prog: unlock a debits points', tree.unlock('a') === true && tree.points === 2);
  check('prog: b now reachable', tree.unlock('b') === true && tree.canUnlock('c') === false);
  tree.grant(1);
  check('prog: c unlockable after grant', tree.unlock('c') === true && tree.spent === 4);
  const pts = tree.points;
  tree.respec();
  check('prog: respec refunds + clears', tree.unlockedList().length === 0 && tree.points === pts + 4);

  // --- prestige ---
  const PL = progression.makeLevels({ curve: progression.linearCurve(10), max: 2 });
  const P = progression.prestige({ levels: PL, reward: (t) => t * 5 });
  check('prog: prestige not ready pre-max', P.ready() === false);
  PL.add(10);
  const gain = P.do();
  check('prog: prestige banks + resets', gain === 5 && P.points === 5 && P.tier === 1 && PL.level === 1);
}

// --- quests: objective ticking, completion, reward gating -------------------
{
  const { makeQuestLog, makeQuest, counterObjective, flagObjective } = quests;

  let completedId = null;
  const grants = [];
  const log = makeQuestLog({ onComplete: (q) => { completedId = q.id; }, grant: (r) => grants.push(r) });
  const hunt = makeQuest('hunt', [
    counterObjective('wolves', 'enemy-died', 3, { match: (d) => d && d.kind === 'wolf' }),
    flagObjective('cave', 'zone-entered'),
  ], { reward: { gold: 100 } });

  check('quests: start returns a view', log.start(hunt).id === 'hunt');
  check('quests: quest is active', log.active().length === 1);

  log.progress('enemy-died', 1, { kind: 'rat' });          // wrong kind, match filters it out
  check('quests: match filters event data', log.get('hunt').objectives[0].count === 0);
  log.progress('enemy-died', 9, { kind: 'wolf' });          // clamps to need
  check('quests: counter clamps to need', log.get('hunt').objectives[0].count === 3);
  check('quests: not complete until all required done', log.completed('hunt') === false);

  const finishedNow = log.progress('zone-entered');
  check('quests: flag objective completes quest', log.completed('hunt') === true);
  check('quests: progress returns completed ids', finishedNow.length === 1 && finishedNow[0] === 'hunt');
  check('quests: onComplete fired', completedId === 'hunt');

  check('quests: turnIn gated to complete', log.canTurnIn('hunt') === true);
  const reward = log.turnIn('hunt');
  check('quests: reward dispensed', reward && reward.gold === 100);
  check('quests: grant adapter received reward', grants.length === 1 && grants[0].gold === 100);
  check('quests: cannot turn in twice', log.turnIn('hunt') === null);

  // requires gating + optional/hidden objectives + persistence
  const log2 = makeQuestLog();
  const seq = makeQuest('sequel', [flagObjective('boss', 'boss-died')], { requires: 'hunt' });
  check('quests: requires blocks start when prereq unmet', log2.start(seq) === null);

  const log3 = makeQuestLog();
  log3.start(makeQuest('explore', [
    flagObjective('main', 'flag-main'),
    flagObjective('secret', 'flag-secret', { hidden: true, optional: true }),
  ]));
  check('quests: hidden objective hidden until revealed', log3.get('explore', false).objectives.length === 1);
  log3.progress('flag-main');
  check('quests: optional objective does not gate completion', log3.completed('explore') === true);

  const snap = JSON.parse(JSON.stringify(log3.snapshot()));
  const restored = makeQuestLog().restore(snap, { explore: makeQuest('explore', [flagObjective('main', 'flag-main')]) });
  check('quests: snapshot/restore keeps completion state', restored.completed('explore') === true);
}

{
  // --- economy: wallet / shop / crafting / pricing (self-contained fakes) ---
  const w = economy.makeWallet({ start: 100 });
  check('economy wallet start', w.balance === 100);
  w.earn(50);
  check('economy wallet earn', w.balance === 150);
  check('economy canAfford', w.canAfford(150) && !w.canAfford(151));
  check('economy spend ok', w.spend(150) === true && w.balance === 0);
  check('economy spend broke no-change', w.spend(1) === false && w.balance === 0);

  // injected signal-like store
  let sv = 10; const store = { get: () => sv, set: (v) => (sv = v) };
  const w2 = economy.makeWallet({ store });
  w2.earn(5);
  check('economy wallet store', sv === 15 && w2.balance === 15);

  // shop over a plain object-map inventory
  const bag = { potion: 0 };
  const shop = economy.makeShop({ stock: [{ id: 'potion', price: 20, qty: 2 }, { id: 'gem', price: 100 }], sellMul: 0.5 });
  check('economy shop price', shop.price('potion') === 20);
  const rich = economy.makeWallet({ start: 45 });
  const b1 = shop.buy('potion', rich, bag);
  check('economy buy item', b1 && b1.id === 'potion' && b1.price === 20);
  check('economy buy debits+stocks', rich.balance === 25 && bag.potion === 1 && shop.stockOf('potion') === 1);
  shop.buy('potion', rich, bag);
  check('economy buy sold out null', shop.buy('potion', rich, bag) === null && rich.balance === 5);
  check('economy unlimited stock', shop.inStock('gem'));
  const bal = rich.balance;
  const s1 = shop.sell('potion', rich, bag);
  check('economy sell credits', s1 && s1.price === 10 && rich.balance === bal + 10);
  check('economy sell pulls+returns', bag.potion === 1 && shop.stockOf('potion') === 1);
  check('economy sell nothing null', shop.sell('nope', rich, bag) === null);
  shop.restock();
  check('economy restock', shop.stockOf('potion') === 2);

  // crafting
  const bench = economy.makeCrafting([{ id: 'elixir', in: [{ id: 'herb', qty: 2 }, { id: 'water', qty: 1 }] }]);
  const cbag = { herb: 3, water: 1 };
  check('economy canCraft', bench.canCraft('elixir', cbag));
  const made = bench.craft('elixir', cbag);
  check('economy craft yields', made && made.id === 'elixir' && cbag.elixir === 1);
  check('economy craft consumes', cbag.herb === 1 && (cbag.water | 0) === 0);
  check('economy craft short null', !bench.canCraft('elixir', cbag) && bench.craft('elixir', cbag) === null && cbag.herb === 1);

  // dynamic pricing
  check('economy priceCurve neutral', economy.priceCurve(100, { demand: 0 }) === 100);
  check('economy priceCurve shortage', economy.priceCurve(100, { demand: 1, elasticity: 0.5 }) === 150);
  check('economy priceCurve glut', economy.priceCurve(100, { demand: -1, elasticity: 0.5 }) === 50);
}


// ===== Round 7 components: gestures / hudkit / menus / touchlayout / tutorial =====

// gestures — touch gesture recognition (headless, deterministic)
{
  const only = (evs, type) => evs.filter(e => e.type === type);

  // tap
  let g = gestures.makeRecognizer();
  g.down(1, 100, 100, 0); g.up(1, 80);
  let e = g.poll();
  check('gestures tap', only(e, 'tap').length === 1 && e[0].x === 100 && e[0].y === 100);

  // doubleTap inside window, then two slow taps outside it
  g = gestures.makeRecognizer();
  g.down(1, 50, 50, 0); g.up(1, 40);
  g.down(1, 52, 51, 100); g.up(1, 140);
  e = g.poll();
  check('gestures doubleTap', e[0].type === 'tap' && only(e, 'doubleTap').length === 1 && only(e, 'tap').length === 1);
  g = gestures.makeRecognizer();
  g.down(1, 50, 50, 0); g.up(1, 40);
  g.down(1, 50, 50, 500); g.up(1, 540);
  check('gestures two slow taps', only(g.poll(), 'tap').length === 2);

  // longPress fires only once the clock (poll t) passes holdMs, and suppresses the tap
  g = gestures.makeRecognizer();
  g.down(1, 200, 200, 0);
  check('gestures no early longpress', g.poll(300).length === 0);
  e = g.poll(450);
  check('gestures longPress', only(e, 'longPress').length === 1 && e[0].x === 200);
  g.up(1, 500);
  check('gestures longpress eats tap', only(g.poll(), 'tap').length === 0);

  // live drag emits cumulative dx/dy per move
  g = gestures.makeRecognizer();
  g.down(1, 0, 0, 0); g.move(1, 5, 3, 16); g.move(1, 20, 10, 32);
  const d = only(g.poll(), 'drag');
  check('gestures drag live', d.length === 2 && d[1].dx === 20 && d[1].dy === 10);

  // swipe (moderate) vs flick (fast)
  g = gestures.makeRecognizer();
  g.down(1, 0, 100, 0); g.move(1, 60, 100, 100); g.up(1, 100);
  let s = only(g.poll(), 'swipe');
  check('gestures swipe right', s.length === 1 && s[0].dir === 'right');
  g = gestures.makeRecognizer();
  g.down(1, 100, 100, 0); g.move(1, 100, 200, 40); g.up(1, 40);
  const f = only(g.poll(), 'flick');
  check('gestures flick down', f.length === 1 && f[0].dir === 'down');
  g = gestures.makeRecognizer();
  g.down(1, 0, 0, 0); g.move(1, 30, 0, 900); g.up(1, 1000);
  check('gestures slow drag no swipe', only(g.poll(), 'swipe').length === 0 && only(g.poll(), 'flick').length === 0);

  // two-finger pinch scale + rotate angle, and no taps from multitouch
  g = gestures.makeRecognizer();
  g.down(1, 0, 0, 0); g.down(2, 10, 0, 0); g.move(2, 20, 0, 16);
  e = g.poll();
  const p = only(e, 'pinch'), r = only(e, 'rotate');
  check('gestures pinch scale', p.length === 1 && Math.abs(p[0].scale - 2) < 1e-9 && p[0].center[0] === 10);
  check('gestures rotate ~0', r.length === 1 && Math.abs(r[0].angle) < 1e-9);
  g = gestures.makeRecognizer();
  g.down(1, 0, 0, 0); g.down(2, 10, 0, 0); g.move(2, 0, 10, 16);
  check('gestures rotate quarter turn', Math.abs(only(g.poll(), 'rotate')[0].angle - Math.PI / 2) < 1e-9);
  g = gestures.makeRecognizer();
  g.down(1, 0, 0, 0); g.down(2, 100, 0, 0); g.up(1, 50); g.up(2, 60);
  check('gestures multitouch no tap', only(g.poll(), 'tap').length === 0);

  // active count + reset
  g = gestures.makeRecognizer();
  g.down(1, 0, 0, 0); g.down(2, 5, 5, 0);
  check('gestures active', g.active() === 2);
  g.reset();
  check('gestures reset', g.active() === 0 && g.poll().length === 0);
}

{
  // hudkit — HUD widget state/geometry
  const near = (a, b, e = 1e-6) => Math.abs(a - b) < e;

  // bar eases display toward the true value (juicy drain)
  const hp = hudkit.bar({ max: 100, smooth: 6 });
  hp.set(40);
  check('hudkit bar value snaps', hp.value === 40);
  check('hudkit bar display lags', hp.display === 100 && hp.draining);
  for (let i = 0; i < 300; i++) hp.step(0.05);
  check('hudkit bar settles at target', near(hp.display, 40, 1e-3));
  check('hudkit bar pct 0..1', near(hp.pct, 0.4, 1e-3));

  // radialCooldown: spend + refill ring
  const cd = hudkit.radialCooldown({ duration: 2 });
  check('hudkit cd ready', cd.ready && near(cd.fraction, 1));
  check('hudkit cd fires', cd.trigger() === true && !cd.ready);
  check('hudkit cd blocks refire', cd.trigger() === false);
  cd.step(1); check('hudkit cd half full', near(cd.fraction, 0.5));
  cd.step(1.1); check('hudkit cd recharged', cd.ready);

  // toastQueue caps + ages out
  const tq = hudkit.toastQueue({ max: 3, life: 2 });
  tq.push('a'); tq.push('b'); tq.push('c'); tq.push('d');
  check('hudkit toast capped', tq.count === 3 && tq.items()[0].msg === 'b');
  tq.step(2.1);
  check('hudkit toast expired', tq.count === 0);

  // comboCounter resets after window
  const cc = hudkit.comboCounter({ window: 2 });
  cc.hit(); cc.hit();
  check('hudkit combo counts', cc.count === 2);
  cc.step(1); check('hudkit combo holds', cc.count === 2 && !cc.broken);
  cc.step(1.1); check('hudkit combo breaks', cc.count === 0 && cc.broken && cc.best === 2);

  // minimap projects + clamps offscreen blips to the edge
  const mm = hudkit.minimap({ worldSize: 100, mapSize: 200 });
  const ctr = mm.project([0, 0, 0]);
  check('hudkit minimap centers', near(ctr[0], 100) && near(ctr[1], 100));
  const cl = mm.clampToEdge(mm.project([500, 0, 0]));
  check('hudkit minimap clamps to edge', near(cl[0], 200) && cl[1] >= 0 && cl[1] <= 200);
  check('hudkit minimap blip flags off', mm.blip([500, 0, 0]).off === true);

  // timer prints mm:ss and latches done
  const t = hudkit.timer({ from: 90, dir: 'down' });
  check('hudkit timer label', t.label === '01:30');
  t.step(200);
  check('hudkit timer done at 0', t.seconds === 0 && t.done && t.label === '00:00');
}

{ const m = menus.makeMenu([
    { id: 'play', label: 'Play', type: 'button' },
    { id: 'sound', label: 'Sound', type: 'toggle', value: true },
    { id: 'vol', label: 'Volume', type: 'slider', value: 0.5, min: 0, max: 1, step: 0.1 },
    { id: 'diff', label: 'Difficulty', type: 'choice', options: ['easy','normal','hard'], value: 'normal' },
  ]);
  check('menus: cursor starts 0 + button activate returns id', m.cursor === 0 && m.activate() === 'play');
  m.move(-1); check('menus: move up wraps to last', m.cursor === 3);
  m.move(1);  check('menus: move down wraps to 0', m.cursor === 0);
  m.move(1);  m.adjust(1);
  check('menus: toggle flips', m.value('sound') === false);
  check('menus: activate toggle flips back + returns id', m.activate() === 'sound' && m.value('sound') === true);
  m.move(1);  // slider
  m.adjust(1); check('menus: slider steps', Math.abs(m.value() - 0.6) < 1e-9);
  for (let i = 0; i < 10; i++) m.adjust(1);
  check('menus: slider clamps to max', m.value() === 1);
  for (let i = 0; i < 30; i++) m.adjust(-1);
  check('menus: slider clamps to min + no confirm', m.value() === 0 && m.activate() === null);
  m.move(1);  // choice
  check('menus: choice resolves label', m.value() === 'normal');
  m.adjust(1); m.adjust(1);
  check('menus: choice cycles + wraps', m.value() === 'easy');
  const vals = m.values();
  check('menus: values snapshot omits buttons', !('play' in vals) && vals.diff === 'easy' && vals.sound === true);
  const m2 = menus.makeMenu([
    { id: 'a', type: 'button' }, { id: 'b', type: 'button', disabled: true }, { id: 'c', type: 'button' },
  ]);
  m2.move(1); check('menus: move skips disabled row', m2.cursor === 2);
  m2.setDisabled('c', true); check('menus: disabling focused moves off it', m2.cursor === 0);
  const s = menus.makeScreens('title');
  s.push('settings'); s.push('audio');
  check('menus: stack push deepens', s.depth === 3 && s.top() === 'audio');
  check('menus: pop returns revealed screen', s.pop() === 'settings' && s.depth === 2);
  s.replace('video'); check('menus: replace swaps in place', s.top() === 'video' && s.depth === 2);
  s.pop(); check('menus: pop refuses to empty root', s.pop() === 'title' && s.depth === 1);
  s.reset('menu'); check('menus: reset clears stack', s.depth === 1 && s.top() === 'menu'); }

{
  const { layout, thumbZone, inZone, place, floatingStick, safeRect } = touchlayout;
  const inSafe = (p, s) => p.x >= s.left && p.x <= s.right && p.y >= s.top && p.y <= s.bottom;
  for (const [w, h, tag] of [[390, 844, 'portrait'], [844, 390, 'landscape']]) {
    for (const hand of ['right', 'left']) {
      const insets = { top: 47, bottom: 34, left: 0, right: 0 };
      const L = layout({ w, h, insets, hand });
      const s = L.safe, j = L.joystick;
      check(tag + ' ' + hand + ' stick in safe', inSafe({ x: j.cx - j.radius, y: j.cy - j.radius }, s) && inSafe({ x: j.cx + j.radius, y: j.cy + j.radius }, s));
      check(tag + ' ' + hand + ' stick in thumb zone', inZone(j, L.zone, j.radius));
      check(tag + ' ' + hand + ' stick on outer side', hand === 'right' ? j.cx > w / 2 : j.cx < w / 2);
      for (const b of L.buttons) {
        check(tag + ' ' + hand + ' btn ' + b.id + ' in safe', inSafe({ x: b.cx, y: b.cy }, s));
        check(tag + ' ' + hand + ' btn ' + b.id + ' in zone', inZone(b, L.zone, b.r));
      }
      const cx = L.buttons.reduce((a, b) => a + b.cx, 0) / L.buttons.length;
      check(tag + ' ' + hand + ' actions bottom-inner of stick', hand === 'right' ? cx < j.cx : cx > j.cx);
      check(tag + ' topCenter dodges notch', L.anchor('topCenter').y >= insets.top);
      const bb = L.anchor('bottomBar');
      check(tag + ' bottomBar clears home bar', bb.y + bb.h <= h - insets.bottom);
      check(tag + ' unknown anchor falls back to center', L.anchor('nope') === L.anchor('center'));
    }
  }
  const g = place(4, { grid: true, cols: 2, center: [100, 100], r: 20, gap: 50 });
  check('place grid count + centering', g.length === 4 && Math.abs((g.reduce((a, b) => a + b.cx, 0) / 4) - 100) < 1e-9);
  const f = place(3, { center: [0, 0], spreadDeg: 90, radius: 100 });
  check('place fan symmetric', f.length === 3 && Math.abs(f[0].cx + f[2].cx) < 1e-9);
  const z = thumbZone(390, 844, 'right', { insets: { bottom: 34 } });
  check('place single on arc stays in zone', inZone(place(1, { zone: z, r: 30 })[0], z, 30));
  check('inZone rejects the far corner', !inZone({ x: 5, y: 5 }, z));
  const sr = safeRect(390, 844, { bottom: 34, top: 47 });
  const fs = floatingStick({ x: 5, y: 840 }, { w: 390, h: 844, radius: 56, insets: { bottom: 34, top: 47 } });
  check('floatingStick clamps into safe area', fs.cx - fs.radius >= sr.left - 1e-9 && fs.cy + fs.radius <= sr.bottom + 1e-9);
  const fs2 = floatingStick({ x: 200, y: 400 }, { w: 390, h: 844, radius: 56 });
  check('floatingStick honors a free touch', fs2.cx === 200 && fs2.cy === 400);
}

{
  const { makeTutorial } = tutorial;
  // event-driven progression + input gating
  const t = makeTutorial([
    { id: 'move', text: 'Drag to move', target: 'stick', advanceOn: 'player-moved', gate: ['move'] },
    { id: 'shoot', text: 'Tap to fire', advanceOn: 'player-fired', gate: true },
    { id: 'clear', until: (s) => s.enemies === 0 },
  ]);
  check('tutorial: starts at first step', t.current().id === 'move' && t.current().first);
  check('tutorial: gate whitelist allows taught input', t.blocks('move') === false);
  check('tutorial: gate whitelist blocks others', t.blocks('fire') === true && t.gating() === true);
  check('tutorial: wrong event is a no-op', t.notify('player-fired') === false && t.current().id === 'move');
  check('tutorial: right event advances', t.notify('player-moved') === true && t.current().id === 'shoot');
  check('tutorial: progress 1/3', Math.abs(t.progress - 1 / 3) < 1e-9);
  check('tutorial: gate true blocks all', t.blocks('anything') === true);
  check('tutorial: advance to until step', t.notify('player-fired') && t.current().id === 'clear');
  check('tutorial: until false holds', t.step(0.1, { enemies: 2 }).id === 'clear');
  check('tutorial: until true finishes', t.step(0.1, { enemies: 0 }) === null && t.done());
  check('tutorial: current null when done', t.current() === null && t.progress === 1);

  // persistence via injected flag (signal-like)
  let stored = false;
  const flag = { get: () => stored, set: (v) => { stored = v; } };
  const t2 = makeTutorial([{ id: 'a', advanceOn: 'go' }], { flag });
  t2.notify('go');
  check('tutorial: flag set once on finish', stored === true && t2.done());
  const t3 = makeTutorial([{ id: 'a', advanceOn: 'go' }], { flag });
  check('tutorial: already-done from flag', t3.done() === true && t3.current() === null);

  // optional step drops itself when its condition already holds
  const t4 = makeTutorial([
    { id: 'intro', advanceOn: 'ok' },
    { id: 'dashTip', optional: true, skipIf: (s) => s.dashed, advanceOn: 'dash-evt' },
    { id: 'end' },
  ]);
  t4.notify('ok');
  t4.step(0.016, { dashed: true });
  check('tutorial: optional step skipped when satisfied', t4.current().id === 'end');

  // skip / finish / restart / empty
  const t5 = makeTutorial([{ id: 'a', advanceOn: 'x' }, { id: 'b' }]);
  check('tutorial: skip advances', t5.skip() && t5.current().id === 'b');
  check('tutorial: finish ends', t5.finish() && t5.done());
  t5.restart();
  check('tutorial: restart returns to start', !t5.done() && t5.current().id === 'a');
  check('tutorial: empty tutorial is done', makeTutorial([]).done() === true);
}

console.log('\nENGINE: ALL ' + pass + ' CHECKS PASSED');
