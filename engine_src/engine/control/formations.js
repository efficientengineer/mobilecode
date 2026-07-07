// engine/control/formations.js
// Reusable FORMATION positioning — a swappable component like cameras/behaviors.
// Given a leader (pos + facing), each factory answers "where should slot N of a
// squad of `count` stand?" as a world target the followers then steer toward:
//   const fmt = formations.wedge({ gap: 2 });
//   const target = fmt(i, squad.length, leader.pos, leader.rot); // -> [x,0,z]
//   const v = steering.arrive(e.pos, target, e.speed); e.vel[0]=v[0]; e.vel[2]=v[2];
//
// Pure math, no state — one instance drives a whole squad. Slots are computed in
// the leader's LOCAL frame (local +z is "forward", +x is "right") then rotated by
// leaderRot, so the whole shape turns to face wherever the leader faces. This is
// the counterpart to steering.js: formations pick the goal, arrive() walks to it.

// Rotate a local offset (right = lx, forward = lz) into world space by `rot`,
// matching the engine's facing convention (forward = [sin rot, cos rot]).
function rot2(lx, lz, rot) {
  const s = Math.sin(rot || 0), c = Math.cos(rot || 0);
  return [lx * c + lz * s, -lx * s + lz * c];   // [worldX, worldZ]
}
// Pack a local offset onto the leader position as a [x,0,z] world target.
function place(leaderPos, lx, lz, rot) {
  const [wx, wz] = rot2(lx, lz, rot);
  return [leaderPos[0] + wx, 0, leaderPos[2] + wz];
}

export function line({ gap = 2 } = {}) {
  // Side by side on the leader's flank line — a firing rank / shield wall. Slots
  // spread left/right, centered so the middle slot sits on the leader.
  return (index, count, leaderPos, leaderRot) => {
    const lx = (index - (count - 1) / 2) * gap;   // centered along local right
    return place(leaderPos, lx, 0, leaderRot);
  };
}

export function column({ gap = 2 } = {}) {
  // Single file directly behind the leader — a marching convoy / snake escort.
  // Slot 0 is one `gap` back; each further slot trails one more `gap`.
  return (index, count, leaderPos, leaderRot) => {
    const lz = -(index + 1) * gap;                // straight back (local -z)
    return place(leaderPos, 0, lz, leaderRot);
  };
}

export function wedge({ gap = 2, angleDeg = 45 } = {}) {
  // V / arrowhead with the leader at the tip. Slots alternate to the left and
  // right flanks, each pair one rank deeper — a flying-V or spearhead charge.
  const a = (angleDeg * Math.PI) / 180;
  const sinA = Math.sin(a), cosA = Math.cos(a);
  return (index, count, leaderPos, leaderRot) => {
    const rank = Math.floor(index / 2) + 1;       // 1,1,2,2,3,3,...
    const side = index % 2 === 0 ? -1 : 1;        // even = left wing, odd = right
    const lx = side * rank * gap * sinA;
    const lz = -rank * gap * cosA;                // trailing behind the tip
    return place(leaderPos, lx, lz, leaderRot);
  };
}

export function circle({ radius = 4 } = {}) {
  // Ring around the leader — a bodyguard cordon / defensive halo. Slots split the
  // circle evenly; the ring rotates with the leader's facing so slot 0 leads.
  return (index, count, leaderPos, leaderRot) => {
    const n = Math.max(1, count);
    const ang = (index / n) * Math.PI * 2;        // even split, slot 0 at front
    const lx = Math.sin(ang) * radius, lz = Math.cos(ang) * radius;
    return place(leaderPos, lx, lz, leaderRot);
  };
}

export function grid({ cols = 3, gap = 2 } = {}) {
  // Rows-and-columns block behind the leader — a phalanx / marching band. Fills
  // left-to-right, front-to-back; columns centered, rows trail into the distance.
  const c = Math.max(1, cols | 0);
  return (index, count, leaderPos, leaderRot) => {
    const col = index % c, row = Math.floor(index / c);
    const lx = (col - (c - 1) / 2) * gap;         // centered across the front
    const lz = -row * gap;                        // rank 0 alongside the leader
    return place(leaderPos, lx, lz, leaderRot);
  };
}

export function echelon({ gap = 2 } = {}) {
  // Diagonal stagger — each unit one step back AND one step to the flank, a
  // slanted line (classic echelon-right formation, good for strafing runs).
  return (index, count, leaderPos, leaderRot) => {
    const step = index + 1;                       // leader is the head of the line
    return place(leaderPos, step * gap, -step * gap, leaderRot);
  };
}

export const formations = {
  line, column, wedge, circle, grid, echelon,
};
