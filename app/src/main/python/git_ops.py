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


# Commit identity for on-device commits. Defaults to the repo owner so commits
# are attributed to their GitHub account (not an anonymous agent@device.local);
# overridable via GIT_AUTHOR_NAME / GIT_AUTHOR_EMAIL (or GIT_COMMITTER_*).
_DEFAULT_GIT_NAME = "efficientengineer"
_DEFAULT_GIT_EMAIL = "efficientengineer@proton.me"


def _identity() -> bytes:
    name = (os.environ.get("GIT_AUTHOR_NAME")
            or os.environ.get("GIT_COMMITTER_NAME") or _DEFAULT_GIT_NAME).strip()
    email = (os.environ.get("GIT_AUTHOR_EMAIL")
             or os.environ.get("GIT_COMMITTER_EMAIL") or _DEFAULT_GIT_EMAIL).strip()
    return f"{name} <{email}>".encode()


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
        raise _GitHubApiError(e.code, detail) from e


class _GitHubApiError(RuntimeError):
    """A GitHub REST API call returned a non-2xx status.

    Carries the HTTP status code and the parsed API message so callers can
    turn common failures (e.g. an insufficiently-scoped token) into a clear,
    user-facing explanation instead of a raw traceback.
    """

    def __init__(self, code: int, detail: str):
        self.code = code
        self.detail = detail
        try:
            self.message = (json.loads(detail) or {}).get("message", "")
        except Exception:
            self.message = ""
        super().__init__(f"GitHub HTTP {code}: {detail}")


def _auth_url(full_name: str) -> str:
    """https clone URL with the token embedded for push/pull auth."""
    return f"https://x-access-token:{_token()}@github.com/{full_name}.git"


def _scrub(s: str) -> str:
    """Redact the GitHub token from any string before it reaches the UI/model.

    Dulwich embeds the token in the remote URL (_auth_url), so a failed
    clone/push/pull traceback can otherwise leak it verbatim.
    """
    tok = _token()
    return s.replace(tok, "***") if tok else s


def _remote_full_name(root: Path) -> str:
    """Read the stored origin (owner/repo) for this workspace, if any."""
    marker = root / ".git" / "voiceagent_origin"
    return marker.read_text().strip() if marker.exists() else ""


def _set_origin(root: Path, full_name: str) -> None:
    porcelain.init(str(root)) if not (root / ".git").exists() else None
    (root / ".git" / "voiceagent_origin").write_text(full_name)


# --- workspace commit + status (for the agent's git tools) ---------------

def _changed(root: Path) -> list:
    """Working-tree paths that differ from HEAD, excluding agent metadata."""
    try:
        st = porcelain.status(str(root))
    except Exception:
        return []
    out = []
    for p in st.untracked:
        out.append(p.decode() if isinstance(p, bytes) else p)
    for kind in ("add", "delete", "modify"):
        out += [p.decode() if isinstance(p, bytes) else p
                for p in st.staged.get(kind, [])]
    out += [p.decode() if isinstance(p, bytes) else p for p in st.unstaged]
    seen, uniq = set(), []
    for p in out:
        if p not in seen and ".agent/" not in p and p not in ("meta.json", "transcript.jsonl"):
            seen.add(p)
            uniq.append(p)
    return uniq


def status_summary() -> str:
    """Branch, remote, and changed files — a git status for the agent."""
    root = _workspace()
    if not (root / ".git").exists():
        return "No git repo yet (a commit will initialize one)."
    changed = _changed(root)
    lines = [f"branch: {current_branch()}",
             f"remote: {_remote_full_name(root) or '(none)'}",
             f"uncommitted changes: {len(changed)}"]
    lines += [f"  {p}" for p in changed[:50]]
    return "\n".join(lines)


def _stage_deletions(root: Path) -> None:
    """Record files removed from disk (dulwich's add never stages removals)."""
    try:
        st = porcelain.status(str(root))
        removed = list(st.staged.get("delete", [])) + list(getattr(st, "unstaged", []) or [])
    except Exception:
        return
    for p in removed:
        rel = p.decode() if isinstance(p, bytes) else p
        if (root / rel).exists():
            continue
        try:
            porcelain.remove(str(root), paths=[str(root / rel)])
        except Exception:
            pass


