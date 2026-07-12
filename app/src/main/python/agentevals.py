"""
agentevals.py — diagnostics + eval harness for the on-device coding agent.

Three ways to pinpoint where the driving model (DeepSeek/Claude) goes wrong:

1. analyze_run()   — score the LAST run's event log for the failure patterns we
                     care about (tool-call spirals, verify-failure thrash,
                     provider fallbacks, crashes, wasted reads, token spend).
                     Deterministic, free, works on every real run.
2. run_scenarios() — run a suite of self-contained tasks in throwaway
                     workspaces and check the end state, so you can A/B models
                     or catch regressions after an OTA update.
3. judge_run()     — have a stronger model grade the last run's transcript for
                     reasoning quality and name specific bad decisions.

All three are OTA-updatable and callable from the web via
orchestrator wrappers (op "diagnose_last_run" / "run_evals" / "judge_last_run").
"""

import os
import json
import tempfile
from pathlib import Path


# --- shared: locate + load a run's event log --------------------------------

def _agent_dir() -> Path:
    ws = os.environ.get("AGENT_WORKSPACE") or os.path.join(
        os.environ.get("HOME", "/tmp"), "workspace")
    return Path(ws) / ".agent"


def _events_path() -> Path:
    return _agent_dir() / "run_events.jsonl"


def load_events(path=None) -> list:
    """Parse a run_events.jsonl into a list of event dicts (bad lines skipped)."""
    fp = Path(path) if path else _events_path()
    if not fp.exists():
        return []
    out = []
    for line in fp.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            out.append(json.loads(line))
        except Exception:
            pass
    return out


# --- 1. run analyzer ---------------------------------------------------------

_READ_TOOLS = {"read_file", "list_files", "grep"}
_EDIT_TOOLS = {"write_file", "str_replace", "delete_file", "delegate_edit"}


