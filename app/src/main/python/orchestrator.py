"""
orchestrator.py — the on-device agent brain.

Architecture:
  - LEAD_MODEL (Claude or DeepSeek — both speak tools via llm.py) drives an
    agentic loop (agentloop.py): it reads the repo with tools, edits files,
    verifies, and repairs until the task is done.
  - WORKER_MODEL is an optional cheap implementer the lead can delegate
    mechanical file edits to (the delegate_edit tool).

Everything runs on-device via Chaquopy. Git is handled by dulwich (pure Python,
no binary). Model calls go out over HTTPS via llm.py (stdlib urllib).

IMPORTANT (Android constraint): the current working directory is read-only on
Android. All file writes MUST go under HOME. The Kotlin side passes us a
workspace path inside app storage; we never write with bare filenames.
"""

import os
import json
import traceback
from pathlib import Path

from dulwich import porcelain
from dulwich.repo import Repo

import llm
import agentloop


# --- Model configuration -------------------------------------------------

# Model strings carry a "<provider>/<model>" prefix so _call can route to the
# right API. Adjust if provider names change.
#
# LEAD_MODEL is the orchestrator/planner. WORKER_MODEL is the implementer/editor
# and is OPTIONAL: if it's blank, the orchestrator does the edits itself
# (single-agent mode). The (cheap) implementer also writes commit messages.
LEAD_MODEL = os.environ.get("LEAD_MODEL", "deepseek/deepseek-v4-pro")
WORKER_MODEL = os.environ.get("WORKER_MODEL", "deepseek/deepseek-v4-flash")


def _impl_model() -> str:
    """The implementer model, falling back to the orchestrator when unset."""
    w = (WORKER_MODEL or "").strip()
    return w if w else LEAD_MODEL


# Reasoning captured from the most recent _call (read right after calling).
_LAST_REASON = ""

# Compact context form of the most recent edit run (read right after _finish_run).
# The chat shows the full "Done / files / committed" text, but context only needs
# the essence, so we carry this leaner version into DISCUSSION SO FAR.
_LAST_EDIT_CTX = ""


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

def _call(model: str, system: str, user: str, max_tokens: int = 4000) -> str:
    """Single-turn text call via the unified llm layer (retries, streaming
    continuation, usage accounting come for free). Kept for outline/commit
    message generation and chat mode."""
    global _LAST_REASON
    text, reasoning = llm.chat_text(model, system, user, max_tokens=max_tokens)
    _LAST_REASON = reasoning
    return text


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


# A word is alphanumeric and may contain internal hyphens/apostrophes, so
# "2D", "3D", "z-index", "index.html" and "don't" stay intact; anything else
# (a lone period, comma, colon…) is its own token.
_WORD_RE = None


def _word_re():
    global _WORD_RE
    if _WORD_RE is None:
        _WORD_RE = _re.compile(r"[A-Za-z0-9]+(?:[-'.][A-Za-z0-9]+)*|[^\sA-Za-z0-9]")
    return _WORD_RE


def _caveman(text: str) -> str:
    if not text:
        return text
    def strip_line(line: str) -> str:
        toks = [t for t in _word_re().findall(line) if t.lower() not in _FILLER]
        s = " ".join(toks)
        # Re-attach trailing/opening punctuation so it reads cleanly:
        # "Good . Strong ." -> "Good. Strong."
        s = _re.sub(r"\s+([.,!?;:)\]])", r"\1", s)
        s = _re.sub(r"([(\[])\s+", r"\1", s)
        return s
    return "\n".join(strip_line(l) for l in text.splitlines())


def _compact_agent_text(text: str) -> str:
    """Reduce a full edit-run reply to just its outcome for context use:
    'Done: <commit message>' (no file list, no commit id). Returns the input
    unchanged when it isn't a committed edit reply."""
    if not text or "Committed " not in text:
        return text
    msg = ""
    for line in text.splitlines():
        st = line.strip()
        if st.startswith("Committed "):
            # 'Committed <id>: <message>' → keep only <message>
            after = st[len("Committed "):]
            msg = after.split(":", 1)[1].strip() if ":" in after else after.strip()
    if not msg:
        return text
    prefix = "Interrupted. " if text.lstrip().startswith("Interrupted") else ""
    return f"{prefix}Done: {msg}"


