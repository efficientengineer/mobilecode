// engine/control/vehicles.js
// Reusable VEHICLE movement controllers — a swappable component like movements.js,
// but with a driving/flying feel: momentum, drag, grip, and a heading that lives
// ON the entity across frames. Same shape as movements:
//   ctx.movement = vehicles.car({ topSpeed: 20 })
//   update(entity, input, dt)   with input = { move:[x,z], aim:[x,z], jump }.
// The movement system calls this on the player each frame, then integrates vel→pos.
//
// Convention (matches movements.js/behaviors.js): e.rot is the heading, so the
// forward unit vector is [sin(rot), cos(rot)] and +Z is "up-screen". A stick
// pushed forward reads move[1] < 0 (throttle = -move[1]), matching movements.tank.
// Per-vehicle scratch (bank angle) rides on e._veh; velocity/heading persist on
// e.vel / e.rot, so the controller is pure and sim-testable with a fake entity.

// --- tiny helpers -----------------------------------------------------------
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const decay = (rate, dt) => Math.exp(-rate * dt);    // frame-rate independent drag
function ensure(e) {                                  // seed persisted fields once
  if (e.rot == null) e.rot = 0;
  if (!e.vel) e.vel = [0, 0, 0];
  return e._veh || (e._veh = { bank: 0 });
}
// Split ground velocity into forward speed (signed) + lateral leftover, so we can
// keep the forward part and bleed off the sideways skid (that's what "grip" is).
function forwardSpeed(e, fx, fz) { return e.vel[0] * fx + e.vel[2] * fz; }

export function car({ accel = 20, topSpeed = 16, grip = 6, turn = 2.6 } = {}) {
  // Arcade car: throttle drives along the nose, steering scales with speed (no
  // pivoting in place), and lateral grip bleeds off sideways slide so hard turns
  // drift instead of tracking on rails. Low grip = slidey, high grip = go-kart.
  return (e, input, dt) => {
    ensure(e);
    const throttle = -input.move[1];                 // stick up = forward
    let fx = Math.sin(e.rot), fz = Math.cos(e.rot);
    // Accelerate along the current heading.
    e.vel[0] += fx * accel * throttle * dt;
    e.vel[2] += fz * accel * throttle * dt;
    // Steer: turn rate ramps with forward speed and flips sign in reverse.
    const steer = clamp(forwardSpeed(e, fx, fz) / 4, -1, 1);
    e.rot += input.move[0] * turn * dt * steer;
    // Recompute heading, then damp the lateral (skid) component toward the nose.
    fx = Math.sin(e.rot); fz = Math.cos(e.rot);
    const fs = forwardSpeed(e, fx, fz);
    const lx = e.vel[0] - fs * fx, lz = e.vel[2] - fs * fz;   // sideways leftover
    const k = decay(grip, dt);
    e.vel[0] = fs * fx + lx * k;
    e.vel[2] = fs * fz + lz * k;
    // Rolling resistance when coasting, then clamp to top speed.
    if (!throttle) { const r = decay(1.5, dt); e.vel[0] *= r; e.vel[2] *= r; }
    e.vel[1] = 0;
    const sp = Math.hypot(e.vel[0], e.vel[2]);
    if (sp > topSpeed) { const c = topSpeed / sp; e.vel[0] *= c; e.vel[2] *= c; }
  };
}

export function boat({ accel = 8, drag = 1.2, turn = 1.4 } = {}) {
  // Heavy boat: lots of momentum, no grip (it slides on water), steady water drag
  // on the whole velocity so it glides to a stop. Turn rate scales with speed.
  return (e, input, dt) => {
    ensure(e);
    const throttle = -input.move[1];
    const fx = Math.sin(e.rot), fz = Math.cos(e.rot);
    e.vel[0] += fx * accel * throttle * dt;
    e.vel[2] += fz * accel * throttle * dt;
    const steer = clamp(forwardSpeed(e, fx, fz) / 3, -1, 1);
    e.rot += input.move[0] * turn * dt * steer;       // rudder bites only underway
    const k = decay(drag, dt);                         // water resistance (omni)
    e.vel[0] *= k; e.vel[1] = 0; e.vel[2] *= k;
  };
}

export function hover({ accel = 18, drag = 3 } = {}) {
  // Hovercraft: omni-directional thrust (no fixed nose) with glide inertia — push
  // the stick any way and it accelerates that way, then coasts. Faces its travel.
  return (e, input, dt) => {
    ensure(e);
    e.vel[0] += input.move[0] * accel * dt;
    e.vel[2] += input.move[1] * accel * dt;
    const k = decay(drag, dt);
    e.vel[0] *= k; e.vel[1] = 0; e.vel[2] *= k;
    if (Math.abs(e.vel[0]) > 1e-3 || Math.abs(e.vel[2]) > 1e-3)
      e.rot = Math.atan2(e.vel[0], e.vel[2]);          // point where we're gliding
  };
}

export function flyer({ thrust = 14, lift = 10, turn = 2 } = {}) {
  // Arcade flight: move[1] is throttle along the nose, move[0] banks/yaws the
  // heading, aim[1] climbs/dives (vertical velocity). Light air drag on the plane.
  // e._veh.bank tracks roll for a renderer to tilt the mesh.
  return (e, input, dt) => {
    const s = ensure(e);
    e.rot += input.move[0] * turn * dt;                // bank turns the heading
    s.bank = clamp(-input.move[0], -1, 1);             // roll hint for visuals
    const throttle = -input.move[1];
    const fx = Math.sin(e.rot), fz = Math.cos(e.rot);
    e.vel[0] += fx * thrust * throttle * dt;
    e.vel[2] += fz * thrust * throttle * dt;
    const k = decay(0.8, dt);                          // thin air drag
    e.vel[0] *= k; e.vel[2] *= k;
    e.vel[1] = -input.aim[1] * lift;                   // aim up = climb, down = dive
  };
}

export function heavyTank({ accel = 10, turn = 1.2 } = {}) {
  // Heavy tank: pivots in place (turn works stopped), builds/sheds speed slowly
  // through inertia, and its treads grind it to a halt when you let off the gas.
  return (e, input, dt) => {
    ensure(e);
    e.rot += input.move[0] * turn * dt;                // treads pivot any time
    const throttle = -input.move[1];
    const fx = Math.sin(e.rot), fz = Math.cos(e.rot);
    e.vel[0] += fx * accel * throttle * dt;
    e.vel[2] += fz * accel * throttle * dt;
    const k = decay(throttle ? 0.6 : 2.4, dt);         // heavy tread friction
    e.vel[0] *= k; e.vel[1] = 0; e.vel[2] *= k;
  };
}

export const vehicles = { car, boat, hover, flyer, heavyTank };
