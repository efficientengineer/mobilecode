"""
workflows.py — multi-agent workflows: fan out to several worker agents in
parallel, then have the lead model judge/score the results.

The orchestrator (lead) drives these via tools:
  - brainstorm: N idea agents in parallel → scored, ranked ideas to present.
  - delegate_parallel: build several independent files at once.

On-device this uses threads. The worker calls are network-bound (LLM API), so
they run genuinely concurrently despite the GIL. Everything is bounded (agent
count capped) and uses the cheap WORKER_MODEL for the fan-out, the LEAD_MODEL
for judging.
"""

import os
import re
import json
import concurrent.futures

import llm

_MAX_AGENTS = 8
_MAX_PARALLEL = 6

# Distinct creative lenses so ideation agents diverge instead of converging.
_LENSES = ["minimalist and elegant", "chaotic and playful", "narrative-driven",
           "competitive and skill-based", "cozy and relaxing", "retro arcade",
           "surprising or subversive", "tactile and physical"]


def _lead():
    return os.environ.get("LEAD_MODEL", "deepseek/deepseek-v4-pro")


def _worker():
    return (os.environ.get("WORKER_MODEL") or "").strip() or _lead()


def _reviewer():
    """The reviewer model: the chosen one, else the fallback, else the lead."""
    return (os.environ.get("AGENT_REVIEWER_MODEL") or "").strip() \
        or (os.environ.get("AGENT_FALLBACK_MODEL") or "").strip() or _lead()


def _review_enabled():
    return (os.environ.get("AGENT_REVIEW", "1") != "0"
            and os.environ.get("AGENT_FRUGAL", "0") != "1")


def _cap(n, default=4):
    try:
        n = int(n)
    except Exception:
        n = default
    return max(1, min(n, _MAX_AGENTS))


def fan_out(prompt, n=4, system="", model=None, max_tokens=1500, angles=None):
    """Run n agents concurrently on `prompt`; return [{idx, angle, text}] in order.

    Each agent gets a distinct angle (or a be-different nudge) so the outputs
    diverge. A failed agent yields a short placeholder instead of aborting.
    """
    n = _cap(n)
    model = model or _worker()
    angles = list(angles) if angles else []

    def one(i):
        angle = angles[i] if i < len(angles) else ""
        p = prompt
        if angle:
            p += f"\n\nApproach it through this lens: {angle}."
        else:
            p += f"\n\n(You are variant {i + 1} of {n} — be genuinely different from the others.)"
        try:
            # Set effort for the worker model.
            os.environ["AGENT_EFFORT"] = os.environ.get("AGENT_IMPL_EFFORT",
                os.environ.get("AGENT_EFFORT", "off"))
            text, _ = llm.chat_text(model, system, p, max_tokens=max_tokens)
        except Exception as e:
            text = f"(variant {i + 1} failed: {type(e).__name__})"
        return {"idx": i, "angle": angle, "text": (text or "").strip()}

    with concurrent.futures.ThreadPoolExecutor(max_workers=min(n, _MAX_PARALLEL)) as ex:
        out = list(ex.map(one, range(n)))
    return sorted(out, key=lambda r: r["idx"])


def _parse_ranking(text, count):
    """Tolerant parse of the judge's JSON → (ranking list, best index)."""
    s = (text or "").strip()
    if s.startswith("```"):
        parts = s.split("```")
        s = parts[1] if len(parts) >= 2 else s.strip("`")
        if s.lower().startswith("json"):
            s = s[4:]
    m = re.search(r"\{.*\}", s, re.S)
    if not m:
        return [], 1
    try:
        data = json.loads(m.group(0))
    except Exception:
        return [], 1
    clean = []
    for r in data.get("ranking") or []:
        try:
            nn = int(r.get("n"))
        except Exception:
            continue
        if 1 <= nn <= count:
            try:
                sc = float(r.get("score", 0))
            except Exception:
                sc = 0.0
            clean.append({"n": nn, "score": sc, "why": str(r.get("why", "")).strip()})
    try:
        best = int(data.get("best"))
    except Exception:
        best = clean[0]["n"] if clean else 1
    if not (1 <= best <= count):
        best = clean[0]["n"] if clean else 1
    return clean, best


def score(candidates, criteria="", model=None):
    """Judge candidates with the lead model. Returns {ranking:[{n,score,why}], best}."""
    model = model or _lead()
    numbered = "\n\n".join(f"[{i + 1}]\n{c['text'][:2000]}"
                           for i, c in enumerate(candidates))
    system = ("You are a sharp, honest judge. Score each candidate 0-10 on how well "
              "it meets the goal and how strong it is, with a terse one-line reason. "
              'Return ONLY JSON: {"ranking":[{"n":<1-based index>,"score":<0-10>,'
              '"why":"..."}],"best":<n>}, best first.')
    goal = f"GOAL / CRITERIA:\n{criteria}\n\n" if criteria else ""
    try:
        # Set effort for the lead (orchestrator) model.
        os.environ["AGENT_EFFORT"] = os.environ.get("AGENT_ORCH_EFFORT",
            os.environ.get("AGENT_EFFORT", "medium"))
        text, _ = llm.chat_text(model, system, goal + "CANDIDATES:\n" + numbered,
                                max_tokens=1000)
    except Exception:
        return {"ranking": [], "best": 1}
    ranking, best = _parse_ranking(text, len(candidates))
    return {"ranking": ranking, "best": best}


def ideate(topic, n=4, criteria=""):
    """Fan out n idea-generators (diverse lenses), score them, return ranked."""
    n = _cap(n)
    system = ("You are a brilliant game/app designer. Produce ONE concrete, "
              "specific, vivid idea for the request — no preamble, no lists of "
              "options, just the single idea in a few tight sentences.")
    angles = _LENSES[:n]
    cands = fan_out(topic, n=n, system=system, angles=angles)
    ranked = score(cands, criteria or topic)
    return {"topic": topic, "candidates": cands,
            "ranking": ranked["ranking"], "best": ranked["best"]}


def parallel_edits(items):
    """Build several files concurrently, one worker per file. `items` is a list of
    {path, instruction}. Returns [{path, result}] once all finish."""
    import agent_tools
    valid = [it for it in (items or [])
             if isinstance(it, dict) and str(it.get("path", "")).strip()][:_MAX_AGENTS]
    if not valid:
        return []

    def one(it):
        try:
            r = agent_tools.t_delegate_edit(path=it["path"],
                                            instruction=it.get("instruction", ""))
        except Exception as e:
            r = f"(failed: {type(e).__name__}: {e})"
        return {"path": it["path"], "instruction": it.get("instruction", ""), "result": r}

    with concurrent.futures.ThreadPoolExecutor(max_workers=min(len(valid), _MAX_PARALLEL)) as ex:
        built = list(ex.map(one, valid))

    # Reviewer POOL: one reviewer per built file, checking it against ITS spec,
    # in parallel — so parallel implementers get parallel reviews. Only when
    # review is enabled and there are ≥2 outputs (a single file is cheaper to
    # review as part of the end-of-run diff review).
    if _review_enabled() and len(built) >= 2:
        model = _reviewer()

        def rev(entry):
            try:
                ok, report = agent_tools.review_file(model, entry["path"],
                                                     entry["instruction"])
            except Exception:
                ok, report = True, ""
            entry["review_ok"] = ok
            entry["review"] = report
            return entry

        with concurrent.futures.ThreadPoolExecutor(
                max_workers=min(len(built), _MAX_PARALLEL)) as ex:
            built = list(ex.map(rev, built))
    return built
