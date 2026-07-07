// engine/core/loop.js
// The frame driver. Each frame it emits the ordered phases systems listen to:
//   input -> update(dt) -> physics -> late  (the sim), then render(dt) (always).
// A fixed-timestep accumulator keeps movement identical on any refresh rate.
// When paused() is true it still renders but skips the sim, so pause is decided
// in ONE place, not in every system. Registries are flushed after the sim so
// spawns/despawns made mid-frame apply safely. Call step(dt) directly in tests.
import { emit } from './events.js';
import { scene } from './world.js';

const STEP = 1 / 60;

export function makeLoop({ paused, registries = [] } = {}) {
  let acc = 0, last = 0, raf = 0;
  const simming = () => !(paused && paused());

  function step(dt) {
    if (simming()) {
      emit('input');
      acc += Math.min(dt, 0.1);
      let guard = 5;
      while (acc >= STEP && guard-- > 0) {
        emit('update', STEP);
        emit('physics');
        acc -= STEP;
      }
      emit('late');
      scene.flush();
      for (const r of registries) r.flush();
    }
    emit('render', dt);
  }

  function frame(t) {
    const dt = last ? (t - last) / 1000 : STEP;
    last = t;
    step(dt);
    raf = requestAnimationFrame(frame);
  }

  return {
    start() { last = 0; raf = requestAnimationFrame(frame); },
    stop() { cancelAnimationFrame(raf); },
    step,
  };
}
