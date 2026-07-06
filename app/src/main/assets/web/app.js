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
window.nativeEvent = (type, payload) => {
  if (type === "speech-final") {
    if (payload && payload.trim()) submit(payload.trim());
  } else if (type === "status") {
    setStatus(payload);
  }
};

// --- DOM helpers ---------------------------------------------------------
const $ = (s) => document.querySelector(s);
const chat = $("#chat");
function setStatus(t) { $("#status").textContent = t || ""; }

function bubble(text, kind) {
  const d = document.createElement("div");
  d.className = "bubble " + kind;
  d.textContent = text;
  chat.appendChild(d);
  chat.scrollTop = chat.scrollHeight;
  return d;
}

async function refreshHeader() {
  const m = await call("session.meta");
  $("#subtitle").textContent =
    (m.name || "session") + " • " + (m.activeRepo || "no repo") +
    " • " + (m.orchestrator || "default");
}

async function loadHistory() {
  chat.innerHTML = "";
  const r = await call("session.turns");
  (r.turns || []).forEach((t) => bubble(t.text, t.role === "user" ? "user" : "agent"));
}

// --- Submit (typed or spoken) -------------------------------------------
async function submit(task) {
  bubble(task, "user");
  setStatus("Thinking…");
  try {
    const r = await call("agent.run", { task });
    bubble(r.text || "(no output)", "agent");
    call("speak", { text: (r.text || "").split("\n")[0] });
  } catch (e) {
    bubble("Error: " + e.message, "agent");
  }
  setStatus("");
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
  const r = await call("fs.tree");
  const all = r.files || [];
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
    ? entries.map((e) => `<div class="filerow ${e.endsWith("/") ? "dir" : ""}" data-e="${e}">${e}</div>`).join("")
    : `<div class="hint">(empty)</div>`);
  modal("/" + path, body);
  $("#modalBody").querySelectorAll("[data-e]").forEach((el) => {
    el.onclick = () => {
      const e = el.dataset.e;
      if (e.endsWith("/")) filesModal(path + e);
      else showFile(path + e);
    };
  });
  const upEl = $("#modalBody").querySelector("[data-up]");
  if (upEl) upEl.onclick = () => {
    const t = path.replace(/\/$/, "");
    filesModal(t.includes("/") ? t.slice(0, t.lastIndexOf("/") + 1) : "");
  };
}

async function showFile(rel) {
  const r = await call("fs.read", { path: rel });
  modal(rel, `<pre class="filebody">${escapeHtml(r.content || "(empty)")}</pre>`);
}

function escapeHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// --- Wire up -------------------------------------------------------------
$("#menuBtn").onclick = () => openSheet("#menu");
$("#menu").querySelectorAll("[data-act]").forEach((b) => {
  b.onclick = () => { closeSheet("#menu"); (actions[b.dataset.act] || (() => {}))(); };
});
document.querySelectorAll("[data-close]").forEach((b) => {
  b.onclick = (e) => e.target.closest(".sheet").classList.add("hidden");
});
$("#sendBtn").onclick = () => {
  const t = $("#input").value.trim();
  if (t) { $("#input").value = ""; submit(t); }
};
$("#input").addEventListener("input", (e) => {
  e.target.style.height = "auto";
  e.target.style.height = Math.min(e.target.scrollHeight, 120) + "px";
});
$("#micBtn").onclick = () => { setStatus("Listening…"); call("listen"); };

// Boot
(async function () {
  try { await refreshHeader(); await loadHistory(); } catch (e) {}
  bubble("Ready. Type or tap 🎤 to speak a task.", "sys");
})();
