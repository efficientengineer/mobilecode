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


# --- branches --------------------------------------------------------------

def current_branch() -> str:
    try:
        return porcelain.active_branch(str(_workspace())).decode()
    except Exception:
        return "master"


def _default_branch(full: str) -> str:
    try:
        return _api("GET", f"/repos/{full}").get("default_branch", "main")
    except Exception:
        return "main"


def start_branch(name: str = "") -> str:
    """Create (if needed) and switch to a work branch at the current HEAD.

    The working tree is untouched — the new branch points at the same commit,
    so this is always safe. Default name: agent/<workspace folder>.
    """
    try:
        root = _workspace()
        if not (root / ".git").exists():
            porcelain.init(str(root))
        name = (name or "").strip() or ("agent/" + root.name)
        from dulwich.repo import Repo
        r = Repo(str(root))
        ref = ("refs/heads/" + name).encode()
        try:
            head = r.head()
            if ref not in r.refs:
                r.refs[ref] = head
        except KeyError:
            pass  # no commits yet — the symref alone is enough
        r.refs.set_symbolic_ref(b"HEAD", ref)
        return f"On branch {name}"
    except Exception:
        return "Branch failed:\n" + traceback.format_exc()


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


def push(force: bool = False) -> str:
    """Push the current branch to origin under its own name (no force by
    default — history on the remote is never silently rewritten)."""
    try:
        root = _workspace()
        full = _remote_full_name(root)
        if not full:
            return "No repo set for this workspace (create or select one first)."
        branch = current_branch()
        refspec = f"refs/heads/{branch}:refs/heads/{branch}"
        try:
            porcelain.push(str(root), _auth_url(full), refspec, force=bool(force))
        except Exception as e:
            if force:
                raise
            return (f"Push rejected ({e}).\nThe remote {branch} has commits you "
                    "don't have — Pull first, or use Force push if you're sure.")
        return f"Pushed {branch} to {full}"
    except Exception:
        return "Push failed:\n" + traceback.format_exc()


def push_force(_=None) -> str:
    return push(force=True)


def pull() -> str:
    """Pull the current branch (falling back to the default branch) from origin."""
    try:
        root = _workspace()
        full = _remote_full_name(root)
        if not full:
            return "No repo set for this workspace (create or select one first)."
        branch = current_branch()
        try:
            porcelain.pull(str(root), _auth_url(full),
                           f"refs/heads/{branch}".encode())
            return f"Pulled {branch} from {full}"
        except Exception:
            default = _default_branch(full)
            porcelain.pull(str(root), _auth_url(full),
                           f"refs/heads/{default}".encode())
            return f"Pulled {default} from {full}"
    except Exception:
        return "Pull failed:\n" + traceback.format_exc()


# --- pull requests ---------------------------------------------------------

def create_pr(title: str = "", body: str = "") -> str:
    """Open a PR from the current branch to the repo's default branch."""
    try:
        root = _workspace()
        full = _remote_full_name(root)
        if not full:
            return "No repo set for this workspace."
        branch = current_branch()
        base = _default_branch(full)
        if branch == base:
            return (f"You are on {base} (the default branch). Use Start branch "
                    "first, then push, then open the PR.")
        # Make sure the branch exists remotely before opening the PR.
        p = push()
        if p.startswith(("Push failed", "Push rejected")):
            return p
        title = (title or "").strip() or f"Agent changes on {branch}"
        pr = _api("POST", f"/repos/{full}/pulls",
                  {"title": title, "body": body or "Created from the phone by Voice Agent.",
                   "head": branch, "base": base})
        return f"PR #{pr.get('number')}: {pr.get('html_url')}"
    except RuntimeError as e:
        if "A pull request already exists" in str(e):
            return pr_status()
        return "Create PR failed:\n" + traceback.format_exc()
    except Exception:
        return "Create PR failed:\n" + traceback.format_exc()


