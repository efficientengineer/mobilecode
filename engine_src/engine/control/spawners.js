// engine/control/spawners.js
// Reusable SPAWN DIRECTORS — the "when and what to spawn" brain, swappable like
// cameras/movements/weapons/behaviors. Each factory returns a stepper:
//   step(dt, api)
// where the spawn system hands it an api it drives (it never touches world/rng
// itself, so directors stay pure and unit-testable with a fake api):
//   api = {
//     count(),        // how many enemies are alive right now
//     spawn(opts),    // ask the game to spawn one thing (opts is yours to shape)
//     setWave(n),     // publish the current wave number (drives the `wave` signal)
//     rng,            // deterministic { next/range/int } for placement/variety
//     onWave(cb),     // register a callback fired when a new wave begins
//   }
// Pick one in bootstrap: ctx.director = spawners.waves({ base: 4, growth: 3 }).
//
// Per-director state (timers, wave index, pending queue) lives in the closure, so
// each factory call is one independent director; call it again for a fresh run.

// A director talks to the game only through `api` (never world/rng directly), so
// every one of these is a pure stepper you can unit-test with a recording fake.
// api.setWave(n) publishes the wave number; the spawn system turns that into the
// `wave` signal + wave-started event, and chain() forwards it to a boss's onWave.

export function waves({ base = 3, growth = 2, delay = 2 } = {}) {
  // Escalating rounds: spawn a batch, wait until the field is CLEAR, pause for
  // `delay`, then start the next (bigger) wave. The classic arena survival loop.
  // Batch size for wave n (1-indexed) = base + growth*(n-1).
  const st = { wave: 0, rest: 0, started: false };
  return (dt, api) => {
    dt = dt || 0;
    if (!st.started) {                   // kick off wave 1 immediately
      st.started = true; st.wave = 1; st.rest = 0;
      if (api.setWave) api.setWave(st.wave);
      for (let i = 0; i < base; i++) api.spawn({ wave: st.wave });
      return;
    }
    if (api.count() > 0) { st.rest = 0; return; }  // still fighting this wave
    st.rest += dt;                       // field clear — count down the breather
    if (st.rest < delay) return;
    st.rest = 0; st.wave += 1;
    if (api.setWave) api.setWave(st.wave);
    const n = base + growth * (st.wave - 1);
    for (let i = 0; i < n; i++) api.spawn({ wave: st.wave });
  };
}

export function endless({ rate = 1, max = Infinity } = {}) {
  // Steady time-based trickle: spawn `rate` enemies per second, forever. No wave
  // structure — good for score-attack / survival pressure. `max` caps live count.
  const st = { acc: 0 };
  const interval = rate > 0 ? 1 / rate : Infinity;
  return (dt, api) => {
    dt = dt || 0;
    st.acc += dt;
    while (st.acc >= interval) {          // catch up if the frame was long
      st.acc -= interval;
      if (api.count() < max) api.spawn({});
    }
  };
}

export function burst({ size = 5, every = 6, max = Infinity } = {}) {
  // Periodic clumps: nothing, then a sudden pack of `size` every `every` seconds.
  // Breathing-room pacing — pressure spikes with lulls between.
  const st = { timer: 0 };
  return (dt, api) => {
    dt = dt || 0;
    st.timer += dt;
    if (st.timer < every) return;
    st.timer -= every;                   // keep remainder so cadence stays true
    const room = max - api.count();
    const n = Math.max(0, Math.min(size, room === Infinity ? size : room));
    for (let i = 0; i < n; i++) api.spawn({ pack: true });
  };
}

export function boss({ atWave = 5, make = null, escort = 0 } = {}) {
  // Watch the wave number and, when it reaches `atWave`, spawn ONE boss (plus
  // optional `escort` minions), then step aside. Compose it with another director
  // via chain(): chain(waves(), boss({ atWave: 5, make: bossEntity })).
  const st = { spawned: false, wave: 0, subbed: false };
  return (dt, api) => {
    if (!st.subbed) {                    // learn the wave number via onWave, if any
      st.subbed = true;
      if (api.onWave) api.onWave((n) => { st.wave = n; });
    }
    if (st.spawned) return;
    if (st.wave >= atWave) {
      st.spawned = true;
      api.spawn({ boss: true, make });
      for (let i = 0; i < escort; i++) api.spawn({ escort: true });
    }
  };
  // Note: boss() needs the wave number. It gets it by chaining AFTER a wave
  // director — chain() forwards each announced wave into every child's onWave.
}

export function timed({ schedule = [], loop = false } = {}) {
  // Scripted encounter: fire specific spawns at absolute times on a clock.
  //   timed({ schedule: [{ at: 0, make: grunt }, { at: 3, count: 4, make: swarm }] })
  // Each entry: { at (seconds), make? (entity descriptor), count=1 }. Great for
  // set-piece intros, tutorials, and boss-rush scripts. `loop` restarts the clock.
  const items = schedule.slice().sort((a, b) => (a.at || 0) - (b.at || 0));
  const span = items.length ? (items[items.length - 1].at || 0) : 0;
  const st = { t: 0, fired: new Array(items.length).fill(false) };
  return (dt, api) => {
    dt = dt || 0;
    st.t += dt;
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (st.fired[i]) continue;
      if (st.t >= (it.at || 0)) {
        st.fired[i] = true;
        const c = it.count || 1;
        for (let k = 0; k < c; k++) api.spawn({ make: it.make, at: it.at });
      }
    }
    if (loop && span >= 0 && st.t >= span) {   // rewind for another pass
      st.t -= (span || 0) + (items.length ? 0 : dt);
      st.fired.fill(false);
    }
  };
}

export function chain(...directors) {
  // Run several directors together as one — e.g. a wave loop plus a boss at wave
  // 5: chain(waves(), boss({ atWave: 5, make: bossEntity })). Any wave a child
  // announces via setWave is forwarded to every child's onWave, so a boss can
  // watch the wave loop that a sibling drives.
  const st = { api: null, subs: [] };
  return (dt, api) => {
    if (!st.api) {                       // first tick: build a shared api wrapper
      st.api = Object.assign({}, api, {
        setWave: (n) => { if (api.setWave) api.setWave(n); for (const cb of st.subs) cb(n); },
        onWave: (cb) => { st.subs.push(cb); if (api.onWave) api.onWave(cb); },
      });
    }
    for (const d of directors) d(dt, st.api);
  };
}

export const spawners = { waves, endless, burst, boss, timed, chain };
