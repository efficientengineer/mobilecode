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


def _frugal_on() -> bool:
    return os.environ.get("AGENT_FRUGAL", "0") == "1" or (_agent_dir() / "frugal").exists()


def _thinking_on() -> bool:
    # Frugal mode forces reasoning off (it's the biggest avoidable output cost).
    return os.environ.get("AGENT_THINKING", "0") == "1" and not _frugal_on()


def _arg_path(args):
    for k in ("path", "file", "filename", "file_path", "filepath", "target"):
        v = (args or {}).get(k)
        if v is not None and str(v).strip():
            return str(v)
    return None


def _trim_superseded(messages) -> int:
    """Stub read_file results that a later read OR an edit of the same file has
    made stale — they're dead weight re-sent on every subsequent step. The
    newest read of each still-unedited file is kept intact. Returns chars saved."""
    saved = 0
    last_read = {}  # path -> index of its most recent still-relevant read result

    def stub(idx, why):
        nonlocal saved
        c = messages[idx].get("content", "")
        if c.startswith("(stale"):
            return
        new = f"(stale read — {why}; re-read the file if you still need it)"
        saved += max(0, len(c) - len(new))
        messages[idx]["content"] = new

    for i, m in enumerate(messages):
        if m.get("role") != "tool":
            continue
        path = m.get("_path")
        if not path:
            continue
        name = m.get("name")
        if name == "read_file":
            if path in last_read:
                stub(last_read[path], "superseded by a newer read")
            last_read[path] = i
        elif name in ("write_file", "str_replace", "delete_file", "delegate_edit"):
            if path in last_read:
                stub(last_read[path], "the file was edited after this read")
                del last_read[path]
    return saved


def _drain_steer() -> list:
    """Read + clear any mid-run guidance the user queued (orchestrator.steer)."""
    fp = _agent_dir() / "steer.jsonl"
    if not fp.exists():
        return []
    out = []
    try:
        for line in fp.read_text(encoding="utf-8").splitlines():
            try:
                t = json.loads(line).get("text", "").strip()
                if t:
                    out.append(t)
            except Exception:
                pass
        fp.unlink()
    except Exception:
        return []
    return out


# --- in-run context pruning --------------------------------------------------
# The loop's own transcript (tool results, mostly) grows every step; without a
# cap a long run re-sends megabytes per step. Old tool results are elided in
# ONE batch when the budget is crossed — batching matters because provider
# prefix caches are invalidated by any edit to earlier messages, so we prune
# rarely and hard rather than a little every step. Knobs live in the same
# .agent/compaction.json the discussion compactor uses.

_LOOP_DEFAULTS = {"loopBudget": 80000, "keepSteps": 4}


def _loop_settings() -> dict:
    s = dict(_LOOP_DEFAULTS)
    try:
        fp = _agent_dir() / "compaction.json"
        if fp.exists():
            data = json.loads(fp.read_text(encoding="utf-8"))
            for k in _LOOP_DEFAULTS:
                if k in data:
                    s[k] = max(0, int(data[k]))
    except Exception:
        pass
    if _frugal_on():
        s["loopBudget"] = min(s["loopBudget"] or 30000, 30000)
        s["keepSteps"] = min(s["keepSteps"] or 2, 2)
    return s


def _msg_len(m) -> int:
    return len(m.get("content") or "")


