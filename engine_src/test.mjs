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

console.log('\nENGINE: ALL ' + pass + ' CHECKS PASSED');
