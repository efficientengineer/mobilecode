"""
orchestrator.py — the on-device agent brain.

Architecture:
  - Opus (Anthropic) is the LEAD/architect: it reads the task, inspects the
    repo, and produces a concrete plan of file edits.
  - DeepSeek V4 (Flash) is the WORKER/editor: it takes each planned edit and
    writes the actual file content, cheaply.

Everything runs on-device via Chaquopy. Git is handled by dulwich (pure Python,
no binary). Model calls go out over HTTPS via litellm.

IMPORTANT (Android constraint): the current working directory is read-only on
Android. All file writes MUST go under HOME. The Kotlin side passes us a
workspace path inside app storage; we never write with bare filenames.
"""

import os
import json
import traceback
import urllib.request
import urllib.error
from pathlib import Path

from dulwich import porcelain
from dulwich.repo import Repo


# --- Model configuration -------------------------------------------------

# Model strings carry a "<provider>/<model>" prefix so _call can route to the
# right API. Adjust if provider names change.
#
# LEAD_MODEL is the orchestrator/planner. WORKER_MODEL is the implementer/editor
# and is OPTIONAL: if it's blank, the orchestrator does the edits itself
# (single-agent mode). The (cheap) implementer also writes commit messages.
LEAD_MODEL = os.environ.get("LEAD_MODEL", "anthropic/claude-opus-4-8")
WORKER_MODEL = os.environ.get("WORKER_MODEL", "deepseek/deepseek-chat")


def _impl_model() -> str:
    """The implementer model, falling back to the orchestrator when unset."""
    w = (WORKER_MODEL or "").strip()
    return w if w else LEAD_MODEL


# Reasoning captured from the most recent _call (read right after calling).
_LAST_REASON = ""


def _thinking_on() -> bool:
    return os.environ.get("AGENT_THINKING", "0") == "1"


def set_thinking(flag="1") -> str:
    on = str(flag) in ("1", "true", "on")
    os.environ["AGENT_THINKING"] = "1" if on else "0"
    return "Thinking capture " + ("on" if on else "off")


def get_thinking(_=None) -> str:
    return "1" if _thinking_on() else "0"

# Keys are injected by the Kotlin layer into the environment before we run.
# (For a public app they come from the user's own settings, never hardcoded.)
#   ANTHROPIC_API_KEY, DEEPSEEK_API_KEY


# --- Utilities -----------------------------------------------------------

def _workspace() -> Path:
    """The writable repo root inside app storage. Set by Kotlin via env."""
    ws = os.environ.get("AGENT_WORKSPACE")
    if not ws:
        # Fallback to HOME so we never touch the read-only CWD.
        ws = os.path.join(os.environ.get("HOME", "/tmp"), "workspace")
    Path(ws).mkdir(parents=True, exist_ok=True)
    return Path(ws)


def _list_repo_files(root: Path, max_files: int = 60) -> list[str]:
    """A shallow view of the repo so the lead model has context."""
    files = []
    for p in root.rglob("*"):
        if ".git" in p.parts or ".agent" in p.parts:
            continue
        if p.name in ("meta.json", "transcript.jsonl"):
            continue
        if p.is_file():
            files.append(str(p.relative_to(root)))
        if len(files) >= max_files:
            break
    return files


def _read_file(root: Path, rel: str) -> str:
    fp = root / rel
    if fp.exists() and fp.is_file():
        try:
            return fp.read_text(encoding="utf-8", errors="replace")
        except Exception:
            return ""
    return ""


def _write_file(root: Path, rel: str, content: str) -> None:
    """Write under the workspace root only — never a bare filename."""
    fp = root / rel
    fp.parent.mkdir(parents=True, exist_ok=True)
    fp.write_text(content, encoding="utf-8")


# --- LLM calls -----------------------------------------------------------

def _http_post_json(url: str, headers: dict, payload: dict) -> dict:
    """Minimal JSON POST using the stdlib — no third-party HTTP deps.

    litellm can't be bundled by Chaquopy (it pulls native/Rust deps like
    fastuuid and tiktoken that lack Android wheels), so we talk to each
    provider's HTTP API directly.
    """
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(url, data=data, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"HTTP {e.code} from {url}: {body}") from e


