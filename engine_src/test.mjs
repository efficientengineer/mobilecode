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

console.log('\nENGINE: ALL ' + pass + ' CHECKS PASSED');
