// engine/control/difficulty.js
// Reusable DIFFICULTY curves — the knob that ramps a game up over time, swappable
// like cameras/movements/weapons/behaviors. Each factory returns a scaler:
//   scale(state) -> { speedMul, hpMul, rateMul, damageMul }   // all multipliers
// where state = { time, score, wave, performance } (whatever fields you have).
// Feed the muls into your spawn/enemy stats: enemy.speed *= speedMul, etc. Pick a
// game-wide default in bootstrap (ctx.difficulty = difficulty.linear()), or read
// it wherever the spawn director builds a wave.
//
// Pure & deterministic: same state in -> same muls out (adaptive keeps a little
// eased state on `this`, still frame-rate free — it advances per call). No timers,
// no globals, so a sim can fast-forward `state.time` and assert the curve.

const num = (v, d) => (typeof v === 'number' && !isNaN(v) ? v : d); // safe read
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const M = (speedMul, hpMul, rateMul, damageMul) => ({ speedMul, hpMul, rateMul, damageMul });
const ONE = () => M(1, 1, 1, 1);

// How each mul reacts to one shared "difficulty amount" `g` (0 = base). Speed and
// fire-rate climb gently, HP and damage harder — tune per curve with `weights`.
const DEFAULT_WEIGHTS = { speed: 0.5, hp: 1, rate: 0.4, damage: 0.7 };
function spread(g, w = DEFAULT_WEIGHTS, cap = 3) {
  const at = (k) => clamp(1 + g * num(w[k], 0), 0, cap);
  return M(at('speed'), at('hp'), at('rate'), at('damage'));
}

export function flat({ speed = 1, hp = 1, rate = 1, damage = 1 } = {}) {
  // No ramp — fixed multipliers forever. Handy as a baseline or a "casual" mode;
  // pass e.g. flat({ hp: 0.5 }) to globally soften enemies.
  const out = M(speed, hp, rate, damage);
  return () => out;
}

export function linear({ per = 0.1, cap = 3, by = 'time', unit = 60, weights } = {}) {
  // Smooth, continuous ramp: difficulty grows `per` for every `unit` of the chosen
  // driver (`time` seconds, `wave`, or `score`). The steady, predictable dial.
  return (state = {}) => {
    const driver = num(state[by], 0);
    const g = Math.max(0, driver / unit) * per;          // difficulty amount
    return spread(g, weights, cap);
  };
}

export function stepped({ every = 30, step = 0.25, cap = 3, by = 'time', weights } = {}) {
  // Discrete plateaus: hold steady, then jump by `step` each `every` units of the
  // driver. Readable spikes — the player feels the game "gearing up."
  return (state = {}) => {
    const driver = num(state[by], 0);
    const tier = Math.max(0, Math.floor(driver / every));
    return spread(tier * step, weights, cap);
  };
}

export function waveBased({ perWave = 0.15, cap = 3, weights } = {}) {
  // Ramp keyed to the wave counter — the natural fit for a wave director. Wave 1
  // is base; each cleared wave adds `perWave`. (linear({by:'wave'}) with a name.)
  return (state = {}) => {
    const wave = Math.max(0, num(state.wave, 1) - 1);    // wave 1 = no bonus
    return spread(wave * perWave, weights, cap);
  };
}

export function adaptive({ up = 0.2, down = 0.1, cap = 3, floor = 0.5, weights, mid = 0.5 } = {}) {
  // Rubber-band / DDA: read state.performance (0 = struggling, 1 = dominating) and
  // ease difficulty UP when the player is winning, DOWN when they're losing. `up`/
  // `down` are per-call ease rates (asymmetric so relief comes faster than heat).
  // Keeps one eased value `g` on the closure — still deterministic given the same
  // performance stream. Great for keeping a wide skill range in the sweet spot.
  let g = 0;                                             // current difficulty amount
  return (state = {}) => {
    const perf = clamp(num(state.performance, mid), 0, 1);
    const drive = (perf - mid) * 2;                      // -1..1 around the target
    const rate = drive >= 0 ? up : down;                 // heat slower than relief
    g = Math.max(0, g + drive * rate);                   // never below base
    const eff = Math.max(floor - 1, g);                  // allow easing below base to `floor`
    return spread(eff, weights, cap);
  };
}

export function compose(...curves) {
  // Multiply several curves together — e.g. compose(waveBased(), adaptive()) so a
  // wave floor rises while rubber-banding nudges within it. Missing muls default 1.
  return (state = {}) => {
    let out = ONE();
    for (const c of curves) {
      const m = c ? c(state) : ONE();
      out.speedMul *= num(m.speedMul, 1);
      out.hpMul *= num(m.hpMul, 1);
      out.rateMul *= num(m.rateMul, 1);
      out.damageMul *= num(m.damageMul, 1);
    }
    return out;
  };
}

export const difficulty = {
  flat, linear, stepped, waveBased, adaptive, compose,
};
