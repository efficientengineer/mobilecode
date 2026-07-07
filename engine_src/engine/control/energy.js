// engine/control/energy.js
// STAMINA / ENERGY + HEALTH vitals — the action budget that gates a farm day.
// This is the Stardew-style "how much can I still DO today?" object: every swing
// of a tool, till, water, or chop SPENDS energy; food RESTORES it; sleep REFILLS
// it overnight. Push past 0 and you get EXHAUSTED (jobs blocked); ignore that and
// pass out, and tomorrow's refill takes a penalty. Health is the separate "am I
// alive?" pool (mine cave-ins, monsters) that food/heal top up.
//
// Pure DATA + closures — no world/DOM/timers/Math.random. A game holds ONE vitals
// object on the player and reads .energy/.health for the HUD; farm tools ask
// canAfford(n) before acting and spend(n) to commit. Compose with tools.js /
// clock.js (sleep at day's end) via plain calls, never hard imports.

const clamp = (n, lo, hi) => (n < lo ? lo : n > hi ? hi : n);

export function makeVitals({ maxEnergy = 270, maxHealth = 100, energy, health } = {}) {
  // Start full unless a save injects partial energy/health (clamped to caps).
  const v = {
    energy: energy == null ? maxEnergy : clamp(energy, 0, maxEnergy),
    maxEnergy,
    health: health == null ? maxHealth : clamp(health, 0, maxHealth),
    maxHealth,
    exhausted: false,   // hit 0 today — jobs blocked, next sleep is dampened
    passedOut: false,   // collapsed (spent while already exhausted / drained health)

    // --- ENERGY: the daily action budget ---------------------------------
    canAfford(n = 0) {                 // does a job fit in the remaining budget?
      return this.energy >= n;
    },
    spend(n = 0) {                     // pay for a job; false + clamp if it can't complete
      if (n <= 0) return true;
      if (this.energy < n) {           // can't finish — drain to empty, mark exhausted
        this.energy = 0;
        this.exhausted = true;
        this.passedOut = true;         // worked past collapse
        return false;
      }
      this.energy -= n;
      if (this.energy === 0) this.exhausted = true;  // exact-empty still counts
      return true;
    },
    restore(n = 0) {                   // add energy, capped at max (drink, rest spot)
      this.energy = clamp(this.energy + n, 0, this.maxEnergy);
      return this.energy;
    },

    // --- HEALTH: the survival pool ---------------------------------------
    damage(n = 0) {                    // take a hit; pass out (not death) at 0
      this.health = clamp(this.health - n, 0, this.maxHealth);
      if (this.health === 0) this.passedOut = true;
      return this.health;
    },
    heal(n = 0) {                      // top health up, capped at max
      this.health = clamp(this.health + n, 0, this.maxHealth);
      return this.health;
    },

    // --- FOOD: one bite feeds both pools --------------------------------
    eat(food = {}) {                   // food = { energy?, health? }; both capped
      if (food.energy) this.restore(food.energy);
      if (food.health) this.heal(food.health);
      // Eating back above 0 clears the exhausted lockout (you got your wind back).
      if (this.energy > 0) this.exhausted = false;
      return this;
    },

    // --- SLEEP: the overnight refill ------------------------------------
    sleep({ overworked, penalty = 0.5, healthPenalty = 0.1 } = {}) {
      // Refill energy to max — MINUS a penalty if you ended yesterday spent.
      // `overworked` lets the caller force the penalty (e.g. worked past 2am);
      // otherwise a prior exhausted/passedOut day docks you. Health tops up too,
      // but a collapse costs a slice of it (you woke up rough).
      const docked = overworked || this.exhausted || this.passedOut;
      this.energy = docked ? Math.round(this.maxEnergy * (1 - penalty)) : this.maxEnergy;
      if (this.passedOut) this.health = Math.round(this.maxHealth * (1 - healthPenalty));
      else this.health = this.maxHealth;
      this.exhausted = false;
      this.passedOut = false;
      return this;
    },

    // --- UPGRADES: perks/levels raise the ceilings ----------------------
    setMax(nextEnergy, nextHealth) {   // raise (or set) caps; current pools follow up, never truncate down silently
      if (nextEnergy != null) {
        this.maxEnergy = nextEnergy;
        if (this.energy > this.maxEnergy) this.energy = this.maxEnergy;
      }
      if (nextHealth != null) {
        this.maxHealth = nextHealth;
        if (this.health > this.maxHealth) this.health = this.maxHealth;
      }
      return this;
    },

    pct() {                            // 0..1 energy fraction — for the HUD bar
      return this.maxEnergy > 0 ? this.energy / this.maxEnergy : 0;
    },
  };
  return v;
}

export const energy = { makeVitals };
