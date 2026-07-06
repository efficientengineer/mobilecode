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
from pathlib import Path

import litellm
from dulwich import porcelain
from dulwich.repo import Repo


# --- Model configuration -------------------------------------------------

# These strings are resolved by litellm. Adjust if provider names change.
LEAD_MODEL = os.environ.get("LEAD_MODEL", "anthropic/claude-opus-4-20250514")
WORKER_MODEL = os.environ.get("WORKER_MODEL", "deepseek/deepseek-chat")

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

def _call(model: str, system: str, user: str, max_tokens: int = 4000) -> str:
    resp = litellm.completion(
        model=model,
        messages=[
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
        max_tokens=max_tokens,
    )
    return resp["choices"][0]["message"]["content"]


def _plan_with_lead(task: str, root: Path) -> dict:
    """Opus reads the task + repo and returns a JSON plan of edits."""
    file_list = _list_repo_files(root)
    system = (
        "You are the lead engineer. Produce a concrete plan to accomplish the "
        "user's task. Respond ONLY with JSON, no prose, no markdown fences. "
        "Schema: {\"summary\": str, \"edits\": [{\"path\": str, "
        "\"instruction\": str}]}. Each edit describes one file to create or "
        "modify and precise instructions for the editor."
    )
    user = (
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
    new_content = _call(WORKER_MODEL, system, user)
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
        summary = plan.get("summary", "(no summary)")
        edits = plan.get("edits", [])

        changed = []
        for edit in edits:
            try:
                changed.append(_edit_with_worker(edit, root))
            except Exception as e:
                changed.append(f"{edit.get('path','?')} [FAILED: {e}]")

        commit_id = _commit(root, f"{summary}")[:8]

        lines = [f"Done: {summary}",
                 f"Files changed: {len(changed)}"]
        lines += [f"  - {c}" for c in changed]
        lines.append(f"Committed as {commit_id}")
        return "\n".join(lines)

    except Exception:
        return "Error during task:\n" + traceback.format_exc()


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