def _call(model: str, system: str, user: str, max_tokens: int = 4000) -> str:
    """Route a chat completion to the right provider based on the model prefix.

    Supports "anthropic/<model>" (Anthropic Messages API) and
    "deepseek/<model>" or any other "<provider>/<model>" that speaks the
    OpenAI-compatible chat/completions schema (DeepSeek does).
    """
    global _LAST_REASON
    _LAST_REASON = ""
    provider, _, model_name = model.partition("/")
    if not model_name:
        provider, model_name = "openai", model

    if provider == "anthropic":
        key = os.environ.get("ANTHROPIC_API_KEY", "")
        payload = {
            "model": model_name,
            "max_tokens": max_tokens,
            "system": system,
            "messages": [{"role": "user", "content": user}],
        }
        if _thinking_on():
            payload["thinking"] = {"type": "adaptive", "display": "summarized"}
        result = _http_post_json(
            "https://api.anthropic.com/v1/messages",
            {
                "x-api-key": key,
                "anthropic-version": "2023-06-01",
                "content-type": "application/json",
            },
            payload,
        )
        parts = result.get("content", [])
        _LAST_REASON = "".join(
            p.get("thinking", "") for p in parts if p.get("type") == "thinking")
        return "".join(p.get("text", "") for p in parts if p.get("type") == "text")

    # OpenAI-compatible providers (DeepSeek, etc.)
    bases = {"deepseek": "https://api.deepseek.com"}
    keys = {"deepseek": "DEEPSEEK_API_KEY"}
    base = bases.get(provider, "https://api.openai.com")
    key = os.environ.get(keys.get(provider, "OPENAI_API_KEY"), "")
    result = _http_post_json(
        f"{base}/v1/chat/completions",
        {
            "Authorization": f"Bearer {key}",
            "content-type": "application/json",
        },
        {
            "model": model_name,
            "max_tokens": max_tokens,
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
        },
    )
    msg = result["choices"][0]["message"]
    _LAST_REASON = msg.get("reasoning_content", "") or ""
    return msg["content"]


def _plan_with_lead(task: str, root: Path) -> dict:
    """Opus reads the task + repo and returns a JSON plan of edits."""
    file_list = _list_repo_files(root)
    system = (
        "You are a coding agent that can either just talk OR make file "
        "changes. Decide which the user actually wants. Respond ONLY with "
        "JSON, no prose, no markdown fences. Schema: "
        "{\"mode\": \"chat\" | \"edit\", \"reply\": str, \"summary\": str, "
        "\"edits\": [{\"path\": str, \"instruction\": str}]}. "
        "Use mode \"chat\" for greetings, questions, discussion, or anything "
        "that does not clearly ask you to create or modify files — put your "
        "natural-language answer in \"reply\" and leave \"edits\" empty; do "
        "NOT create files just to respond. Use mode \"edit\" ONLY when the "
        "user is asking you to create or change code/files — set \"summary\" "
        "and one \"edit\" per file. When in doubt, prefer \"chat\". "
        "Persistent project notes, instructions, or things to remember belong "
        "in a file named guidelines.md (create or update it)."
    )
    mode = os.environ.get("AGENT_MODE", "auto").strip().lower()
    context = _full_context(task, mode).strip()
    context_block = f"{context}\n\n" if context else ""
    nudge = ("The user explicitly requested file changes — use mode \"edit\" "
             "and produce concrete edits.\n\n") if mode in ("code", "plan") else ""
    user = (
        nudge +
        context_block +
        f"TASK:\n{task}\n\n"
        f"EXISTING FILES ({len(file_list)}):\n" + "\n".join(file_list)
    )
    raw = _call(LEAD_MODEL, system, user)
    raw = raw.strip()
    # Strip accidental fences if the model added them.
    if raw.startswith("```"):
        raw = raw.split("```", 2)[1]
        if raw.startswith("json"):
            raw = raw[4:]
        raw = raw.strip("` \n")
    plan = json.loads(raw)
    plan["_reasoning"] = _LAST_REASON
    return plan


_SR_RE = None


def _sr_pattern():
    global _SR_RE
    if _SR_RE is None:
        import re as _r
        _SR_RE = _r.compile(
            r"<{5,}\s*SEARCH\s*\n(.*?)\n?={5,}\s*\n(.*?)\n?>{5,}\s*REPLACE",
            _r.S)
    return _SR_RE


def _strip_fence(text: str) -> str:
    t = text.strip()
    if t.startswith("```"):
        lines = t.split("\n")
        if lines and lines[0].startswith("```"):
            lines = lines[1:]
        if lines and lines[-1].strip() == "```":
            lines = lines[:-1]
        t = "\n".join(lines)
    return t


def _apply_sr_blocks(current: str, text: str):
    """Apply SEARCH/REPLACE blocks. Returns (new_text, applied, total) or None."""
    blocks = _sr_pattern().findall(text)
    if not blocks:
        return None
    new = current
    applied = 0
    for search, replace in blocks:
        if search.strip() == "":
            new = (new + ("\n" if new and not new.endswith("\n") else "")) + replace
            applied += 1
        elif search in new:
            new = new.replace(search, replace, 1)
            applied += 1
    return new, applied, len(blocks)