def _append_discussion(role: str, text: str, run_id: str = "", ctx: str = None) -> None:
    """Record a turn. `text` is the full message shown in chat; `ctx` (optional)
    is a leaner form used only when assembling context — pass it to strip
    redundancy the model doesn't need to re-read."""
    idx = len(_read_discussion())
    ctx_text = text if ctx is None else ctx
    rec = {"id": idx, "role": role, "text": text, "ctx": ctx_text,
           "cave": _caveman(ctx_text), "run_id": run_id}
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
    # In-run pruning (read by agentloop): once the loop's own transcript
    # exceeds loopBudget chars, old tool results are elided in one batch,
    # protecting the last keepSteps model turns.
    "loopBudget": 80000,
    "keepSteps": 4,
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
    if _frugal_on():
        # Carry less discussion history when spending less.
        s["maxTurns"] = min(s["maxTurns"], 6)
        s["codeTurns"] = min(s["codeTurns"], 4)
        s["charBudget"] = min(s["charBudget"], 3000)
        s["perTurn"] = min(s["perTurn"], 500)
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
        # Prefer the stored compact form; for older turns saved before that
        # existed, derive it from the full text so history compacts too.
        raw = d.get("ctx") or _compact_agent_text(d.get("text", ""))
        base = _caveman(raw) if cave else raw
        body = _clip_turn(base or "", s["perTurn"])
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
    """JSON {turns:[{id,role,text,ctx,run_id}]}. `text` is the full display
    message; `ctx` is the leaner form that actually goes into context (used by
    the UI to show per-message context cost)."""
    cave = _caveman_on()
    turns = []
    for i, d in enumerate(_read_discussion()):
        text = d.get("text", "")
        raw = d.get("ctx") or _compact_agent_text(text)
        ctx = _caveman(raw) if cave else raw
        turns.append({"id": d.get("id", i), "role": d["role"], "text": text,
                      "ctx": ctx, "run_id": d.get("run_id", "")})
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


_OUTLINE_RULES = (
    "The outline is a DENSE project map re-sent as context every turn, so every "
    "word must earn its place. Rules:\n"
    "- Terse fragments, not sentences. Be as short as the project warrants — a "
    "tiny project gets a few lines; only grow it as the project genuinely does.\n"
    "- One line: what the project IS (concrete, not 'a minimal template').\n"
    "- 'Files:' then `path — role` per real file, one phrase each. Skip empty/boilerplate files.\n"
    "- Note key functions/entry points ONLY if evident from the snippets.\n"
    "- NO generic advice, NO invented TODOs, NO 'likely'/'to be added' filler, "
    "NO restating structure that the file list already shows."
)


def _outline_manifest_path(root: Path = None) -> Path:
    return _agent_dir(root) / "outline_manifest.json"


def _file_hashes(root: Path, files: list) -> dict:
    """sha1 of each readable file's content, keyed by path."""
    import hashlib
    out = {}
    for f in files:
        c = _read_file(root, f)
        if c is not None:
            out[f] = hashlib.sha1(c.encode("utf-8", "replace")).hexdigest()
    return out


