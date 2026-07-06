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

function bubble(text, kind, runId) {
  const d = document.createElement("div");
  d.className = "bubble " + kind;
  d.textContent = text;
  if (runId) {
    d.classList.add("tappable");
    d.onclick = () => openRun(runId);
  }
  chat.appendChild(d);
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
      bubble(t.text, t.role === "user" ? "user" : "agent", t.run_id || null));
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

async function runTask(task, mode) {
  running = true;
  bubble(task, "user");
  $("#runbar").classList.remove("hidden");
  $("#runlabel").textContent = mode === "plan" ? "Planning…" : "Working…";
  const live = document.createElement("div");
  live.className = "live";
  live.textContent = "Starting…";
  chat.appendChild(live);
  const lines = [];
  let cursor = 0, polling = true;

  (async function poll() {
    while (polling) {
      try {
        const r = JSON.parse((await call("orch", { fn: "get_events", arg: String(cursor) })).text);
        cursor = r.cursor;
        (r.events || []).forEach((e) => { lines.push(fmtEvent(e)); });
        if (lines.length) { live.textContent = lines.slice(-12).join("\n"); chat.scrollTop = chat.scrollHeight; }
      } catch (e) {}
      await new Promise((r) => setTimeout(r, 700));
    }
  })();

  try {
    await call("agent.run", { task, mode });
  } catch (e) {
    lines.push("Error: " + e.message);
  }
  polling = false;
  live.remove();
  await loadHistory();
  if (mode === "plan") addApprove();
  running = false;
  $("#runbar").classList.add("hidden");
  setStatus("");
  drainQueue();
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

// Live progress for an arbitrary agent call (e.g. plan approval).
async function driveLive(label, promiseFactory) {
  running = true;
  $("#runbar").classList.remove("hidden");
  $("#runlabel").textContent = label;
  const live = document.createElement("div");
  live.className = "live"; live.textContent = "Starting…";
  chat.appendChild(live);
  const lines = []; let cursor = 0, polling = true;
  (async function poll() {
    while (polling) {
      try {
        const r = JSON.parse((await call("orch", { fn: "get_events", arg: String(cursor) })).text);
        cursor = r.cursor;
        (r.events || []).forEach((e) => lines.push(fmtEvent(e)));
        if (lines.length) { live.textContent = lines.slice(-12).join("\n"); chat.scrollTop = chat.scrollHeight; }
      } catch (e) {}
      await new Promise((r) => setTimeout(r, 700));
    }
  })();
  try { await promiseFactory(); } catch (e) {}
  polling = false; live.remove(); await loadHistory();
  running = false; $("#runbar").classList.add("hidden"); drainQueue();
}

function fmtEvent(e) {
  switch (e.kind) {
    case "plan_start": return "🧠 Orchestrator planning…";
    case "plan_done": return "📋 Plan: " + (e.summary || "") + " (" + (e.files || []).length + " files)";
    case "round_start": return "── Round " + (e.round + 1) + ": " + (e.files || []).join(", ");
    case "impl_start": return "⚙️ implementer → " + e.path + "\n    " + (e.instruction || "").slice(0, 120);
    case "impl_reason": return "   💭 " + (e.reason || "").slice(0, 160);
    case "plan_reason": return "💭 " + (e.reason || "").slice(0, 160);
    case "impl_done": return "   ✓ " + e.path + " [" + e.status + "]";
    case "review_start": return "🔎 Orchestrator reviewing…";
    case "review_done": return "   review: " + e.status + (e.notes ? " — " + e.notes.slice(0, 120) : "");
    case "commit_start": return "💾 Committing…";
    case "done": return "✅ Committed " + (e.commit || "");
    case "interrupt": return "⏹ Interrupting…";
    default: return e.kind;
  }
}

async function openRun(runId) {
  let rec = {};
  try { rec = JSON.parse((await call("orch", { fn: "get_run", arg: String(runId) })).text); } catch (e) {}
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
  updateAgent() { runText("Update agent", "updateAgent"); },
  async updateUI() {
    bubble("Updating UI…", "sys");
    try { await call("updateUI"); } catch (e) { bubble("Update UI failed: " + e.message, "sys"); }
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
       <div class="hint">Trims the discussion sent each prompt using plain rules — turn caps,
       duplicate removal, per-turn truncation, and a char budget. Costs zero tokens.</div>`,
      async () => {
        const payload = {
          maxTurns: $("#maxTurns").value, codeTurns: $("#codeTurns").value,
          charBudget: $("#charBudget").value, perTurn: $("#perTurn").value,
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
      ? pinned.map((p) => `<div class="list-item" data-unpin="${p}"><span>${p}</span><span class="sub">tap to remove</span></div>`).join("")
      : `<div class="hint">No files attached.</div>`) +
      `<div class="hint">Add files from the Files screen (📌), so the model reads them as context.</div>`;
    modal("Attached files", body);
    $("#modalBody").querySelectorAll("[data-unpin]").forEach((el) => {
      el.onclick = async () => {
        await call("orch", { fn: "remove_context_file", arg: el.dataset.unpin });
        closeSheet("#modal"); refreshStats();
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
      const repo = s.activeRepo ? " ("+s.activeRepo+")" : "";
      return `<div class="list-item" data-sid="${s.id}"><span>${dot}${s.name}${repo}</span></div>`;
    }).join("");
    modal("Sessions", items +
      `<button class="pill ghost" id="newSess" style="margin-top:10px">New session</button>`);
    $("#modalBody").querySelectorAll("[data-sid]").forEach((el) => {
      el.onclick = async () => {
        await call("session.setActive", { id: el.dataset.sid });
        closeSheet("#modal"); await refreshHeader(); await loadHistory();
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
       <label>Agent branch (for OTA updates)</label><input id="br" type="text" value="${s.branch||""}" />`,
      async () => {
        await call("settings.save", {
          anthropicKey: $("#ak").value.trim(), deepseekKey: $("#dk").value.trim(),
          githubToken: $("#gt").value.trim(), leadModel: $("#lm").value.trim(),
          workerModel: $("#wm").value.trim(), branch: $("#br").value.trim(),
        });
        refreshHeader();
      });
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
        const pin = e.endsWith("/") ? "" : `<b data-pin="${path + e}" title="Attach to context"> 📌</b>`;
        return `<div class="filerow ${e.endsWith("/") ? "dir" : ""}"><span data-e="${e}">${e}</span>${pin}</div>`;
      }).join("")
    : `<div class="hint">(empty)</div>`);
  modal("/" + path, body);
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
      const r = await call("orch", { fn: "add_context_file", arg: el.dataset.pin });
      bubble(r.text, "sys");
      refreshStats();
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
  const u = bubble(q, "user"); u.classList.add("eph");
  setStatus("Thinking…");
  try {
    const r = await call("orch", { fn: "ask", arg: q });
    const a = bubble(r.text || "(no answer)", "agent"); a.classList.add("eph");
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
  try { updateCavemanLabel((await call("orch", { fn: "get_caveman" })).text.trim() === "1"); } catch (e) {}
  try { updateThinkingLabel((await call("orch", { fn: "get_thinking" })).text.trim() === "1"); } catch (e) {}
  bubble("Ready. Type or tap 🎤 to dictate a task.", "sys");
})();
