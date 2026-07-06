# Voice Agent — on-device multi-agent coding, driven by voice

A native Android app that lets you speak a coding task and have AI agents plan,
write, and commit code **entirely on your device**. Models run remotely (so your
phone stays light); everything else — orchestration, file editing, git — runs
on-device via an embedded Python interpreter.

## Architecture

```
Native Android (Kotlin)          Embedded Python (Chaquopy)         Remote
┌──────────────────────┐         ┌─────────────────────────┐       ┌──────────┐
│ WebView chat UI      │         │ agentloop.run           │──────▶│ Claude   │
│ SpeechRecognizer     ├────────▶│  read/grep/edit tools   │  or   ├──────────┤
│ TextToSpeech         │◀────────┤  verify → repair        │──────▶│ DeepSeek │
│ Foreground service   │         │  diff → commit (dulwich)│       └──────────┘
└──────────────────────┘         │ git_ops: branch/PR/CI   │──────▶ GitHub API
                                 └─────────────────────────┘
```

- **The lead model drives an agentic tool loop** (`agentloop.py`): it reads
  the repo with tools (`read_file`, `grep`, `list_files`), edits with
  `str_replace`/`write_file`, syntax-checks and runs tests, and repairs its
  own failures — until the task is done. Either **Claude** (native tool use)
  or **DeepSeek** (OpenAI-style function calling) can be the lead; both speak
  through one provider layer (`llm.py`).
- **An optional cheap implementer** (WORKER_MODEL, e.g. `deepseek/deepseek-chat`)
  is exposed to the lead as a `delegate_edit` tool for mechanical edits.
- **llm.py** handles both wire formats plus streaming, retries with backoff,
  Anthropic prompt caching, and real token accounting — stdlib `urllib` only
  (litellm can't be bundled on Android: it pulls native/Rust deps like
  `fastuuid` and `tiktoken` with no Android wheels).
- **dulwich** does git with no binary; **git_ops.py** adds GitHub: clone,
  work branches, non-force push, pull requests, Actions builds, and fetching
  CI failure logs so the agent can fix its own broken builds.

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
  usable. `dulwich` is verified; model calls use the stdlib `urllib`. Projects
  the agent builds face the same ceiling: pure-Python (stdlib/WSGI) or static
  web apps preview on-device; anything needing native wheels won't.
- **No arbitrary shell execution.** The agent edits files, syntax-checks
  Python, runs pure-Python unittests in-process (the verify gate now blocks
  "done" on a failing test, not just a syntax error), fetches URLs
  (`web_fetch`), and previews web apps in a WebView — but there is no real
  shell (that needs an embedded proot layer). The escape hatch is the cloud:
  push and let GitHub Actions build, then use **Fix CI build** to feed failure
  logs back to the agent.
- **Turn-taking is one-shot.** Speak → wait → hear result (enable
  **Speak replies** to have answers read aloud). You can Stop a running task
  from the run bar, but not by voice.
- **Models.** Pick any listed model per session from the model switcher (or set
  `LEAD_MODEL` / `WORKER_MODEL`). DeepSeek **V4 Flash/Pro** (`deepseek-v4-flash`,
  `deepseek-v4-pro`) are hybrid Thinking/Non-Thinking models: the **Thinking**
  toggle sends `thinking:{type:enabled|disabled}` so turning it off actually
  stops reasoning generation and its token cost — not just the display.
  (`deepseek-reasoner` always reasons; `deepseek-chat` never does, so the toggle
  is moot for those.) Set a **Fallback model** in Settings and a run that hits an
  overloaded/failed provider fails over to it (e.g. Claude → DeepSeek) instead of
  dying. See `PARITY.md` for the full feature-parity audit and roadmap.

## Verifying the Python core locally (optional)

The agent loop can be exercised without a phone or API keys:
```bash
cd app/src/main/python
HOME=/tmp python3 orchestrator.py --selftest
```
This drives the loop with a scripted fake model and proves
tools → verify → repair → commit end to end.

## Project layout

```
build.gradle.kts                 root plugins
settings.gradle.kts              modules + repos
app/build.gradle.kts             Android + Chaquopy config, pip deps
app/src/main/python/
    llm.py                       provider layer: Claude + DeepSeek, tools,
                                 streaming, retries, caching, usage
    agent_tools.py               the tool belt (read/grep/edit/check/tests)
    agentloop.py                 the agentic loop (the brain's engine)
    orchestrator.py              modes, context, diff gate, commits
    git_ops.py                   GitHub: repos, branches, PRs, CI logs
    localrun.py                  on-device web preview server
    agent_loader.py              OTA hot-reload of all of the above
app/src/main/java/.../MainActivity.kt   WebView shell + Python bridge
app/src/main/java/.../AgentService.kt   foreground service for long runs
app/src/main/assets/web/         the chat UI (HTML/CSS/JS, OTA-updatable)
.github/workflows/build.yml      cloud build → APK artifact
```