def build_outline(_=None) -> str:
    """(Re)generate .agent/outline.md efficiently:
      - diff mode (SEARCH/REPLACE) against the existing outline → cheap output,
      - only CHANGED files' snippets are sent → cheap input,
      - skips the model entirely when nothing changed since the last build."""
    try:
        root = _workspace()
        files = _list_repo_files(root, max_files=120)
        hashes = _file_hashes(root, files)

        prev = ""
        of = _outline_file(root)
        if of.exists():
            try:
                prev = of.read_text(encoding="utf-8")
            except Exception:
                prev = ""

        manifest = {}
        mp = _outline_manifest_path(root)
        if mp.exists():
            try:
                manifest = json.loads(mp.read_text(encoding="utf-8"))
            except Exception:
                manifest = {}

        changed = [f for f in files if hashes.get(f) != manifest.get(f)]
        deleted = [f for f in manifest if f not in hashes]

        def snippets_for(paths):
            out = []
            for f in paths[:40]:
                c = _read_file(root, f)
                if c and len(c) < 4000:
                    out.append(f"### {f}\n{c[:1500]}")
            return "\n\n".join(out)

        diff_mode = bool(prev.strip() and manifest)

        if diff_mode and not changed and not deleted:
            return "Outline already up to date (no file changes)"

        if diff_mode:
            # Only send what moved; the outline already covers the rest.
            facts = "ALL FILES:\n" + "\n".join(files)
            if changed:
                facts += "\n\nCHANGED / NEW FILE SNIPPETS:\n" + snippets_for(changed)
            if deleted:
                facts += "\n\nDELETED FILES (remove from outline):\n" + "\n".join(deleted)
            system = (
                "You maintain a project outline by editing it in place.\n" + _OUTLINE_RULES +
                "\n\nOnly the files that changed are shown; assume everything else is "
                "unchanged and already correctly described. Return ONLY SEARCH/REPLACE "
                "blocks that update the CURRENT OUTLINE. Each block:\n"
                "<<<<<<< SEARCH\n<exact text to find>\n=======\n<replacement>\n>>>>>>> REPLACE\n"
                "Use an empty SEARCH section to append new content. If nothing needs "
                "changing, return exactly: NO CHANGES."
            )
            user = "CURRENT OUTLINE:\n" + prev + "\n\n" + facts
            out = _call(LEAD_MODEL, system, user, max_tokens=5000)
            res = _apply_sr_blocks(prev, out)
            if res is None and "NO CHANGES" in out.upper():
                mp.write_text(json.dumps(hashes), encoding="utf-8")
                return "Outline already up to date"
            if res and res[1] > 0:
                md = res[0].strip()
                if _caveman_on():
                    md = _caveman(md)
                of.write_text(md, encoding="utf-8")
                mp.write_text(json.dumps(hashes), encoding="utf-8")
                return f"Outline updated via diff ({res[1]}/{res[2]} edits, {len(md)} chars)"
            # Diff failed to apply — fall through to a full rewrite.

        facts = "FILES:\n" + "\n".join(files) + "\n\nSNIPPETS:\n" + snippets_for(files)
        system = ("You write a project outline in markdown, no fences.\n" + _OUTLINE_RULES)
        md = _call(LEAD_MODEL, system, facts, max_tokens=5000).strip()
        if _caveman_on():
            md = _caveman(md)
        of.write_text(md, encoding="utf-8")
        mp.write_text(json.dumps(hashes), encoding="utf-8")
        return f"Outline generated ({len(md)} chars)"
    except Exception:
        return "Outline failed:\n" + traceback.format_exc()


# --- Execution: events, interrupt, run records ----------------------------

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
    """Reset per-run state so events/interrupt/usage/todos/steer start clean."""
    _clear_events()
    os.environ["AGENT_INTERRUPT"] = "0"
    llm.reset_usage()
    for name in ("todos.json", "steer.jsonl"):
        try:
            (_agent_dir() / name).unlink()
        except Exception:
            pass
    # Publish frugal state to the env so llm.py (no workspace concept) sees it.
    os.environ["AGENT_FRUGAL"] = "1" if _frugal_on() else "0"


def _frugal_on() -> bool:
    return os.environ.get("AGENT_FRUGAL", "0") == "1" or (_agent_dir() / "frugal").exists()


def get_frugal(_=None) -> str:
    return "1" if _frugal_on() else "0"


def set_frugal(flag="1") -> str:
    on = str(flag) in ("1", "true", "True", "on")
    marker = _agent_dir() / "frugal"
    if on:
        marker.write_text("1")
        os.environ["AGENT_FRUGAL"] = "1"
    else:
        if marker.exists():
            marker.unlink()
        os.environ["AGENT_FRUGAL"] = "0"
    return ("Frugal mode ON — reasoning off, tighter context, smaller reads, "
            "and split-file nudges to spend less." if on else "Frugal mode off")


def steer(text="") -> str:
    """Queue a guidance message for the CURRENTLY RUNNING loop. The loop picks
    it up before its next model call and adjusts course (see agentloop)."""
    t = str(text).strip()
    if not t:
        return "(nothing to steer)"
    try:
        with open(_agent_dir() / "steer.jsonl", "a", encoding="utf-8") as f:
            f.write(json.dumps({"text": t}) + "\n")
        return "Steering the running task…"
    except Exception:
        return "Could not queue guidance."


def get_usage(_=None) -> str:
    """Token usage of the current/most recent run (real API numbers)."""
    return json.dumps(llm.usage())


def get_todos(_=None) -> str:
    """The current task checklist (JSON list of {content, status})."""
    fp = _agent_dir() / "todos.json"
    return fp.read_text(encoding="utf-8") if fp.exists() else "[]"


def _runs_dir() -> Path:
    d = _agent_dir() / "runs"
    d.mkdir(parents=True, exist_ok=True)
    return d


