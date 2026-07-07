// engine/control/palettes.js
// COLOR + PALETTE helpers for the low-poly look. Engine colors are [r,g,b] with
// each channel 0..1, so everything here speaks that dialect (never 0..255) and a
// game reads the returned arrays straight into e.color / mesh tints. Two halves:
//
//   1. NAMED PALETTES — small arrays of [r,g,b] swatches, each capturing a mood
//      (sunset/neon/forest/mono/pastel/retro/ice/lava). Pick one for a level's
//      look, then sample it with gradient()/pick().
//   2. HELPERS — channel math (lerpColor, lighten/darken), hue tricks (hueShift),
//      hit feedback (damageFlash), team hues (teamColor), ramp sampling
//      (gradient), and hex I/O (toHex/fromHex).
//
// All pure + deterministic (no Math.random, no DOM/timers): variation comes from
// a passed rng or an index, so a sim can assert exact channel numbers, palette
// shape, and hue wrap. Colors are treated as fresh arrays — helpers never mutate
// their inputs, so a swatch pulled from a named palette is safe to reuse.

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const lerp = (a, b, t) => a + (b - a) * t;

// ---- named palettes ---------------------------------------------------------
// Each is an ordered ramp: index 0 = darkest/coolest anchor, last = brightest
// accent, so gradient(p, t) reads as a natural dark→light sweep.
export const PALETTES = {
  sunset: [[0.15, 0.08, 0.25], [0.45, 0.14, 0.35], [0.85, 0.30, 0.35],
           [0.98, 0.55, 0.30], [1.00, 0.80, 0.45]],
  neon:   [[0.05, 0.02, 0.10], [0.90, 0.10, 0.55], [0.55, 0.15, 0.95],
           [0.15, 0.85, 0.95], [0.30, 1.00, 0.65]],
  forest: [[0.06, 0.12, 0.08], [0.13, 0.28, 0.15], [0.25, 0.45, 0.22],
           [0.45, 0.60, 0.28], [0.72, 0.78, 0.45]],
  mono:   [[0.08, 0.08, 0.09], [0.28, 0.29, 0.31], [0.50, 0.51, 0.54],
           [0.72, 0.73, 0.76], [0.95, 0.96, 0.98]],
  pastel: [[0.68, 0.80, 0.90], [0.80, 0.72, 0.90], [0.95, 0.75, 0.82],
           [0.98, 0.88, 0.72], [0.80, 0.92, 0.78]],
  retro:  [[0.16, 0.14, 0.22], [0.85, 0.32, 0.38], [0.95, 0.62, 0.32],
           [0.42, 0.72, 0.55], [0.30, 0.42, 0.72]],
  ice:    [[0.10, 0.18, 0.30], [0.20, 0.40, 0.60], [0.42, 0.66, 0.85],
           [0.68, 0.86, 0.96], [0.92, 0.98, 1.00]],
  lava:   [[0.08, 0.02, 0.02], [0.35, 0.05, 0.04], [0.75, 0.15, 0.05],
           [0.98, 0.45, 0.08], [1.00, 0.85, 0.30]],
};

export function palette(name) {
  // Look up a named ramp; returns a defensive COPY of swatches (own arrays) so a
  // caller can tweak without corrupting the shared table. Falls back to mono.
  const p = PALETTES[name] || PALETTES.mono;
  return p.map((c) => [c[0], c[1], c[2]]);
}

// ---- channel math -----------------------------------------------------------
export function lerpColor(a, b, t) {
  // Straight per-channel blend a→b at t (0..1, clamped). t=0 is a, t=1 is b.
  const u = clamp01(t);
  return [lerp(a[0], b[0], u), lerp(a[1], b[1], u), lerp(a[2], b[2], u)];
}

export function lighten(c, amt = 0.2) {
  // Move each channel toward white by amt (0..1). amt=1 → pure white.
  const u = clamp01(amt);
  return [lerp(c[0], 1, u), lerp(c[1], 1, u), lerp(c[2], 1, u)];
}

export function darken(c, amt = 0.2) {
  // Move each channel toward black by amt (0..1). amt=1 → pure black.
  const u = clamp01(amt);
  return [c[0] * (1 - u), c[1] * (1 - u), c[2] * (1 - u)];
}

export function saturate(c, amt = 0.2) {
  // Push a color away from (amt>0) or toward (amt<0) its own gray, holding
  // luminance. amt clamped to [-1,1]; -1 fully desaturates to gray.
  const a = amt < -1 ? -1 : amt > 1 ? 1 : amt;
  const g = 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2];   // perceived luma
  return [clamp01(lerp(g, c[0], 1 + a)),
          clamp01(lerp(g, c[1], 1 + a)),
          clamp01(lerp(g, c[2], 1 + a))];
}

export function grayscale(c) {
  // Collapse to its perceived-luminance gray (Rec.601 weights).
  const g = 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2];
  return [g, g, g];
}

