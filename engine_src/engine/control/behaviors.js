// engine/control/behaviors.js
// Reusable BEHAVIOR controllers — the brain for an enemy or NPC, swappable like
// cameras/movements/weapons/aim. Each factory returns a stepper:
//   step(entity, target, dt, ctx)   // target is usually the player, or null
// that sets the entity's velocity (movement.js integrates it) and facing. Pick a
// game-wide default in bootstrap (ctx.behavior = behaviors.chase()), give one
// enemy its own with e.behavior, or mix types with behaviors.byKind({...}).
//
// Per-entity state (wander goal, dash phase, patrol index) lives on the entity in
// e._ai, so ONE behavior instance can drive a whole registry without cross-talk.

function scratch(e) { return e._ai || (e._ai = {}); }
function drive(e, dx, dz, speed) {           // set velocity toward (dx,dz), face it
  const l = Math.hypot(dx, dz) || 1;
  e.vel[0] = (dx / l) * speed; e.vel[1] = 0; e.vel[2] = (dz / l) * speed;
  if (dx || dz) e.rot = Math.atan2(dx, dz);
}
function halt(e) { e.vel[0] = 0; e.vel[2] = 0; }
function face(e, dx, dz) { if (dx || dz) e.rot = Math.atan2(dx, dz); }
const spd = (cfg, e) => (cfg.speed != null ? cfg.speed : (e.speed != null ? e.speed : 3));

export function chase(cfg = {}) {
  // Beeline straight at the target. The classic pursuer (engine default).
  return (e, t) => {
    if (!t) return halt(e);
    drive(e, t.pos[0] - e.pos[0], t.pos[2] - e.pos[2], spd(cfg, e));
  };
}

export function flee(cfg = {}) {
  // Run directly away — prey, cowards, things you chase.
  return (e, t) => {
    if (!t) return halt(e);
    drive(e, e.pos[0] - t.pos[0], e.pos[2] - t.pos[2], spd(cfg, e));
  };
}

export function orbit({ radius = 6, dir = 1, speed } = {}) {
  // Circle-strafe: hold `radius` from the target while orbiting (dir ±1). Good
  // for ranged/harassing enemies that never quite close in.
  const cfg = { speed };
  return (e, t) => {
    if (!t) return halt(e);
    const rx = e.pos[0] - t.pos[0], rz = e.pos[2] - t.pos[2];
    const d = Math.hypot(rx, rz) || 1, nx = rx / d, nz = rz / d;
    const pull = Math.max(-1, Math.min(1, (d - radius) / radius)); // + = too far
    const tx = -nz * dir - nx * pull;          // tangent + radial correction
    const tz = nx * dir - nz * pull;
    drive(e, tx, tz, spd(cfg, e));
    face(e, t.pos[0] - e.pos[0], t.pos[2] - e.pos[2]);   // keep facing the target
  };
}

export function keepDistance({ min = 5, max = 9, speed } = {}) {
  // Skittish ranged: approach if farther than `max`, back off if closer than
  // `min`, otherwise hold and face the target.
  const cfg = { speed };
  return (e, t) => {
    if (!t) return halt(e);
    const dx = t.pos[0] - e.pos[0], dz = t.pos[2] - e.pos[2];
    const d = Math.hypot(dx, dz) || 1;
    if (d > max) drive(e, dx, dz, spd(cfg, e));
    else if (d < min) drive(e, -dx, -dz, spd(cfg, e));
    else { halt(e); face(e, dx, dz); }
  };
}

export function zigzag({ amp = 1, freq = 6, speed } = {}) {
  // Advance toward the target while weaving side to side — hard to draw a bead on.
  const cfg = { speed };
  return (e, t, dt) => {
    if (!t) return halt(e);
    const st = scratch(e); st.t = (st.t || 0) + (dt || 0);
    const dx = t.pos[0] - e.pos[0], dz = t.pos[2] - e.pos[2];
    const l = Math.hypot(dx, dz) || 1, nx = dx / l, nz = dz / l;
    const w = Math.sin(st.t * freq) * amp;      // perpendicular wobble
    drive(e, nx - nz * w, nz + nx * w, spd(cfg, e));
  };
}

