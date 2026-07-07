// engine/core/rng.js
// A tiny seeded RNG (mulberry32) so runs are deterministic when you want them
// (replays, multiplayer sync). Use rng.next() in the simulation instead of
// Math.random() so the same seed always produces the same game.
export function makeRng(seed = 1) {
  let a = seed >>> 0;
  const api = {
    next() {
      a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    },
    range(min, max) { return min + api.next() * (max - min); },
    int(min, max) { return Math.floor(api.range(min, max + 1)); },
    seed(s) { a = s >>> 0; },
  };
  return api;
}