def prune_messages(messages: list) -> int:
    """Elide old bulky tool results once the transcript exceeds the budget.

    The last `keepSteps` assistant turns (and everything after them) are
    protected so the model keeps its working set. Returns chars saved.
    """
    s = _loop_settings()
    budget = s["loopBudget"]
    if budget <= 0 or sum(_msg_len(m) for m in messages) <= budget:
        return 0
    # Protect the tail: everything from the keepSteps-th assistant turn
    # (counted from the end), plus the initial user task.
    cutoff = 0
    seen = 0
    for i in range(len(messages) - 1, -1, -1):
        if messages[i]["role"] == "assistant":
            seen += 1
            if seen >= s["keepSteps"]:
                cutoff = i
                break
    saved = 0
    for m in messages[1:cutoff]:
        if m["role"] == "tool" and _msg_len(m) > 200 and \
                not m.get("content", "").startswith("(elided "):
            n = _msg_len(m)
            m["content"] = (f"(elided {n} chars of {m.get('name', 'tool')} "
                            "output to save context — re-run the tool if you "
                            "need it again)")
            saved += n - _msg_len(m)
    return saved


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
    "- Structure every project as a CONTEXT-FRIENDLY 'file per feature' spine: "
    "one small, single-responsibility file per feature (e.g. player.js, "
    "enemies.js, dungeon.js, input.js) wired from a small entry file (an "
    "index.html that loads them, or a main.js). This keeps each read and edit "
    "small and cheap. NEVER build a whole app as one giant file.\n"
    "- Keep files under ~300 lines; if one would grow past that, split it. "
    "Writing a very large file in one call also risks hitting the output limit "
    "and truncating — write a small skeleton, then grow it with str_replace. "
    "After a big write, grep for the expected closing token (</script>, "
    "</html>, last function); if it is missing the write truncated — continue "
    "with str_replace rather than rewriting.\n"
    "- After editing Python, run check_python; if the project has tests, run "
    "run_tests. Fix what fails.\n"
    "- Keep the project self-contained and runnable on the device: plain "
    "Python (stdlib + Flask-style WSGI `app.py`) or static web (index.html) "
    "work best — the phone can preview both. No native/compiled dependencies.\n"
    "- Paths are always relative to the workspace root.\n"
    "- Persistent notes the user asks you to remember belong in guidelines.md.\n"
    "\n"
    "Task tracking: for any multi-step task, call todo_write FIRST with the "
    "full list of steps (one in_progress, rest pending), then call it again "
    "after finishing each step to mark it completed and start the next. This is "
    "the checklist the user watches. Skip it for trivial one-step tasks.\n"
    "\n"
    "Git: you have git_status/git_branch/git_commit/git_push/git_open_pr. The "
    "workspace is auto-committed at the end of a run, so you do NOT need to "
    "commit for normal edits. Use git_branch before editing when the user wants "
    "a PR; use git_push / git_open_pr ONLY when the user explicitly asks to "
    "publish, push, or open a pull request.\n"
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

