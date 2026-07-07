// engine/control/pathing.js
// Reusable PATHING controllers — route FOLLOWING and simple grid navigation, one
// rung ABOVE the steering primitives (steering.js) and a sibling of behaviors.js.
// Where a steering atom answers "what velocity points at this one spot?", a
// pathing controller owns a whole ROUTE: which waypoint we're on, when to advance,
// whether to loop / bounce / wait, and how to pick a step around blocked cells.
//
// Route followers return a stepper:
//   step(entity, dt) -> [x,0,z]   // desired velocity; also written to e.vel
// with per-entity progress kept on e._path, so ONE instance drives a whole
// registry without cross-talk (behaviors.js / projectiles.js e._m style).
//
// gridNav is the odd one out: a PURE planner given a `passable(cx,cz)->bool`
// predicate (no world access), exposing stepToward(fromPos, goalPos) -> [x,z].
//
// All node-safe: no window/DOM/timers, no Math.random. Fully sim-testable.

const EPS = 1e-9;

// --- tiny [x,z] helpers (y stays 0 — this engine navigates the ground plane)
function len(x, z) { return Math.hypot(x, z); }
function vec(x, z) { return [x, 0, z]; }          // pack into the engine's [x,y,z]
function path(e) { return e._path || (e._path = {}); }   // per-entity progress
function drive(e, v) {                              // write velocity + face heading
  e.vel[0] = v[0]; e.vel[1] = 0; e.vel[2] = v[2];
  if (v[0] || v[2]) e.rot = Math.atan2(v[0], v[2]);
  return v;
}
function toward(fromPos, wp, speed) {              // full-speed velocity at a [x,z]
  const dx = wp[0] - fromPos[0], dz = wp[1] - fromPos[2];
  const d = len(dx, dz);
  if (d < EPS) return vec(0, 0);
  return vec((dx / d) * speed, (dz / d) * speed);
}

export function followPath({ points = [], loop = true, arrive = 0.4, speed = 3 } = {}) {
  // Walk a fixed route [[x,z],...] waypoint by waypoint. Advance to the next once
  // within `arrive` of the current one; `loop` wraps back to the start, otherwise
  // it parks on the final point. Progress (the current index + a `done` flag)
  // rides on e._path so the one instance steers a whole squad down the same road.
  return (e, dt) => {
    if (!points.length) return drive(e, vec(0, 0));
    const st = path(e);
    if (st.i == null) st.i = 0;
    if (st.done) return drive(e, vec(0, 0));        // parked at the end (no loop)
    const wp = points[st.i];
    const dx = wp[0] - e.pos[0], dz = wp[1] - e.pos[2];
    if (len(dx, dz) <= arrive) {                    // reached this waypoint
      if (st.i >= points.length - 1) {
        if (loop) st.i = 0; else { st.done = true; return drive(e, vec(0, 0)); }
      } else st.i++;
    }
    return drive(e, toward(e.pos, points[st.i], speed));
  };
}

export function pingPong({ points = [], arrive = 0.4, speed = 3 } = {}) {
  // Bounce back and forth along the route instead of looping: run to the last
  // waypoint, then reverse and run back to the first, forever. `dir` (+1/-1) lives
  // on e._path. With 2 points this is a simple shuttle between two spots.
  return (e, dt) => {
    if (!points.length) return drive(e, vec(0, 0));
    const st = path(e);
    if (st.i == null) { st.i = 0; st.dir = 1; }
    if (points.length === 1) return drive(e, toward(e.pos, points[0], speed));
    const wp = points[st.i];
    const dx = wp[0] - e.pos[0], dz = wp[1] - e.pos[2];
    if (len(dx, dz) <= arrive) {
      if (st.i + st.dir > points.length - 1) st.dir = -1;   // hit the far end
      else if (st.i + st.dir < 0) st.dir = 1;               // back at the start
      st.i += st.dir;
    }
    return drive(e, toward(e.pos, points[st.i], speed));
  };
}

