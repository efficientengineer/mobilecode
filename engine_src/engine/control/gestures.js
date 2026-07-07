// engine/control/gestures.js
// Touch GESTURE recognizers for mobile — the high-level layer ABOVE the raw
// twin-stick input system. You feed it plain pointer events (id + x,y in screen
// px + a timestamp t, in ms) and poll() the recognized gestures back as flat
// data. It NEVER touches window/DOM/WebGL/timers/Math.random — the game or app
// UI supplies the events and the clock, so it is fully deterministic and
// node-testable by scripting down/move/up sequences and asserting what comes out.
//
//   const gr = gestures.makeRecognizer({ holdMs: 400 });
//   onpointerdown = e => gr.down(e.pointerId, e.clientX, e.clientY, e.timeStamp);
//   onpointermove = e => gr.move(e.pointerId, e.clientX, e.clientY, e.timeStamp);
//   onpointerup   = e => gr.up(e.pointerId, e.timeStamp);
//   // each frame: for (const g of gr.poll(nowMs)) handle(g);
//
// Emitted gesture shapes (every one carries a `type`):
//   tap        { type, x, y }
//   doubleTap  { type, x, y }              second tap inside doubleMs + near
//   longPress  { type, x, y }              held past holdMs without moving
//   drag       { type, x, y, dx, dy }      LIVE, every move of one finger
//   swipe      { type, dir, dx, dy, vel }  dir = up|down|left|right
//   flick      { type, dir, dx, dy, vel }  a swipe past flickMinVel (fast)
//   pinch      { type, scale, center:[x,y] } two fingers, scale vs. gesture start
//   rotate     { type, angle, center:[x,y] } two fingers, radians turned so far
//
// Time is passed IN as `t` (milliseconds). A finger held perfectly still emits
// NO events, so pass the clock to poll(t) (or move()/up()) to let a pending
// longPress fire. Thresholds live in cfg; the defaults are thumb-friendly.

const DEFAULTS = {
  tapSlop: 10,        // px a tap/longPress may drift before it becomes a drag
  holdMs: 400,        // ms of stationary hold that makes a longPress
  doubleMs: 280,      // ms window for a second tap to pair into a doubleTap
  doubleSlop: 30,     // px the second tap may land from the first
  swipeMinVel: 0.3,   // px/ms release speed that turns a drag into a swipe (300 px/s)
  flickMinVel: 0.9,   // px/ms release speed that upgrades a swipe to a flick
  swipeMinDist: 24,   // px net travel required for any swipe/flick
};

function dir4(dx, dy) {                       // dominant-axis compass (y+ = down)
  if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? 'right' : 'left';
  return dy >= 0 ? 'down' : 'up';
}
function wrapPi(a) {                           // fold a radian delta to -PI..PI
  while (a > Math.PI) a -= 2 * Math.PI;
  while (a < -Math.PI) a += 2 * Math.PI;
  return a;
}

