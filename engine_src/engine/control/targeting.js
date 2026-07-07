// engine/control/targeting.js
// Reusable TARGET-SELECTION strategies — the "which one do I pick?" brain shared
// by aim assist, homing bullets, and enemy fire. A strategy is swappable like
// cameras/behaviors: each factory returns a selector
//   select(fromPos, candidates, ctx) -> entity | null
// where `fromPos` is the [x,y,z] doing the choosing, `candidates` is EITHER a
// plain array of entities or a registry-like with `.each(fn)`, and each entity
// has `.pos` (+ optional `.hp`). Pick one wherever you need a target:
//   const pick = targeting.nearest();
//   const foe  = pick(bullet.pos, ctx.registries.enemies, ctx);   // or null
//
// Pure and deterministic (given ctx.rng); no world/DOM/timers, so every variant
// unit-tests against a fake array of {pos,hp}. Empty/all-dead input -> null.

// Walk either an array or a registry (.each) uniformly, skipping the dead.
function forEach(candidates, fn) {
  if (!candidates) return;
  if (typeof candidates.each === 'function') { candidates.each((e) => { if (e && !e.dead) fn(e); }); return; }
  for (let i = 0; i < candidates.length; i++) { const e = candidates[i]; if (e && !e.dead) fn(e); }
}
function dist2(a, p) {                          // squared XZ distance (cheap compare)
  const dx = p[0] - a[0], dz = p[2] - a[2];
  return dx * dx + dz * dz;
}
const hpOf = (e) => (e.hp != null ? e.hp : Infinity);

// Generic "keep the entity that wins on score(e) vs the running best" scan.
function extremum(candidates, score, keepHigher) {
  let best = null, bestS = keepHigher ? -Infinity : Infinity;
  forEach(candidates, (e) => {
    const s = score(e);
    if (keepHigher ? s > bestS : s < bestS) { bestS = s; best = e; }
  });
  return best;
}

export function nearest() {
  // Closest candidate to fromPos — the default for aim assist and homing.
  return (from, candidates) => extremum(candidates, (e) => dist2(from, e.pos), false);
}

export function farthest() {
  // Most distant candidate — snipers, artillery, "pick off the stragglers."
  return (from, candidates) => extremum(candidates, (e) => dist2(from, e.pos), true);
}

export function lowestHp() {
  // Weakest target — finish off the almost-dead (focus fire). Ties: first seen.
  return (from, candidates) => extremum(candidates, (e) => hpOf(e), false);
}

export function highestHp() {
  // Toughest target — chip the tank / the boss first.
  return (from, candidates) => extremum(candidates, (e) => hpOf(e), true);
}

export function random({ rng } = {}) {
  // Uniform random pick (reservoir sampling — one pass, no array copy). Uses the
  // rng passed here, else ctx.rng; falls back to nearest-ish determinism (index 0)
  // when no rng is available, so it never calls Math.random.
  return (from, candidates, ctx) => {
    const r = rng || (ctx && ctx.rng);
    let chosen = null, n = 0;
    forEach(candidates, (e) => {
      n++;
      // keep e with probability 1/n → uniform over all seen; no rng → first one.
      if (n === 1 || (r && r.next() < 1 / n)) chosen = e;
    });
    return chosen;
  };
}

export function inCone({ dir = [0, 1], arcDeg = 60, range = Infinity } = {}) {
  // Nearest candidate inside an aim cone: within `range` AND within ±arcDeg/2 of
  // `dir` (an XZ vector, need not be unit). For directional weapons / vision.
  // `dir` can be overridden per-call via ctx.aimDir (a live facing vector).
  const cosHalf = Math.cos((arcDeg * Math.PI / 180) / 2);
  const r2 = range === Infinity ? Infinity : range * range;
  return (from, candidates, ctx) => {
    let d = (ctx && ctx.aimDir) || dir;
    const dl = Math.hypot(d[0], d[1]) || 1, dx0 = d[0] / dl, dz0 = d[1] / dl;
    let best = null, bestD = Infinity;
    forEach(candidates, (e) => {
      const ex = e.pos[0] - from[0], ez = e.pos[2] - from[2];
      const d2 = ex * ex + ez * ez;
      if (d2 > r2) return;
      const el = Math.sqrt(d2) || 1;
      const dot = (ex / el) * dx0 + (ez / el) * dz0;   // cos(angle to aim)
      if (dot < cosHalf) return;                        // outside the arc
      if (d2 < bestD) { bestD = d2; best = e; }
    });
    return best;
  };
}

export function mostClustered({ radius = 4 } = {}) {
  // Aim where the swarm is thickest: pick the candidate with the most neighbors
  // within `radius` (O(n²), fine for arena counts). Great for AoE/rockets.
  const r2 = radius * radius;
  return (from, candidates) => {
    const list = [];
    forEach(candidates, (e) => list.push(e));
    if (!list.length) return null;
    let best = list[0], bestC = -1;
    for (let i = 0; i < list.length; i++) {
      let c = 0;
      for (let j = 0; j < list.length; j++) {
        if (i === j) continue;
        if (dist2(list[i].pos, list[j].pos) <= r2) c++;
      }
      if (c > bestC) { bestC = c; best = list[i]; }
    }
    return best;
  };
}

export function leastRecent() {
  // Round-robin: spread attention across the swarm by preferring whoever was
  // chosen longest ago. Remembers picks in a per-selector WeakSet — once every
  // live candidate has been hit the set clears and a new round begins. Deterministic
  // (no rng): among unseen candidates it takes the nearest to fromPos.
  let seen = new WeakSet();
  const near = nearest();
  return (from, candidates, ctx) => {
    // gather the not-yet-seen; if all seen, start a fresh round.
    let unseen = [], any = false;
    forEach(candidates, (e) => { any = true; if (!seen.has(e)) unseen.push(e); });
    if (!any) return null;
    if (!unseen.length) { seen = new WeakSet(); forEach(candidates, (e) => unseen.push(e)); }
    const chosen = near(from, unseen, ctx);
    if (chosen) seen.add(chosen);
    return chosen;
  };
}

export const targeting = {
  nearest, farthest, lowestHp, highestHp, random, inCone, mostClustered, leastRecent,
};
