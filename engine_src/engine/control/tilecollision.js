// engine/control/tilecollision.js
// Reusable TILE-COLLISION resolution — the WORLD-layer piece a top-down
// adventure/dungeon game needs and the engine currently lacks. The built-in
// collision system is entity-vs-entity (overlap -> events); this one resolves an
// entity moving against SOLID TILES so it stops at walls and SLIDES along them
// instead of sticking — the feel of Zelda: A Link to the Past room navigation.
//
// The core is:
//   moveAndCollide(entity, dx, dz, isSolid, { size, tileSize, cornerCut })
// which moves an AABB (half-extent `size`, a circle radius in spirit) by (dx,dz)
// but SEPARATES THE AXES: try X and snap flush if it hits a solid tile, then try
// Z and snap flush — so a diagonal into a wall keeps the free axis and slides.
// `isSolid(tx,tz) -> bool` is supplied by the game (e.g. a tilemap.isSolid) over
// INTEGER tile coords; this file never reads the world, only that predicate — the
// same predicate pathing.gridNav consumes, so the two agree on what a wall is.
//
// Also here: resolveCircleVsTiles (depenetrate a body already inside solids),
// rayTile (first solid tile a ray crosses — line-of-sight / aim / hitscan) and a
// `cornerCut` option that rounds convex corners so the player slips past a lip
// instead of catching on it.
//
// Ground plane is XZ (y is up, untouched). Pure math: no window/DOM/timers, no
// Math.random, state only on the passed entity — deterministic and node-testable.

const EPS = 1e-9;

// --- tiny grid helpers -------------------------------------------------------
function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
// Rightmost tile index a right/top box edge at world `v` overlaps (right-open
// tiles [t*ts,(t+1)*ts)): an edge exactly on a boundary belongs to the LOWER tile.
function edgeMax(v, ts) { return Math.ceil(v / ts) - 1; }
// Solidity query, hardened like pathing.gridNav: a throwing/garbage predicate
// reads as "solid" would be worse than "open", so out-of-bounds/errors = open.
function solid(isSolid, tx, tz) { try { return !!isSolid(tx, tz); } catch { return false; } }
// Pull [x,z] out of an [x,y,z] OR a flat [x,z] point.
function px(p) { return p[0]; }
function pz(p) { return p.length > 2 ? p[2] : p[1]; }
function py(p) { return p.length > 2 ? p[1] : 0; }

// World point -> integer tile coords [tx,tz].
export function tileOf(x, z, tileSize = 1) {
  return [Math.floor(x / tileSize), Math.floor(z / tileSize)];
}

// Does an AABB (center x,z, half-extent r) overlap ANY solid tile? Treats the
// body as a box so it matches the flush math in `sweep` exactly.
export function overlapsSolid(x, z, r, isSolid, tileSize = 1) {
  const ts = tileSize;
  const txMin = Math.floor((x - r) / ts), txMax = edgeMax(x + r, ts);
  const tzMin = Math.floor((z - r) / ts), tzMax = edgeMax(z + r, ts);
  for (let tx = txMin; tx <= txMax; tx++)
    for (let tz = tzMin; tz <= tzMax; tz++)
      if (solid(isSolid, tx, tz)) return true;
  return false;
}

// Sweep the box one axis. `a` is the moving coordinate, `b` the fixed one; `axis`
// is 'x' (a=worldX,b=worldZ) or 'z' (a=worldZ,b=worldX). Scans tile columns from
// the leading edge outward and, on the FIRST solid one, returns the coordinate
// that puts the box flush against that wall — so fast moves don't leave a gap and
// slow moves don't tunnel. { c: allowed coord, hit }.
function sweep(a, b, r, d, axis, isSolid, ts) {
  if (!d) return { c: a, hit: false };
  const pMin = Math.floor((b - r) / ts), pMax = edgeMax(b + r, ts);   // fixed perp span
  const cell = axis === 'x'
    ? (col, p) => solid(isSolid, col, p)      // a=X so col is tx, p is tz
    : (col, p) => solid(isSolid, p, col);     // a=Z so col is tz, p is tx
  if (d > 0) {
    const start = Math.floor((a + r) / ts), end = edgeMax(a + r + d, ts);
    for (let col = start; col <= end; col++)
      for (let p = pMin; p <= pMax; p++)
        if (cell(col, p)) { const wall = col * ts - r; return { c: wall > a ? wall : a, hit: true }; }
  } else {
    const start = Math.floor((a - r) / ts), end = Math.floor((a - r + d) / ts);
    for (let col = start; col >= end; col--)
      for (let p = pMin; p <= pMax; p++)
        if (cell(col, p)) { const wall = (col + 1) * ts + r; return { c: wall < a ? wall : a, hit: true }; }
  }
  return { c: a + d, hit: false };
}