def analyze_events(events: list) -> dict:
    """Reduce a run's events to structured metrics + a list of flagged issues.

    Returns {steps, tools, reads, edits, spirals, verify_failures, fallbacks,
    errors, usage, flags:[{level, code, detail}], verdict}."""
    steps = 0
    tools = {}                 # name -> call count
    spirals = []               # [{name, count}] from loop_warn
    verify_failures = []       # [which]
    fallbacks = []             # [{from, to}]
    errors = []                # [detail]
    reads = edits = 0
    usage = {}
    structure = {}
    pruned = 0

    for ev in events:
        k = ev.get("kind")
        if k == "step":
            steps = max(steps, int(ev.get("n") or 0))
        elif k == "tool_start":
            name = ev.get("name") or "?"
            tools[name] = tools.get(name, 0) + 1
            if name in _READ_TOOLS:
                reads += 1
            elif name in _EDIT_TOOLS:
                edits += 1
        elif k == "loop_warn":
            spirals.append({"name": ev.get("name"), "count": ev.get("count")})
        elif k == "verify_failed":
            verify_failures.append(ev.get("which") or "?")
        elif k == "fallback":
            fallbacks.append({"from": ev.get("frm"), "to": ev.get("to")})
        elif k == "error":
            errors.append(ev.get("detail") or "")
        elif k == "usage":
            usage = {"input": ev.get("input", 0), "output": ev.get("output", 0),
                     "cache": ev.get("cache", 0), "calls": ev.get("calls", 0)}
        elif k == "structure":
            structure = {"files": ev.get("files", 0),
                         "max_lines": ev.get("max_lines", 0),
                         "avg_fanout": ev.get("avg_fanout", 0)}
        elif k == "pruned":
            pruned += int(ev.get("chars") or 0)

    flags = []

    def flag(level, code, detail):
        flags.append({"level": level, "code": code, "detail": detail})

    for s in spirals:
        flag("red", "spiral",
             f"repeated `{s['name']}` {s['count']}x with no progress")
    # Thrash means the SAME check failed repeatedly — the fix didn't take.
    # Distinct checks each failing once (e.g. one web round + one review
    # round) is the repair pipeline working as designed, so only warn.
    vf_counts = {}
    for w in verify_failures:
        vf_counts[w] = vf_counts.get(w, 0) + 1
    # A secrets round is red even when repaired in one pass: the credential
    # was written to disk and may survive in git history — it must be rotated.
    if vf_counts.pop("secrets", 0):
        flag("red", "secret-exposed",
             "a hardcoded credential was caught by the secret scan — even "
             "though it was removed, ROTATE that key (it may be in git history)")
    thrashed = {w: c for w, c in vf_counts.items() if c >= 2}
    if thrashed:
        flag("red", "verify-thrash",
             "same check failed repeatedly: " +
             ", ".join(f"{w}×{c}" for w, c in thrashed.items()))
    elif verify_failures:
        flag("yellow", "verify-retry",
             f"{len(verify_failures)} verify-failure round(s) "
             f"({', '.join(verify_failures)}), each fixed in one pass")
    for f in fallbacks:
        flag("yellow", "provider-fallback",
             f"switched provider {f['from']} -> {f['to']} (primary failed)")
    for e in errors:
        lvl = "red" if ("failed" in e.lower() or "step limit" in e.lower()) else "yellow"
        flag(lvl, "error", e[:160])
    if steps >= 80:
        flag("red", "step-heavy", f"{steps} steps (near the safety limit)")
    elif steps >= 50:
        flag("yellow", "step-heavy", f"{steps} steps")
    if edits and reads >= 4 * edits:
        flag("yellow", "read-heavy",
             f"{reads} reads for {edits} edits — over-investigating")
    if reads and edits == 0 and steps > 3:
        flag("yellow", "no-edits", f"{reads} reads but no edits made")
    if usage.get("output", 0) >= 40000:
        flag("yellow", "token-heavy",
             f"{usage['output']} output tokens for this run")
    # Workspace-wide structure health (the gate only blocks NEW debt, so this
    # is how legacy tangle stays visible). Thresholds mirror projectmap's.
    if structure:
        try:
            import projectmap as _pm
            max_lines, max_fan = _pm.MAX_FILE_LINES, _pm.MAX_LOCAL_IMPORTS
        except Exception:
            max_lines, max_fan = 400, 3
        if (structure["max_lines"] > max_lines
                or structure["avg_fanout"] > max_fan):
            flag("yellow", "tangled",
                 f"workspace structure: largest file {structure['max_lines']} "
                 f"lines, avg fan-out {structure['avg_fanout']}")

    reds = sum(1 for f in flags if f["level"] == "red")
    yellows = sum(1 for f in flags if f["level"] == "yellow")
    if reds:
        verdict = f"PROBLEMATIC — {reds} serious issue(s), {yellows} warning(s)"
    elif yellows:
        verdict = f"OK with {yellows} warning(s)"
    else:
        verdict = "CLEAN — no red flags"

    return {"steps": steps, "tools": tools, "reads": reads, "edits": edits,
            "spirals": spirals, "verify_failures": verify_failures,
            "fallbacks": fallbacks, "errors": errors, "usage": usage,
            "structure": structure, "pruned": pruned, "flags": flags,
            "verdict": verdict}


def format_report(m: dict) -> str:
    """Human-readable scorecard from analyze_events output."""
    lines = ["=== Run diagnosis ===", m["verdict"], ""]
    lines.append(f"steps: {m['steps']}   reads: {m['reads']}   edits: {m['edits']}")
    if m["tools"]:
        top = sorted(m["tools"].items(), key=lambda kv: -kv[1])[:8]
        lines.append("tools: " + ", ".join(f"{n}×{c}" for n, c in top))
    u = m["usage"]
    if u:
        lines.append(f"tokens: {u.get('input', 0)} in / {u.get('output', 0)} out"
                     f" (cache {u.get('cache', 0)}, {u.get('calls', 0)} calls)")
    s = m.get("structure")
    if s:
        lines.append(f"structure: {s['files']} files, largest "
                     f"{s['max_lines']} lines, avg fan-out {s['avg_fanout']}")
    if m["flags"]:
        lines.append("")
        lines.append("Issues:")
        for f in m["flags"]:
            mark = "🔴" if f["level"] == "red" else "🟡"
            lines.append(f"  {mark} [{f['code']}] {f['detail']}")
    else:
        lines.append("\nNo issues flagged.")
    return "\n".join(lines)


