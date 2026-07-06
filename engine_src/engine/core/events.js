// engine/core/events.js
// The event bus. Systems talk through named events instead of importing each
// other: emit('enemy-died', e) reaches every on('enemy-died', ...) listener,
// and neither side knows the other exists. Add ?debug to the URL to log events.
const listeners = new Map();
const PHASES = new Set(['input', 'update', 'physics', 'render', 'late']);
const DEBUG = typeof location !== 'undefined' && /[?&]debug/.test(location.search);

export function on(name, fn) {
  let set = listeners.get(name);
  if (!set) listeners.set(name, (set = new Set()));
  set.add(fn);
  return () => set.delete(fn);            // call the return value to unsubscribe
}

export function off(name, fn) {
  const set = listeners.get(name);
  if (set) set.delete(fn);
}

export function emit(name, data) {
  if (DEBUG && !PHASES.has(name)) console.log('[event]', name, data === undefined ? '' : data);
  const set = listeners.get(name);
  if (!set) return;
  for (const fn of [...set]) {            // copy so a listener can subscribe/unsub safely
    try { fn(data); } catch (e) { console.error('listener for "' + name + '" failed:', e); }
  }
}

export function clearEvents() { listeners.clear(); }
