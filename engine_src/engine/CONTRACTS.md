# Engine contracts — the whole interface

This is the only engine file you normally need to read. The engine is a black
box; you build a game by writing `game/` (glue), not by editing `engine/`.

## The verbs (import from engine/core)
- `signal(v)` → `{ get(), set(v), update(fn), subscribe(fn) }` — one reactive value.
- `makeRegistry()` → `{ add(e), remove(e), each(fn), query(pred), has(e), size, flush(), clear() }` — a set of entities; add/remove are deferred (safe to mutate while iterating).
- `on(name, fn)` / `off(name, fn)` / `emit(name, data)` — the event bus. `on` returns an unsubscribe fn.
- `spawn(kind, opts)` / `spawnInto(reg, kind, opts)` / `despawn(e)` — entities. `despawn` removes from the scene AND the entity's registry.
- `makeRng(seed)` → `{ next(), range(a,b), int(a,b) }` — deterministic RNG.
- `makeLoop({ paused, registries })` → `{ start(), stop(), step(dt) }` — the frame driver.

## Entity fields
`{ kind, pos:[x,y,z], rot, scale (number or [x,y,z]), vel:[x,y,z], color:[r,g,b] (0..1), mesh, radius, dead, ...your fields }`.
`mesh` is one of: `box | sphere | cylinder | plane`. `spawn(opts.at)` sets pos.

## Phases (emitted by the loop each frame, in order)
`input → update(dt) → physics → late` (the sim; skipped when paused) then `render(dt)` (always).
Continuous state → **signals** (input sticks). Discrete happenings → **events**.

## Signals the systems expect (define these in game/contracts.js)
`gameState` (menu|playing|paused|over) · `score` · `wave` · `playerHealth` · `moveInput` [x,z] · `aimInput` [x,z] · `firing` · `player` (the entity).

## Registries the systems expect
`enemies` · `bullets`.

## Events (the vocabulary)
Raised by systems: `game-started` · `game-over` · `player-fired` · `enemy-hit {enemy,bullet}` · `enemy-died {enemy}` · `player-hit {enemy}` · `player-damaged {hp}` · `player-died` · `wave-started {n}` · `wave-cleared {n}`.