def analyze_run(path=None) -> str:
    """Diagnose the last run (or a given events file). Text scorecard."""
    events = load_events(path)
    if not events:
        return "No run events found to analyze (run the agent first)."
    return format_report(analyze_events(events))


# --- automatic post-run diagnosis -------------------------------------------
# Called by the orchestrator at the end of EVERY run, so issues surface without
# anyone remembering to tap "Diagnose". It (a) records a one-line verdict to a
# rolling history file for trend review, and (b) returns a short warning to
# append to the reply ONLY when the run had real problems — silent on clean runs.

_HISTORY_MAX = 200


def _history_path() -> Path:
    return _agent_dir() / "diagnoses.jsonl"


def _append_history(metrics: dict, run_id: str = "") -> None:
    try:
        fp = _history_path()
        rec = {"run_id": run_id, "verdict": metrics["verdict"],
               "steps": metrics["steps"],
               "flags": [f["code"] for f in metrics["flags"]]}
        lines = fp.read_text(encoding="utf-8").splitlines() if fp.exists() else []
        lines.append(json.dumps(rec))
        fp.write_text("\n".join(lines[-_HISTORY_MAX:]) + "\n", encoding="utf-8")
    except Exception:
        pass


def auto_note(path=None, surface="red", run_id="") -> str:
    """Analyze the just-finished run, log it, and return a short warning to show
    the user — but only when there's something worth flagging. surface='red'
    (default) speaks up only on serious issues; 'all' also reports warnings."""
    events = load_events(path)
    if not events:
        return ""
    m = analyze_events(events)
    _append_history(m, run_id)
    reds = [f for f in m["flags"] if f["level"] == "red"]
    show = reds if surface != "all" else m["flags"]
    if not show:
        return ""
    body = "\n".join(f"  • {f['detail']}" for f in show[:5])
    return ("\n⚠️ Auto-diagnosis — this run showed problems:\n" + body
            + "\n(Open ☰ → Agent tests → Diagnose run for the full scorecard.)")


def diagnosis_history(_=None) -> str:
    """Recent runs' verdicts — spot recurring failure patterns over time."""
    fp = _history_path()
    if not fp.exists():
        return "No run history yet."
    rows = []
    for line in fp.read_text(encoding="utf-8").splitlines()[-20:]:
        try:
            rows.append(json.loads(line))
        except Exception:
            pass
    if not rows:
        return "No run history yet."
    out = ["=== Recent runs (newest last) ==="]
    for r in rows:
        flags = (" · " + ",".join(r["flags"])) if r.get("flags") else ""
        out.append(f"steps {r.get('steps', '?'):>3}  {r.get('verdict', '')}{flags}")
    codes = {}
    for r in rows:
        for c in r.get("flags", []):
            codes[c] = codes.get(c, 0) + 1
    if codes:
        top = sorted(codes.items(), key=lambda kv: -kv[1])
        out.append("\nMost common issues: "
                   + ", ".join(f"{c}×{n}" for c, n in top))
    return "\n".join(out)


# --- 2. scenario suite -------------------------------------------------------
# Each scenario is self-contained: a task string + a checker that inspects the
# resulting workspace and returns (passed, note). Scenarios run in a throwaway
# temp workspace so they never touch the user's project. They exercise REAL
# model reasoning + tool use + the verify loop, scored deterministically.

def _check_file_contains(ws: Path, name: str, needles) -> tuple:
    fp = ws / name
    if not fp.exists():
        return False, f"{name} was not created"
    text = fp.read_text(encoding="utf-8", errors="ignore")
    missing = [n for n in needles if n not in text]
    if missing:
        return False, f"{name} missing: {', '.join(missing)}"
    return True, f"{name} looks right"


