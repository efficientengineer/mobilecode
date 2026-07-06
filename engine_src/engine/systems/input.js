// engine/systems/input.js
// Turns touch into the input SIGNALS (moveInput, aimInput, firing). A floating
// twin-stick: touch the LEFT half to move (the stick anchors where your thumb
// lands), the RIGHT half to aim and fire. Multi-touch via pointerId, so moving
// and firing at once both register. It knows nothing about the player or guns —
// it only writes signals; other systems read them.
export function initInput(ctx) {
  const { moveInput, aimInput, firing } = ctx.signals;
  const R = 60;                 // max stick radius in px
  const sticks = {};            // pointerId -> {left, ox, oy}

  function vec(e, s) {
    let dx = e.clientX - s.ox, dy = e.clientY - s.oy;
    const l = Math.hypot(dx, dy);
    if (l > R) { dx = dx / l * R; dy = dy / l * R; }
    return [dx / R, dy / R];
  }
  window.addEventListener('pointerdown', (e) => {
    const left = e.clientX < window.innerWidth / 2;
    sticks[e.pointerId] = { left, ox: e.clientX, oy: e.clientY };
    if (!left) firing.set(true);
  });
  window.addEventListener('pointermove', (e) => {
    const s = sticks[e.pointerId]; if (!s) return;
    const v = vec(e, s);
    if (s.left) moveInput.set(v); else { aimInput.set(v); firing.set(true); }
  });
  const end = (e) => {
    const s = sticks[e.pointerId]; if (!s) return;
    if (s.left) moveInput.set([0, 0]); else firing.set(false);
    delete sticks[e.pointerId];
  };
  window.addEventListener('pointerup', end);
  window.addEventListener('pointercancel', end);
}