def _edit_with_worker(edit: dict, root: Path) -> dict:
    """Implementer edits one file via SEARCH/REPLACE diff blocks.

    Returns a structured handoff record for the review loop and insight UI.
    """
    path = edit["path"]
    instruction = edit["instruction"]
    current = _read_file(root, path)
    is_new = not current
    system = (
        "You are the implementer. Make the requested change to ONE file using "
        "SEARCH/REPLACE blocks, so only changed regions are emitted. Format each "
        "block EXACTLY as:\n"
        "<<<<<<< SEARCH\n<exact existing lines>\n=======\n<replacement lines>\n"
        ">>>>>>> REPLACE\n"
        "The SEARCH text must match the current file exactly. Use multiple "
        "blocks for multiple regions. For a NEW file or a full rewrite, use one "
        "block with an EMPTY search section (the replace section is the whole "
        "file). Output ONLY blocks, no prose, no fences."
    )
    user = (
        f"FILE: {path}\n\n"
        f"CURRENT CONTENTS:\n{current if current else '(new file)'}\n\n"
        f"INSTRUCTION:\n{instruction}"
    )
    output = _call(_impl_model(), system, user).strip()
    reason = _LAST_REASON

    parsed = _apply_sr_blocks(current or "", output)
    if parsed is None:
        # No blocks — treat the whole response as the file body (fallback).
        new = _strip_fence(output)
        _write_file(root, path, new + ("" if new.endswith("\n") else "\n"))
        status = "rewrite"
        applied, total = 1, 1
    else:
        new, applied, total = parsed
        _write_file(root, path, new)
        status = "new" if is_new else ("ok" if applied == total else "partial")
    return {
        "path": path,
        "instruction": instruction,
        "output": output,
        "reasoning": reason,
        "status": status,
        "applied": applied,
        "total": total,
    }


def _commit_message(summary: str, changed: list) -> str:
    """Have the cheap implementer model write a concise commit message.

    Falls back to the plan summary if the model call fails, so a commit is
    never blocked on message generation.
    """
    try:
        system = (
            "Write a single-line git commit message (max 72 chars) in the "
            "imperative mood for the described change. Output ONLY the message, "
            "no quotes, no prose, no trailing period."
        )
        files = "\n".join(f"  - {c}" for c in changed) or "  (none)"
        user = f"CHANGE:\n{summary}\n\nFILES CHANGED:\n{files}"
        msg = _call(_impl_model(), system, user, max_tokens=60).strip()
        msg = msg.splitlines()[0].strip().strip('"').strip()
        return msg or summary
    except Exception:
        return summary


def _commit(root: Path, message: str) -> str:
    """Stage all changes and commit via dulwich."""
    git_dir = root / ".git"
    if not git_dir.exists():
        porcelain.init(str(root))
    # Stage everything that isn't in .git, the agent's .agent dir, or app meta
    for p in root.rglob("*"):
        if ".git" in p.parts or ".agent" in p.parts or not p.is_file():
            continue
        if p.name in ("meta.json", "transcript.jsonl"):
            continue
        porcelain.add(str(root), paths=[str(p)])
    commit_id = porcelain.commit(
        str(root),
        message=message.encode(),
        author=b"Voice Agent <agent@device.local>",
        committer=b"Voice Agent <agent@device.local>",
    )
    return commit_id.decode() if isinstance(commit_id, bytes) else str(commit_id)


# --- Project context: memory, outline, discussion, caveman ---------------

import re as _re


def _agent_dir(root: Path = None) -> Path:
    d = (root or _workspace()) / ".agent"
    d.mkdir(parents=True, exist_ok=True)
    return d


def _discussion_file(root: Path = None) -> Path:
    return _agent_dir(root) / "discussion.jsonl"


def _outline_file(root: Path = None) -> Path:
    return _agent_dir(root) / "outline.md"


def _caveman_on() -> bool:
    return os.environ.get("AGENT_CAVEMAN", "0") == "1" or (_agent_dir() / "caveman").exists()


# Conservative filler set: articles, auxiliaries, politeness, and connectors.
# Content words and pronouns are kept so meaning survives.
_FILLER = {
    "a", "an", "the", "is", "are", "am", "was", "were", "be", "been", "being",
    "to", "of", "for", "please", "kindly", "just", "really", "very", "that",
    "this", "so", "then", "and", "but", "with", "as", "at", "in", "on",
    "would", "could", "should", "will", "shall", "do", "does", "did",
}