def commit(message: str = "") -> str:
    """Stage every workspace file (except .git/.agent/app meta) and commit."""
    try:
        root = _workspace()
        if not (root / ".git").exists():
            porcelain.init(str(root))
        if not _changed(root):
            return "Nothing to commit."
        for p in root.rglob("*"):
            if ".git" in p.parts or ".agent" in p.parts or not p.is_file():
                continue
            if p.name in ("meta.json", "transcript.jsonl"):
                continue
            porcelain.add(str(root), paths=[str(p)])
        _stage_deletions(root)  # dulwich's add never records removals
        msg = (message or "").strip() or "Update workspace"
        ident = _identity()
        cid = porcelain.commit(str(root), message=msg.encode(),
                               author=ident, committer=ident)
        cid = cid.decode() if isinstance(cid, bytes) else str(cid)
        return f"Committed {cid[:8]}: {msg}"
    except Exception:
        return "Commit failed:\n" + traceback.format_exc()


# --- GitHub REST ---------------------------------------------------------

def current_user() -> str:
    return _api("GET", "/user").get("login", "")


def create_repo(name: str, private: bool = True) -> str:
    """Create a repo on GitHub and set it as this workspace's origin.

    Idempotent: if a repo with this name already exists on the account (for
    example because the button was tapped twice), adopt the existing repo as
    this workspace's origin instead of reporting an error.
    """
    try:
        repo = _api("POST", "/user/repos",
                    {"name": name, "private": bool(private), "auto_init": False})
        full = repo["full_name"]
        root = _workspace()
        if not (root / ".git").exists():
            porcelain.init(str(root))
        _set_origin(root, full)
        return f"Created {full}"
    except _GitHubApiError as e:
        if e.code == 422 and "already exists" in (e.detail or ""):
            try:
                login = current_user()
                repo = _api("GET", f"/repos/{login}/{name}")
                full = repo["full_name"]
                root = _workspace()
                if not (root / ".git").exists():
                    porcelain.init(str(root))
                _set_origin(root, full)
                return f"Using existing {full}"
            except Exception:
                pass
            return f"Repo '{name}' already exists on your account."
        if e.code in (403, 401):
            return (
                "Create repo failed: your GitHub token isn't allowed to "
                "create repositories.\n\n"
                "Give the token the \"repo\" scope (classic token) or "
                "\"Administration: Read and write\" repository permission "
                "plus access to your account (fine-grained token), then try "
                "again.\n\n"
                f"(GitHub said: {e.message or e.detail})"
            )
        return f"Create repo failed: GitHub returned HTTP {e.code}.\n\n{e.message or e.detail}"
    except Exception:
        return "Create repo failed:\n" + traceback.format_exc()


def delete_repo(full: str) -> str:
    """Delete a GitHub repo (owner/name, or just name for the current user)."""
    full = (full or "").strip().strip("/")
    if not full:
        return "Delete repo failed: no repository given."
    try:
        if "/" not in full:
            full = f"{current_user()}/{full}"
        _api("DELETE", f"/repos/{full}")
        return f"Deleted {full}"
    except _GitHubApiError as e:
        if e.code in (403, 401):
            return (
                f"Delete repo failed: your GitHub token isn't allowed to delete "
                f"'{full}'.\n\nGive the token the \"delete_repo\" scope (classic) "
                "and make sure you own the repo, then try again.\n\n"
                f"(GitHub said: {e.message or e.detail})"
            )
        if e.code == 404:
            return f"Delete repo failed: '{full}' not found (or no access)."
        return f"Delete repo failed: GitHub returned HTTP {e.code}.\n\n{e.message or e.detail}"
    except Exception:
        return "Delete repo failed:\n" + traceback.format_exc()


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
    root = _workspace()
    if not (root / ".git").exists():
        return "(no repo)"
    try:
        return porcelain.active_branch(str(root)).decode()
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
        return _scrub("Clone failed:\n" + traceback.format_exc())


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
        return _scrub("Push failed:\n" + traceback.format_exc())