// Corner rounding: when a mostly-single-axis push is blocked, try nudging the
// PERPENDICULAR coord (either way, up to `maxNudge`) so the primary move clears —
// this rounds a convex corner / slips the player into a doorway they clipped by a
// hair. Returns { c: new along coord, p: new perp coord } or null (no relief).
function cornerSlip(a, b, r, d, axis, isSolid, ts, maxNudge) {
  const SAMPLES = 6;
  for (let i = 1; i <= SAMPLES; i++) {
    const off = (maxNudge * i) / SAMPLES;
    for (const s of [1, -1]) {
      const nb = b + s * off;
      const clear = axis === 'x'
        ? !overlapsSolid(a, nb, r, isSolid, ts)   // shifting there must itself be open
        : !overlapsSolid(nb, a, r, isSolid, ts);
      if (!clear) continue;
      const sw = sweep(a, nb, r, d, axis, isSolid, ts);
      if (!sw.hit) return { c: sw.c, p: nb };     // primary move now goes through
    }
  }
  return null;
}

// Move `entity` by (dx,dz) resolved against solid tiles, axis-separated so it
// slides along walls. Writes entity.pos (y untouched) and returns
//   { moved:[mx,mz], hitX, hitZ }
// where moved is the displacement ACTUALLY applied on each axis (0 = fully
// stopped that axis) and hitX/hitZ flag which axis touched a wall.
// opts: { size=0.4 (body half-extent), tileSize=1, cornerCut=0 (max corner
// nudge; 0 = off — try ~0.4*size for a forgiving feel) }.
export function moveAndCollide(entity, dx, dz, isSolid, opts = {}) {
  const ts = opts.tileSize != null ? opts.tileSize : 1;
  const r = opts.size != null ? opts.size : 0.4;
  const cc = opts.cornerCut || 0;
  const p = entity.pos;
  const ox = p[0], oz = p[2];
  let x = ox, z = oz;

  // --- X axis
  const sx = sweep(x, z, r, dx, 'x', isSolid, ts);
  let hitX = sx.hit; x = sx.c;
  if (cc && hitX && Math.abs(dx) >= Math.abs(dz)) {          // round the corner in X
    const slip = cornerSlip(ox, oz, r, dx, 'x', isSolid, ts, cc);
    if (slip) { x = slip.c; z = slip.p; hitX = false; }
  }

  // --- Z axis (from the possibly corner-nudged z)
  const sz = sweep(z, x, r, dz, 'z', isSolid, ts);
  let hitZ = sz.hit; z = sz.c;
  if (cc && hitZ && Math.abs(dz) > Math.abs(dx)) {           // round the corner in Z
    const slip = cornerSlip(z === sz.c ? oz : z, x, r, dz, 'z', isSolid, ts, cc);
    if (slip) { z = slip.c; x = slip.p; hitZ = false; }
  }

  p[0] = x; p[2] = z;
  return { moved: [x - ox, z - oz], hitX, hitZ };
}

