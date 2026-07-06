# Voice Agent — on-device multi-agent coding, driven by voice

A native Android app that lets you speak a coding task and have AI agents plan,
write, and commit code **entirely on your device**. Models run remotely (so your
phone stays light); everything else — orchestration, file editing, git — runs
on-device via an embedded Python interpreter.

## Architecture

```
Native Android (Kotlin)          Embedded Python (Chaquopy)        Remote
┌──────────────────────┐         ┌────────────────────────┐       ┌──────────┐
│ SpeechRecognizer ────┼────────▶│ orchestrator.run_task  │──────▶│ Opus     │  (lead / architect)
│ (voice in)           │         │   ├ plan (Opus)        │       └──────────┘
│ TextToSpeech         │◀────────┤   ├ edit files (worker)│──────▶┌──────────┐
│ (voice out)          │         │   ├ write under HOME   │       │ DeepSeek │  (worker / editor)
│ Chat UI              │         │   └ commit (dulwich)   │       └──────────┘
└──────────────────────┘         └────────────────────────┘
```

- **Opus** is the lead: it reads your task and the repo, returns a JSON edit plan.
- **DeepSeek V4** is the worker: it writes each file, cheaply.
- **dulwich** does git with no binary (verified working).
- Model calls go out over plain **HTTPS via the Python stdlib** (`urllib`).
  litellm was the original plan but can't be bundled on Android (it pulls
  native/Rust deps like `fastuuid` and `tiktoken` that have no Android
  wheels), so `orchestrator.py` calls the Anthropic and DeepSeek HTTP APIs
  directly — no third-party HTTP dependency required.

## Build it — no Android Studio required (cloud build)

This repo builds itself on GitHub Actions. To get an installable APK:

1. Create a new GitHub repository and push this folder to it:
   ```bash
   git init
   git add .
   git commit -m "Initial commit"
   git branch -M main
   git remote add origin https://github.com/YOUR_USERNAME/YOUR_REPO.git
   git push -u origin main
   ```
2. Go to the repo's **Actions** tab. The **Build APK** workflow runs automatically
   on push (you can also trigger it manually with **Run workflow**).
3. When it finishes (green check), open the run and download the
   **voice-agent-debug-apk** artifact from the *Artifacts* section.
4. Unzip it, transfer the `.apk` to your Android phone, and install it
   (you'll need to allow "install from unknown sources").

The first build downloads the Android SDK, Gradle, and Chaquopy's Python
components, so it takes several minutes. Later builds are faster (cached).

## First run on the phone

1. Launch the app, tap the gear icon, and paste your **Anthropic** and
   **DeepSeek** API keys. They're stored locally on the device only.
2. Grant microphone permission when asked.
3. Tap **Tap to speak** and say a task, e.g.
   *"Create a Python function that reverses a string and add a test."*
4. Watch the transcript: the agent plans, writes files, and commits. The result
   is read back aloud.

Files live in the app's private storage under a `workspace/` git repo.

## Known limitations (read these)

- **Debug APK, not a release build.** This workflow produces an unsigned debug
  APK for personal installation. For **Play Store** release you must (a) switch
  to `bundleRelease` producing an `.aab`, (b) set up app signing, and (c) NOT
  ship any API keys in the app — the current design correctly asks the *user*
  for their own keys, which is the right model for a public app.
- **Dependency ceiling.** Only pure-Python packages that Chaquopy can bundle are
  usable. `dulwich` is verified; model calls use the stdlib `urllib` instead
  of `litellm` (which needs native wheels Android lacks). Heavier frameworks (CrewAI,
  Aider) may pull C-extension dependencies that lack Android wheels — that's why
  this uses a hand-rolled orchestrator instead.
- **Turn-taking is one-shot.** Speak → wait → hear result. No interrupting a
  running task by voice (Android speech recognizer limitation).
- **No arbitrary shell execution.** The agent edits and commits files. It does
  NOT run tests or shell commands on-device (that needs an embedded proot layer,
  intentionally out of scope for this first version). Model calls + file edits +
  git cover most workflows.
- **Model strings may need updating.** `orchestrator.py` uses
  `anthropic/claude-opus-4-20250514` and `deepseek/deepseek-chat`. If a call
  errors on an unknown model, update those constants (or set `LEAD_MODEL` /
  `WORKER_MODEL` env vars) to the current provider model names.
- **Background limits.** A foreground-service scaffold (`AgentService`) is
  included for long runs but not yet wired to the task loop.

## Verifying the Python core locally (optional)

The orchestrator's logic can be exercised without a phone:
```bash
cd app/src/main/python
HOME=/tmp python3 orchestrator.py --selftest
```
This mocks the model calls and proves the plan → edit → write → commit pipeline.

## Project layout

```
build.gradle.kts                 root plugins
settings.gradle.kts              modules + repos
app/build.gradle.kts             Android + Chaquopy config, pip deps
app/src/main/python/
    orchestrator.py              the agent brain (tested)
app/src/main/java/.../MainActivity.kt   voice UI + Python bridge
app/src/main/java/.../AgentService.kt   foreground-service scaffold
app/src/main/res/                layouts, strings, icons, theme
.github/workflows/build.yml      cloud build → APK artifact
```
