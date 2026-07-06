// game/entities.js  — GAME GLUE (yours to edit)
// What things ARE: mesh, color ([r,g,b] 0..1), size, and stats. Pure data — no
// behavior. Change a color or swap 'sphere' for 'box' to restyle the game; the
// systems read these fields. mesh is one of: box | sphere | cylinder | plane.
export const entities = {
  player: { mesh: 'cylinder', color: [0.30, 0.80, 1.00], scale: [1, 1.6, 1], radius: 0.6 },
  enemy:  { mesh: 'sphere',   color: [1.00, 0.35, 0.35], scale: 1.1, radius: 0.6, hp: 3, speed: 3.2 },
  bullet: { mesh: 'box',      color: [1.00, 0.90, 0.35], scale: 0.3, radius: 0.28 },
};
