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

## To make a NEW game
1. In `game/contracts.js` declare the signals + registries it needs.
2. In `game/entities.js` describe what things are (mesh, color, size, stats) — pure data.
3. In `game/config.js` set the numbers (speeds, rates).
4. In `game/bootstrap.js` list the systems to run (add/remove one line each) and start the loop.
5. Only write a NEW system file if the game needs behavior none of the above provides — one small file, imports only core, reacts to events/signals.

You should not need to open `engine/core`, `engine/render`, or the existing `engine/systems`.