def _check_python_runs(ws: Path, name: str, snippet: str, expect: str) -> tuple:
    """Import/execute a tiny check snippet against the generated file."""
    fp = ws / name
    if not fp.exists():
        return False, f"{name} was not created"
    import subprocess
    code = f"import sys; sys.path.insert(0, {str(ws)!r})\n{snippet}"
    try:
        out = subprocess.run(["python3", "-c", code], capture_output=True,
                             text=True, timeout=20)
    except Exception as e:
        return False, f"could not run check: {e}"
    got = (out.stdout or "").strip()
    if out.returncode != 0:
        return False, f"error: {(out.stderr or '').strip()[:160]}"
    if expect not in got:
        return False, f"expected {expect!r}, got {got!r}"
    return True, f"runs and prints {expect}"


SCENARIOS = [
    {
        "name": "python-factorial",
        "task": ("Create a file mathutil.py with a function factorial(n) that "
                 "returns n! (iterative, factorial(0)==1). Nothing else."),
        "check": lambda ws: _check_python_runs(
            ws, "mathutil.py",
            "import mathutil; print(mathutil.factorial(5))", "120"),
    },
    {
        "name": "fix-bug",
        "task": ("The file buggy.py has a function add(a,b) that wrongly returns "
                 "a-b. Fix it to return a+b. Change only what's needed."),
        "setup": {"buggy.py": "def add(a, b):\n    return a - b\n"},
        "check": lambda ws: _check_python_runs(
            ws, "buggy.py", "import buggy; print(buggy.add(2,3))", "5"),
    },
    {
        "name": "web-static",
        "task": ("Create index.html: a valid HTML5 page with a <canvas> element "
                 "whose id is 'game' and a <script src=\"game.js\"></script>. "
                 "Also create game.js that draws a red rectangle on that canvas."),
        "check": lambda ws: _check_file_contains(
            ws, "index.html", ["<canvas", "game", "game.js"]),
    },
]


def run_scenarios(names=None, model=None) -> str:
    """Run scenarios against the agent in throwaway workspaces and score them.

    names: comma-separated subset (or None for all). model: override LEAD_MODEL
    for an A/B (e.g. 'anthropic/claude-sonnet-5' vs 'deepseek/deepseek-v4-pro').
    """
    want = None
    if names:
        want = {n.strip() for n in str(names).replace(",", " ").split() if n.strip()}
    chosen = [s for s in SCENARIOS if not want or s["name"] in want]
    if not chosen:
        return ("No matching scenarios. Available: "
                + ", ".join(s["name"] for s in SCENARIOS))

    import agentloop
    prev_ws = os.environ.get("AGENT_WORKSPACE")
    prev_model = os.environ.get("LEAD_MODEL")
    if model:
        os.environ["LEAD_MODEL"] = str(model)

    results = []
    passed = 0
    try:
        for sc in chosen:
            ws = Path(tempfile.mkdtemp(prefix="eval_" + sc["name"] + "_"))
            (ws / ".agent").mkdir(parents=True, exist_ok=True)
            for fn, content in (sc.get("setup") or {}).items():
                (ws / fn).write_text(content, encoding="utf-8")
            os.environ["AGENT_WORKSPACE"] = str(ws)
            try:
                run = agentloop.run(sc["task"], write=True)
                ok, note = sc["check"](ws)
                diag = analyze_events(load_events(ws / ".agent" / "run_events.jsonl"))
                results.append({
                    "name": sc["name"], "passed": ok, "note": note,
                    "steps": run.get("steps"),
                    "flags": [f"{f['code']}" for f in diag["flags"]],
                })
                if ok:
                    passed += 1
            except Exception as e:
                results.append({"name": sc["name"], "passed": False,
                                "note": f"harness error: {e}", "steps": None,
                                "flags": []})
    finally:
        if prev_ws is not None:
            os.environ["AGENT_WORKSPACE"] = prev_ws
        else:
            os.environ.pop("AGENT_WORKSPACE", None)
        if model:
            if prev_model is not None:
                os.environ["LEAD_MODEL"] = prev_model
            else:
                os.environ.pop("LEAD_MODEL", None)

    lines = [f"=== Scenario suite: {passed}/{len(results)} passed"
             + (f"  (model={model})" if model else "") + " ==="]
    for r in results:
        mark = "✅" if r["passed"] else "❌"
        extra = f" · steps={r['steps']}" if r["steps"] is not None else ""
        if r["flags"]:
            extra += " · flags: " + ",".join(r["flags"])
        lines.append(f"{mark} {r['name']} — {r['note']}{extra}")
    return "\n".join(lines)