def pr_status(_=None) -> str:
    """State + CI verdict of the open PR for the current branch, if any."""
    try:
        full = _remote_full_name(_workspace())
        if not full:
            return "No repo set for this workspace."
        branch = current_branch()
        owner = full.split("/")[0]
        prs = _api("GET", f"/repos/{full}/pulls?head={owner}:{branch}&state=all&per_page=1")
        if not prs:
            return f"No PR for branch {branch}."
        pr = prs[0]
        line = f"PR #{pr['number']} [{pr['state']}"
        if pr.get("merged_at"):
            line += ", merged"
        line += f"]: {pr['html_url']}"
        try:
            sha = pr["head"]["sha"]
            runs = _api("GET", f"/repos/{full}/commits/{sha}/check-runs").get(
                "check_runs", [])
            if runs:
                bad = [r for r in runs if r.get("conclusion") not in
                       (None, "success", "neutral", "skipped")]
                line += "\nCI: " + ("FAILING — " + ", ".join(r["name"] for r in bad[:5])
                                     if bad else
                                     ("passing" if all(r.get("status") == "completed"
                                                        for r in runs) else "running…"))
        except Exception:
            pass
        return line
    except Exception:
        return "PR status failed:\n" + traceback.format_exc()


# --- file inspection -----------------------------------------------------

def list_tree() -> str:
    """JSON array of the workspace's files (relative paths, sorted)."""
    root = _workspace()
    files = []
    for p in sorted(root.rglob("*")):
        if ".git" in p.parts or ".agent" in p.parts:
            continue
        if p.is_file():
            files.append(str(p.relative_to(root)))
    return json.dumps(files)


def cloud_build() -> str:
    """Trigger the active repo's first workflow (needs workflow_dispatch)."""
    try:
        full = _remote_full_name(_workspace())
        if not full:
            return "No repo set for this session."
        repo = _api("GET", f"/repos/{full}")
        branch = repo.get("default_branch", "main")
        wfs = _api("GET", f"/repos/{full}/actions/workflows").get("workflows", [])
        if not wfs:
            return f"No workflows in {full} to build."
        wf = wfs[0]
        _api("POST", f"/repos/{full}/actions/workflows/{wf['id']}/dispatches",
             {"ref": branch})
        return (f"Triggered '{wf.get('name')}' on {full}@{branch}.\n"
                f"Watch: https://github.com/{full}/actions")
    except Exception:
        return "Cloud build failed:\n" + traceback.format_exc()


def latest_build() -> str:
    """Status of the active repo's most recent workflow run."""
    try:
        full = _remote_full_name(_workspace())
        if not full:
            return "No repo set for this session."
        runs = _api("GET", f"/repos/{full}/actions/runs?per_page=1").get(
            "workflow_runs", [])
        if not runs:
            return "No runs yet."
        r = runs[0]
        status = r.get("status")
        concl = r.get("conclusion") or "…"
        return f"{status} / {concl}\n{r.get('html_url')}"
    except Exception:
        return "Status check failed:\n" + traceback.format_exc()


def ci_failure_log(_=None) -> str:
    """Tail of the failed job's log from the most recent workflow run.

    Returns "(…)"-wrapped explanations when there's nothing to fix, so
    callers can tell 'no failure' apart from an actual log.
    """
    try:
        full = _remote_full_name(_workspace())
        if not full:
            return "(no repo set for this session)"
        runs = _api("GET", f"/repos/{full}/actions/runs?per_page=1").get(
            "workflow_runs", [])
        if not runs:
            return "(no workflow runs yet)"
        run = runs[0]
        if run.get("status") != "completed":
            return f"(latest run is still {run.get('status')} — check back when it finishes)"
        if run.get("conclusion") == "success":
            return "(latest run succeeded — nothing to fix)"
        jobs = _api("GET", f"/repos/{full}/actions/runs/{run['id']}/jobs").get(
            "jobs", [])
        failed = [j for j in jobs if j.get("conclusion") == "failure"] or jobs[:1]
        if not failed:
            return "(run failed but no jobs found)"
        job = failed[0]
        steps = [s.get("name", "?") for s in job.get("steps", [])
                 if s.get("conclusion") == "failure"]
        header = (f"run '{run.get('name')}' #{run.get('run_number')} failed; "
                  f"job '{job.get('name')}'"
                  + (f", failed step(s): {', '.join(steps)}" if steps else ""))
        log = _fetch_job_log(full, job["id"])
        return header + "\n\n" + log[-12000:]
    except Exception:
        return "(CI log fetch failed:\n" + traceback.format_exc() + ")"


