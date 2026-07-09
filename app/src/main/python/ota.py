"""
ota.py — the manifest-driven OTA loader: update ANY runtime file of the app.

The Kotlin layer is a dumb bootstrap (fetch nothing, decide nothing): it calls
ota.update(kind) and reloads the UI afterwards. Everything else — what to
fetch, where it lands, verification, deletions — is driven by the repo's
ota_manifest.json and THIS module. Both are plain files, so the update logic
itself updates over the air: update() first refreshes ota.py from the repo and
delegates to the fresh copy before doing any work (two-phase, self-hosting).

Manifest (v2 — v1 keys still honored):
  {
    "version": 2,
    "loader": "app/src/main/python/ota.py",       # self-update source
    "python": ["llm.py", ...],                    # repo app/src/main/python/<f> -> py root
    "web":    ["index.html", "sub/x.js", ...],    # repo app/src/main/assets/web/<f> -> web root
    "extra":  [{"path": "repo/path", "root": "py|web|files|home",
                "dest": "rel/path", "sha256": "..."}],   # anything else
    "remove": [{"root": "py", "dest": "dead_module.py"}] # prune obsolete files
  }

Roots (device destinations, exported by Kotlin, HOME-relative fallbacks):
  py    -> AGENT_OVERRIDE_DIR   (hot-loaded python modules)
  web   -> OTA_WEB_DIR          (the WebView UI)
  files -> OTA_FILES_DIR        (app-private files/)
  home  -> HOME

Safety: every file is fetched (and sha256-verified when given) BEFORE anything
is written, each write goes through a temp file + atomic rename, and dests are
confined to their root (no traversal). A failed fetch changes nothing on disk.
"""

import os
import json
import hashlib
import importlib.util
import urllib.request

_PY_PREFIX = "app/src/main/python/"
_WEB_PREFIX = "app/src/main/assets/web/"
_ME = "ota.py"


# --- environment -------------------------------------------------------------

def _home():
    return os.environ.get("HOME", "/tmp")


def _roots():
    h = _home()
    return {
        "py": os.environ.get("AGENT_OVERRIDE_DIR") or os.path.join(h, "py_override"),
        "web": os.environ.get("OTA_WEB_DIR") or os.path.join(h, "web"),
        "files": os.environ.get("OTA_FILES_DIR") or h,
        "home": h,
    }


def _base_url():
    # OTA_BASE_URL overrides everything (tests / self-hosting); otherwise raw
    # GitHub for the configured repo + branch.
    base = os.environ.get("OTA_BASE_URL", "")
    if base:
        return base.rstrip("/") + "/"
    repo = os.environ.get("OTA_REPO", "efficientengineer/mobilecode")
    branch = os.environ.get("OTA_BRANCH", "main")
    return f"https://raw.githubusercontent.com/{repo}/{branch}/"


def _fetch(path):
    url = _base_url() + path.lstrip("/")
    with urllib.request.urlopen(url, timeout=25) as r:
        if r.status != 200:
            raise RuntimeError(f"HTTP {r.status} for {path}")
        return r.read()


# --- manifest -> a flat entry list -------------------------------------------

def _load_manifest():
    return json.loads(_fetch("ota_manifest.json").decode("utf-8"))


def _entries(manifest, kind):
    """Normalize v1/v2 manifest into [{path, root, dest, sha256?}] for `kind`
    (agent = python, ui = web, all = everything incl. extra)."""
    out = []
    if kind in ("agent", "all"):
        for f in manifest.get("python") or []:
            out.append({"path": _PY_PREFIX + f, "root": "py", "dest": f})
    if kind in ("ui", "all"):
        for f in manifest.get("web") or []:
            out.append({"path": _WEB_PREFIX + f, "root": "web", "dest": f})
    if kind == "all":
        for e in manifest.get("extra") or []:
            out.append({"path": e["path"], "root": e.get("root", "files"),
                        "dest": e["dest"], "sha256": e.get("sha256")})
    return out


