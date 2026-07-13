# PLAN.md — Mobilecode: Game Studio Edition

**Goal:** Evolve the VoiceAgent mobile coding app into a phone-only game studio.
The user codes games by voice/text on an Android phone and ships **sellable**
builds to five platforms: **Web, Android, Windows/Linux (PC), macOS, iOS.**

**Executor:** This plan is written for an AI coding agent (DeepSeek or Claude)
to follow. Do not improvise beyond it. Do not skip steps.

---

## 0. How to use this document (rules for the agent)

1. **Work one phase at a time, in order.** Do not start a phase until the
   previous phase's "Definition of done" checklist is fully green.
2. **Work one task at a time.** Each task ends with a commit. Commit messages
   start with the task ID, e.g. `P2.3: install toolchain into rootfs`.
3. **Never break an existing feature.** Appendix A lists every current
   feature. If a task would remove or change one, STOP and ask the user.
4. **Run the acceptance check after every task.** If it fails, fix it before
   moving on. Never mark a task done on a failing check.
5. **Git safety (non-negotiable):**
   - Never develop on `main`. Create a branch per phase: `phase-1-bundles`,
     `phase-2-proot`, etc. Merge to `main` only when the phase is done.
   - Never run `git reset --hard`, `git checkout .`, `git clean -f`,
     `git push --force`, or delete branches while uncommitted or unpushed
     work exists. Push after every task.
   - Before saying work is or isn't shipped, check `git status` and
     `git log --branches --not --remotes` — never modify state to answer.
6. **OTA golden rule (from `guidelines.md`, still applies):** every file you
   add/change/remove that is OTA-updatable must be listed in
   `ota_manifest.json`, and `content_version` must be bumped **in the same
   commit**. The Kotlin layer stays a dumb bootstrap; no updatable logic in
   Kotlin.
7. **When something is impossible or ambiguous, stop and ask.** Do not guess
   at signing keys, store accounts, or anything involving the user's money.

---

## 1. The target architecture (read this before coding)

Today the app is: Kotlin shell → WebView UI → embedded Python (Chaquopy)
agent → dulwich fake-git → GitHub Actions for real builds. Games are written
against the bundled WebGL engine and previewed in a WebView.

We are adding, without removing anything:

```
┌─ Android app (existing) ──────────────────────────────────────────┐
│ WebView UI · voice · agent loop · tools · OTA · sessions          │
│                                                                   │
│  NEW: proot Linux layer                NEW: game pipeline         │
│  ┌──────────────────────────┐          ┌───────────────────────┐  │
│  │ real git · clang · emcc  │          │ game bundle format    │  │
│  │ zip/apksigner · shell    │          │ web export (itch.io)  │  │
│  │ tool for the agent       │          │ APK repack (sideload) │  │
│  └──────────────────────────┘          │ "Ship" → cloud builds │  │
│                                        └───────────┬───────────┘  │
└────────────────────────────────────────────────────┼──────────────┘
                                                     ▼
                       GitHub Actions (free, incl. macOS machines)
                       web zip · Windows/Linux (Tauri) · macOS (Tauri)
                       iOS (Tauri) · Android AAB (Gradle shell)
```

**Key decisions (do not revisit them):**

- **Games are web games.** One bundle of HTML/JS/WASM runs identically on all
  five platforms inside thin per-platform shells. The existing WebGL engine
  stays the primary game framework.
- **The phone builds what a phone can build**: web zips instantly, and
  sideloadable Android APKs by *repacking* a prebuilt shell (no on-device
  compilation). Store-grade builds (signed AAB, PC, Mac, iOS) come from
  GitHub Actions — the same mechanism the app already uses to build itself.
- **The proot layer is a power tool, not the runtime.** It provides real
  git, clang, and Emscripten (C → WebAssembly). Games do NOT depend on proot
  to run; graphics stay WebGL in the WebView (GPU-accelerated, no X11).
- **Store paperwork is the user's job**, done once from a phone browser:
  Google Play $25 one-time, Apple Developer $99/yr, Steam $100/game,
  itch.io free. The plan never handles the user's passwords or payment.

---

## Phase 0 — Bootstrap the new repo

**Purpose:** stand the existing app up in this repository, fully working,
before changing anything.