def _caveman(text: str) -> str:
    if not text:
        return text
    def strip_line(line: str) -> str:
        toks = _re.findall(r"[A-Za-z']+|[^A-Za-z'\s]", line)
        out = [t for t in toks if t.lower() not in _FILLER]
        return " ".join(out)
    return "\n".join(strip_line(l) for l in text.splitlines())


def _append_discussion(role: str, text: str, run_id: str = "") -> None:
    idx = len(_read_discussion())
    rec = {"id": idx, "role": role, "text": text, "cave": _caveman(text),
           "run_id": run_id}
    with open(_discussion_file(), "a", encoding="utf-8") as f:
        f.write(json.dumps(rec) + "\n")


def _read_discussion() -> list:
    fp = _discussion_file()
    if not fp.exists():
        return []
    out = []
    for line in fp.read_text(encoding="utf-8").splitlines():
        try:
            out.append(json.loads(line))
        except Exception:
            pass
    return out


def _memory(root: Path = None):
    """The project guidelines file (guidelines.md, falling back to CLAUDE.md)."""
    root = root or _workspace()
    for name in ("guidelines.md", "CLAUDE.md"):
        c = _read_file(root, name)
        if c:
            return name, c
    return "guidelines.md", ""


# --- deterministic (no-LLM) context compaction ---------------------------
# All knobs are plain numbers; changing them costs zero tokens. Defaults are
# tuned to keep recent context useful while capping the payload.
_COMPACT_DEFAULTS = {
    "maxTurns": 12,       # hard cap on discussion turns kept (any mode)
    "codeTurns": 6,       # tighter cap in code/plan modes (outline carries state)
    "charBudget": 6000,   # total char budget for the discussion block
    "perTurn": 800,       # truncate any single turn longer than this
}


def _compact_settings() -> dict:
    fp = _agent_dir() / "compaction.json"
    s = dict(_COMPACT_DEFAULTS)
    if fp.exists():
        try:
            s.update({k: int(v) for k, v in json.loads(fp.read_text()).items()
                      if k in _COMPACT_DEFAULTS})
        except Exception:
            pass
    return s


def get_compaction(_=None) -> str:
    return json.dumps(_compact_settings())


def set_compaction(arg="") -> str:
    try:
        kw = json.loads(arg) if isinstance(arg, str) else dict(arg or {})
    except Exception:
        return "Bad compaction payload"
    s = _compact_settings()
    for k, v in kw.items():
        if k in _COMPACT_DEFAULTS:
            try:
                s[k] = max(0, int(v))
            except Exception:
                pass
    (_agent_dir() / "compaction.json").write_text(json.dumps(s), encoding="utf-8")
    return "Compaction settings saved"


def _clip_turn(text: str, limit: int) -> str:
    """Keep head+tail of an over-long turn so both intent and outcome survive."""
    if limit <= 0 or len(text) <= limit:
        return text
    head = limit * 2 // 3
    tail = limit - head
    return text[:head] + " …[clipped]… " + text[-tail:]


def _compact_discussion(mode: str = "") -> list:
    """Select + squeeze recent turns deterministically (no model calls).

    Techniques: turn cap (mode-aware), drop consecutive duplicates, per-turn
    truncation, and a total char budget applied newest-first.
    """
    s = _compact_settings()
    cap = s["codeTurns"] if mode in ("code", "plan") else s["maxTurns"]
    disc = _read_discussion()
    cave = _caveman_on()

    # 1) newest-first, cap the count
    picked = disc[-cap:] if cap > 0 else []

    # 2) drop consecutive duplicate turns (same role + same text)
    deduped = []
    for d in picked:
        key = (d.get("role"), d.get("text", ""))
        if deduped and (deduped[-1].get("role"), deduped[-1].get("text", "")) == key:
            continue
        deduped.append(d)

    # 3) per-turn truncation + 4) total char budget (drop oldest first)
    rendered, used = [], 0
    for d in reversed(deduped):  # newest first for budgeting
        body = _clip_turn(d.get("cave" if cave else "text", ""), s["perTurn"])
        line = f"{d['role']}: {body}"
        if s["charBudget"] and used + len(line) > s["charBudget"] and rendered:
            break
        rendered.append(line)
        used += len(line)
    rendered.reverse()
    return rendered