def get_run(run_id: str) -> str:
    """Return a stored run record (plan + handoffs + reviews) as JSON."""
    fp = _runs_dir() / f"{run_id}.json"
    return fp.read_text(encoding="utf-8") if fp.exists() else "{}"


# --- diff gate + autocommit ------------------------------------------------

def _autocommit_on() -> bool:
    """Autocommit is the default; a marker file turns the diff gate on."""
    return not (_agent_dir() / "noautocommit").exists()


def set_autocommit(flag="1") -> str:
    on = str(flag) in ("1", "true", "True", "on")
    marker = _agent_dir() / "noautocommit"
    if on and marker.exists():
        marker.unlink()
    elif not on:
        marker.write_text("1")
    return "Autocommit " + ("on" if on else "off — review the diff, then Commit")


def get_autocommit(_=None) -> str:
    return "1" if _autocommit_on() else "0"


def _changed_paths(root: Path) -> list:
    """Working-tree paths that differ from the index/HEAD (via dulwich status)."""
    try:
        status = porcelain.status(str(root))
    except Exception:
        return []
    out = []
    for p in status.untracked:
        out.append(p.decode() if isinstance(p, bytes) else p)
    for kind in ("add", "delete", "modify"):
        out += [p.decode() if isinstance(p, bytes) else p
                for p in status.staged.get(kind, [])]
    out += [p.decode() if isinstance(p, bytes) else p for p in status.unstaged]
    seen, uniq = set(), []
    for p in out:
        if p not in seen and ".agent/" not in p and p not in ("meta.json", "transcript.jsonl"):
            seen.add(p)
            uniq.append(p)
    return uniq


def _head_file(root: Path, rel: str):
    """The file's content at HEAD, or None if it doesn't exist there."""
    try:
        from dulwich.object_store import tree_lookup_path
        r = Repo(str(root))
        head = r[r.head()]
        _, sha = tree_lookup_path(r.object_store.__getitem__, head.tree,
                                  rel.encode())
        return r.object_store[sha].data.decode("utf-8", "replace")
    except Exception:
        return None


def get_diff(_=None) -> str:
    """Unified diff of the working tree vs HEAD (uncommitted changes)."""
    import difflib
    root = _workspace()
    if not (root / ".git").exists():
        return "(no git repo yet)"
    chunks = []
    for rel in _changed_paths(root)[:50]:
        old = _head_file(root, rel)
        fp = root / rel
        new = None
        if fp.exists() and fp.is_file():
            try:
                new = fp.read_text(encoding="utf-8", errors="replace")
            except Exception:
                new = "(binary or unreadable)"
        if old == new:
            continue
        diff = difflib.unified_diff(
            (old or "").splitlines(keepends=True),
            (new or "").splitlines(keepends=True),
            fromfile=f"a/{rel}" if old is not None else "/dev/null",
            tofile=f"b/{rel}" if new is not None else "/dev/null")
        chunks.append("".join(diff)[:20000])
    return "\n".join(chunks) or "(no uncommitted changes)"


def discard_changes(_=None) -> str:
    """Throw away all uncommitted changes (hard reset to HEAD)."""
    try:
        root = _workspace()
        for rel in _changed_paths(root):
            old = _head_file(root, rel)
            fp = root / rel
            if old is None:
                if fp.exists():
                    fp.unlink()
            else:
                fp.parent.mkdir(parents=True, exist_ok=True)
                fp.write_text(old, encoding="utf-8")
        try:
            porcelain.reset(str(_workspace()), "hard")
        except Exception:
            pass
        return "Uncommitted changes discarded"
    except Exception:
        return "Discard failed:\n" + traceback.format_exc()


def revert_last(_=None) -> str:
    """Undo the most recent commit (moves the branch back one; files follow)."""
    try:
        root = _workspace()
        r = Repo(str(root))
        head = r[r.head()]
        if not head.parents:
            return "Nothing before the first commit — cannot revert."
        parent = head.parents[0]
        try:
            ref = r.refs.follow(b"HEAD")[0][-1]
        except Exception:
            ref = b"refs/heads/master"
        r.refs[ref] = parent
        porcelain.reset(str(root), "hard")
        msg = r[parent].message.decode("utf-8", "replace").strip()
        return f"Reverted to {parent.decode()[:8]}: {msg.splitlines()[0]}"
    except Exception:
        return "Revert failed:\n" + traceback.format_exc()