- **P0.1** Copy the entire VoiceAgent source tree from the old repo into this
  repo unchanged: `app/`, `engine_src/`, `gradle*`, `settings.gradle.kts`,
  `build.gradle.kts`, `ota_manifest.json`, `guidelines.md`, `.github/`,
  `README.md`.
  *Done when:* `git status` clean after commit; file count matches the source.
- **P0.2** Run the offline self-test:
  `cd app/src/main/python && HOME=/tmp python3 orchestrator.py --selftest`.
  *Done when:* self-test passes (tools → verify → repair → commit).
- **P0.3** Run the engine test: `cd engine_src && node test.mjs`.
  *Done when:* it passes.
- **P0.4** Push to `main`, confirm the **Build APK** GitHub Actions workflow
  goes green and produces the `voice-agent-debug-apk` artifact.
  *Done when:* green run, artifact downloadable.
- **P0.5** Update `ota_manifest.json` raw URLs / repo references to point at
  THIS repo so OTA updates flow from here. Bump `content_version`.
  *Done when:* `ota.py`'s manifest URL resolves to this repo and a device
  "Update All" fetches from it.

**Definition of done (Phase 0):** all five checks green. The app installs and
runs exactly as before. Appendix A features all still work.

---

## Phase 1 — Game bundles + web export (first sellable output)

**Purpose:** define the portable game format and export it as a zip the user
can upload to itch.io and sell. No new native code.

- **P1.1** Define the bundle format. Create `docs/BUNDLE.md` specifying: a
  game is a folder containing `index.html` (entry point), `game.json`
  (metadata), and any assets/JS/WASM it needs, all with **relative paths
  only** (must work from `file://` and from any subdirectory of a web
  server). `game.json` schema (all fields required):

  ```json
  {
    "id": "lowercase-hyphens-only",
    "name": "Display Name",
    "version": "1.0.0",
    "orientation": "landscape | portrait | any",
    "icon": "icon.png"
  }
  ```
  `icon.png` is square, 512×512.
  *Done when:* `docs/BUNDLE.md` exists and matches the above.
- **P1.2** Add `app/src/main/python/bundle.py` with:
  - `validate(path) -> str` — checks `game.json` against the schema, checks
    `index.html` and the icon exist, checks no absolute paths / no external
    `http(s)://` script tags (games must be self-contained). Returns "ok" or
    a list of problems.
  - `export_web(path) -> str` — runs `validate`, then zips the bundle to
    `<workspace>/dist/<id>-<version>-web.zip` (this is exactly what itch.io
    accepts for HTML5 games). Returns the zip path or the validation errors.
  Register both as orchestrator ops and add `export_web` to the agent tool
  belt in `agent_tools.py`. List `bundle.py` in `ota_manifest.json` `python`
  array; bump `content_version`.
  *Done when:* in a workspace containing a template game, calling
  `export_web` produces a zip; unzipping it and opening `index.html` in a
  browser runs the game.
- **P1.3** Update the game templates (`templates.py` / engine template) so
  every new game project is born as a valid bundle: template includes
  `game.json` and a placeholder 512×512 `icon.png`. Bump `content_version`.
  *Done when:* new project from template passes `validate` with zero edits.
- **P1.4** Add an "Export for web" button to the web UI (`app.js`) that calls
  the op and shows the resulting file path with a share action (Android
  share sheet via a new small `share` bridge action in `MainActivity.kt` —
  bootstrap-only code, allowed in Kotlin). Bump `content_version`.
  *Done when:* tap button → zip created → share sheet opens with the zip.
- **P1.5** Teach the agent: add a short section to `sysguide.py` — "games are
  bundles; keep `game.json` valid; bump its `version` on release; assets
  relative-path only." Bump `content_version`.

**Definition of done (Phase 1):** From the phone: speak a game into
existence → preview it → Export for web → upload the zip to itch.io → the
game is playable and sellable on the web. Appendix A regression list passes.

---

## Phase 2 — The proot Linux layer

**Purpose:** give the agent a real Linux userland on-device: real git, clang,
Emscripten, and the packaging tools Phase 3 needs. This phase is plumbing;
nothing user-visible ships except a working "shell" capability.

