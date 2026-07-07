// engine/control/particles.js
// Particle EMITTER logic — a pure DATA simulation the renderer later draws (there
// is no WebGL here). A particle is { pos:[x,y,z], vel:[x,y,z], life, age, size,
// color:[r,g,b] }. You make ONE system, feed it emit-specs (burst/fountain/…),
// step it each frame, and hand `system.particles` to whatever draws points.
//
//   const fx = particles.makeSystem();
//   fx.emit(particles.burst(), { pos: e.pos, rng });      // explosion pop
//   const smoke = particles.fountain();                    // keep this instance
//   ...each frame: fx.emit(smoke, { pos, dt, rng }); fx.step(dt);
//
// A SPEC is a stateful fn (add, ctx) => void: it calls add({vel,life,…}) once per
// new particle. Rate-based specs (fountain/stream/trail) carry a fractional carry
// in their closure, so give each emitter its OWN instance. Everything is
// deterministic given ctx.rng (or an internal phase fallback) — no Math.random,
// no globals — so a sim can emit N, step, and assert aging / expiry / counts.

const UP = [0, 1, 0];

// --- tiny vector helpers (local, no deps) ---
function norm(v) { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; }
function cross(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }

// Orthonormal basis with `axis` as the local +z, so we can aim a cone anywhere.
function basisFrom(axis) {
  const a = norm(axis);
  const ref = Math.abs(a[1]) < 0.99 ? UP : [1, 0, 0];   // avoid a degenerate cross
  const x = norm(cross(ref, a));
  const y = cross(a, x);
  return [x, y, a];
}

// A unit vector inside a cone of half-angle `half` around `axis`. half=PI = full
// sphere (omni pop); small half = a tight jet. rand() is a ()->[0,1) supplier.
function coneDir(rand, axis, half) {
  const cosT = 1 - rand() * (1 - Math.cos(half));       // cosθ in [cos(half), 1]
  const sinT = Math.sqrt(Math.max(0, 1 - cosT * cosT));
  const phi = rand() * Math.PI * 2;
  const lx = sinT * Math.cos(phi), ly = sinT * Math.sin(phi), lz = cosT;
  const [bx, by, bz] = basisFrom(axis);
  return [
    lx * bx[0] + ly * by[0] + lz * bz[0],
    lx * bx[1] + ly * by[1] + lz * bz[1],
    lx * bx[2] + ly * by[2] + lz * bz[2],
  ];
}

export function makeSystem({ gravity = -9.8, drag = 0, max = 2000, rng } = {}) {
  // gravity = signed Y accel applied to every particle that doesn't override `g`;
  // drag = per-second linear velocity damping; max caps live count (mobile-safe).
  const parts = [];
  let phase = 0;                                          // deterministic rand fallback
  const fallback = () => {                                // golden-ratio hop + hash, no Math.random
    phase = (phase + 0.6180339887498949) % 1;
    const s = Math.sin(phase * 99.13 + phase * phase * 57.7) * 43758.5453;
    return s - Math.floor(s);
  };
  const sysRand = rng ? () => rng.next() : fallback;

  const sys = {
    particles: parts,
    get count() { return parts.length; },

    // Run a spec: it calls add() per particle. ctx = { pos, dir, dt, rng }.
    emit(spec, ctx = {}) {
      if (typeof spec !== 'function') return 0;
      const rand = ctx.rng ? () => ctx.rng.next() : sysRand;
      const origin = ctx.pos || [0, 0, 0];
      let added = 0;
      const add = (init = {}) => {
        if (parts.length >= max) return;                 // silently drop when full
        const p = init.pos ? [init.pos[0], init.pos[1], init.pos[2]]
                           : [origin[0], origin[1], origin[2]];
        const v = init.vel || [0, 0, 0];
        parts.push({
          pos: p,
          vel: [v[0], v[1], v[2]],
          life: init.life != null ? init.life : 0.6,
          age: 0,
          size: init.size != null ? init.size : 0.2,
          color: init.color ? init.color.slice() : [1, 1, 1],
          g: init.g != null ? init.g : gravity,
          drag: init.drag != null ? init.drag : drag,
        });
        added++;
      };
      spec(add, { pos: origin, dir: ctx.dir, dt: ctx.dt || 0, rand, rng: ctx.rng });
      return added;
    },

    // Age, integrate, and drop the expired. Compacts in place (stable array ref).
    step(dt) {
      dt = dt || 0;
      let w = 0;
      for (let r = 0; r < parts.length; r++) {
        const p = parts[r];
        p.age += dt;
        if (p.age >= p.life) continue;                   // expired → drop
        p.vel[1] += p.g * dt;                            // gravity
        if (p.drag) {                                    // linear drag
          const f = Math.max(0, 1 - p.drag * dt);
          p.vel[0] *= f; p.vel[1] *= f; p.vel[2] *= f;
        }
        p.pos[0] += p.vel[0] * dt;                       // integrate
        p.pos[1] += p.vel[1] * dt;
        p.pos[2] += p.vel[2] * dt;
        parts[w++] = p;
      }
      parts.length = w;
      return parts.length;
    },

    clear() { parts.length = 0; },
  };
  return sys;
}

