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
`input` (touch→sticks) · `movement` (input+velocity→position) · `ai` (enemies chase player) · `fire` (spawn bullets) · `spawn` (wave director) · `collision` (overlap→events) · `health` (hits→damage/death) · `score` · `cleanup` (life/bounds despawn) · `gamestate` (lifecycle+pause) · `hud` (DOM overlay) · `audio` (WebAudio SFX) · `render` (WebGL follow-cam).

## Cameras (reusable component — engine/render/cameras.js)
Set `ctx.camera` in bootstrap to pick a view; all are swappable without touching game logic:
`cameras.topDown({height,back})` · `cameras.sideScroller({distance,height,ahead})` · `cameras.thirdPerson({distance,height})` · `cameras.orbit({radius,height,speed})` · `cameras.fixed({eye,target})` · `cameras.flat2D({height,size})` (true 2D, orthographic top-down) · `cameras.sideScroller2D({distance,size})` (2D platformer). Each is a pure `(focus, entity, dt) → {eye,target,up?,projection?,orthoSize?}`; add your own the same way.

## Movement (reusable component — engine/control/movements.js)
Set `ctx.movement` in bootstrap: `movements.twinStick({speed})` (top-down) · `movements.eightWay({speed})` · `movements.tank({speed,turn})` · `movements.platformer({speed,jump,gravity})` (side view, gravity+jump) · `movements.autoRun({speed,jump})` (endless runner). Each is `update(entity, input, dt)` where `input = {move:[x,z], aim:[x,z], jump}`. Default is twinStick.

## Weapons (reusable component — engine/control/weapons.js)
Set `ctx.weapon` in bootstrap to pick the gun (rhythm + pattern): `weapons.single({cooldown})` (default) · `weapons.rapid({cooldown})` (machine gun) · `weapons.shotgun({pellets,spreadDeg,cooldown})` (fan) · `weapons.burst({count,gap,cooldown})` (tap-fire) · `weapons.radial({ways,cooldown})` (nova/bomb). Each is a stateful `update(dt, firing, dir) → shots[]`; a shot is `{dir:[x,z], speed?, life?, damage?, scale?}`. The fire system spawns whatever it returns, so this is the one place that decides "what a shot is." Per-shot `damage` overrides `config.bulletDamage`.

## Aim (reusable component — engine/control/aim.js)
Set `ctx.aim` in bootstrap to pick how shots are pointed: `aim.stick()` (twin-stick, default) · `aim.facing()` (shoot where you move — one-stick/auto-fire) · `aim.manual()` (sticky: flick to set, holds after release) · `aim.autoAim({range})` (lock the nearest enemy — mobile aim assist). Each is `resolve(player, raw, ctx) → [x,z]` (a unit direction). The fire system asks the aimer each shot.

## Building a game from a description (the app's core job)
The app's purpose is making games. Given a description, DON'T write an engine — pick components and glue:
1. **View + movement** from the description: top-down shooter → `cameras.topDown` + `movements.twinStick`; platformer → `cameras.sideScroller` + `movements.platformer`; runner → `cameras.sideScroller` + `movements.autoRun`; true 2D → `cameras.flat2D`.
2. **Systems** in `game/bootstrap.js`: keep the ones the game needs (movement, ai, collision, health, score, hud, audio, render, gamestate are almost always in; add `fire`/`spawn` for shooters, drop them for a pure platformer). For a shooter also pick `ctx.weapon` (single/rapid/shotgun/burst/radial) and `ctx.aim` (stick/facing/manual/autoAim) — e.g. a one-thumb mobile shooter is `aim.autoAim` + `weapons.rapid`.
3. **Entities** (`game/entities.js`): mesh (box/sphere/cylinder/plane), color, size, stats — pure data. **Config** (`game/config.js`): the numbers.
4. **Signals/registries** (`game/contracts.js`): add any the game needs.
5. Ask the user AT MOST 1–2 questions only for genuinely ambiguous core choices (e.g. "waves or endless? health or one-hit?"). Otherwise pick sensible defaults and build.
6. Only write a NEW system for behavior no component provides — one small file, imports only core, reacts to events/signals.

You should not need to open `engine/core`, `engine/render`, `engine/control`, or the existing `engine/systems`.