def _full_context(task_hint: str = "", mode: str = "") -> str:
    """Assemble the per-prompt context: guidelines + outline + attached + discussion."""
    root = _workspace()
    parts = []
    mem_name, mem = _memory(root)
    if mem:
        parts.append(f"PROJECT GUIDELINES ({mem_name}):\n" + mem)
    outline = _outline_file(root)
    if outline.exists():
        parts.append("PROJECT OUTLINE:\n" + outline.read_text(encoding="utf-8"))
    try:
        pinned = json.loads(list_context_files())
    except Exception:
        pinned = []
    att = []
    for p in pinned:
        c = _read_file(root, p)
        if c:
            att.append(f"### {p}\n{c[:6000]}")
    if att:
        parts.append("ATTACHED FILES (the user asked you to read these):\n" +
                     "\n\n".join(att))
    lines = _compact_discussion(mode)
    if lines:
        parts.append("DISCUSSION SO FAR:\n" + "\n".join(lines))
    return "\n\n".join(parts)


# --- op targets (called from the web via agent_loader.op) ----------------

def get_discussion(_=None) -> str:
    """JSON {turns:[{id,role,text,run_id}]} of the original (display) messages."""
    turns = [{"id": d.get("id", i), "role": d["role"], "text": d.get("text", ""),
              "run_id": d.get("run_id", "")}
             for i, d in enumerate(_read_discussion())]
    return json.dumps({"turns": turns})


def clear_discussion(_=None) -> str:
    fp = _discussion_file()
    if fp.exists():
        fp.unlink()
    return "Context cleared"


def trim_discussion(keep="10") -> str:
    try:
        k = int(str(keep))
    except Exception:
        k = 10
    fp = _discussion_file()
    if not fp.exists():
        return "Nothing to trim"
    lines = fp.read_text(encoding="utf-8").splitlines()
    if len(lines) > k:
        fp.write_text("\n".join(lines[-k:]) + "\n", encoding="utf-8")
    return f"Trimmed to last {k} turns"


def context_counts(_=None) -> str:
    outline = _outline_file()
    o = outline.read_text(encoding="utf-8") if outline.exists() else ""
    cave = _caveman_on()
    disc = _read_discussion()
    mode = os.environ.get("AGENT_MODE", "auto").strip().lower()
    # Effective (compacted) discussion — what is actually sent this turn.
    eff_lines = _compact_discussion(mode)
    d = "\n".join(eff_lines)
    _, mem = _memory()

    def toks(s):
        return len(s) // 4
    return json.dumps({
        "outlineChars": len(o), "outlineTokens": toks(o),
        "discussionChars": len(d), "discussionTokens": toks(d),
        "memoryTokens": toks(mem), "turns": len(disc),
        "sentTurns": len(eff_lines), "caveman": cave,
    })


def set_caveman(flag="1") -> str:
    on = str(flag) in ("1", "true", "True", "on")
    marker = _agent_dir() / "caveman"
    if on:
        marker.write_text("1")
    elif marker.exists():
        marker.unlink()
    os.environ["AGENT_CAVEMAN"] = "1" if on else "0"
    return "Caveman mode " + ("on" if on else "off")


def get_caveman(_=None) -> str:
    return "1" if _caveman_on() else "0"


# --- Attached context files ("files for the model to look at") -----------

def _ctx_files_path() -> Path:
    return _agent_dir() / "context_files.json"


def list_context_files(_=None) -> str:
    fp = _ctx_files_path()
    if fp.exists():
        try:
            return fp.read_text(encoding="utf-8")
        except Exception:
            pass
    return "[]"


def add_context_file(path="") -> str:
    path = str(path).strip()
    if not path:
        return "no path"
    try:
        lst = json.loads(list_context_files())
    except Exception:
        lst = []
    if path not in lst:
        lst.append(path)
        _ctx_files_path().write_text(json.dumps(lst), encoding="utf-8")
        return f"Attached {path}"
    return f"{path} already attached"


def remove_context_file(path="") -> str:
    try:
        lst = json.loads(list_context_files())
    except Exception:
        lst = []
    lst = [p for p in lst if p != str(path)]
    _ctx_files_path().write_text(json.dumps(lst), encoding="utf-8")
    return f"Removed {path}"


# --- File browser (shows .agent/ so you can see outline.md etc.) ----------

def browse_files(_=None) -> str:
    """All workspace files EXCEPT .git and app metadata. Includes .agent/*."""
    root = _workspace()
    files = []
    for p in sorted(root.rglob("*")):
        if ".git" in p.parts:
            continue
        if p.name in ("meta.json", "transcript.jsonl"):
            continue
        if p.is_file():
            files.append(str(p.relative_to(root)))
    return json.dumps(files)


def read_ws_file(path="") -> str:
    fp = _workspace() / str(path)
    if fp.exists() and fp.is_file():
        try:
            return fp.read_text(encoding="utf-8", errors="replace")
        except Exception:
            return ""
    return ""


