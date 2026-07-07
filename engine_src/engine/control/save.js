// engine/control/save.js
// SAVE / PERSISTENCE helpers — reliable game-state save-load with NO hard-coded
// storage backend. Everything goes through an injected `store` adapter
//   { get(key)->str|null, set(key,str), remove(key) }
// so the SAME code runs on localStorage in-app, a plain object in tests, a file
// shim on a server, or the in-RAM memoryStore() below for a first run. Pure and
// deterministic: no window/localStorage/DOM/timers/Math.random ever touched here.
//
// A saved slot is JSON with a version stamp: { v, t, data }. On load, if the
// stored `v` is older than the current `version`, migrate(old, fromVersion) runs
// to upgrade the shape — so a save shipped on v1 survives a v2 schema change.
//
//   const save = makeSave({ store: localStorage, version: 2, migrate });
//   save.save('slot1', world);           // stamp + serialize + persist
//   const world = save.load('slot1', {}); // parse + migrate-if-old + unwrap
//   save.has('slot1'); save.list(); save.clear('slot1');
//
// autosave(getState, { everyMs }) -> step(dt) that persists on an interval, and
// memoryStore() hands back a throwaway adapter for tests / the very first run.

const PREFIX = 'save:';                 // namespace so list()/clear-all only touch ours

function keyOf(prefix, slot) { return prefix + String(slot); }

// Parse a stored string into the wrapped envelope, tolerating legacy/plain JSON.
// Returns { v, t, data } or null if the string is absent/corrupt.
function unwrap(str) {
  if (str == null) return null;
  let obj;
  try { obj = JSON.parse(str); } catch (_) { return null; }
  if (obj && typeof obj === 'object' && 'v' in obj && 'data' in obj) return obj;
  // Legacy save written before versioning: treat the whole blob as v0 data.
  return { v: 0, t: 0, data: obj };
}

export function makeSave({ store, version = 1, migrate, prefix = PREFIX, clock } = {}) {
  if (!store || typeof store.get !== 'function' || typeof store.set !== 'function') {
    throw new Error('makeSave: needs a store adapter { get, set, remove }');
  }
  // `clock` is an optional injected () -> ms for the timestamp stamp (keeps the
  // module node-safe — no Date.now on the hot path unless a game opts in).
  const now = () => (typeof clock === 'function' ? clock() : 0);

  function save(slot, data) {
    const env = { v: version, t: now(), data };
    store.set(keyOf(prefix, slot), JSON.stringify(env));
    return env;
  }

  function load(slot, fallback = null) {
    const env = unwrap(store.get(keyOf(prefix, slot)));
    if (!env) return fallback;
    let data = env.data;
    if (env.v < version && typeof migrate === 'function') {
      // Walk the shape forward from its stored version to the current one.
      data = migrate(data, env.v, version);
    }
    return data === undefined ? fallback : data;
  }

  function has(slot) {
    return store.get(keyOf(prefix, slot)) != null;
  }

  function clear(slot) {
    if (typeof store.remove === 'function') store.remove(keyOf(prefix, slot));
    else store.set(keyOf(prefix, slot), null);   // adapters without remove: blank it
  }

  // Enumerate the slots we own. Prefers a store that exposes keys()/keys array;
  // falls back to the memoryStore's own listing. Slot names are the un-prefixed tail.
  function list() {
    let keys = null;
    if (typeof store.keys === 'function') keys = store.keys();
    else if (Array.isArray(store.keys)) keys = store.keys;
    else if (typeof store.length === 'number' && typeof store.key === 'function') {
      keys = []; for (let i = 0; i < store.length; i++) keys.push(store.key(i));  // localStorage
    }
    if (!keys) return [];
    const out = [];
    for (const k of keys) if (typeof k === 'string' && k.startsWith(prefix)) out.push(k.slice(prefix.length));
    return out;
  }

  // Read the raw envelope (version + timestamp) without unwrapping data — for a
  // save-slot menu that shows "v2 · saved at …".
  function meta(slot) {
    const env = unwrap(store.get(keyOf(prefix, slot)));
    return env ? { v: env.v, t: env.t, stale: env.v < version } : null;
  }

  return { save, load, has, clear, list, meta, version };
}

// autosave: fold a persist call into the frame loop on a fixed real-time cadence.
// step(dt) accumulates dt (seconds) and, once `everyMs` has elapsed, snapshots
// getState() through the save API and writes the slot. Deterministic — driven only
// by the dt you feed it, no timers. Returns whether it wrote this frame.
export function autosave(getState, { save, slot = 'auto', everyMs = 30000, immediate = false } = {}) {
  if (typeof getState !== 'function') throw new Error('autosave: getState must be a function');
  if (!save || typeof save.save !== 'function') throw new Error('autosave: needs a makeSave instance');
  const everyS = Math.max(0, everyMs / 1000);
  let acc = 0, first = true;

  function step(dt) {
    acc += dt || 0;
    if ((first && immediate) || acc >= everyS) {
      first = false; acc = 0;
      save.save(slot, getState());
      return true;
    }
    first = false;
    return false;
  }
  step.flush = () => { first = false; acc = 0; save.save(slot, getState()); return true; }; // force-write now
  step.reset = () => { acc = 0; first = true; };
  return step;
}

// memoryStore: a self-contained in-RAM adapter matching the store contract, with a
// keys() enumerator so save.list() works. For tests, headless sims, and the first
// run before any real backend is wired.
export function memoryStore(seed) {
  const mem = new Map(seed ? Object.entries(seed) : undefined);
  return {
    get(key) { return mem.has(key) ? mem.get(key) : null; },
    set(key, str) { if (str == null) mem.delete(key); else mem.set(key, String(str)); },
    remove(key) { mem.delete(key); },
    keys() { return [...mem.keys()]; },
    clear() { mem.clear(); },
    get size() { return mem.size; },
  };
}

export const save = { makeSave, autosave, memoryStore };