// Push a circle (center `pos`, `radius`) OUT of any solid tiles it overlaps —
// depenetration for spawns, teleports, knockback, or a body a moving wall shoved
// into. Resolves against the deepest offender then re-checks a few times so a
// body wedged in a corner pops cleanly out. PURE: returns a fresh
//   { pos:[x,y,z], push:[px,pz], hit }
// and never mutates the input point.
export function resolveCircleVsTiles(pos, radius, isSolid, tileSize = 1) {
  const ts = tileSize, y = py(pos);
  let x = px(pos), z = pz(pos), pushX = 0, pushZ = 0, hit = false;
  for (let iter = 0; iter < 4; iter++) {
    const txMin = Math.floor((x - radius) / ts), txMax = edgeMax(x + radius, ts);
    const tzMin = Math.floor((z - radius) / ts), tzMax = edgeMax(z + radius, ts);
    let bestPen = 0, bnx = 0, bnz = 0;
    for (let tx = txMin; tx <= txMax; tx++) {
      for (let tz = tzMin; tz <= tzMax; tz++) {
        if (!solid(isSolid, tx, tz)) continue;
        const minX = tx * ts, maxX = minX + ts, minZ = tz * ts, maxZ = minZ + ts;
        const qx = clamp(x, minX, maxX), qz = clamp(z, minZ, maxZ);  // closest pt on tile
        const ddx = x - qx, ddz = z - qz, dd = Math.hypot(ddx, ddz);
        let pen, nx, nz;
        if (dd > EPS) { pen = radius - dd; nx = ddx / dd; nz = ddz / dd; }
        else {                                    // center inside tile: exit least-overlap face
          const l = x - minX, rgt = maxX - x, dn = z - minZ, up = maxZ - z;
          const mX = Math.min(l, rgt), mZ = Math.min(dn, up);
          if (mX < mZ) { nx = l < rgt ? -1 : 1; nz = 0; pen = radius + mX; }
          else { nz = dn < up ? -1 : 1; nx = 0; pen = radius + mZ; }
        }
        if (pen > bestPen) { bestPen = pen; bnx = nx; bnz = nz; }
      }
    }
    if (bestPen <= EPS) break;
    x += bnx * bestPen; z += bnz * bestPen;
    pushX += bnx * bestPen; pushZ += bnz * bestPen; hit = true;
  }
  return { pos: [x, y, z], push: [pushX, pushZ], hit };
}

// First solid tile a ray from `from` to `to` crosses — line-of-sight, aim laser,
// hitscan. Amanatides–Woo grid DDA: walks tile to tile in order, so it returns the
// NEAR wall, not just any wall. from/to accept [x,y,z] or flat [x,z]. Returns
//   { tile:[tx,tz], point:[x,y,z], dist, t (0..1 along the ray) }
// or null if the segment reaches `to` unobstructed. A ray STARTING inside a solid
// reports that tile at dist 0 (caller decides if that counts as blocked).
export function rayTile(from, to, isSolid, tileSize = 1) {
  const ts = tileSize;
  const x0 = px(from), z0 = pz(from), y0 = py(from);
  const x1 = px(to), z1 = pz(to);
  const dx = x1 - x0, dz = z1 - z0, dist = Math.hypot(dx, dz);
  let tx = Math.floor(x0 / ts), tz = Math.floor(z0 / ts);
  if (solid(isSolid, tx, tz)) return { tile: [tx, tz], point: [x0, y0, z0], dist: 0, t: 0 };
  if (dist < EPS) return null;
  const dirx = dx / dist, dirz = dz / dist;
  const stepX = dirx > 0 ? 1 : -1, stepZ = dirz > 0 ? 1 : -1;
  const bx = dirx > 0 ? (tx + 1) * ts : tx * ts;    // next X boundary along the ray
  const bz = dirz > 0 ? (tz + 1) * ts : tz * ts;
  let tMaxX = Math.abs(dirx) < EPS ? Infinity : (bx - x0) / dirx;
  let tMaxZ = Math.abs(dirz) < EPS ? Infinity : (bz - z0) / dirz;
  const tDeltaX = Math.abs(dirx) < EPS ? Infinity : ts / Math.abs(dirx);
  const tDeltaZ = Math.abs(dirz) < EPS ? Infinity : ts / Math.abs(dirz);
  let t = 0;
  while (t <= dist + EPS) {
    if (tMaxX < tMaxZ) { tx += stepX; t = tMaxX; tMaxX += tDeltaX; }
    else { tz += stepZ; t = tMaxZ; tMaxZ += tDeltaZ; }
    if (t > dist + EPS) break;                        // crossed no wall before `to`
    if (solid(isSolid, tx, tz))
      return { tile: [tx, tz], point: [x0 + dirx * t, y0, z0 + dirz * t], dist: t, t: t / dist };
  }
  return null;
}

export const tilecollision = {
  moveAndCollide, resolveCircleVsTiles, rayTile, tileOf, overlapsSolid,
};
