// engine/control/menus.js
// MENU / navigation STATE — the model behind title screens, pause menus, and
// settings panels. The renderer draws; THIS holds the cursor + values and turns
// input intents (move/adjust/activate) into plain data. Swappable and headless,
// like the rest of control/: no window/DOM/timers/Math.random, state in closures.
//
// makeMenu(items) drives one screen of rows. An item is:
//   { id, label, type:"button"|"toggle"|"slider"|"choice",
//     value?, min?, max?, step?, options? }
//   button — a command; activate() returns its id (fire it in your glue).
//   toggle — a boolean; adjust() flips it.
//   slider — a number clamped to [min,max] stepped by `step`; adjust() nudges it.
//   choice — a labelled pick from `options`; adjust() cycles (wraps).
// A menu exposes: move(dir) (cursor up/down, wraps, skips disabled), adjust(dir)
// (left/right edits the focused value), activate() (fire a button / flip a
// toggle), cursor, focused(), value(id?), values() (a plain {id:value} snapshot).
//
// makeScreens() is the STACK behind nested menus + a hardware/back button:
//   push(name) / pop() / replace(name) / top() / depth / reset(name).
//
// Mobile defaults: cursor wraps (no dead ends for a thumb), disabled rows are
// skipped so focus never lands on a greyed option, sliders step coarsely.

function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
function sign(d) { return d > 0 ? 1 : (d < 0 ? -1 : 0); }        // normalize a dir

// Round to the nearest `step` off `min` so a slider always lands on a legal notch.
function quantize(v, min, step) {
  if (!(step > 0)) return v;
  return min + Math.round((v - min) / step) * step;
}

function normItem(raw) {
  // Fill an item with sane defaults for its type; keep the caller's fields.
  const it = { type: 'button', disabled: false, ...raw };
  if (it.type === 'toggle') {
    it.value = !!it.value;
  } else if (it.type === 'slider') {
    it.min = it.min != null ? it.min : 0;
    it.max = it.max != null ? it.max : 1;
    it.step = it.step != null ? it.step : (it.max - it.min) / 10 || 1;
    it.value = clamp(quantize(it.value != null ? it.value : it.min, it.min, it.step), it.min, it.max);
  } else if (it.type === 'choice') {
    it.options = it.options && it.options.length ? it.options.slice() : [it.value];
    // value is the INDEX into options; accept either an index or a matching value.
    let idx = 0;
    if (typeof it.value === 'number' && it.options[it.value] !== undefined) idx = it.value;
    else { const f = it.options.indexOf(it.value); if (f >= 0) idx = f; }
    it.value = idx;
  }
  return it;
}

export function makeMenu(items = []) {
  const rows = items.map(normItem);
  let cursor = firstEnabled(0, 1);

  function firstEnabled(from, step) {
    // Find the nearest selectable row from `from` scanning by `step`, wrapping.
    const n = rows.length;
    if (!n) return 0;
    for (let k = 0; k < n; k++) {
      const i = ((from + step * k) % n + n) % n;
      if (!rows[i].disabled) return i;
    }
    return clamp(from, 0, n - 1);                 // all disabled: park in range
  }

  function move(dir) {
    // Step the cursor up (dir<0) or down (dir>0); wrap; skip disabled rows.
    const s = sign(dir); if (!s || !rows.length) return cursor;
    cursor = firstEnabled(cursor + s, s);
    return cursor;
  }

  function adjust(dir) {
    // Left/right on the focused row: flip a toggle, nudge a slider, cycle a choice.
    const s = sign(dir); const it = rows[cursor];
    if (!s || !it || it.disabled) return valueOf(it);
    if (it.type === 'toggle') {
      it.value = !it.value;
    } else if (it.type === 'slider') {
      it.value = clamp(quantize(it.value + s * it.step, it.min, it.step), it.min, it.max);
    } else if (it.type === 'choice') {
      const n = it.options.length;
      it.value = ((it.value + s) % n + n) % n;
    }
    return valueOf(it);
  }

  function activate() {
    // Confirm on the focused row. A button returns its id (the fire signal);
    // a toggle flips; slider/choice have no confirm action → return null.
    const it = rows[cursor];
    if (!it || it.disabled) return null;
    if (it.type === 'button') return it.id;
    if (it.type === 'toggle') { it.value = !it.value; return it.id; }
    return null;
  }

  function valueOf(it) {
    if (!it) return undefined;
    if (it.type === 'choice') return it.options[it.value];      // resolve to label
    if (it.type === 'button') return undefined;
    return it.value;
  }

  function focused() { return rows[cursor]; }
  function find(id) { return rows.find(r => r.id === id); }
  function value(id) { return valueOf(id == null ? rows[cursor] : find(id)); }
  function values() {
    // A flat {id: value} snapshot for saving / feeding config; buttons omitted.
    const out = {};
    for (const it of rows) if (it.type !== 'button') out[it.id] = valueOf(it);
    return out;
  }
  function setCursor(id) {
    // Jump focus to a row by id (ignores unknown/disabled) — e.g. restore state.
    const i = rows.findIndex(r => r.id === id && !r.disabled);
    if (i >= 0) cursor = i;
    return cursor;
  }
  function setDisabled(id, on) {
    // Grey a row out (e.g. lock "Continue" with no save); move off it if focused.
    const it = find(id); if (!it) return;
    it.disabled = !!on;
    if (it.disabled && cursor === rows.indexOf(it)) cursor = firstEnabled(cursor, 1);
  }

  return {
    move, adjust, activate, focused, value, values, setCursor, setDisabled,
    find, items: rows,
    get cursor() { return cursor; },
    get length() { return rows.length; },
  };
}

export function makeScreens(initial) {
  // A screen STACK for nested menus. `top()` is the visible screen; push to open
  // a submenu, pop for the back button, replace to swap without deepening.
  const stack = initial != null ? [initial] : [];

  function push(name) { stack.push(name); return name; }
  function pop() {
    // Back button: drop the top screen and return the one now revealed. Refuses
    // to empty the stack past the root (there's nothing behind a title screen).
    if (stack.length > 1) stack.pop();
    return stack[stack.length - 1];
  }
  function top() { return stack[stack.length - 1]; }
  function replace(name) { if (stack.length) stack[stack.length - 1] = name; else stack.push(name); return name; }
  function reset(name) { stack.length = 0; if (name != null) stack.push(name); return name; }
  function has(name) { return stack.indexOf(name) >= 0; }

  return {
    push, pop, top, replace, reset, has,
    get depth() { return stack.length; },
    get stack() { return stack.slice(); },
  };
}

export const menus = { makeMenu, makeScreens };
