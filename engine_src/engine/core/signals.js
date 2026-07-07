// engine/core/signals.js
// A signal is one reactive value — the single source of truth for a piece of
// state. Read .get(), change with .set(v) or .update(fn), react with
// .subscribe(fn). Every system shares the SAME signal instance, so nothing
// keeps its own private copy of the score or the player's health.
export function signal(initial) {
  let value = initial;
  const subs = new Set();
  const api = {
    get: () => value,
    set(v) {
      if (v === value) return;
      value = v;
      for (const fn of [...subs]) {
        try { fn(v); } catch (e) { console.error('signal subscriber failed:', e); }
      }
    },
    update(fn) { api.set(fn(value)); },
    subscribe(fn) { subs.add(fn); fn(value); return () => subs.delete(fn); },
  };
  return api;
}