**Background you must understand before starting:**
- Android blocks `exec()` of downloaded files for apps targeting modern API
  levels — **except** files inside the APK's native library directory.
  Therefore the `proot` static binary ships INSIDE the APK as
  `app/src/main/jniLibs/arm64-v8a/libproot.so` (a fake .so). proot then runs
  the rootfs's programs through its own loader, so only proot itself ever
  needs exec permission.
- The rootfs (a full Linux filesystem) is far too big for the APK. It is
  downloaded on first use through the existing OTA `extra` mechanism with a
  `sha256`, into app-private storage.
- Distribution reality: this pattern is fine for sideload/F-Droid/GitHub
  releases. Do not plan on Play Store distribution of the STUDIO app itself.

Tasks:

- **P2.1** Obtain a static `proot` built for `aarch64` (build it in a GitHub
  Actions job from the proot-me/proot source, or take the termux-maintained
  static build; commit the Actions workflow that produces it so it is
  reproducible). Place it at `app/src/main/jniLibs/arm64-v8a/libproot.so`.
  *Done when:* the APK builds and `Context.applicationInfo.nativeLibraryDir`
  contains `libproot.so` on-device.
- **P2.2** Build the rootfs in CI: a GitHub Actions workflow
  (`.github/workflows/rootfs.yml`) that takes an Alpine Linux `aarch64`
  minirootfs, installs `git bash coreutils zip unzip` inside it (via chroot
  or apk --root), tars it, records its sha256, and uploads it as a release
  asset of this repo.
  *Done when:* workflow green; release asset `rootfs-aarch64.tar.gz` +
  printed sha256 exist.
- **P2.3** Extend the rootfs with the compiler toolchain: add `clang`, `make`,
  `python3`, and **Emscripten** to the image (Emscripten via `emsdk` inside
  the rootfs). Also add `apksigner` + `zipalign` equivalents: install
  `openjdk17-jre-headless` and the `apksigner.jar` from Android build-tools
  (jar runs on any JVM; no native build-tools needed).
  Keep two artifacts: `rootfs-min` (git+shell, ~50 MB) and `rootfs-full`
  (toolchain, larger). *Done when:* both release assets exist with sha256s.
- **P2.4** Add `app/src/main/python/prootenv.py`:
  - `install(kind) -> str` — downloads `rootfs-min` or `rootfs-full` (URL +
    sha256 read from `ota_manifest.json` `extra` entries), verifies sha256,
    extracts to `<filesDir>/rootfs/`. Idempotent; resumable download.
  - `sh(cmd, cwd=None, timeout=120) -> {"exit": int, "out": str}` — runs
    `libproot.so -r <rootfs> -b <workspace>:/workspace -w /workspace
    /bin/sh -c <cmd>` via `subprocess`, captures output, enforces timeout,
    truncates output over 20 000 chars.
  List it in `ota_manifest.json`; bump `content_version`.
  *Done when:* on a device, `sh("git --version")` returns a version string.
- **P2.5** Expose it to the agent: add a `shell` tool in `agent_tools.py`
  (input: `cmd`, optional `timeout`) that calls `prootenv.sh` **with the
  workspace mounted at /workspace**. Guardrails, enforced in code before
  running: refuse `rm -rf /`-style commands touching the rootfs itself;
  always run with the workspace as cwd. Add to `sysguide.py`: prefer the
  existing purpose-built tools; use `shell` for compilers, real git
  plumbing, and packaging only. Bump `content_version`.
  *Done when:* an agent run can execute `shell {"cmd": "clang --version"}`.
- **P2.6** C→WASM path: add a `build_wasm` tool that runs
  `emcc <sources> -o game.wasm.js` inside proot with sane defaults
  (`-O2 -s WASM=1`), so games can include C-compiled modules that still run
  in every browser/WebView.
  *Done when:* a sample C file in a workspace compiles and the produced
  JS+WASM loads in the preview WebView.
- **P2.7** UI: a one-time "Install toolchain" screen (progress bar for the
  rootfs download) and a settings row showing installed/version/size with a
  reinstall action. Bump `content_version`.

**Definition of done (Phase 2):** fresh install → Install toolchain →
agent can run real `git`, `clang`, `emcc`, and `java -jar apksigner.jar`
on-device. Existing dulwich git path still works untouched (do NOT replace
`git_ops.py` in this phase). Appendix A regression list passes.

---

## Phase 3 — On-device Android packager (APK repack)

