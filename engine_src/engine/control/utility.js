// engine/control/utility.js
// UTILITY-based AI — the "what should I do RIGHT NOW?" brain, a sibling of fsm.js
// and a layer ABOVE behaviors.js. Instead of hard states + transitions, you list
// candidate ACTIONS, each SCORES itself 0..1 from weighted CONSIDERATIONS of the
// world (my hp%, distance to the target, ammo, threat), and the reasoner picks the
// highest-scoring one every tick. This is more fluid than an fsm: no explicit
// edges — priorities emerge from the curves, so "flee when hurt, attack when the
// enemy is close and I'm healthy" falls out of the math instead of being wired.
//
//   const brain = utility.makeReasoner([
//     { name: 'flee',   score: (e, ctx) => utility.curve(inverse)(e.hp / e.maxHp) },
//     { name: 'attack', considerations: [
//         (e, ctx) => threshold(0.5)(e.hp / e.maxHp),        // healthy enough
//         (e, ctx) => inverse(dist(e, ctx.target) / 12) ] }, // and target is near
//   ]);
//   const action = brain.decide(e, ctx);   // -> 'flee' | 'attack' | ...
//   runAction(e, action);                  // YOUR glue drives the behavior
//
// Considerations are pure fns of (e, ctx) -> 0..1 (a raw input already mapped
// through a curve). An action's score is its considerations combined (mult by
// default — one veto near 0 kills the action, like The Sims / Infinite Axis).
// decide() is DETERMINISTIC: highest score wins, ties break by declaration order.
// No world/rng/timers needed; per-entity scratch (last pick, hysteresis) on e._util.

// ---- consideration curves: map a raw input to a 0..1 desirability -----------
const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);

// linearC(x): pass-through clamp — desirability rises straight with the input.
export function linearC(x) { return clamp01(x); }

// inverse(x): the mirror — high input = low desirability (near enemy, low hp...).
export function inverse(x) { return 1 - clamp01(x); }

// threshold(at, soft): step gate. soft=0 is a hard 0/1 cutoff at `at`; a soft band
// eases from 0 to 1 across [at-soft, at+soft] (smoothstep) so choices don't snap.
export function threshold(at = 0.5, soft = 0) {
  return (x) => {
    if (soft <= 0) return x >= at ? 1 : 0;
    const t = clamp01((x - (at - soft)) / (2 * soft));
    return t * t * (3 - 2 * t);           // smoothstep
  };
}

// curve(fn): wrap any raw->raw shaping fn (e.g. a math easing) and clamp the
// result to 0..1, so exotic curves plug in as considerations safely.
export function curve(fn) { return (x) => clamp01(fn(x)); }

// A couple of ready-made example curves for common "sweet spot" wants:
// bell(center,width): peaks at `center`, falls off either side — "I want the
// target at ~ideal range, not too close, not too far" (kiting, spacing).
export function bell(center = 0.5, width = 0.5) {
  return (x) => { const d = (clamp01(x) - center) / (width || 1e-6); return clamp01(1 - d * d); };
}
// expo(k): sharp low-end urgency — small inputs already read as high desire (k>1
// steeper). Good for "even a little danger should matter a lot".
export function expo(k = 2) { return (x) => 1 - Math.pow(1 - clamp01(x), k); }

// ---- combining scores -------------------------------------------------------
// combine(scores, mode): fold several 0..1 considerations into one action score.
//   "mult" (default) — AND-ish: any near-0 consideration vetoes the action.
//   "avg"            — democratic mean, forgiving of one weak factor.
//   "max"            — OR-ish: the strongest reason carries the action.
//   "min"            — the weakest link (harshest gate).
export function combine(scores, mode = 'mult') {
  if (!scores || !scores.length) return 0;
  if (mode === 'avg') return scores.reduce((a, b) => a + b, 0) / scores.length;
  if (mode === 'max') return scores.reduce((a, b) => (b > a ? b : a), 0);
  if (mode === 'min') return scores.reduce((a, b) => (b < a ? b : a), 1);
  let p = 1; for (const s of scores) p *= s; return p;   // mult
}

