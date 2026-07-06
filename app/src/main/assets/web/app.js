"use strict";

// --- Native bridge -------------------------------------------------------
// Kotlin exposes `Native.invoke(reqId, action, argJson)`. Results come back
// via window.nativeResolve / nativeReject; async events via nativeEvent.
let _req = 0;
const _pending = {};
function call(action, arg) {
  return new Promise((resolve, reject) => {
    const id = "r" + (++_req);
    _pending[id] = { resolve, reject };
    try {
      Native.invoke(id, action, JSON.stringify(arg || {}));
    } catch (e) {
      delete _pending[id];
      reject(e);
    }
  });
}
window.nativeResolve = (id, json) => {
  const p = _pending[id]; if (!p) return; delete _pending[id];
  let v = {}; try { v = JSON.parse(json); } catch (e) {}
  p.resolve(v);
};
window.nativeReject = (id, msg) => {
  const p = _pending[id]; if (!p) return; delete _pending[id];
  p.reject(new Error(msg || "error"));
};
let _dictBase = "";
window.nativeEvent = (type, payload) => {
  const box = $("#input");
  if (type === "speech-partial") {
    box.value = _dictBase + (_dictBase ? " " : "") + (payload || "");
    box.dispatchEvent(new Event("input"));
  } else if (type === "speech-final") {
    // Commit the utterance into the box; do NOT submit. Keep dictating.
    if (payload && payload.trim()) {
      box.value = _dictBase + (_dictBase ? " " : "") + payload.trim();
      _dictBase = box.value;
      box.dispatchEvent(new Event("input"));
      box.focus();
    }
    setStatus("");
  } else if (type === "status") {
    setStatus(payload);
  }
};

let currentMode = "auto";

// --- DOM helpers ---------------------------------------------------------
const $ = (s) => document.querySelector(s);
const chat = $("#chat");
function setStatus(t) { $("#status").textContent = t || ""; }

function estTokens(s) {
  return Math.max(1, Math.round((s || "").length / 4));
}

function bubble(text, kind, runId, ctxText) {
  const d = document.createElement("div");
  d.className = "bubble " + kind;
  d.textContent = text;
  if (runId) {
    d.classList.add("tappable");
    d.onclick = () => openRun(runId);
  }
  chat.appendChild(d);
  // Per-message token estimate = what this turn costs in CONTEXT (the compact
  // form), not the full displayed text. UI only — never itself sent.
  if ((kind === "user" || kind === "agent") && ctxText !== false) {
    const t = document.createElement("div");
    t.className = "tok " + kind;
    t.textContent = "~" + estTokens(ctxText != null ? ctxText : text) + " ctx tokens";
    chat.appendChild(t);
  }
  chat.scrollTop = chat.scrollHeight;
  return d;
}

function shortModel(m) {
  if (!m) return "default";
  const s = String(m);
  return s.includes("/") ? s.slice(s.indexOf("/") + 1) : s;
}

async function refreshHeader() {
  const m = await call("session.meta");
  $("#subtitle").textContent =
    (m.name || "session") + " • " + (m.activeRepo || "no repo");
  const mn = $("#modelName");
  if (mn) mn.textContent = shortModel(m.orchestrator);
}

async function loadHistory() {
  chat.innerHTML = "";
  try {
    const r = JSON.parse((await call("orch", { fn: "get_discussion" })).text);
    (r.turns || []).forEach((t) =>
      bubble(t.text, t.role === "user" ? "user" : "agent", t.run_id || null, t.ctx));
  } catch (e) {}
  refreshStats();
}

// --- Context + balance stats -------------------------------------------
let _balStart = null;
async function refreshStats() {
  try {
    const c = JSON.parse((await call("orch", { fn: "context_counts" })).text);
    const sent = c.sentTurns != null ? c.sentTurns : c.turns;
    const turnStr = sent < c.turns ? `${sent}/${c.turns} turns` : `${c.turns} turns`;
    let s = `ctx ~${(c.outlineTokens + c.discussionTokens + (c.memoryTokens || 0))}t ` +
            `(outline ${c.outlineTokens} · disc ${c.discussionTokens} · ${turnStr})`;
    if (c.caveman) s += " · 🪨";
    try {
      const pins = JSON.parse((await call("orch", { fn: "list_context_files" })).text);
      if (pins.length) s += ` · 📎${pins.length}`;
    } catch (e) {}
    $("#stats").textContent = s;
  } catch (e) {}
  refreshBalance();
  refreshAttachBar();
}

async function refreshAttachBar() {
  const bar = $("#attachBar");
  if (!bar) return;
  let pinned = [];
  try { pinned = JSON.parse((await call("orch", { fn: "list_context_files" })).text); } catch (e) {}
  if (!pinned.length) { bar.classList.add("hidden"); bar.innerHTML = ""; return; }
  bar.classList.remove("hidden");
  bar.innerHTML =
    `<span class="attach-label">Context:</span>` +
    pinned.map((p) => {
      const name = p.includes("/") ? p.slice(p.lastIndexOf("/") + 1) : p;
      return `<span class="attach-chip" title="${escapeHtml(p)}">${escapeHtml(name)}<b data-rm="${escapeHtml(p)}">✕</b></span>`;
    }).join("");
  bar.querySelectorAll("[data-rm]").forEach((el) => {
    el.onclick = async (ev) => {
      ev.stopPropagation();
      await call("orch", { fn: "remove_context_file", arg: el.dataset.rm });
      refreshAttachBar(); refreshStats();
    };
  });
}

