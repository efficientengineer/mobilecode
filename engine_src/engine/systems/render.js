// engine/systems/render.js
// The bridge between the sim and the renderer. It inits WebGL on the canvas and,
// on every 'render' phase, asks the active camera controller where to look
// (focused on the player) and draws the scene. The camera is a swappable
// component (ctx.camera, see cameras.js); default is a top-down follow. This is
// the only system that imports the renderer.
import { on } from '../core/events.js';
import { scene } from '../core/world.js';
import { initRenderer, applyCamera, render } from '../render/gl.js';
import { topDown } from '../render/cameras.js';

export function initRender(ctx) {
  initRenderer(ctx.canvas);
  const camera = ctx.camera || topDown({ height: ctx.config.camHeight, back: ctx.config.camBack });
  on('render', (dt) => {
    const p = ctx.signals.player.get();
    const focus = p && !p.dead ? p.pos : [0, 0, 0];
    applyCamera(camera(focus, p, dt));
    render(scene);
  });
}