export function charger({ range = 8, windup = 0.5, dashTime = 0.4, dashSpeed = 18, cooldown = 1.2, speed } = {}) {
  // Approach, telegraph with a pause, then DASH straight at where the target was;
  // rest, repeat. A committed melee lunger you can sidestep.
  const cfg = { speed };
  return (e, t, dt) => {
    if (!t) return halt(e);
    const st = scratch(e); dt = dt || 0;
    const dx = t.pos[0] - e.pos[0], dz = t.pos[2] - e.pos[2];
    const d = Math.hypot(dx, dz) || 1;
    st.phase = st.phase || 'approach'; st.timer = st.timer || 0; st.timer -= dt;
    if (st.phase === 'approach') {
      drive(e, dx, dz, spd(cfg, e));
      if (d <= range) { st.phase = 'windup'; st.timer = windup; }
    } else if (st.phase === 'windup') {
      halt(e); face(e, dx, dz);
      if (st.timer <= 0) { st.phase = 'dash'; st.timer = dashTime; st.dir = [dx / d, dz / d]; }
    } else if (st.phase === 'dash') {
      drive(e, st.dir[0], st.dir[1], dashSpeed);
      if (st.timer <= 0) { st.phase = 'rest'; st.timer = cooldown; }
    } else { halt(e); if (st.timer <= 0) st.phase = 'approach'; }
  };
}

export function wander({ area = 8, speed, retarget = 2.5 } = {}) {
  // Ambient roaming around the spawn point — neutral critters, idle townsfolk.
  const cfg = { speed };
  const rand = (ctx, a, b) => (ctx && ctx.rng ? ctx.rng.range(a, b) : a + (b - a) * 0.5);
  return (e, t, dt, ctx) => {
    const st = scratch(e); dt = dt || 0;
    if (!st.home) st.home = [e.pos[0], e.pos[2]];
    st.timer = (st.timer || 0) - dt;
    const gx = st.goal ? st.goal[0] - e.pos[0] : 0, gz = st.goal ? st.goal[1] - e.pos[2] : 0;
    if (!st.goal || st.timer <= 0 || Math.hypot(gx, gz) < 0.4) {
      st.goal = [st.home[0] + rand(ctx, -area, area), st.home[1] + rand(ctx, -area, area)];
      st.timer = retarget;
    }
    drive(e, st.goal[0] - e.pos[0], st.goal[1] - e.pos[2], spd(cfg, e) * 0.6);
  };
}

export function patrol({ points = [], loop = true, speed } = {}) {
  // Walk a fixed route of waypoints [[x,z],...] — guards, moving platforms.
  const cfg = { speed };
  return (e) => {
    if (!points.length) return halt(e);
    const st = scratch(e); st.i = st.i || 0;
    const wp = points[Math.min(st.i, points.length - 1)];
    const dx = wp[0] - e.pos[0], dz = wp[1] - e.pos[2];
    if (Math.hypot(dx, dz) < 0.3) {
      st.i = loop ? (st.i + 1) % points.length : Math.min(st.i + 1, points.length - 1);
    }
    drive(e, dx, dz, spd(cfg, e));
  };
}

export function follow({ distance = 3, speed } = {}) {
  // Companion NPC: trail the target but stop at `distance` so it never crowds.
  const cfg = { speed };
  return (e, t) => {
    if (!t) return halt(e);
    const dx = t.pos[0] - e.pos[0], dz = t.pos[2] - e.pos[2];
    const d = Math.hypot(dx, dz) || 1;
    if (d > distance) drive(e, dx, dz, spd(cfg, e));
    else { halt(e); face(e, dx, dz); }
  };
}

export function guard({ radius = 6, speed } = {}) {
  // Post NPC: hold a home point; chase the target only if it comes within
  // `radius`, then return home when it leaves. Home = spawn position.
  const cfg = { speed };
  return (e, t) => {
    const st = scratch(e);
    if (!st.home) st.home = [e.pos[0], e.pos[2]];
    if (t) {
      const dx = t.pos[0] - e.pos[0], dz = t.pos[2] - e.pos[2];
      if (Math.hypot(dx, dz) < radius) { drive(e, dx, dz, spd(cfg, e)); return; }
    }
    const hx = st.home[0] - e.pos[0], hz = st.home[1] - e.pos[2];
    if (Math.hypot(hx, hz) < 0.3) { halt(e); if (t) face(e, t.pos[0] - e.pos[0], t.pos[2] - e.pos[2]); }
    else drive(e, hx, hz, spd(cfg, e));
  };
}

export function byKind(map = {}) {
  // Dispatch by entity kind so one ctx.behavior drives mixed enemy/NPC types:
  //   ctx.behavior = behaviors.byKind({ grunt: chase(), archer: orbit(), default: chase() })
  return (e, t, dt, ctx) => {
    const b = map[e.kind] || map.default;
    if (b) b(e, t, dt, ctx);
  };
}

export const behaviors = {
  chase, flee, orbit, keepDistance, zigzag, charger, wander, patrol, follow, guard, byKind,
};