async function refreshBalance() {
  const el = $("#balance");
  if (!el) return;
  try {
    const b = JSON.parse((await call("py.call", { module: "git_ops", fn: "balance_value" })).text);
    if (b.deepseek == null) {
      el.className = "balchip none";
      el.textContent = "no balance";
      return;
    }
    if (_balStart == null) _balStart = b.deepseek;
    const used = _balStart - b.deepseek;
    el.className = "balchip" + (b.deepseek < 1 ? " low" : "");
    let t = `${b.deepseek.toFixed(2)} ${b.currency || ""}`.trim();
    if (used > 0.001) t += ` (−${used.toFixed(2)})`;
    el.textContent = t;
  } catch (e) {
    el.className = "balchip none";
    el.textContent = "balance ?";
  }
}

// --- Run state machine (queue + live progress + interrupt) --------------
let running = false;
const queue = [];

function renderQueue() {
  const c = $("#queueChips");
  c.innerHTML = queue.map((q, i) =>
    `<span class="qchip">${q.mode}: ${escapeHtml(q.task).slice(0, 24)}<b data-q="${i}"> ✕</b></span>`
  ).join("");
  c.querySelectorAll("[data-q]").forEach((el) => {
    el.onclick = () => { queue.splice(+el.dataset.q, 1); renderQueue(); };
  });
}

function submit(task) {
  if (running) {
    queue.push({ task, mode: currentMode });
    bubble(task, "user");
    renderQueue();
    return;
  }
  runTask(task, currentMode);
}

// Poll run events into a live element. Streams `delta` text into a tail
// block so the model's reply appears as it is generated; tracks whether a
// commit is pending user review. Returns { stop(), pendingCommit() }.
function makeLivePoller(live) {
  const lines = [];
  let stream = "";
  let cursor = 0, polling = true, pending = false;
  function render() {
    let t = lines.slice(-10).join("\n");
    if (stream) t += (t ? "\n" : "") + "💬 " + stream.slice(-600);
    live.textContent = t || "Starting…";
    chat.scrollTop = chat.scrollHeight;
  }
  (async function poll() {
    while (polling) {
      try {
        const r = JSON.parse((await call("orch", { fn: "get_events", arg: String(cursor) })).text);
        cursor = r.cursor;
        (r.events || []).forEach((e) => {
          if (e.kind === "delta") { stream += e.text || ""; return; }
          if (e.kind === "todos") { renderTodos(e.todos || []); return; }
          if (e.kind === "pending_commit") pending = true;
          if (e.kind === "step") stream = ""; // new model turn — reset the tail
          const f = fmtEvent(e);
          if (f) lines.push(f);
        });
        render();
      } catch (e) {}
      await new Promise((r) => setTimeout(r, 500));
    }
  })();
  return { stop() { polling = false; }, pendingCommit: () => pending };
}

async function runTask(task, mode) {
  running = true;
  bubble(task, "user");
  clearTodos();
  $("#runbar").classList.remove("hidden");
  $("#runlabel").textContent = mode === "plan" ? "Planning…" : "Working…";
  const live = document.createElement("div");
  live.className = "live";
  live.textContent = "Starting…";
  chat.appendChild(live);
  const poller = makeLivePoller(live);

  let reply = "";
  try {
    reply = (await call("agent.run", { task, mode })).text || "";
  } catch (e) {
    reply = "Error: " + e.message;
  }
  poller.stop();
  live.remove();
  await loadHistory();
  if (mode === "plan") {
    addApprove();
    notifyUser("Plan ready — approve to build", firstLine(reply));
    speakReply(reply);
  } else {
    if (poller.pendingCommit()) addCommitReview();
    notifyUser("Agent replied", firstLine(reply));
    speakReply(reply);
  }
  running = false;
  $("#runbar").classList.add("hidden");
  setStatus("");
  drainQueue();
}

function firstLine(s) {
  const t = (s || "").trim().split("\n")[0];
  return t.length > 140 ? t.slice(0, 140) + "…" : (t || "Done");
}

function notifyUser(title, body) {
  try { call("notify", { title, body }); } catch (e) {}
}

function drainQueue() {
  if (running || !queue.length) return;
  const next = queue.shift();
  renderQueue();
  currentMode = next.mode;
  document.querySelectorAll(".mode").forEach((x) =>
    x.classList.toggle("active", x.dataset.mode === next.mode));
  runTask(next.task, next.mode);
}

// Live progress for an arbitrary agent call (e.g. plan approval, fix build).
async function driveLive(label, promiseFactory) {
  running = true;
  clearTodos();
  $("#runbar").classList.remove("hidden");
  $("#runlabel").textContent = label;
  const live = document.createElement("div");
  live.className = "live"; live.textContent = "Starting…";
  chat.appendChild(live);
  const poller = makeLivePoller(live);
  try { await promiseFactory(); } catch (e) {}
  poller.stop(); live.remove(); await loadHistory();
  if (poller.pendingCommit()) addCommitReview();
  running = false; $("#runbar").classList.add("hidden"); drainQueue();
}

const TOOL_ICONS = {
  read_file: "📖", list_files: "📂", grep: "🔍", write_file: "✏️",
  str_replace: "✂️", delete_file: "🗑", check_python: "🧪", run_tests: "🧪",
  delegate_edit: "🤝", propose_plan: "📋", web_fetch: "🌐", todo_write: "☑️",
  git_status: "🔧", git_branch: "🌿", git_commit: "💾", git_push: "⬆️",
  git_open_pr: "🔀",
};

