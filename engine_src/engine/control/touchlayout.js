// engine/control/touchlayout.js
// On-screen TOUCH CONTROL layout — where the virtual joystick, action buttons and
// HUD anchors sit on a given phone screen. Pure geometry: you hand it a size +
// safe-area insets + which thumb, it hands back pixel positions. No DOM, no WebGL;
// a game reads the numbers and draws its own widgets, the input system its sticks.
//   const L = layout({ w, h, insets, hand:"right" });
//   L.joystick -> {cx,cy,radius}   L.buttons -> [{id,cx,cy,r}]   L.anchor('bottomBar')
//
// The #1 mobile ergonomics rule: keep everything inside the SAFE AREA (dodge the
// notch/home-bar via insets) AND inside the THUMB ARC (the sweep a resting thumb
// can actually reach). The movement stick rests in the lower OUTER corner; primary
// actions fan along the reachable arc, bottom-INNER; HUD labels pin to safe edges.
// Screen coords are pixels, origin TOP-LEFT, +x right, +y DOWN. Everything is a
// pure fn of sizes, so a sim asserts positions stay in safe area + zone in any
// orientation. hand = the thumb doing the driving ("right" = held/played righty).

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const norm = (i) => ({ top: i && i.top || 0, right: i && i.right || 0, bottom: i && i.bottom || 0, left: i && i.left || 0 });

// The safe rectangle (screen minus insets) — nothing interactive should leave it.
function safeRect(w, h, insets) {
  const i = norm(insets);
  return { x: i.left, y: i.top, w: w - i.left - i.right, h: h - i.top - i.bottom,
           right: w - i.right, bottom: h - i.bottom, left: i.left, top: i.top };
}

// The reachable thumb ARC for a resting grip. Modeled as an annulus sector pivoting
// at the lower OUTER corner (where the thumb's base joint sits): a point is in reach
// when its distance from the pivot is within [inner,outer] and its bearing sweeps
// from straight-inward (along the bottom edge) up to a little past vertical. `inner`
// culls the cramped nub right at the corner; `outer` is the fingertip's limit.
export function thumbZone(w, h, hand = 'right', opts = {}) {
  const insets = norm(opts.insets);
  const outerHand = hand === 'left' ? 'left' : 'right';
  // Pivot at the bottom outer corner of the safe area, nudged just off-screen so the
  // corner itself reads as comfortably reachable rather than "too close".
  const px = outerHand === 'right' ? (w - insets.right) : insets.left;
  const py = h - insets.bottom;
  const reach = opts.reach != null ? opts.reach : 0.58 * Math.hypot(w, h);
  const outer = reach;
  const inner = opts.inner != null ? opts.inner : 0.12 * reach;
  // Bearings measured in a hand-neutral frame: u = inward (toward center), v = up.
  const minA = opts.minA != null ? opts.minA : -0.17;   // ~10° below the bottom edge
  const maxA = opts.maxA != null ? opts.maxA : 1.75;     // ~100°, just past straight up
  return { hand: outerHand, pivot: [px, py], inner, outer, minA, maxA };
}

// Map a screen point into the zone's hand-neutral (inward u, up v) frame.
function local(zone, x, y) {
  const u = zone.hand === 'right' ? (zone.pivot[0] - x) : (x - zone.pivot[0]);
  const v = zone.pivot[1] - y;
  return { u, v, r: Math.hypot(u, v), a: Math.atan2(v, u) };
}

// Is a point (with optional radius `pad` for the whole widget) inside the arc?
export function inZone(pt, zone, pad = 0) {
  const p = local(zone, pt.cx != null ? pt.cx : pt.x, pt.cy != null ? pt.cy : pt.y);
  return p.r >= Math.max(0, zone.inner - pad) && p.r <= zone.outer + pad
      && p.a >= zone.minA && p.a <= zone.maxA;
}

// A world point at bearing `a` / distance `r` from a zone pivot, back in screen px.
function unlocal(zone, r, a) {
  const u = Math.cos(a) * r, v = Math.sin(a) * r;
  const x = zone.hand === 'right' ? (zone.pivot[0] - u) : (zone.pivot[0] + u);
  const y = zone.pivot[1] - v;
  return [x, y];
}

