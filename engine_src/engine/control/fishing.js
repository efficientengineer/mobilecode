// engine/control/fishing.js
// The FISHING MINIGAME — Stardew's catch bar as a pure, real-time STATE MACHINE a
// UI drives. A vertical bar 0..1: the FISH bobs (a seeded pseudo-random target that
// darts and drifts), the GREEN CATCH BAR is a floaty box you shove UPWARD while the
// player HOLDS (reeling) and that falls by gravity when released. Keep the fish INSIDE
// the bar and a progress meter climbs; let it escape and progress bleeds away — catch
// at progress>=1, snap the line (fail) at progress<=0.
//
//   const bar = makeFishingBar({ difficulty: 0.4, seed: 7 });
//   bar.cast({ behavior: 'dart', difficulty: 0.6 });   // hook a new fish (fresh run)
//   // each frame, from your input layer:
//   const s = bar.step(dt, holding);                   // holding = reel button down
//   drawBar(s.barBottom, s.barTop); drawFish(s.fishPos); drawMeter(s.progress);
//   if (s.done) s.caught ? onCatch() : onGetAway();
//
// Everything lives in the closure and advances ONLY from the dt you feed it — no clock,
// no DOM, no Math.random (an injected seed drives an internal rng), so a sim replays a
// catch exactly and unit-tests by stepping with holding=true/false. Compose by PLAIN
// DATA: tools.js decides a bite happened, weather.js's fishingBonus can lower difficulty,
// then this owns the tug-of-war; the caller reads `caught` and hands the fish to inventory.