const TODO_ICON = { completed: "✅", in_progress: "▶️", pending: "⬜" };

// The live task checklist (TodoWrite). Rendered into #todos, which lives
// OUTSIDE #chat so it survives history reloads; cleared at each run start.
function renderTodos(list) {
  const el = $("#todos");
  if (!el) return;
  if (!list || !list.length) { el.classList.add("hidden"); el.innerHTML = ""; return; }
  const done = list.filter((t) => t.status === "completed").length;
  el.classList.remove("hidden");
  el.innerHTML =
    `<div class="todos-head">Tasks ${done}/${list.length}</div>` +
    list.map((t) =>
      `<div class="todo-item ${t.status}">${TODO_ICON[t.status] || "⬜"} ${escapeHtml(t.content)}</div>`
    ).join("");
}
function clearTodos() { renderTodos([]); }

function fmtEvent(e) {
  switch (e.kind) {
    case "step": return "── step " + e.n;
    case "tool_start":
      return (TOOL_ICONS[e.name] || "⚙️") + " " + e.name + (e.detail ? " " + e.detail : "");
    case "tool_done":
      return "   ✓ " + (e.result || e.name);
    case "reason": return "💭 " + (e.text || "").slice(0, 160);
    case "fallback": return "🔀 " + (e.frm || "primary") + " failed → falling back to " + (e.to || "fallback");
    case "verify_failed": return "🧪 verification FAILED (" + (e.which || "check") + ") — repairing:\n" + (e.detail || "");
    case "verify_ok": return "🧪 verification passed";
    case "usage": return "∑ " + (e.input || 0) + " in / " + (e.output || 0) + " out tokens, " + (e.calls || 0) + " calls" +
      (e.cache ? " · " + e.cache + " cached" : "");
    case "pruned": return "🧹 context pruned (−" + (e.chars || 0) + " chars of old tool output)";
    case "todos": return ""; // rendered in the #todos panel, not the log
    case "pending_commit": return "⏸ Changes held for your review (autocommit off)";
    case "error": return "⚠️ " + (e.detail || "error");
    case "plan_start": return "🧠 Orchestrator planning…";
    case "plan_done": return "📋 Plan: " + (e.summary || "") + " (" + (e.files || []).length + " files)";
    case "commit_start": return "💾 Committing…";
    case "done": return "✅ Committed " + (e.commit || "");
    case "interrupt": return "⏹ Interrupting…";
    // legacy kinds (old orchestrator versions)
    case "round_start": return "── Round " + (e.round + 1) + ": " + (e.files || []).join(", ");
    case "impl_start": return "⚙️ implementer → " + e.path;
    case "impl_done": return "   ✓ " + e.path + " [" + e.status + "]";
    default: return e.kind;
  }
}

// Reattach to a run that is still executing natively after the WebView was
// reloaded or the Activity recreated (backgrounding, OTA UI update). The
// original result promise is gone, so we watch events + run.active instead.
async function reattachLive() {
  running = true;
  $("#runbar").classList.remove("hidden");
  $("#runlabel").textContent = "Reattached to running task…";
  bubble("A task is still running — reattached to its progress.", "sys");
  const live = document.createElement("div");
  live.className = "live"; live.textContent = "Reattaching…";
  chat.appendChild(live);
  // Show whatever checklist the in-flight run has already produced.
  try { renderTodos(JSON.parse((await call("orch", { fn: "get_todos" })).text)); } catch (e) {}
  const poller = makeLivePoller(live);
  while (true) {
    try {
      const r = await call("run.active");
      if (!r.active) break;
    } catch (e) {}
    await new Promise((r) => setTimeout(r, 1500));
  }
  poller.stop(); live.remove(); await loadHistory();
  if (poller.pendingCommit()) addCommitReview();
  notifyUser("Task finished", "The reattached run has completed.");
  running = false; $("#runbar").classList.add("hidden"); drainQueue();
}

// Review bar shown after a run when autocommit is off and changes are pending.
function addCommitReview() {
  const bar = document.createElement("div");
  bar.className = "review-bar";
  bar.innerHTML =
    `<button class="pill ghost" id="rvDiff">View diff</button>
     <button class="pill" id="rvCommit">✓ Commit</button>
     <button class="pill stop" id="rvDiscard">Discard</button>`;
  chat.appendChild(bar);
  chat.scrollTop = chat.scrollHeight;
  bar.querySelector("#rvDiff").onclick = () => actions.diff();
  bar.querySelector("#rvCommit").onclick = async () => {
    bar.remove();
    await runText("Commit", "agent.commit");
  };
  bar.querySelector("#rvDiscard").onclick = () => {
    modal("Discard changes",
      `<div class="hint">Throw away ALL uncommitted changes in this project?</div>`,
      async () => {
        bar.remove();
        bubble((await call("orch", { fn: "discard_changes" })).text, "sys");
      });
  };
}

