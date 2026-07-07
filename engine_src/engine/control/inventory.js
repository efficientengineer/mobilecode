// engine/control/inventory.js
// INVENTORY + EQUIPMENT — the "what am I carrying / wearing" model, a swappable
// meta-game system like save/economy. It is PURE DATA: slots, stacks and equipped
// gear live in a closure, never in window/localStorage/DOM, so a menu screen, a
// loot drop, a crafting bench and a headless sim all drive the SAME store.
//
//   const bag = inventory.makeInventory({ slots: 20, stackSize: 99, catalog });
//   const leftover = bag.add('potion', 5);   // fills stacks then empty slots
//   bag.has('potion', 3);  bag.count('potion');  bag.remove('potion', 2);
//   bag.move(0, 4);                            // drag a slot in the UI
//
//   const gear = inventory.makeEquipment({ slots: ['weapon','armor','trinket'] });
//   gear.equip({ id:'sword', slot:'weapon', stats:{ atk:5 } });  // returns old item
//   gear.stats();                              // summed stat bag of everything worn
//
// An ITEM is plain data: { id, stack?, stats?, slot?, ...anything }. Per-item
// `stack` overrides the bag's default stackSize (via an optional `catalog`); an
// equippable item names its target slot with `slot`. Nothing here mutates the item
// objects you pass in — the store only tracks { id, qty } references.

// -------- helpers ---------------------------------------------------------------

function lookup(catalog, id) {            // resolve an item def from an injected catalog
  if (!catalog) return null;
  if (typeof catalog === 'function') return catalog(id) || null;
  if (typeof catalog.get === 'function') return catalog.get(id) || null;  // Map
  return catalog[id] || null;             // plain object map
}

// -------- inventory: slots + stacking -------------------------------------------

export function makeInventory({ slots = 20, stackSize = 99, catalog = null } = {}) {
  const cells = new Array(slots).fill(null);   // each cell: null | { id, qty }

  // Per-item cap: item.stack from the catalog, else the bag default. Floored at 1.
  const capOf = (id) => {
    const def = lookup(catalog, id);
    const s = def && def.stack != null ? def.stack : stackSize;
    return Math.max(1, s | 0);
  };

  function add(itemId, qty = 1) {
    let left = Math.max(0, qty | 0);
    if (!itemId || left === 0) return left;
    const cap = capOf(itemId);
    // 1) top up existing stacks of this item
    for (let i = 0; i < cells.length && left > 0; i++) {
      const c = cells[i];
      if (c && c.id === itemId && c.qty < cap) {
        const put = Math.min(cap - c.qty, left);
        c.qty += put; left -= put;
      }
    }
    // 2) spill the rest into empty slots
    for (let i = 0; i < cells.length && left > 0; i++) {
      if (cells[i] === null) {
        const put = Math.min(cap, left);
        cells[i] = { id: itemId, qty: put }; left -= put;
      }
    }
    return left;                          // what did NOT fit (0 = all stowed)
  }

  function remove(itemId, qty = 1) {
    let need = Math.max(0, qty | 0);
    const want = need;
    for (let i = 0; i < cells.length && need > 0; i++) {
      const c = cells[i];
      if (c && c.id === itemId) {
        const take = Math.min(c.qty, need);
        c.qty -= take; need -= take;
        if (c.qty === 0) cells[i] = null;
      }
    }
    return want - need;                   // how many were actually removed
  }

  function count(itemId) {
    let n = 0;
    for (const c of cells) if (c && c.id === itemId) n += c.qty;
    return n;
  }

  const has = (itemId, qty = 1) => count(itemId) >= Math.max(1, qty | 0);

  // Drag slot `from` onto slot `to`: fill empty, MERGE same-id (respecting cap,
  // leaving any overflow behind), else SWAP. Returns false on a no-op/bad index.
  function move(from, to) {
    if (from === to) return false;
    if (from < 0 || to < 0 || from >= cells.length || to >= cells.length) return false;
    const a = cells[from], b = cells[to];
    if (!a) return false;
    if (!b) { cells[to] = a; cells[from] = null; return true; }
    if (a.id === b.id) {
      const cap = capOf(a.id);
      const put = Math.min(cap - b.qty, a.qty);
      if (put <= 0) { cells[from] = b; cells[to] = a; return true; }  // both full → swap
      b.qty += put; a.qty -= put;
      if (a.qty === 0) cells[from] = null;
      return true;
    }
    cells[from] = b; cells[to] = a; return true;      // different items → swap
  }

  // Snapshot aligned to slot indices (null = empty), safe to read in a UI loop.
  const items = () => cells.map((c) => (c ? { id: c.id, qty: c.qty } : null));

  return {
    add, remove, count, has, move, items,
    get slots() { return cells.length; },
    get slotsUsed() { let n = 0; for (const c of cells) if (c) n++; return n; },
    get free() { let n = 0; for (const c of cells) if (!c) n++; return n; },
  };
}

// -------- equipment: named slots + summed stats ---------------------------------

export function makeEquipment({ slots = ['weapon', 'armor', 'trinket'] } = {}) {
  const worn = Object.create(null);       // slotName -> item | undefined
  const names = slots.slice();
  const valid = (s) => names.indexOf(s) !== -1;

  // Equip into `slot` (defaults to item.slot). Returns the DISPLACED item (or null),
  // so the caller can drop the old gear back into a bag. No-op returns null.
  function equip(item, slot = item && item.slot) {
    if (!item || !valid(slot)) return null;
    const prev = worn[slot] || null;
    worn[slot] = item;
    return prev;
  }

  function unequip(slot) {
    if (!valid(slot)) return null;
    const prev = worn[slot] || null;
    delete worn[slot];
    return prev;
  }

  const get = (slot) => worn[slot] || null;

  // Sum every equipped item's `stats` bag into one flat totals object.
  function stats() {
    const total = Object.create(null);
    for (const s of names) {
      const it = worn[s];
      if (it && it.stats) for (const k in it.stats) total[k] = (total[k] || 0) + it.stats[k];
    }
    return total;
  }

  return {
    equip, unequip, get, stats,
    slots: () => names.slice(),
    all: () => names.map((s) => ({ slot: s, item: worn[s] || null })),
  };
}

export const inventory = { makeInventory, makeEquipment };
