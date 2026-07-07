// engine/control/rooms.js
// ROOM / SCREEN graph with doors — the structural spine of a Zelda-style world
// (screen-by-screen overworld, or a dungeon of connected rooms). Where tilemap.js
// owns ONE room's grid, rooms.js owns the GRAPH: which rooms exist, which door
// leads where, which are locked, where the camera is boxed in, and what the player
// has already explored (the dungeon map). It is a pure STATE MACHINE over plain
// room/door data — no world/DOM/tilemap import — so it sim-tests by walking a
// position through a door and asserting the active room changed.
//
//   const w = rooms.makeWorld({ start: 'A', rooms: [
//     { id: 'A', bounds: { min: [0,0], max: [16,16] }, neighbors: { east: 'B' } },
//     { id: 'B', bounds: { min: [16,0], max: [32,16] } },
//   ]});
//   w.door('B', { at: [24,8], radius: 1 }, 'C', { locked: true, key: 'boss' });
//   const hit = w.tryDoor(player.pos);         // player standing on a door?
//   if (hit && !hit.locked) player.pos = w.enter(hit.to, { at: hit.at }).entryAt;
//   if (hit && hit.locked && inv.has(hit.needs)) w.unlock(hit.needs);  // spend a key
//
// A door is DIRECTIONAL (from -> to) but placed in the FROM room; list a room on
// both sides' neighbors (or add two doors) for a two-way passage. `bounds` is
// { min:[x,z], max:[x,z] } on the ground plane (XZ); if omitted it is derived from
// the room's tilemap (w*tileSize, h*tileSize). cameraBounds() hands the current
// room's box to the follow-cam so it clamps to that one screen.
//
// Transitions: switching is INSTANT by default (a Zelda screen-cut). For a fade/
// slide, DON'T call enter() immediately — run a transitions.js stepper, then call
// enter() at its midpoint; tryDoor() only REPORTS the crossing, it never mutates.
//
// Pure and node-safe: no window/DOM/WebGL/timers, no Math.random. All state lives
// on the returned world object.

// --- ground-plane helpers. pos is [x,y,z] (or [x,z]); bounds axes are [x,z]. ---
const xOf = (p) => p[0];
const zOf = (p) => (p[2] != null ? p[2] : p[1]);   // accept [x,y,z] or [x,z]
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

// Edge model: which axis of `bounds` an edge lives on, and which side (min/max).
// Screen orientation matches tilemap ASCII art (row 0 = top): north = top = min z,
// south = bottom = max z, west = left = min x, east = right = max x.
const EDGES = {
  north: { axis: 1, side: 'min' },
  south: { axis: 1, side: 'max' },
  west:  { axis: 0, side: 'min' },
  east:  { axis: 0, side: 'max' },
};
const OPPOSITE = { north: 'south', south: 'north', west: 'east', east: 'west' };

// Fill in a room's bounds from its tilemap when not given explicitly.
function boundsOf(room) {
  if (!room) return null;
  if (room.bounds) return room.bounds;
  const m = room.tilemap;
  if (m && m.w != null) {
    const ts = m.tileSize != null ? m.tileSize : 1;
    return (room.bounds = { min: [0, 0], max: [m.w * ts, m.h * ts] });
  }
  return null;
}