// A tiny deterministic rng (mulberry32) seeded from an integer — the ONLY source of
// randomness, so no Math.random and a seed replays the same fish dance.
function makeSeededRng(seed) {
  let a = (seed >>> 0) || 0x9e3779b9;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

// FISH MOTION FLAVORS — how the target reselects, Stardew's "behavior" per fish.
// Each returns a new target 0..1 given the rng roll, the current pos, and difficulty.
// Harder fish (higher difficulty) also retarget FASTER (see cast()), so darting reads
// as frantic. bias<1 pulls a fish downward (sinker), >1 upward (floater).
const BEHAVIORS = {
  smooth:  (r, pos) => clamp01(pos + (r - 0.5) * 0.5),          // lazy short drifts
  mixed:   (r) => r,                                            // anywhere, uniform
  dart:    (r, pos) => (r < 0.3 ? clamp01(pos + (r - 0.15))     // mostly small hops...
                                : r),                           // ...then a sudden leap
  sinker:  (r) => clamp01(r * r),                               // hugs the bottom
  floater: (r) => clamp01(1 - r * r),                           // hugs the top
};

export function makeFishingBar(cfg = {}) {
  const {
    fishSpeed = 0.5,     // how snappily the fish chases its target (0..1-ish)
    barSize   = 0.3,     // green bar height in 0..1 units (bigger = easier)
    fillRate  = 0.4,     // upward thrust while reeling (bar accel, units/s^2)
    drainRate = 0.35,    // gravity always pulling the bar down (units/s^2)
    difficulty = 0.4,    // 0 easy .. 1 brutal — fish speed/erraticism + escape bleed
    seed = 1,            // integer seed for the internal rng (determinism)
    startProgress = 0.35,// where the catch meter begins (Stardew ~0.3)
    catchSpeed = 0.55,   // progress/s gained while the fish is inside the bar
    escapeSpeed = 0.4,   // base progress/s lost while it's outside (scaled by difficulty)
    bounce = 0.3,        // how much the bar rebounds off the 0/1 walls (0=stick)
    force = 24,          // scales fill/drain into a responsive bar (Stardew tunes ~fast)
    treasure = false,    // add a stationary bonus target you also try to overlap
    treasureSpeed = 0.5, // progress/s the treasure meter fills while overlapped
  } = cfg;

  // Live run state — reset by cast(). The fish is a smoothed pursuer of `target`.
  let s;
  function reset(fish) {
    const diff = clamp01(fish && fish.difficulty != null ? fish.difficulty : difficulty);
    const behavior = (fish && fish.behavior) || 'mixed';
    s = {
      diff,
      motion: BEHAVIORS[behavior] || BEHAVIORS.mixed,
      rng: makeSeededRng((seed | 0) + Math.round(diff * 100) + behaviorSeed(behavior)),
      // fish
      fishPos: 0.5, target: 0.5, retarget: 0,
      // bar (center + velocity); half-height so top/bottom clamp to [0,1]
      half: barSize / 2, barCenter: barSize / 2, barVel: 0,
      // meters
      progress: clamp01(startProgress), done: false, caught: false,
      // optional treasure chest, placed once away from the edges
      hasTreasure: !!(fish && fish.treasure != null ? fish.treasure : treasure),
      treasurePos: 0, treasureProgress: 0, treasureCaught: false,
    };
    if (s.hasTreasure) s.treasurePos = 0.2 + s.rng() * 0.6;
    pickTarget();
  }
  function behaviorSeed(b) { return (b.charCodeAt(0) + (b.length << 4)) | 0; }

  // Choose a fresh target and a difficulty-scaled countdown to the next pick. Erratic
  // (hard) fish get shorter intervals so they jitter; calm fish hold a spot.
  function pickTarget() {
    s.target = clamp01(s.motion(s.rng(), s.fishPos, s.diff));
    const base = 1.6 - s.diff * 1.1;               // 1.6s calm .. 0.5s frantic
    s.retarget = base * (0.55 + s.rng() * 0.6);
  }

  // cast(fish) hooks a NEW fish and starts a fresh tug-of-war. `fish` is plain data:
  //   { difficulty?:0..1, behavior?:'smooth'|'mixed'|'dart'|'sinker'|'floater', treasure?:bool }
  function cast(fish) { reset(fish || {}); return snapshot(); }

  // step(dt, holding) advances the sim one frame and returns the full render/logic
  // snapshot. `holding` = reel button held this frame. Once done it freezes (idempotent).
  function step(dt, holding) {
    if (!s) reset({});
    dt = dt > 0 ? dt : 0;
    if (s.done || dt === 0) return snapshot();

    // — FISH: reselect on the timer, then ease toward the target. Exponential approach
    //   is frame-rate independent; `rate` (from fishSpeed + difficulty) sets snappiness,
    //   so a fast/hard fish darts across the bar while a calm one glides.
    s.retarget -= dt;
    if (s.retarget <= 0) pickTarget();
    const rate = 1.5 + fishSpeed * 6 + s.diff * 4;
    s.fishPos = clamp01(s.fishPos + (s.target - s.fishPos) * (1 - Math.exp(-rate * dt)));

    // — BAR: reeling accelerates the bar UP, releasing lets gravity accelerate it
    //   DOWN (a floaty two-button feel — tap to hover). Integrate the velocity, then
    //   clamp to the walls and rebound so it can't leave 0..1.
    s.barVel += (holding ? fillRate : -drainRate) * force * dt;
    s.barCenter += s.barVel * dt;
    if (s.barCenter - s.half < 0) { s.barCenter = s.half; if (s.barVel < 0) s.barVel = -s.barVel * bounce; }
    else if (s.barCenter + s.half > 1) { s.barCenter = 1 - s.half; if (s.barVel > 0) s.barVel = -s.barVel * bounce; }

    const barBottom = s.barCenter - s.half, barTop = s.barCenter + s.half;
    const overlapping = s.fishPos >= barBottom && s.fishPos <= barTop;

    // — PROGRESS: climb while the fish is caged, bleed while it's loose (harder fish
    //   bleed faster). Cross either wall and the run ends.
    if (overlapping) s.progress += catchSpeed * dt;
    else s.progress -= escapeSpeed * (0.5 + s.diff) * dt;
    s.progress = clamp01(s.progress);

    // — TREASURE: a stationary chest fills its own meter only while the bar covers it.
    let overlappingTreasure = false;
    if (s.hasTreasure && !s.treasureCaught) {
      overlappingTreasure = s.treasurePos >= barBottom && s.treasurePos <= barTop;
      if (overlappingTreasure) {
        s.treasureProgress = clamp01(s.treasureProgress + treasureSpeed * dt);
        if (s.treasureProgress >= 1) s.treasureCaught = true;
      }
    }

    if (s.progress >= 1) { s.done = true; s.caught = true; }
    else if (s.progress <= 0) { s.done = true; s.caught = false; }

    return snapshot(overlapping, overlappingTreasure);
  }

  // The pure DATA a UI paints and the game reads. barTop/barBottom bracket the green
  // bar; fishPos/treasurePos are the moving/stationary targets; progress drives the meter.
  function snapshot(overlapping, overlappingTreasure) {
    const barBottom = s.barCenter - s.half, barTop = s.barCenter + s.half;
    if (overlapping === undefined) overlapping = s.fishPos >= barBottom && s.fishPos <= barTop;
    const out = {
      fishPos: s.fishPos,
      barPos: s.barCenter, barTop, barBottom, barSize,
      progress: s.progress,
      overlapping,
      done: s.done,
      caught: s.caught,
    };
    if (s.hasTreasure) {
      out.treasurePos = s.treasurePos;
      out.treasureProgress = s.treasureProgress;
      out.treasureCaught = s.treasureCaught;
      out.overlappingTreasure = overlappingTreasure === undefined
        ? (s.treasurePos >= barBottom && s.treasurePos <= barTop) : overlappingTreasure;
    }
    return out;
  }

  reset(cfg.fish || {});
  return { step, cast, reset: (f) => reset(f || {}), get: () => snapshot(), BEHAVIORS };
}

export const fishing = { makeFishingBar, BEHAVIORS };
