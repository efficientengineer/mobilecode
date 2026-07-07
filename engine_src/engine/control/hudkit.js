// engine/control/hudkit.js
// HUD WIDGET logic — the pure state + geometry a renderer or DOM overlay DRAWS.
// Nothing here touches WebGL/DOM/timers/Math.random; each factory is a tiny state
// machine you feed dt and read once per frame, so it sim-tests headless and mobile
// legibility is baked into the DEFAULTS (fat touch targets, slow readable eases,
// blips that hug the map edge instead of vanishing). A game keeps one instance per
// widget, pokes it on events, and samples it in render:
//   const hp = hudkit.bar({ max: 100 });
//   on('player-damaged', ({ hp:v }) => hp.set(v));    // render: fill = hp.pct
//   hp.step(dt);                                       // ease the drain each frame
//
// Convention: everything normalized where it helps a renderer — `pct`/`fraction`
// are 0..1, map coords are in map space (0..mapSize), timers hand back "mm:ss".
// State lives in the closure (per instance); never module globals.

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
// frame-rate-INDEPENDENT ease of `cur` toward `target` at rate k (per second).
// k<=0 snaps instantly. This is the juice: a drained bar glides, it doesn't jump.
function damp(cur, target, k, dt) {
  if (k <= 0 || dt <= 0) return target;
  return cur + (target - cur) * (1 - Math.exp(-k * dt));
}

// --- bar: an eased fill (health / mana / boss / shield) ---------------------
// `set(v)` snaps the underlying VALUE (the true amount); `display` chases it so a
// hit shows a satisfying slide-down instead of a pop. Read `pct` for the fill the
// renderer paints, `value` for the exact number a label prints. `smooth`=0 = rigid.
export function bar({ max = 100, smooth = 6, value = null } = {}) {
  let target = clamp(value == null ? max : value, 0, max);
  let disp = target;                                   // eased follower
  const api = {
    set(v) { target = clamp(v, 0, max); return target; },
    add(d) { return api.set(target + d); },            // damage (-) or heal (+)
    setMax(m, keep = true) { max = m > 0 ? m : 0; if (!keep) { target = max; disp = max; } else target = clamp(target, 0, max); return max; },
    snap() { disp = target; return disp; },            // kill the ease (respawn/reset)
    step(dt) { disp = damp(disp, target, smooth, dt || 0); return disp; },
    get value() { return target; },
    get max() { return max; },
    get display() { return disp; },                    // the number the bar is AT mid-drain
    get pct() { return max > 0 ? clamp01(disp / max) : 0; },     // fill to draw
    get targetPct() { return max > 0 ? clamp01(target / max) : 0; }, // where it's headed
    get empty() { return target <= 0; },
    get full() { return target >= max; },
    get draining() { return disp - target > 1e-4; },   // show a "chip" trail behind
  };
  return api;
}

// --- radialCooldown: an ability ring that recharges ------------------------
// `fraction` is 0..1 where 1 = READY (ring full). `trigger()` spends it (only when
// ready) and starts the refill; `step(dt)` fills it back over `duration` seconds.
export function radialCooldown({ duration = 1, ready = true, charges = 1 } = {}) {
  let cd = ready ? 0 : duration;                       // seconds left until ready
  let stock = ready ? charges : 0;                     // banked uses (for multi-charge)
  const api = {
    trigger() {                                        // fire if able; returns did-fire
      if (stock <= 0) return false;
      stock -= 1;
      if (cd <= 0) cd = duration;                      // start refilling this charge
      return true;
    },
    step(dt) {
      dt = dt || 0;
      if (stock < charges && cd > 0) {
        cd -= dt;
        if (cd <= 0) { stock += 1; cd = stock < charges ? duration : 0; }
      }
      return api.fraction;
    },
    reset() { cd = 0; stock = charges; },              // full instant refill (pickup)
    get ready() { return stock > 0; },
    get charges() { return stock; },
    get fraction() { return duration > 0 ? clamp01(1 - cd / duration) : 1; }, // ring fill 0..1
    get remaining() { return cd > 0 ? cd : 0; },       // seconds label
  };
  return api;
}

// --- toastQueue: a self-ageing notification stack --------------------------
// `push(msg)` drops a toast on top (pickup grabbed / wave cleared / +score);
// `step(dt)` ages them and expires the oldest; `items()` is what the overlay draws,
// each carrying `t` (0..1 elapsed) and `alpha` (fades out in its last 25%).
export function toastQueue({ max = 3, life = 2, fade = 0.25 } = {}) {
  let items = [];
  let seq = 0;
  const api = {
    push(msg, opts = {}) {
      const t = { id: ++seq, msg, life: opts.life != null ? opts.life : life, age: 0, data: opts.data };
      items.push(t);
      if (items.length > max) items.splice(0, items.length - max); // shove out the oldest
      return t.id;
    },
    step(dt) {
      dt = dt || 0;
      for (const it of items) it.age += dt;
      items = items.filter((it) => it.age < it.life);
      return items.length;
    },
    items() {                                          // newest last; ready to render
      return items.map((it) => {
        const t = it.life > 0 ? clamp01(it.age / it.life) : 1;
        const f = fade > 0 ? clamp01((1 - t) / fade) : 1;   // fade over final `fade` frac
        return { id: it.id, msg: it.msg, data: it.data, t, alpha: f };
      });
    },
    clear() { items = []; },
    get count() { return items.length; },
  };
  return api;
}