**Purpose:** turn any game bundle into an installable, signed Android APK in
seconds, on the phone, with **zero compilation**.

**How it works (read carefully — this is the foolproof trick):** we never
compile on the phone. CI builds ONE generic "game shell" APK once. The phone
copies it, swaps the game files in, stamps a unique application id, and
re-signs. The only binary edit is a **same-length string substitution**:

- The shell is built with applicationId `com.mcgame.aaaaaaaaaaaa` (exactly
  12 placeholder chars). To stamp a game, replace every occurrence of that
  byte string in `AndroidManifest.xml` and `resources.arsc` inside the APK
  with `com.mcgame.<12-hex-chars>` derived from sha256 of the game id —
  **identical byte length**, so all binary offsets stay valid.
- The launcher label and icon are NOT baked into resources: the shell reads
  `game.json` at runtime for its window title, and CI builds the shell with
  a generic icon. (Per-game launcher icons come from the store builds in
  Phase 4; on-device repacks all share the studio icon — acceptable for
  test/sideload builds. State this limitation in the UI.)

Tasks:

- **P3.1** Create the shell app as `shell-android/` in this repo: a minimal
  Kotlin project — one Activity with a WebView that loads
  `file:///android_asset/game/index.html`, fullscreen, orientation read from
  `game.json`, WebGL + audio enabled, back-button handling. applicationId
  `com.mcgame.aaaaaaaaaaaa`. No network permission (games are offline;
  revisit only if the user asks).
  *Done when:* `shell-android` builds locally in CI and, with a sample game
  copied into `assets/game/`, plays it.
- **P3.2** CI workflow `.github/workflows/shell.yml`: builds
  `shell-template.apk` (release-unsigned) and publishes it as a release
  asset with sha256. Add an `extra` entry in `ota_manifest.json` so devices
  download it like the rootfs. Bump `content_version`.
- **P3.3** Add `app/src/main/python/packager.py`:
  - `make_apk(bundle_path) -> str`:
    1. `validate` the bundle (Phase 1).
    2. Copy `shell-template.apk` to a temp dir; open with `zipfile`.
    3. Remove existing `assets/game/*`; insert the bundle as `assets/game/`.
    4. Do the same-length id substitution in `AndroidManifest.xml` and
       `resources.arsc` (raw bytes; assert occurrence count > 0 and that
       replacement length == placeholder length, else abort).
    5. Remove `META-INF/*` (old signature), rewrite the zip with correct
       alignment (store uncompressed entries 4-byte aligned; run zipalign
       via proot if present, else pure-Python align).
    6. Sign: keystore auto-generated once per device
       (`keytool` via proot JRE) and reused; sign with
       `java -jar apksigner.jar` via proot.
    7. Output `<workspace>/dist/<id>-<version>.apk`.
  List in `ota_manifest.json`; bump `content_version`.
  *Done when:* `make_apk` on a template game outputs an APK that installs
  and runs on a real device alongside a second game's APK (different ids).
- **P3.4** UI: "Build Android APK" button next to "Export for web"; result
  row offers Install (ACTION_VIEW intent — small Kotlin bridge addition) and
  Share. Bump `content_version`.
- **P3.5** Agent tool `package_android` wrapping `make_apk`, and a
  `sysguide.py` note describing the two on-device outputs (web zip, APK).
  Bump `content_version`.

**Definition of done (Phase 3):** phone-only flow: make game → tap button →
signed APK → installs and plays on the same phone and on a friend's phone.
Two different games install side-by-side. Appendix A passes.

---

## Phase 4 — "Ship" pipeline: PC, Mac, iOS, and store-grade Android

**Purpose:** one button that turns a game bundle into store-uploadable
builds for every platform, using GitHub Actions (free macOS machines make
Mac + iOS possible with no computer).

**Structure:** each shipped game gets its own GitHub repository, created
from a template repo that contains the per-platform shells + workflows. The
studio app pushes the bundle into `game/` in that repo; Actions do the rest.
The app already has everything needed to drive this: repo creation, push,
workflow trigger, run status, failure-log fetch, and the fix-CI loop
(`git_ops.py`, `PrWatchWorker.kt`).

Tasks:

- **P4.1** Create the template repo content under `ship-template/` in this
  repo (it will be pushed to a standalone `mobilecode-ship-template` repo by
  CI so GitHub's "template repository" feature can be enabled once,
  manually, by the user):
  - `game/` — placeholder bundle (replaced by the studio on ship).
  - `desktop/` — a Tauri v2 project whose webview loads `../game/` assets;
    workflow `build-desktop.yml` builds Windows `.msi`/`.exe`, Linux
    `.AppImage`, macOS `.app`/`.dmg` on the matching runners and uploads all
    as artifacts. Unsigned first; signing added in P4.4.
  - `ios/` — the same Tauri project's iOS target; workflow `build-ios.yml`
    on `macos` runner producing an `.ipa` (unsigned build first).
  - `android/` — a copy of the Phase 3 shell as a proper Gradle project;
    workflow `build-android.yml` producing a signed `.aab` (Play requires
    AAB) using keystore secrets.
  - `web/` — workflow `build-web.yml` zipping `game/` (itch parity in CI).
  - `README.md` explaining exactly which artifact goes to which store.
  *Done when:* pushing a sample bundle to a repo created from the template
  turns all four workflows green with downloadable artifacts (unsigned
  where signing isn't configured yet).
- **P4.2** Studio-side `ship.py`:
  - `ship(bundle_path) -> str`: validate; create (or reuse) the game's repo
    from the template (GitHub API `generate` endpoint via `git_ops._api`);
    replace `game/` with the bundle; commit; push; trigger workflows; return
    the repo URL. Registered as op + agent tool `ship_game`.
  - `ship_status() -> str`: per-platform workflow status + artifact download
    URLs, reusing `git_ops` Actions helpers.
  List in `ota_manifest.json`; bump `content_version`.
  *Done when:* "Ship" from the phone yields, within one CI cycle, artifacts
  for web/desktop/iOS/Android in the game repo.
- **P4.3** UI: a Ship screen — per-platform status chips (queued/building/
  green/failed), artifact links opening in the browser, and a "Fix build"
  button on any failed platform that feeds that workflow's failure log into
  the existing fix-CI agent loop. Wire `PrWatchWorker`-style polling so the
  user gets a notification when all platforms are green. Bump
  `content_version`.
- **P4.4** Signing & store docs — `docs/SELLING.md`, written for the user
  (plain language), covering, per store: account cost, which artifact to
  upload, and how to add signing secrets to the game repo from a phone
  browser (Android keystore base64 → `ANDROID_KEYSTORE` secret; Apple
  cert/profile → `IOS_CERT`/`IOS_PROFILE` secrets; Tauri updater keys).
  Update the workflows to sign when secrets exist and fall back to unsigned
  otherwise. **The agent must never ask for or store passwords/certs in the
  studio app; secrets live only in GitHub repo secrets.**
  *Done when:* with secrets configured on a test repo, Android AAB and iOS
  IPA come out signed; without secrets, workflows still pass unsigned.

**Definition of done (Phase 4):** phone-only: Ship → five platform artifacts
→ `docs/SELLING.md` walks the user through uploading each to its store.
Appendix A passes.

---

## Phase 5 — Store polish

**Purpose:** the boring assets stores demand, generated by the agent.

- **P5.1** `storeassets.py`: from the bundle's 512×512 `icon.png`, generate
  every required icon size (Play, App Store, desktop) using pure-Python
  image resizing (Pillow is available under Chaquopy; if not, do it via a
  tiny canvas page in the hidden WebView and the existing bridge). Output
  into the game repo's `store/` folder on ship.
- **P5.2** Screenshot capture: a bridge action that snapshots the preview
  WebView to PNG at phone resolution; agent op `capture_screenshots` that
  loads the game, waits N seconds, captures, repeats. Store in `store/`.
- **P5.3** `release.py`: `bump_release(kind)` — bumps `game.json` version
  (patch/minor/major), re-exports web zip, re-runs `ship`, tags the game
  repo `v<version>`. One command = new version everywhere.
- **P5.4** Store listing text: agent op `draft_listing` producing title,
  short and long descriptions, and tags from the game's README + code, saved
  to `store/listing.md` for the user to paste.
- **P5.5** Final docs pass: update `README.md` (studio repo) with the full
  make→test→export→ship→sell walkthrough; update `guidelines.md` with the
  bundle/ship rules so every future agent session knows them.

**Definition of done (Phase 5):** shipping a version update is one action;
each store's upload form can be completed with files/text found in the game
repo's `store/` folder. Appendix A passes.

---

## Appendix A — Feature inventory (regression checklist)

Everything below exists today and must still work after every phase. Test
what a phase touches; spot-check the rest at each phase boundary.

**Shell (Kotlin):** WebView chat UI + JS↔Python bridge (`agent`, `orch`,
`run`, `ui`, `listen`, `speak`, `notify`, `update*`); voice dictation in
(SpeechRecognizer) and spoken replies out (TTS); foreground service keeps
runs alive in background/Doze; PR watcher (WorkManager) with notify +
optional auto-fix + stop-on-merge; preview activity (localhost WebView,
fullscreen-capable, console capture); folder-per-session workspaces.

**Providers (`llm.py`):** Claude + DeepSeek behind one neutral tool schema;
streaming; retries; sticky fallback-model failover; prompt caching; thinking
toggle (incl. DeepSeek V4 hybrid); separate orchestrator/implementer effort
levels; per-model token accounting; DeepSeek balance readout.

**Agent loop (`agentloop.py`):** tool loop with plan mode
(propose→approve→execute) and write mode; verify→repair gate including
runtime (preview console) errors; mid-run steering; interrupt; transcript
pruning; frugal mode; optional reviewer-model pass; worker delegation.

**Tools (`agent_tools.py`):** read/write/str_replace/delete/list/grep;
check_python/check_web/check_structure/check_secrets/run_tests; web_fetch;
todo_write; note_write; 16 git tools (status→ship); brainstorm /
delegate_edit / delegate_parallel (parallel multi-agent, `workflows.py`);
workspace path sandbox.

**Orchestrator (`orchestrator.py`):** ask/run_task/plan/execute_plan/
fix_build/commit_now; triage; diff gate (get_diff/discard/revert) +
autocommit toggle + generated commit messages; context assembly (sysguide +
guidelines + outline + pinned files + persistent discussion, cached);
compaction controls; caveman mode; dependency map (`projectmap.py`);
diagnostics (`agentevals.py`: analyze/run scenarios/LLM judge); templates;
guidelines & best-practices editing; merged-branch cleanup; event log +
polling + steer + interrupt ops.

**Git/GitHub (`git_ops.py`):** PAT auth; repo create/delete/list/clone;
branch lifecycle incl. prune + update-from-base; commit; REST push; pull
with conflict handling; ship (branch→PR); PR create/status/check/merge;
Actions trigger + status + CI failure-log fetch.

**Knowledge:** `sysguide.py` (system-wide, OTA-updatable, per-device
overrides); per-project `guidelines.md`; `best_practices.py` playbook.

**Engine (`engine_src/` → `engine3d.py` template):** custom WebGL 3D engine
(event bus, entities, single-WebGL-file renderer, swappable cameras, ~40
systems), CONTRACTS.md interface, twin-stick example, headless Node test,
`regen.py` packer, asset-budget/function-cap gates.

**Preview:** `localrun.py` WSGI/static server into the preview WebView;
runtime errors feed the verify gate.

**Web UI:** markdown chat with per-turn cost; live progress + todo
checklist; plan approval; run bar (stop/steer); sessions CRUD + per-session
models; effort/thinking/fallback settings; balance chip; PR-watch controls;
diff modal; visual **edit mode** (tap/drag/resize elements in preview →
edits back to agent).

**OTA:** manifest-driven self-updating loader; python/web/extra roots;
sha256; prune; `content_version` gating; full hot-reload without APK
rebuild.

**CI:** `build.yml` builds the studio APK on GitHub Actions.

## Appendix B — Glossary

- **Bundle** — a self-contained folder of web files + `game.json`; the one
  true form of a game.
- **proot** — user-space chroot; lets an unrooted Android app run a Linux
  filesystem's programs. Ships as `libproot.so` so Android permits exec.
- **Rootfs** — the Linux filesystem image proot runs (Alpine aarch64 here).
- **Repack** — stamping a prebuilt shell APK with a game's files + a
  same-length application id, then re-signing. No compilation.
- **Shell** — a thin native app whose only job is to display a bundle
  (Android WebView shell, Tauri desktop/iOS shells).
- **Ship** — push bundle to the game's repo → CI builds all platforms.
