"""
agent_loader.py — thin indirection so the agent brain can be hot-updated.

The Kotlin layer always calls agent_loader.run_task(). If an override copy of
orchestrator.py has been downloaded into app storage (env AGENT_OVERRIDE points
at it), we load and run *that* file fresh on every call — so an over-the-air
update takes effect on the next task with no app restart. Otherwise we fall
back to the orchestrator.py bundled inside the APK.
"""

import os
import importlib.util


def _load_orchestrator():
    override = os.environ.get("AGENT_OVERRIDE")
    if override and os.path.exists(override):
        # Load the downloaded file fresh each time (no import cache) so edits
        # are picked up immediately.
        spec = importlib.util.spec_from_file_location("orchestrator_live", override)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        return mod
    import orchestrator
    return orchestrator


def run_task(task: str) -> str:
    return _load_orchestrator().run_task(task)


def execute_plan() -> str:
    return _load_orchestrator().execute_plan()


def op(name: str, arg: str = "") -> str:
    """Generic OTA entry point: call orchestrator.<name>(arg?) from the web."""
    mod = _load_orchestrator()
    fn = getattr(mod, name, None)
    if fn is None:
        return f"no such op: {name}"
    return fn(arg) if arg != "" else fn()
