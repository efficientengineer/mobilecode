// engine/control/squad.js
// GROUP TACTICS — the coordination brain that sits ABOVE behaviors.js and steers a
// whole PACK of enemies as one smart unit. behaviors.js drives one entity in
// isolation; squad.js votes on a shared plan and stamps per-entity ORDERS the
// behavior then obeys. Make one per pack:
//   const pack = squad.makeSquad({ flankers: 0.5, maxAttackers: 3 });
//   enemies.each(e => pack.join(e));                      // enroll on spawn
//   // each frame, before ai:
//   pack.update(enemies.query(x=>!x.dead), player, dt);   // writes e._squad
//   // then a behavior reads the order and moves the entity:
//   const o = e._squad;  const v = steering.arrive(e.pos, o.slot, e.speed);
//   e.vel[0]=v[0]+o.spacing[0]; e.vel[2]=v[2]+o.spacing[1];
//
// Orders written onto e._squad each update (PURE DATA — squad never moves the
// entity, the behavior/steering does):
//   target   focus-fired enemy the whole pack agrees to gang up on (or null)
//   role     'flank' | 'press'  — flankers swing wide, pressers bore straight in
//   angle    flank bearing offset in radians (0 for pressers)
//   engage   true = attack now; false = hang back and circle (staggered assault)
//   slot     [x,0,z] world point this member should move to this frame
//   spacing  [x,z] anti-stack separation push to add on top of the slot approach
//   centroid [x,y,z] pack center (handy for regroup / camera / director)
//
// Pure + deterministic (no window/DOM/timers/Math.random — pass cfg.rng if a tie
// ever needs breaking randomly). Per-entity state lives on e._squad; the pack's
// own roster is a plain Set, so it sim-tests with fake entities and dt stepping.

// -------- vector scratch (XZ ground plane; forward = [sin,cos] like behaviors) --

function dist2(ax, az, bx, bz) { const dx = ax - bx, dz = az - bz; return dx * dx + dz * dz; }
function alive(e) { return e && !e.dead; }
function order(e) { return e._squad || (e._squad = {}); }

// Average position of a member list -> [x,y,z]. Empty -> origin. The pack's center
// of mass: focus voting biases toward it, and a leaderless pack regroups on it.
export function centroid(members) {
  let x = 0, y = 0, z = 0, n = 0;
  for (const e of members) {
    if (!alive(e)) continue;
    x += e.pos[0]; y += e.pos[1]; z += e.pos[2]; n++;
  }
  if (!n) return [0, 0, 0];
  return [x / n, y / n, z / n];
}

// Vote a single shared focus target out of `candidates`. Emergent, not dictated:
// every living member casts ONE ballot for the candidate it would personally pick
// under `strategy`, and the winner is whoever the pack collectively wants most —
// so the swarm naturally converges on the enemy the majority can reach.
//   'nearest'    each votes for the candidate nearest ITSELF (converge on the
//                target most of the pack is already facing) — default
//   'lowestHp'   everyone votes to finish the weakest (unanimous focus fire)
//   'centroid'   each votes for the candidate nearest the pack's center of mass
// Ties break toward the candidate closest to the centroid, then by first seen.
export function focusTarget(members, candidates, strategy = 'nearest') {
  const cand = [];
  if (candidates) for (const c of (candidates.length != null ? candidates : [])) if (alive(c)) cand.push(c);
  if (!cand.length) return null;
  const live = []; for (const e of members) if (alive(e)) live.push(e);
  const cen = centroid(live.length ? live : cand);

  // Precompute the global pick for strategies that don't depend on the voter.
  const weakest = () => {
    let best = null, bh = Infinity;
    for (const c of cand) { const h = c.hp != null ? c.hp : Infinity; if (h < bh) { bh = h; best = c; } }
    return best;
  };
  const nearestTo = (px, pz) => {
    let best = cand[0], bd = Infinity;
    for (const c of cand) { const d = dist2(c.pos[0], c.pos[2], px, pz); if (d < bd) { bd = d; best = c; } }
    return best;
  };

  const votes = new Map();
  const ballot = c => votes.set(c, (votes.get(c) || 0) + 1);
  if (!live.length) ballot(strategy === 'lowestHp' ? weakest() : nearestTo(cen[0], cen[2]));
  else for (const e of live) {
    if (strategy === 'lowestHp') ballot(weakest());
    else if (strategy === 'centroid') ballot(nearestTo(cen[0], cen[2]));
    else ballot(nearestTo(e.pos[0], e.pos[2]));       // 'nearest'
  }

  // Winner = most ballots; tie -> closer to centroid, then earlier in `cand`.
  let win = null, wv = -1, wd = Infinity;
  for (const c of cand) {
    const v = votes.get(c) || 0; if (v === 0 && win) continue;
    const d = dist2(c.pos[0], c.pos[2], cen[0], cen[2]);
    if (v > wv || (v === wv && d < wd)) { win = c; wv = v; wd = d; }
  }
  return win;
}

