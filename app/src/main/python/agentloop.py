"""
agentloop.py — the agentic tool-use loop (the claude.ai/code-style core).

The driving model (LEAD_MODEL — Claude or DeepSeek, both speak tools via
llm.py) iterates: inspect the repo with read tools, edit with write tools,
verify, and repair — until it stops calling tools. Project context (guidelines,
outline, pinned files, discussion) is passed IN by the orchestrator, so this
module never imports it (no circular imports) and stays OTA-updatable.

Events stream to <workspace>/.agent/run_events.jsonl — the same file the UI
already polls — including streamed text deltas.
"""

import os
import json
from pathlib import Path

import llm
import agent_tools

MAX_STEPS = int(os.environ.get("AGENT_MAX_STEPS", "40"))
REPAIR_ROUNDS = 2


# --- events / interrupt (same file + flag the orchestrator uses) -----------

def _agent_dir() -> Path:
    ws = os.environ.get("AGENT_WORKSPACE") or os.path.join(
        os.environ.get("HOME", "/tmp"), "workspace")
    d = Path(ws) / ".agent"
    d.mkdir(parents=True, exist_ok=True)
    return d


def _emit(kind: str, **data) -> None:
    try:
        rec = {"kind": kind}
        rec.update(data)
        with open(_agent_dir() / "run_events.jsonl", "a", encoding="utf-8") as f:
            f.write(json.dumps(rec) + "\n")
    except Exception:
        pass


def _interrupted() -> bool:
    return os.environ.get("AGENT_INTERRUPT", "0") == "1"


class _DeltaBuffer:
    """Batch streamed text into event-sized chunks so the events file stays sane."""

    def __init__(self):
        self.buf = ""

    def __call__(self, chunk: str) -> None:
        self.buf += chunk
        if len(self.buf) >= 160 or "\n" in self.buf:
            self.flush()

    def flush(self) -> None:
        if self.buf:
            _emit("delta", text=self.buf)
            self.buf = ""


# --- prompts -----------------------------------------------------------------

_AGENT_SYSTEM = (
    "You are a coding agent running ON the user's phone, building and editing "
    "a project in a git workspace. You have tools to inspect and modify the "
    "workspace. Work autonomously until the task is done.\n"
    "\n"
    "Method:\n"
    "- Look before you leap: read the relevant files (read_file/grep/"
    "list_files) BEFORE editing. Never guess at file contents.\n"
    "- Prefer str_replace for targeted changes; write_file for new files or "
    "full rewrites.\n"
    "- After editing Python, run check_python; if the project has tests, run "
    "run_tests. Fix what fails.\n"
    "- Keep the project self-contained and runnable on the device: plain "
    "Python (stdlib + Flask-style WSGI `app.py`) or static web (index.html) "
    "work best — the phone can preview both. No native/compiled dependencies.\n"
    "- Paths are always relative to the workspace root.\n"
    "- Persistent notes the user asks you to remember belong in guidelines.md.\n"
    "\n"
    "When the task is complete (or is a question needing no edits), reply in "
    "plain text WITHOUT calling tools: a short summary of what you did and "
    "anything the user should know. Do not narrate individual tool calls."
)

_PLAN_SYSTEM = (
    "You are a coding agent in PLAN mode: investigate the workspace with the "
    "read-only tools, then propose a plan — do NOT modify anything.\n"
    "When you have enough understanding, call propose_plan exactly once with "
    "a concise summary and one step per file you would create or change. "
    "Steps must be concrete enough that another agent could execute them."
)

_PROPOSE_PLAN_TOOL = {
    "name": "propose_plan",
    "description": "Finish planning: submit the plan for user approval.",
    "input_schema": {
        "type": "object",
        "properties": {
            "summary": {"type": "string", "description": "one-line plan summary"},
            "steps": {"type": "array", "items": {
                "type": "object",
                "properties": {
                    "path": {"type": "string"},
                    "instruction": {"type": "string"},
                },
                "required": ["instruction"],
            }},
        },
        "required": ["summary", "steps"],
    },
    "fn": lambda **kw: "(plan recorded)",
}


def _clip(s, n):
    s = str(s or "")
    return s if len(s) <= n else s[:n] + "…"