// ---- hue ops (via HSL) ------------------------------------------------------
function rgbToHsl(r, g, b) {
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  let h = 0; const l = (max + min) / 2;
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  if (d !== 0) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60; if (h < 0) h += 360;
  }
  return [h, s, l];
}
function hslToRgb(h, s, l) {
  h = ((h % 360) + 360) % 360;                 // wrap into [0,360)
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let r = 0, g = 0, b = 0;
  if (h < 60) { r = c; g = x; }
  else if (h < 120) { r = x; g = c; }
  else if (h < 180) { g = c; b = x; }
  else if (h < 240) { g = x; b = c; }
  else if (h < 300) { r = x; b = c; }
  else { r = c; b = x; }
  return [clamp01(r + m), clamp01(g + m), clamp01(b + m)];
}

export function hueShift(c, deg = 0) {
  // Rotate the hue by `deg` degrees (wraps at 360, any sign), holding S+L.
  const [h, s, l] = rgbToHsl(c[0], c[1], c[2]);
  return hslToRgb(h + deg, s, l);
}

// ---- feedback + procedural colors -------------------------------------------
export function damageFlash(base, t, { peak = 1 } = {}) {
  // Hit-feedback tint: at t=0 the color is blown toward white by `peak`, easing
  // back to `base` as t→1. Drive t = elapsed/duration (t auto-clamps); >=1 is a
  // no-op that returns base untouched. Ease is quadratic so the flash snaps then
  // settles. Handy as e.color while a hit-flash timer counts down.
  const u = clamp01(t);
  const k = (1 - u) * (1 - u) * clamp01(peak);          // white amount now
  return [lerp(base[0], 1, k), lerp(base[1], 1, k), lerp(base[2], 1, k)];
}

const TEAM_HUES = [0, 210, 120, 45, 285, 170, 320, 90];  // red,blue,green,gold...
export function teamColor(index = 0, { sat = 0.7, light = 0.55, count } = {}) {
  // A distinct, saturated hue per team/player index. For small rosters it uses a
  // hand-picked hue wheel (max separation); if `count` is given it instead spaces
  // `count` hues evenly around the circle (golden-ish spread for big lobbies).
  let hue;
  if (count && count > 0) hue = (index * (360 / count)) % 360;
  else hue = TEAM_HUES[((index % TEAM_HUES.length) + TEAM_HUES.length) % TEAM_HUES.length];
  return hslToRgb(hue, sat, light);
}

// ---- ramp sampling ----------------------------------------------------------
export function gradient(pal, t) {
  // Sample a palette as a continuous ramp: t 0..1 maps across the swatches with
  // linear interpolation between neighbours. t<=0 → first swatch, t>=1 → last.
  // Accepts a name or an array of [r,g,b].
  const p = typeof pal === 'string' ? palette(pal) : pal;
  const n = p.length;
  if (n === 0) return [0, 0, 0];
  if (n === 1) return [p[0][0], p[0][1], p[0][2]];
  const u = clamp01(t) * (n - 1);
  const i = Math.min(Math.floor(u), n - 2);
  return lerpColor(p[i], p[i + 1], u - i);
}

export function pick(pal, sel) {
  // Grab one swatch. `sel` is either an rng ({int/range/next}) for a uniform
  // random pick, or a numeric index (wraps around, so -1 = last). Returns a copy.
  const p = typeof pal === 'string' ? palette(pal) : pal;
  const n = p.length;
  if (n === 0) return [0, 0, 0];
  let i;
  if (sel && typeof sel === 'object') {
    if (typeof sel.int === 'function') i = sel.int(0, n - 1);
    else if (typeof sel.next === 'function') i = Math.floor(sel.next() * n) % n;
    else i = 0;
  } else {
    i = Math.floor(sel || 0);
  }
  i = ((i % n) + n) % n;                        // wrap negatives/overflow
  const c = p[i];
  return [c[0], c[1], c[2]];
}

// ---- hex I/O ----------------------------------------------------------------
const hex2 = (v) => {
  const n = Math.round(clamp01(v) * 255);
  return (n < 16 ? '0' : '') + n.toString(16);
};
export function toHex(c) {
  // [r,g,b] 0..1 → '#rrggbb' (channels clamped + rounded to 0..255).
  return '#' + hex2(c[0]) + hex2(c[1]) + hex2(c[2]);
}
export function fromHex(str) {
  // '#rgb' | '#rrggbb' (with or without '#') → [r,g,b] 0..1. Bad input → black.
  let s = String(str).trim().replace(/^#/, '');
  if (s.length === 3) s = s[0] + s[0] + s[1] + s[1] + s[2] + s[2];
  if (s.length !== 6 || /[^0-9a-fA-F]/.test(s)) return [0, 0, 0];
  return [parseInt(s.slice(0, 2), 16) / 255,
          parseInt(s.slice(2, 4), 16) / 255,
          parseInt(s.slice(4, 6), 16) / 255];
}

export const palettes = {
  PALETTES, palette,
  lerpColor, lighten, darken, saturate, grayscale,
  hueShift, damageFlash, teamColor, gradient, pick, toHex, fromHex,
};
