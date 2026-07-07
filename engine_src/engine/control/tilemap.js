// engine/control/tilemap.js
// TILEMAP — the grid foundation for rooms, dungeons and overworlds (Zelda-style).
// A tilemap is a fixed w×h grid of tiles laid on the ground plane (XZ, y up); each
// tile is a plain value: a number (a type id) OR an object of flags
//   { solid, water, hazard, type, ... }.
// It owns two jobs: AUTHORING (build a room from ASCII art) and QUERYING
// (world<->tile coordinate maps, bounds, and flag reads like isSolid).
//
//   const map = tilemap.fromStrings(["#####","#...#","#.~.#","#####"],
//                                   { "#": { solid: true }, ".": 0, "~": { water: true } });
//   map.isSolid(0, 0)                 -> true  (a wall)
//   map.tileToWorld(2, 2)             -> [x,0,z] CENTER of that cell
//   const { tx, tz, v } = map.tileAtWorld(player.pos);
//
// Coordinate convention matches pathing.gridNav so its planner can consume this
// map directly: worldToTile = floor(w / tileSize); a cell's CENTER is at
// (i + 0.5) * tileSize. Feed `(cx,cz) => !map.isSolid(cx,cz)` as gridNav's
// `passable` predicate — do NOT import pathing here; stay pure data.
//
// Out-of-bounds is treated as SOLID so the world is walled by default (an enemy
// or the player can never path off the edge). Optional named LAYERS
// (ground / decor / collision) share the grid's dimensions.
//
// Pure and node-safe: no window/DOM/WebGL/timers, no Math.random. State lives on
// the returned object, so it sim-tests by authoring from strings and asserting
// coordinate maps, bounds and solidity.

// --- flag reading: a tile is a number (no flags) or an object carrying flags ---
function flagOf(v, name) { return v && typeof v === 'object' ? v[name] : undefined; }

// A single w×h grid of tiles as a flat row-major array (index = tz * w + tx).
function makeGrid(w, h, fill) {
  const cells = new Array(w * h);
  // clone object fills per-cell so authored objects aren't shared by reference,
  // but keep the shared reference for LEGEND-authored maps (set below). Numbers
  // and undefined copy by value.
  for (let i = 0; i < cells.length; i++) cells[i] = fill;
  return cells;
}

export function makeTilemap({ w = 8, h = 8, fill = 0, tileSize = 1 } = {}) {
  w = Math.max(0, w | 0); h = Math.max(0, h | 0);
  const cells = makeGrid(w, h, fill);
  const layers = {};                              // name -> flat cell array (lazy)

  const inBounds = (tx, tz) => tx >= 0 && tz >= 0 && tx < w && tz < h;
  const idx = (tx, tz) => tz * w + tx;

  function get(tx, tz) { return inBounds(tx, tz) ? cells[idx(tx, tz)] : undefined; }
  function set(tx, tz, v) { if (!inBounds(tx, tz)) return false; cells[idx(tx, tz)] = v; return true; }

  // world <-> tile. tileToWorld returns the cell CENTER; worldToTile floors, so a
  // point anywhere in a cell maps back to that cell. Accepts [x,z] or [x,y,z].
  const zOf = (p) => (p[2] != null ? p[2] : p[1]);
  function worldToTile(p) { return [Math.floor(p[0] / tileSize), Math.floor(zOf(p) / tileSize)]; }
  function tileToWorld(tx, tz) { return [(tx + 0.5) * tileSize, 0, (tz + 0.5) * tileSize]; }
  function tileAtWorld(p) { const [tx, tz] = worldToTile(p); return { tx, tz, v: get(tx, tz) }; }

  // Read an arbitrary flag; missing tile / plain-number tile -> undefined.
  function flag(tx, tz, name) { return flagOf(get(tx, tz), name); }
  // Out-of-bounds counts as solid so the map is walled; in-bounds reads .solid.
  function isSolid(tx, tz) { return inBounds(tx, tz) ? !!flagOf(cells[idx(tx, tz)], 'solid') : true; }
  const passable = (tx, tz) => !isSolid(tx, tz);   // ready to hand to gridNav

  function forEach(cb) {
    for (let tz = 0; tz < h; tz++) for (let tx = 0; tx < w; tx++) cb(cells[idx(tx, tz)], tx, tz);
  }

  // A named extra layer (decor/collision/ground) with the SAME dimensions; its own
  // cells, sharing bounds + coordinate maps. layer(name) is idempotent.
  function layer(name, layerFill = 0) {
    let lc = layers[name];
    if (!lc) lc = layers[name] = makeGrid(w, h, layerFill);
    return {
      name, w, h, tileSize, inBounds,
      get: (tx, tz) => (inBounds(tx, tz) ? lc[idx(tx, tz)] : undefined),
      set: (tx, tz, v) => { if (!inBounds(tx, tz)) return false; lc[idx(tx, tz)] = v; return true; },
      forEach: (cb) => { for (let tz = 0; tz < h; tz++) for (let tx = 0; tx < w; tx++) cb(lc[idx(tx, tz)], tx, tz); },
    };
  }

  return {
    w, h, tileSize, cells,
    get, set, inBounds, worldToTile, tileToWorld, tileAtWorld,
    flag, isSolid, passable, forEach, layer,
    _legend: null,        // stamped by fromStrings for a default toStrings round-trip
    toStrings(legend) { return toStrings(this, legend); },
  };
}

// Author a room as ASCII ART. `rows` is an array of strings (rows[0] is tz=0, the
// top row); each char is looked up in `legend` (char -> tile value/object) to fill
// that cell. Width = the longest row; short rows pad with `fill`. A legend value
// that is an OBJECT is stored BY REFERENCE (so every wall shares one flag object —
// cheap, and lets toStrings round-trip by identity). Unknown chars fall back to
// `fill`. opts: { tileSize=1, fill=0 }.
export function fromStrings(rows = [], legend = {}, opts = {}) {
  const { tileSize = 1, fill = 0 } = opts;
  const h = rows.length;
  let w = 0;
  for (const r of rows) if (r.length > w) w = r.length;
  const map = makeTilemap({ w, h, fill, tileSize });
  for (let tz = 0; tz < h; tz++) {
    const row = rows[tz];
    for (let tx = 0; tx < w; tx++) {
      const ch = tx < row.length ? row[tx] : undefined;
      const v = ch != null && Object.prototype.hasOwnProperty.call(legend, ch) ? legend[ch] : fill;
      map.set(tx, tz, v);
    }
  }
  map._legend = legend;
  return map;
}

// Round-trip / debug: render a tilemap back to an array of strings using `legend`
// (defaults to the legend it was authored with). A cell matches a legend char by
// reference first (object tiles), then by value equality (numbers/deep-equal),
// else '?'. Handy for asserting a mutated map or printing a dungeon in a log.
export function toStrings(map, legend) {
  legend = legend || map._legend || {};
  const chars = Object.keys(legend);
  const same = (a, b) => a === b ||
    (a && b && typeof a === 'object' && typeof b === 'object' && JSON.stringify(a) === JSON.stringify(b));
  const charFor = (v) => {
    for (const c of chars) if (legend[c] === v) return c;        // reference hit
    for (const c of chars) if (same(legend[c], v)) return c;     // value hit
    return '?';
  };
  const out = [];
  for (let tz = 0; tz < map.h; tz++) {
    let row = '';
    for (let tx = 0; tx < map.w; tx++) row += charFor(map.get(tx, tz));
    out.push(row);
  }
  return out;
}

export const tilemap = { makeTilemap, fromStrings, toStrings };
