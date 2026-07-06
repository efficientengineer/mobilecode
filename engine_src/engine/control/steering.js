// engine/control/steering.js
// Reusable STEERING primitives — the low-level building blocks that higher-level
// brains (behaviors.js) compose. Where a behavior is a whole "step the entity"
// controller, a steering primitive is smaller and pure: each returns a DESIRED
// VELOCITY vector [x,0,z] and touches nothing. You add them up, weight them, and
// clamp with combine() to get one movement each frame.
//
// A game rarely picks these directly; a behavior does:
//   import { steering as S } from '../control/steering.js'
//   const v = S.combine([
//     { v: S.seek(e.pos, t.pos, 4),                weight: 1 },
//     { v: S.separation(e.pos, near, 2, 4),        weight: 1.5 },
//   ]);                                    // -> [x,0,z], length clamped to maxSpeed
//   e.vel[0] = v[0]; e.vel[1] = 0; e.vel[2] = v[2];
//
// Pure vector math, no per-frame side effects (except wander, which advances a
// heading you hand it in `state`). Fully sim-testable under node.

const EPS = 1e-9;

// --- tiny [x,z] helpers (y is always 0 — this engine steers on the ground plane)
function len(x, z) { return Math.hypot(x, z); }
function unit(x, z) {                 // normalized [x,z], or [0,0] if degenerate
  const l = len(x, z);
  return l < EPS ? [0, 0] : [x / l, z / l];
}
function vec(x, z) { return [x, 0, z]; }        // pack into the engine's [x,y,z]
const ZERO = [0, 0, 0];

export function seek(fromPos, toPos, speed = 3) {
  // Desired velocity straight AT the goal at full speed. The atom of "go there".
  const [ux, uz] = unit(toPos[0] - fromPos[0], toPos[2] - fromPos[2]);
  return vec(ux * speed, uz * speed);
}

export function flee(fromPos, fromTarget, speed = 3) {
  // Desired velocity straight AWAY from a point — the mirror of seek.
  const [ux, uz] = unit(fromPos[0] - fromTarget[0], fromPos[2] - fromTarget[2]);
  return vec(ux * speed, uz * speed);
}

export function arrive(fromPos, toPos, speed = 3, slowRadius = 3) {
  // Like seek, but ease off inside slowRadius so the entity settles ON the goal
  // instead of jittering past it. Speed ramps linearly from the edge to 0.
  const dx = toPos[0] - fromPos[0], dz = toPos[2] - fromPos[2];
  const d = len(dx, dz);
  if (d < EPS) return vec(0, 0);
  const ramp = slowRadius > EPS ? Math.min(1, d / slowRadius) : 1;
  const s = speed * ramp;
  return vec((dx / d) * s, (dz / d) * s);
}

export function pursue(self, target, speed = 3) {
  // Seek where the target WILL be, not where it is: project its position forward
  // by a lead time that grows with distance and shrinks with our own speed. Give
  // it {pos,vel}; if the target isn't moving this degrades to a plain seek.
  const tv = target.vel || ZERO;
  const dx = target.pos[0] - self.pos[0], dz = target.pos[2] - self.pos[2];
  const lead = (speed > EPS ? len(dx, dz) / speed : 0);   // seconds to close gap
  const px = target.pos[0] + tv[0] * lead;
  const pz = target.pos[2] + tv[2] * lead;
  return seek(self.pos, [px, 0, pz], speed);
}

export function evade(self, target, speed = 3) {
  // Pursue in reverse: flee from where the threat is HEADED, so you dodge the
  // interception instead of the stale position. The classic "don't get caught".
  const tv = target.vel || ZERO;
  const dx = target.pos[0] - self.pos[0], dz = target.pos[2] - self.pos[2];
  const lead = (speed > EPS ? len(dx, dz) / speed : 0);
  const px = target.pos[0] + tv[0] * lead;
  const pz = target.pos[2] + tv[2] * lead;
  return flee(self.pos, [px, 0, pz], speed);
}

export function separation(selfPos, neighborsPos = [], radius = 2, speed = 3) {
  // Anti-crowding push: sum a repulsion from every neighbor within `radius`,
  // weighted 1/distance so the closer they are the harder they shove. Returns a
  // zero vector when nobody's near. Feed it a flock and add it to your seek.
  let ax = 0, az = 0;
  for (let i = 0; i < neighborsPos.length; i++) {
    const n = neighborsPos[i];
    const dx = selfPos[0] - n[0], dz = selfPos[2] - n[2];
    const d = len(dx, dz);
    if (d < EPS || d > radius) continue;          // itself, or out of range
    const w = 1 / d;                              // closer => stronger
    ax += (dx / d) * w; az += (dz / d) * w;
  }
  const [ux, uz] = unit(ax, az);
  return vec(ux * speed, uz * speed);
}

export function wander(state = {}, { speed = 3, jitter = 0.5, turn = Math.PI } = {}) {
  // Smooth roaming: keep a heading on `state.heading` and nudge it by a small
  // random-ish step each call, so the path curves instead of twitching. Unlike
  // the others this MUTATES the state you pass (so the heading persists), but the
  // returned vector is still pure output. Pass state.rng for determinism.
  if (state.heading == null) state.heading = 0;
  const r = state.rng ? state.rng.next() : 0.5;   // deterministic if given an rng
  state.heading += (r - 0.5) * 2 * jitter * turn;  // wobble the aim, bounded
  return vec(Math.sin(state.heading) * speed, Math.cos(state.heading) * speed);
}

export function combine(parts = [], maxSpeed = Infinity) {
  // Blend a list of weighted desires into ONE velocity, then clamp its length to
  // maxSpeed. This is how a behavior mixes primitives: seek + separation + a dash
  // of wander, each with a weight. Zero/empty in => zero out.
  let x = 0, z = 0;
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]; if (!p || !p.v) continue;
    const w = p.weight != null ? p.weight : 1;
    x += p.v[0] * w; z += p.v[2] * w;
  }
  const l = len(x, z);
  if (l > maxSpeed && l > EPS) { const s = maxSpeed / l; x *= s; z *= s; }
  return vec(x, z);
}

export const steering = {
  seek, flee, arrive, pursue, evade, separation, wander, combine,
};
