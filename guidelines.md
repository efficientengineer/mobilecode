# VoiceAgent Guidelines

## OTA (Over-the-Air) Updates — The Golden Rule

**The Kotlin layer is a dumb bootstrap. Everything updateable must be updatable without rebuilding the Android APK.**

### Architecture

- `ota_manifest.json` at the repo root is the single source of truth for what files are OTA-updatable.
- `app/src/main/python/ota.py` is the self-updating loader — it refreshes itself first, then fetches + installs everything else.
- Kotlin (`MainActivity.kt`) only exports environment variables and delegates to `ota.py` via `py("ota").callAttr("update", kind)`. It has a **legacy fallback** that runs only when `ota.py` itself is broken/missing, and that fallback exists purely to restore `ota.py` so the manifest-driven path works again.

### Manifest structure (`ota_manifest.json`)

```json
{
  "version": 2,
  "loader": "app/src/main/python/ota.py",
  "python": ["llm.py", "agent_tools.py", ...],
  "web": ["index.html", "style.css", "app.js"],
  "extra": [],
  "remove": []
}
```

- **`python`** — files in `app/src/main/python/` deployed to the `py` root (hot-loaded Python override directory).
- **`web`** — files in `app/src/main/assets/web/` deployed to the `web` root (WebView UI).
- **`extra`** — arbitrary repo paths with explicit dest roots; supports `sha256` verification.
- **`remove`** — paths to delete from device on a full update (prune obsolete files).

### When you add/change/remove a file

1. **Adding a new Python module** (e.g. `app/src/main/python/new_feature.py`): add `"new_feature.py"` to the `"python"` array in `ota_manifest.json`. Done — the next `updateAgent` call will fetch it.

2. **Adding a new web asset** (e.g. `app/src/main/assets/web/component.js`): add `"component.js"` to the `"web"` array in `ota_manifest.json`, AND add a `<script src="component.js">` or equivalent in `index.html`. The next `updateUI` call fetches it and reloads the WebView.

3. **Removing a file**: add it to the `"remove"` array with the appropriate root, e.g. `{"root": "py", "dest": "dead_module.py"}`. The full `updateAll` will prune it from the device.

4. **Renaming a file**: remove the old name (via `"remove"`) and add the new name to the appropriate list. Do both in the same manifest update.

### Version bumping — REQUIRED on every OTA change

**Every time you add, remove, rename, or change the contents of ANY file listed in `ota_manifest.json` (python, web, extra, remove, or the loader), you MUST bump `content_version` in `ota_manifest.json`.** The version is a simple integer — increment it by 1.

Why: `ota.py` compares its locally-stored `content_version` (written after the last successful update) against the remote manifest's `content_version`. If they match, it reports `dirty=0` — the device sees no update available and the "Update" button does nothing. Bumping the version is the signal that tells every device "there's new code to fetch."

**This is NOT optional.** Forgetting to bump `content_version` means your changes never reach any device. The agent must bump it as part of the same commit that changes the files.

### NEVER do these

- **Never** hardcode a file list in Kotlin that duplicates the manifest. The `manifestList()` helper already falls back to reading `ota_manifest.json` from the repo; the hardcoded fallback list in `legacyUpdateAgent()` is ONLY a last-resort bootstrap to restore `ota.py`.
- **Never** edit a Kotlin file to add/remove a Python or web module — that would require an APK rebuild, defeating the whole point of OTA.
- **Never** put OTA-updatable logic in Kotlin. All update logic (fetch, verify, atomic write, self-update, pruning) lives in `ota.py` which itself is OTA-updatable.
- **Never** skip the manifest when adding a file. If it's not in `ota_manifest.json`, it won't reach the device.
- **Never** change an OTA-updatable file without bumping `content_version` in the same commit. No bump = no update = broken button.

### Update flow (what happens when user taps "Update Agent" / "Update UI")

1. Kotlin calls `py("ota").callAttr("update", kind)` where kind is `"agent"`, `"ui"`, or `"all"`.
2. `ota.py` fetches `ota_manifest.json` from the repo.
3. If a newer `ota.py` exists in the repo, it self-updates (atomic write + re-import) and delegates to the fresh copy.
4. All listed files are fetched and SHA256-verified (when checksums are provided) BEFORE anything touches disk.
5. Each file is written atomically (temp file + `os.replace`).
6. Unchanged files are skipped.
7. For `"all"`, obsolete files listed in `"remove"` are deleted.
8. Returns a human-readable summary. Kotlin reloads the WebView for UI updates.

### Device roots (set by Kotlin as env vars)

| Root key | Env var | Purpose |
|----------|---------|---------|
| `py` | `AGENT_OVERRIDE_DIR` | Hot-loaded Python modules |
| `web` | `OTA_WEB_DIR` | WebView UI files |
| `files` | `OTA_FILES_DIR` | App-private files |
| `home` | `HOME` | Home directory |

### Self-update (two-phase)