## Systems (engine/systems/*, each imports only core)
`input` (touch→sticks) · `movement` (input+velocity→position) · `ai` (runs each enemy/NPC's behavior) · `fire` (spawn bullets) · `spawn` (wave director) · `collision` (overlap→events) · `health` (hits→damage/death) · `score` · `cleanup` (life/bounds despawn) · `gamestate` (lifecycle+pause) · `hud` (DOM overlay) · `audio` (WebAudio SFX) · `render` (WebGL follow-cam).

## Cameras (reusable component — engine/render/cameras.js)
Set `ctx.camera` in bootstrap to pick a view; all are swappable without touching game logic:
`cameras.topDown({height,back})` · `cameras.sideScroller({distance,height,ahead})` · `cameras.thirdPerson({distance,height})` · `cameras.orbit({radius,height,speed})` · `cameras.fixed({eye,target})` · `cameras.flat2D({height,size})` (true 2D, orthographic top-down) · `cameras.sideScroller2D({distance,size})` (2D platformer). Each is a pure `(focus, entity, dt) → {eye,target,up?,projection?,orthoSize?}`; add your own the same way.

## Movement (reusable component — engine/control/movements.js)
Set `ctx.movement` in bootstrap: `movements.twinStick({speed})` (top-down) · `movements.eightWay({speed})` · `movements.tank({speed,turn})` · `movements.platformer({speed,jump,gravity})` (side view, gravity+jump) · `movements.autoRun({speed,jump})` (endless runner). Each is `update(entity, input, dt)` where `input = {move:[x,z], aim:[x,z], jump}`. Default is twinStick.

## Weapons (reusable component — engine/control/weapons.js)
Set `ctx.weapon` in bootstrap to pick the gun (rhythm + pattern): `weapons.single({cooldown})` (default) · `weapons.rapid({cooldown})` (machine gun) · `weapons.shotgun({pellets,spreadDeg,cooldown})` (fan) · `weapons.burst({count,gap,cooldown})` (tap-fire) · `weapons.radial({ways,cooldown})` (nova/bomb). Each is a stateful `update(dt, firing, dir) → shots[]`; a shot is `{dir:[x,z], speed?, life?, damage?, scale?}`. The fire system spawns whatever it returns, so this is the one place that decides "what a shot is." Per-shot `damage` overrides `config.bulletDamage`.

## Aim (reusable component — engine/control/aim.js)
Set `ctx.aim` in bootstrap to pick how shots are pointed: `aim.stick()` (twin-stick, default) · `aim.facing()` (shoot where you move — one-stick/auto-fire) · `aim.manual()` (sticky: flick to set, holds after release) · `aim.autoAim({range})` (lock the nearest enemy — mobile aim assist). Each is `resolve(player, raw, ctx) → [x,z]` (a unit direction). The fire system asks the aimer each shot.

## Behaviors (reusable component — engine/control/behaviors.js)
The brain for each enemy/NPC (in the `enemies` registry). Set a game-wide default `ctx.behavior`, or give one entity its own `e.behavior`, or mix types with `behaviors.byKind({kind: ..., default: ...})`. Enemy: `chase()` (default) · `flee()` · `orbit({radius,dir})` (circle-strafe) · `keepDistance({min,max})` (ranged) · `zigzag({amp,freq})` (weaves) · `charger({range,windup,dashSpeed})` (telegraph→dash). NPC: `wander({area})` (roam near spawn) · `patrol({points})` (waypoint route) · `follow({distance})` (companion) · `guard({radius})` (hold home, chase intruders). Each is `step(entity, target, dt, ctx)` and sets velocity + facing; per-entity state lives on `e._ai`, so one instance drives a whole registry. `target` is the player, or null when it's gone (NPC behaviors keep going; chasers idle).

## Spawn directors (reusable component — engine/control/spawners.js)
The "when and what to spawn" brain, swappable like cameras/movements/behaviors. Set `ctx.director` in bootstrap; the spawn system calls it each update phase as `director(dt, api)`. A director is a PURE stepper — it never imports world/rng, it only drives the injected `api = { count() (live enemy count), spawn(opts), setWave(n), rng, onWave(cb) }`, so it unit-tests with a recording fake. Variants: `waves({base,growth,delay})` (escalating arena rounds; advances to the next, bigger wave once `count()===0` and a `delay` breather passes — batch n = base+growth*(n-1)) · `endless({rate,max})` (steady time-based trickle, catches up long frames, `max` caps live count) · `burst({size,every,max})` (periodic clumps with lulls) · `boss({atWave,make,escort})` (watches the wave via `onWave`, spawns one boss + escorts once, then steps aside) · `timed({schedule:[{at,count,make}],loop})` (scripted absolute-time cues for intros/boss-rush). Compose with `chain(...directors)` — it forwards any wave announced via `setWave` into every child's `onWave`, so `chain(waves(), boss({atWave:5, make}))` lets a boss watch a wave loop. `spawn(opts)` shape is the game's own contract (opts carries { wave } | { pack } | { boss, make, escort } | { make, at }).

## Pickups (reusable component — engine/control/pickups.js)
What an item does when the player collects it — a swappable effect component. Set it per-drop on an item entity (`item.pickup = pickups.health({ amount: 50 })`), not game-wide. Each factory returns `{ kind, apply(ctx, player) }`; `apply` mutates the game's signals and/or stashes a timed buff on the player, then returns a short tag string ('heal'|'shield'|'score'|'speed'|'weapon'|'magnet'|'life') for a label/sound. Variants: `health({amount,cap})` (raise playerHealth, capped) · `shield({duration})` (player.shield invuln timer) · `scoreBonus({points})` · `speedBoost({mult,duration})` (player.speedMult+speedTimer for movement) · `weaponSwap({weapon})` (set ctx.weapon) · `magnet({radius,duration})` (player.magnetRadius+magnetTimer) · `extraLife({refill,cap})` (bump lives signal/player.lives, optional heal). Helper `makePickup(kind, apply)`. Timed buffs are seconds-remaining fields a tiny game system counts down and clears.

## Hazards (reusable component — engine/control/hazards.js)
Environmental effect zones — lava, spikes, wind, pits — swappable like behaviors. A game places a zone in the world as either a circle `{pos:[x,y,z], radius}` or an axis-aligned box `{min:[x,z], max:[x,z]}`, then picks a hazard per zone: `const lake = hazards.lava()`. Each hazard exposes `inside(entity, zone) -> bool` (radius-aware membership, works for both shapes) and `affect(entity, dt, zone) -> {damage?, push?[x,z], kill?, slow?} | null`. The verdict is PURE DATA — the hazard never mutates the entity; a system reads the fields and applies them (subtract `damage`, add `push` to vel, despawn on `kill`, scale speed by `slow` 0..1). Returns null when the entity is outside. Variants: `damageZone({dps=10})` (dt-scaled DoT) · `spikes({damage=20})` (one-shot flat hit on entry, re-arms after you leave — per-entity via WeakSet) · `lava({dps=30,slow=0.5})` (DoT + drag) · `slowField({mult=0.5})` (pure speed multiplier — mud/web) · `pit({})` (instant kill inside) · `windZone({force:[x,z]})` (constant dt-scaled velocity push — conveyor/fan/current; also exposes `outward(entity,zone)` for radial repulsors). Pure and sim-testable; a game applies verdicts wherever it steps hazards (e.g. a small system in `update`).

## Difficulty (reusable component — engine/control/difficulty.js)
Set `ctx.difficulty` in bootstrap to pick how the game ramps up. Each is a pure `scale(state) -> {speedMul, hpMul, rateMul, damageMul}` where `state = {time, score, wave, performance}`; the spawn director multiplies enemy stats by the muls when building a wave. `difficulty.flat({speed,hp,rate,damage})` (fixed, a casual baseline) · `difficulty.linear({per,cap,by,unit})` (smooth continuous ramp vs time/wave/score, default) · `difficulty.stepped({every,step})` (discrete plateaus that jump) · `difficulty.waveBased({perWave})` (keyed to the wave counter; wave 1 = base) · `difficulty.adaptive({up,down,floor})` (rubber-band/DDA: eases up when `state.performance`>0.5, down when struggling) · `difficulty.compose(...curves)` (multiply curves, e.g. a rising wave floor plus rubber-banding). Deterministic and node-safe; per-mul weights make HP/damage climb harder than speed/rate, all clamped to `cap` (default 3).

## Steering (reusable component — engine/control/steering.js)
Low-level STEERING primitives that a behavior composes (behaviors.js is the high-level brain; these are its atoms). Each returns a desired velocity vector `[x,0,z]` from pure vector math — no side effects (except `wander`, which advances a heading on the state you pass). Blend several with `combine`, write the result to `e.vel`, and let movement.js integrate it. `steering.seek(fromPos,toPos,speed)` (go there) · `steering.flee(fromPos,fromTarget,speed)` (mirror of seek) · `steering.arrive(fromPos,toPos,speed,slowRadius=3)` (ease to a stop on the goal) · `steering.pursue(self{pos,vel},target{pos,vel},speed)` (lead a moving target) · `steering.evade(self,target,speed)` (dodge the interception) · `steering.separation(selfPos,neighborsPosArray,radius,speed)` (anti-crowding push) · `steering.wander(state,{speed,jitter,turn})` (smooth roam; pass `state.rng` for determinism) · `steering.combine([{v,weight}...],maxSpeed)` (weighted blend, length-clamped). Typical use inside a behavior: `const v = steering.combine([{v:steering.seek(e.pos,t.pos,4),weight:1},{v:steering.separation(e.pos,near,2,4),weight:1.5}], 4); e.vel[0]=v[0]; e.vel[2]=v[2];`.

## Building a game from a description (the app's core job)
The app's purpose is making games. Given a description, DON'T write an engine — pick components and glue:
1. **View + movement** from the description: top-down shooter → `cameras.topDown` + `movements.twinStick`; platformer → `cameras.sideScroller` + `movements.platformer`; runner → `cameras.sideScroller` + `movements.autoRun`; true 2D → `cameras.flat2D`.
2. **Systems** in `game/bootstrap.js`: keep the ones the game needs (movement, ai, collision, health, score, hud, audio, render, gamestate are almost always in; add `fire`/`spawn` for shooters, drop them for a pure platformer). For a shooter also pick `ctx.weapon` (single/rapid/shotgun/burst/radial) and `ctx.aim` (stick/facing/manual/autoAim) — e.g. a one-thumb mobile shooter is `aim.autoAim` + `weapons.rapid`. Pick enemy/NPC brains with `ctx.behavior` (chase/orbit/zigzag/charger for foes; wander/patrol/follow/guard for NPCs), or `behaviors.byKind({...})` to mix.
3. **Entities** (`game/entities.js`): mesh (box/sphere/cylinder/plane), color, size, stats — pure data. **Config** (`game/config.js`): the numbers.
4. **Signals/registries** (`game/contracts.js`): add any the game needs.
5. Ask the user AT MOST 1–2 questions only for genuinely ambiguous core choices (e.g. "waves or endless? health or one-hit?"). Otherwise pick sensible defaults and build.
6. Only write a NEW system for behavior no component provides — one small file, imports only core, reacts to events/signals.

You should not need to open `engine/core`, `engine/render`, `engine/control`, or the existing `engine/systems`.