async function openRun(runId) {
  let rec = {};
  try { rec = JSON.parse((await call("orch", { fn: "get_run", arg: String(runId) })).text); } catch (e) {}
  if (rec.touched || rec.usage) {
    // New agent-loop record shape.
    const u = rec.usage || {};
    const files = (rec.touched || []).map((p) => `<div class="run-file">${escapeHtml(p)}</div>`).join("");
    const think = rec.reasoning
      ? `<div class="hint">model thinking (last step):</div><pre class="small">${escapeHtml(rec.reasoning.slice(0, 4000))}</pre>` : "";
    modal("Run details",
      `<div class="hint">task:</div><pre class="small">${escapeHtml((rec.task || "").slice(0, 2000))}</pre>` +
      think +
      `<div class="hint">${(rec.touched || []).length} file(s) touched, ${rec.steps || 0} steps:</div>${files}` +
      (rec.commit ? `<div class="hint">committed ${escapeHtml(rec.commit)}: ${escapeHtml(rec.message || "")}</div>` : "") +
      `<div class="hint">tokens: ${u.input || 0} in / ${u.output || 0} out (${u.calls || 0} calls)</div>`);
    return;
  }
  const rounds = rec.rounds || [];
  if (!rounds.length) { modal("Run details", `<div class="hint">No details recorded.</div>`); return; }
  const html = rounds.map((rd) => {
    const planThink = rd.plan_reasoning
      ? `<div class="hint">orchestrator thinking:</div><pre class="small">${escapeHtml(rd.plan_reasoning.slice(0, 4000))}</pre>` : "";
    const files = (rd.handoffs || []).map((h) =>
      `<div class="run-file">${h.path} [${h.status}]</div>
       <div class="hint">prompt to implementer:</div><pre class="small">${escapeHtml(h.instruction || "")}</pre>` +
      (h.reasoning ? `<div class="hint">implementer thinking:</div><pre class="small">${escapeHtml(h.reasoning.slice(0, 4000))}</pre>` : "") +
      `<div class="hint">implementer output:</div><pre class="small">${escapeHtml((h.output || "").slice(0, 4000))}</pre>`
    ).join("");
    const rev = rd.review ? `<div class="hint">orchestrator review:</div><pre class="small">${escapeHtml((rd.review.notes || rd.review.status || ""))}</pre>` : "";
    return `<div class="run-round"><h4>Round ${(rd.round || 0) + 1} — ${(rd.handoffs || []).length} implementer(s)</h4>${planThink}${files}${rev}</div>`;
  }).join("");
  modal("Run details", html);
}

function updateAutocommitLabel(on) {
  const b = document.querySelector('[data-act="autocommit"]');
  if (b) b.textContent = "Autocommit: " + (on ? "on" : "off");
}

function updateSpeakLabel(on) {
  const b = document.querySelector('[data-act="speak"]');
  if (b) b.textContent = "Speak replies: " + (on ? "on" : "off");
}
function autoSpeakOn() {
  try { return localStorage.getItem("autoSpeak") === "1"; } catch (e) { return false; }
}
// Read an agent reply aloud when auto-speak is on. Strips code blocks so long
// diffs aren't dictated, and caps length.
function speakReply(text) {
  if (!autoSpeakOn() || !text) return;
  const clean = String(text).replace(/```[\s\S]*?```/g, " (code) ").replace(/\s+/g, " ").trim().slice(0, 500);
  if (clean) { try { call("speak", { text: clean }); } catch (e) {} }
}

function updateCavemanLabel(on) {
  const b = document.querySelector('[data-act="caveman"]');
  if (b) b.textContent = "Caveman: " + (on ? "on" : "off");
}
function updateThinkingLabel(on) {
  const b = document.querySelector('[data-act="thinking"]');
  if (b) b.textContent = "Thinking: " + (on ? "on" : "off");
}

function addApprove() {
  const btn = document.createElement("button");
  btn.className = "approve";
  btn.textContent = "✓ Approve & build";
  btn.onclick = () => {
    btn.remove();
    driveLive("Building plan…", () => call("plan.approve"));
  };
  chat.appendChild(btn);
  chat.scrollTop = chat.scrollHeight;
}

// --- Simple action runner (git etc.) ------------------------------------
async function runText(label, action, arg) {
  bubble(label + "…", "sys");
  try {
    const r = await call(action, arg);
    bubble(r.text || "done", "sys");
  } catch (e) {
    bubble(label + " failed: " + e.message, "sys");
  }
}

// --- Menu / modal --------------------------------------------------------
function openSheet(sel) { $(sel).classList.remove("hidden"); }
function closeSheet(sel) { $(sel).classList.add("hidden"); }

function modal(title, bodyHtml, onOk) {
  $("#modalTitle").textContent = title;
  $("#modalBody").innerHTML = bodyHtml;
  const ok = $("#modalOk");
  if (onOk) {
    ok.style.display = "";
    ok.onclick = async () => { const keep = await onOk(); if (keep !== true) closeSheet("#modal"); };
  } else {
    ok.style.display = "none";
  }
  openSheet("#modal");
}