def push_force(_=None) -> str:
    # Guard: never rewrite the default branch. Force-push is for feature
    # branches you rebuilt/rebased — clobbering the default branch is how you
    # lose everyone's history.
    root = _workspace()
    full = _remote_full_name(root)
    default = _default_branch(full) if full else "main"
    if current_branch() == default:
        return (f"Refusing to force-push {default} — never rewrite the default "
                "branch. Force-push only feature branches.")
    return push(force=True)


def start_fresh(name: str = "") -> str:
    """Start a NEW work branch from an UP-TO-DATE default branch — the safe way
    that avoids conflicts (switch to default, pull latest, then branch). Refuses
    if there are uncommitted changes (they'd be stranded on the old branch)."""
    try:
        root = _workspace()
        if not (root / ".git").exists():
            return start_branch(name)          # no repo yet — just make the branch
        if _changed(root):
            return ("You have uncommitted changes — git_commit or revert them "
                    "before starting a fresh branch.")
        full = _remote_full_name(root)
        default = _default_branch(full) if full else "main"
        name = (name or "").strip() or ("agent/" + root.name)
        if name == default:
            return f"'{name}' is the default branch — pick a feature branch name."
        steps = []
        if current_branch() != default:
            co = checkout(default)
            steps.append(co.splitlines()[0])
        if full:
            steps.append(pull().splitlines()[0])   # sync default to latest
        steps.append(start_branch(name).splitlines()[0])
        return f"Fresh branch '{name}' from {default}: " + " · ".join(s for s in steps if s)
    except Exception:
        return _scrub("Start-fresh failed:\n" + traceback.format_exc())


def ship(title: str = "", body: str = "") -> str:
    """Finish a change in one step: commit pending work, push, and open a PR.
    Won't run on the default branch — start a feature branch first."""
    try:
        root = _workspace()
        full = _remote_full_name(root)
        branch = current_branch()
        default = _default_branch(full) if full else "main"
        if branch == default:
            return (f"You're on {default}. Start a feature branch first "
                    "(git_start), make the change, then git_ship.")
        out = []
        if _changed(root):
            out.append(commit(title or "").splitlines()[0])
        else:
            out.append("no local changes to commit")
        out.append(create_pr(title, body).splitlines()[0])   # pushes, then PR
        return "Shipped: " + " · ".join(out)
    except Exception:
        return _scrub("Ship failed:\n" + traceback.format_exc())


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
        return _scrub("Pull failed:\n" + traceback.format_exc())


def _conflicted_files(root: Path) -> list:
    """Workspace files left with merge-conflict markers, relative-path sorted."""
    out = []
    skip = {".git", ".agent", "node_modules", "__pycache__"}
    for p in root.rglob("*"):
        if not p.is_file() or any(s in p.parts for s in skip):
            continue
        try:
            t = p.read_text(encoding="utf-8", errors="ignore")
        except Exception:
            continue
        if "<<<<<<<" in t and ">>>>>>>" in t:
            out.append(str(p.relative_to(root)))
    return sorted(out)


