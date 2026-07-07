# engine_src — the custom 3D game engine (source)

Readable, testable source for our own event-driven, low-poly WebGL engine. It
ships to the app as a project template (packed into
`app/src/main/python/engine3d.py`), and gets laid into a user's game project
where the AI **glues** against `engine/CONTRACTS.md` rather than reopening it.

## Layout
- `engine/core/` — event bus, signals, registries, world/entities, loop, math.
- `engine/render/` — `gl.js` (the only WebGL file), `meshes.js` (primitives),
  `cameras.js` (swappable camera controllers).
- `engine/systems/` — decoupled systems (input, movement, ai, fire, spawn,
  collision, health, score, cleanup, gamestate, hud, audio, render).
- `game/` — the example twin-stick shooter (the glue + acceptance demo).
- `engine/CONTRACTS.md` — the whole public interface (the file the AI reads).

## Workflow
```
node test.mjs      # runs the sim + camera controllers headlessly (no browser)
python3 regen.py   # repacks engine3d.py from these sources
```
Edit here, run the test, regen, commit both the sources and the regenerated
`engine3d.py`. The engine is renderer-swappable: `engine/render/gl.js` is the
only file that touches WebGL, and cameras are pure controllers in `cameras.js`.
