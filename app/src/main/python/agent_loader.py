"""
agent_loader.py — thin indirection so the agent brain can be hot-updated.

The Kotlin layer always calls through this module. If an override directory of
downloaded .py files exists (env AGENT_OVERRIDE_DIR), those files are loaded
fresh — in dependency order, registered in sys.modules so they import each
other's override versions — whenever one of them changed on disk. So an
over-the-air update takes effect on the next task with no app restart.

Back-compat: env AGENT_OVERRIDE (a single orchestrator.py path) still works.
"""

import os
import sys
import importlib
import importlib.util

# Load order matters: leaves first, orchestrator last.
_MODULES = ["llm", "agent_tools", "agentloop", "git_ops", "localrun", "templates", "orchestrator"]

_loaded_mtimes = {}


def _override_files():
    d = os.environ.get("AGENT_OVERRIDE_DIR", "")
    files = {}
    if d and os.path.isdir(d):
        for name in _MODULES:
            fp = os.path.join(d, name + ".py")
            if os.path.exists(fp):
                files[name] = fp
    legacy = os.environ.get("AGENT_OVERRIDE", "")
    if "orchestrator" not in files and legacy and os.path.exists(legacy):
        files["orchestrator"] = legacy
    return files


def _load_module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod  # register BEFORE exec so cross-imports resolve
    spec.loader.exec_module(mod)
    return mod


def _load_orchestrator():
    files = _override_files()
    if not files:
        import orchestrator
        return orchestrator

    mtimes = {n: os.path.getmtime(p) for n, p in files.items()}
    changed = mtimes != _loaded_mtimes
    for name in _MODULES:
        if name in files:
            if changed or name not in sys.modules:
                _load_module(name, files[name])
        else:
            # Bundled version, reloaded so it links against override deps.
            if changed:
                sys.modules.pop(name, None)
            try:
                importlib.import_module(name)
            except Exception:
                # Optional module not present in this build (e.g. a newer
                # agent_loader listing a module an older APK doesn't bundle).
                # Skip it rather than break the whole agent.
                pass
    _loaded_mtimes.clear()
    _loaded_mtimes.update(mtimes)
    return sys.modules["orchestrator"]


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


def call_any(module: str, fn: str, *args):
    """Call <module>.<fn>(*args) through the OTA loader so the OVERRIDE copy of
    the module is used, not the stale bundled one. Used by the web `py.call`
    bridge so an OTA update to any module actually takes effect."""
    _load_orchestrator()  # ensures overrides are registered in sys.modules
    mod = sys.modules.get(module)
    if mod is None:
        try:
            mod = importlib.import_module(module)
        except Exception:
            return f"no such module: {module}"
    f = getattr(mod, fn, None)
    if f is None:
        return f"no such fn: {module}.{fn}"
    return f(*args)