def _fetch_job_log(full: str, job_id) -> str:
    """GitHub returns the log as a 302 to a signed URL; the signed URL must be
    fetched WITHOUT the Authorization header, so handle the redirect manually."""
    import urllib.request
    import urllib.error

    class _NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, req, fp, code, msg, headers, newurl):
            return None

    url = f"{_API}/repos/{full}/actions/jobs/{job_id}/logs"
    req = urllib.request.Request(url, headers={
        "Authorization": f"Bearer {_token()}",
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "voice-agent",
    })
    opener = urllib.request.build_opener(_NoRedirect)
    try:
        with opener.open(req, timeout=60) as r:
            return r.read().decode("utf-8", errors="replace")
    except urllib.error.HTTPError as e:
        if e.code in (301, 302, 307):
            signed = e.headers.get("Location")
            with urllib.request.urlopen(signed, timeout=60) as r:
                return r.read().decode("utf-8", errors="replace")
        raise


def balances() -> str:
    """Return provider balances. DeepSeek exposes one; Anthropic does not."""
    import urllib.request
    import urllib.error
    lines = []
    ds_key = os.environ.get("DEEPSEEK_API_KEY", "").strip()
    if ds_key:
        try:
            req = urllib.request.Request(
                "https://api.deepseek.com/user/balance",
                headers={"Authorization": f"Bearer {ds_key}",
                         "Accept": "application/json"},
            )
            with urllib.request.urlopen(req, timeout=30) as r:
                info = json.loads(r.read().decode())
            infos = info.get("balance_infos", [])
            if infos:
                for b in infos:
                    lines.append(
                        f"DeepSeek: {b.get('total_balance', '?')} "
                        f"{b.get('currency', '')}".strip()
                    )
            else:
                avail = info.get("is_available")
                lines.append(f"DeepSeek: available={avail}")
        except Exception as e:
            lines.append(f"DeepSeek: error ({e})")
    else:
        lines.append("DeepSeek: no key set")
    lines.append("Anthropic: balance not available via API")
    return "\n".join(lines)


def balance_value(_=None) -> str:
    """Structured balance for the UI. JSON: {deepseek: number|null, currency}."""
    import urllib.request
    ds_key = os.environ.get("DEEPSEEK_API_KEY", "").strip()
    out = {"deepseek": None, "currency": ""}
    if ds_key:
        try:
            req = urllib.request.Request(
                "https://api.deepseek.com/user/balance",
                headers={"Authorization": f"Bearer {ds_key}", "Accept": "application/json"},
            )
            with urllib.request.urlopen(req, timeout=20) as r:
                info = json.loads(r.read().decode())
            infos = info.get("balance_infos", [])
            if infos:
                out["deepseek"] = float(infos[0].get("total_balance", 0) or 0)
                out["currency"] = infos[0].get("currency", "")
        except Exception:
            pass
    return json.dumps(out)


def read_file(rel: str) -> str:
    """Return a workspace file's contents (empty string if missing)."""
    fp = _workspace() / rel
    if fp.exists() and fp.is_file():
        try:
            return fp.read_text(encoding="utf-8", errors="replace")
        except Exception:
            return ""
    return ""
