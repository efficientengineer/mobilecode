// engine/core/world.js
// The entity model. spawn(kind, opts) makes a plain-data entity with a transform
// and a mesh and puts it in the shared `scene` registry that the renderer draws.
// spawnInto(reg, ...) also files it in a gameplay registry (enemies, bullets) and
// remembers it, so despawn(e) cleanly removes it from BOTH. Entities are just
// data: { kind, pos, rot, scale, vel, color, mesh, dead, ...your fields }.
import { makeRegistry } from './registry.js';

export const scene = makeRegistry();

export function spawn(kind, opts = {}) {
  const e = Object.assign(
    { kind, rot: 0, scale: 1, color: [1, 1, 1], mesh: 'box', dead: false, reg: null },
    opts,
  );
  e.pos = (opts.at || opts.pos || [0, 0, 0]).slice();
  e.vel = (opts.vel || [0, 0, 0]).slice();
  scene.add(e);
  return e;
}

export function spawnInto(reg, kind, opts = {}) {
  const e = spawn(kind, opts);
  e.reg = reg;
  reg.add(e);
  return e;
}

export function despawn(e) {
  if (!e || e.dead) return;
  e.dead = true;
  scene.remove(e);
  if (e.reg) e.reg.remove(e);
}

export function resetWorld() { scene.clear(); }