export function makeWorld({ rooms = [], start, doorMargin = 0.75, doors = [] } = {}) {
  // Build the graph. `rooms` is an array of { id, bounds?, tilemap?, spawns?,
  // neighbors? }; `start` is the id the world opens on. `doorMargin` is how close
  // (world units) a player must get to an edge / door point to trip it.
  const byId = new Map();
  const doorList = [];              // every door, in creation order
  const doorsFrom = new Map();      // roomId -> door[] (only checked for that room)
  const unlocked = new Set();       // door ids opened by unlock(id)
  const openKeys = new Set();       // keys spent via unlock(key) — opens matching doors
  const seen = new Set();           // visited room ids (the dungeon map)
  let doorSeq = 0;
  let currentId = null;
  let entryAt = null;               // where enter() asked the player be placed

  for (const r of rooms) { byId.set(r.id, r); boundsOf(r); }

  const room = (id) => byId.get(id) || null;

  // A door's trigger region: either an EDGE band of the from-room's bounds
  // (optionally clipped to a `span` [lo,hi] on the perpendicular axis) or a
  // circular `at`+`radius` spot. Returns the door.
  function door(fromId, where, toId, opts = {}) {
    const from = room(fromId);
    const d = {
      id: opts.id != null ? opts.id : `${fromId}>${toId}#${doorSeq++}`,
      from: fromId, to: toId,
      edge: null, span: opts.span || null,
      at: null, radius: opts.radius != null ? opts.radius : doorMargin,
      locked: !!opts.locked, key: opts.key != null ? opts.key : null,
      toAt: opts.at || opts.toAt || null,   // explicit landing spot in the dest
      margin: opts.margin != null ? opts.margin : doorMargin,
    };
    if (typeof where === 'string') d.edge = where;            // 'north' | ...
    else if (Array.isArray(where)) d.at = [xOf(where), zOf(where)];
    else if (where && where.at) { d.at = [xOf(where.at), zOf(where.at)]; d.radius = where.radius != null ? where.radius : d.radius; }
    else if (where && where.edge) { d.edge = where.edge; d.span = where.span || d.span; }
    doorList.push(d);
    if (!doorsFrom.has(fromId)) doorsFrom.set(fromId, []);
    doorsFrom.get(fromId).push(d);
    void from;
    return d;
  }

  // Wire implicit edge doors from each room's `neighbors` map, plus any doors
  // passed in the config (array of [from, where, to, opts] or {from,where,to,...}).
  for (const r of rooms) {
    if (!r.neighbors) continue;
    for (const edge of Object.keys(r.neighbors)) {
      if (EDGES[edge]) door(r.id, edge, r.neighbors[edge], {});
    }
  }
  for (const spec of doors) {
    if (Array.isArray(spec)) door(spec[0], spec[1], spec[2], spec[3] || {});
    else door(spec.from, spec.where != null ? spec.where : (spec.edge || { at: spec.at, radius: spec.radius }), spec.to, spec);
  }

  const isLocked = (d) =>
    d.locked && !unlocked.has(d.id) && !(d.key != null && openKeys.has(d.key));

  // Is `pos` inside door d's trigger region (d lives in the current room)?
  function overDoor(pos, d) {
    if (d.at) {                                   // circular spot
      const dx = xOf(pos) - d.at[0], dz = zOf(pos) - d.at[1];
      return dx * dx + dz * dz <= d.radius * d.radius;
    }
    const b = boundsOf(room(d.from));             // edge band needs bounds
    if (!b || !EDGES[d.edge]) return false;
    const { axis, side } = EDGES[d.edge];
    const line = side === 'max' ? b.max[axis] : b.min[axis];
    const p = axis === 0 ? xOf(pos) : zOf(pos);
    const near = side === 'max' ? p >= line - d.margin : p <= line + d.margin;
    if (!near) return false;
    if (d.span) {                                 // clipped to part of the edge
      const q = axis === 0 ? zOf(pos) : xOf(pos);
      if (q < d.span[0] || q > d.span[1]) return false;
    }
    return true;
  }

  // Where should the player appear in the destination? Explicit toAt wins; for an
  // edge door, land just inside the OPPOSITE edge of the dest, preserving the
  // crossing coordinate (so a screen-scroll keeps your x when you go north).
  function landing(d, pos) {
    if (d.toAt) return [d.toAt[0], 0, d.toAt[1]];
    const db = boundsOf(room(d.to));
    if (!db) return null;
    if (!d.edge) return [(db.min[0] + db.max[0]) / 2, 0, (db.min[1] + db.max[1]) / 2];
    const destEdge = OPPOSITE[d.edge];
    const { axis, side } = EDGES[destEdge];
    const inset = d.margin + 0.5;
    const line = side === 'max' ? db.max[axis] : db.min[axis];
    const comp = side === 'max' ? line - inset : line + inset;    // step inside
    const perpAxis = axis === 0 ? 1 : 0;
    const perp = axis === 0 ? zOf(pos) : xOf(pos);
    const cp = clamp(perp, db.min[perpAxis] + inset, db.max[perpAxis] - inset);
    const out = [0, 0, 0];
    out[axis === 0 ? 0 : 2] = comp;
    out[perpAxis === 0 ? 0 : 2] = cp;
    return out;
  }

  if (start != null) { currentId = start; seen.add(start); }

  const api = {
    // --- active room ---
    current() { return room(currentId); },
    currentId() { return currentId; },
    entryAt,                                     // last enter()'s landing spot (also on the return)

    enter(roomId, { at } = {}) {
      // Switch the active room (instant screen-cut). Marks it visited and records
      // the landing spot (for the game to place the player). Returns the room,
      // with `.entryAt` set to `at` (or null) for convenience.
      if (!byId.has(roomId)) return null;
      currentId = roomId;
      seen.add(roomId);
      entryAt = api.entryAt = at ? [xOf(at), 0, zOf(at)] : null;
      const r = room(roomId);
      r.entryAt = entryAt;
      return r;
    },

    // --- doors ---
    door,                                         // add one: door(from, where, to, opts)

    tryDoor(pos) {
      // If `pos` is on/over a door of the CURRENT room, report it WITHOUT
      // switching: { to, locked, needs, at, door }. `needs` is the key a locked
      // door wants (or true when it just needs a switch); null when open. `at` is
      // the landing spot to pass straight to enter(). Nearest matching door wins.
      const list = doorsFrom.get(currentId);
      if (!list) return null;
      for (const d of list) {
        if (!overDoor(pos, d)) continue;
        const locked = isLocked(d);
        return {
          to: d.to,
          locked,
          needs: locked ? (d.key != null ? d.key : true) : null,
          at: locked ? null : landing(d, pos),
          door: d,
        };
      }
      return null;
    },

    unlock(idOrKey) {
      // Open a door by its id, or SPEND a key: unlock(key) opens every door that
      // needs that key (now and later). Returns true if anything opened.
      if (doorList.some((d) => d.id === idOrKey)) { unlocked.add(idOrKey); return true; }
      let any = false;
      openKeys.add(idOrKey);
      for (const d of doorList) if (d.key === idOrKey) { unlocked.add(d.id); any = true; }
      return any || openKeys.has(idOrKey);
    },
    lock(id) { unlocked.delete(id); },            // re-lock a specific door (traps/puzzles)
    isLocked(id) { const d = doorList.find((x) => x.id === id); return d ? isLocked(d) : false; },
    doorsOf(roomId) { return (doorsFrom.get(roomId) || []).slice(); },

    // --- camera ---
    cameraBounds() {
      // The current room's box for the follow-cam to clamp against — the boxed-in
      // screen feel. Returns { min:[x,z], max:[x,z] } (a copy) or null (open room).
      const b = boundsOf(room(currentId));
      return b ? { min: [b.min[0], b.min[1]], max: [b.max[0], b.max[1]] } : null;
    },

    // --- dungeon map / exploration ---
    visited(id) { return seen.has(id); },
    markVisited(id) { seen.add(id); return id; },
    visitedRooms() { return [...seen]; },
    rooms: byId,
    room,
    get size() { return byId.size; },
  };
  return api;
}

export const rooms = { makeWorld, boundsOf, EDGES };
