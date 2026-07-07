// engine/control/projectiles.js
// Reusable PROJECTILE MOTION controllers — how a bullet FLIES after it leaves the
// muzzle, swappable like cameras/movements/weapons. weapons.js decides WHEN and in
// what PATTERN shots are born; this decides what each one does mid-air. Each
// factory returns a stepper:
//   step(bullet, dt, ctx)   // mutate bullet.vel and/or bullet.pos
// The movement system integrates vel -> pos for every entity, so these components
// STEER velocity (set a heading + speed) and let integration move the bullet;
// arc is the exception, nudging pos through vel[1]. `ctx.target(bullet)` returns
// the nearest enemy { pos } for guidance (always guard for null — it may be gone).
//
// Per-bullet state (launch origin, weave clock, phase) lives on the bullet in
// b._m, so ONE motion instance can drive a whole bullet registry without crosstalk.
// Pick one in game/bootstrap.js:  ctx.projectile = projectiles.homing({ turn: 6 })
// and run it over the bullets registry each update (or store b.motion per-bullet).

function scratch(b) { return b._m || (b._m = {}); }          // per-bullet stash
function planar(v) { return Math.hypot(v[0], v[2]); }        // ground-plane speed
const TAU = Math.PI * 2;
function wrap(a) { a %= TAU; if (a > Math.PI) a -= TAU; if (a < -Math.PI) a += TAU; return a; }

export function straight() {
  // Dumb-fire: keep the launch velocity, forever. The default (and the cheapest).
  return () => {};
}

export function homing({ turn = 4, speed } = {}) {
  // Seeker: rotate the velocity toward the nearest enemy by at most `turn`
  // rad/sec, holding speed. Small turn = lazy arc, big turn = near lock-on. With
  // no target it flies straight. Angles use behaviors.js's atan2(x,z) convention.
  return (b, dt, ctx) => {
    const v = b.vel, cur = planar(v) || 1;
    const spd = speed != null ? speed : cur;               // keep launch speed by default
    const t = ctx && ctx.target && ctx.target(b);
    let a = Math.atan2(v[0], v[2]);                         // current heading
    if (t) {
      const desired = Math.atan2(t.pos[0] - b.pos[0], t.pos[2] - b.pos[2]);
      a += Math.max(-turn * dt, Math.min(turn * dt, wrap(desired - a)));
    }
    b.vel[0] = Math.sin(a) * spd; b.vel[2] = Math.cos(a) * spd;
  };
}

export function boomerang({ range = 8, speed } = {}) {
  // Thrown blade: fly out to `range` from the launch point, then curve back to the
  // owner and self-destruct when it lands home. Tracks a live owner if the game
  // hands one in (ctx.owner or b.owner), else returns to the launch origin.
  return (b, dt, ctx) => {
    const st = scratch(b), v = b.vel;
    const spd = speed != null ? speed : (planar(v) || range);
    if (!st.boomer) { st.boomer = true; st.origin = [b.pos[0], b.pos[2]]; st.phase = 'out'; }
    if (st.phase === 'out') {
      const ox = b.pos[0] - st.origin[0], oz = b.pos[2] - st.origin[1];
      if (Math.hypot(ox, oz) >= range) st.phase = 'back';
      const cur = planar(v) || 1;                           // renormalize outbound heading
      b.vel[0] = v[0] / cur * spd; b.vel[2] = v[2] / cur * spd;
    }
    if (st.phase === 'back') {
      const owner = (ctx && ctx.owner && ctx.owner.pos) || (b.owner && b.owner.pos);
      const hx = (owner ? owner[0] : st.origin[0]) - b.pos[0];
      const hz = (owner ? owner[2] : st.origin[1]) - b.pos[2];
      const d = Math.hypot(hx, hz) || 1;
      b.vel[0] = hx / d * spd; b.vel[2] = hz / d * spd;
      if (d < 0.5) b.dead = true;                           // caught — game despawns it
    }
  };
}

export function wave({ amp = 3, freq = 6, speed } = {}) {
  // Weaver: sine-strafe perpendicular to the launch heading while advancing —
  // snakes toward the aim, hard to line up against. `amp` = lateral reach (world
  // units), `freq` = wobbles/sec. Locks its forward axis from the first frame.
  return (b, dt) => {
    const st = scratch(b), v = b.vel;
    if (!st.wave) {
      const s = planar(v) || 1;
      st.wave = true; st.fwd = [v[0] / s, v[2] / s]; st.speed = speed != null ? speed : s; st.t = 0;
    }
    st.t += dt;
    const f = st.fwd, w = amp * freq * Math.cos(freq * st.t); // d/dt of amp*sin ⇒ true sine path
    b.vel[0] = f[0] * st.speed + -f[1] * w;                 // forward + perpendicular weave
    b.vel[2] = f[1] * st.speed + f[0] * w;
  };
}

export function arc({ gravity = 30 } = {}) {
  // Lob: pile downward acceleration onto vel[1] so the shot rises and falls —
  // grenades, mortars, arrows. Launch the bullet with some vel[1] > 0 to get air.
  return (b, dt) => { b.vel[1] -= gravity * dt; };
}

export function accelerate({ accel = 40, max } = {}) {
  // Ramp: scale the ground-plane speed by `accel` units/sec² along the current
  // heading — a slow-starting rail shot or a charging spitball. Negative `accel`
  // decays to a stop (never reverses); `max` caps the top speed.
  return (b, dt) => {
    const v = b.vel, cur = planar(v);
    if (cur < 1e-6) return;                                 // no heading to ramp
    let ns = cur + accel * dt;
    if (ns < 0) ns = 0;
    if (max != null && ns > max) ns = max;
    const k = ns / cur;
    b.vel[0] = v[0] * k; b.vel[2] = v[2] * k;
  };
}

export const projectiles = { straight, homing, boomerang, wave, arc, accelerate };