// --- Actions -------------------------------------------------------------
const actions = {
  async files() { filesModal(""); },
  run() { call("run"); },
  commit() { runText("Commit", "agent.commit"); },
  push() { runText("Push", "git.push"); },
  pull() { runText("Pull", "git.pull"); },
  balance() { runText("Balance", "git.balances"); },
  cloudBuild() { runText("Cloud build", "git.cloudBuild"); },
  buildStatus() { runText("Build status", "git.buildStatus"); },
  async diff() {
    const r = await call("orch", { fn: "get_diff" });
    modal("Uncommitted changes", `<pre class="filebody diff">${escapeHtml(r.text || "(none)")}</pre>`);
  },
  revertLast() {
    modal("Revert last commit",
      `<div class="hint">Undo the most recent commit? Files return to the previous commit's state.</div>`,
      async () => { bubble((await call("orch", { fn: "revert_last" })).text, "sys"); });
  },
  startBranch() {
    modal("Start work branch",
      `<label>Branch name (blank = agent/&lt;session&gt;)</label><input id="bn" type="text" placeholder="agent/my-feature" />
       <div class="hint">Work lands on this branch; open a PR to merge it. Safe: your files don't change.</div>`,
      async () => {
        bubble((await call("py.call", { module: "git_ops", fn: "start_branch", args: [$("#bn").value.trim()] })).text, "sys");
      });
  },
  createPR() {
    modal("Open pull request",
      `<label>Title</label><input id="prt" type="text" placeholder="What changed?" />
       <div class="hint">Pushes the current branch, then opens a PR against the repo's default branch.</div>`,
      async () => {
        bubble("Opening PR…", "sys");
        bubble((await call("py.call", { module: "git_ops", fn: "create_pr", args: [$("#prt").value.trim(), ""] })).text, "sys");
      });
  },
  prStatus() { runText("PR status", "py.call", { module: "git_ops", fn: "pr_status", args: [] }); },
  forcePush() {
    modal("Force push",
      `<div class="hint">Overwrite the remote branch with your local history? Remote-only commits are LOST.</div>`,
      async () => { bubble((await call("py.call", { module: "git_ops", fn: "push_force", args: [] })).text, "sys"); });
  },
  fixBuild() {
    driveLive("Fixing CI build…", () => call("orch", { fn: "fix_build" }));
  },
  async battery() {
    try {
      const r = await call("battery.exempt");
      bubble(r.exempt
        ? "Already exempt from battery optimization — background runs won't be killed by Doze."
        : "Requested exemption — allow it in the system dialog so long background runs survive.",
        "sys");
    } catch (e) { bubble("Battery request failed: " + e.message, "sys"); }
  },
  async autocommit() {
    const cur = (await call("orch", { fn: "get_autocommit" })).text.trim();
    const next = cur === "1" ? "0" : "1";
    bubble((await call("orch", { fn: "set_autocommit", arg: next })).text, "sys");
    updateAutocommitLabel(next === "1");
  },
  speak() {
    const next = autoSpeakOn() ? "0" : "1";
    try { localStorage.setItem("autoSpeak", next); } catch (e) {}
    updateSpeakLabel(next === "1");
    bubble("Speak replies " + (next === "1" ? "on" : "off"), "sys");
    if (next === "1") { try { call("speak", { text: "Voice replies on." }); } catch (e) {} }
  },
  async updateApp() {
    bubble("Updating agent + UI…", "sys");
    setStatus("Updating…");
    try {
      const a = await call("updateAgent");
      bubble(a.text || "Agent updated", "sys");
      await call("updateUI"); // fetches new web assets and reloads the WebView
    } catch (e) {
      bubble("Update failed: " + e.message, "sys");
      setStatus("");
    }
  },
  async viewContext() {
    let turns = [];
    try { turns = JSON.parse((await call("orch", { fn: "get_discussion" })).text).turns || []; } catch (e) {}
    const body = turns.length
      ? turns.map((t) =>
          `<div class="list-item"><span><b>${t.role}</b><div class="sub">${escapeHtml(t.text).slice(0, 400)}</div></span></div>`
        ).join("")
      : `<div class="hint">(no context yet)</div>`;
    modal("Discussion (" + turns.length + " turns)", body);
  },
  trimContext() {
    modal("Trim context",
      `<label>Keep the last N turns</label><input id="keepN" type="text" value="10" />
       <div class="hint">Older turns are dropped from this project's discussion.</div>`,
      async () => {
        const n = parseInt($("#keepN").value.trim(), 10) || 10;
        bubble((await call("orch", { fn: "trim_discussion", arg: String(n) })).text, "sys");
        loadHistory();
      });
  },
  clearContext() {
    modal("Clear context",
      `<div class="hint">Erase this project's discussion memory? Files and outline are untouched.</div>`,
      async () => {
        bubble((await call("orch", { fn: "clear_discussion" })).text, "sys");
        loadHistory();
      });
  },
  async buildOutline() {
    bubble("Building outline from the project files…", "sys");
    bubble((await call("orch", { fn: "build_outline" })).text, "sys");
    refreshStats();
  },
  async caveman() {
    const cur = (await call("orch", { fn: "get_caveman" })).text.trim();
    const next = cur === "1" ? "0" : "1";
    const r = await call("orch", { fn: "set_caveman", arg: next });
    bubble(r.text, "sys");
    updateCavemanLabel(next === "1");
    refreshStats();
  },
  async thinking() {
    const cur = (await call("orch", { fn: "get_thinking" })).text.trim();
    const next = cur === "1" ? "0" : "1";
    const r = await call("orch", { fn: "set_thinking", arg: next });
    bubble(r.text, "sys");
    updateThinkingLabel(next === "1");
  },
  async guidelines() {
    const cur = (await call("orch", { fn: "get_guidelines" })).text || "";
    modal("Guidelines (guidelines.md)",
      `<textarea id="gtext" class="field" rows="14" style="min-height:240px">${escapeHtml(cur)}</textarea>
       <div class="hint">Persistent project instructions — included in the model's context every prompt.</div>`,
      async () => {
        await call("orch", { fn: "set_guidelines", arg: $("#gtext").value });
        bubble("Guidelines saved", "sys");
        refreshStats();
      });
  },
  async previewContext() {
    const r = await call("orch", { fn: "preview_context" });
    modal("Context sent to the model", `<pre class="filebody">${escapeHtml(r.text || "(empty)")}</pre>`);
  },
  async compaction() {
    let s = {};
    try { s = JSON.parse((await call("orch", { fn: "get_compaction" })).text); } catch (e) {}
    const num = (id, val) => `<input type="text" inputmode="numeric" id="${id}" value="${val}" style="width:80px" />`;
    modal("Context compaction (no AI, free)",
      `<label>Max turns kept (Talk/Auto)</label>${num("maxTurns", s.maxTurns)}
       <label>Max turns kept (Code/Plan)</label>${num("codeTurns", s.codeTurns)}
       <label>Total char budget for discussion</label>${num("charBudget", s.charBudget)}
       <label>Truncate any single turn longer than (chars)</label>${num("perTurn", s.perTurn)}
       <label>Agent-loop transcript budget (chars)</label>${num("loopBudget", s.loopBudget)}
       <label>Loop steps protected from pruning</label>${num("keepSteps", s.keepSteps)}
       <div class="hint">Trims the discussion sent each prompt using plain rules — turn caps,
       duplicate removal, per-turn truncation, and a char budget. The loop knobs
       cap the agent's own working transcript inside one run: past the budget,
       old tool outputs are elided (the agent can re-read files it still needs).
       Costs zero tokens.</div>`,
      async () => {
        const payload = {
          maxTurns: $("#maxTurns").value, codeTurns: $("#codeTurns").value,
          charBudget: $("#charBudget").value, perTurn: $("#perTurn").value,
          loopBudget: $("#loopBudget").value, keepSteps: $("#keepSteps").value,
        };
        await call("orch", { fn: "set_compaction", arg: JSON.stringify(payload) });
        bubble("Compaction settings saved", "sys");
        refreshStats();
      });
  },
  async contextFiles() {
    let pinned = [];
    try { pinned = JSON.parse((await call("orch", { fn: "list_context_files" })).text); } catch (e) {}
    const body = (pinned.length
      ? pinned.map((p) => `<div class="list-item"><span>${escapeHtml(p)}</span><button class="pinbtn on" data-unpin="${escapeHtml(p)}">Remove</button></div>`).join("")
      : `<div class="hint">No files attached.</div>`) +
      `<div class="hint">These files are sent to the model as context every turn. Add more from the Files screen.</div>`;
    modal("Attached files", body);
    $("#modalBody").querySelectorAll("[data-unpin]").forEach((el) => {
      el.onclick = async () => {
        const r = await call("orch", { fn: "remove_context_file", arg: el.dataset.unpin });
        bubble(r.text, "sys");
        refreshStats();
        actions.contextFiles(); // re-render remaining
      };
    });
  },
  newRepo() {
    modal("New GitHub repo",
      `<label>Repo name</label><input id="rn" type="text" placeholder="repo-name" />`,
      async () => {
        const name = $("#rn").value.trim(); if (!name) return;
        await runText("Create repo", "git.createRepo", { name });
        refreshHeader();
      });
  },
  async switchRepo() {
    bubble("Loading repos…", "sys");
    const r = await call("git.listRepos");
    const repos = r.repos || [];
    if (!repos.length) { bubble("No repos found (check GitHub token).", "sys"); return; }
    modal("Switch repo",
      repos.map((f) => `<div class="list-item" data-repo="${f}"><span>${f}</span></div>`).join(""));
    $("#modalBody").querySelectorAll("[data-repo]").forEach((el) => {
      el.onclick = () => { closeSheet("#modal"); confirmClone(el.dataset.repo); };
    });
  },
  async sessions() {
    const r = await call("session.list");
    const items = (r.sessions || []).map((s) => {
      const dot = s.id === r.activeId ? "● " : "○ ";
      const repo = s.activeRepo ? " (" + s.activeRepo + ")" : "";
      const nm = escapeHtml(s.name);
      return `<div class="list-item sess-row">
        <span class="sess-pick" data-sid="${s.id}">${dot}${nm}${escapeHtml(repo)}</span>
        <span class="sess-actions">
          <b class="sess-btn" data-rename="${s.id}" data-name="${nm}" title="Rename">✎</b>
          <b class="sess-btn" data-del="${s.id}" data-name="${nm}" title="Delete">🗑</b>
        </span></div>`;
    }).join("");
    modal("Sessions", items +
      `<button class="pill ghost" id="newSess" style="margin-top:10px">New session</button>`);
    const reopen = async () => { await refreshHeader(); await loadHistory(); actions.sessions(); };
    $("#modalBody").querySelectorAll("[data-sid]").forEach((el) => {
      el.onclick = async () => {
        await call("session.setActive", { id: el.dataset.sid });
        closeSheet("#modal"); await refreshHeader(); await loadHistory();
      };
    });
    $("#modalBody").querySelectorAll("[data-rename]").forEach((el) => {
      el.onclick = (ev) => {
        ev.stopPropagation();
        modal("Rename session",
          `<label>Name</label><input id="rn2" type="text" value="${el.dataset.name}" />`,
          async () => {
            const name = $("#rn2").value.trim(); if (!name) return;
            await call("session.rename", { id: el.dataset.rename, name });
            reopen();
          });
      };
    });
    $("#modalBody").querySelectorAll("[data-del]").forEach((el) => {
      el.onclick = (ev) => {
        ev.stopPropagation();
        modal("Delete session",
          `<div class="hint">Permanently delete "<b>${el.dataset.name}</b>" — its repo workspace,
           history, and settings? This cannot be undone.</div>`,
          async () => {
            await call("session.delete", { id: el.dataset.del });
            reopen();
          });
      };
    });
    $("#newSess").onclick = () => {
      modal("New session", `<label>Name</label><input id="sn" type="text" placeholder="session name" />`,
        async () => {
          await call("session.create", { name: $("#sn").value.trim() });
          await refreshHeader(); await loadHistory();
        });
    };
  },
  async models() {
    const meta = await call("session.meta");
    modal("Session models",
      `<label>Orchestrator model (planner)</label>
       <input id="mo" type="text" list="ml" value="${meta.orchestrator || ""}" />
       <label>Implementer model (blank = single agent)</label>
       <input id="mi" type="text" list="ml" value="${meta.implementer || ""}" />
       <datalist id="ml"></datalist>
       <div class="hint">Models are aggregated from every provider you have a key for.</div>`,
      async () => {
        await call("session.setModels", { orchestrator: $("#mo").value.trim(), implementer: $("#mi").value.trim() });
        refreshHeader();
      });
    // Populate the shared datalist asynchronously.
    const r = await call("models.aggregate");
    const dl = $("#ml");
    if (dl) dl.innerHTML = (r.models || []).map((m) => `<option value="${m}">`).join("");
  },
  async modelSwitch() {
    const [meta, agg] = await Promise.all([call("session.meta"), call("models.aggregate")]);
    const all = agg.models || [];
    const cur = meta.orchestrator || "";
    const implementer = meta.implementer || "";
    const recent = getRecentModels(); // oldest → newest
    const rank = (m) => recent.indexOf(m);
    // Unused models first (alpha), then used models by recency ascending, so the
    // most-recently-used sits at the very bottom (closest to the thumb).
    const sorted = all.slice().sort((a, b) => {
      const ra = rank(a), rb = rank(b);
      if (ra < 0 && rb < 0) return a.localeCompare(b);
      if (ra < 0) return -1;
      if (rb < 0) return 1;
      return ra - rb;
    });
    const rows = sorted.length
      ? sorted.map((m) =>
          `<div class="list-item" data-model="${escapeHtml(m)}">
             <span>${m === cur ? "● " : ""}${escapeHtml(shortModel(m))}<div class="sub">${escapeHtml(m)}</div></span>
             ${rank(m) >= 0 ? '<span class="sub">recent</span>' : ""}</div>`
        ).join("")
      : `<div class="hint">No models available — add an API key in Settings.</div>`;
    modal("Switch model", rows +
      `<div class="hint">Sorted with your most recently used at the bottom.</div>`);
    $("#modalBody").querySelectorAll("[data-model]").forEach((el) => {
      el.onclick = async () => {
        const m = el.dataset.model;
        await call("session.setModels", { orchestrator: m, implementer });
        pushRecentModel(m);
        closeSheet("#modal");
        await refreshHeader();
        bubble("Model → " + shortModel(m), "sys");
      };
    });
  },
  async settings() {
    const s = await call("settings.get");
    modal("Settings",
      `<label>Anthropic API key</label><input id="ak" type="password" value="${s.anthropicKey||""}" />
       <label>DeepSeek API key</label><input id="dk" type="password" value="${s.deepseekKey||""}" />
       <label>GitHub token (push / create / build)</label><input id="gt" type="password" value="${s.githubToken||""}" />
       <label>Default orchestrator model</label><input id="lm" type="text" value="${s.leadModel||""}" />
       <label>Default implementer model (blank = single agent)</label><input id="wm" type="text" value="${s.workerModel||""}" />
       <label>Fallback model (used if the primary provider fails)</label><input id="fm" type="text" list="ml" value="${s.fallbackModel||""}" placeholder="e.g. deepseek/deepseek-chat" />
       <datalist id="ml"></datalist>
       <label>Agent branch (for OTA updates)</label><input id="br" type="text" value="${s.branch||""}" />`,
      async () => {
        await call("settings.save", {
          anthropicKey: $("#ak").value.trim(), deepseekKey: $("#dk").value.trim(),
          githubToken: $("#gt").value.trim(), leadModel: $("#lm").value.trim(),
          workerModel: $("#wm").value.trim(), fallbackModel: $("#fm").value.trim(),
          branch: $("#br").value.trim(),
        });
        refreshHeader();
      });
    try {
      const agg = await call("models.aggregate");
      const dl = $("#ml");
      if (dl) dl.innerHTML = (agg.models || []).map((m) => `<option value="${m}">`).join("");
    } catch (e) {}
  },
};