// --- comboCounter: a decaying hit chain ------------------------------------
// `hit()` bumps the count and re-arms the window; `step(dt)` bleeds the window and
// DROPS the chain to 0 when it lapses. `broken` latches true for the one step the
// combo expired on (so the UI can flash "COMBO BREAK"); `fraction` is the window
// timer 0..1 for a draining pip. Tracks `best` across the session.
export function comboCounter({ window = 2 } = {}) {
  let count = 0, timer = 0, best = 0, broke = false;
  const api = {
    hit(n = 1) {
      broke = false;
      count += n; timer = window;
      if (count > best) best = count;
      return count;
    },
    step(dt) {
      broke = false;
      if (count > 0) {
        timer -= dt || 0;
        if (timer <= 0) { broke = true; count = 0; timer = 0; }
      }
      return count;
    },
    reset() { count = 0; timer = 0; broke = false; },
    get count() { return count; },
    get best() { return best; },
    get broken() { return broke; },                    // true only on the expiry step
    get active() { return count > 0; },
    get fraction() { return window > 0 ? clamp01(timer / window) : 0; }, // window drain pip
  };
  return api;
}

// --- minimap: world -> map projection with edge-clamped offscreen blips -----
// `worldSize` is the FULL world extent (a scalar square, or [w,h] for x/z);
// `mapSize` is the widget's pixel size (scalar or [w,h]). World is centered on
// `center` [x,z] (pass the player/camera each frame for a scrolling minimap).
// `project(worldPos)` -> [x,y] in map space (y grows downward, screen-style);
// `clampToEdge(mapPos)` pins an offscreen blip to the border along its bearing so
// enemies never just disappear — the staple mobile radar dot.
export function minimap({ worldSize = 100, mapSize = 128, center = [0, 0] } = {}) {
  const ws = Array.isArray(worldSize) ? worldSize : [worldSize, worldSize];
  const ms = Array.isArray(mapSize) ? mapSize : [mapSize, mapSize];
  let cx = center[0], cz = center[1];
  const api = {
    setCenter(c) { cx = c[0]; cz = c[1]; },            // recenter each frame if scrolling
    project(p) {                                       // [x,y,z] or [x,z] world -> [x,y] map
      const wx = p[0], wz = p.length > 2 ? p[2] : p[1];
      const nx = (wx - cx) / ws[0] + 0.5;              // 0..1 across the world
      const nz = (wz - cz) / ws[1] + 0.5;
      return [nx * ms[0], nz * ms[1]];                 // map space, y-down
    },
    onMap(m) { return m[0] >= 0 && m[0] <= ms[0] && m[1] >= 0 && m[1] <= ms[1]; },
    clampToEdge(m) {                                    // push an offscreen point to the border
      const hx = ms[0] / 2, hy = ms[1] / 2;
      let dx = m[0] - hx, dy = m[1] - hy;
      if (dx >= -hx && dx <= hx && dy >= -hy && dy <= hy) return [m[0], m[1]]; // already inside
      const sx = dx !== 0 ? hx / Math.abs(dx) : Infinity;   // scale to the nearest edge
      const sy = dy !== 0 ? hy / Math.abs(dy) : Infinity;
      const s = Math.min(sx, sy);
      return [hx + dx * s, hy + dy * s];
    },
    blip(p) {                                          // one call for the render path
      const m = api.project(p);
      const on = api.onMap(m);
      return { x: on ? m[0] : api.clampToEdge(m)[0], y: on ? m[1] : api.clampToEdge(m)[1], off: !on };
    },
    get size() { return [ms[0], ms[1]]; },
  };
  return api;
}

// --- timer: a counting clock that prints mm:ss -----------------------------
// `dir` "down" counts `from` -> 0 and latches `done`; "up" counts 0 -> up (or to a
// `from` cap if given). `step(dt)` advances only while running. `label` is the
// zero-padded "mm:ss" a renderer prints; `seconds` is the raw number.
export function timer({ from = 60, dir = 'down', running = true, cap = null } = {}) {
  const down = dir === 'down';
  let t = down ? from : 0;
  let run = running;
  let fin = false;
  const limit = cap != null ? cap : (down ? 0 : from);
  const api = {
    step(dt) {
      if (!run || fin) return t;
      t += (down ? -1 : 1) * (dt || 0);
      if (down && t <= 0) { t = 0; fin = true; run = false; }
      if (!down && cap != null && t >= limit) { t = limit; fin = true; run = false; }
      return t;
    },
    pause() { run = false; },
    start() { if (!fin) run = true; },
    toggle() { if (!fin) run = !run; },
    reset(v) { t = v != null ? v : (down ? from : 0); fin = false; run = running; },
    add(sec) { t += sec; if (down) t = Math.max(0, t); return t; }, // +time pickups
    get seconds() { return t; },
    get running() { return run; },
    get done() { return fin; },
    get label() {                                      // "mm:ss", floors partial seconds
      const s = Math.max(0, Math.floor(t));
      const mm = Math.floor(s / 60), ss = s % 60;
      return `${mm < 10 ? '0' : ''}${mm}:${ss < 10 ? '0' : ''}${ss}`;
    },
  };
  return api;
}

export const hudkit = {
  bar, radialCooldown, toastQueue, comboCounter, minimap, timer,
};
