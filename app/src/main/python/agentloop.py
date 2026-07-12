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

MAX_STEPS = int(os.environ.get("AGENT_MAX_STEPS", "120"))
REPAIR_ROUNDS = 2


# --- events / interrupt (same file + flag the orchestrator uses) -----------

_AGENT_DIR_CACHE = {}


def _agent_dir() -> Path:
    ws = os.environ.get("AGENT_WORKSPACE") or os.path.join(
        os.environ.get("HOME", "/tmp"), "workspace")
    d = _AGENT_DIR_CACHE.get(ws)
    if d is None:
        # mkdir once per workspace, not on every event — _emit flushes a delta
        # every ~160 chars, so a long response fired hundreds of syscalls here.
        d = Path(ws) / ".agent"
        d.mkdir(parents=True, exist_ok=True)
        _AGENT_DIR_CACHE[ws] = d
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
    # Reasoning is captured/shown only when effort is on. Frugal forces it off
    # (the biggest avoidable output cost). AGENT_EFFORT (off/low/medium/high) is
    # the control; the legacy AGENT_THINKING on/off toggle is the fallback.
    if _frugal_on():
        return False
    e = (os.environ.get("AGENT_EFFORT", "") or "").strip().lower()
    if e in ("off", "none", "0"):
        return False
    if e in ("low", "medium", "high", "max"):
        return True
    return os.environ.get("AGENT_THINKING", "0") == "1"


def _review_on() -> bool:
    # Independent code review is on by default; frugal mode (cost-saving) and an
    # explicit AGENT_REVIEW=0 turn it off.
    return not _frugal_on() and os.environ.get("AGENT_REVIEW", "1") != "0"


def _reviewer_model(active: str) -> str:
    """A STRONGER/DIFFERENT model to review the lead's work when configured;
    falls back to the run's fallback model, then the active lead."""
    return (os.environ.get("AGENT_REVIEWER_MODEL", "").strip()
            or os.environ.get("AGENT_FALLBACK_MODEL", "").strip()
            or active)


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

# Budget is deliberately HIGH: with provider prompt caching, carrying the
# growing transcript is cheap (cache hits), while editing earlier messages to
# "save" context invalidates the cache and makes the model re-read — costing
# MORE. So we only prune when genuinely near the context window.
_LOOP_DEFAULTS = {"loopBudget": 300000, "keepSteps": 6}


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
    return s


def _msg_len(m) -> int:
    return len(m.get("content") or "")