function confirmClone(full) {
  modal(full,
    `<div class="hint">Clone into the current session (replaces local files), or just point at it?</div>`,
    null);
  const body = $("#modalBody");
  body.innerHTML += `<div class="row" style="margin-top:12px">
    <button class="pill" id="cloneBtn">Clone</button>
    <button class="pill ghost" id="pointBtn">Point at it</button></div>`;
  $("#cloneBtn").onclick = async () => { closeSheet("#modal"); await runText("Clone", "git.clone", { full }); refreshHeader(); };
  $("#pointBtn").onclick = async () => { closeSheet("#modal"); await runText("Set repo", "git.setActiveRepo", { full }); refreshHeader(); };
}

async function filesModal(path) {
  let all = [];
  try { all = JSON.parse((await call("orch", { fn: "browse_files" })).text); } catch (e) {}
  let pinned = [];
  try { pinned = JSON.parse((await call("orch", { fn: "list_context_files" })).text); } catch (e) {}
  const dirs = new Set(); const files = [];
  all.forEach((p) => {
    if (!p.startsWith(path)) return;
    const rest = p.slice(path.length);
    const i = rest.indexOf("/");
    if (i >= 0) dirs.add(rest.slice(0, i) + "/"); else files.push(rest);
  });
  const entries = [...[...dirs].sort(), ...files.sort()];
  const up = path ? `<div class="filerow dir" data-up="1">.. (up)</div>` : "";
  const body = up + (entries.length
    ? entries.map((e) => {
        if (e.endsWith("/")) {
          return `<div class="filerow dir"><span data-e="${e}">${e}</span></div>`;
        }
        const on = pinned.includes(path + e);
        const btn = `<button class="pinbtn ${on ? "on" : ""}" data-pin="${path + e}">${on ? "Remove from context" : "Add to context"}</button>`;
        return `<div class="filerow"><span data-e="${e}">${on ? "📎 " : ""}${e}</span>${btn}</div>`;
      }).join("")
    : `<div class="hint">(empty)</div>`);
  modal("/" + path, body + `<div class="hint">📎 = sent to the model as context every turn. Tap "Remove from context" to stop sending a file.</div>`);
  $("#modalBody").querySelectorAll("[data-e]").forEach((el) => {
    el.onclick = () => {
      const e = el.dataset.e;
      if (e.endsWith("/")) filesModal(path + e);
      else showFile(path + e);
    };
  });
  $("#modalBody").querySelectorAll("[data-pin]").forEach((el) => {
    el.onclick = async (ev) => {
      ev.stopPropagation();
      const p = el.dataset.pin;
      const on = pinned.includes(p);
      const r = await call("orch", { fn: on ? "remove_context_file" : "add_context_file", arg: p });
      bubble(r.text, "sys");
      refreshStats();
      filesModal(path); // re-render to reflect new state
    };
  });
  const upEl = $("#modalBody").querySelector("[data-up]");
  if (upEl) upEl.onclick = () => {
    const t = path.replace(/\/$/, "");
    filesModal(t.includes("/") ? t.slice(0, t.lastIndexOf("/") + 1) : "");
  };
}

