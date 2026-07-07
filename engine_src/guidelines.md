# Project guidelines (custom 3D engine)

This project uses our own event-driven, low-poly 3D engine. **GLUE, don't
rewrite.** The engine in `engine/` already works and is tested — treat it as a
black box.

Rules for the agent:
- To build or change the game, read `engine/CONTRACTS.md`, then edit ONLY the
  `game/` files: `contracts.js` (signals/registries), `entities.js` (data),
  `config.js` (numbers), `bootstrap.js` (which systems run). Do not re-implement
  a system that already exists.
- Systems are decoupled: they talk through the event bus (`emit`/`on`) and shared
  signals/registries, and import ONLY `engine/core`. Never import one system from
  another; if two systems must interact, add an event to the vocabulary.
- Continuous state (input, positions) → signals. Discrete happenings (a death, a
  wave cleared) → events.
- Add a NEW system only when the game needs behavior nothing here provides. Make
  it one small file under `engine/systems/`, import only core, react to
  events/signals, and add one `init...(ctx)` line in `game/bootstrap.js`.
- Do not add a rendering library (no Babylon/Three). The renderer is
  `engine/render/gl.js`; swap that one file to change the look.
- Verify with the preview and the `?debug` URL flag (logs the event flow).
