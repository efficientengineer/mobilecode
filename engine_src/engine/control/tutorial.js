// engine/control/tutorial.js
// TUTORIAL / onboarding SEQUENCING — drive a first-run walkthrough one step at a
// time, so the UI just paints whatever `current()` hands it and forwards events.
// A step is plain data:
//   { id, text, target?, advanceOn?, until?, gate?, optional?, skipIf? }
//     text      — the coach line the UI shows.
//     target    — a HUD/world ANCHOR name the UI can spotlight (any token the game
//                 understands: 'fireButton', an entity id, [x,z]… — we never read it).
//     advanceOn — event name (or array) that clears the step: notify(name) advances.
//     until     — predicate until(state,dt)->bool; step(dt,state) advances when true
//                 (for state-driven gates: "moved 3m", "hp<50", "wave===2").
//     gate      — block OTHER input while this step is up: true = block all, or an
//                 array/predicate of ALLOWED inputs (whitelist what we're teaching).
//     optional  — step may be skipped; paired with skipIf(state)->bool it drops
//                 itself the moment its condition is already met (no dead barks).
//
// Persist completion through an INJECTED flag ({ get(), set(v) } — a signal fits):
// if the flag reads truthy at construction the whole walkthrough is already done
// (current()===null); on finishing we set it once, so onboarding shows exactly once.
//
// Pure, deterministic, headless: no engine bus, no window/DOM/timers/Math.random.
// You pump it — notify(eventName) for discrete cues, step(dt,state) for predicate/
// optional steps each frame — so a sim feeds events + state and asserts progression,
// gating and completion. All state lives in the returned closure.

export function makeTutorial(steps = [], opts = {}) {
  const list = Array.isArray(steps) ? steps.slice() : [];
  const total = list.length;
  const flag = opts.flag || null;                // { get(), set(v) } — e.g. a signal
  const onDone = typeof opts.onDone === 'function' ? opts.onDone : null;
  const onStep = typeof opts.onStep === 'function' ? opts.onStep : null;

  let pos = 0;                                    // index of the current step
  let finished = false;
  let announced = -1;                             // last index handed to onStep
  let state = opts.state != null ? opts.state : null;  // freshest game state seen

  // Already completed on a previous run? Start silent (don't re-fire onDone/flag).
  if (flag && flag.get && flag.get()) { finished = true; pos = total; }

  function markDone() {
    if (finished) return;
    finished = true; pos = total;
    if (flag && flag.set) flag.set(true);
    if (onDone) onDone();
  }

  function cur() { return finished ? null : (list[pos] || null); }

  // Drop leading OPTIONAL steps whose skipIf(state) already holds — so an optional
  // "try the dash" tip vanishes if the player dashed before we reached it.
  function resolve() {
    while (!finished) {
      const s = list[pos];
      if (!s) { markDone(); return; }
      if (s.optional && typeof s.skipIf === 'function' && state != null && s.skipIf(state)) { pos++; continue; }
      break;
    }
    // announce entry into a freshly-shown step exactly once
    if (!finished && onStep && pos !== announced) { announced = pos; onStep(list[pos], pos); }
  }
  resolve();                                       // announce step 0, settle any optionals

  function advance() {
    if (finished) return false;
    pos++;
    if (pos >= total) { markDone(); return true; }
    resolve();
    return true;
  }

  return {
    // The step to show right now, enriched for the UI, or null when the walkthrough
    // is over. `gate` is normalized to a boolean here; use blocks() for the detail.
    current() {
      const s = cur();
      if (!s) return null;
      return {
        id: s.id, text: s.text, target: s.target != null ? s.target : null,
        gate: !!s.gate, optional: !!s.optional,
        index: pos, total, first: pos === 0, last: pos === total - 1,
      };
    },

    // Feed a discrete happening (an event NAME you forward — not the engine bus).
    // Advances iff the current step waits on it. Returns whether it advanced.
    notify(name, _data) {
      const s = cur();
      if (!s) return false;
      const on = s.advanceOn;
      const hit = Array.isArray(on) ? on.indexOf(name) !== -1 : on === name;
      return hit ? advance() : false;
    },

    // Pump per frame for until()-based and optional steps. `state` is your game
    // state bag (signals snapshot, the player, whatever your predicates read).
    step(dt, gameState) {
      if (gameState !== undefined) state = gameState;
      resolve();                                   // skip optionals now that state is fresh
      const s = cur();
      if (!s) return null;
      if (typeof s.until === 'function' && s.until(state, dt || 0)) advance();
      return this.current();
    },

    // Manually clear the current step (a "skip" tap on that one tip).
    skip() { return advance(); },
    // Bail out of the whole walkthrough (a "skip tutorial" button) — persists done.
    finish() { markDone(); return true; },

    // Should the UI swallow this input right now? A step with `gate:true` blocks
    // everything; `gate:['fire']` blocks all BUT the fire input (teach one verb);
    // `gate:(name)=>bool` lets the step decide. No gate / done → nothing blocked.
    blocks(input) {
      const s = cur();
      if (!s || !s.gate) return false;
      const g = s.gate;
      if (g === true) return true;
      if (Array.isArray(g)) return g.indexOf(input) === -1;   // list = ALLOWED inputs
      if (typeof g === 'function') return !g(input);
      return true;
    },
    gating() { const s = cur(); return !!(s && s.gate); },     // is any input gated?

    done() { return finished; },
    // Re-run from the top (does NOT clear the persisted flag — for a "replay
    // tutorial" menu, clear the flag yourself first if you want it to stick).
    restart() { finished = false; pos = 0; announced = -1; resolve(); },

    get progress() { return total === 0 ? 1 : Math.min(pos, total) / total; },
    get index() { return Math.min(pos, total); },
    get length() { return total; },
  };
}

export const tutorial = { makeTutorial };
