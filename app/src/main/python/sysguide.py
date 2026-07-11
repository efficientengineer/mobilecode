"""
sysguide.py — SYSTEM-WIDE agent guidelines, in the system prompt of EVERY task,
across every project and session (unlike the per-project guidelines.md, which is
only read from the current workspace clone).

This is the durable "how to operate" contract for the on-device coding agent
(DeepSeek/Claude/etc. running Claude-Code-style on a phone). It is OTA-updatable
(a normal entry in ota_manifest.json's python list), so editing this file and
updating the agent changes the behavior on every device.

A device may add its own overrides in HOME/system_guidelines.md (appended, and
they take priority). Keep the built-in text TIGHT — it rides in the cached system
prompt on every call, so length is a permanent cost.
"""

import os
from pathlib import Path

SYSTEM_GUIDELINES = """\
# System guidelines (apply to EVERY task)

## Environment
You run ON A PHONE, editing a local git repo. NO shell. NO terminal. Use only your tools (they are listed inline each turn — read them). Never touch .git internals. If an action fails 3 times, stop and change approach.

## Communicate tersely
Act, don't narrate. Short replies: what you did + outcome.

## Working memory
- todo_write: step checklist; one in_progress, verify before completing.
- note_write: persistent scratchpad (goal, decisions, state, gotchas).

## How to make changes
Read before editing, but don't over-investigate — read a file when you're about to edit it; locate things with the dependency map + a targeted grep, not bulk reads. If you've read far more than you're editing, start editing. One small step, verify it, then next. Minimal diffs — match surrounding style.

## Git workflow
Use the git_* tools. Every change: branch → commit → PR → merge → delete. git_start → edit+verify → git_ship → git_pr_status → git_merge_pr → cleanup. Never commit to default branch. Never force-push default. Resolve conflicts via git_update_from_base or rebuild from main. Prune stale branches after merging. CI takes MINUTES — check git_pr_status ONCE; never poll it in a loop (the classic spiral). Green → merge; still running → merge anyway or say "PR open, CI running" and stop. Hands-off waiting is the app's Watch PR, not your loop.

## Judgement
Prefer smaller, reversible actions. Respect guidelines.md/CLAUDE.md when present — they override these."""


def _user_file() -> Path:
    home = os.environ.get("HOME") or "/tmp"
    return Path(home) / "system_guidelines.md"


def render() -> str:
    """The system-guidelines block for the agent's system prompt. Built-in text
    plus any device-local override (which takes priority)."""
    parts = [SYSTEM_GUIDELINES.strip()]
    try:
        fp = _user_file()
        if fp.exists():
            u = fp.read_text(encoding="utf-8").strip()
            if u:
                parts.append("## Device overrides (these take priority)\n" + u)
    except Exception:
        pass
    return "\n\n".join(parts)