async function showFile(rel) {
  const r = await call("orch", { fn: "read_ws_file", arg: rel });
  modal(rel, `<pre class="filebody">${escapeHtml(r.text || "(empty)")}</pre>`);
}

function escapeHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// --- Recently-used models (local only, no token cost) -------------------
function getRecentModels() {
  try { return JSON.parse(localStorage.getItem("recentModels") || "[]"); } catch (e) { return []; }
}
function pushRecentModel(m) {
  let r = getRecentModels().filter((x) => x !== m);
  r.push(m);
  r = r.slice(-12);
  try { localStorage.setItem("recentModels", JSON.stringify(r)); } catch (e) {}
}

// --- Ephemeral question (not saved to context) --------------------------
async function askEphemeral(q) {
  const wrap = document.createElement("div");
  wrap.className = "eph-tag";
  wrap.textContent = "— side question (not saved) —";
  chat.appendChild(wrap);
  const u = bubble(q, "user", null, false); u.classList.add("eph");
  setStatus("Thinking…");
  try {
    const r = await call("orch", { fn: "ask", arg: q });
    const a = bubble(r.text || "(no answer)", "agent", null, false); a.classList.add("eph");
    notifyUser("Answer ready", firstLine(r.text || ""));
    speakReply(r.text || "");
  } catch (e) {
    bubble("Ask failed: " + e.message, "sys");
  }
  setStatus("");
}