export function makeRecognizer(cfg = {}) {
  const c = { ...DEFAULTS, ...cfg };
  const ptr = new Map();        // id -> pointer state (insertion order = touch order)
  const out = [];               // queued gestures, drained by poll()
  let two = null;               // active two-finger baseline { a, b, d0, a0 }
  let lastTap = null;           // { x, y, t } for doubleTap pairing

  const emit = (g) => out.push(g);

  // Fire a pending longPress on a lone, still finger once it has held long enough.
  function checkHold(t) {
    if (ptr.size !== 1) return;
    const p = ptr.values().next().value;
    if (p.long || p.moved || p.multi) return;
    if (t - p.t0 >= c.holdMs) {
      p.long = true;
      emit({ type: 'longPress', x: p.x, y: p.y });
    }
  }

  // (Re)establish the two-finger baseline from the two oldest live pointers.
  function armTwo() {
    const it = ptr.values();
    const a = it.next().value, b = it.next().value;
    const dx = b.x - a.x, dy = b.y - a.y;
    two = { a: a.id, b: b.id, d0: Math.hypot(dx, dy) || 1, a0: Math.atan2(dy, dx) };
    a.multi = b.multi = true;   // taint both so lifting won't tap/swipe
  }

  function down(id, x, y, t) {
    checkHold(t);
    ptr.set(id, {
      id, x0: x, y0: y, t0: t, x, y, t,
      lx: x, ly: y, lt: t,       // previous sample for instantaneous velocity
      vx: 0, vy: 0,
      moved: false, long: false, multi: false,
    });
    if (ptr.size === 2) armTwo();
    // A 3rd+ finger just taints itself; pinch keeps tracking the first two.
    if (ptr.size >= 2) { const p = ptr.get(id); p.multi = true; }
  }

  function move(id, x, y, t) {
    checkHold(t);
    const p = ptr.get(id);
    if (!p) return;
    const dt = t - p.lt;
    if (dt > 0) { p.vx = (x - p.lx) / dt; p.vy = (y - p.ly) / dt; }
    p.lx = x; p.ly = y; p.lt = t;
    p.x = x; p.y = y; p.t = t;
    if (Math.hypot(x - p.x0, y - p.y0) > c.tapSlop) p.moved = true;

    if (two && (id === two.a || id === two.b)) {
      const a = ptr.get(two.a), b = ptr.get(two.b);
      if (a && b) {
        const dx = b.x - a.x, dy = b.y - a.y;
        const center = [(a.x + b.x) / 2, (a.y + b.y) / 2];
        emit({ type: 'pinch', scale: (Math.hypot(dx, dy) || 1) / two.d0, center });
        emit({ type: 'rotate', angle: wrapPi(Math.atan2(dy, dx) - two.a0), center });
      }
      return;
    }
    if (!p.multi) emit({ type: 'drag', x, y, dx: x - p.x0, dy: y - p.y0 });
  }

  function up(id, t) {
    checkHold(t);
    const p = ptr.get(id);
    if (!p) return;
    ptr.delete(id);

    const endedTwo = two && (id === two.a || id === two.b);
    if (endedTwo) two = null;

    if (!p.multi) resolveSingle(p, t);

    // Dropping to one finger after a pinch: re-baseline the survivor so it never
    // fires a stale swipe, but keep it tainted until it too lifts.
    if (ptr.size === 1 && (endedTwo || p.multi)) {
      const s = ptr.values().next().value;
      s.x0 = s.x; s.y0 = s.y; s.t0 = t; s.lx = s.x; s.ly = s.y; s.lt = t;
      s.moved = false; s.long = false; s.multi = true;
    } else if (ptr.size >= 2) {
      armTwo();               // still multi-touch — re-arm on the remaining pair
    }
  }

  function resolveSingle(p, t) {
    if (p.long) return;                        // longPress already consumed it
    const dx = p.x - p.x0, dy = p.y - p.y0;
    const dist = Math.hypot(dx, dy);
    const dur = Math.max(1, t - p.t0);
    // Release velocity: prefer the last live sample, fall back to whole-stroke avg.
    let vel = Math.hypot(p.vx, p.vy);
    if (!vel) vel = dist / dur;

    if (dist <= c.tapSlop && (t - p.t0) < c.holdMs) {
      if (lastTap && (t - lastTap.t) <= c.doubleMs &&
          Math.hypot(p.x - lastTap.x, p.y - lastTap.y) <= c.doubleSlop) {
        emit({ type: 'doubleTap', x: p.x, y: p.y });
        lastTap = null;
      } else {
        emit({ type: 'tap', x: p.x, y: p.y });
        lastTap = { x: p.x, y: p.y, t };
      }
      return;
    }
    if (dist >= c.swipeMinDist && vel >= c.swipeMinVel) {
      const type = vel >= c.flickMinVel ? 'flick' : 'swipe';
      emit({ type, dir: dir4(dx, dy), dx, dy, vel });
    }
    // else: a slow short drag — the live `drag` events already told that story.
  }

  function poll(t) {                           // drain queued gestures (pass clock to age holds)
    if (t != null) checkHold(t);
    if (!out.length) return [];
    return out.splice(0, out.length);
  }

  function active() { return ptr.size; }       // live finger count (handy for HUD)
  function reset() { ptr.clear(); out.length = 0; two = null; lastTap = null; }

  return { down, move, up, poll, active, reset, cfg: c };
}

export const gestures = { makeRecognizer };