// Lay out N buttons. Two modes:
//  • ARC (default, or opts.zone given): buttons ride the reachable arc at a comfy
//    band of the thumb's reach, spread across a slice of the sweep — the natural
//    home for face buttons on a phone. Guaranteed in-zone.
//  • GRID/FAN around an explicit opts.center (no zone): a block (cols×rows) or a
//    straight fan along `spreadDeg`, for menus / ability rows that ignore the thumb.
// Returns [{id,cx,cy,r}] (id defaults to A,B,C… or opts.ids[i]).
export function place(n, opts = {}) {
  const out = [];
  const r = opts.r != null ? opts.r : 34;
  const id = (k) => (opts.ids && opts.ids[k] != null) ? opts.ids[k] : String.fromCharCode(65 + k);
  if (opts.grid || opts.cols) {                     // GRID block around center
    const c = opts.center || [0, 0];
    const cols = opts.cols || Math.ceil(Math.sqrt(n));
    const gap = opts.gap != null ? opts.gap : r * 2.4;
    const rows = Math.ceil(n / cols);
    for (let k = 0; k < n; k++) {
      const cx = (k % cols) - (cols - 1) / 2, cy = Math.floor(k / cols) - (rows - 1) / 2;
      out.push({ id: id(k), cx: c[0] + cx * gap, cy: c[1] + cy * gap, r });
    }
    return out;
  }
  if (opts.zone) {                                  // ARC along the thumb sweep
    const z = opts.zone;
    const band = opts.band != null ? opts.band : 0.6;          // 0 inner .. 1 outer
    const rad = z.inner + band * (z.outer - z.inner);
    const pad = opts.edge != null ? opts.edge : 0.28;          // keep off the sweep ends
    const a0 = z.minA + pad, a1 = z.maxA - pad;
    for (let k = 0; k < n; k++) {
      const t = n === 1 ? 0.5 : k / (n - 1);
      const [cx, cy] = unlocal(z, rad, a0 + (a1 - a0) * t);
      out.push({ id: id(k), cx, cy, r });
    }
    return out;
  }
  const c = opts.center || [0, 0];                  // straight FAN around center
  const spread = (opts.spreadDeg != null ? opts.spreadDeg : 90) * Math.PI / 180;
  const base = (opts.baseDeg != null ? opts.baseDeg : -90) * Math.PI / 180;
  const fanR = opts.radius != null ? opts.radius : r * 2.6;
  for (let k = 0; k < n; k++) {
    const t = n === 1 ? 0 : k / (n - 1) - 0.5;
    const a = base + t * spread;
    out.push({ id: id(k), cx: c[0] + Math.cos(a) * fanR, cy: c[1] + Math.sin(a) * fanR, r });
  }
  return out;
}

// Anchor a FLOATING stick wherever the thumb first touched down, clamped so the
// whole ring stays inside the safe area (a dynamic joystick — the modern default,
// beats a fixed pad because the thumb never has to hunt for home). Feed the raw
// touch {x,y}; pass screen size + insets so it can clamp. Returns {cx,cy,radius}.
export function floatingStick(touch, opts = {}) {
  const w = opts.w != null ? opts.w : 0, h = opts.h != null ? opts.h : 0;
  const radius = opts.radius != null ? opts.radius : 56;
  const s = safeRect(w || (touch.x * 2), h || (touch.y * 2), opts.insets);
  const m = radius + (opts.pad != null ? opts.pad : 8);
  const cx = clamp(touch.x, s.left + m, s.right - m);
  const cy = clamp(touch.y, s.top + m, s.bottom - m);
  return { cx, cy, radius };
}

// The whole layout for one screen. Movement stick = lower OUTER corner in the thumb
// arc; primary actions = a fan along the reachable arc, bottom-INNER; anchor(name)
// = named HUD points pinned to the safe edges (they dodge notches via the insets).
export function layout(cfg = {}) {
  const w = cfg.w || 0, h = cfg.h || 0, hand = cfg.hand === 'left' ? 'left' : 'right';
  const insets = norm(cfg.insets);
  const pad = cfg.pad != null ? cfg.pad : 16;
  const s = safeRect(w, h, insets);
  const zone = thumbZone(w, h, hand, { insets });
  const outer = hand === 'right' ? 'right' : 'left';

  // Movement stick: rest it near the outer-bottom corner, one comfortable margin in.
  const stickR = cfg.stickRadius != null ? cfg.stickRadius : clamp(0.135 * Math.min(w, h), 44, 96);
  const jx = outer === 'right' ? (s.right - pad - stickR) : (s.left + pad + stickR);
  const jy = s.bottom - pad - stickR;
  const joystick = { cx: jx, cy: jy, radius: stickR };

  // Primary actions: N face buttons riding the thumb arc, bottom-inner of the stick.
  const nBtn = cfg.buttons != null ? cfg.buttons : 3;
  const btnR = cfg.buttonRadius != null ? cfg.buttonRadius : clamp(0.075 * Math.min(w, h), 26, 52);
  const buttons = place(nBtn, {
    zone, r: btnR, band: cfg.band != null ? cfg.band : 0.62,
    ids: cfg.buttonIds || ['A', 'B', 'C', 'D', 'E', 'F'],
  });
  // Short screens (landscape) can push the far end of the arc past the safe edge;
  // pull each button back in. Clamping moves toward the pivot, so it stays in-zone.
  for (const b of buttons) {
    b.cx = clamp(b.cx, s.left + b.r + pad, s.right - b.r - pad);
    b.cy = clamp(b.cy, s.top + b.r + pad, s.bottom - b.r - pad);
  }

  // Named HUD anchors — pin to safe edges so score/health/minimap clear the notch.
  const barH = cfg.barH != null ? cfg.barH : 44;
  const anchors = {
    topLeft:      { x: s.left + pad,  y: s.top + pad },
    topCenter:    { x: w / 2,         y: s.top + pad },
    topRight:     { x: s.right - pad, y: s.top + pad },
    midLeft:      { x: s.left + pad,  y: h / 2 },
    center:       { x: w / 2,         y: h / 2 },
    midRight:     { x: s.right - pad, y: h / 2 },
    bottomLeft:   { x: s.left + pad,  y: s.bottom - pad },
    bottomCenter: { x: w / 2,         y: s.bottom - pad },
    bottomRight:  { x: s.right - pad, y: s.bottom - pad },
    topBar:       { x: s.left + pad,  y: s.top + pad, w: s.w - pad * 2, h: barH },
    bottomBar:    { x: s.left + pad,  y: s.bottom - pad - barH, w: s.w - pad * 2, h: barH },
  };
  const anchor = (name) => anchors[name] || anchors.center;

  return { hand, safe: s, zone, joystick, buttons, anchor, anchors };
}

export const touchlayout = { layout, thumbZone, inZone, place, floatingStick, safeRect };
