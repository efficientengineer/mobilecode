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
let _dictating = false;
function stopDictation() {
  if (!_dictating) return;
  _dictating = false;
  const b = $("#micBtn"); if (b) b.textContent = "Speak";
  setStatus("");
  try { call("listen", { on: false }); } catch (e) {}
}
window.nativeEvent = (type, payload) => {
  const box = $("#input");
  if (type === "speech-partial") {
    composeOpen(false);   // dictation streams into the shared floating box
    box.value = _dictBase + (_dictBase ? " " : "") + (payload || "");
    box.dispatchEvent(new Event("input"));
  } else if (type === "speech-final") {
    // Commit the utterance into the box; do NOT submit — Send sends it.
    if (payload && payload.trim()) {
      composeOpen(false);
      box.value = _dictBase + (_dictBase ? " " : "") + payload.trim();
      _dictBase = box.value;
      box.dispatchEvent(new Event("input"));
    }
    if (!_dictating) setStatus("");
  } else if (type === "dictation" && payload === "off") {
    // The recognizer stopped on its own (e.g. an error) — reset the toggle.
    _dictating = false;
    const b = $("#micBtn"); if (b) b.textContent = "Speak";
    setStatus("");
  } else if (type === "shared-text") {
    receiveShared(payload);
  } else if (type === "status") {
    setStatus(payload);
  }
};

// Text/URL shared into the app from another app — drop it into the composer.
function receiveShared(txt) {
  if (!txt) return;
  composeOpen(false);
  const box = $("#input");
  box.value = (box.value ? box.value + "\n" : "") + txt;
  box.dispatchEvent(new Event("input"));
  box.focus();
  setStatus("Shared text added — edit and Send");
}

let currentMode = "auto";
let _loadingHistory = false;
let _editorSelection = { rel: null, text: "" };

// --- Agent chat drawer (slides in from the right; toggled by the 💬 button) --
function chatIsOpen() { const d = $("#chatDrawer"); return !!(d && d.classList.contains("open")); }
function setChatUnread(on) { const u = $("#chatUnread"); if (u) u.classList.toggle("hidden", !on); }
function setChatFabIcon(open) {
  const icon = $("#chatFabIcon"); if (icon) icon.textContent = open ? "✕" : "💬";
  const fab = $("#chatFab");
  if (fab) { fab.classList.toggle("chat-open", open); fab.title = open ? "Close chat" : "Agent chat"; }
}
function openChat() {
  const d = $("#chatDrawer"); if (!d) return;
  d.classList.add("open");
  const b = $("#chatBackdrop"); if (b) b.classList.remove("hidden");
  setChatUnread(false);
  setChatFabIcon(true);
  const c = $("#chat"); if (c) setTimeout(() => { c.scrollTop = c.scrollHeight; }, 60);
}
function closeChat() {
  const d = $("#chatDrawer"); if (d) d.classList.remove("open");
  const b = $("#chatBackdrop"); if (b) b.classList.add("hidden");
  setChatFabIcon(false);
}
function toggleChat() { chatIsOpen() ? closeChat() : openChat(); }

// --- DOM helpers ---------------------------------------------------------
const $ = (s) => document.querySelector(s);
const chat = $("#chat");
function setStatus(t) { $("#status").textContent = t || ""; }

function estTokens(s) {
  return Math.max(1, Math.round((s || "").length / 4));
}

// Copy text to the clipboard, with a WebView-safe fallback (navigator.clipboard
// isn't always available/permitted in the Android WebView). Flashes the button.
async function copyToClipboard(text, btn) {
  let ok = false;
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      ok = true;
    }
  } catch (e) {}
  if (!ok) {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed"; ta.style.opacity = "0";
      document.body.appendChild(ta); ta.focus(); ta.select();
      ok = document.execCommand("copy");
      document.body.removeChild(ta);
    } catch (e) {}
  }
  if (btn) {
    const prev = btn.textContent;
    btn.textContent = ok ? "✓" : "✕";
    btn.classList.add("copied");
    setTimeout(() => { btn.textContent = prev; btn.classList.remove("copied"); }, 1200);
  }
}

function addCopyButton(bubbleEl, text) {
  const cp = document.createElement("button");
  cp.className = "copybtn";
  cp.title = "Copy message";
  cp.textContent = "⧉";
  cp.onclick = (ev) => { ev.stopPropagation(); copyToClipboard(text, cp); };
  bubbleEl.appendChild(cp);
}

function bubble(text, kind, runId, ctxText) {
  const d = document.createElement("div");
  d.className = "bubble " + kind;
  // Agent replies render markdown (code blocks, bold, lists); user/sys stay
  // plain text — safest, and there's nothing to format.
  if (kind === "agent") d.innerHTML = renderMarkdown(text);
  else d.textContent = text;
  if (runId) {
    d.classList.add("tappable");
    d.onclick = () => openRun(runId);
  }
  // Copy-to-clipboard button (copies the raw text, not the rendered markdown).
  if (kind === "user" || kind === "agent") addCopyButton(d, text);
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
  // New agent reply while the drawer is closed → flag it on the 💬 button.
  if (kind === "agent" && !_loadingHistory && !chatIsOpen()) setChatUnread(true);
  return d;
}

function shortModel(m) {
  if (!m) return "default";
  const s = String(m);
  return s.includes("/") ? s.slice(s.indexOf("/") + 1) : s;
}

async function refreshHeader() {
  // Fetch session meta + git branch independently (one failure shouldn't block the other).
  let m = { name: "session", activeRepo: "", orchestrator: "", implementer: "" };
  let branch = "?";
  try { m = await call("session.meta"); } catch (e) {}
  try { const br = await call("git.currentBranch"); branch = br.text || "?"; } catch (e) {}
  // If the session doesn't know its repo yet, try the workspace's git remote origin.
  if (!m.activeRepo) {
    try {
      const r = await call("py.call", { module: "git_ops", fn: "workspace_repo", args: [] });
      if (r.text && r.text.trim() && r.text !== "(no repo)") m.activeRepo = r.text.trim();
    } catch (e) {}
  }
  // Always-visible subtitle bar: session · repo · branch
  const ss = $("#subSession");
  if (ss) ss.textContent = m.name || "session";
  const sr = $("#subRepo");
  if (sr) sr.textContent = m.activeRepo || "no repo";
  const sb = $("#subBranch");
  if (sb) sb.textContent = branch;
  // GitHub fab shows repo short-name + branch.
  const fab = $("#githubFab");
  if (fab) {
    const shortRepo = m.activeRepo ? m.activeRepo.split("/").pop() : "";
    fab.textContent = "GitHub ▾" + (shortRepo ? " · " + shortRepo : "") + " · " + branch;
  }
  // Model picker labels in the chat drawer.
  const mn = $("#modelName");
  if (mn) mn.textContent = shortModel(m.orchestrator);
  const inm = $("#implName");
  if (inm) inm.textContent = m.implementer ? shortModel(m.implementer) : "single";
  // Effort dropdowns — one per role.
  try { updateEffortSelect("orchEffortSelect", (await call("orch", { fn: "get_orch_effort" })).text.trim()); } catch (e) {}
  try { updateEffortSelect("implEffortSelect", (await call("orch", { fn: "get_impl_effort" })).text.trim()); } catch (e) {}
}

async function loadHistory() {
  chat.innerHTML = "";
  _loadingHistory = true;
  let turns = [];
  try {
    const r = JSON.parse((await call("orch", { fn: "get_discussion" })).text);
    turns = r.turns || [];
    turns.forEach((t) =>
      // display-only turns (mid-run narration) are agent bubbles that cost no
      // context, so suppress their per-message token estimate (ctxText=false).
      bubble(t.text, t.role === "user" ? "user" : "agent", t.run_id || null,
        t.display_only ? false : t.ctx));
  } catch (e) {}
  _loadingHistory = false;
  refreshStats();
  refreshOpenTabs();   // pick up any files the agent just edited
}

// --- Context + balance stats -------------------------------------------
let _balStart = null;

function fmtK(n) {
  n = n || 0;
  return n >= 1000 ? (n / 1000).toFixed(n >= 10000 ? 0 : 1) + "k" : String(n);
}