def _finish_run(task: str, res: dict, run_id: str) -> str:
    """Verify → commit (or hold for review) → record. Returns the reply text."""
    global _LAST_EDIT_CTX
    root = _workspace()
    touched = res.get("touched") or []
    lines = []
    if res.get("interrupted"):
        lines.append("Interrupted.")
    lines.append(res.get("text", "").strip() or "(no summary)")

    commit_id, message = "", ""
    if touched:
        lines.append(f"\nFiles changed: {len(touched)}")
        lines += [f"  - {c}" for c in touched]
        if _autocommit_on():
            _emit("commit_start")
            summary = (res.get("text", "").strip().splitlines() or ["update"])[0][:120]
            message = _commit_message(summary, touched)
            commit_id = _commit(root, message)[:8]
            _emit("done", commit=commit_id)
            lines.append(f"Committed {commit_id}: {message}")
        else:
            _emit("pending_commit", files=touched)
            lines.append("Not committed — review the diff, then Commit or Discard.")

    u = res.get("usage") or {}
    if u.get("input") or u.get("output"):
        lines.append(f"[tokens: {u.get('input', 0)} in / {u.get('output', 0)} out, "
                     f"{res.get('steps', 0)} steps]")

    try:
        (_runs_dir() / f"{run_id}.json").write_text(
            json.dumps({"task": task, "text": res.get("text", ""),
                        "reasoning": res.get("reasoning", ""),
                        "touched": touched, "steps": res.get("steps", 0),
                        "usage": u, "commit": commit_id, "message": message}),
            encoding="utf-8")
    except Exception:
        pass

    full = "\n".join(lines)
    _LAST_EDIT_CTX = (("Interrupted. " if res.get("interrupted") else "") +
                      (f"Done: {message}" if commit_id else
                       ((res.get("text", "").strip().splitlines() or ["done"])[0][:200]
                        if touched else full)))
    return full


# --- Modes ---------------------------------------------------------------

def _chat_reply(task: str) -> str:
    """Plain conversational answer — no files, no commit. Streams deltas to the
    run-events file so the UI shows the reply as it is generated."""
    context = _full_context(task, "chat")
    system = ("You are a helpful coding assistant. Answer conversationally and "
              "concisely. Do not create or modify files.")
    user = (f"{context}\n\n" if context else "") + "USER: " + task
    text, reason = llm.chat_text(LEAD_MODEL, system, user,
                                 on_delta=lambda c: _emit("delta", text=c))
    global _LAST_REASON
    _LAST_REASON = reason
    return text


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


# --- Public entry point (called from Kotlin) -----------------------------

def run_task(task: str) -> str:
    """
    Handle one turn. Mode comes from env AGENT_MODE:
      chat  — just reply (no tools, cheap)
      code  — agentic loop with write tools
      plan  — agentic loop with read-only tools; plan stashed for approval
      auto  — agentic loop with write tools; the model just answers when the
              task doesn't need edits (default)
    """
    try:
        mode = os.environ.get("AGENT_MODE", "auto").strip().lower()
        _begin_run()
        _append_discussion("user", task)

        if mode == "chat":
            reply = _chat_reply(task)
            _append_discussion("agent", reply)
            return reply

        context = _full_context(task, mode).strip()

        if mode == "plan":
            res = agentloop.run(task, context=context, plan=True)
            plan = res.get("plan")
            if not plan or not plan.get("edits"):
                result = res.get("text") or "(no plan produced)"
                _append_discussion("agent", result)
                return result
            plan["task"] = task
            try:
                _plan_path().write_text(json.dumps(plan))
            except Exception:
                pass
            result = _format_plan(plan)
            _append_discussion("agent", result)
            return result

        extra = ("" if mode == "code" else
                 "If the user's message is a question or discussion that needs "
                 "no file changes, just answer it in plain text without tools.")
        res = agentloop.run(task, context=context, write=True, extra_system=extra)
        run_id = _new_run_id()
        result = _finish_run(task, res, run_id)
        _append_discussion("agent", result,
                           run_id=run_id if res.get("touched") else "",
                           ctx=_LAST_EDIT_CTX)
        return result

    except Exception:
        err = "⚠️ Error during task:\n" + traceback.format_exc()
        # Record it so the chat actually SHOWS the failure instead of returning
        # a blank turn. Keep it out of future context (short ctx marker).
        try:
            _append_discussion("agent", err, ctx="(previous attempt errored)")
        except Exception:
            pass
        return err