export function patrolPath({ points = [], arrive = 0.4, wait = 0, loop = true, speed = 3 } = {}) {
  // followPath with a PAUSE at each waypoint — sentries that stop and look around.
  // On arrival it halts for `wait` seconds (counted down on e._path.wait) before
  // advancing. `wait` may be a number (same everywhere) or an array parallel to
  // points (per-stop dwell). Same loop/park semantics as followPath.
  const waitAt = (i) => (Array.isArray(wait) ? (wait[i] || 0) : wait);
  return (e, dt = 0) => {
    if (!points.length) return drive(e, vec(0, 0));
    const st = path(e);
    if (st.i == null) st.i = 0;
    if (st.done) return drive(e, vec(0, 0));
    if (st.wait > 0) { st.wait -= dt; return drive(e, vec(0, 0)); }   // dwelling
    const wp = points[st.i];
    const dx = wp[0] - e.pos[0], dz = wp[1] - e.pos[2];
    if (len(dx, dz) <= arrive) {
      st.wait = waitAt(st.i);                       // start the dwell for this stop
      if (st.i >= points.length - 1) {
        if (loop) st.i = 0; else st.done = true;
      } else st.i++;
      return drive(e, vec(0, 0));
    }
    return drive(e, toward(e.pos, points[st.i], speed));
  };
}

export function lerpTo({ speed = 6, arrive = 0.05 } = {}) {
  // Ease toward a MOVING goal exponentially: each step closes a fraction of the
  // remaining gap (frame-rate independent via 1 - e^(-speed*dt)), so it glides in
  // and settles softly. Great for a soft-follow companion, a camera dolly target,
  // or a homing pull. Returns the velocity that would carry it there this frame;
  // also writes e.pos-independent velocity so movement.js integrates it.
  return (e, goalPos, dt = 0) => {
    if (!goalPos) return drive(e, vec(0, 0));
    const gx = goalPos[0], gz = goalPos[2] != null ? goalPos[2] : goalPos[1];
    const dx = gx - e.pos[0], dz = gz - e.pos[2];
    if (len(dx, dz) <= arrive) return drive(e, vec(0, 0));
    const k = dt > 0 ? 1 - Math.exp(-speed * dt) : 1;   // fraction to close now
    return drive(e, vec((dx * k) / (dt || 1), (dz * k) / (dt || 1)));
  };
}

export function gridNav({ cell = 1, passable = () => true } = {}) {
  // Greedy 8-direction grid planner. PURE: it never reads the world — you hand it
  // a `passable(cx,cz) -> bool` predicate over integer cell coords, and it hands
  // back the next [x,z] world position to walk to. From the cell holding `fromPos`
  // it scores the 8 neighbours by how much closer they get to the goal cell,
  // skipping blocked cells (and diagonals that would cut a blocked corner), and
  // returns the CENTER of the best open neighbour — or the current cell's center
  // when boxed in. Chain calls to crawl a route one cell at a time; no allocation
  // of a full A* path, which suits swarms on mobile.
  const toCell = (w) => Math.floor(w / cell);
  const toWorld = (c) => (c + 0.5) * cell;
  const open = (cx, cz) => { try { return !!passable(cx, cz); } catch { return false; } };
  return {
    // expose the coordinate maps so callers can align entities to the grid
    toCell, toWorld,
    stepToward(fromPos, goalPos) {
      const cx = toCell(fromPos[0]), cz = toCell(fromPos[2]);
      const gx = toCell(goalPos[0]), gz = toCell(goalPos[2]);
      if (cx === gx && cz === gz) return [toWorld(gx), toWorld(gz)];   // arrived
      const base = len(gx - cx, gz - cz);
      let best = null, bestScore = 0;                 // score = distance improved
      for (let dx = -1; dx <= 1; dx++) {
        for (let dz = -1; dz <= 1; dz++) {
          if (!dx && !dz) continue;
          const nx = cx + dx, nz = cz + dz;
          if (!open(nx, nz)) continue;
          if (dx && dz && (!open(cx + dx, cz) || !open(cx, cz + dz))) continue; // no corner cut
          const score = base - len(gx - nx, gz - nz);
          if (score > bestScore + EPS) { bestScore = score; best = [nx, nz]; }
        }
      }
      if (!best) return [toWorld(cx), toWorld(cz)];    // boxed in — hold position
      return [toWorld(best[0]), toWorld(best[1])];
    },
  };
}

export const pathing = {
  followPath, pingPong, patrolPath, lerpTo, gridNav,
};