# --- 3. LLM judge ------------------------------------------------------------

_JUDGE_SYSTEM = (
    "You are a strict reviewer of an AI coding agent's run. You are given a "
    "compressed trace of what the agent did (its reasoning snippets, the tools "
    "it called, verification outcomes, and any errors). Grade the agent's "
    "PROCESS, not just the outcome.\n"
    "Score 1-5 (5=excellent) on: planning, tool efficiency, error recovery, and "
    "whether it avoided spirals/waste. Then list up to 5 SPECIFIC mistakes or "
    "missed opportunities, each with the concrete step it happened at. Be "
    "terse. End with a one-line verdict."
)


def _trace_from_events(events: list, limit: int = 120) -> str:
    """A compact, judge-friendly trace from the event log."""
    out = []
    for ev in events:
        k = ev.get("kind")
        if k == "reason":
            out.append("think: " + (ev.get("text") or "")[:200])
        elif k == "say":
            out.append("say: " + (ev.get("text") or "")[:200])
        elif k == "tool_start":
            out.append(f"tool: {ev.get('name')} {ev.get('detail') or ''}".strip())
        elif k == "tool_done":
            r = (ev.get("result") or "")[:120]
            if r:
                out.append(f"  -> {r}")
        elif k == "verify_failed":
            out.append(f"VERIFY FAILED ({ev.get('which')}): {(ev.get('detail') or '')[:120]}")
        elif k == "loop_warn":
            out.append(f"LOOP GUARD: repeated {ev.get('name')} {ev.get('count')}x")
        elif k == "fallback":
            out.append(f"PROVIDER FALLBACK {ev.get('frm')} -> {ev.get('to')}")
        elif k == "error":
            out.append("ERROR: " + (ev.get("detail") or "")[:160])
    if len(out) > limit:
        out = out[:limit // 2] + ["… (trace trimmed) …"] + out[-limit // 2:]
    return "\n".join(out)


def judge_run(path=None, model=None) -> str:
    """Grade the last run's transcript with a stronger model. Uses the configured
    judge model (AGENT_JUDGE_MODEL), else the fallback, else the lead model."""
    events = load_events(path)
    if not events:
        return "No run events found to judge (run the agent first)."
    trace = _trace_from_events(events)
    if not trace.strip():
        return "The run has no reasoning/tool trace to judge."
    _def_lead = "deepseek/deepseek-v4-pro"
    judge = (model or os.environ.get("AGENT_JUDGE_MODEL")
             or os.environ.get("AGENT_FALLBACK_MODEL")
             or os.environ.get("LEAD_MODEL") or _def_lead)
    import llm
    # Judge uses orchestrator effort — it's an evaluator, not a worker.
    os.environ["AGENT_EFFORT"] = os.environ.get("AGENT_ORCH_EFFORT",
        os.environ.get("AGENT_EFFORT", "medium"))
    text, _reasoning = llm.chat_text(
        judge, _JUDGE_SYSTEM,
        "Here is the agent run trace to grade:\n\n" + trace, max_tokens=1200)
    return "=== LLM judge (" + judge + ") ===\n" + (text or "(no verdict)")