def preview_context(_=None) -> str:
    """Exactly what gets sent to the model as context this turn."""
    mode = os.environ.get("AGENT_MODE", "auto").strip().lower()
    c = _full_context("", mode)
    return c if c else "(context is empty)"


def get_guidelines(_=None) -> str:
    """Current project guidelines text (for the editor)."""
    _, mem = _memory()
    return mem


def set_guidelines(text="") -> str:
    (_workspace() / "guidelines.md").write_text(str(text), encoding="utf-8")
    return "Guidelines saved"


def build_outline(_=None) -> str:
    """Read the project folder and (re)generate .agent/outline.md."""
    try:
        root = _workspace()
        files = _list_repo_files(root, max_files=120)
        snippets = []
        for f in files[:40]:
            c = _read_file(root, f)
            if c and len(c) < 4000:
                snippets.append(f"### {f}\n{c[:1500]}")
        system = ("You are documenting a software project. Produce a concise "
                  "outline in markdown covering: purpose, structure, key files, "
                  "and open TODOs. Output markdown only, no fences.")
        user = "FILES:\n" + "\n".join(files) + "\n\nSNIPPETS:\n" + "\n\n".join(snippets)
        md = _call(LEAD_MODEL, system, user, max_tokens=1500)
        _outline_file(root).write_text(md, encoding="utf-8")
        return f"Outline updated ({len(md)} chars)"
    except Exception:
        return "Outline failed:\n" + traceback.format_exc()


# --- Execution: events, interrupt, review loop, run records --------------

MAX_ROUNDS = 2


def _events_file() -> Path:
    return _agent_dir() / "run_events.jsonl"


def _emit(kind: str, **data) -> None:
    try:
        rec = {"kind": kind}
        rec.update(data)
        with open(_events_file(), "a", encoding="utf-8") as f:
            f.write(json.dumps(rec) + "\n")
    except Exception:
        pass


def _clear_events() -> None:
    try:
        f = _events_file()
        if f.exists():
            f.unlink()
    except Exception:
        pass


def get_events(cursor="0") -> str:
    """Return events with index > cursor (for live progress polling)."""
    try:
        c = int(str(cursor))
    except Exception:
        c = 0
    f = _events_file()
    lines = f.read_text(encoding="utf-8").splitlines() if f.exists() else []
    out = []
    for i in range(c, len(lines)):
        try:
            out.append(json.loads(lines[i]))
        except Exception:
            pass
    return json.dumps({"cursor": len(lines), "events": out})


def interrupt(_=None) -> str:
    os.environ["AGENT_INTERRUPT"] = "1"
    _emit("interrupt")
    return "Interrupting after the current step…"


def _interrupted() -> bool:
    return os.environ.get("AGENT_INTERRUPT", "0") == "1"


def _new_run_id() -> str:
    import time
    return str(int(time.time() * 1000))


def _begin_run() -> None:
    """Reset per-run state so events/interrupt start clean."""
    _clear_events()
    os.environ["AGENT_INTERRUPT"] = "0"


def _runs_dir() -> Path:
    d = _agent_dir() / "runs"
    d.mkdir(parents=True, exist_ok=True)
    return d


def get_run(run_id: str) -> str:
    """Return a stored run record (plan + handoffs + reviews) as JSON."""
    fp = _runs_dir() / f"{run_id}.json"
    return fp.read_text(encoding="utf-8") if fp.exists() else "{}"


def _review_with_lead(task: str, handoffs: list, root: Path) -> dict:
    """Orchestrator reviews what the implementers did and decides next step."""
    summaries = []
    for h in handoffs:
        summaries.append(
            f"FILE {h['path']} [{h['status']}]\nIMPLEMENTER OUTPUT:\n{h['output'][:2000]}")
    system = (
        "You are the orchestrator reviewing the implementers' work. Decide if "
        "the task is complete or needs another round. Respond ONLY with JSON: "
        "{\"status\": \"done\" | \"continue\", \"notes\": str, "
        "\"edits\": [{\"path\": str, \"instruction\": str}]}. Use \"done\" with "
        "empty edits when the task is satisfied; use \"continue\" with edits to "
        "fix or extend. Be strict but do not loop unnecessarily."
    )
    user = (f"TASK:\n{task}\n\nWHAT THE IMPLEMENTERS DID:\n" +
            "\n\n".join(summaries))
    try:
        raw = _strip_fence(_call(LEAD_MODEL, system, user, max_tokens=1500))
        return json.loads(raw)
    except Exception:
        return {"status": "done", "notes": "(review unavailable)", "edits": []}