// --- emit-spec presets (each returns a fresh, stateful spec) ---

export function burst({ count = 16, speed = 6, life = 0.6, spread = Math.PI,
                        size = 0.2, color = [1, 0.72, 0.25], gravity = 0, drag = 1.5 } = {}) {
  // One-shot explosion pop: `count` shards fired omni (spread=PI) and braked by
  // drag so they punch out then hang. Emit once on a hit/death.
  return (add, ctx) => {
    for (let i = 0; i < count; i++) {
      const d = coneDir(ctx.rand, UP, spread);
      const sp = speed * (0.6 + 0.4 * ctx.rand());
      add({ vel: [d[0] * sp, d[1] * sp, d[2] * sp], life: life * (0.7 + 0.6 * ctx.rand()),
            size, color, g: -gravity, drag });
    }
  };
}

export function fountain({ rate = 30, up = 8, spread = 0.35, life = 1.2,
                           size = 0.18, color = [0.4, 0.7, 1], gravity = 9.8, drag = 0.2 } = {}) {
  // Continuous upward jet: `rate` particles/sec shot up a tight cone; system/own
  // gravity arcs them back down into a fountain. Call every frame with ctx.dt.
  let carry = 0;
  return (add, ctx) => {
    carry += rate * ctx.dt;
    let n = Math.floor(carry); carry -= n;
    while (n-- > 0) {
      const d = coneDir(ctx.rand, UP, spread);
      const sp = up * (0.85 + 0.3 * ctx.rand());
      add({ vel: [d[0] * sp, d[1] * sp, d[2] * sp], life, size, color, g: -gravity, drag });
    }
  };
}

export function stream({ rate = 40, dir = [0, 0, 1], speed = 10, spread = 0.15,
                         life = 0.8, size = 0.15, color = [1, 0.9, 0.5], gravity = 0, drag = 0.1 } = {}) {
  // Continuous directed jet (thruster/flamethrower/hose). `dir` is the base aim;
  // pass ctx.dir per-emit to swivel it. Call every frame with ctx.dt.
  let carry = 0;
  return (add, ctx) => {
    carry += rate * ctx.dt;
    let n = Math.floor(carry); carry -= n;
    const a = ctx.dir || dir;
    while (n-- > 0) {
      const d = coneDir(ctx.rand, a, spread);
      const sp = speed * (0.85 + 0.3 * ctx.rand());
      add({ vel: [d[0] * sp, d[1] * sp, d[2] * sp], life, size, color, g: -gravity, drag });
    }
  };
}

export function trail({ life = 0.4, size = 0.16, color = [0.8, 0.8, 0.9],
                        jitter = 0.05, drag = 2, every = 0 } = {}) {
  // Breadcrumbs behind a mover: drop a near-still fading dot AT ctx.pos. One per
  // call by default; set `every` (seconds) to throttle at high frame rates.
  let carry = 0;
  return (add, ctx) => {
    if (every > 0) { carry += ctx.dt; if (carry < every) return; carry -= every; }
    const j = () => (ctx.rand() * 2 - 1) * jitter;
    add({ pos: [ctx.pos[0] + j(), ctx.pos[1] + j(), ctx.pos[2] + j()],
          vel: [0, 0, 0], life, size, color, g: 0, drag });
  };
}

export function sparks({ count = 12, speed = 7, life = 0.5, spread = Math.PI,
                         gravity = 22, size = 0.1, color = [1, 0.85, 0.4], drag = 0.6 } = {}) {
  // One-shot bright shards with STRONG gravity — they leap up and rain back down
  // (impacts, welding, muzzle grit). Biased upward so the arc reads.
  return (add, ctx) => {
    for (let i = 0; i < count; i++) {
      const d = coneDir(ctx.rand, UP, spread);
      const sp = speed * (0.4 + 0.9 * ctx.rand());
      add({ vel: [d[0] * sp, Math.abs(d[1]) * sp * 0.7 + sp * 0.2, d[2] * sp],
            life: life * (0.5 + 0.8 * ctx.rand()), size, color, g: -gravity, drag });
    }
  };
}

export const particles = { makeSystem, burst, fountain, stream, trail, sparks };