// The Sims-style "mult" compensation: multiplying N factors biases scores toward
// zero the more considerations an action has. compensate() rescales to undo that
// so a 4-consideration action competes fairly with a 1-consideration one.
function compensate(score, n, mode) {
  if (mode !== 'mult' || n <= 1) return score;
  const mod = 1 - 1 / n;
  return score + (1 - score) * mod * score;
}

// ---- the reasoner ----------------------------------------------------------
// makeReasoner(actions, cfg): actions is an array of
//   { name, score?(e,ctx)->0..1, considerations?:[fn(e,ctx)->0..1],
//     combine?:"mult"|"avg"|"max"|"min", weight?:number, run?(e,ctx) }
// Provide EITHER a single `score` fn OR a list of `considerations` (folded by the
// action's `combine`, default from cfg.combine="mult"). `weight` scales the final
// score (a static bias/priority). cfg.commit adds hysteresis: the currently-chosen
// action gets a `commit` bonus so the brain doesn't dither between near-ties.
export function makeReasoner(actions = [], cfg = {}) {
  const list = actions.slice();
  const defMode = cfg.combine || 'mult';
  const commit = cfg.commit || 0;

  function scoreOf(a, e, ctx) {
    let s;
    if (a.considerations && a.considerations.length) {
      const parts = a.considerations.map((f) => clamp01(f(e, ctx)));
      const mode = a.combine || defMode;
      s = compensate(combine(parts, mode), parts.length, mode);
    } else if (typeof a.score === 'function') {
      s = clamp01(a.score(e, ctx));
    } else s = 0;
    return s * (a.weight != null ? a.weight : 1);
  }

  // evaluate: every action's final score, most-desirable first (stable order on
  // ties). Handy for HUD/debug ("why did it pick this?").
  function evaluate(e, ctx = {}) {
    const st = e && (e._util || (e._util = {}));
    const cur = st ? st.action : null;
    const rows = list.map((a, i) => {
      let s = scoreOf(a, e, ctx);
      if (commit && a.name === cur) s += commit;   // stickiness on the held action
      return { name: a.name, action: a, score: s, order: i };
    });
    rows.sort((p, q) => (q.score - p.score) || (p.order - q.order));
    return rows;
  }

  // decide: the winning action NAME (deterministic; ties -> earliest declared).
  // Stashes the pick on e._util.action for hysteresis + last-choice queries.
  function decide(e, ctx = {}) {
    const rows = evaluate(e, ctx);
    const best = rows[0];
    if (!best) return null;
    if (e && e._util) e._util.action = best.name;
    return best.name;
  }

  // act: decide AND fire the winner's run(e,ctx) if it has one; returns the name.
  function act(e, ctx = {}) {
    const name = decide(e, ctx);
    const a = list.find((x) => x.name === name);
    if (a && typeof a.run === 'function') a.run(e, ctx);
    return name;
  }

  return { decide, act, evaluate, actions: list };
}

// ---- small helpers a game's considerations lean on -------------------------
// dist(a, b): planar XZ distance between two entities/points (null-safe -> Inf).
export function dist(a, b) {
  if (!a || !b) return Infinity;
  const pa = a.pos || a, pb = b.pos || b;
  return Math.hypot(pa[0] - pb[0], pa[2] - pb[2]);
}
// ratio(x, of): x/of clamped 0..1 — e.g. hp fraction, ammo fraction, dist/range.
export function ratio(x, of) { return of ? clamp01(x / of) : 0; }

export const utility = {
  makeReasoner,
  // curves
  linearC, inverse, threshold, curve, bell, expo,
  // combining
  combine,
  // helpers
  dist, ratio,
};