// --- Wire up -------------------------------------------------------------
$("#menuBtn").onclick = () => openSheet("#menu");
document.querySelectorAll("[data-act]").forEach((b) => {
  b.onclick = () => { closeSheet("#menu"); (actions[b.dataset.act] || (() => {}))(); };
});
document.querySelectorAll("[data-close]").forEach((b) => {
  b.onclick = (e) => e.target.closest(".sheet").classList.add("hidden");
});
$("#sendBtn").onclick = () => {
  const t = $("#input").value.trim();
  if (t) { $("#input").value = ""; submit(t); }
};
$("#askBtn").onclick = () => {
  const t = $("#input").value.trim();
  if (!t) { setStatus("Type a question first"); return; }
  $("#input").value = ""; $("#input").style.height = "auto";
  askEphemeral(t);
};
$("#input").addEventListener("input", (e) => {
  e.target.style.height = "auto";
  e.target.style.height = Math.min(e.target.scrollHeight, 120) + "px";
});
$("#micBtn").onclick = () => { _dictBase = $("#input").value.trim(); setStatus("Listening…"); call("listen"); };
$("#stopBtn").onclick = () => { $("#runlabel").textContent = "Stopping…"; call("orch", { fn: "interrupt" }); };
document.querySelectorAll(".mode").forEach((b) => {
  b.onclick = () => {
    document.querySelectorAll(".mode").forEach((x) => x.classList.remove("active"));
    b.classList.add("active");
    currentMode = b.dataset.mode;
  };
});

// Boot
(async function () {
  try { await refreshHeader(); await loadHistory(); } catch (e) {}
  // If a run outlived the previous UI (backgrounded, rotated on an old build,
  // OTA reload), pick its progress back up instead of looking dead.
  try { if ((await call("run.active")).active) reattachLive(); } catch (e) {}
  try { updateCavemanLabel((await call("orch", { fn: "get_caveman" })).text.trim() === "1"); } catch (e) {}
  try { updateThinkingLabel((await call("orch", { fn: "get_thinking" })).text.trim() === "1"); } catch (e) {}
  try { updateAutocommitLabel((await call("orch", { fn: "get_autocommit" })).text.trim() === "1"); } catch (e) {}
  updateSpeakLabel(autoSpeakOn());
  bubble("Ready. Type or tap 🎤 to dictate a task.", "sys");
})();