def _safe_dest(root_dir, dest):
    """Resolve dest under its root; refuse traversal outside it."""
    fp = os.path.realpath(os.path.join(root_dir, dest))
    base = os.path.realpath(root_dir)
    if fp != base and not fp.startswith(base + os.sep):
        raise RuntimeError(f"unsafe dest outside root: {dest}")
    return fp


def _atomic_write(fp, data):
    os.makedirs(os.path.dirname(fp) or ".", exist_ok=True)
    tmp = fp + ".ota-tmp"
    with open(tmp, "wb") as f:
        f.write(data)
    os.replace(tmp, fp)  # atomic on POSIX


# --- self-update --------------------------------------------------------------

def _maybe_self_update(manifest):
    """Refresh THIS module from the repo before doing any work. Returns the
    fresh module to delegate to, or None when already current / unavailable."""
    loader_path = manifest.get("loader")
    if not loader_path:
        return None
    try:
        remote = _fetch(loader_path)
    except Exception:
        return None  # can't fetch the loader — proceed with the running copy
    roots = _roots()
    fp = _safe_dest(roots["py"], _ME)
    try:
        current = open(fp, "rb").read() if os.path.exists(fp) else \
            open(os.path.abspath(__file__), "rb").read()
    except Exception:
        current = b""
    if remote == current:
        return None
    _atomic_write(fp, remote)
    spec = importlib.util.spec_from_file_location("ota_fresh", fp)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


# --- the one public verb -------------------------------------------------------

def update(kind="all", _fresh=False):
    """Fetch + install per the repo manifest. kind: "agent" | "ui" | "all".
    Returns a human summary; raises only if NOTHING could be updated (the
    Kotlin caller then falls back to its legacy built-in updater)."""
    kind = str(kind or "all")
    if kind not in ("agent", "ui", "all"):
        kind = "all"
    manifest = _load_manifest()

    # Phase 0: hand off to a newer loader, so fixes to THIS logic apply now.
    if not _fresh:
        fresh = _maybe_self_update(manifest)
        if fresh is not None:
            return fresh.update(kind, _fresh=True) + " · loader self-updated"

    roots = _roots()
    entries = _entries(manifest, kind)

    # Phase 1: fetch EVERYTHING (verify hashes) before touching the disk.
    blobs = []
    for e in entries:
        data = _fetch(e["path"])
        want = e.get("sha256")
        if want:
            got = hashlib.sha256(data).hexdigest()
            if got != want:
                raise RuntimeError(f"sha256 mismatch for {e['path']}: {got}")
        blobs.append((e, data))

    # Phase 2: install (atomic per file), skipping unchanged bytes.
    written, skipped, per_root = 0, 0, {}
    for e, data in blobs:
        root_dir = roots.get(e["root"]) or roots["files"]
        fp = _safe_dest(root_dir, e["dest"])
        try:
            if os.path.exists(fp) and open(fp, "rb").read() == data:
                skipped += 1
                continue
        except Exception:
            pass
        _atomic_write(fp, data)
        written += 1
        per_root[e["root"]] = per_root.get(e["root"], 0) + 1

    # Phase 3: prune files the manifest says are obsolete (all-mode only).
    removed = 0
    if kind == "all":
        for e in manifest.get("remove") or []:
            try:
                fp = _safe_dest(roots.get(e.get("root", "files"), roots["files"]),
                                e["dest"])
                if os.path.exists(fp):
                    os.remove(fp)
                    removed += 1
            except Exception:
                pass  # a bad remove entry must never break the update

    parts = [f"{n} {r}" for r, n in sorted(per_root.items())]
    detail = (", ".join(parts) or "0") + f" written · {skipped} unchanged"
    if removed:
        detail += f" · {removed} removed"
    return f"Updated ({kind}): {detail} — next task uses the new code"
