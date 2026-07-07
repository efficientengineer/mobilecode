// engine/systems/audio.js
// Sound effects, synthesized with WebAudio (no files). It listens for gameplay
// events and beeps — decoupled from everything, so deleting it changes nothing
// else. Audio is unlocked on the first touch, per mobile autoplay rules.
import { on } from '../core/events.js';

export function initAudio() {
  let actx = null;
  window.addEventListener('pointerdown', () => {
    if (!actx) actx = new (window.AudioContext || window.webkitAudioContext)();
    if (actx.state === 'suspended') actx.resume();
  });
  function beep(freq, dur, type, gain) {
    if (!actx || actx.state !== 'running') return;
    const o = actx.createOscillator(), g = actx.createGain();
    o.type = type; o.frequency.value = freq;
    g.gain.value = gain;
    o.connect(g); g.connect(actx.destination);
    o.start();
    g.gain.exponentialRampToValueAtTime(0.0001, actx.currentTime + dur);
    o.stop(actx.currentTime + dur);
  }
  on('player-fired', () => beep(520, 0.08, 'square', 0.03));
  on('enemy-died', () => beep(150, 0.16, 'sawtooth', 0.05));
  on('player-damaged', () => beep(90, 0.22, 'triangle', 0.06));
}
