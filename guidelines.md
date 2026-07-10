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

### NEVER do these

- **Never** hardcode a file list in Kotlin that duplicates the manifest. The `manifestList()` helper already falls back to reading `ota_manifest.json` from the repo; the hardcoded fallback list in `legacyUpdateAgent()` is ONLY a last-resort bootstrap to restore `ota.py`.
- **Never** edit a Kotlin file to add/remove a Python or web module — that would require an APK rebuild, defeating the whole point of OTA.
- **Never** put OTA-updatable logic in Kotlin. All update logic (fetch, verify, atomic write, self-update, pruning) lives in `ota.py` which itself is OTA-updatable.
- **Never** skip the manifest when adding a file. If it's not in `ota_manifest.json`, it won't reach the device.

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

## Git Branching Workflow — Feature Branches Required

**Every new feature or non-trivial change MUST be developed in its own branch. Never commit directly to `main`.**

### The workflow

1. **Start a feature branch**: `git checkout -b feature/<short-name>` (e.g. `feature/edit-mode`, `feature/dark-theme`). The branch name should be descriptive and kebab-case.
2. **Build the feature**: all commits for that feature go on the feature branch. Commit frequently with clear messages.
3. **Push to remote**: `git push -u origin feature/<short-name>` so the branch exists on GitHub.
4. **Merge to main when done**: once the feature is complete and verified, merge it into `main`:
   ```
   git checkout main
   git pull origin main
   git merge feature/<short-name>
   git push origin main
   ```
5. **Delete the feature branch** after merging (both locally and on remote):
   ```
   git branch -d feature/<short-name>
   git push origin --delete feature/<short-name>
   ```

### Why this matters

- `main` is the production branch — the OTA system pulls from it. Broken code on `main` breaks the app for every user on the next update.
- Feature branches let you test safely by pointing a device at the feature branch (`OTA_BRANCH = feature/<short-name>`) before merging.
- If something goes wrong, you can abandon the branch without polluting `main`.

### NEVER do these

- **Never** commit directly to `main` for anything beyond a one-line hotfix (typo, manifest entry). Even small changes should go through a branch.
- **Never** leave stale feature branches — delete them after merging.
- **Never** merge a branch you haven't pushed — the agent needs to push so the user can see/test the changes on their device.