// Split the pack into flankers and pressers and stamp e._squad.role/.angle.
// `flankers` is a COUNT (>=1) or a FRACTION (0..1) of the pack; the flank wing is
// drawn from the members FARTHEST out (they're already positioned to swing wide,
// leaving the front-runners to press), and flankers alternate to opposite sides so
// the pack pincers instead of bunching on one hip.
export function assignRoles(members, { flankers = 0.5, spreadDeg = 55, target = null } = {}) {
  const live = []; for (const e of members) if (alive(e)) live.push(e);
  const n = live.length;
  const k = Math.max(0, Math.min(n, flankers <= 1 && flankers > 0 ? Math.round(n * flankers)
    : flankers > 1 ? Math.floor(flankers) : flankers === 1 ? n : 0));
  const spread = (spreadDeg * Math.PI) / 180;
  // Rank by distance to the target (or centroid) descending — outermost first.
  const ref = target && target.pos ? target.pos : centroid(live);
  const ranked = live.map(e => ({ e, d: dist2(e.pos[0], e.pos[2], ref[0], ref[2]) }))
    .sort((a, b) => b.d - a.d);
  let side = 1, flanked = 0;
  for (let i = 0; i < ranked.length; i++) {
    const o = order(ranked[i].e);
    if (i < k) { o.role = 'flank'; o.angle = spread * side; side = -side; flanked++; }
    else { o.role = 'press'; o.angle = 0; }
  }
  return { flankers: flanked, pressers: n - flanked };
}

export function makeSquad(cfg = {}) {
  // A coordinated pack. Enroll members with join(); each frame call update() with
  // the live members and the target(s), then let each member's behavior read the
  // order off e._squad. Defaults tuned for a ~4-8 strong melee/harass pack.
  const {
    focus = 'nearest',          // focusTarget voting strategy
    flankers = 0.5,             // share of the pack that swings wide
    spreadDeg = 55,             // how far flankers arc off the direct bearing
    maxAttackers = 3,           // staggered assault: only this many engage at once
    engageRange = 2.2,          // how close an attacker presses to the target
    waitRange = 7,              // radius the benched members circle at
    spacing = 2.5,              // personal-space radius; closer neighbors push apart
    push = 1,                   // strength of the anti-stack separation
    rng = null,                 // optional, only for random tie-breaks
  } = cfg;

  const roster = new Set();
  function join(e) { if (e) { roster.add(e); order(e); } return e; }
  function leave(e) { if (e) { roster.delete(e); if (e._squad) e._squad = undefined; } }

  function update(members, target, dt) {
    // Accept the caller's live list, or fall back to the roster (minus the dead).
    const live = [];
    const src = members && members.length != null ? members : roster;
    for (const e of src) if (alive(e) && (members || roster.has(e))) live.push(e);
    const cen = centroid(live);
    if (!live.length) return null;

    // 1. FOCUS FIRE — one shared target. `target` may be a single entity or a list
    //    of candidates to vote among; a single entity is honored as-is.
    let tgt;
    if (target && target.pos && target.length == null) tgt = alive(target) ? target : null;
    else tgt = focusTarget(live, target, focus);

    // 2. ROLES — flank wing vs. pressers, oriented around the chosen target.
    assignRoles(live, { flankers, spreadDeg, target: tgt });

    // 3. STAGGERED ENGAGEMENT — the nearest `maxAttackers` commit; the rest wait
    //    and circle, so the pack trades off instead of dogpiling into a wall.
    const tp = tgt ? tgt.pos : cen;
    const byRange = live.slice().sort((a, b) =>
      dist2(a.pos[0], a.pos[2], tp[0], tp[2]) - dist2(b.pos[0], b.pos[2], tp[0], tp[2]));
    const cap = maxAttackers == null ? live.length : maxAttackers;

    for (let i = 0; i < byRange.length; i++) {
      const e = byRange[i], o = order(e);
      o.target = tgt; o.centroid = cen;
      o.engage = tgt ? i < cap : false;

      // 4. SLOT — a world point to move to. Take the member's current bearing FROM
      //    the target, rotate it by the flank angle, and stand off at the engage or
      //    wait radius. No target -> regroup on the pack centroid.
      if (!tgt) { o.slot = [cen[0], 0, cen[2]]; }
      else {
        let bx = e.pos[0] - tp[0], bz = e.pos[2] - tp[2];
        const bl = Math.hypot(bx, bz);
        let b = bl > 1e-4 ? Math.atan2(bx, bz)
          : (rng ? rng.range(-Math.PI, Math.PI) : (i / byRange.length) * Math.PI * 2);
        b += o.angle;                               // flankers curl off to the side
        const r = o.engage ? engageRange : waitRange;
        o.slot = [tp[0] + Math.sin(b) * r, 0, tp[2] + Math.cos(b) * r];
      }

      // 5. SPACING — sum a repulsion from every neighbor inside `spacing`, so bodies
      //    never stack. Reported separately; the behavior adds it to its approach.
      let sx = 0, sz = 0;
      for (const other of live) {
        if (other === e) continue;
        const dx = e.pos[0] - other.pos[0], dz = e.pos[2] - other.pos[2];
        const d = Math.hypot(dx, dz);
        if (d < spacing && d > 1e-4) { const w = (spacing - d) / spacing; sx += (dx / d) * w; sz += (dz / d) * w; }
      }
      o.spacing = [sx * push, sz * push];
    }
    return tgt;
  }

  return { join, leave, update, roster };
}

export const squad = { makeSquad, centroid, assignRoles, focusTarget };