`ota.py` is listed as `"loader"` in the manifest. On every update call, it fetches its own remote copy first. If different from the running copy, it writes the new version to disk, imports it as `ota_fresh`, and delegates the rest of the update to that fresh module. This means fixes to the OTA logic itself roll out without an APK rebuild.

### Testing OTA changes

1. Push changes (including `ota_manifest.json`) to the repo branch the app is configured to track.
2. In the app, trigger an update (UI button or programmatic call).
3. The update summary tells you what was written/skipped/removed.
4. For web changes, the WebView reloads automatically after `updateUI`.
5. For Python changes, the next agent run uses the new modules.

### Repo and branch

The app reads `OTA_REPO` and `OTA_BRANCH` from SharedPreferences (or defaults from `strings.xml`). All OTA fetches go to `https://raw.githubusercontent.com/{repo}/{branch}/`. You can point a test device at a different branch to validate OTA changes before merging to main.

## Git Workflow — Use the git TOOLS, not raw `git`

**You do NOT have a shell or the `git` command.** Do all git work through your
git TOOLS. Never write shell/`git` commands for the user to run — you have
everything you need:

| Tool | What it does |
|------|--------------|
| `git_status` | current branch, remote, uncommitted changes |
| `git_branch(name)` | create + switch to a work branch at HEAD (files untouched) |
| `git_commit(message)` | stage all changes and commit |
| `git_push` | push the current branch to origin |
| `git_open_pr(title, body)` | push, then open a PR into the default branch |
| `git_pr_status` | the PR's state + CI verdict — check before merging |
| `git_merge_pr(method)` | merge the current branch's PR (`merge`/`squash`/`rebase`) |
| `git_pull` | pull the current branch (or default) from origin |
| `git_checkout(name)` | switch to an existing local branch |
| `git_delete_branch(name, remote)` | delete a merged branch, local (+ remote) |
| `git_update_from_base` | merge the latest default branch into your branch (un-stale a PR) |
| `git_force_push` | force-push (overwrite the remote branch) — for rebuilt branches |

**Every non-trivial change goes on its own branch. Never commit directly to
`main`** — the OTA system pulls from `main`, so broken code there breaks the app
for every user on the next update.

### The happy path (do it in this order)

1. **Start clean from the latest default branch** — this is the #1 way to AVOID
   conflicts: `git_checkout("main")` → `git_pull` → `git_branch("feature/<short-name>")`
   (descriptive, kebab-case). A branch cut from up-to-date `main` won't conflict
   if you also merge promptly.
2. **Build + commit**: make the change, then `git_commit("clear message")`. Keep
   each branch SMALL and focused — small, short-lived branches almost never
   conflict.
3. **Open the PR**: `git_open_pr("what changed", "why")` (it pushes first).
4. **Check, then merge**: `git_pr_status` to confirm CI is green, then
   `git_merge_pr("merge")`.
5. **Clean up**: `git_checkout("main")` → `git_pull` →
   `git_delete_branch("feature/<short-name>", remote=true)`.

### When a merge conflicts (do NOT get stuck — you can fix this)

`git_merge_pr` returns a reason when GitHub blocks the merge. If it's a
**conflict** or "branch is behind", resolve it — two ways, prefer the first:

**A. Resolve in place (keeps your PR):**
1. `git_update_from_base` — merges the latest `main` into your branch.
   - *Clean* → it says so: `git_push`, then `git_merge_pr` again. Done.
   - *Conflicts* → it lists the conflicted files.
2. For each listed file: `read_file` it, find the conflict blocks
   (`<<<<<<< … ======= … >>>>>>>`), and use `str_replace`/`write_file` to keep
   the correct code and **delete all three marker lines**. Verify nothing else
   still contains `<<<<<<<`.
3. `git_commit("resolve merge conflicts with main")` → `git_push` →
   `git_merge_pr`.

**B. Rebuild from main (bulletproof fallback — use if A can't merge on-device,
or the change is small):**
1. `git_checkout("main")` → `git_pull` (now you have the latest).
2. `git_branch("feature/<short-name>-v2")` and **re-apply your change** (you know
   what it was — just redo the edits on this fresh branch).
3. `git_open_pr(...)` → `git_merge_pr` → `git_delete_branch` the stale branch
   (`remote=true`). Because you started from current `main`, there's no conflict.

Both paths are safe. When in doubt, prefer **B** for small changes — it can't get
stuck. Never leave the user a list of terminal commands to run; finish the git
work with your tools.

### NEVER do these

- **Never** hand the user raw `git`/shell commands — you have tools; use them.
- **Never** commit directly to `main` beyond a one-line hotfix (typo, manifest
  entry). Even small changes go through a branch + PR.
- **Never** `git_force_push` the default branch.
- **Never** leave stale branches — delete them (local + remote) after merging.
- **Never** "merge" by editing files to look merged — resolve the actual conflict
  markers or rebuild from `main`.
