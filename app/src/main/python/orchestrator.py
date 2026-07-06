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
        if ".git" in p.parts:
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
    context = os.environ.get("AGENT_CONTEXT", "").strip()
    context_block = f"RECENT CONVERSATION:\n{context}\n\n" if context else ""
    user = (
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
    # Stage everything that isn't in .git
    for p in root.rglob("*"):
        if ".git" in p.parts or not p.is_file():
            continue
        porcelain.add(str(root), paths=[str(p)])
    commit_id = porcelain.commit(
        str(root),
        message=message.encode(),
        author=b"Voice Agent <agent@device.local>",
        committer=b"Voice Agent <agent@device.local>",
    )
    return commit_id.decode() if isinstance(commit_id, bytes) else str(commit_id)


# --- Public entry point (called from Kotlin) -----------------------------

def run_task(task: str) -> str:
    """
    Full pipeline for one spoken instruction.
    Returns a human-readable summary string for display + TTS.
    """
    try:
        root = _workspace()
        plan = _plan_with_lead(task, root)
        edits = plan.get("edits", [])

        # Conversational turn: reply in words, touch no files, no commit.
        if plan.get("mode") == "chat" or not edits:
            reply = plan.get("reply") or plan.get("summary") or "(no reply)"
            return reply

        summary = plan.get("summary", "(no summary)")
        changed = []
        for edit in edits:
            try:
                changed.append(_edit_with_worker(edit, root))
            except Exception as e:
                changed.append(f"{edit.get('path','?')} [FAILED: {e}]")

        message = _commit_message(summary, changed)
        commit_id = _commit(root, message)[:8]

        lines = [f"Done: {summary}",
                 f"Files changed: {len(changed)}"]
        lines += [f"  - {c}" for c in changed]
        lines.append(f"Committed {commit_id}: {message}")
        return "\n".join(lines)

    except Exception:
        return "Error during task:\n" + traceback.format_exc()


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