def execute_plan() -> str:
    """Build the previously-stashed plan (plan-mode approval) with the full
    agentic loop, so the builder can still read files and verify its work."""
    try:
        p = _plan_path()
        if not p.exists():
            return "No pending plan to approve."
        plan = json.loads(p.read_text())
        _begin_run()
        steps = "\n".join(
            f"{i}. {e.get('path', '(path up to you)')}: {e.get('instruction', '')}"
            for i, e in enumerate(plan.get("edits", []), 1))
        task = (f"Implement this approved plan.\n\nORIGINAL TASK:\n"
                f"{plan.get('task', '')}\n\nPLAN: {plan.get('summary', '')}\n{steps}")
        context = _full_context(task, "code").strip()
        res = agentloop.run(task, context=context, write=True)
        run_id = _new_run_id()
        result = _finish_run(task, res, run_id)
        try:
            p.unlink()
        except Exception:
            pass
        _append_discussion("agent", result, run_id=run_id, ctx=_LAST_EDIT_CTX)
        return result
    except Exception:
        return "Approve failed:\n" + traceback.format_exc()


def fix_build(_=None) -> str:
    """Pull the latest CI failure from GitHub Actions and set the agent on it."""
    try:
        import git_ops
        log = git_ops.ci_failure_log()
        if log.startswith("("):
            return log  # no repo / no failure / API problem — explain, don't run
        _begin_run()
        task = ("The cloud build (GitHub Actions) failed. Diagnose from the log "
                "below, fix the workspace, and verify. Failure log (tail):\n\n" + log)
        _append_discussion("user", "Fix the failed cloud build", ctx="Fix the failed cloud build")
        context = _full_context(task, "code").strip()
        res = agentloop.run(task, context=context, write=True)
        run_id = _new_run_id()
        result = _finish_run(task, res, run_id)
        _append_discussion("agent", result, run_id=run_id, ctx=_LAST_EDIT_CTX)
        return result
    except Exception:
        return "Fix build failed:\n" + traceback.format_exc()


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
# Exercises the full tool loop with a scripted fake model — no API keys.
if __name__ == "__main__":
    import sys
    if "--selftest" in sys.argv:
        script = [
            # step 1: model inspects, then writes a (deliberately broken) file
            {"text": "", "reasoning": "", "stop": "tool_use", "usage": {"input": 10, "output": 5},
             "tool_calls": [
                 {"id": "t1", "name": "list_files", "args": {}},
                 {"id": "t2", "name": "write_file",
                  "args": {"path": "greet.py",
                           "content": "def hello(:\n    print('hi')\n"}}]},
            # step 2: model checks its work, finds the syntax error, fixes it
            {"text": "", "reasoning": "", "stop": "tool_use", "usage": {"input": 10, "output": 5},
             "tool_calls": [
                 {"id": "t3", "name": "check_python", "args": {}},
                 {"id": "t4", "name": "write_file",
                  "args": {"path": "greet.py",
                           "content": "def hello():\n    print('hi from agent')\n"}}]},
            # step 3: done
            {"text": "Added greet.py with a hello() function.", "reasoning": "",
             "stop": "end_turn", "usage": {"input": 10, "output": 5}, "tool_calls": []},
        ]
        calls = {"n": 0}

        def fake_chat(model, system, messages, tools=None, max_tokens=8000,
                      cached_context="", on_delta=None):
            r = script[min(calls["n"], len(script) - 1)]
            calls["n"] += 1
            return r

        def fake_chat_text(model, system, user, max_tokens=4000, on_delta=None):
            return "Add greeting module", ""

        llm.chat = fake_chat
        llm.chat_text = fake_chat_text
        import agentloop as _al
        _al.llm.chat = fake_chat

        os.environ["AGENT_WORKSPACE"] = os.path.join(
            os.environ.get("HOME", "/tmp"), "selftest_ws")
        os.environ["AGENT_MODE"] = "code"
        import shutil
        shutil.rmtree(os.environ["AGENT_WORKSPACE"], ignore_errors=True)

        out = run_task("Add a hello world greeting function")
        print(out)
        ws = Path(os.environ["AGENT_WORKSPACE"])
        body = (ws / "greet.py").read_text()
        assert "hi from agent" in body, "final file content wrong"
        assert "Committed" in out, "run did not commit"
        assert (ws / ".git").exists(), "no git repo created"
        print("\nSELFTEST OK — loop, tools, verify, commit all exercised")
