// engine/control/fsm.js
// Reusable FINITE STATE MACHINE — the backbone for LAYERED enemy/NPC logic that
// sits ABOVE behaviors.js. A behavior (chase/flee/orbit/...) answers "how do I
// move right now?"; the FSM answers "which mode am I in, and when do I switch?"
// (idle -> alert -> attack -> flee -> search). One machine drives a whole
// registry — all per-entity state (current state name + a per-state timer) lives
// on the entity in e._fsm, never on the module.
//
//   const brain = makeFsm({
//     initial: 'idle',
//     states: {
//       idle:   { update: when((e, dt, ctx) => sees(e, ctx.target), 'alert') },
//       alert:  { update: after(0.4, 'attack') },        // brief "!" telegraph
//       attack: { update: any([                          // do, THEN decide
//                   (e, dt, ctx) => { chase(); return null; },   // action leg
//                   when(e => e.hp < e.maxHp * 0.3, 'flee'),     // guard legs
//                   when((e, dt, ctx) => !sees(e, ctx.target), 'search'),
//                 ]) },
//       flee:   { enter: e => flee(), update: when(e => e.hp > e.maxHp*0.6,'idle') },
//       search: { update: after(3, 'idle') },
//     },
//   });
//   // each frame, per entity:  brain(enemy, dt, { target: player, ... });
//
// A state is { enter(e,ctx), update(e,dt,ctx)->nextName|null, exit(e,ctx) } — all
// optional. `update` returns the name of the state to switch to, or null/undefined
// to stay put. On a switch the old state's exit and the new state's enter fire and
// the per-state timer resets. Only ONE transition happens per step (enter never
// self-transitions), so a machine can never loop forever in a single frame.
//
// Pure, deterministic, node-safe: no window/DOM/WebGL/timers, no Math.random. Any
// randomness a guard needs comes off the ctx you pass (ctx.rng). Sim-test it by
// driving a fake entity through dt steps and asserting e._fsm.state.

function mem(e) { return e._fsm || (e._fsm = { state: null, t: 0 }); }

// Normalize a state entry: a bare function is shorthand for { update: fn }.
function normal(s) { return typeof s === 'function' ? { update: s } : (s || {}); }

function enter(e, m, states, name, ctx) {
  m.state = name; m.t = 0;                       // fresh per-state clock
  const s = normal(states[name]);
  if (s.enter) s.enter(e, ctx);
}

export function makeFsm({ initial, states = {} } = {}) {
  // Build a stepper that runs the current state and switches when its `update`
  // returns a new state name. Reuse ONE instance across a whole registry.
  return function step(e, dt, ctx) {
    dt = dt || 0;
    const m = mem(e);
    if (m.state == null) enter(e, m, states, initial, ctx);   // lazy first entry
    m.t += dt;                                    // time spent in this state
    const s = normal(states[m.state]);
    const next = s.update ? s.update(e, dt, ctx) : null;
    if (next != null && next !== m.state) {       // a real transition was requested
      if (s.exit) s.exit(e, ctx);
      enter(e, m, states, next, ctx);
    }
    return m.state;
  };
}

// --- Guard / transition helpers (compose these into a state's `update`) -------

export function after(seconds, toState) {
  // Auto-transition once `seconds` have elapsed IN THE CURRENT STATE (the timer
  // resets every time the state is (re)entered). The classic "wind up for 0.4s".
  return (e) => (e._fsm && e._fsm.t >= seconds ? toState : null);
}

export function when(pred, toState) {
  // Transition the moment `pred(e, dt, ctx)` is truthy — sightlines, hp, range.
  return (e, dt, ctx) => (pred(e, dt, ctx) ? toState : null);
}

export function any(guards = []) {
  // Compose several legs, first non-null wins. A leg is either a guard (after/when)
  // or an ACTION fn that does work (steer, animate) and returns null to fall
  // through — so `any([action, guardA, guardB])` reads "act, then maybe switch".
  return (e, dt, ctx) => {
    for (let i = 0; i < guards.length; i++) {
      const r = guards[i] && guards[i](e, dt, ctx);
      if (r != null) return r;
    }
    return null;
  };
}

// --- Tiny read-only introspection (handy in guards / HUD / debug) -------------

export function is(e, name) { return !!e._fsm && e._fsm.state === name; }   // in state?
export function elapsed(e) { return e._fsm ? e._fsm.t : 0; }               // secs in state
export function reset(e) { e._fsm = { state: null, t: 0 }; }              // re-arm next step

export const fsm = { makeFsm, after, when, any, is, elapsed, reset };
