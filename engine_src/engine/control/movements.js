// engine/control/movements.js
// Reusable movement controllers — a swappable component like cameras. Each
// factory returns update(entity, input, dt) that sets the entity's velocity
// (platformers also do gravity/jump/ground). Pick one in game/bootstrap.js:
//   ctx.movement = movements.platformer({ speed: 8, jump: 15 })
// The movement system applies it to the player, then integrates all velocities.
// input = { move:[x,z], aim:[x,z], jump:bool }.

export function twinStick({ speed = 8 } = {}) {
  // Top-down (XZ): move by the left stick, face the move direction.
  return (e, input) => {
    const m = input.move;
    e.vel[0] = m[0] * speed; e.vel[1] = 0; e.vel[2] = m[1] * speed;
    if (m[0] || m[1]) e.rot = Math.atan2(m[0], m[1]);
  };
}

export function eightWay({ speed = 8 } = {}) {
  // Top-down, snapped to 8 directions (classic arcade feel).
  const snap = (v) => (Math.abs(v) < 0.35 ? 0 : Math.sign(v));
  return (e, input) => {
    const x = snap(input.move[0]), z = snap(input.move[1]);
    const l = Math.hypot(x, z) || 1;
    e.vel[0] = (x / l) * speed; e.vel[1] = 0; e.vel[2] = (z / l) * speed;
    if (x || z) e.rot = Math.atan2(x, z);
  };
}

export function tank({ speed = 8, turn = 3 } = {}) {
  // Top-down: left stick x rotates, y drives forward/back (Asteroids-like).
  return (e, input, dt) => {
    e.rot += input.move[0] * turn * dt;
    const fwd = -input.move[1] * speed;
    e.vel[0] = Math.sin(e.rot) * fwd; e.vel[1] = 0; e.vel[2] = Math.cos(e.rot) * fwd;
  };
}

export function platformer({ speed = 8, jump = 15, gravity = 40, ground = 0 } = {}) {
  // Side view (XY): left stick x moves; a tap (jump/right touch) hops when grounded.
  let wasJump = false;
  return (e, input, dt) => {
    e.vel[0] = input.move[0] * speed; e.vel[2] = 0;
    e.vel[1] -= gravity * dt;
    const grounded = e.pos[1] <= ground + 1e-3;
    if (grounded && e.vel[1] < 0) { e.pos[1] = ground; e.vel[1] = 0; }
    const pressed = input.jump && !wasJump;
    wasJump = input.jump;
    if (pressed && grounded) e.vel[1] = jump;
    if (input.move[0]) e.rot = input.move[0] > 0 ? Math.PI / 2 : -Math.PI / 2;
  };
}

export function autoRun({ speed = 10, jump = 15, gravity = 40, ground = 0 } = {}) {
  // Endless runner (XY): constant forward run, tap to jump.
  let wasJump = false;
  return (e, input, dt) => {
    e.vel[0] = speed; e.vel[2] = 0;
    e.vel[1] -= gravity * dt;
    const grounded = e.pos[1] <= ground + 1e-3;
    if (grounded && e.vel[1] < 0) { e.pos[1] = ground; e.vel[1] = 0; }
    const pressed = input.jump && !wasJump;
    wasJump = input.jump;
    if (pressed && grounded) e.vel[1] = jump;
  };
}

export const movements = { twinStick, eightWay, tank, platformer, autoRun };
