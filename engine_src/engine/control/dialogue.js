// engine/control/dialogue.js
// NPC DIALOGUE / interaction trees — the talky side of NPC logic (behaviors.js is
// the moving side). A tree is a plain map of nodes you author as data:
//   { id: { text, speaker?, effect?, next?, choices:[{ label, next, cond, effect }] } }
// and `run(tree, {start,vars})` walks it: current line, the choices visible right
// now (after cond gating), and the verbs to move forward. Quest state lives in
// `vars` — conds read it to lock/unlock branches, effects write it to set flags.
//
// Pure & deterministic: no world/DOM/timers/Math.random. All mutation happens in
// the `vars` you pass (a save-game bag), so a sim walks a branching tree and
// asserts gating + var mutation + endings. text/speaker/label/next may each be a
// fn(vars) for dynamic lines and computed jumps; effects may mutate vars in place
// or return a patch object that gets merged.

function callv(v, vars) { return typeof v === 'function' ? v(vars) : v; }
function runEffect(fn, vars) {                 // mutate vars, or merge a returned patch
  if (!fn) return;
  const r = fn(vars);
  if (r && typeof r === 'object') Object.assign(vars, r);
}

export function run(tree = {}, opts = {}) {
  const vars = opts.vars || {};
  let cur = opts.start || 'start';
  let finished = false;

  const def = (id) => (tree ? tree[id] : null);
  const visible = () => {                       // choices whose cond passes right now
    const n = def(cur);
    if (!n || !n.choices) return [];
    return n.choices.filter((c) => !c.cond || c.cond(vars));
  };
  function enter(id) {                           // run the node's entry effect ONCE
    cur = id;
    const n = def(id);
    if (!n) { finished = true; return; }
    runEffect(n.effect, vars);
  }

  enter(cur);                                    // fire the start node's effect on open

  const api = {
    vars,
    id: () => cur,

    node() {                                     // the current line + gated choices, or null
      const n = def(cur);
      if (!n) return null;
      return {
        id: cur,
        speaker: callv(n.speaker, vars),
        text: callv(n.text, vars),
        choices: visible().map((c) => ({ label: callv(c.label, vars) })),
      };
    },

    choices() { const v = api.node(); return v ? v.choices : []; },

    choose(i) {                                  // take the i-th VISIBLE choice
      if (finished) return false;
      const c = visible()[i];
      if (!c) return false;                      // out of range / no choices → no-op
      runEffect(c.effect, vars);
      const nxt = callv(c.next, vars);
      if (nxt == null) { finished = true; return true; }   // choice with no next = ending
      enter(nxt);
      return true;
    },

    advance() {                                  // step a LINEAR line (no open choices)
      if (finished) return false;
      const n = def(cur);
      if (!n || visible().length) return false;  // has choices → must choose(), not advance
      const nxt = callv(n.next, vars);
      if (nxt == null) { finished = true; return false; }  // leaf → conversation over
      enter(nxt);
      return true;
    },

    goto(id) { enter(id); return api; },         // jump anywhere (scripted barks, retries)

    done() {                                      // terminal: nothing left to say or pick
      if (finished) return true;
      const n = def(cur);
      if (!n) return true;
      if (visible().length) return false;
      return callv(n.next, vars) == null;
    },
  };
  return api;
}

// --- authoring helpers: terse cond/effect builders that read & write vars ------
// conds return bool, effects mutate vars. Compose them straight into node data:
//   choices:[{ label:'Take the key', cond:not('hasKey'), effect:set('hasKey') }]
const set = (k, v = true) => (vars) => { vars[k] = v; };
const inc = (k, by = 1) => (vars) => { vars[k] = (vars[k] || 0) + by; };
const toggle = (k) => (vars) => { vars[k] = !vars[k]; };
const seq = (...effs) => (vars) => { for (const e of effs) runEffect(e, vars); };

const has = (k) => (vars) => !!vars[k];         // flag is set / truthy
const missing = (k) => (vars) => !vars[k];      // flag unset / falsy
const eq = (k, v) => (vars) => vars[k] === v;
const gte = (k, v) => (vars) => (vars[k] || 0) >= v;
const all = (...cs) => (vars) => cs.every((c) => !c || c(vars));  // AND (skips falsy)
const any = (...cs) => (vars) => cs.some((c) => c && c(vars));    // OR

export const dialogue = {
  run,
  set, inc, toggle, seq,
  has, missing, eq, gte, all, any,
};