// Show the last run's token usage with the CACHE HIT % up front — a high %
// means the prompt cache is doing its job (repeated context billed cheaply).
let _lastUsage = null;
async function refreshUsage() {
  const el = $("#usage");
  if (!el) return;
  try {
    const u = JSON.parse((await call("orch", { fn: "get_usage" })).text);
    _lastUsage = u;
    const inp = u.input || 0, cr = u.cache_read || 0, out = u.output || 0;
    if (!inp && !out) { el.classList.add("hidden"); return; }
    const pct = inp ? Math.round((100 * cr) / inp) : 0;
    el.classList.remove("hidden");
    el.textContent = `⚡${pct}% cached · ${fmtK(inp)}↓ ${fmtK(out)}↑`;
    el.title = `${inp} input tokens (${cr} cached, ${inp - cr} new) · ${out} output · ${u.calls || 0} model calls`;
  } catch (e) {}
}
function showUsageDetail() {
  const u = _lastUsage;
  if (!u) return;
  const inp = u.input || 0, cr = u.cache_read || 0, out = u.output || 0;
  const pct = inp ? Math.round((100 * cr) / inp) : 0;
  // Per-model breakdown (orchestrator vs implementer vs any others).
  const bm = u.byModel || {};
  const models = Object.keys(bm).sort((a, b) =>
    (bm[b].input + bm[b].output) - (bm[a].input + bm[a].output));
  let perModel = "";
  if (models.length) {
    perModel = `<div class="group-title">By model</div>` + models.map((m) => {
      const v = bm[m], mcr = v.cache_read || 0, mi = v.input || 0;
      const mp = mi ? Math.round((100 * mcr) / mi) : 0;
      return `<div class="list-item"><span>${escapeHtml(m)}</span>
        <b>${fmtK(mi)}↓ ${fmtK(v.output || 0)}↑ · ${v.calls || 0} calls · ${mp}% cached</b></div>`;
    }).join("");
  }
  modal("Tokens this run",
    `<div class="list-item"><span>Input total</span><b>${inp}</b></div>
     <div class="list-item"><span>&nbsp;&nbsp;· cached (cheap)</span><b>${cr} · ${pct}%</b></div>
     <div class="list-item"><span>&nbsp;&nbsp;· new (full price)</span><b>${inp - cr}</b></div>
     <div class="list-item"><span>Output</span><b>${out}</b></div>
     <div class="list-item"><span>Model calls</span><b>${u.calls || 0}</b></div>
     ${perModel}
     <div class="hint">A high <b>cached %</b> means repeated context is being billed at a fraction of the price — the prompt cache is working. The by-model split shows orchestrator vs implementer spend. Actual dollars show in the balance chip.</div>`);
}
function refreshStats() {
  // The old #stats readout was removed with the top bar; the two orch bridge
  // calls that fed it (context_counts + list_context_files) were pure waste on
  // every action. Balance/usage/attach-bar are the live indicators now.
  refreshBalance();
  refreshUsage();
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

// --- Run state machine (live progress + interrupt) ----------------------
let running = false;

let _routingOn = false;   // synced from get_routing on load / toggle

function submit(task) {
  if (running) { steerRun(task); return; }
  if (_routingOn) { routePrompt(task); return; }
  runTask(task, currentMode);
}

// Triage the prompt, then present routing options as buttons (single agent /
// multiple agents / plan / just answer) — the user picks how to run it.
async function routePrompt(task) {
  bubble(task, "user");                       // show the message right away
  modal("Route this request", `<div class="hint">Analyzing your request…</div>`);
  let r;
  try { r = JSON.parse((await call("orch", { fn: "triage_prompt", arg: task })).text); }
  catch (e) { r = { recommend: "single", confidence: "low", reason: "", subtasks: [] }; }
  const subs = r.subtasks || [];
  const rec = r.recommend || "single";
  // Auto-skip the window when the route is obvious (a confident single edit or a
  // plain question) — only ask when there's a real fork (multi/plan, or unsure).
  if (r.confidence === "high" && (rec === "single" || rec === "chat")) {
    closeSheet("#modal");
    runTask(task, rec === "chat" ? "chat" : "code", true);
    return;
  }
  const subsHtml = subs.length
    ? `<div class="hint" style="margin-top:8px">Proposed split (${subs.length}):</div>` +
      subs.map((s) => `<div class="list-item"><span>${escapeHtml(s.title || s.instruction)}</span></div>`).join("")
    : "";
  const b = (id, label, hot) =>
    `<button class="pill ${hot ? "" : "ghost"}" id="${id}" style="margin:4px 6px 0 0">${label}</button>`;
  const rlabel = (m, base) => (rec === m ? "★ " : "") + base;
  modal("Route this request",
    (r.reason ? `<div class="hint">${escapeHtml(r.reason)}</div>` : "") + subsHtml +
    `<div class="row" style="margin-top:12px;flex-wrap:wrap">
       ${b("rSingle", rlabel("single", "🧠 Single agent"), rec === "single")}
       ${b("rMulti", rlabel("multi", "🧩 Multiple agents" + (subs.length ? ` (${subs.length})` : "")), rec === "multi")}
       ${b("rPlan", rlabel("plan", "📋 Plan first"), rec === "plan")}
       ${b("rChat", rlabel("chat", "💬 Just answer"), rec === "chat")}
     </div>`);
  const pick = (fn) => { closeSheet("#modal"); fn(); };
  $("#rSingle").onclick = () => pick(() => runTask(task, "code", true));
  $("#rMulti").onclick = () => pick(() => runTask(task, "multi", true));
  $("#rPlan").onclick = () => pick(() => runTask(task, "plan", true));
  $("#rChat").onclick = () => pick(() => runTask(task, "chat", true));
}

// While a run is in flight, a new message steers it — the agent folds it into
// the live loop before its next model call — rather than queuing a fresh task.
async function steerRun(task) {
  bubble(task, "user");
  const tag = document.createElement("div");
  tag.className = "eph-tag";
  tag.textContent = "↪ steering the running task";
  chat.appendChild(tag);
  chat.scrollTop = chat.scrollHeight;
  try { await call("orch", { fn: "steer", arg: task }); } catch (e) {}
}

// Scroll the chat to the bottom only if the user is already near it — so live
// updates don't yank the view down while they're reading earlier messages.
function maybeScroll() {
  if (chat.scrollHeight - chat.scrollTop - chat.clientHeight < 140) {
    chat.scrollTop = chat.scrollHeight;
  }
}

// Poll run events into a COLLAPSIBLE live element: a one-line "step N · latest
// activity" header (always visible) plus a full log revealed on tap, so the
// progress feed never buries the conversation. Returns { stop, pendingCommit }.
function makeLivePoller(live) {
  live.classList.add("live");
  live.innerHTML =
    '<div class="live-head"><span class="live-now">Starting…</span><span class="live-chev">▸</span></div>' +
    '<div class="live-log"></div>';
  const nowEl = live.querySelector(".live-now");
  const logEl = live.querySelector(".live-log");
  const chevEl = live.querySelector(".live-chev");
  live.querySelector(".live-head").onclick = () => {
    const open = live.classList.toggle("open");
    chevEl.textContent = open ? "▾" : "▸";
    if (open) logEl.scrollTop = logEl.scrollHeight;
  };

  const lines = [];
  let stream = "", stepN = 0, lastAct = "";
  let cursor = 0, polling = true, pending = false, streamDirty = false;

  // The agent's PROSE renders as real chat bubbles (like the user's messages),
  // inserted ABOVE the steps feed — not merged into the tool log. `msgEl` is the
  // bubble currently being streamed; it's finalized (left in the chat) at each
  // message boundary (a `say` event or the next step), and a fresh one starts.
  let msgEl = null;
  function ensureMsg() {
    if (!msgEl) {
      msgEl = document.createElement("div");
      msgEl.className = "bubble agent streaming";
      chat.insertBefore(msgEl, live);
    }
    return msgEl;
  }
  function finalizeMsg(fullText) {
    if (msgEl) {
      if (fullText != null && fullText.trim()) msgEl.innerHTML = renderMarkdown(fullText);
      if (!msgEl.textContent.trim()) msgEl.remove();   // drop an empty stub
      else msgEl.classList.remove("streaming");
    }
    msgEl = null;
    stream = "";
  }

  function render() {
    const now = [stepN ? "step " + stepN : "", lastAct].filter(Boolean)
      .join(" · ") || "working…";
    nowEl.textContent = now.replace(/\s+/g, " ").trim().slice(0, 90);
    // Capture whether the log is pinned to the bottom BEFORE we change its
    // content. Only re-pin if it was — otherwise keep the user's scroll
    // position exactly (never yank while they read back through the steps).
    const logPinned = logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < 40;
    logEl.textContent = lines.join("\n");
    if (live.classList.contains("open") && logPinned) logEl.scrollTop = logEl.scrollHeight;
    maybeScroll();
  }
  (async function poll() {
    while (polling) {
      try {
        const r = JSON.parse((await call("orch", { fn: "get_events", arg: String(cursor) })).text);
        cursor = r.cursor;
        (r.events || []).forEach((e) => {
          // Assistant text: accumulate; render once per batch (below), not per
          // delta — re-parsing the whole growing buffer per token is O(n²).
          if (e.kind === "delta") { stream += e.text || ""; streamDirty = true; return; }
          // Message boundary: lock in the finished message as its own bubble.
          if (e.kind === "say") { finalizeMsg(e.text || stream); return; }
          if (e.kind === "todos") { renderTodos(e.todos || []); return; }
          if (e.kind === "pending_commit") pending = true;
          if (e.kind === "step") { if (msgEl) finalizeMsg(stream); stepN = e.n; }
          const f = fmtEvent(e);
          if (f) { lines.push(f); if (e.kind !== "step") lastAct = f; }
        });
        if (streamDirty) { ensureMsg().innerHTML = renderMarkdown(stream); maybeScroll(); streamDirty = false; }
        render();
      } catch (e) {}
      await new Promise((r) => setTimeout(r, 500));
    }
  })();
  // On stop, drop any half-streamed bubble — loadHistory() re-renders the run's
  // messages (now persisted as turns) authoritatively right after.
  return { stop() { polling = false; if (msgEl) { msgEl.remove(); msgEl = null; } },
           pendingCommit: () => pending };
}

async function runTask(task, mode, alreadyShown) {
  running = true;
  if (!alreadyShown) bubble(task, "user");
  clearTodos();
  $("#runbar").classList.remove("hidden");
  $("#runlabel").textContent = mode === "plan" ? "Planning…" : "Working…";
  // Clear the previous run's event feed BEFORE polling, so the poller can't
  // replay the last agent message as a stale duplicate until this run streams.
  try { await call("orch", { fn: "clear_run_events" }); } catch (e) {}
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
  // After an edit run, load the preview headlessly and surface any real JS
  // runtime errors (fire-and-forget).
  if (mode !== "plan") maybeWebCheck();
}

// Load the running preview in a hidden WebView and report runtime JS errors.
async function maybeWebCheck() {
  if (running) return;   // a queued task started; skip to avoid clashing
  let r;
  try { r = await call("web.runtimeCheck"); } catch (e) { return; }
  if (!r || r.skipped) return;
  const errs = r.errors || [];
  if (!errs.length) return;
  bubble("⚠️ The preview threw runtime errors:\n" +
    errs.slice(0, 12).map((e) => "• " + e).join("\n"), "sys");
  addFixRuntime(errs);
}

function addFixRuntime(errs) {
  const btn = document.createElement("button");
  btn.className = "approve";
  btn.textContent = "🩹 Fix runtime errors";
  btn.onclick = () => {
    btn.remove();
    runTask("The running preview throws these JavaScript runtime errors — find "
      + "the cause and fix them:\n" +
      errs.slice(0, 15).map((e) => "- " + e).join("\n"), "code");
  };
  chat.appendChild(btn);
  chat.scrollTop = chat.scrollHeight;
}

function firstLine(s) {
  const t = (s || "").trim().split("\n")[0];
  return t.length > 140 ? t.slice(0, 140) + "…" : (t || "Done");
}

function notifyUser(title, body) {
  try { call("notify", { title, body }); } catch (e) {}
}

// Live progress for an arbitrary agent call (e.g. plan approval, fix build).
async function driveLive(label, promiseFactory) {
  running = true;
  clearTodos();
  $("#runbar").classList.remove("hidden");
  $("#runlabel").textContent = label;
  try { await call("orch", { fn: "clear_run_events" }); } catch (e) {}
  const live = document.createElement("div");
  live.className = "live"; live.textContent = "Starting…";
  chat.appendChild(live);
  const poller = makeLivePoller(live);
  try { await promiseFactory(); } catch (e) {}
  poller.stop(); live.remove(); await loadHistory();
  if (poller.pendingCommit()) addCommitReview();
  running = false; $("#runbar").classList.add("hidden");
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
  if (!list || !list.length) { el.classList.add("hidden"); el.classList.remove("open"); return; }
  el.classList.remove("hidden");
  const done = list.filter((t) => t.status === "completed").length;
  const cur = list.find((t) => t.status === "in_progress") || list.find((t) => t.status === "pending");
  $("#todos-now").textContent = cur ? (TODO_ICON[cur.status] || "") + " " + cur.content : "✅ all tasks done";
  $("#todos-count").textContent = done + "/" + list.length;
  $("#todos-body").innerHTML = list.map((t) =>
    `<div class="todo-item ${t.status}">${TODO_ICON[t.status] || "⬜"} ${escapeHtml(t.content)}</div>`).join("");
}
function clearTodos() {
  const el = $("#todos");
  if (el) { el.classList.add("hidden"); el.classList.remove("open"); }
}

function fmtEvent(e) {
  switch (e.kind) {
    case "step": return "── step " + e.n;
    case "tool_start":
      return (TOOL_ICONS[e.name] || "⚙️") + " " + e.name + (e.detail ? " " + e.detail : "");
    case "tool_done":
      return "   ✓ " + (e.result || e.name);
    case "reason": return "💭 " + (e.text || "").slice(0, 160);
    case "fallback": return "🔀 " + (e.frm || "primary") + " failed → falling back to " + (e.to || "fallback");
    case "steer": return "↪ steering: " + (e.text || "");
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
  running = false; $("#runbar").classList.add("hidden");
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
      `<div class="hint">tokens: ${u.input || 0} in (${u.input ? Math.round((100 * (u.cache_read || 0)) / u.input) : 0}% cached) / ${u.output || 0} out · ${u.calls || 0} calls</div>`);
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

function updateAutodiagnoseLabel(on) {
  const b = document.querySelector('[data-act="autoDiagnose"]');
  if (b) b.textContent = "Auto-diagnose: " + (on ? "on" : "off");
}

function updateAutocleanLabel(on) {
  const b = document.querySelector('[data-act="autoClean"]');
  if (b) b.textContent = "Auto-clean after merge: " + (on ? "on" : "off");
}

function updateReviewLabel(on) {
  const b = document.querySelector('[data-act="codeReview"]');
  if (b) b.textContent = "Code review: " + (on ? "on" : "off");
}

function updateRoutingLabel(on) {
  const b = document.querySelector('[data-act="routing"]');
  if (b) b.textContent = "Prompt routing: " + (on ? "on" : "off");
}

function updateSpeakLabel(on) {
  const b = document.querySelector('[data-act="speak"]');
  if (b) b.textContent = "Speak replies: " + (on ? "on" : "off");
}
function updateFrugalLabel(on) {
  const b = document.querySelector('[data-act="frugal"]');
  if (b) b.textContent = "Frugal: " + (on ? "on" : "off");
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
function updateEffortLabel(level) {
  const b = document.querySelector('[data-act="effort"]');
  if (b) b.textContent = "Effort: " + (level || "off");
}
function updateEffortSelect(selId, level) {
  const s = $("#" + selId);
  if (s) s.value = level || "off";
}
async function onOrchEffortChange() {
  const s = $("#orchEffortSelect");
  if (!s) return;
  const r = await call("orch", { fn: "set_orch_effort", arg: s.value });
  bubble(r.text, "sys");
  refreshStats();
}
async function onImplEffortChange() {
  const s = $("#implEffortSelect");
  if (!s) return;
  const r = await call("orch", { fn: "set_impl_effort", arg: s.value });
  bubble(r.text, "sys");
  refreshStats();
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
    let running = false;
    ok.onclick = async () => {
      if (running) return; // ignore double-taps while the handler is in flight
      running = true;
      ok.disabled = true;
      try {
        const keep = await onOk();
        if (keep !== true) closeSheet("#modal");
      } finally {
        running = false;
        ok.disabled = false;
      }
    };
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
    switchBranch() {
      modal("Switch / create branch",
        `<div class="hint">Enter a branch name:</div>
         <input id="branchNameInput" type="text" placeholder="e.g. feature/my-feature" style="width:100%;box-sizing:border-box;font-size:16px;padding:12px" />`,
        async () => {
          const name = document.getElementById("branchNameInput")?.value?.trim();
          if (!name) return;
          try {
            const r = await call("py.call", { module: "git_ops", fn: "start_branch", args: [name] });
            bubble(r.text || "Switched to branch " + name, "sys");
            await refreshHeader();
          } catch (e) {
            bubble("Error: " + (e.message || "failed to switch branch"), "sys");
          }
        });
    },
  balance() { runText("Balance", "git.balances"); },
  cloudBuild() { runText("Cloud build", "git.cloudBuild"); },
  buildStatus() { runText("Build status", "git.buildStatus"); },
  async diff() {
    const r = await call("orch", { fn: "get_diff" });
    modal("Uncommitted changes", `<pre class="filebody diff">${escapeHtml(r.text || "(none)")}</pre>`);
  },
  async diagnoseRun() {
    bubble("Diagnosing the last run…", "sys");
    const r = await call("orch", { fn: "diagnose_last_run" });
    modal("Run diagnosis", `<pre class="filebody">${escapeHtml(r.text || "(none)")}</pre>`);
  },
  async judgeRun() {
    bubble("Grading the last run…", "sys");
    const r = await call("orch", { fn: "judge_last_run" });
    modal("LLM judge", `<pre class="filebody">${escapeHtml(r.text || "(none)")}</pre>`);
  },
  async runEvals() {
    bubble("Running eval scenarios (this runs the agent a few times — hang on)…", "sys");
    const r = await call("orch", { fn: "run_evals" });
    modal("Eval scenarios", `<pre class="filebody">${escapeHtml(r.text || "(none)")}</pre>`);
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
  mergePR() {
    modal("Merge pull request",
      `<div class="hint">Merges the open PR for the current branch into its base branch. This can't be easily undone — GitHub will block it if CI is failing, a review is required, or there's a conflict.</div>
       <label>Method</label>
       <select id="mm">
         <option value="merge">Merge commit</option>
         <option value="squash">Squash and merge</option>
         <option value="rebase">Rebase and merge</option>
       </select>`,
      async () => {
        const m = ($("#mm") && $("#mm").value) || "merge";
        bubble("Merging PR…", "sys");
        const res = (await call("py.call", { module: "git_ops", fn: "merge_pr", args: [m] })).text;
        bubble(res, "sys");
        // Origin is the source of truth: once merged, drop the local feature
        // files (auto-clean, if enabled) so local never drifts from origin.
        if (/merged/i.test(res)) {
          try {
            const clean = (await call("orch", { fn: "cleanup_if_merged" })).text;
            if (clean && clean.trim()) bubble(clean, "sys");
          } catch (e) {}
        }
        refreshHeader();
      });
  },
  async cleanupMerged() {
    bubble("Checking if this feature is merged…", "sys");
    bubble((await call("orch", { fn: "cleanup_merged" })).text, "sys");
    refreshHeader();
  },
  async autoClean() {
    const cur = (await call("orch", { fn: "get_autoclean" })).text.trim();
    const next = cur === "1" ? "0" : "1";
    bubble((await call("orch", { fn: "set_autoclean", arg: next })).text, "sys");
    updateAutocleanLabel(next === "1");
  },
  async codeReview() {
    const cur = (await call("orch", { fn: "get_review" })).text.trim();
    const next = cur === "1" ? "0" : "1";
    bubble((await call("orch", { fn: "set_review", arg: next })).text, "sys");
    updateReviewLabel(next === "1");
  },
  async routing() {
    const next = _routingOn ? "0" : "1";
    bubble((await call("orch", { fn: "set_routing", arg: next })).text, "sys");
    _routingOn = next === "1";
    updateRoutingLabel(_routingOn);
  },
  forcePush() {
    modal("Force push",
      `<div class="hint">Overwrite the remote branch with your local history? Remote-only commits are LOST.</div>`,
      async () => { bubble((await call("py.call", { module: "git_ops", fn: "push_force", args: [] })).text, "sys"); });
  },
  fixBuild() {
    driveLive("Fixing CI build…", () => call("orch", { fn: "fix_build" }));
  },
  async watchPr() {
    let st = {};
    try { st = await call("pr.watchState"); } catch (e) {}
    if (st.watching) {
      modal("Watching PR",
        `<div class="hint">This branch's PR is being watched${st.autofix ? " with <b>auto-fix</b>" : " (notify only)"}.
         You'll get a notification when CI passes, fails, or the PR merges${st.autofix ? ", and the agent will fix &amp; push on a CI failure" : ""}.</div>
         <div class="row" style="margin-top:12px"><button class="pill stop" id="unwatchBtn">Stop watching</button></div>`);
      $("#unwatchBtn").onclick = async () => { closeSheet("#modal"); await runText("Unwatch", "pr.unwatch"); };
      return;
    }
    modal("Watch this PR",
      `<div class="hint">Poll the current branch's PR about every 15 min and notify you when CI
       passes, fails, or it merges. <b>Auto-fix</b> additionally runs the agent on a CI failure and
       pushes the fix to this branch (runs in the background; won't touch other branches).</div>
       <div class="row" style="margin-top:12px">
         <button class="pill ghost" id="notifyOnly">Notify only</button>
         <button class="pill" id="autofixBtn">Auto-fix CI</button></div>`);
    $("#notifyOnly").onclick = async () => { closeSheet("#modal"); await runText("Watch PR", "pr.watch", { autofix: false }); };
    $("#autofixBtn").onclick = async () => { closeSheet("#modal"); await runText("Watch PR (auto-fix)", "pr.watch", { autofix: true }); };
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
  async autoDiagnose() {
    const cur = (await call("orch", { fn: "get_autodiagnose" })).text.trim();
    const next = cur === "1" ? "0" : "1";
    bubble((await call("orch", { fn: "set_autodiagnose", arg: next })).text, "sys");
    updateAutodiagnoseLabel(next === "1");
  },
  async runHistory() {
    const r = await call("orch", { fn: "diagnosis_history" });
    modal("Run history", `<pre class="filebody">${escapeHtml(r.text || "(none)")}</pre>`);
  },
  speak() {
    const next = autoSpeakOn() ? "0" : "1";
    try { localStorage.setItem("autoSpeak", next); } catch (e) {}
    updateSpeakLabel(next === "1");
    bubble("Speak replies " + (next === "1" ? "on" : "off"), "sys");
    if (next === "1") { try { call("speak", { text: "Voice replies on." }); } catch (e) {} }
  },
  async updateApp() {
    bubble("Updating everything (manifest-driven OTA)…", "sys");
    setStatus("Updating…");
    try {
      // One verb updates every runtime file (python + web + extras) per the
      // repo's ota_manifest.json; the host reloads the WebView afterwards.
      const r = await call("updateAll");
      const t = (r && r.text) || "";
      if (/^unknown action/.test(t)) {
        // Older APK without updateAll — fall back to the two legacy verbs.
        const a = await call("updateAgent");
        bubble(a.text || "Agent updated", "sys");
        await call("updateUI"); // reloads the WebView
      } else {
        bubble(t || "Updated", "sys");
      }
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
  async refreshMap() {
    // Rebuild the dependency graph + outline the agent uses to avoid re-reading
    // the whole project. Runs automatically each task too; this forces it now.
    bubble("Refreshing project map (dependency graph + outline)…", "sys");
    bubble((await call("orch", { fn: "refresh_project_map" })).text, "sys");
    refreshStats();
  },
  async checkWeb() {
    bubble("Loading the preview to check for runtime errors…", "sys");
    let r;
    try { r = await call("web.runtimeCheck"); }
    catch (e) { bubble("Check failed: " + e.message, "sys"); return; }
    if (r.skipped) { bubble("No web entry point (index.html) to check.", "sys"); return; }
    const errs = r.errors || [];
    if (!errs.length) { bubble("✓ No runtime errors from the preview.", "sys"); return; }
    bubble("⚠️ Runtime errors:\n" + errs.slice(0, 12).map((e) => "• " + e).join("\n"), "sys");
    addFixRuntime(errs);
  },
  async caveman() {
    const cur = (await call("orch", { fn: "get_caveman" })).text.trim();
    const next = cur === "1" ? "0" : "1";
    const r = await call("orch", { fn: "set_caveman", arg: next });
    bubble(r.text, "sys");
    updateCavemanLabel(next === "1");
    refreshStats();
  },
  async frugal() {
    const cur = (await call("orch", { fn: "get_frugal" })).text.trim();
    const next = cur === "1" ? "0" : "1";
    bubble((await call("orch", { fn: "set_frugal", arg: next })).text, "sys");
    updateFrugalLabel(next === "1");
    refreshStats();
  },
  async effort() {
    // Cycle orchestrator effort: off → low → medium → high → off.
    const cur = (await call("orch", { fn: "get_orch_effort" })).text.trim();
    const levels = ["off", "low", "medium", "high"];
    const idx = levels.indexOf(cur);
    const next = levels[(idx + 1) % levels.length];
    const r = await call("orch", { fn: "set_orch_effort", arg: next });
    bubble(r.text, "sys");
    updateEffortSelect("orchEffortSelect", next);
    refreshStats();
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
  async bestPractices() {
    const cur = (await call("orch", { fn: "get_best_practices" })).text || "";
    const active = (await call("orch", { fn: "preview_best_practices" })).text || "";
    modal("Best practices (every project)",
      `<textarea id="bptext" class="field" rows="9" style="min-height:170px" placeholder="- Your own rules, one per line, e.g. movement = floating joystick on the left half">${escapeHtml(cur)}</textarea>
       <div class="hint">Your rules apply to <b>every</b> project and override the built-ins. Built-in mobile-game practices (floating joystick, safe areas, delta-time loops…) auto-apply to game projects.</div>
       <details style="margin-top:8px"><summary class="hint">What's active for this project</summary><pre class="small">${escapeHtml(active)}</pre></details>`,
      async () => {
        await call("orch", { fn: "set_best_practices", arg: $("#bptext").value });
        bubble("Best practices saved — applied to every project", "sys");
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
  templates() { showTemplates(); },
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
  // Repo switching within a session is intentionally gone: a session belongs to
  // one repo (its source of truth). To work on another repo, open Projects and
  // start a session under it.
  openProjects() { showProjects(); },
  async deleteRepo() {
    bubble("Loading repos…", "sys");
    let repos = [];
    try { repos = (await call("git.listRepos")).repos || []; }
    catch (e) { bubble("Couldn't load repos: " + e.message, "sys"); return; }
    if (!repos.length) { bubble("No repos found (check GitHub token).", "sys"); return; }
    modal("Delete repository",
      `<div class="hint danger">Deletes a repo on GitHub permanently — this cannot be undone.</div>` +
      repos.map((f) => `<div class="list-item" data-del="${escAttr(f)}"><span>${escapeHtml(f)}</span><span class="sub">delete</span></div>`).join(""));
    $("#modalBody").querySelectorAll("[data-del]").forEach((el) => {
      el.onclick = () => {
        const full = el.getAttribute("data-del");
        modal("Delete " + full + "?",
          `<div class="hint danger">Permanently delete <b>${escapeHtml(full)}</b> on GitHub? This cannot be undone.</div>`,
          async () => {
            bubble("Deleting " + full + "…", "sys");
            const res = await call("py.call", { module: "git_ops", fn: "delete_repo", args: [full] });
            bubble(res.text || "done", "sys");
          });
      };
    });
  },
  // The app's headline action: describe a game, we spin up a fresh project on
  // OUR engine and hand your description to the agent, which picks a view +
  // movement from the CONTRACTS recipe and glues game/ together (asking at most
  // a follow-up or two). No framework to choose — game-making is the default.
  async makeGame() {
    const examples = [
      "A top-down twin-stick shooter where I dodge waves of enemies",
      "A side-scrolling platformer where I jump between platforms and stomp enemies",
      "An endless runner where I auto-run and tap to jump over gaps",
      "A tank battle where I rotate and drive around an arena",
    ];
    const chips = examples.map((e) =>
      `<button type="button" class="pill ghost gm-ex" style="text-align:left;white-space:normal;margin:4px 0;width:100%">${escapeHtml(e)}</button>`).join("");
    modal("🎮 Make a game",
      `<label>Describe the game you want</label>
       <textarea id="gmdesc" class="field" rows="3" placeholder="e.g. a top-down shooter where I survive waves of enemies"></textarea>
       <div class="hint" style="margin-top:10px">Not sure? Tap one to start:</div>${chips}
       <div class="hint" style="margin-top:10px">We build it on our own low-poly 3D engine. The AI may ask a quick question, then builds it — you keep tweaking in chat.</div>`,
      async () => {
        const desc = $("#gmdesc").value.trim();
        if (!desc) { $("#gmdesc").focus(); return true; }
        const name = desc.split(/\s+/).slice(0, 4).join("-").toLowerCase().replace(/[^a-z0-9-]/g, "") || "my-game";
        // Every project lives on a repo — pick/create one, then build the game.
        pickRepoThen(async (repoOrName, isNew) => {
          await startSessionOnRepo(repoOrName, isNew, name);
          bubble((await call("orch", { fn: "apply_template", arg: "engine-3d" })).text, "sys");
          submit("Make this game on the existing engine (glue game/ against engine/CONTRACTS.md, don't rewrite the engine): " + desc);
          setTimeout(() => maybeOpenPreview(), 2000);
        });
        return true;   // keep the sheet open; pickRepoThen takes it over
      });
    $("#modalBody").querySelectorAll(".gm-ex").forEach((el) => {
      el.onclick = () => { $("#gmdesc").value = el.textContent; $("#gmdesc").focus(); };
    });
  },
  async newProject() {
    let tpls = [];
    try { tpls = JSON.parse((await call("orch", { fn: "list_templates" })).text); } catch (e) {}
    const opts = [{ id: "", name: "Empty project", description: "Blank workspace" }].concat(tpls);
    const rows = opts.map((t, i) =>
      `<label class="list-item" style="align-items:flex-start">
         <input type="radio" name="tpl" value="${escapeHtml(t.id)}" ${i === 1 ? "checked" : ""} style="margin-top:4px"/>
         <span>${escapeHtml(t.name)}<div class="sub">${escapeHtml(t.description || "")}</div></span>
       </label>`).join("");
    modal("New project",
      `<label>Name</label><input id="pname" type="text" placeholder="my-game" />
       <div class="hint" style="margin-top:10px">Start from a template</div>${rows}`,
      async () => {
        const name = $("#pname").value.trim();
        const sel = $("#modalBody").querySelector('input[name="tpl"]:checked');
        const tpl = sel ? sel.value : "";
        pickRepoThen(async (repoOrName, isNew) => {
          await startSessionOnRepo(repoOrName, isNew, name || (isNew ? repoOrName : ""));
          if (tpl) bubble((await call("orch", { fn: "apply_template", arg: tpl })).text, "sys");
          bubble("New project ready. Describe what to build, or press ▶ to preview.", "sys");
          setTimeout(() => maybeOpenPreview(), 1500);
        });
        return true;   // keep the sheet open; pickRepoThen takes it over
      });
  },
  async sessions() { openSessionPanel(); },
  async models() {
    const meta = await call("session.meta");
    let reviewer = "";
    try { reviewer = (await call("orch", { fn: "get_reviewer_model" })).text.trim(); } catch (e) {}
    modal("Session models",
      `<label>Orchestrator model (planner)</label>
       <input id="mo" type="text" list="ml" value="${meta.orchestrator || ""}" />
       <label>Implementer model (blank = single agent)</label>
       <input id="mi" type="text" list="ml" value="${meta.implementer || ""}" />
       <label>Reviewer model (blank = use fallback model)</label>
       <input id="mr" type="text" list="ml" value="${escAttr(reviewer)}" />
       <datalist id="ml"></datalist>
       <div class="hint">Models are aggregated from every provider you have a key for. The reviewer checks each change (and each parallel build) — pick a stronger/different model to catch the implementer's blind spots.</div>`,
      async () => {
        await call("session.setModels", { orchestrator: $("#mo").value.trim(), implementer: $("#mi").value.trim() });
        await call("orch", { fn: "set_reviewer_model", arg: $("#mr").value.trim() });
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
       <label>OpenAI API key</label><input id="ok" type="password" value="${s.openaiKey||""}" />
       <label>GitHub token (push / create / build)</label><input id="gt" type="password" value="${s.githubToken||""}" />
       <label>Default orchestrator model</label><input id="lm" type="text" value="${s.leadModel||""}" />
       <label>Default implementer model (blank = single agent)</label><input id="wm" type="text" value="${s.workerModel||""}" />
       <label>Fallback model (used if the primary provider fails)</label><input id="fm" type="text" list="ml" value="${s.fallbackModel||""}" placeholder="e.g. deepseek/deepseek-chat" />
       <datalist id="ml"></datalist>
       <label>Voice: silence before it stops (ms)</label><input id="ssm" type="text" inputmode="numeric" value="${s.speechSilenceMs||"7000"}" />
       <label>Agent branch (for OTA updates)</label><input id="br" type="text" value="${s.branch||""}" />
       <div class="group-title">Preferences</div>
       <div class="grid">
         <button data-act="autocommit">Autocommit: —</button>
         <button data-act="speak">Speak replies: —</button>
         <button data-act="caveman">Caveman: —</button>
         <button data-act="frugal">Frugal: —</button>
       </div>`,
      async () => {
        await call("settings.save", {
          anthropicKey: $("#ak").value.trim(), deepseekKey: $("#dk").value.trim(),
          openaiKey: $("#ok").value.trim(),
          githubToken: $("#gt").value.trim(), leadModel: $("#lm").value.trim(),
          workerModel: $("#wm").value.trim(), fallbackModel: $("#fm").value.trim(),
          speechSilenceMs: $("#ssm").value.trim(),
          branch: $("#br").value.trim(),
        });
        refreshHeader();
      });
    try {
      const agg = await call("models.aggregate");
      const dl = $("#ml");
      if (dl) dl.innerHTML = (agg.models || []).map((m) => `<option value="${m}">`).join("");
    } catch (e) {}
    // Preference toggles: wire clicks (they cycle state) and show current values.
    $("#modalBody").querySelectorAll("[data-act]").forEach((b) => {
      b.onclick = () => (actions[b.dataset.act] || (() => {}))();
    });
    try { updateAutocommitLabel((await call("orch", { fn: "get_autocommit" })).text.trim() === "1"); } catch (e) {}
    updateSpeakLabel(autoSpeakOn());
    try { updateCavemanLabel((await call("orch", { fn: "get_caveman" })).text.trim() === "1"); } catch (e) {}
    try { updateFrugalLabel((await call("orch", { fn: "get_frugal" })).text.trim() === "1"); } catch (e) {}
    try { updateAutodiagnoseLabel((await call("orch", { fn: "get_autodiagnose" })).text.trim() === "1"); } catch (e) {}
    try { updateAutocleanLabel((await call("orch", { fn: "get_autoclean" })).text.trim() === "1"); } catch (e) {}
    try { updateReviewLabel((await call("orch", { fn: "get_review" })).text.trim() === "1"); } catch (e) {}
    try { _routingOn = (await call("orch", { fn: "get_routing" })).text.trim() === "1"; updateRoutingLabel(_routingOn); } catch (e) {}
  },
};

// --- Projects → Sessions manager (repo owns its sessions) ----------------
// A project IS a GitHub repo (the source of truth); a session is work under it.
// Top level lists repos; drilling in lists that repo's sessions.

async function listSessionsGrouped() {
  const r = await call("session.list");
  const sessions = r.sessions || [];
  const groups = {};
  sessions.forEach((s) => {
    const key = s.activeRepo || "";
    (groups[key] = groups[key] || []).push(s);
  });
  return { groups, activeId: r.activeId };
}

async function showProjects() {
  const { groups, activeId } = await listSessionsGrouped();
  const repos = Object.keys(groups).filter((k) => k).sort();
  const noRepo = groups[""] || [];
  let html = repos.map((full) => {
    const list = groups[full];
    const active = list.some((s) => s.id === activeId);
    return `<div class="list-item" data-repo="${escAttr(full)}">
      <span>${active ? "● " : "○ "}${escapeHtml(full)}</span>
      <span class="sub">${list.length} session${list.length > 1 ? "s" : ""}</span></div>`;
  }).join("");
  if (noRepo.length) {
    html += `<div class="list-item" data-repo="__none__">
      <span>○ Needs a repo</span><span class="sub">${noRepo.length}</span></div>`;
  }
  if (!html) html = `<div class="hint">No projects yet — start one on a GitHub repo.</div>`;
  modal("Projects", html +
    `<button class="pill ghost" id="newProj" style="margin-top:10px">➕ New project</button>`);
  $("#modalBody").querySelectorAll("[data-repo]").forEach((el) => {
    el.onclick = () => showRepoSessions(el.dataset.repo);
  });
  $("#newProj").onclick = () => pickRepoThen((repoOrName, isNew) =>
    startSessionOnRepo(repoOrName, isNew));
}

async function showRepoSessions(repo) {
  const { groups, activeId } = await listSessionsGrouped();
  const key = repo === "__none__" ? "" : repo;
  const list = groups[key] || [];
  const title = repo === "__none__" ? "Needs a repo" : repo;
  const items = list.map((s) => {
    const nm = escapeHtml(s.name);
    return `<div class="list-item sess-row">
      <span class="sess-pick" data-sid="${s.id}">${s.id === activeId ? "● " : "○ "}${nm}</span>
      <span class="sess-actions">
        <b class="sess-btn" data-rename="${s.id}" data-name="${nm}" title="Rename">✎</b>
        <b class="sess-btn" data-del="${s.id}" data-name="${nm}" title="Delete">🗑</b>
      </span></div>`;
  }).join("") || `<div class="hint">No sessions in this project yet.</div>`;
  const newBtn = key
    ? `<button class="pill ghost" id="newSess" style="margin-top:10px">➕ New session in ${escapeHtml(key)}</button>`
    : "";
  modal(title, `<div class="list-item" id="backProj"><span>‹ All projects</span></div>` + items + newBtn);
  $("#backProj").onclick = () => showProjects();
  const reopen = () => showRepoSessions(repo);
  $("#modalBody").querySelectorAll("[data-sid]").forEach((el) => {
    el.onclick = async () => {
      await call("session.setActive", { id: el.dataset.sid });
      closeSheet("#modal"); await refreshHeader(); await loadHistory();
    };
  });
  $("#modalBody").querySelectorAll("[data-rename]").forEach((el) => {
    el.onclick = (ev) => {
      ev.stopPropagation();
      modal("Rename session", `<label>Name</label><input id="rn2" type="text" value="${el.dataset.name}" />`,
        async () => {
          const n = $("#rn2").value.trim(); if (!n) return;
          await call("session.rename", { id: el.dataset.rename, name: n }); reopen();
        });
    };
  });
  $("#modalBody").querySelectorAll("[data-del]").forEach((el) => {
    el.onclick = (ev) => {
      ev.stopPropagation();
      modal("Delete session",
        `<div class="hint">Permanently delete "<b>${el.dataset.name}</b>" — its local files, history and settings? The repo on GitHub is untouched. This cannot be undone.</div>`,
        async () => { await call("session.delete", { id: el.dataset.del }); reopen(); });
    };
  });
  if (key) $("#newSess").onclick = () => promptNewSessionInRepo(key);
}

function promptNewSessionInRepo(full) {
  modal("New session in " + full,
    `<label>Name</label><input id="sn" type="text" placeholder="what you're working on" />`,
    async () => {
      const name = $("#sn").value.trim() || full.split("/").pop();
      closeSheet("#modal");
      await startSessionOnRepo(full, false, name);
    });
}

// --- Session side panel (slides in from the left, like Claude.ai) ----------
// Fold-out session browser with swipe gesture, search, and quick CRUD.

let _sessionPanelOpen = false;
let _sessionTouchStart = null;

function sessionPanelIsOpen() {
  const p = $("#sessionPanel");
  return !!(p && p.classList.contains("open"));
}

function openSessionPanel() {
  const p = $("#sessionPanel");
  if (!p) return;
  p.classList.add("open");
  const b = $("#sessionBackdrop");
  if (b) b.classList.remove("hidden");
  const t = $("#sessionTab");
  if (t) t.classList.add("panel-open");
  _sessionPanelOpen = true;
  renderSessionPanel();
}

function closeSessionPanel() {
  const p = $("#sessionPanel");
  if (p) p.classList.remove("open");
  const b = $("#sessionBackdrop");
  if (b) b.classList.add("hidden");
  const t = $("#sessionTab");
  if (t) t.classList.remove("panel-open");
  _sessionPanelOpen = false;
}

function toggleSessionPanel() {
  sessionPanelIsOpen() ? closeSessionPanel() : openSessionPanel();
}

// Swipe-to-open: detect a rightward swipe from the left ~30px edge.
function initSessionSwipe() {
  document.addEventListener("touchstart", (e) => {
    if (e.touches.length !== 1) return;
    const x = e.touches[0].clientX;
    if (x > 32 || sessionPanelIsOpen()) return;
    _sessionTouchStart = { x, y: e.touches[0].clientY, time: Date.now() };
  }, { passive: true });

  document.addEventListener("touchend", (e) => {
    if (!_sessionTouchStart) return;
    const last = e.changedTouches[0];
    if (!last) { _sessionTouchStart = null; return; }
    const dx = last.clientX - _sessionTouchStart.x;
    const dy = Math.abs(last.clientY - _sessionTouchStart.y);
    const dt = Date.now() - _sessionTouchStart.time;
    // Rightward swipe of at least 60px, mostly horizontal, within 400ms
    if (dx > 60 && dy < dx * 0.6 && dt < 400) {
      openSessionPanel();
    }
    _sessionTouchStart = null;
  }, { passive: true });
}

async function renderSessionPanel(filter) {
  const list = $("#sessionList");
  if (!list) return;
  let sessions = [];
  let activeId = "";
  try {
    const r = await call("session.list");
    sessions = r.sessions || [];
    activeId = r.activeId || "";
  } catch (e) {
    list.innerHTML = `<div class="sp-empty">Could not load sessions.</div>`;
    return;
  }

  const q = (filter || "").trim().toLowerCase();
  if (q) sessions = sessions.filter((s) => s.name.toLowerCase().includes(q) || (s.activeRepo || "").toLowerCase().includes(q));

  // Group by repo
  const groups = {};
  sessions.forEach((s) => {
    const key = s.activeRepo || "Unassigned";
    (groups[key] = groups[key] || []).push(s);
  });

  const repoKeys = Object.keys(groups).sort((a, b) => {
    if (a === "Unassigned") return 1;
    if (b === "Unassigned") return -1;
    return a.localeCompare(b);
  });

  if (!repoKeys.length) {
    list.innerHTML = `<div class="sp-empty">No sessions yet.<br><br><button class="pill ghost" id="spNewEmpty">➕ Create a session</button></div>`;
    const btn = list.querySelector("#spNewEmpty");
    if (btn) btn.onclick = () => { closeSessionPanel(); actions.newProject(); };
    return;
  }

  let html = "";
  repoKeys.forEach((repo) => {
    const items = groups[repo];
    const shortRepo = repo === "Unassigned" ? repo : repo.split("/").pop();
    html += `<div class="sp-group">
      <span class="sp-repo-name">${escapeHtml(shortRepo)}</span>
      <span class="sp-repo-count">${items.length}</span>
    </div>`;
    items.forEach((s) => {
      const isActive = s.id === activeId;
      html += `<div class="sp-session${isActive ? " active" : ""}" data-sid="${s.id}">
        <span class="sp-sess-icon">${isActive ? "●" : "○"}</span>
        <span class="sp-sess-name" title="${escapeHtml(s.name)}">${escapeHtml(s.name)}</span>
        <span class="sp-sess-actions">
          <button class="sp-sess-act" data-sp-rename="${s.id}" data-sp-name="${escapeHtml(s.name)}" title="Rename">✎</button>
          <button class="sp-sess-act danger" data-sp-del="${s.id}" data-sp-name="${escapeHtml(s.name)}" title="Delete">🗑</button>
        </span>
      </div>`;
    });
  });

  list.innerHTML = html;

  // Wire clicks: switch session
  list.querySelectorAll(".sp-session").forEach((el) => {
    el.onclick = async (ev) => {
      // Don't switch if clicking an action button
      if (ev.target.closest(".sp-sess-act")) return;
      const id = el.dataset.sid;
      if (id === activeId) return;
      await call("session.setActive", { id });
      closeSessionPanel();
      await refreshHeader();
      await loadHistory();
    };
  });

  // Wire rename
  list.querySelectorAll("[data-sp-rename]").forEach((btn) => {
    btn.onclick = (ev) => {
      ev.stopPropagation();
      const id = btn.dataset.spRename;
      const name = btn.dataset.spName;
      modal("Rename session",
        `<label>Name</label><input id="spRnInput" type="text" value="${escapeHtml(name)}" />`,
        async () => {
          const n = $("#spRnInput").value.trim();
          if (!n) return;
          await call("session.rename", { id, name: n });
          renderSessionPanel($("#sessionSearch")?.value || "");
        });
    };
  });

  // Wire delete
  list.querySelectorAll("[data-sp-del]").forEach((btn) => {
    btn.onclick = (ev) => {
      ev.stopPropagation();
      const id = btn.dataset.spDel;
      const name = btn.dataset.spName;
      modal("Delete session",
        `<div class="hint">Permanently delete "<b>${escapeHtml(name)}</b>" — its local files, history and settings? The repo on GitHub is untouched. This cannot be undone.</div>`,
        async () => {
          await call("session.delete", { id });
          closeSheet("#modal");
          await refreshHeader();
          await loadHistory();
          renderSessionPanel($("#sessionSearch")?.value || "");
        });
    };
  });
}

// Choose (or create) the GitHub repo a new project lives on.
async function pickRepoThen(cb) {
  bubble("Loading repos…", "sys");
  let repos = [];
  try { repos = (await call("git.listRepos")).repos || []; } catch (e) {}
  const rows = repos.map((f) =>
    `<div class="list-item" data-repo="${escAttr(f)}"><span>${escapeHtml(f)}</span></div>`).join("");
  modal("Choose a repo",
    `<div class="hint">Every project lives on a GitHub repo — its source of truth.</div>` +
    rows + `<button class="pill ghost" id="newRepoBtn" style="margin-top:10px">➕ Create new repo</button>`);
  $("#modalBody").querySelectorAll("[data-repo]").forEach((el) => {
    el.onclick = () => {
      const repo = el.dataset.repo;
      closeSheet("#modal");
      // Immediate UI feedback: update the subtitle bar so the user sees the chosen repo.
      const sr = $("#subRepo"); if (sr) sr.textContent = repo;
      setStatus("Selected " + repo);
      cb(repo, false);
    };
  });
  $("#newRepoBtn").onclick = () => {
    modal("New GitHub repo", `<label>Repo name</label><input id="nrn" type="text" placeholder="my-project" />`,
      async () => {
        const name = $("#nrn").value.trim(); if (!name) return;
        closeSheet("#modal");
        // Immediate UI feedback for a new repo name.
        const sr = $("#subRepo"); if (sr) sr.textContent = name;
        setStatus("Creating " + name + "…");
        cb(name, true);
      });
  };
}

// Create a session bound to a repo: clone an existing one, or create a new repo.
// Returns the repo full name (existing) or the new repo's name.
async function startSessionOnRepo(repoOrName, isNew, sessionName) {
  const name = sessionName || (isNew ? repoOrName : repoOrName.split("/").pop());
  bubble((isNew ? "Creating repo " : "Starting on ") + repoOrName + "…", "sys");
  await call("session.create", { name });
  const res = isNew
    ? (await call("git.createRepo", { name: repoOrName })).text
    : (await call("git.clone", { full: repoOrName })).text;
  if (res) bubble(res, "sys");
  await refreshHeader(); await loadHistory(); refreshStats();
  return repoOrName;
}

function confirmClone(full) {
  modal(full,
    `<div class="hint">Clone into the current session (replaces local files), or just point at it?</div>`,
    null);
  const body = $("#modalBody");
  body.innerHTML += `<div class="row" style="margin-top:12px">
    <button class="pill" id="cloneBtn">Clone</button>
    <button class="pill ghost" id="pointBtn">Point at it</button></div>`;
  $("#cloneBtn").onclick = async () => { closeSheet("#modal"); await runText("Clone", "git.clone", { full }); await onRepoChanged(); };
  $("#pointBtn").onclick = async () => { closeSheet("#modal"); await runText("Set repo", "git.setActiveRepo", { full }); await onRepoChanged(); };
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
          return `<div class="filerow dir"><span data-e="${escAttr(e)}">${escapeHtml(e)}</span></div>`;
        }
        const on = pinned.includes(path + e);
        const btn = `<button class="pinbtn ${on ? "on" : ""}" data-pin="${escAttr(path + e)}">${on ? "Remove from context" : "Add to context"}</button>`;
        return `<div class="filerow"><span data-e="${escAttr(e)}">${on ? "📎 " : ""}${escapeHtml(e)}</span>${btn}</div>`;
      }).join("")
    : `<div class="hint">(empty)</div>`);
  modal("/" + path, body + `<div class="hint">📎 = sent to the model as context every turn. Tap "Remove from context" to stop sending a file.</div>`);
  $("#modalBody").querySelectorAll("[data-e]").forEach((el) => {
    el.onclick = () => {
      const e = el.dataset.e;
      if (e.endsWith("/")) filesModal(path + e);
      else { openTab(path + e); closeSheet("#modal"); }
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

// --- Persistent file explorer (tree view) --------------------------------
const treeState = { expanded: new Set(), active: "" };

function buildTree(paths) {
  const root = { dirs: {}, files: [], path: "" };
  for (const p of paths) {
    const parts = p.split("/");
    let node = root, cur = "";
    for (let i = 0; i < parts.length - 1; i++) {
      const d = parts[i];
      cur = cur ? cur + "/" + d : d;
      if (!node.dirs[d]) node.dirs[d] = { dirs: {}, files: [], path: cur };
      node = node.dirs[d];
    }
    node.files.push({ name: parts[parts.length - 1], path: p });
  }
  return root;
}
function fileIcon(name) {
  const e = (name.split(".").pop() || "").toLowerCase();
  if (["js", "ts", "jsx", "tsx", "kt", "java"].includes(e)) return "📜";
  if (["py", "pyw"].includes(e)) return "🐍";
  if (["json", "toml", "yaml", "yml", "ini", "cfg"].includes(e)) return "🧾";
  if (["md", "txt"].includes(e)) return "📝";
  if (e === "html") return "🌐";
  if (e === "css") return "🎨";
  if (["png", "jpg", "jpeg", "gif", "svg", "webp"].includes(e)) return "🖼️";
  return "📄";
}
function escAttr(s) { return escapeHtml(s).replace(/"/g, "&quot;"); }
function treeRowHtml(o) {
  const pad = 8 + o.depth * 14;
  const caret = o.dir ? `<span class="tw-caret">${o.open ? "▾" : "▸"}</span>` : `<span class="tw-caret"></span>`;
  const ico = o.dir ? (o.open ? "📂" : "📁") : fileIcon(o.name);
  const active = !o.dir && o.path === treeState.active ? " active" : "";
  const attr = o.dir ? `data-dir="${escAttr(o.path)}"` : `data-file="${escAttr(o.path)}"`;
  return `<div class="tree-row${o.dir ? " dir" : ""}${active}" style="padding-left:${pad}px" ${attr}>` +
    `${caret}<span class="tw-ico">${ico}</span><span class="tw-name">${escapeHtml(o.name)}</span></div>`;
}
function renderTreeNode(node, depth, out) {
  Object.keys(node.dirs).sort((a, b) => a.localeCompare(b)).forEach((d) => {
    const dir = node.dirs[d];
    const open = treeState.expanded.has(dir.path);
    out.push(treeRowHtml({ dir: true, name: d, path: dir.path, depth, open }));
    if (open) renderTreeNode(dir, depth + 1, out);
  });
  node.files.sort((a, b) => a.name.localeCompare(b.name)).forEach((f) => {
    out.push(treeRowHtml({ dir: false, name: f.name, path: f.path, depth }));
  });
}
async function renderTree() {
  const el = $("#tree");
  if (!el) return;
  let paths = [];
  try { paths = JSON.parse((await call("orch", { fn: "browse_files" })).text) || []; } catch (e) {}
  if (!paths.length) { el.innerHTML = `<div class="tree-empty">No files yet.</div>`; return; }
  const out = [];
  renderTreeNode(buildTree(paths), 0, out);
  el.innerHTML = out.join("");
  el.querySelectorAll("[data-dir]").forEach((row) => {
    row.onclick = () => {
      const p = row.getAttribute("data-dir");
      if (treeState.expanded.has(p)) treeState.expanded.delete(p);
      else treeState.expanded.add(p);
      renderTree();
    };
  });
  el.querySelectorAll("[data-file]").forEach((row) => {
    row.onclick = () => {
      openTab(row.getAttribute("data-file"));
      closeTree();
    };
  });
}
function openTree() {
  const o = $("#treeOverlay"), b = $("#treeBackdrop");
  if (o) o.classList.remove("hidden");
  if (b) b.classList.remove("hidden");
  renderTree();
}
function closeTree() {
  const o = $("#treeOverlay"), b = $("#treeBackdrop");
  if (o) o.classList.add("hidden");
  if (b) b.classList.add("hidden");
}
// Create a new empty file from the explorer and open it in a tab for editing.
function newFile() {
  modal("New file",
    `<label>File path (relative to project root)</label>
     <input id="nfName" type="text" placeholder="src/newfile.js" autocapitalize="off" autocorrect="off" spellcheck="false" />
     <div class="hint">Creates an empty file and opens it for editing.</div>`,
    async () => {
      const name = ($("#nfName").value || "").trim().replace(/^\/+/, "");
      if (!name) return;
      const res = await call("py.call", { module: "orchestrator", fn: "write_ws_file", args: [name, ""] });
      if ((res.text || "").startsWith("Saved")) {
        closeTree();
        await openTab(name);
        const a = $("#edArea"); if (a) a.focus();
      } else {
        bubble(res.text || "Could not create file.", "sys");
      }
    });
}
// After the active repo/session changes, the workspace is different: drop open
// tabs and let the tree re-read on next open.
async function onRepoChanged() {
  openTabs.length = 0;
  activeTab = null;
  showEditorEmpty();
  renderTabs();
  await refreshHeader();
}

// --- Syntax highlighting -------------------------------------------------
// A small, dependency-free highlighter. It tokenizes the RAW text and only
// wraps recognized tokens in <span>s (everything is HTML-escaped), so the
// highlighted layer lines up character-for-character with the textarea.
const HL_KEYWORDS = {
  c: ["if","else","for","while","do","switch","case","break","continue","return",
      "function","var","let","const","class","extends","new","this","super","import",
      "export","default","from","as","try","catch","finally","throw","typeof",
      "instanceof","in","of","void","delete","yield","async","await","static","get",
      "set","fun","val","when","object","override","private","public","internal",
      "suspend","interface","enum","true","false","null","undefined"],
  py: ["def","class","return","if","elif","else","for","while","import","from","as",
       "try","except","finally","with","lambda","yield","async","await","pass","break",
       "continue","in","is","not","and","or","None","True","False","self","raise",
       "global","nonlocal","assert","del","print"],
};
function hlLangFor(rel) {
  const ext = (rel.split(".").pop() || "").toLowerCase();
  if (["html", "htm", "xml", "svg", "vue"].includes(ext)) return "html";
  if (["css", "scss", "less"].includes(ext)) return "css";
  if (["py", "pyw", "sh", "bash", "yaml", "yml", "toml", "rb", "cfg", "ini"].includes(ext)) return "py";
  return "c";
}
function highlightCode(code, lang) {
  if (lang === "html") return highlightHtml(code);
  if (lang === "css") return highlightCss(code);
  return highlightGeneric(code, { keywords: lang === "py" ? HL_KEYWORDS.py : HL_KEYWORDS.c, hash: lang === "py" });
}
function highlightGeneric(code, opts) {
  const kwRe = opts.keywords.length ? new RegExp("^(?:" + opts.keywords.join("|") + ")$") : null;
  const comment = opts.hash ? "#[^\\n]*" : "//[^\\n]*|/\\*[\\s\\S]*?\\*/";
  const re = new RegExp(
    "(" + comment + ")" +
    "|(\"(?:\\\\.|[^\"\\\\])*\"|'(?:\\\\.|[^'\\\\])*'|`(?:\\\\.|[^`\\\\])*`)" +
    "|(\\b\\d[\\w.]*\\b)" +
    "|([A-Za-z_$][\\w$]*)", "g");
  let out = "", last = 0, m;
  while ((m = re.exec(code))) {
    out += escapeHtml(code.slice(last, m.index));
    const t = m[0];
    if (m[1]) out += '<span class="tk-c">' + escapeHtml(t) + "</span>";
    else if (m[2]) out += '<span class="tk-s">' + escapeHtml(t) + "</span>";
    else if (m[3]) out += '<span class="tk-n">' + escapeHtml(t) + "</span>";
    else if (m[4] && kwRe && kwRe.test(t)) out += '<span class="tk-k">' + escapeHtml(t) + "</span>";
    else out += escapeHtml(t);
    last = re.lastIndex;
  }
  out += escapeHtml(code.slice(last));
  return out + "\n";
}
// HTML/XML: colors comments, tag names, and quoted attribute values.
function highlightHtml(code) {
  const re = /(<!--[\s\S]*?-->)|(<\/?)([A-Za-z][\w:-]*)?|("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')|(>|\/>)/g;
  let out = "", last = 0, m;
  while ((m = re.exec(code))) {
    out += escapeHtml(code.slice(last, m.index));
    if (m[1]) out += '<span class="tk-c">' + escapeHtml(m[1]) + "</span>";
    else if (m[2] !== undefined && m[2] !== "") {
      out += '<span class="tk-p">' + escapeHtml(m[2]) + "</span>";
      if (m[3]) out += '<span class="tk-k">' + escapeHtml(m[3]) + "</span>";
    } else if (m[4]) out += '<span class="tk-s">' + escapeHtml(m[4]) + "</span>";
    else if (m[5]) out += '<span class="tk-p">' + escapeHtml(m[5]) + "</span>";
    else out += escapeHtml(m[0]);
    last = re.lastIndex;
  }
  out += escapeHtml(code.slice(last));
  return out + "\n";
}
// CSS: colors comments, strings, hex colors, numbers/units, at-rules, and
// property names (identifiers immediately followed by a colon).
function highlightCss(code) {
  const re = /(\/\*[\s\S]*?\*\/)|("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')|(#[0-9a-fA-F]{3,8}\b)|(-?\d[\d.]*(?:px|em|rem|%|vh|vw|vmin|vmax|s|ms|deg|fr|pt|ch|ex)?\b)|(@[\w-]+)|([A-Za-z_-][\w-]*)/g;
  let out = "", last = 0, m;
  while ((m = re.exec(code))) {
    out += escapeHtml(code.slice(last, m.index));
    if (m[1]) out += '<span class="tk-c">' + escapeHtml(m[1]) + "</span>";
    else if (m[2]) out += '<span class="tk-s">' + escapeHtml(m[2]) + "</span>";
    else if (m[3]) out += '<span class="tk-n">' + escapeHtml(m[3]) + "</span>";
    else if (m[4]) out += '<span class="tk-n">' + escapeHtml(m[4]) + "</span>";
    else if (m[5]) out += '<span class="tk-k">' + escapeHtml(m[5]) + "</span>";
    else if (m[6]) {
      // Property name if the next non-space char is a colon.
      const rest = code.slice(re.lastIndex);
      const isProp = /^\s*:/.test(rest);
      out += isProp ? '<span class="tk-p">' + escapeHtml(m[6]) + "</span>" : escapeHtml(m[6]);
    } else out += escapeHtml(m[0]);
    last = re.lastIndex;
  }
  out += escapeHtml(code.slice(last));
  return out + "\n";
}
function escapeRegExp(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
// Line-based diff (LCS). Returns [[sign, line], …] with sign " ", "-", or "+",
// or null if the inputs are too large to diff cheaply on-device.
function lineDiff(a, b) {
  const A = a.split("\n"), B = b.split("\n");
  const n = A.length, m = B.length;
  if (n * m > 4000000) return null;
  const dp = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out = []; let i = 0, j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) { out.push([" ", A[i]]); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push(["-", A[i]]); i++; }
    else { out.push(["+", B[j]]); j++; }
  }
  while (i < n) out.push(["-", A[i++]]);
  while (j < m) out.push(["+", B[j++]]);
  return out;
}

// --- Tabbed, auto-saving editor ------------------------------------------
// Open files live as tabs to the right of the ☰ Files button. There is no
// editor chrome: the active tab is the title, its ✕ closes it, edits auto-save
// (debounced), and find/replace is a floating 🔍 button inside the code.
const openTabs = [];   // [{ rel, content, saved }]
let activeTab = null;  // rel of the active tab
const _saveTimers = {};

function tabBasename(rel) { return rel.includes("/") ? rel.slice(rel.lastIndexOf("/") + 1) : rel; }

// A tab's status dot: amber = unsaved edits, green = differs from last commit.
function tabMark(t) {
  if (t.content !== t.saved) return { ch: "●", cls: "m-unsaved" };
  if (t.head != null && t.saved !== t.head) return { ch: "●", cls: "m-modified" };
  return { ch: "", cls: "" };
}
function renderTabs() {
  const c = $("#tabs"); if (!c) return;
  c.innerHTML = openTabs.map((t) => {
    const active = t.rel === activeTab ? " active" : "";
    const mk = tabMark(t);
    return `<div class="tab${active}" data-tab="${escAttr(t.rel)}" title="${escAttr(t.rel)}">
      <span class="tab-dirty ${mk.cls}">${mk.ch}</span>
      <span class="tab-name">${escapeHtml(tabBasename(t.rel))}</span>
      <span class="tab-x" data-close="${escAttr(t.rel)}">✕</span></div>`;
  }).join("");
  c.querySelectorAll(".tab").forEach((el) => {
    el.onclick = (e) => { if (!e.target.closest("[data-close]")) setActiveTab(el.getAttribute("data-tab")); };
  });
  c.querySelectorAll("[data-close]").forEach((el) => {
    el.onclick = (e) => { e.stopPropagation(); closeTab(el.getAttribute("data-close")); };
  });
}
function updateActiveTabMark() {
  const tab = openTabs.find((t) => t.rel === activeTab);
  const d = document.querySelector("#tabs .tab.active .tab-dirty");
  if (!tab || !d) return;
  const mk = tabMark(tab);
  d.textContent = mk.ch;
  d.className = "tab-dirty " + mk.cls;
}
async function openTab(rel) {
  if (openTabs.some((t) => t.rel === rel)) { setActiveTab(rel); return; }
  let content = "";
  try { content = (await call("orch", { fn: "read_ws_file", arg: rel })).text || ""; } catch (e) {}
  const tab = { rel, content, saved: content, head: null };
  openTabs.push(tab);
  setActiveTab(rel);
  // Fetch the committed version in the background for the "modified" dot.
  fetchHead(tab);
}
async function fetchHead(tab) {
  try { tab.head = (await call("py.call", { module: "orchestrator", fn: "head_file", args: [tab.rel] })).text || ""; }
  catch (e) { return; }
  if (tab.rel === activeTab) updateActiveTabMark(); else renderTabs();
}
function setActiveTab(rel) {
  activeTab = rel;
  treeState.active = rel;
  renderTabs();
  renderEditor();
}
function closeTab(rel) {
  flushSave(rel);
  const i = openTabs.findIndex((t) => t.rel === rel);
  if (i < 0) return;
  openTabs.splice(i, 1);
  if (activeTab === rel) {
    const next = openTabs[i] || openTabs[i - 1] || null;
    activeTab = next ? next.rel : null;
    treeState.active = activeTab || "";
  }
  renderTabs();
  if (activeTab) renderEditor(); else showEditorEmpty();
}
function showEditorEmpty() {
  const pane = $("#editorPane"), empty = $("#editorEmpty"), fab = $("#edFindFab"), diffFab = $("#edDiffFab");
  if (pane) { pane.classList.add("hidden"); pane.innerHTML = ""; }
  if (empty) empty.classList.remove("hidden");
  if (fab) fab.classList.add("hidden");
  if (diffFab) diffFab.classList.add("hidden");
  const cp = $("#cursorPos"); if (cp) cp.textContent = "";
}

// Debounced auto-save.
function scheduleSave(rel) {
  if (_saveTimers[rel]) clearTimeout(_saveTimers[rel]);
  _saveTimers[rel] = setTimeout(() => saveTab(rel), 800);
}
function flushSave(rel) {
  if (_saveTimers[rel]) { clearTimeout(_saveTimers[rel]); delete _saveTimers[rel]; }
  saveTab(rel);
}
async function saveTab(rel) {
  const tab = openTabs.find((t) => t.rel === rel);
  if (!tab || tab.content === tab.saved) return;
  const pending = tab.content;
  const res = await call("py.call", { module: "orchestrator", fn: "write_ws_file", args: [rel, pending] });
  if ((res.text || "").startsWith("Saved")) {
    tab.saved = pending;
    if (rel === activeTab && tab.content === tab.saved) updateActiveTabMark();
    else renderTabs();
  }
}

// Re-read open tabs from disk so agent edits show up. If the agent changed the
// file (disk differs from what we last saved), take the agent's version — even
// over local edits. If the agent didn't touch it, any unsaved edits are kept.
async function refreshOpenTabs() {
  for (const tab of openTabs) {
    let disk;
    try { disk = (await call("orch", { fn: "read_ws_file", arg: tab.rel })).text || ""; }
    catch (e) { continue; }
    if (disk === tab.saved) { fetchHead(tab); continue; } // maybe committed → refresh head dot
    tab.content = disk;
    tab.saved = disk;
    fetchHead(tab);
    if (tab.rel === activeTab) {
      const prev = $("#edArea"), st = prev ? prev.scrollTop : 0;
      renderEditor();
      const a = $("#edArea"); if (a) { a.scrollTop = st; a.dispatchEvent(new Event("scroll")); }
    }
  }
}

// Render the active tab's file into the (chrome-less) editor pane.
function renderEditor() {
  const tab = openTabs.find((t) => t.rel === activeTab);
  const pane = $("#editorPane"), empty = $("#editorEmpty"), fab = $("#edFindFab"), diffFab = $("#edDiffFab");
  if (!tab) { showEditorEmpty(); return; }
  empty.classList.add("hidden");
  pane.classList.remove("hidden");
  fab.classList.remove("hidden");
  diffFab.classList.remove("hidden");
  diffFab.classList.remove("active");
  const hlLang = hlLangFor(tab.rel);
  pane.innerHTML =
    `<div class="editor">
       <div class="editor-body">
         <div class="editor-code">
           <pre class="editor-hl" id="edHl" aria-hidden="true"></pre>
           <textarea class="editor-area" id="edArea" spellcheck="false"
                     autocomplete="off" autocapitalize="off" autocorrect="off"></textarea>
           <div class="editor-diff hidden" id="edDiff"></div>
           <div class="editor-findpop hidden" id="edFindPop">
             <div class="fp-row">
               <input id="edFindI" class="field" placeholder="Find" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" />
               <span id="edFindCount" class="editor-find-count">0/0</span>
               <button class="pill ghost sm" id="edPrev" title="Previous">‹</button>
               <button class="pill ghost sm" id="edNext" title="Next">›</button>
               <button class="pill ghost sm" id="edFindClose" title="Close">✕</button>
             </div>
             <div class="fp-row">
               <input id="edReplI" class="field" placeholder="Replace" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" />
               <button class="pill ghost sm" id="edRepl">Replace</button>
               <button class="pill ghost sm" id="edReplAll">All</button>
             </div>
           </div>
         </div>
       </div>
     </div>`;

  const area = $("#edArea"), hl = $("#edHl");
  area.value = tab.content;

  // Coalesce re-highlights to one per animation frame — re-tokenizing the whole
  // buffer on every keystroke lags input on large files.
  let hlPending = false;
  function renderHl() {
    if (hlPending) return;
    hlPending = true;
    requestAnimationFrame(() => { hlPending = false; hl.innerHTML = highlightCode(area.value, hlLang); });
  }
  // Show the caret's line/column in the tab bar, and remember any selection
  // (so the chat composer can pull it into the message even after focus moves).
  function updatePos() {
    _editorSelection = { rel: tab.rel, text: area.value.slice(area.selectionStart, area.selectionEnd) };
    const el = $("#cursorPos"); if (!el) return;
    const upto = area.value.slice(0, area.selectionStart);
    const line = upto.split("\n").length;
    const col = upto.length - upto.lastIndexOf("\n"); // 1-based within the line
    el.textContent = `Ln ${line}, Col ${col}`;
  }
  function refresh() { renderHl(); findMatches(); updatePos(); }

  // --- Inline diff (working buffer vs last commit), toggled by the ± button ---
  const edDiff = $("#edDiff");
  let diffOn = false;
  function hideDiff() { diffOn = false; diffFab.classList.remove("active"); edDiff.classList.add("hidden"); fab.classList.remove("hidden"); }
  // Apply a programmatic buffer change (e.g. a revert) without leaving diff view.
  function setBuffer(v) {
    area.value = v; tab.content = v;
    updateActiveTabMark(); renderHl(); findMatches();
    scheduleSave(tab.rel);
  }
  async function renderDiff() {
    let head = "";
    try { head = (await call("py.call", { module: "orchestrator", fn: "head_file", args: [tab.rel] })).text || ""; } catch (e) {}
    if (!diffOn) return;
    const rows = lineDiff(head, area.value);
    if (rows === null) { edDiff.innerHTML = `<span class="di-empty">File too large to diff.</span>`; return; }
    // Group consecutive changed rows into hunks.
    const hunkOf = rows.map(() => -1);
    let h = -1, prev = false;
    rows.forEach((r, i) => { const ch = r[0] !== " "; if (ch) { if (!prev) h++; hunkOf[i] = h; } prev = ch; });
    if (h < 0) { edDiff.innerHTML = `<span class="di-empty">No changes vs last commit.</span>`; return; }
    let html = "", cur = -1;
    rows.forEach(([t, s], i) => {
      const k = hunkOf[i];
      if (k !== cur) {
        if (cur !== -1) html += "</div>";
        if (k !== -1) html += `<div class="di-hunk"><button class="di-revert" data-hunk="${k}">⤺ revert</button>`;
        cur = k;
      }
      const cls = t === "+" ? "di-add" : t === "-" ? "di-del" : "di-ctx";
      html += `<span class="${cls}">${escapeHtml(t + " " + s)}</span>`;
    });
    if (cur !== -1) html += "</div>";
    edDiff.innerHTML = html;
    edDiff.querySelectorAll("[data-hunk]").forEach((btn) => {
      btn.onclick = () => {
        const k = parseInt(btn.dataset.hunk, 10);
        const res = [];
        rows.forEach(([t, s], i) => {
          if (hunkOf[i] === k) { if (t === "-") res.push(s); }   // revert: keep committed side
          else if (t !== "-") res.push(s);                        // elsewhere: keep current
        });
        setBuffer(res.join("\n"));
        renderDiff();
      };
    });
  }
  async function toggleDiff() {
    if (diffOn) { hideDiff(); return; }
    diffOn = true;
    diffFab.classList.add("active");
    findPop.classList.add("hidden");
    fab.classList.add("hidden");   // hide the find button while diffing
    await renderDiff();
    if (diffOn) edDiff.classList.remove("hidden");
  }
  diffFab.onclick = toggleDiff;

  // Any edit updates the tab buffer, flags dirty, and schedules an auto-save.
  function onEdit() {
    if (diffOn) hideDiff(); // editing exits the (now stale) diff view
    tab.content = area.value;
    updateActiveTabMark();
    refresh();
    scheduleSave(tab.rel);
  }
  area.addEventListener("input", onEdit);
  area.addEventListener("scroll", () => {
    hl.scrollTop = area.scrollTop;
    hl.scrollLeft = area.scrollLeft;
  });
  // Caret moves that aren't edits (click, arrows, selection) update the readout.
  ["keyup", "click", "select", "focus"].forEach((ev) => area.addEventListener(ev, updatePos));
  area.addEventListener("keydown", (ev) => {
    if (ev.key === "Tab") {
      ev.preventDefault();
      const s = area.selectionStart, e = area.selectionEnd;
      area.value = area.value.slice(0, s) + "  " + area.value.slice(e);
      area.selectionStart = area.selectionEnd = s + 2;
      onEdit();
    }
  });

  // --- Find & replace (floating 🔍 button toggles the popover) ---
  const findPop = $("#edFindPop");
  fab.onclick = () => {
    const hidden = findPop.classList.toggle("hidden");
    if (!hidden) { const fi = $("#edFindI"); fi.focus(); fi.select(); }
  };
  $("#edFindClose").onclick = () => findPop.classList.add("hidden");
  let matches = [], curMatch = -1;
  function updateFindCount() {
    $("#edFindCount").textContent = `${matches.length ? curMatch + 1 : 0}/${matches.length}`;
  }
  function findMatches() {
    const q = $("#edFindI").value;
    matches = [];
    if (q) {
      const hay = area.value.toLowerCase(), needle = q.toLowerCase();
      let i = hay.indexOf(needle);
      while (i >= 0) { matches.push(i); i = hay.indexOf(needle, i + Math.max(1, needle.length)); }
    }
    if (curMatch >= matches.length) curMatch = matches.length - 1;
    updateFindCount();
  }
  function scrollToOffset(off) {
    const line = area.value.slice(0, off).split("\n").length; // 1-based
    const lh = 12.5 * 1.5;
    area.scrollTop = Math.max(0, (line - 3) * lh);
    area.dispatchEvent(new Event("scroll"));
  }
  function selectCurrent(focus) {
    if (curMatch < 0 || !matches.length) return;
    const q = $("#edFindI").value, s = matches[curMatch];
    if (focus) area.focus();
    area.setSelectionRange(s, s + q.length);
    scrollToOffset(s);
    updateFindCount();
  }
  function gotoMatch(dir) {
    if (!matches.length) return;
    curMatch = (Math.max(0, curMatch) + dir + matches.length) % matches.length;
    selectCurrent(true);
  }
  $("#edFindI").addEventListener("input", () => {
    findMatches();
    curMatch = matches.length ? 0 : -1;
    updateFindCount();
    if (matches.length) selectCurrent(false);
  });
  $("#edNext").onclick = () => gotoMatch(1);
  $("#edPrev").onclick = () => gotoMatch(-1);
  $("#edRepl").onclick = () => {
    const q = $("#edFindI").value, rep = $("#edReplI").value;
    if (!q || curMatch < 0 || !matches.length) return;
    const s = matches[curMatch];
    area.value = area.value.slice(0, s) + rep + area.value.slice(s + q.length);
    onEdit();
    if (matches.length) { curMatch = curMatch % matches.length; selectCurrent(true); }
  };
  $("#edReplAll").onclick = () => {
    const q = $("#edFindI").value, rep = $("#edReplI").value;
    if (!q) return;
    area.value = area.value.replace(new RegExp(escapeRegExp(q), "gi"), () => rep);
    onEdit();
  };

  refresh();
}

function escapeHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Minimal, XSS-safe markdown → HTML for agent replies. Everything is HTML-
// escaped first, and only a fixed set of safe tags is emitted (pre/code/strong/
// em/br). Links are rendered as plain text (no anchors) so a model reply can
// never navigate the WebView or run script.
function renderInline(seg) {
  let s = escapeHtml(seg);
  s = s.replace(/`([^`\n]+)`/g, (m, c) => "<code>" + c + "</code>");
  s = s.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, "$1<em>$2</em>");
  s = s.replace(/^\s*#{1,6}\s+(.+)$/gm, "<strong>$1</strong>");
  s = s.replace(/^\s*[-*]\s+(.+)$/gm, "• $1");
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, "$1 ($2)");
  return s.replace(/\n/g, "<br>");
}
function renderMarkdown(src) {
  const parts = String(src == null ? "" : src).split("```");
  let html = "";
  for (let i = 0; i < parts.length; i++) {
    if (i % 2 === 1) {
      let code = parts[i];
      const nl = code.indexOf("\n");
      if (nl >= 0 && /^[a-z0-9+#.\-]*$/i.test(code.slice(0, nl).trim())) {
        code = code.slice(nl + 1); // drop the ```lang label line
      }
      html += '<pre class="md-pre"><code>' + escapeHtml(code.replace(/\s+$/, "")) + "</code></pre>";
    } else {
      html += renderInline(parts[i]);
    }
  }
  return html;
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

// --- Floating controls (menu / model picker / actions catch-all) ---------
function closeFabMenus() {
  const mm = $("#modelMenu"), am = $("#actionsMenu"), cm = $("#chatActionsMenu"), gm = $("#githubMenu"), xm = $("#ctxMenu");
  if (mm) mm.classList.add("hidden");
  if (am) am.classList.add("hidden");
  if (cm) cm.classList.add("hidden");
  if (gm) gm.classList.add("hidden");
  if (xm) xm.classList.add("hidden");
}
function positionFabMenu(menu, fab, align, vertical) {
  const r = fab.getBoundingClientRect();
  if (vertical === "up") { menu.style.bottom = (window.innerHeight - r.top + 6) + "px"; menu.style.top = "auto"; }
  else { menu.style.top = (r.bottom + 6) + "px"; menu.style.bottom = "auto"; }
  if (align === "right") { menu.style.right = (window.innerWidth - r.right) + "px"; menu.style.left = "auto"; }
  else { menu.style.left = r.left + "px"; menu.style.right = "auto"; }
}
// Keep a left-anchored menu on screen after its content (and width) are known.
function clampFabMenu(menu) {
  if (!menu.style.left || menu.style.left === "auto") return;
  const w = menu.offsetWidth;
  let left = parseFloat(menu.style.left) || 0;
  left = Math.max(8, Math.min(left, window.innerWidth - w - 8));
  menu.style.left = left + "px";
}
// --- model grouping (by provider, and OpenAI further by family) -------------
const PROVIDER_ORDER = ["anthropic", "deepseek", "openai"];
const PROVIDER_LABEL = { anthropic: "Anthropic", deepseek: "DeepSeek", openai: "OpenAI" };
// OpenAI ships a lot of ids; bucket them into recognizable families.
const OAI_FAMILY_ORDER = ["GPT-5", "o-series (reasoning)", "GPT-4.1", "GPT-4o", "GPT-4", "GPT-3.5", "Other"];
function modelProvider(m) { const i = m.indexOf("/"); return i < 0 ? "openai" : m.slice(0, i); }
function modelName(m) { const i = m.indexOf("/"); return i < 0 ? m : m.slice(i + 1); }
function openaiFamily(name) {
  const n = name.toLowerCase();
  if (/^o[0-9]/.test(n)) return "o-series (reasoning)";
  if (n.startsWith("gpt-5") || n.startsWith("chatgpt-5")) return "GPT-5";
  if (n.startsWith("gpt-4.1")) return "GPT-4.1";
  if (n.startsWith("gpt-4o") || n.startsWith("chatgpt")) return "GPT-4o";
  if (n.startsWith("gpt-4")) return "GPT-4";
  if (n.startsWith("gpt-3.5") || n.startsWith("gpt-3")) return "GPT-3.5";
  return "Other";
}
function titleCase(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }

// Model picker for a given role ("orchestrator" or "implementer"), anchored to
// the button that opened it. Models are grouped into collapsible provider
// sections (Anthropic / DeepSeek / OpenAI), and OpenAI is further split by
// family. Selecting sets that role and keeps the other.
async function openModelMenu(role, anchor) {
  const menu = $("#modelMenu");
  if (!menu.classList.contains("hidden") && menu._role === role) { menu.classList.add("hidden"); return; }
  closeFabMenus();
  menu._role = role;
  menu.innerHTML = `<div class="fab-item muted">Loading…</div>`;
  positionFabMenu(menu, anchor, "left");
  menu.classList.remove("hidden");
  let all = [], cur = "", meta = {};
  try {
    const [m, agg] = await Promise.all([call("session.meta"), call("models.aggregate")]);
    meta = m; all = agg.models || [];
    cur = (role === "implementer" ? m.implementer : m.orchestrator) || "";
  } catch (e) {}

  // sort within a group: most-recently-used first, then alphabetical by name
  const recent = getRecentModels(), rank = (m) => recent.indexOf(m);
  const bySort = (a, b) => {
    const ra = rank(a), rb = rank(b);
    if (ra < 0 && rb < 0) return modelName(a).localeCompare(modelName(b));
    if (ra < 0) return -1; if (rb < 0) return 1; return rb - ra;
  };
  const groups = {};
  for (const m of all) (groups[modelProvider(m)] || (groups[modelProvider(m)] = [])).push(m);
  for (const k in groups) groups[k].sort(bySort);
  const provKeys = [
    ...PROVIDER_ORDER.filter((p) => groups[p]),
    ...Object.keys(groups).filter((p) => !PROVIDER_ORDER.includes(p)).sort(),
  ];

  // Expanded sections. Open the current model's provider (+ family); if there's
  // only one provider, open it so there's no needless extra tap.
  const expanded = new Set();
  const curProv = cur ? modelProvider(cur) : provKeys[0];
  if (curProv) expanded.add("prov:" + curProv);
  if (provKeys.length === 1) expanded.add("prov:" + provKeys[0]);
  if (cur && modelProvider(cur) === "openai") expanded.add("fam:" + openaiFamily(modelName(cur)));

  const chip = (n, open) => `<span class="fm-meta">${n} ${open ? "▾" : "▸"}</span>`;
  const modelRow = (m) =>
    `<div class="fab-item model" data-model="${escAttr(m)}">${m === cur ? "● " : ""}${escapeHtml(modelName(m))}</div>`;

  function render() {
    const rows = [];
    if (role === "implementer") {
      rows.push(`<div class="fab-item" data-model="">${cur === "" ? "● " : ""}(single agent)</div>`);
    }
    if (!provKeys.length) {
      menu.innerHTML = rows.join("") +
        `<div class="fab-item muted">No models — add an API key in Settings.</div>`;
      clampFabMenu(menu); bind(); return;
    }
    for (const p of provKeys) {
      const list = groups[p], open = expanded.has("prov:" + p);
      rows.push(`<div class="fab-head tap" data-toggle="prov:${escAttr(p)}">` +
        `<span>${escapeHtml(PROVIDER_LABEL[p] || titleCase(p))}</span>${chip(list.length, open)}</div>`);
      if (!open) continue;
      if (p === "openai") {
        const fam = {};
        for (const m of list) (fam[openaiFamily(modelName(m))] || (fam[openaiFamily(modelName(m))] = [])).push(m);
        const famKeys = [
          ...OAI_FAMILY_ORDER.filter((f) => fam[f]),
          ...Object.keys(fam).filter((f) => !OAI_FAMILY_ORDER.includes(f)),
        ];
        for (const f of famKeys) {
          const fopen = expanded.has("fam:" + f);
          rows.push(`<div class="fab-subhead tap" data-toggle="fam:${escAttr(f)}">` +
            `<span>${escapeHtml(f)}</span>${chip(fam[f].length, fopen)}</div>`);
          if (fopen) rows.push(...fam[f].map(modelRow));
        }
      } else {
        rows.push(...list.map(modelRow));
      }
    }
    menu.innerHTML = rows.join("");
    clampFabMenu(menu);
    bind();
  }

  function bind() {
    menu.querySelectorAll("[data-toggle]").forEach((el) => {
      el.onclick = (ev) => {
        ev.stopPropagation();
        const k = el.getAttribute("data-toggle");
        expanded.has(k) ? expanded.delete(k) : expanded.add(k);
        render();
      };
    });
    menu.querySelectorAll("[data-model]").forEach((el) => {
      el.onclick = async () => {
        const chosen = el.getAttribute("data-model");
        const orchestrator = role === "implementer" ? (meta.orchestrator || "") : chosen;
        const implementer = role === "implementer" ? chosen : (meta.implementer || "");
        await call("session.setModels", { orchestrator, implementer });
        if (chosen) pushRecentModel(chosen);
        menu.classList.add("hidden");
        await refreshHeader();
        bubble((role === "implementer" ? "Implementer → " : "Model → ") + (chosen ? shortModel(chosen) : "single agent"), "sys");
      };
    });
  }

  render();
}
const ACTION_ITEMS = [
  { label: "Clear context", act: "clearContext" },
  { label: "Files", act: "files" },
  { label: "Diff", act: "diff" },
  { label: "Commit", act: "commit" },
  { label: "Push", act: "push" },
  { label: "Pull", act: "pull" },
];
function openActionsMenu() {
  const menu = $("#actionsMenu");
  if (!menu.classList.contains("hidden")) { menu.classList.add("hidden"); return; }
  closeFabMenus();
  menu.innerHTML = ACTION_ITEMS.map((a) => `<div class="fab-item" data-fabact="${a.act}">${a.label}</div>`).join("");
  positionFabMenu(menu, $("#actionsFab"), "right");
  menu.classList.remove("hidden");
  menu.querySelectorAll("[data-fabact]").forEach((el) => {
    el.onclick = () => { menu.classList.add("hidden"); (actions[el.getAttribute("data-fabact")] || (() => {}))(); };
  });
}
// Chat-relevant actions (context + guidelines), opened from the drawer's ⋯.
const CHAT_ACTION_ITEMS = [
  { label: "Clear context", act: "clearContext" },
  { label: "Guidelines", act: "guidelines" },
  { label: "View context", act: "viewContext" },
  { label: "Preview payload", act: "previewContext" },
  { label: "Attach files", act: "contextFiles" },
];
function openChatActionsMenu() {
  const menu = $("#chatActionsMenu");
  if (!menu.classList.contains("hidden")) { menu.classList.add("hidden"); return; }
  closeFabMenus();
  menu.innerHTML = CHAT_ACTION_ITEMS.map((a) => `<div class="fab-item" data-chatact="${a.act}">${a.label}</div>`).join("");
  positionFabMenu(menu, $("#chatActionsBtn"), "right");
  menu.classList.remove("hidden");
  menu.querySelectorAll("[data-chatact]").forEach((el) => {
    el.onclick = () => { menu.classList.add("hidden"); (actions[el.getAttribute("data-chatact")] || (() => {}))(); };
  });
}
// Composer context button: quick-attach editor files or the selection.
async function attachCtxFiles(rels) {
  const uniq = [...new Set(rels)].filter(Boolean);
  for (const r of uniq) { try { await call("orch", { fn: "add_context_file", arg: r }); } catch (e) {} }
  refreshAttachBar(); refreshStats();
  bubble(`Attached ${uniq.length} file${uniq.length !== 1 ? "s" : ""} to context.`, "sys");
}
function insertSelectionIntoMessage() {
  const box = $("#input"); if (!box) return;
  composeOpen(false);
  const sel = _editorSelection;
  const ref = sel.rel ? `// from ${sel.rel}\n` : "";
  box.value = (box.value ? box.value + "\n\n" : "") + "```\n" + ref + sel.text + "\n```\n";
  box.dispatchEvent(new Event("input"));
  box.focus();
}
function openCtxMenu() {
  const menu = $("#ctxMenu");
  if (!menu.classList.contains("hidden")) { menu.classList.add("hidden"); return; }
  closeFabMenus();
  const items = [];
  if (activeTab) items.push({ label: "Attach current file", fn: () => attachCtxFiles([activeTab]) });
  if (openTabs.length > 1) items.push({ label: `Attach all open files (${openTabs.length})`, fn: () => attachCtxFiles(openTabs.map((t) => t.rel)) });
  if (_editorSelection.text && _editorSelection.text.trim()) items.push({ label: "Insert selection into message", fn: insertSelectionIntoMessage });
  items.push({ label: "Browse & pin files…", fn: () => actions.contextFiles() });
  menu.innerHTML = items.map((it, i) => `<div class="fab-item" data-ci="${i}">${escapeHtml(it.label)}</div>`).join("");
  positionFabMenu(menu, $("#ctxBtn"), "left", "up");
  clampFabMenu(menu);
  menu.classList.remove("hidden");
  menu.querySelectorAll("[data-ci]").forEach((el, idx) => { el.onclick = () => { menu.classList.add("hidden"); items[idx].fn(); }; });
}

// GitHub actions, opened from the top-bar GitHub button.
const GITHUB_ITEMS = [
  { label: "New repository", act: "newRepo" },
  { label: "Projects", act: "openProjects" },
  { label: "Delete repository", act: "deleteRepo" },
  //
  { label: "Switch / create branch", act: "switchBranch" },
  { label: "Commit (AI message)", act: "commit" },
  { label: "Pull", act: "pull" },
  { label: "Push", act: "push" },
  { label: "Merge → open PR", act: "createPR" },
  { header: "More" },
  { label: "Diff", act: "diff" },
  { label: "Start branch", act: "startBranch" },
  { label: "PR status", act: "prStatus" },
  { label: "Merge PR", act: "mergePR" },
  { label: "Clean up merged", act: "cleanupMerged" },
  { label: "Watch PR", act: "watchPr" },
  { label: "Build in cloud", act: "cloudBuild" },
  { label: "Build status", act: "buildStatus" },
  { label: "Fix CI build", act: "fixBuild" },
  { label: "Revert last commit", act: "revertLast" },
  { label: "Force push", act: "forcePush" },
];
function openGithubMenu() {
  const menu = $("#githubMenu");
  if (!menu.classList.contains("hidden")) { menu.classList.add("hidden"); return; }
  closeFabMenus(); (async () => {
    // Repo + branch are already live on the fab and subtitle bar — read them.
    const repoName = ($("#subRepo") && $("#subRepo").textContent) || "no repo";
    const branchName = ($("#subBranch") && $("#subBranch").textContent) || "?";
    // Header row showing current repo and branch.
    const headerHtml = `<div class="fab-head" style="pointer-events:none;opacity:0.7;font-size:13px">
      📁 ${escapeHtml(repoName)} &nbsp; 🌿 ${escapeHtml(branchName)}</div>`;
    menu.innerHTML = headerHtml + GITHUB_ITEMS.map((a) => a.header
      ? `<div class="fab-head">${escapeHtml(a.header)}</div>`
      : `<div class="fab-item" data-ghact="${a.act}">${a.label}</div>`).join("");
    positionFabMenu(menu, $("#githubFab"), "left");
    clampFabMenu(menu);
    menu.classList.remove("hidden");
    menu.querySelectorAll("[data-ghact]").forEach((el) => {
      el.onclick = () => { menu.classList.add("hidden"); (actions[el.getAttribute("data-ghact")] || (() => {}))(); };
    });
  })();
}

// --- Command palette (search box in the menu) ----------------------------
const ACTION_INDEX = [
  { label: "Make a game", act: "makeGame" },
  { label: "Blank project", act: "newProject" },
  { label: "Projects / sessions", act: "sessions" },
  { label: "Best practices", act: "bestPractices" },
  { label: "Guidelines", act: "guidelines" },
  { label: "Settings", act: "settings" },
  { label: "Open files", fn: () => openTree() },
  { label: "New file", fn: () => newFile() },
  { label: "Run app (external)", fn: () => call("run") },
  { label: "▶ Run & preview (inline)", fn: runScript },
  { label: "🖥 Toggle preview pane", fn: togglePreview },
  { label: "± Diff (uncommitted)", fn: showDiff },
  { label: "🧪 Check runtime errors", fn: showRuntimeErrors },
  { label: "📦 Quick-start templates", fn: showTemplates },
  { label: "Refresh map", act: "refreshMap" },
  { label: "Check web", act: "checkWeb" },
  { label: "Commit (AI message)", act: "commit" },
  { label: "Push", act: "push" },
  { label: "Pull", act: "pull" },
  { label: "New repository", act: "newRepo" },
  { label: "Projects", act: "openProjects" },
  { label: "Delete repository", act: "deleteRepo" },
  { label: "Merge → open PR", act: "createPR" },
  { label: "Diff (workspace)", act: "diff" },
  { label: "Start branch", act: "startBranch" },
  { label: "PR status", act: "prStatus" },
  { label: "Merge PR", act: "mergePR" },
  { label: "Clean up merged", act: "cleanupMerged" },
  { label: "Watch PR", act: "watchPr" },
  { label: "Build in cloud", act: "cloudBuild" },
  { label: "Build status", act: "buildStatus" },
  { label: "Fix CI build", act: "fixBuild" },
  { label: "Revert last commit", act: "revertLast" },
  { label: "Force push", act: "forcePush" },
  { label: "Clear context", act: "clearContext" },
  { label: "View context", act: "viewContext" },
  { label: "Preview payload", act: "previewContext" },
  { label: "Attach files", act: "contextFiles" },
  { label: "Trim context", act: "trimContext" },
  { label: "Compaction", act: "compaction" },
  { label: "Autocommit toggle", act: "autocommit" },
  { label: "Speak replies toggle", act: "speak" },
  { label: "Caveman toggle", act: "caveman" },
  { label: "Frugal toggle", act: "frugal" },
  { label: "Battery", act: "battery" },
  { label: "Update app", act: "updateApp" },
];
function runPaletteEntry(e) {
  closeSheet("#menu");
  if (e.fn) e.fn(); else (actions[e.act] || (() => {}))();
}
function renderPalette(q) {
  const results = $("#menuResults"), def = $("#menuDefault");
  q = (q || "").trim().toLowerCase();
  if (!q) { results.classList.add("hidden"); results.innerHTML = ""; def.classList.remove("hidden"); return; }
  def.classList.add("hidden"); results.classList.remove("hidden");
  const hits = ACTION_INDEX.filter((e) => e.label.toLowerCase().includes(q));
  results.innerHTML = hits.length
    ? hits.map((e, i) => `<div class="palette-item" data-pi="${i}">${escapeHtml(e.label)}</div>`).join("")
    : `<div class="hint">No matching action.</div>`;
  results.querySelectorAll("[data-pi]").forEach((el, idx) => { el.onclick = () => runPaletteEntry(hits[idx]); });
}

// --- Inline preview pane ---------------------------------------------------
// A resizable preview frame embedded in the main UI, below the workspace.
// It loads the Python/static web server so you can test code without leaving
// the main screen. Opens automatically after a run completes if the project
// has an index.html or app.py, and can be toggled manually with the 🖥 fab.

let _previewUrl = null;
let _previewActive = false;

function openPreview(url, label) {
  const pane = $("#previewPane");
  const body = $("#previewBody");
  const urlEl = $("#previewUrl");
  const fab = $("#previewFab");
  if (!pane || !body) return;
  if (url) _previewUrl = url;
  if (urlEl && label) urlEl.textContent = label || url || "Preview";
  if (_previewUrl) {
    body.innerHTML = `<iframe src="${escapeHtml(_previewUrl)}" allow="fullscreen; autoplay; microphone" loading="lazy"></iframe>`;
  } else {
    body.innerHTML = `<div class="preview-empty">Server not running</div>`;
  }
  pane.classList.remove("hidden");
  pane.classList.add("open");
  _previewActive = true;
  if (fab) { fab.classList.add("active"); fab.textContent = "🖥"; fab.title = "Close preview"; }
}

function closePreview() {
  const pane = $("#previewPane");
  const fab = $("#previewFab");
  if (pane) { pane.classList.remove("open", "active"); pane.classList.add("hidden");
    // Kill the iframe to stop audio/WebGL/CPU use when preview is hidden.
    const body = $("#previewBody");
    if (body) body.innerHTML = `<div class="preview-empty">Closed</div>`;
  }
  _previewActive = false;
  if (fab) { fab.classList.remove("active"); fab.textContent = "🖥"; fab.title = "Open preview"; }
}

async function togglePreview() {
  if (_previewActive) { closePreview(); return; }
  // Start the server if it hasn't been started yet.
  setStatus("Starting server…");
  try {
    const r = await call("py.call", { module: "localrun", fn: "start", args: [] });
    const url = (r.text || "").trim().split(" ")[0];
    if (url.startsWith("http")) {
      openPreview(url, r.text);
    } else {
      bubble("Preview server: " + r.text, "sys");
      openPreview(null, "Failed to start");
    }
  } catch (e) {
    bubble("Preview start failed: " + e.message, "sys");
    openPreview(null, "Start failed");
  }
  setStatus("");
}

async function refreshPreview() {
  const body = $("#previewBody");
  if (!body || !_previewUrl) return;
  const iframe = body.querySelector("iframe");
  if (iframe) { iframe.src = _previewUrl; return; }
  // If the iframe was removed (e.g. error state), re-create it.
  openPreview(_previewUrl);
}

// Start preview automatically after a code run if the project has a web entry.
async function maybeOpenPreview() {
  if (running) return;
  try {
    let files = [];
    try { files = JSON.parse((await call("orch", { fn: "browse_files" })).text) || []; } catch (e) {}
    const hasWeb = files.some((f) => f === "index.html" || f === "app.py" || f === "wsgi.py");
    if (!hasWeb) return;
    const r = await call("py.call", { module: "localrun", fn: "start", args: [] });
    const url = (r.text || "").trim().split(" ")[0];
    if (url.startsWith("http")) {
      openPreview(url, r.text);
      // Also do a runtime check and surface errors.
      let errCheck;
      try { errCheck = await call("web.runtimeCheck"); } catch (e) {}
      if (errCheck && errCheck.errors && errCheck.errors.length) {
        bubble("⚠️ The preview has runtime errors:\n" +
          errCheck.errors.slice(0, 12).map((e) => "• " + e).join("\n"), "sys");
        addFixRuntime(errCheck.errors);
      } else if (errCheck && errCheck.skipped === false) {
        // Only show success if we actually did a check.
      }
    }
  } catch (e) {
    // Server start may fail silently — that's fine, user can tap 🖥 to try.
  }
}

// --- Enhanced diff view: inline per-file or full project diff --------------
async function showDiff() {
  const r = await call("orch", { fn: "get_diff" });
  const text = r.text || "";
  if (!text || text === "(none)") {
    bubble("No uncommitted changes.", "sys");
    return;
  }
  modal("Uncommitted changes",
    `<pre class="filebody diff">${escapeHtml(text)}</pre>
     <div class="hint">Changes since the last commit. Tap Commit to save, or revert files.</div>
     <button class="pill" id="diffCommit" style="margin-top:10px">✓ Commit all</button>`);
  $("#diffCommit").onclick = async () => { closeSheet("#modal"); await runText("Commit", "agent.commit"); };
}

// --- Enhanced error surfacing --------------------------------------------
function showRuntimeErrors() {
  driveLive("Checking runtime errors…", async () => {
    let r;
    try { r = await call("web.runtimeCheck"); } catch (e) {
      bubble("Runtime check failed: " + e.message, "sys"); return;
    }
    if (r.skipped) { bubble("No web entry point (index.html) to check.", "sys"); return; }
    const errs = r.errors || [];
    if (!errs.length) { bubble("✓ No runtime errors from the preview.", "sys"); return; }
    bubble("⚠️ Runtime errors detected:\n" + errs.slice(0, 15).map((e) => "• " + e).join("\n"), "sys");
    addFixRuntime(errs);
  });
}

// --- Template shortcuts: quick-start templates for common project types -----
const QUICK_TEMPLATES = [
  { id: "blank", name: "Empty project", desc: "Blank workspace", act: "newProject" },
  { id: "web-game", name: "🎮 Web game (canvas)", desc: "HTML5 canvas game with input, loop, entities" },
  { id: "web-app", name: "🌐 Web app", desc: "index.html + app.js CSS starter" },
  { id: "python-web", name: "🐍 Python web app", desc: "Flask-like app.py with localrun support" },
  { id: "engine-3d", name: "🎲 3D game (engine)", desc: "Full 3D engine twin-stick shooter base" },
  { id: "chat-ui", name: "💬 Chat UI", desc: "Chat interface like this one" },
];

async function applyQuickTemplate(id) {
  if (id === "blank" || id === "newProject") { actions.newProject(); return; }
  // Every project lives on a repo — pick/create one, then apply the template.
  pickRepoThen(async (repoOrName, isNew) => {
    await startSessionOnRepo(repoOrName, isNew, id + "-" + Date.now().toString(36));
    const r = await call("orch", { fn: "apply_template", arg: id });
    bubble(r.text || "Template applied", "sys");
    setTimeout(() => maybeOpenPreview(), 1500);
  });
}

function showTemplates() {
  const rows = QUICK_TEMPLATES.map((t) =>
    `<div class="list-item" data-tpl="${escAttr(t.id)}">
       <span><b>${escapeHtml(t.name)}</b><div class="sub">${escapeHtml(t.desc)}</div></span></div>`
  ).join("");
  modal("Quick-start templates",
    rows + `<div class="hint">Creates a new session and applies the template. The agent sets up
     the boilerplate — you can then describe what to build.</div>`);
  $("#modalBody").querySelectorAll("[data-tpl]").forEach((el) => {
    el.onclick = () => { closeSheet("#modal"); applyQuickTemplate(el.dataset.tpl); };
  });
}

// --- Run generated script (Python or Node-like) ---------------------------
async function runScript() {
  // Check for a runnable entry point: app.py first, then index.html.
  try {
    const files = JSON.parse((await call("orch", { fn: "browse_files" })).text) || [];
    const hasAppPy = files.includes("app.py") || files.includes("wsgi.py");
    if (hasAppPy) {
      // Start the Python web server and open the preview.
      setStatus("Starting Python server…");
      const r = await call("py.call", { module: "localrun", fn: "start", args: [] });
      const url = (r.text || "").trim().split(" ")[0];
      if (url.startsWith("http")) {
        openPreview(url, r.text);
        bubble("Python app running at " + url, "sys");
      } else {
        bubble("Server start: " + r.text, "sys");
      }
      setStatus("");
      return;
    }
    const hasIndexHtml = files.includes("index.html");
    if (hasIndexHtml) {
      // Open preview for static web.
      const r = await call("py.call", { module: "localrun", fn: "start", args: [] });
      const url = (r.text || "").trim().split(" ")[0];
      if (url.startsWith("http")) {
        openPreview(url, r.text);
      } else {
        bubble("Preview start: " + r.text, "sys");
      }
      return;
    }
    bubble("No runnable entry found (need index.html or app.py).", "sys");
  } catch (e) {
    bubble("Script runner failed: " + e.message, "sys");
  }
}

// --- Wire up -------------------------------------------------------------
$("#menuFab").onclick = () => { closeFabMenus(); const s = $("#menuSearch"); if (s) s.value = ""; renderPalette(""); openSheet("#menu"); };
const _menuSearch = $("#menuSearch");
if (_menuSearch) _menuSearch.addEventListener("input", (e) => renderPalette(e.target.value));
$("#actionsFab").onclick = (e) => { e.stopPropagation(); openActionsMenu(); };
$("#githubFab").onclick = (e) => { e.stopPropagation(); openGithubMenu(); };
$("#playFab").onclick = async () => {
  closeFabMenus();
  const fab = $("#playFab");
  if (fab.classList.contains("running")) return;
  fab.classList.add("running");
  try { await call("run"); } catch (e) {}
  fab.classList.remove("running");
};
// Preview fab: toggle the inline preview pane.
$("#previewFab").onclick = togglePreview;
$("#previewClose").onclick = closePreview;
$("#previewRefresh").onclick = refreshPreview;
$("#modelLead").onclick = (e) => { e.stopPropagation(); openModelMenu("orchestrator", e.currentTarget); };
$("#modelImpl").onclick = (e) => { e.stopPropagation(); openModelMenu("implementer", e.currentTarget); };
$("#chatActionsBtn").onclick = (e) => { e.stopPropagation(); openChatActionsMenu(); };
$("#ctxBtn").onclick = (e) => { e.stopPropagation(); openCtxMenu(); };
document.addEventListener("click", (e) => {
  if (!e.target.closest(".fab") && !e.target.closest(".fabmenu") &&
      !e.target.closest("#chatActionsBtn") && !e.target.closest("#modelLead") &&
      !e.target.closest("#modelImpl") && !e.target.closest("#ctxBtn")) closeFabMenus();
});
$("#filesBtn").onclick = openTree;
$("#treeClose").onclick = closeTree;
$("#treeBackdrop").onclick = closeTree;
$("#newFileBtn").onclick = newFile;
const _advToggle = $("#advToggle");
if (_advToggle) _advToggle.onclick = () => {
  const hidden = $("#advSection").classList.toggle("hidden");
  _advToggle.textContent = hidden ? "Advanced ▾" : "Advanced ▴";
};
$("#chatFab").onclick = toggleChat;
$("#chatDrawerClose").onclick = closeChat;
$("#chatBackdrop").onclick = closeChat;
// Session panel (slides in from the left)
$("#sessionTab").onclick = toggleSessionPanel;
$("#sessionPanelClose").onclick = closeSessionPanel;
$("#sessionBackdrop").onclick = closeSessionPanel;
$("#sessionNewBtn").onclick = () => { closeSessionPanel(); actions.newProject(); };
const _sessionSearch = $("#sessionSearch");
if (_sessionSearch) _sessionSearch.addEventListener("input", (e) => renderSessionPanel(e.target.value));
initSessionSwipe();
document.querySelectorAll("[data-act]").forEach((b) => {
  b.onclick = () => { closeSheet("#menu"); (actions[b.dataset.act] || (() => {}))(); };
});
document.querySelectorAll("[data-close]").forEach((b) => {
  b.onclick = (e) => e.target.closest(".sheet").classList.add("hidden");
});
// --- Floating compose box (shared by Send / Speak / ❓) --------------------
// The bottom bar has no inline text field. First Send/Speak press opens the
// box; Send again submits its text; the ✕ cancels the message.
// Reserve space at the bottom of #chat equal to the floating compose box's
// footprint (it's position:absolute, so #chat doesn't otherwise know it's there),
// and keep the view pinned to the bottom so the last message stays clear of it.
function syncComposePad() {
  const drawer = $("#chatDrawer");
  if (!drawer || !drawer.classList.contains("composing")) return;
  const box = $("#composeBox");
  // composeBox sits 62px above the drawer bottom (over the composer bar); reserve
  // that plus its height plus a small gap.
  const pad = 62 + (box ? box.offsetHeight : 80) + 16;
  drawer.style.setProperty("--compose-pad", pad + "px");
  if (chat) chat.scrollTop = chat.scrollHeight;
}
function composeOpen(focus) {
  const b = $("#composeBox");
  if (b) b.classList.remove("hidden");
  if (focus !== false) { const i = $("#input"); if (i) i.focus(); }
  const drawer = $("#chatDrawer");
  if (drawer) drawer.classList.add("composing");
  syncComposePad();
}
function composeReset() {
  const i = $("#input");
  if (i) { i.value = ""; i.style.height = "auto"; }
  const b = $("#composeBox");
  if (b) b.classList.add("hidden");
  const drawer = $("#chatDrawer");
  if (drawer) { drawer.classList.remove("composing"); drawer.style.removeProperty("--compose-pad"); }
}
$("#composeClose").onclick = () => { stopDictation(); composeReset(); };
$("#sendBtn").onclick = () => {
  const t = $("#input").value.trim();
  if (!t) { composeOpen(true); return; }   // nothing pending → open the box
  stopDictation();
  composeReset();
  submit(t);
};
$("#askBtn").onclick = () => {
  const t = $("#input").value.trim();
  if (!t) { composeOpen(true); setStatus("Type a question, then tap ❓ again"); return; }
  stopDictation();
  composeReset();
  askEphemeral(t);
};
$("#input").addEventListener("input", (e) => {
  e.target.style.height = "auto";
  e.target.style.height = Math.min(e.target.scrollHeight, 200) + "px";
  syncComposePad();   // grow the reserved chat space with the textarea
});
const _usageChip = $("#usage");
if (_usageChip) _usageChip.onclick = showUsageDetail;
const _todosHead = $("#todos-head");
if (_todosHead) _todosHead.onclick = () => {
  const open = $("#todos").classList.toggle("open");
  $("#todos-chev").textContent = open ? "▾" : "▸";
};
$("#micBtn").onclick = () => {
  _dictating = !_dictating;
  $("#micBtn").textContent = _dictating ? "◼ Stop" : "Speak";
  if (_dictating) {
    composeOpen(false);   // voice shares the same box; no keyboard while talking
    _dictBase = $("#input").value.trim();
    setStatus("Listening… (tap ◼ to stop)");
    call("listen", { on: true });
  } else {
    setStatus("");
    call("listen", { on: false });
  }
};
$("#stopBtn").onclick = () => { $("#runlabel").textContent = "Stopping…"; call("orch", { fn: "interrupt" }); };
const _exRefresh = $("#explorerRefresh");
if (_exRefresh) _exRefresh.onclick = () => renderTree();
const _orchEffortSel = $("#orchEffortSelect");
if (_orchEffortSel) _orchEffortSel.onchange = onOrchEffortChange;
const _implEffortSel = $("#implEffortSelect");
if (_implEffortSel) _implEffortSel.onchange = onImplEffortChange;
// Boot
(async function () {
  try { await refreshHeader(); await loadHistory(); } catch (e) {}
  // If a run outlived the previous UI (backgrounded, rotated on an old build,
  // OTA reload), pick its progress back up instead of looking dead.
  try { if ((await call("run.active")).active) reattachLive(); } catch (e) {}
  // Text/URL shared into the app before the UI was ready.
  try { const sh = await call("shared.consume"); if (sh && sh.text) receiveShared(sh.text); } catch (e) {}
  try { updateCavemanLabel((await call("orch", { fn: "get_caveman" })).text.trim() === "1"); } catch (e) {}
  try { updateEffortSelect("orchEffortSelect", (await call("orch", { fn: "get_orch_effort" })).text.trim()); } catch (e) {}
  try { updateEffortSelect("implEffortSelect", (await call("orch", { fn: "get_impl_effort" })).text.trim()); } catch (e) {}
  try { updateAutocommitLabel((await call("orch", { fn: "get_autocommit" })).text.trim() === "1"); } catch (e) {}
  try { updateFrugalLabel((await call("orch", { fn: "get_frugal" })).text.trim() === "1"); } catch (e) {}
  try { updateAutodiagnoseLabel((await call("orch", { fn: "get_autodiagnose" })).text.trim() === "1"); } catch (e) {}
  try { updateAutocleanLabel((await call("orch", { fn: "get_autoclean" })).text.trim() === "1"); } catch (e) {}
  try { updateReviewLabel((await call("orch", { fn: "get_review" })).text.trim() === "1"); } catch (e) {}
  try { _routingOn = (await call("orch", { fn: "get_routing" })).text.trim() === "1"; updateRoutingLabel(_routingOn); } catch (e) {}
  updateSpeakLabel(autoSpeakOn());
})();
