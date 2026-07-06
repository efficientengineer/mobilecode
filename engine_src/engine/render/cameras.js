// engine/render/cameras.js
// Reusable camera controllers — a swappable component. Each factory returns a
// pure function `(focus, entity, dt) -> { eye, target, up?, projection?,
// orthoSize? }` that the render system applies. Pick one in game/bootstrap.js:
//   ctx.camera = cameras.topDown({ height: 24, back: 14 })
// Add your own here; they never touch WebGL.
export function topDown({ height = 24, back = 14 } = {}) {
  return (f) => ({ eye: [f[0], height, f[2] + back], target: f });
}

export function sideScroller({ distance = 20, height = 4, ahead = 0 } = {}) {
  return (f) => ({ eye: [f[0] + ahead, height, distance], target: [f[0] + ahead, height, 0] });
}

export function thirdPerson({ distance = 9, height = 5, lift = 1 } = {}) {
  return (f, e) => {
    const r = e ? e.rot : 0;
    return { eye: [f[0] - Math.sin(r) * distance, height, f[2] - Math.cos(r) * distance], target: [f[0], lift, f[2]] };
  };
}

export function orbit({ radius = 18, height = 12, speed = 0.3 } = {}) {
  let a = 0;
  return (f, e, dt = 0) => {
    a += speed * dt;
    return { eye: [f[0] + Math.cos(a) * radius, height, f[2] + Math.sin(a) * radius], target: f };
  };
}

export function fixed({ eye = [0, 26, 20], target = [0, 0, 0] } = {}) {
  return () => ({ eye, target });
}

// True 2D: orthographic, straight down. up is in the ground plane so it isn't
// parallel to the view direction.
export function flat2D({ height = 24, size = 20 } = {}) {
  return (f) => ({ eye: [f[0], height, f[2]], target: f, up: [0, 0, -1], projection: 'ortho', orthoSize: size });
}

// 2D side view: orthographic, looking down +z (classic platformer).
export function sideScroller2D({ distance = 20, height = 4, ahead = 0, size = 12 } = {}) {
  return (f) => ({ eye: [f[0] + ahead, height, distance], target: [f[0] + ahead, height, 0], projection: 'ortho', orthoSize: size });
}

export const cameras = { topDown, sideScroller, thirdPerson, orbit, fixed, flat2D, sideScroller2D };