_DELEGATE_GUIDANCE = (
    "\n\nDELEGATION: a cheap implementer model ({worker}) is available via the "
    "delegate_edit tool. You are the ORCHESTRATOR — prefer delegating file "
    "creation and mechanical edits to it: one delegate_edit per file, with a "
    "precise, self-contained instruction (name functions, describe behavior, "
    "spell out anything it cannot infer). Reserve your own write_file/"
    "str_replace for small surgical tweaks, fixes to the implementer's output, "
    "and files where exact contents matter more than cost. ALWAYS verify "
    "delegated work afterwards (read_file / check_python) — the implementer "
    "is fast, not reliable."
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
    model = os.environ.get("LEAD_MODEL", "deepseek/deepseek-v4-pro")
    fallback = (os.environ.get("AGENT_FALLBACK_MODEL") or "").strip()
    active = model  # sticky: once we fail over, stay on the fallback
    agent_tools.reset_touched()

    if plan:
        tools = agent_tools.toolset(write=False) + [_PROPOSE_PLAN_TOOL]
        system = _PLAN_SYSTEM
    else:
        tools = agent_tools.toolset(write=write)
        system = _AGENT_SYSTEM
        worker = (os.environ.get("WORKER_MODEL") or "").strip()
        if write and worker:
            system += _DELEGATE_GUIDANCE.format(worker=worker)
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
        # Mid-run steering: fold any guidance the user typed while running into
        # the conversation before the next model call. Attach to the trailing
        # tool-results / user turn so the user/assistant alternation stays valid.
        steer_msgs = _drain_steer()
        if steer_msgs:
            note = ("\n\n[User guidance mid-run — adjust course accordingly]:\n- "
                    + "\n- ".join(steer_msgs))
            if messages and messages[-1]["role"] in ("tool", "user"):
                messages[-1]["content"] = (messages[-1].get("content") or "") + note
            else:
                messages.append({"role": "user", "content": note.strip()})
            _emit("steer", text=" | ".join(steer_msgs))
        # Trim stale reads first (free, always safe), then budget-prune the rest.
        saved = _trim_superseded(messages) + prune_messages(messages)
        if saved:
            _emit("pruned", chars=saved)
        buf = _DeltaBuffer()
        try:
            r = llm.chat(active, system, messages, tools=tools,
                         max_tokens=8000, cached_context=context, on_delta=buf)
        except Exception as e:
            # Fail over to the configured fallback provider (e.g. Claude→DeepSeek)
            # and stay on it for the rest of the run. One overloaded provider
            # should not kill a run when another is keyed and ready.
            if fallback and active != fallback and not _interrupted():
                _emit("fallback", frm=active, to=fallback, detail=str(e)[:200])
                active = fallback
                buf = _DeltaBuffer()
                try:
                    r = llm.chat(active, system, messages, tools=tools,
                                 max_tokens=8000, cached_context=context, on_delta=buf)
                except Exception as e2:
                    buf.flush()
                    _emit("error", detail=str(e2)[:400])
                    final_text = f"Model call failed (both providers): {e2}"
                    break
            else:
                buf.flush()
                _emit("error", detail=str(e)[:400])
                final_text = f"Model call failed after retries: {e}"
                break
        buf.flush()
        # "Thinking off" hides reasoning from EVERY provider — not just
        # Anthropic. DeepSeek's reasoner returns reasoning_content natively, so
        # gating the display here is the only way to honor the toggle for it.
        if r.get("reasoning") and _thinking_on():
            reasoning_last = r["reasoning"]
            _emit("reason", text=_clip(r["reasoning"], 400))

        calls = r.get("tool_calls") or []
        if not calls:
            final_text = r.get("text", "")
            # Post-run verification: (1) syntax-check touched Python, then
            # (2) run the project's tests. Either failure is fed back as a
            # repair round so "done" means "parses AND passes", not just parses.
            if write and not plan and repair_left > 0:
                errs = agent_tools.check_python_files()
                if errs:
                    repair_left -= 1
                    _emit("verify_failed", which="syntax", detail=_clip(errs, 500))
                    messages.append({"role": "assistant", "content": final_text})
                    messages.append({"role": "user", "content":
                                     "Verification failed — these Python files "
                                     "have syntax errors. Fix them, re-run "
                                     "check_python, then finish:\n" + errs})
                    continue
                ran, ok, out = agent_tools.run_tests_status()
                if ran and not ok:
                    repair_left -= 1
                    _emit("verify_failed", which="tests", detail=_clip(out, 500))
                    messages.append({"role": "assistant", "content": final_text})
                    messages.append({"role": "user", "content":
                                     "Verification failed — the project's tests "
                                     "did not pass. Investigate and fix, then "
                                     "re-run run_tests and finish:\n" + out})
                    continue
            if write and not plan:
                _emit("verify_ok")
            break

        # Record the assistant turn, then execute each requested tool. Keep the
        # Anthropic thinking blocks so they replay correctly on the next turn
        # (required for extended thinking + tool use).
        messages.append({"role": "assistant", "content": r.get("text", ""),
                         "tool_calls": calls,
                         "thinking_blocks": r.get("thinking_blocks") or []})
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
                             "name": tc["name"], "content": result,
                             "_path": _arg_path(tc.get("args"))})
        if plan_out is not None or interrupted:
            final_text = r.get("text", "")
            break
    else:
        _emit("error", detail=f"step limit ({MAX_STEPS}) reached")
        final_text = (final_text or
                      f"Stopped at the {MAX_STEPS}-step safety limit. "
                      "Progress so far is in the workspace — say 'continue' to keep going.")

    u = llm.usage()
    _emit("usage", input=u["input"], output=u["output"], calls=u["calls"],
          cache=u.get("cache_read", 0))
    return {"text": final_text or "(no reply)", "reasoning": reasoning_last,
            "touched": sorted(agent_tools.TOUCHED), "plan": plan_out,
            "steps": steps, "usage": u, "interrupted": interrupted}
