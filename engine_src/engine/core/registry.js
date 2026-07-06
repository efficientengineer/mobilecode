// engine/core/registry.js
// A runtime set of entities that objects add/remove themselves to. add() and
// remove() are DEFERRED and applied on flush() (the loop calls it in the 'late'
// phase), so a system can safely spawn or kill things while iterating with
// each(). This is what lets systems never hold references to each other.
export function makeRegistry() {
  const items = new Set();
  const pendingAdd = [];
  const pendingRemove = [];
  return {
    add(e) { pendingAdd.push(e); return e; },
    remove(e) { pendingRemove.push(e); },
    has(e) { return items.has(e); },
    each(fn) { for (const e of items) fn(e); },
    query(pred) { const out = []; for (const e of items) if (!pred || pred(e)) out.push(e); return out; },
    get size() { return items.size; },
    flush() {
      if (pendingAdd.length) { for (const e of pendingAdd) items.add(e); pendingAdd.length = 0; }
      if (pendingRemove.length) { for (const e of pendingRemove) items.delete(e); pendingRemove.length = 0; }
    },
    clear() { items.clear(); pendingAdd.length = 0; pendingRemove.length = 0; },
  };
}
