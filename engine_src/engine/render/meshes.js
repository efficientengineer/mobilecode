// engine/render/meshes.js
// Generates primitive geometry (positions + normals) once, with no asset files.
// Everything is centered at the origin at ~1 unit; the entity's scale sizes it.
function push(a, x, y, z) { a.push(x, y, z); }

function box() {
  const p = [], n = [];
  const faces = [
    [[0, 0, 1], [[-.5, -.5, .5], [.5, -.5, .5], [.5, .5, .5], [-.5, .5, .5]]],
    [[0, 0, -1], [[.5, -.5, -.5], [-.5, -.5, -.5], [-.5, .5, -.5], [.5, .5, -.5]]],
    [[1, 0, 0], [[.5, -.5, .5], [.5, -.5, -.5], [.5, .5, -.5], [.5, .5, .5]]],
    [[-1, 0, 0], [[-.5, -.5, -.5], [-.5, -.5, .5], [-.5, .5, .5], [-.5, .5, -.5]]],
    [[0, 1, 0], [[-.5, .5, .5], [.5, .5, .5], [.5, .5, -.5], [-.5, .5, -.5]]],
    [[0, -1, 0], [[-.5, -.5, -.5], [.5, -.5, -.5], [.5, -.5, .5], [-.5, -.5, .5]]],
  ];
  for (const [nrm, q] of faces) {
    for (const i of [0, 1, 2, 0, 2, 3]) { push(p, q[i][0], q[i][1], q[i][2]); push(n, nrm[0], nrm[1], nrm[2]); }
  }
  return { positions: p, normals: n };
}

function sphere(rings = 12, sectors = 18) {
  const grid = [];
  for (let r = 0; r <= rings; r++) {
    const phi = Math.PI * r / rings;
    for (let s = 0; s <= sectors; s++) {
      const theta = 2 * Math.PI * s / sectors;
      const x = Math.sin(phi) * Math.cos(theta), y = Math.cos(phi), z = Math.sin(phi) * Math.sin(theta);
      grid.push([x * .5, y * .5, z * .5, x, y, z]);
    }
  }
  const p = [], n = [], idx = (r, s) => r * (sectors + 1) + s;
  for (let r = 0; r < rings; r++) for (let s = 0; s < sectors; s++) {
    const a = grid[idx(r, s)], b = grid[idx(r, s + 1)], c = grid[idx(r + 1, s + 1)], d = grid[idx(r + 1, s)];
    for (const v of [a, b, c, a, c, d]) { push(p, v[0], v[1], v[2]); push(n, v[3], v[4], v[5]); }
  }
  return { positions: p, normals: n };
}

function plane(size = 1) {
  const s = size / 2, q = [[-s, 0, -s], [s, 0, -s], [s, 0, s], [-s, 0, s]];
  const p = [], n = [];
  for (const i of [0, 1, 2, 0, 2, 3]) { push(p, q[i][0], q[i][1], q[i][2]); push(n, 0, 1, 0); }
  return { positions: p, normals: n };
}

function cylinder(sectors = 20) {
  const p = [], n = [];
  for (let s = 0; s < sectors; s++) {
    const t0 = 2 * Math.PI * s / sectors, t1 = 2 * Math.PI * (s + 1) / sectors;
    const x0 = Math.cos(t0) * .5, z0 = Math.sin(t0) * .5, x1 = Math.cos(t1) * .5, z1 = Math.sin(t1) * .5;
    const n0 = [Math.cos(t0), 0, Math.sin(t0)], n1 = [Math.cos(t1), 0, Math.sin(t1)];
    push(p, x0, -.5, z0); push(n, n0[0], 0, n0[2]); push(p, x1, -.5, z1); push(n, n1[0], 0, n1[2]); push(p, x1, .5, z1); push(n, n1[0], 0, n1[2]);
    push(p, x0, -.5, z0); push(n, n0[0], 0, n0[2]); push(p, x1, .5, z1); push(n, n1[0], 0, n1[2]); push(p, x0, .5, z0); push(n, n0[0], 0, n0[2]);
    push(p, 0, .5, 0); push(n, 0, 1, 0); push(p, x0, .5, z0); push(n, 0, 1, 0); push(p, x1, .5, z1); push(n, 0, 1, 0);
    push(p, 0, -.5, 0); push(n, 0, -1, 0); push(p, x1, -.5, z1); push(n, 0, -1, 0); push(p, x0, -.5, z0); push(n, 0, -1, 0);
  }
  return { positions: p, normals: n };
}

export const MESHES = { box: box(), sphere: sphere(), plane: plane(), cylinder: cylinder() };