# --- the loop -----------------------------------------------------------------

def run(task: str, context: str = "", write: bool = True, plan: bool = False,
        extra_system: str = "") -> dict:
    """Run the agent loop for one task.

    Returns {"text": str, "touched": [paths], "plan": dict|None,
             "steps": int, "usage": {...}, "interrupted": bool}
    """
    model = os.environ.get("LEAD_MODEL", "anthropic/claude-opus-4-8")
    agent_tools.reset_touched()

    if plan:
        tools = agent_tools.toolset(write=False) + [_PROPOSE_PLAN_TOOL]
        system = _PLAN_SYSTEM
    else:
        tools = agent_tools.toolset(write=write)
        system = _AGENT_SYSTEM
    if extra_system:
        system += "\n\n" + extra_system

    messages = [{"role": "user", "content": task}]
    final_text, reasoning_last = "", ""
    plan_out = None
    interrupted = False
    repair_left = REPAIR_ROUNDS
    steps = 0

    while steps < MAX_STEPS:
        if _interrupted():
            interrupted = True
            break
        steps += 1
        _emit("step", n=steps)
        buf = _DeltaBuffer()
        try:
            r = llm.chat(model, system, messages, tools=tools,
                         max_tokens=8000, cached_context=context, on_delta=buf)
        except Exception as e:
            buf.flush()
            _emit("error", detail=str(e)[:400])
            final_text = f"Model call failed after retries: {e}"
            break
        buf.flush()
        if r.get("reasoning"):
            reasoning_last = r["reasoning"]
            _emit("reason", text=_clip(r["reasoning"], 400))

        calls = r.get("tool_calls") or []
        if not calls:
            final_text = r.get("text", "")
            # Post-run verification: syntax-check touched Python before
            # accepting "done"; feed failures back as repair rounds.
            if write and not plan and repair_left > 0:
                errs = agent_tools.check_python_files()
                if errs:
                    repair_left -= 1
                    _emit("verify_failed", detail=_clip(errs, 500))
                    messages.append({"role": "assistant", "content": final_text})
                    messages.append({"role": "user", "content":
                                     "Verification failed — these Python files "
                                     "have syntax errors. Fix them, re-run "
                                     "check_python, then finish:\n" + errs})
                    continue
            if write and not plan:
                _emit("verify_ok")
            break

        # Record the assistant turn, then execute each requested tool.
        messages.append({"role": "assistant", "content": r.get("text", ""),
                         "tool_calls": calls})
        for tc in calls:
            if _interrupted():
                interrupted = True
                result = "(run interrupted by the user — stop now)"
            elif plan and tc["name"] == "propose_plan":
                plan_out = {"summary": tc["args"].get("summary", ""),
                            "edits": [
                                {"path": s.get("path", ""),
                                 "instruction": s.get("instruction", "")}
                                for s in tc["args"].get("steps", [])]}
                result = "(plan recorded — stop now)"
                _emit("plan_done", summary=plan_out["summary"],
                      files=[e["path"] for e in plan_out["edits"]])
            else:
                detail = tc["args"].get("path") or tc["args"].get("pattern") or ""
                _emit("tool_start", name=tc["name"], detail=_clip(detail, 120))
                result = agent_tools.execute(tools, tc["name"], tc["args"])
                _emit("tool_done", name=tc["name"], detail=_clip(detail, 120),
                      result=_clip(result.splitlines()[0] if result else "", 160))
            messages.append({"role": "tool", "tool_call_id": tc["id"],
                             "name": tc["name"], "content": result})
        if plan_out is not None or interrupted:
            final_text = r.get("text", "")
            break
    else:
        _emit("error", detail=f"step limit ({MAX_STEPS}) reached")
        final_text = (final_text or
                      f"Stopped at the {MAX_STEPS}-step safety limit. "
                      "Progress so far is in the workspace — say 'continue' to keep going.")

    u = llm.usage()
    _emit("usage", input=u["input"], output=u["output"], calls=u["calls"])
    return {"text": final_text or "(no reply)", "reasoning": reasoning_last,
            "touched": sorted(agent_tools.TOUCHED), "plan": plan_out,
            "steps": steps, "usage": u, "interrupted": interrupted}