def prune_messages(messages: list) -> int:
    """Only act when the transcript is genuinely near the context limit.

    Below budget we change NOTHING — editing earlier messages invalidates the
    provider prompt cache (so the whole tail is re-billed at full price) and
    makes the model re-read files, which costs MORE than carrying the cached
    history. Over budget: drop stale reads first, then elide the oldest tool
    results outside the protected tail (last `keepSteps` assistant turns).
    """
    s = _loop_settings()
    budget = s["loopBudget"]
    if budget <= 0 or sum(_msg_len(m) for m in messages) <= budget:
        return 0
    saved = _trim_superseded(messages)
    if sum(_msg_len(m) for m in messages) <= budget:
        return saved
    cutoff, seen = 0, 0
    for i in range(len(messages) - 1, -1, -1):
        if messages[i]["role"] == "assistant":
            seen += 1
            if seen >= s["keepSteps"]:
                cutoff = i
                break
    for m in messages[1:cutoff]:
        if m["role"] == "tool" and _msg_len(m) > 200 and \
                not m.get("content", "").startswith(("(elided ", "(stale")):
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
    "- A PROJECT OUTLINE and DEPENDENCY MAP are in your context every turn. USE "
    "THEM: to work on a feature, open its entry file (from the map) and follow "
    "that file's import edges — read only those files. Do NOT list_files or grep "
    "across the whole project when the map already shows where a feature lives; "
    "search only for something the map doesn't cover.\n"
    "- Look before you leap: read the specific files you will change BEFORE "
    "editing them. Never guess at file contents.\n"
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
    "- Reuse well-known libraries instead of building engines from scratch, and "
    "load them from a PINNED CDN — a <script src> tag or an ESM import map. For "
    "a 3D game DEFAULT to Babylon.js (pin a version, e.g. "
    "https://cdn.jsdelivr.net/npm/babylonjs@7/babylon.js); use Phaser for 2D. "
    "NEVER paste a library's source or a minified bundle into the workspace: "
    "reference it by URL so it loads at runtime and never enters context (the "
    "on-device preview has network). Prefer libraries you know well over obscure "
    "ones — the model already knows their API, so you write only small glue "
    "code.\n"
    "- For MULTIPLAYER default to PeerJS (WebRTC peer-to-peer) from a pinned CDN "
    "— there is no server to host, so it runs directly in the on-device preview. "
    "Pattern: one peer hosts and its peer id is the room code; others connect to "
    "that id; sync player inputs/positions over the data connection on a fixed "
    "tick, and reconcile on the host. Keep networking in its own small file "
    "(e.g. net.js), separate from the game/render code.\n"
    "- When a BEST PRACTICES block appears in your context, treat it as "
    "REQUIRED, not optional. It encodes how to build a good mobile app/game — "
    "e.g. movement is a floating joystick under the thumb, not fixed on-screen "
    "buttons; layout respects the safe area; the loop uses delta time. The "
    "user's own practices there override the built-in ones.\n"
    "- Use your MULTI-AGENT tools when a task calls for them: brainstorm(topic, "
    "count) runs several idea agents in PARALLEL and returns scored, ranked "
    "ideas — use it whenever the user wants options/concepts to choose from (art "
    "directions, mechanics, names, enemy or level designs); present the ranked "
    "ideas and ask which to build. delegate_parallel builds several independent "
    "files at once. Prefer these over doing everything yourself, one step at a "
    "time, when the work naturally fans out.\n"
    "- Verify as you GO, not only at the end: after writing Python run "
    "check_python; after writing HTML/JS run check_web; run run_tests once the "
    "pieces a test needs exist. Fix what fails before continuing.\n"
    "- Keep the project self-contained and runnable on the device: plain "
    "Python (stdlib + Flask-style WSGI `app.py`) or static web (index.html) "
    "work best — the phone can preview both. No native/compiled dependencies.\n"
    "- Paths are always relative to the workspace root.\n"
    "- Persistent notes the user asks you to remember belong in guidelines.md.\n"
    "\n"
    "Task tracking & step-by-step verification: for any multi-step task, call "
    "todo_write FIRST with the full list of steps (one in_progress, rest "
    "pending). Then work ONE step at a time: implement it, VERIFY it works (run "
    "check_python / check_web, and run_tests when its dependencies exist), fix "
    "anything broken, and only THEN mark that step completed and start the next. "
    "Do NOT build the whole app and check only at the end — that lets errors "
    "pile up. Marking a step completed triggers an automatic self-check of the "
    "code you touched; if it flags a problem, fix it before moving on. Skip "
    "todos only for trivial one-step tasks.\n"
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
    "\n\nDELEGATION (IMPORTANT — this is how you must work): a cheap implementer "
    "model ({worker}) is available via the delegate_edit tool, and you are the "
    "ORCHESTRATOR. Delegating is your DEFAULT, not an option:\n"
    "- Create EVERY new file with delegate_edit — one call per file — giving a "
    "precise, self-contained spec: exact path, what the file must contain, the "
    "function/class names and signatures, the behavior, and anything it cannot "
    "infer from context.\n"
    "- Make SUBSTANTIAL edits to an existing file with delegate_edit too "
    "(describe the change precisely).\n"
    "- Use write_file / str_replace YOURSELF only for small surgical changes "
    "(roughly < 10 lines) or to FIX the worker's output.\n"
    "- After each delegate_edit, verify the result (read_file / check_python / "
    "check_web) and correct it if wrong — the worker is fast, not reliable.\n"
    "Do NOT hand-write whole files yourself; that wastes the expensive lead on "
    "typing. Plan → delegate → verify → integrate."
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
        extra_system: str = "", on_say=None) -> dict:
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
        # Only push delegation when there's a genuinely CHEAPER worker (a distinct
        # model) and the user hasn't turned it off — delegating to the same model
        # just adds round-trips.
        if (write and worker and worker != active
                and os.environ.get("AGENT_DELEGATE", "").strip().lower() != "off"):
            system += _DELEGATE_GUIDANCE.format(worker=worker)
    # System-wide guidelines — the durable "how to operate" contract applied on
    # EVERY task/project/session (OTA-updatable via sysguide.py). Imported lazily
    # so an older build without it still runs.
    try:
        import sysguide
        system += "\n\n" + sysguide.render()
    except Exception:
        pass
    if extra_system:
        system += "\n\n" + extra_system

    messages = [{"role": "user", "content": task}]
    final_text, reasoning_last = "", ""
    plan_out = None
    interrupted = False
    repair_left = REPAIR_ROUNDS
    review_left = 1          # independent code review runs at most once per run
    steps = 0
    # Anti-spiral: count identical tool calls (name + args) so we can nudge the
    # model off a loop before it burns the whole step budget retrying the same
    # failing action — the #1 way a run gets stuck. Nudge once per signature.
    call_counts = {}
    nudged = set()
    REPEAT_LIMIT = 3

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
        # Prune ONLY when near the context limit — otherwise we keep the cache
        # warm (cheaper) instead of thrashing it. See prune_messages.
        saved = prune_messages(messages)
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
        # The assistant's PROSE for this step (the message that accompanies its
        # tool calls) is a real chat message, not step noise — surface it as its
        # own event so the UI shows it as a bubble, and persist it (display-only,
        # via on_say) so it survives a reload without re-entering model context.
        say = (r.get("text") or "").strip()
        if calls and say:
            _emit("say", text=r.get("text", ""), step=steps)
            if on_say:
                try:
                    on_say(r.get("text", ""))
                except Exception:
                    pass
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
                    messages.append({"role": "assistant", "content": final_text,
                                     "reasoning": r.get("reasoning", "")})
                    messages.append({"role": "user", "content":
                                     "Verification failed — these Python files "
                                     "have syntax errors. Fix them, re-run "
                                     "check_python, then finish:\n" + errs})
                    continue
                ran, ok, out = agent_tools.run_tests_status()
                if ran and not ok:
                    repair_left -= 1
                    _emit("verify_failed", which="tests", detail=_clip(out, 500))
                    messages.append({"role": "assistant", "content": final_text,
                                     "reasoning": r.get("reasoning", "")})
                    messages.append({"role": "user", "content":
                                     "Verification failed — the project's tests "
                                     "did not pass. Investigate and fix, then "
                                     "re-run run_tests and finish:\n" + out})
                    continue
                # (3) static-check touched web files: a <script>/<link>/import
                # pointing at a local file that doesn't exist is deterministic
                # breakage the model often misses. (Runtime JS errors are caught
                # separately by the headless preview check.)
                try:
                    web_hard, _web_soft = agent_tools.check_web_files()
                except Exception:
                    web_hard = ""
                if web_hard:
                    repair_left -= 1
                    _emit("verify_failed", which="web", detail=_clip(web_hard, 500))
                    messages.append({"role": "assistant", "content": final_text,
                                     "reasoning": r.get("reasoning", "")})
                    messages.append({"role": "user", "content":
                                     "Verification failed — web files reference "
                                     "local files that do not exist. Create them "
                                     "or fix the paths, then finish:\n" + web_hard})
                    continue
                # (4) Independent code review by a stronger/different model, once
                # the mechanical checks pass. A BLOCK verdict on real correctness/
                # security issues is fed back as one repair round; runs at most
                # once so it can't loop.
                if review_left > 0 and _review_on() and agent_tools.TOUCHED:
                    review_left -= 1
                    reviewer = _reviewer_model(active)
                    _emit("review_start", model=reviewer)
                    try:
                        block, report = agent_tools.review_changes(reviewer, task)
                    except Exception:
                        block, report = False, ""
                    if report:
                        _emit("review", block=block, detail=_clip(report, 500))
                    if block:
                        _emit("verify_failed", which="review", detail=_clip(report, 500))
                        messages.append({"role": "assistant", "content": final_text,
                                         "reasoning": r.get("reasoning", "")})
                        messages.append({"role": "user", "content":
                                         "A code review of your change found issues "
                                         "that must be fixed before finishing. "
                                         "Address each, then finish:\n" + report})
                        continue
            if write and not plan:
                _emit("verify_ok")
            break

        # Record the assistant turn, then execute each requested tool. Keep the
        # Anthropic thinking blocks so they replay correctly on the next turn
        # (required for extended thinking + tool use).
        messages.append({"role": "assistant", "content": r.get("text", ""),
                         "tool_calls": calls,
                         "reasoning": r.get("reasoning", ""),
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
                extra = {}
                # For str_replace, include old/new snippets so the UI can show a mini-diff
                if tc["name"] == "str_replace":
                    old = tc["args"].get("old", "")
                    new = tc["args"].get("new", "")
                    if old: extra["old"] = _clip(old, 200)
                    if new: extra["new"] = _clip(new, 200)
                elif tc["name"] == "delegate_edit":
                    inst = tc["args"].get("instruction", "")
                    if inst: extra["instruction"] = _clip(inst, 300)
                _emit("tool_start", name=tc["name"], detail=_clip(detail, 120), **extra)
                result = agent_tools.execute(tools, tc["name"], tc["args"])
                _emit("tool_done", name=tc["name"], detail=_clip(detail, 120),
                      result=_clip(result.splitlines()[0] if result else "", 160))
            messages.append({"role": "tool", "tool_call_id": tc["id"],
                             "name": tc["name"], "content": result,
                             "_path": _arg_path(tc.get("args"))})
            # Track exact-repeat calls (skip read-only inspection, which is fine
            # to repeat). When one crosses the limit, queue a one-time nudge.
            if tc["name"] not in ("read_file", "list_files", "grep",
                                  "todo_write", "note_write"):
                try:
                    sig = tc["name"] + "|" + json.dumps(tc.get("args") or {},
                                                        sort_keys=True)[:400]
                except Exception:
                    sig = tc["name"]
                call_counts[sig] = call_counts.get(sig, 0) + 1
                if call_counts[sig] >= REPEAT_LIMIT and sig not in nudged:
                    nudged.add(sig)
                    _emit("loop_warn", name=tc["name"], count=call_counts[sig])
                    nudge = (
                        f"\n\n[Loop guard] You've called `{tc['name']}` with the "
                        f"same arguments {call_counts[sig]} times and it is not "
                        "making progress. STOP repeating it. Either take a "
                        "genuinely different approach, or if this needs a decision, "
                        "permission, or a tool you don't have, say so plainly and "
                        "stop — do not keep retrying.")
                    if messages and messages[-1]["role"] in ("tool", "user"):
                        messages[-1]["content"] = (
                            messages[-1].get("content") or "") + nudge
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
