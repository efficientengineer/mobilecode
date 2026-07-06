"""
git_ops.py — GitHub + git remote operations for the on-device agent.

All functions act on the *active workspace* (env AGENT_WORKSPACE), which the
Kotlin layer points at the currently selected session/repo. Authentication for
both the GitHub REST API and git push/pull uses the token in env GITHUB_TOKEN.

Returned values are simple strings (status messages) or JSON strings, so the
Kotlin side can display or parse them without extra glue. Everything is pure
Python (urllib + dulwich), so this file is over-the-air updatable.
"""

import os
import json
import traceback
from pathlib import Path

from dulwich import porcelain

_API = "https://api.github.com"


# --- helpers -------------------------------------------------------------

def _token() -> str:
    return os.environ.get("GITHUB_TOKEN", "").strip()


def _workspace() -> Path:
    ws = os.environ.get("AGENT_WORKSPACE")
    if not ws:
        ws = os.path.join(os.environ.get("HOME", "/tmp"), "workspace")
    p = Path(ws)
    p.mkdir(parents=True, exist_ok=True)
    return p


def _api(method: str, path: str, payload=None):
    import urllib.request
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(
        _API + path, data=data, method=method,
        headers={
            "Authorization": f"Bearer {_token()}",
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "Content-Type": "application/json",
            "User-Agent": "voice-agent",
        },
    )
    import urllib.error
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            body = r.read().decode()
            return json.loads(body) if body else {}
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"GitHub HTTP {e.code}: {detail}") from e


def _auth_url(full_name: str) -> str:
    """https clone URL with the token embedded for push/pull auth."""
    return f"https://x-access-token:{_token()}@github.com/{full_name}.git"


def _remote_full_name(root: Path) -> str:
    """Read the stored origin (owner/repo) for this workspace, if any."""
    marker = root / ".git" / "voiceagent_origin"
    return marker.read_text().strip() if marker.exists() else ""


def _set_origin(root: Path, full_name: str) -> None:
    porcelain.init(str(root)) if not (root / ".git").exists() else None
    (root / ".git" / "voiceagent_origin").write_text(full_name)


# --- GitHub REST ---------------------------------------------------------

def current_user() -> str:
    return _api("GET", "/user").get("login", "")


def create_repo(name: str, private: bool = True) -> str:
    """Create a repo on GitHub and set it as this workspace's origin."""
    try:
        repo = _api("POST", "/user/repos",
                    {"name": name, "private": bool(private), "auto_init": False})
        full = repo["full_name"]
        root = _workspace()
        if not (root / ".git").exists():
            porcelain.init(str(root))
        _set_origin(root, full)
        return f"Created {full}"
    except Exception:
        return "Create repo failed:\n" + traceback.format_exc()


def list_repos() -> str:
    """JSON array of the user's repo full names (most recently pushed first)."""
    try:
        repos = _api("GET", "/user/repos?per_page=100&sort=pushed")
        return json.dumps([r["full_name"] for r in repos])
    except Exception:
        return json.dumps([])


def set_active_repo(full_name: str) -> str:
    """Point this workspace at an existing repo (records origin)."""
    try:
        _set_origin(_workspace(), full_name)
        return f"Active repo: {full_name}"
    except Exception:
        return "Set repo failed:\n" + traceback.format_exc()


# --- git remote ----------------------------------------------------------

def clone_repo(full_name: str) -> str:
    """Clone (or refresh) a repo into the active workspace."""
    try:
        root = _workspace()
        # Clean the workspace so clone lands in an empty dir.
        for child in root.iterdir():
            if child.is_dir() and child.name == ".git":
                import shutil
                shutil.rmtree(child, ignore_errors=True)
            elif child.is_file():
                child.unlink()
            else:
                import shutil
                shutil.rmtree(child, ignore_errors=True)
        porcelain.clone(_auth_url(full_name), str(root))
        _set_origin(root, full_name)
        return f"Cloned {full_name}"
    except Exception:
        return "Clone failed:\n" + traceback.format_exc()


def push() -> str:
    """Push the active workspace to its origin (as the 'main' branch)."""
    try:
        root = _workspace()
        full = _remote_full_name(root)
        if not full:
            return "No repo set for this workspace (create or select one first)."
        try:
            branch = porcelain.active_branch(str(root)).decode()
        except Exception:
            branch = "master"
        refspec = f"refs/heads/{branch}:refs/heads/main"
        porcelain.push(str(root), _auth_url(full), refspec, force=True)
        return f"Pushed to {full} (main)"
    except Exception:
        return "Push failed:\n" + traceback.format_exc()


def pull() -> str:
    """Pull origin/main into the active workspace."""
    try:
        root = _workspace()
        full = _remote_full_name(root)
        if not full:
            return "No repo set for this workspace (create or select one first)."
        porcelain.pull(str(root), _auth_url(full), b"refs/heads/main")
        return f"Pulled from {full}"
    except Exception:
        return "Pull failed:\n" + traceback.format_exc()


# --- file inspection -----------------------------------------------------

def list_tree() -> str:
    """JSON array of the workspace's files (relative paths, sorted)."""
    root = _workspace()
    files = []
    for p in sorted(root.rglob("*")):
        if ".git" in p.parts:
            continue
        if p.is_file():
            files.append(str(p.relative_to(root)))
    return json.dumps(files)


def read_file(rel: str) -> str:
    """Return a workspace file's contents (empty string if missing)."""
    fp = _workspace() / rel
    if fp.exists() and fp.is_file():
        try:
            return fp.read_text(encoding="utf-8", errors="replace")
        except Exception:
            return ""
    return ""
