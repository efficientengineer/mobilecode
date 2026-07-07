// engine/control/economy.js
// ECONOMY — currency, shops, pricing and crafting: the "money and stuff" meta-game
// layer, a swappable pure-data system like inventory/save/progression. Nothing here
// touches window/localStorage/DOM — a wallet is a number in a closure (or an injected
// store), a shop reads plain stock rows, and crafting walks recipe data. So a HUD, a
// vendor screen, a loot drop and a headless sim all drive the SAME numbers.
//
//   const purse = economy.makeWallet({ start: 200 });
//   purse.earn(50);  purse.canAfford(30);  purse.spend(30);   // false if broke
//
//   const shop = economy.makeShop({ stock: [{ id:'potion', price:25, qty:5 }] });
//   const item = shop.buy('potion', purse, bag);   // checks funds+stock, debits, adds
//   shop.sell('potion', purse, bag);               // credits sellMul * price, pulls 1
//   shop.restock();                                // refill to the original quantities
//
//   const bench = economy.makeCrafting([{ id:'elixir', out:'elixir', in:[{ id:'herb', qty:2 }] }]);
//   if (bench.canCraft('elixir', bag)) bench.craft('elixir', bag);  // eats herbs, yields
//
// INVENTORY is optional and duck-typed: anything with add/remove/count (the engine's
// inventory.js), a plain object map { herb: 3 }, or a Map all work — buy/sell/craft
// route through a tiny adapter. Wallets accept an injected `store` ({ get, set } or a
// signal) so balance can live in a save file. Pure, deterministic, node-safe.

// -------- inventory adapter — normalize the many shapes into add/remove/count -----

function invAdapter(inv) {
  if (!inv) return null;
  // Engine inventory.js / anything already exposing the verbs.
  if (typeof inv.count === 'function' && typeof inv.add === 'function' && typeof inv.remove === 'function') {
    return {
      count: (id) => inv.count(id) | 0,
      add: (id, q) => inv.add(id, q),
      remove: (id, q) => inv.remove(id, q),   // returns amount actually removed
    };
  }
  // A Map of id -> qty.
  if (typeof inv.get === 'function' && typeof inv.set === 'function') {
    return {
      count: (id) => inv.get(id) | 0,
      add: (id, q) => { inv.set(id, (inv.get(id) | 0) + q); return 0; },
      remove: (id, q) => {
        const have = inv.get(id) | 0, take = Math.min(have, q);
        if (have - take <= 0) inv.delete(id); else inv.set(id, have - take);
        return take;
      },
    };
  }
  // A plain object map { id: qty }.
  return {
    count: (id) => inv[id] | 0,
    add: (id, q) => { inv[id] = (inv[id] | 0) + q; return 0; },
    remove: (id, q) => {
      const have = inv[id] | 0, take = Math.min(have, q);
      const left = have - take;
      if (left <= 0) delete inv[id]; else inv[id] = left;
      return take;
    },
  };
}

const clamp0 = (n) => (n > 0 ? n : 0);
const money = (n) => Math.round(clamp0(Number(n) || 0));   // a non-negative amount
const coins = (n) => Math.round(Number(n) || 0);           // a balance (may go negative)

// -------- wallet — the currency store -------------------------------------------

export function makeWallet({ start = 0, store = null, allowDebt = false, min = 0 } = {}) {
  // A balance you can earn into and spend from. State lives here unless you inject a
  // `store` (a signal, or any { get, set }), letting the balance live in a save file.
  let bal = coins(start);
  const read = store && store.get ? () => coins(store.get()) : () => bal;
  const write = store && store.set ? (v) => store.set(coins(v)) : (v) => { bal = coins(v); };
  if (store && store.set && (store.get ? store.get() == null : true)) write(start);

  function earn(n) {                          // add coins (ignores negatives)
    const add = money(n);
    write(read() + add);
    return read();
  }
  const canAfford = (n) => read() >= money(n);
  function spend(n) {                          // debit; false (no change) if short
    const cost = money(n);
    if (!allowDebt && read() < cost) return false;
    write(read() - cost);
    if (allowDebt && read() < min) write(min);
    return true;
  }

  return {
    earn, spend, canAfford,
    get balance() { return read(); },
    set balance(v) { write(v); },
  };
}

// -------- pricing — optional dynamic price curves --------------------------------