def _run_edits(task: str, plan: dict, root: Path, run_id: str) -> str:
    """The orchestrator↔implementer feedback loop with live events."""
    rounds = []
    round_edits = plan.get("edits", [])
    interrupted = False

    for r in range(MAX_ROUNDS):
        if _interrupted():
            interrupted = True
            break
        _emit("round_start", round=r, files=[e.get("path") for e in round_edits])
        handoffs = []
        for e in round_edits:
            if _interrupted():
                interrupted = True
                break
            _emit("impl_start", round=r, path=e.get("path"), instruction=e.get("instruction"))
            try:
                res = _edit_with_worker(e, root)
            except Exception as ex:
                res = {"path": e.get("path"), "instruction": e.get("instruction"),
                       "output": f"ERROR: {ex}", "status": "error", "applied": 0, "total": 0}
            handoffs.append(res)
            if res.get("reasoning"):
                _emit("impl_reason", round=r, path=res["path"], reason=res["reasoning"][:500])
            _emit("impl_done", round=r, path=res["path"], status=res["status"])

        review = {"status": "done", "notes": "", "edits": []}
        if handoffs and not interrupted and r < MAX_ROUNDS - 1:
            _emit("review_start", round=r)
            review = _review_with_lead(task, handoffs, root)
            _emit("review_done", round=r, status=review.get("status"), notes=review.get("notes", ""))

        rounds.append({"round": r, "plan_summary": plan.get("summary", ""),
                       "plan_reasoning": plan.get("_reasoning", ""),
                       "handoffs": handoffs, "review": review})

        if interrupted or review.get("status") == "done" or not review.get("edits"):
            break
        round_edits = review["edits"]

    # Commit whatever was written.
    all_changed = [h["path"] for rd in rounds for h in rd["handoffs"]]
    summary = plan.get("summary", "(no summary)")
    _emit("commit_start")
    message = _commit_message(summary, all_changed)
    commit_id = _commit(root, message)[:8]
    _emit("done", commit=commit_id)

    # Persist the run record for the insight UI.
    try:
        (_runs_dir() / f"{run_id}.json").write_text(
            json.dumps({"task": task, "rounds": rounds, "commit": commit_id,
                        "message": message}), encoding="utf-8")
    except Exception:
        pass

    lines = []
    if interrupted:
        lines.append("Interrupted.")
    lines.append(f"Done: {summary}")
    files = sorted(set(all_changed))
    lines.append(f"Files changed: {len(files)}")
    lines += [f"  - {c}" for c in files]
    lines.append(f"Committed {commit_id}: {message}")
    return "\n".join(lines)


# --- Modes ---------------------------------------------------------------

def _chat_reply(task: str) -> str:
    """Plain conversational answer — no files, no commit."""
    context = _full_context(task, "chat")
    system = ("You are a helpful coding assistant. Answer conversationally and "
              "concisely. Do not create or modify files.")
    user = (f"{context}\n\n" if context else "") + "USER: " + task
    return _call(LEAD_MODEL, system, user)


def ask(task="") -> str:
    """Ephemeral question: answer using the current context but DO NOT record
    the question or the answer to the discussion. Lets the user check something
    without polluting (or paying to carry) future context."""
    try:
        q = str(task).strip()
        if not q:
            return "(empty question)"
        context = _full_context(q, "chat")
        system = ("You are a helpful coding assistant. Answer the user's side "
                  "question directly and concisely. Do not modify files. This "
                  "is a one-off question and will not be remembered.")
        user = (f"{context}\n\n" if context else "") + "QUESTION: " + q
        return _call(LEAD_MODEL, system, user)
    except Exception:
        return "Error answering question:\n" + traceback.format_exc()


def _plan_path() -> Path:
    return Path(os.environ.get("HOME", "/tmp")) / ".pending_plan.json"


def _format_plan(plan: dict) -> str:
    summary = plan.get("summary", "(plan)")
    edits = plan.get("edits", [])
    lines = ["PLAN: " + summary, ""]
    for i, e in enumerate(edits, 1):
        lines.append(f"{i}. {e.get('path','?')}")
        lines.append(f"   {e.get('instruction','')}")
    lines.append("")
    lines.append("Approve to build these changes, or refine the plan.")
    return "\n".join(lines)


