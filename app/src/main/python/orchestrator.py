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
    provider, _, model_name = model.partition("/")
    if not model_name:
        provider, model_name = "openai", model

    if provider == "anthropic":
        key = os.environ.get("ANTHROPIC_API_KEY", "")
        result = _http_post_json(
            "https://api.anthropic.com/v1/messages",
            {
                "x-api-key": key,
                "anthropic-version": "2023-06-01",
                "content-type": "application/json",
            },
            {
                "model": model_name,
                "max_tokens": max_tokens,
                "system": system,
                "messages": [{"role": "user", "content": user}],
            },
        )
        parts = result.get("content", [])
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
    return result["choices"][0]["message"]["content"]


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
        "and one \"edit\" per file. When in doubt, prefer \"chat\"."
    )
    context = _full_context(task).strip()
    context_block = f"{context}\n\n" if context else ""
    mode = os.environ.get("AGENT_MODE", "auto").strip().lower()
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
    return json.loads(raw)


def _edit_with_worker(edit: dict, root: Path) -> str:
    """DeepSeek writes the actual new content for one file."""
    path = edit["path"]
    instruction = edit["instruction"]
    current = _read_file(root, path)
    system = (
        "You are the editor. Output ONLY the complete new contents of the "
        "file — no explanations, no markdown fences. If modifying, return the "
        "whole file with changes applied."
    )
    user = (
        f"FILE: {path}\n\n"
        f"CURRENT CONTENTS:\n{current if current else '(new file)'}\n\n"
        f"INSTRUCTION:\n{instruction}"
    )
    new_content = _call(_impl_model(), system, user)
    new_content = new_content.strip()
    if new_content.startswith("```"):
        # drop first fence line and trailing fence
        lines = new_content.split("\n")
        if lines[0].startswith("```"):
            lines = lines[1:]
        if lines and lines[-1].strip() == "```":
            lines = lines[:-1]
        new_content = "\n".join(lines)
    _write_file(root, path, new_content + "\n")
    return path


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
    # Stage everything that isn't in .git or the agent's private .agent dir
    for p in root.rglob("*"):
        if ".git" in p.parts or ".agent" in p.parts or not p.is_file():
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


def _append_discussion(role: str, text: str) -> None:
    rec = {"role": role, "text": text, "cave": _caveman(text)}
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


def _full_context(task_hint: str = "") -> str:
    """Assemble the per-prompt context: memory + outline + recent discussion."""
    root = _workspace()
    parts = []
    claude = _read_file(root, "CLAUDE.md")
    if claude:
        parts.append("PROJECT MEMORY (CLAUDE.md):\n" + claude)
    outline = _outline_file(root)
    if outline.exists():
        parts.append("PROJECT OUTLINE:\n" + outline.read_text(encoding="utf-8"))
    disc = _read_discussion()[-12:]
    if disc:
        cave = _caveman_on()
        lines = [f"{d['role']}: {d.get('cave' if cave else 'text', '')}" for d in disc]
        parts.append("DISCUSSION SO FAR:\n" + "\n".join(lines))
    return "\n\n".join(parts)


# --- op targets (called from the web via agent_loader.op) ----------------

def get_discussion(_=None) -> str:
    """JSON {turns:[{role,text}]} of the original (display) messages."""
    turns = [{"role": d["role"], "text": d.get("text", "")} for d in _read_discussion()]
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
    d = "\n".join(x.get("cave" if cave else "text", "") for x in disc)
    claude = _read_file(_workspace(), "CLAUDE.md")

    def toks(s):
        return len(s) // 4
    return json.dumps({
        "outlineChars": len(o), "outlineTokens": toks(o),
        "discussionChars": len(d), "discussionTokens": toks(d),
        "memoryTokens": toks(claude), "turns": len(disc), "caveman": cave,
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


# --- Modes ---------------------------------------------------------------

def _chat_reply(task: str) -> str:
    """Plain conversational answer — no files, no commit."""
    context = _full_context()
    system = ("You are a helpful coding assistant. Answer conversationally and "
              "concisely. Do not create or modify files.")
    user = (f"{context}\n\n" if context else "") + "USER: " + task
    return _call(LEAD_MODEL, system, user)


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
        _append_discussion("user", task)

        if mode == "chat":
            reply = _chat_reply(task)
            _append_discussion("agent", reply)
            return reply

        plan = _plan_with_lead(task, root)
        edits = plan.get("edits", [])

        if mode == "plan":
            if not edits:
                result = plan.get("reply") or _chat_reply(task)
            else:
                try:
                    _plan_path().write_text(json.dumps(plan))
                except Exception:
                    pass
                result = _format_plan(plan)
        elif mode != "code" and (plan.get("mode") == "chat" or not edits):
            result = plan.get("reply") or plan.get("summary") or "(no reply)"
        elif not edits:
            result = plan.get("reply") or "(nothing to change)"
        else:
            result = _execute_edits(plan, root)

        _append_discussion("agent", result)
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
        result = _execute_edits(plan, _workspace())
        try:
            p.unlink()
        except Exception:
            pass
        _append_discussion("agent", result)
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
