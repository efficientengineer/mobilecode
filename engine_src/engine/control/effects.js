// engine/control/effects.js
// Screen/game FEEL signals — the "juice" a renderer or the loop reads each frame.
// These are pure STATE MACHINES that PRODUCE values (offsets, timescales, alphas,
// zoom factors); they never draw, touch WebGL/DOM, or read Math.random. A game
// keeps one instance per effect, fires it on an event, and samples it per frame:
//   const shake = effects.screenShake();
//   on('enemy-died', () => shake.trigger());          // kick it
//   // in render/late: const [ox, oy] = shake.step(dt); camera.eye[0] += ox; ...
//
// Every factory returns the SAME tiny shape so they're swappable/composable:
//   { trigger(cfg?), step(dt) -> value, active }
//   - trigger(cfg?)  starts (or restarts/stacks) the effect; optional overrides.
//   - step(dt)       advances the clock and returns THIS FRAME's value.
//   - active         getter: is the effect still doing something?
// State lives in the closure (per instance), so replays are deterministic — the
// wobble rides a seeded counter, NOT Math.random, so the same trigger+dt sequence
// yields the same values every run. Sim-test by triggering then stepping dt.

// Hashed pseudo-random in [-1,1] from an integer counter — our Math.random stand-in
// in the hot path (same counter -> same value, so shakes replay identically).
function hashNoise(n) {
  let h = (n | 0) * 374761393 + 668265263;
  h = (h ^ (h >>> 13)) * 1274126177;
  h = h ^ (h >>> 16);
  return ((h >>> 0) / 4294967295) * 2 - 1;
}
const clamp01 = (t) => (t < 0 ? 0 : t > 1 ? 1 : t);
// smooth ease used by punches/pulses: 0 at the ends, 1 in the middle-ish (spike then settle)

// --- screenShake: a decaying positional wobble -----------------------------
// step returns an offset [x,y] a renderer adds to the camera eye (or a 2D layer).
// The offset rides a seeded counter so it looks noisy but replays deterministically.
// `mag` = peak amplitude, `duration` = seconds to fully decay, `decay` = extra
// exponential falloff on top of the linear timer (higher = snappier settle).
export function screenShake({ mag = 0.6, duration = 0.4, decay = 6 } = {}) {
  let t = 0, dur = duration, peak = mag, n = 0;
  const self = {
    trigger(cfg = {}) {
      // Restart at full strength; take the STRONGER of any lingering shake so a
      // fresh hit never weakens one already in flight.
      peak = Math.max(cfg.mag != null ? cfg.mag : mag, t > 0 ? peak : 0);
      dur = cfg.duration != null ? cfg.duration : duration;
      t = dur;
    },
    step(dt = 0) {
      if (t <= 0) return [0, 0];
      t = Math.max(0, t - dt);
      n += 3;                                   // advance the noise counter
      const lin = dur > 0 ? t / dur : 0;        // 1 -> 0 over the duration
      const env = lin * Math.exp(-decay * (1 - lin)); // linear * exponential settle
      const k = peak * env;
      return [hashNoise(n * 2 + 1) * k, hashNoise(n * 2 + 7) * k];
    },
    get active() { return t > 0; },
  };
  return self;
}

// --- hitStop: a crunchy micro-freeze on impact -----------------------------
// step returns a TIMESCALE the loop multiplies into its sim dt: 0 while frozen,
// 1 otherwise. A few frames of 0 make a hit land with weight. Tick with REAL dt
// (unscaled) or the freeze can never end. Re-triggering extends the freeze.
export function hitStop({ duration = 0.06 } = {}) {
  let t = 0;
  const self = {
    trigger(cfg = {}) {
      const d = cfg.duration != null ? cfg.duration : duration;
      t = Math.max(t, d);                       // extend, never shorten
    },
    step(dt = 0) {
      if (t <= 0) return 1;
      t = Math.max(0, t - dt);
      return 0;                                 // fully frozen this frame
    },
    get active() { return t > 0; },
  };
  return self;
}

// --- flash: a full-screen color overlay that fades out ----------------------
// step returns an alpha 0..1 a renderer uses to blend `color` over the frame —
// a hit-white, a pickup-gold, a damage-red. `color` is carried on the instance
// (read it as .color) so the renderer knows what to tint. Fades linearly to 0.
export function flash({ color = [1, 1, 1], duration = 0.2, peak = 1 } = {}) {
  let t = 0, dur = duration, top = peak;
  const self = {
    color: [color[0], color[1], color[2]],
    trigger(cfg = {}) {
      if (cfg.color) self.color = [cfg.color[0], cfg.color[1], cfg.color[2]];
      dur = cfg.duration != null ? cfg.duration : duration;
      top = cfg.peak != null ? cfg.peak : peak;
      t = dur;
    },
    step(dt = 0) {
      if (t <= 0) return 0;
      t = Math.max(0, t - dt);
      return top * (dur > 0 ? t / dur : 0);     // linear fade
    },
    get active() { return t > 0; },
  };
  return self;
}

// --- zoomPunch: a camera zoom that spikes then eases back to 1 --------------
// step returns a MULTIPLIER around 1 (e.g. 1.15 at the peak of a +0.15 punch)
// that a camera dolly/FOV reads: >1 punches IN, `amount` negative punches OUT.
// Fast attack, slower ease-out so the recoil feels springy, not linear.
export function zoomPunch({ amount = 0.15, duration = 0.25, attack = 0.25 } = {}) {
  let t = 0, dur = duration, amt = amount;
  const self = {
    trigger(cfg = {}) {
      amt = cfg.amount != null ? cfg.amount : amount;
      dur = cfg.duration != null ? cfg.duration : duration;
      t = dur;
    },
    step(dt = 0) {
      if (t <= 0) return 1;
      t = Math.max(0, t - dt);
      const p = dur > 0 ? 1 - t / dur : 1;      // 0 at trigger -> 1 at end
      // quick ramp up over `attack` of the window, smooth ease down after
      const env = p < attack
        ? p / attack                            // attack: 0 -> 1
        : 1 - clamp01((p - attack) / (1 - attack)); // release: 1 -> 0
      const s = env * env * (3 - 2 * env);      // smoothstep the envelope
      return 1 + amt * s;
    },
    get active() { return t > 0; },
  };
  return self;
}

// --- vignettePulse: an edge-darkening throb --------------------------------
// step returns an alpha 0..1 a renderer uses for vignette strength — a low-health
// heartbeat, a shield-up glow, a boss-arrival dread. Rises fast, ebbs slow (a
// one-shot pulse); set `hold` to keep it pinned at peak (e.g. while a state lasts).
export function vignettePulse({ duration = 0.6, peak = 1, hold = 0 } = {}) {
  let t = 0, dur = duration, top = peak, held = hold;
  const self = {
    trigger(cfg = {}) {
      dur = cfg.duration != null ? cfg.duration : duration;
      top = cfg.peak != null ? cfg.peak : peak;
      held = cfg.hold != null ? cfg.hold : hold;
      t = dur + held;
    },
    step(dt = 0) {
      if (t <= 0) return 0;
      t = Math.max(0, t - dt);
      if (t > dur) return top;                  // holding at peak
      const p = dur > 0 ? t / dur : 0;          // dur..0 -> 1..0
      // fast rise near the start of the fade window, slow tail: shape with sqrt
      return top * Math.sqrt(p);
    },
    get active() { return t > 0; },
  };
  return self;
}

export const effects = {
  screenShake, hitStop, flash, zoomPunch, vignettePulse,
};