def _execute_edits(plan: dict, root: Path) -> str:
    edits = plan.get("edits", [])
    summary = plan.get("summary", "(no summary)")
    changed = []
    for edit in edits:
        try:
            changed.append(_edit_with_worker(edit, root))
        except Exception as e:
            changed.append(f"{edit.get('path','?')} [FAILED: {e}]")
    message = _commit_message(summary, changed)
    commit_id = _commit(root, message)[:8]
    lines = [f"Done: {summary}", f"Files changed: {len(changed)}"]
    lines += [f"  - {c}" for c in changed]
    lines.append(f"Committed {commit_id}: {message}")
    return "\n".join(lines)


# --- Public entry point (called from Kotlin) -----------------------------

def run_task(task: str) -> str:
    """
    Handle one turn. Mode comes from env AGENT_MODE:
      chat  — just reply
      code  — always make changes
      plan  — produce a plan and stash it for approval (no writes)
      auto  — let the model decide chat vs edit (default)
    """
    try:
        root = _workspace()
        mode = os.environ.get("AGENT_MODE", "auto").strip().lower()
        _begin_run()
        _append_discussion("user", task)

        if mode == "chat":
            reply = _chat_reply(task)
            _append_discussion("agent", reply)
            return reply

        _emit("plan_start")
        plan = _plan_with_lead(task, root)
        edits = plan.get("edits", [])
        _emit("plan_done", summary=plan.get("summary", ""),
              files=[e.get("path") for e in edits])

        if mode == "plan":
            if not edits:
                result = plan.get("reply") or _chat_reply(task)
                _append_discussion("agent", result)
            else:
                try:
                    plan["task"] = task
                    _plan_path().write_text(json.dumps(plan))
                except Exception:
                    pass
                result = _format_plan(plan)
                _append_discussion("agent", result)
            return result

        if mode != "code" and (plan.get("mode") == "chat" or not edits):
            result = plan.get("reply") or plan.get("summary") or "(no reply)"
            _append_discussion("agent", result)
            return result

        if not edits:
            result = plan.get("reply") or "(nothing to change)"
            _append_discussion("agent", result)
            return result

        run_id = _new_run_id()
        result = _run_edits(task, plan, root, run_id)
        _append_discussion("agent", result, run_id=run_id)
        return result

    except Exception:
        return "Error during task:\n" + traceback.format_exc()


def execute_plan() -> str:
    """Build the previously-stashed plan (plan-mode approval)."""
    try:
        p = _plan_path()
        if not p.exists():
            return "No pending plan to approve."
        plan = json.loads(p.read_text())
        _begin_run()
        run_id = _new_run_id()
        result = _run_edits(plan.get("task", ""), plan, _workspace(), run_id)
        try:
            p.unlink()
        except Exception:
            pass
        _append_discussion("agent", result, run_id=run_id)
        return result
    except Exception:
        return "Approve failed:\n" + traceback.format_exc()


def commit_now() -> str:
    """Stage and commit the current workspace with an auto-written message.

    Triggered by the Commit button — independent of a task run.
    """
    try:
        root = _workspace()
        if not (root / ".git").exists():
            porcelain.init(str(root))
        # Detect changed paths so we can (a) skip empty commits and (b) feed
        # the message generator.
        try:
            status = porcelain.status(str(root))
            changed = list(status.untracked)
            for kind in ("add", "delete", "modify"):
                changed += [
                    p.decode() if isinstance(p, bytes) else p
                    for p in status.staged.get(kind, [])
                ]
            changed += [
                p.decode() if isinstance(p, bytes) else p for p in status.unstaged
            ]
        except Exception:
            changed = []
        if not changed:
            return "Nothing to commit."
        message = _commit_message(f"Update {len(changed)} file(s)", changed)
        commit_id = _commit(root, message)[:8]
        return f"Committed {commit_id}: {message}"
    except Exception:
        return "Commit failed:\n" + traceback.format_exc()


# --- Local test harness (does NOT run on device) -------------------------
# Lets us exercise control flow here with a mock, no API keys needed.
if __name__ == "__main__":
    import sys
    if "--selftest" in sys.argv:
        # Monkeypatch the LLM calls with deterministic fakes.
        def fake_call(model, system, user, max_tokens=4000):
            if model == LEAD_MODEL:
                return json.dumps({
                    "summary": "Add a greeting module",
                    "edits": [
                        {"path": "greet.py",
                         "instruction": "Create a function hello() that prints hi"},
                    ],
                })
            else:
                return "def hello():\n    print('hi from agent')\n"
        globals()["_call"] = fake_call

        os.environ["AGENT_WORKSPACE"] = os.path.join(
            os.environ.get("HOME", "/tmp"), "selftest_ws")
        # clean slate
        import shutil
        shutil.rmtree(os.environ["AGENT_WORKSPACE"], ignore_errors=True)

        print(run_task("Add a hello world greeting function"))