def update_from_base() -> str:
    """Merge the latest default branch into the current work branch, so a PR
    that has fallen behind main becomes mergeable. Clean merge -> push, then
    merge the PR. Conflicts -> the files are left with <<<<<<< markers to fix,
    then git_commit + git_push. If this build can't 3-way-merge on device, it
    says so and you rebuild the branch from main instead (see guidelines)."""
    try:
        root = _workspace()
        full = _remote_full_name(root)
        if not full:
            return "No repo set for this workspace."
        branch = current_branch()
        default = _default_branch(full)
        if branch == default:
            return f"You're on {default} — nothing to update from."
        remote = _auth_url(full)
        try:
            porcelain.fetch(str(root), remote)
        except Exception:
            pass
        from dulwich.repo import Repo
        r = Repo(str(root))
        base_sha = None
        for cand in (f"refs/remotes/origin/{default}", f"refs/heads/{default}"):
            b = cand.encode()
            if b in r.refs:
                base_sha = r.refs[b]
                break
        if base_sha is None:
            return (f"Couldn't find {default} after fetch. Rebuild the branch from "
                    f"{default} instead (see guidelines: 'When a merge conflicts').")
        if not hasattr(porcelain, "merge"):
            return (f"This build can't 3-way-merge on device. Rebuild the branch "
                    f"from the latest {default}: git_checkout {default} -> git_pull "
                    "-> git_branch <new-name> -> redo your change -> git_open_pr "
                    "(see guidelines: 'When a merge conflicts').")
        try:
            try:
                porcelain.merge(str(root), base_sha)
            except TypeError:
                porcelain.merge(str(root), [base_sha])
        except Exception as e:
            conflicts = _conflicted_files(root)
            if conflicts:
                return ("Merge hit CONFLICTS in:\n- " + "\n- ".join(conflicts) +
                        "\nOpen each file, resolve the <<<<<<< / ======= / >>>>>>> "
                        "sections (keep the right code, delete the markers), then "
                        "git_commit and git_push, then git_merge_pr.")
            return (f"Couldn't merge {default} cleanly ({_scrub(str(e))[:160]}). "
                    f"Rebuild the branch from {default} instead (see guidelines).")
        conflicts = _conflicted_files(root)
        if conflicts:
            return ("Merged with CONFLICTS in:\n- " + "\n- ".join(conflicts) +
                    "\nResolve the <<<<<<< markers in each, then git_commit, "
                    "git_push, git_merge_pr.")
        return (f"Merged the latest {default} into {branch} cleanly. "
                "Now git_push, then git_merge_pr.")
    except Exception:
        return _scrub("Update from base failed:\n" + traceback.format_exc())


def checkout(name: str = "") -> str:
    """Switch to an existing local branch, updating the working tree. Refuses
    when there are uncommitted changes (a hard switch would lose them)."""
    try:
        root = _workspace()
        if not (root / ".git").exists():
            return "No repo in this workspace."
        name = (name or "").strip()
        if not name:
            return "checkout: which branch?"
        if name == current_branch():
            return f"Already on {name}."
        from dulwich.repo import Repo
        r = Repo(str(root))
        ref = ("refs/heads/" + name).encode()
        if ref not in r.refs:
            return (f"No local branch '{name}'. Pull it first "
                    "(git_pull) or create it (git_branch).")
        if _changed(root):
            return (f"Can't switch to {name}: you have uncommitted changes. "
                    "Commit or revert them first.")
        r.refs.set_symbolic_ref(b"HEAD", ref)     # point HEAD at the branch
        porcelain.reset(str(root), "hard")        # materialize its tree
        return f"On branch {name}"
    except Exception:
        return _scrub("Checkout failed:\n" + traceback.format_exc())


def delete_branch(name: str = "", remote: bool = False) -> str:
    """Delete a local branch (and the remote one when remote=True). If you're
    currently on it, switches to the default branch first so the delete is
    allowed; never deletes the default branch itself."""
    try:
        root = _workspace()
        if not (root / ".git").exists():
            return "No repo in this workspace."
        full = _remote_full_name(root)
        name = (name or "").strip()
        if not name:
            return "delete_branch: which branch?"
        default = _default_branch(full) if full else "main"
        if name == default:
            return f"Refusing to delete '{name}' — it's the default branch."

        from dulwich.repo import Repo
        r = Repo(str(root))
        ref = ("refs/heads/" + name).encode()
        msgs = []
        if current_branch() == name:
            dref = ("refs/heads/" + default).encode()
            if dref not in r.refs:
                return (f"Can't delete '{name}' while it's checked out and there's "
                        f"no local '{default}' to switch to. Pull {default} first.")
            r.refs.set_symbolic_ref(b"HEAD", dref)
            if not _changed(root):
                try: porcelain.reset(str(root), "hard")
                except Exception: pass
            msgs.append(f"switched to {default}")
        if ref in r.refs:
            del r.refs[ref]
            msgs.append(f"deleted local {name}")
        else:
            msgs.append(f"no local {name}")

        if remote and full:
            try:
                _api("DELETE", f"/repos/{full}/git/refs/heads/{name}")
                msgs.append(f"deleted remote {name}")
            except _GitHubApiError as e:
                if e.code in (404, 422):
                    msgs.append(f"remote {name} already gone")
                elif e.code in (401, 403):
                    msgs.append("remote delete not allowed (token needs write access)")
                else:
                    msgs.append(f"remote delete failed ({e.code}: {e.message or ''})")
        return "Cleanup: " + ", ".join(msgs)
    except Exception:
        return _scrub("Delete branch failed:\n" + traceback.format_exc())


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