export function priceCurve(base, { demand = 0, elasticity = 0.5, min = 1, max = Infinity } = {}) {
  // Nudge a base price by market `demand` (-1 glut .. +1 shortage). `elasticity` is
  // how hard demand bites; result is clamped and rounded. demand 0 = base unchanged.
  const d = Math.max(-1, Math.min(1, Number(demand) || 0));
  const p = base * (1 + d * elasticity);
  return Math.max(money(min), Math.min(max === Infinity ? Infinity : money(max), money(p)));
}

// -------- shop — buy / sell / stock ----------------------------------------------

export function makeShop({ stock = [], buyMul = 1, sellMul = 0.5, currency = null } = {}) {
  // A vendor over a list of stock rows { id, price, qty? } (qty omitted = unlimited).
  // buyMul/sellMul scale the listed price for purchase vs. buy-back. Restock returns
  // every row to its ORIGINAL qty. `currency` is an optional demand map { id: -1..1 }.
  const rows = new Map();
  const start = new Map();                     // original qty for restock()
  for (const s of stock) {
    if (!s || s.id == null) continue;
    const qty = s.qty == null ? Infinity : Math.max(0, s.qty | 0);
    rows.set(s.id, { id: s.id, price: money(s.price), qty, demand: s.demand || 0 });
    start.set(s.id, qty);
  }
  const row = (id) => rows.get(id) || null;

  function listed(id) {                         // the row's base price after demand
    const r = row(id); if (!r) return null;
    return r.demand ? priceCurve(r.price, { demand: r.demand }) : r.price;
  }
  const price = (id) => { const b = listed(id); return b == null ? null : money(b * buyMul); };
  const sellPrice = (id) => { const b = listed(id); return b == null ? null : money(b * sellMul); };
  const inStock = (id) => { const r = row(id); return !!r && r.qty > 0; };

  function buy(id, wallet, inv) {
    const r = row(id); if (!r) return null;
    if (r.qty <= 0) return null;                 // sold out
    const cost = price(id);
    if (wallet && !wallet.spend(cost)) return null;   // broke → no change
    if (r.qty !== Infinity) r.qty -= 1;
    const a = invAdapter(inv); if (a) a.add(id, 1);
    return { id, qty: 1, price: cost };
  }

  function sell(id, wallet, inv) {
    const a = invAdapter(inv);
    if (a && a.remove(id, 1) < 1) return null;   // nothing to sell back
    const paid = sellPrice(id) != null ? sellPrice(id) : 0;
    if (wallet) wallet.earn(paid);
    const r = row(id); if (r && r.qty !== Infinity) r.qty += 1;   // buy-back returns to shelf
    return { id, qty: 1, price: paid };
  }

  function restock() {
    for (const [id, q] of start) { const r = row(id); if (r) r.qty = q; }
  }

  return {
    price, sellPrice, inStock, buy, sell, restock,
    stockOf: (id) => { const r = row(id); return r ? r.qty : 0; },
    setDemand: (id, d) => { const r = row(id); if (r) r.demand = Math.max(-1, Math.min(1, d)); },
    ids: () => [...rows.keys()],
  };
}

// -------- crafting — recipes that consume inputs and yield an output --------------

export function makeCrafting(recipes = []) {
  // Recipes: { id, out, in:[{id,qty}], outQty? }. `out` defaults to `id`. canCraft
  // checks the inventory has every input; craft consumes them (all-or-nothing) and
  // adds the output, returning the produced item ref (or null if it couldn't).
  const book = new Map();
  for (const r of recipes) if (r && r.id != null) book.set(r.id, r);
  const recipe = (id) => book.get(id) || null;

  function canCraft(id, inv) {
    const r = recipe(id); if (!r) return false;
    const a = invAdapter(inv); if (!a) return false;
    for (const need of r.in || []) if (a.count(need.id) < Math.max(1, need.qty | 0)) return false;
    return true;
  }

  function craft(id, inv) {
    const r = recipe(id); if (!r) return null;
    if (!canCraft(id, inv)) return null;
    const a = invAdapter(inv);
    for (const need of r.in || []) a.remove(need.id, Math.max(1, need.qty | 0));
    const out = r.out != null ? r.out : r.id;
    const outQty = Math.max(1, r.outQty | 0 || 1);
    a.add(out, outQty);
    return { id: out, qty: outQty };
  }

  return { canCraft, craft, recipe, ids: () => [...book.keys()] };
}

export const economy = {
  makeWallet, makeShop, makeCrafting, priceCurve, invAdapter,
};