def merge_pr(method: str = "merge") -> str:
    """Merge the open PR for the current branch into its base branch.

    method: "merge" (default) | "squash" | "rebase". Surfaces GitHub's own
    reason when the merge is blocked (CI still running/failing, review or
    branch-protection rules, conflicts, or a token without write access)
    instead of a raw traceback."""
    try:
        full = _remote_full_name(_workspace())
        if not full:
            return "No repo set for this workspace."
        branch = current_branch()
        owner = full.split("/")[0]
        prs = _api("GET", f"/repos/{full}/pulls?head={owner}:{branch}&state=all&per_page=1")
        if not prs:
            return f"No PR for branch {branch}. Open one first (Merge → open PR)."
        pr = prs[0]
        num = pr["number"]
        if pr.get("merged_at"):
            return f"PR #{num} is already merged: {pr['html_url']}"
        if pr.get("state") != "open":
            return f"PR #{num} is {pr.get('state')} (not open): {pr['html_url']}"

        m = (method or "merge").strip().lower()
        if m not in ("merge", "squash", "rebase"):
            m = "merge"
        try:
            res = _api("PUT", f"/repos/{full}/pulls/{num}/merge", {"merge_method": m})
        except _GitHubApiError as e:
            why = e.message or (e.detail or "")[:200]
            if e.code == 405:
                return (f"PR #{num} can't be merged yet: {why}\n"
                        "Usually required CI is still running or failing, a review "
                        "is required, or branch protection is blocking it. "
                        "Tap PR status to check.")
            if e.code == 409:
                return (f"PR #{num} has a conflict or the branch moved: {why}\n"
                        "Pull the base branch, resolve conflicts, push, then retry.")
            if e.code in (403, 401):
                return (f"Merge not allowed: {why}\nThe GitHub token needs write "
                        "access to this repo — a classic token with the 'repo' "
                        "scope, or a fine-grained token with Contents + Pull "
                        "requests read/write.")
            return f"Merge PR #{num} failed (HTTP {e.code}): {why}"

        if res.get("merged"):
            base = (pr.get("base") or {}).get("ref", "the base branch")
            return f"Merged PR #{num} ({m}) into {base} ✅\n{pr['html_url']}"
        return f"Merge PR #{num}: {res.get('message', 'unexpected response')}"
    except Exception:
        return "Merge PR failed:\n" + traceback.format_exc()


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


def pr_check(_=None) -> str:
    """Structured PR + CI status for the background watcher. JSON:
    {branch, pr, state, ci, url}. state: none|open|closed|merged|error;
    ci: none|passing|failing|running. Keeps the Kotlin worker logic trivial."""
    try:
        full = _remote_full_name(_workspace())
        if not full:
            return json.dumps({"state": "none", "ci": "none", "reason": "no repo"})
        branch = current_branch()
        owner = full.split("/")[0]
        prs = _api("GET", f"/repos/{full}/pulls?head={owner}:{branch}&state=all&per_page=1")
        if not prs:
            return json.dumps({"branch": branch, "pr": None, "state": "none", "ci": "none"})
        pr = prs[0]
        state = "merged" if pr.get("merged_at") else pr.get("state", "open")
        ci = "none"
        try:
            sha = pr["head"]["sha"]
            runs = _api("GET", f"/repos/{full}/commits/{sha}/check-runs").get("check_runs", [])
            if runs:
                if any(r.get("conclusion") in ("failure", "timed_out", "cancelled")
                       for r in runs):
                    ci = "failing"
                elif all(r.get("status") == "completed" for r in runs):
                    ci = "passing"
                else:
                    ci = "running"
        except Exception:
            pass
        return json.dumps({"branch": branch, "pr": pr.get("number"), "state": state,
                           "ci": ci, "url": pr.get("html_url", "")})
    except Exception as e:
        return json.dumps({"state": "error", "ci": "none", "reason": str(e)[:200]})


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
