# Voice Agent — Feature-Parity Audit vs. claude.ai/code

*Repo: `efficientengineer/mobilecode` · branch `claude/feature-parity-audit-5h9gqx` · audited 2026-07-06*

Method: 155 claude.ai/code capabilities were cataloged from the docs + knowledge,
then each of 12 dimensions was audited against the actual source (every claim carries
`file:line` evidence), each claimed gap was adversarially re-verified against the code
to avoid false "missing" calls, and a completeness-critic pass corrected the draft.
The goal is parity with **claude.ai/code** (Claude Code *on the web* — the cloud/GitHub
version), **while DeepSeek can drive the agent as a first-class model**, not just Claude.

## 1. Executive summary

The app has genuine parity on the **inner coding loop** — the file tools, the agentic
inspect→edit→verify→repair cycle, provider-neutral model routing, prompt caching, and
context/memory assembly are all well-built, and crucially they are **provider-agnostic**:
one neutral tool schema transcodes to both Anthropic `tool_use` and OpenAI-style
function-calling (`llm.py`), so DeepSeek is a true driver, not a bolt-on. Overall parity
is roughly **50/100**, but that average is bimodal: the model/tools/context core scores
73–78 while everything *around* the loop is thin. The biggest structural gap is **reach** —
the agent can't touch anything outside the local workspace: no web fetch, no git-as-tools,
no image input. On a phone, where pasted URLs and screenshots are the natural inputs, that
boxes it in. Many absences (Bash, Docker, multi-runtime toolchains, cloud VMs, egress
policy) are legitimate **non-goals** for an unrooted Android app and are separated out in §5.

## 2. Parity scorecard

| Dimension | Score | Headline |
|---|---|---|
| Tools | 78 | Strong, provider-neutral file-tool belt; gaps are edit/search *richness*, not the loop |
| Models | 76 | Best-realized dimension — DeepSeek is a genuine first-class driver; no fallback chain |
| Context & Memory | 73 | Dual compaction, both-provider caching, persistent discussion; deterministic not LLM-summary |
| UI & Interaction | 68 | Solid mobile-native chat/progress/plan/stop; review + steer thin, TTS unwired |
| Sessions & Persistence | 61 | Folder-per-session with per-session models is a parity-plus; housekeeping unwired |
| Permissions | 60 | 3-mode model (auto/plan/code) + commit diff-gate ≈ web's Accept/Plan/Auto; no per-tool allowlist |
| Git & GitHub | 57 | Strong commit→push→PR→CI-fix path, but git is button-driven, not agent-orchestrated |
| Execution | 35 | No Bash by design; Python-only in-process runners, cloud CI compensates for builds |
| Lifecycle | 33 | Background-run survival well done; entire scheduled-routines subsystem absent |
| Tasks | 25 | Plan-approval works; TodoWrite / live checklist entirely absent |
| Web & Multimodal | 15 | No web search/fetch, no image/PDF input; only the local preview server exists |
| Extensibility | 7 | No MCP/commands/skills/hooks/plugins; only a developer-facing OTA hot-reload substrate |

## 3. Per-dimension detail

### Tools — 78/100
The core belt steers like claude.ai/code: `read_file` is line-numbered `cat -n` style with
offset/limit paging and an 800-line cap (`agent_tools.py:66-80`); `str_replace` carries the
same exact-match uniqueness guard + `replace_all` flag as Edit (`agent_tools.py:135-152`);
`write_file`, `delete_file`, `list_files`, `grep` round it out behind a clean
`toolset()/execute()` registry (`agent_tools.py:305-401`). Every tool works identically under
DeepSeek. Gaps are breadth, not the loop.
- **Present:** Read (paged, numbered), Write, Edit + uniqueness guard, replace_all, List, Grep,
  the loop (`agentloop.py:201-311`), delegate_edit.
- **Partial:** No atomic MultiEdit (independent `str_replace` calls, no rollback; `delegate_edit`
  can commit a partial apply, `agent_tools.py:294-300`). Glob is only an `fnmatch` filter (`*`
  crosses `/`, no mtime sort). Grep is a `re` line scanner (no `-i`/context/multiline).
- **Absent:** Read images/screenshots/PDFs (text-only; **and DeepSeek can't do vision at all**,
  so this would be Claude-only). NotebookEdit.

### Models — 76/100
The strongest dimension and the one that delivers the stated goal. `llm.py` is a clean unified
provider layer; Claude+DeepSeek, switching, SSE streaming, thinking capture, token accounting,
and tool-calling all fire for **both** providers. The DeepSeek live-balance chip actually
*exceeds* claude.ai/code.
- **Partial:** Extended thinking is **adaptive** (`{"type":"adaptive"}`, `llm.py:173`) with no
  user budget/effort knob, and the toggle only wires the Anthropic payload. **Likely correctness
  bug:** Claude thinking blocks (with signatures) are not echoed back into `_anthropic_messages`
  on later tool-loop turns (`llm.py:125-132`), which can 400 or silently degrade Claude thinking
  mid-loop.
- **Absent:** Fallback model chain — an overloaded provider kills the run (`agentloop.py:243-247`),
  yet both providers are already keyed and prefix-routed, so Claude↔DeepSeek failover is near-free.

### Context & Memory — 73/100
A real strength. `_full_context` assembles guidelines/CLAUDE.md + auto-outline + pinned files +
a **persistent per-project discussion** into one cached block every turn (`orchestrator.py:426-451`) —
the persistent history actually exceeds claude.ai/code's fresh-session default. Prompt caching works
for both providers; two compaction layers exist (discussion compactor + in-run transcript pruner).
- **Partial:** Compaction is deterministic pruning, **not** LLM summarization with a focus
  instruction — older detail is dropped, not summarized. Memory is single-scope (no
  user/local/managed hierarchy). Rewind is git-granularity and the discussion doesn't rewind with
  the files.
- **Absent:** `@path` memory imports; quick `#` memory-add.

### UI & Interaction — 68/100
Mobile-native and robust: chat with per-turn ctx-cost, a 500 ms event-poll live progress view with
tool icons + streamed deltas, plan propose/approve, working stop, a removable task-chip queue,
backgrounding survival + reattach, heads-up notifications, voice dictation.
- **Partial:** Diff review is a **read-only** text modal — no inline per-line comments that bundle
  into the next message, not even +/- coloring (`app.js` diff modal); this is a claude.ai/code core
  feature. Steering mid-run only *queues* for after; no injection into the live loop. **Voice output
  is dead in a "Voice Agent":** the `speak()` bridge + TTS engine exist (`MainActivity.kt:375-378`)
  but the UI never calls them. Chat bubbles render raw `textContent` — no markdown/code formatting.
- **Absent:** Slash commands; `@`-file mention autocomplete in the composer; message edit-and-resubmit;
  file attachment into the prompt; share-intent / URL prefill.

### Sessions & Persistence — 61/100
Each session is a self-contained folder that *is* its own git workspace, with its own repo,
discussion, settings, **and per-session lead/implementer models** — so you can run one session on
Claude and another on DeepSeek (a parity-plus). Multiple sessions, switch-active, resume-on-launch,
background survival all work.
- **Partial:** Sessions are isolated but **not simultaneously executable** (single global `activeRuns`,
  one bound `AGENT_WORKSPACE`). Checkpoint/rewind is single-step.
- **Bugs:** `SessionManager.delete()` is implemented but **completely unwired** (no bridge action, no
  UI) — sessions accumulate forever. A dead `transcript.jsonl` path shadows the real `discussion.jsonl`.
- **Absent:** Rename, archive, cross-device sync, multi-repo per session.

### Permissions — 60/100  *(re-framed after critic pass)*
Judged against the **web** target, not the CLI. claude.ai/code web has no allow/ask/deny model —
it has three modes (Accept-edits / Plan / Auto). The app maps closely: `AGENT_MODE` supports
`auto`/`plan`/`code` (`orchestrator.py`), plan mode is a genuine read-only propose→approve surface
(`agentloop.py` plan path), and the autocommit-off **diff gate** (`get_diff`/`discard_changes`/
`revert_last`) is a real human checkpoint at commit time. Path writes are sandboxed to the workspace
(`agent_tools.py` `_resolve` escape guard).
- **Absent (mostly CLI/enterprise, largely non-goal for web parity):** per-tool allowlist, `/permissions`
  UI, settings.json permission scopes, managed policy, `--add-dir`.

### Git & GitHub — 57/100
The on-device core is strong and fully wired: auto+manual commit with generated message, branch
create/switch, non-force push restricted to the current branch, pull, PR-create, PR/CI status,
CI-failure-log fetch, and a manual "Fix CI build" that loops the failing log back into the agent —
all pure urllib+dulwich.
- **Partial (structural):** git is entirely user-button-driven — the tool belt has **no git tools**,
  so the model can't branch/push/open-PR itself mid-run, only auto-commit at end (`orchestrator.py`).
  Auto-fix is manual + one-shot and targets the repo's *latest* run, not a specific PR. Iterating
  after a PR in the same session *does* work via the persistent discussion (paste CI/review output and
  continue); only the *automated* subscribe-and-fix loop is missing.
- **Absent:** Review-comment reply threads; built-in issue/PR tools ("fix issue #123"); multi-repo
  sessions; GitHub App (PAT only); GitHub Enterprise (hardcoded `api.github.com`).

### Execution — 35/100
A deliberate, coherent trade: **no Bash** — everything runs in the embedded Chaquopy Python
interpreter, so execution = `check_python` (compile-check), `run_tests` (in-process unittest,
pure-Python only), and a localrun WSGI/static preview. Real builds are delegated to GitHub Actions
with the CI-failure fix loop.
- **Partial:** The auto-verify gate runs **only** the Python syntax check — a failing `run_tests` or a
  broken JS/HTML app is not caught as `verify_failed` (`agentloop.py:258-268`); wiring `run_tests` in is
  a small, high-value change. `run_tests` has **no timeout** — an infinite loop hangs the interpreter.
- **Absent (mostly non-goal):** Bash / arbitrary shell, multi-language runtimes, Docker, databases,
  egress policy. Command timeout is a real robustness gap, though.

### Lifecycle — 33/100
Two halves. The **background-run survival** half is genuinely built: a dataSync foreground service +
partial wake lock carries the SSE stream through Doze (`AgentService.kt`), battery-exemption request,
completion notifications, and a durable JSONL event log lets a recreated WebView reattach and replay.
- **Partial:** A process kill is unrecoverable — the run executes in the Activity's `lifecycleScope`
  and `activeRuns` is a static reset on death; no resume of a partial loop.
- **Absent:** The **entire scheduled-routines subsystem** — recurring cron, one-off future runs,
  run-now/pause/resume, GitHub-event triggers (searched `schedul|cron|alarm|WorkManager`, not found).
  An on-device GitHub-event poller is feasible and high value.

### Tasks — 25/100
**TodoWrite is entirely absent** — no todo tool in the registry, no pending/in_progress/completed state
model anywhere. The proxy is a numeric `step` counter + tool events rendered as a scrolling activity feed
(`agentloop.py`, `app.js`) — a live log, not a checklist the user watches tick to done.
- **Partial:** Plan mode is present and provider-agnostic, but the plan is a static artifact —
  `execute_plan` flattens steps into one task string; no per-step progress. Sub-agents = the narrow
  single-file `delegate_edit` only.
- **Absent:** TodoWrite/live checklist; general Task tool; parallel/concurrent tool calls (serial loop).

### Web & Multimodal — 15/100
Almost entirely unbuilt; the agent is boxed into the local filesystem.
- **Present:** On-device web preview (`localrun.py` + `RunActivity.kt`) — Python/static only.
- **Absent:** **Web fetch** — can't retrieve a doc page or a pasted URL; provider-agnostic and cheap
  (urllib already used) — **the lowest-effort, highest-leverage gap in the whole audit.** **Web search** —
  Anthropic's server-side `web_search` is Claude-only; DeepSeek needs a 3rd-party search API. **Read
  images/PDFs** — text-only, no image content blocks; **Claude-only even if built** (DeepSeek is text-only).
  No camera permission / picker.

### Extensibility — 7/100
The weakest dimension. The entire claude.ai/code user-facing extension system — MCP, custom slash
commands, SKILL.md skills, hooks, subagent definitions, plugins, output styles — is absent; the tool list
is hard-closed (`agentloop.py:212-215`). What exists is a distinctive **developer-facing** substrate: OTA
hot-reload of the whole Python brain + web UI from GitHub raw (`agent_loader.py`), a generic `op()`
dispatcher, and a `py.call` escape hatch — powerful for shipping features without a native rebuild, but
not user-authorable extensions. Remote MCP-over-HTTP and HTTP hooks are both feasible on-device.

## 4. Prioritized roadmap (impact-per-effort, highest first)

Ordered to unblock real on-phone coding cheaply, favoring provider-agnostic wins that work under DeepSeek.

1. **WebFetch tool (URL → text/markdown).** The one high-impact / small-effort / fully provider-agnostic
   gap. On a phone you constantly want to paste a doc/RFC/error-page URL; nothing ingests it today. urllib
   is already proven; add a registry entry + an HTML→text pass. Identical for DeepSeek.
2. **Wire `run_tests` into the auto-verify gate.** Today the closed loop only runs a *syntax* check; a
   failing test or broken app isn't caught. Small change turns "does it parse" into "does it pass."
3. **Fallback model chain (Claude ↔ DeepSeek).** A single overloaded provider kills the run; both are
   already keyed and prefix-routed, so a `fallbackModel` env + a loop in `llm.chat` is near-free resilience
   on flaky mobile networks. The DeepSeek-first infra is the enabler.
4. **Speak agent replies (wire the existing TTS).** It's a *Voice Agent* that never talks — `speak()` +
   engine already exist, the UI just never calls them. One call + an auto-read toggle.
5. **Wire session delete (+ rename); remove dead `transcript.jsonl`.** `delete()` exists but is
   unreachable, so sessions pile up forever.
6. **Fix the Claude thinking-block drop bug.** Echo prior assistant thinking blocks (with signatures) back
   into the tool loop; today they're dropped (`llm.py:125-132`). Correctness fix, matters whenever thinking
   is on with Claude.
7. **Add a command timeout to `run_tests`.** An infinite loop currently hangs the interpreter thread with
   no recovery. Small robustness fix.
8. **Expose git as agent tools (branch/commit/push/open-PR).** Wrapping the existing pure-Python `git_ops`
   primitives as registry tools lets the agent branch-before-edit and open a PR itself mid-run. Provider-agnostic.
9. **TodoWrite / live task checklist.** The headline Tasks feature; on long multi-step phone runs you can't
   watch the plan tick to done. `todo_write` tool + `.agent/todos.json` + a checklist render. Neutral schema
   works for DeepSeek (test its reliability on a high-frequency bookkeeping tool).
10. **GitHub-event-triggered auto-fix (polling).** Poll the existing Actions/PR APIs with WorkManager and
    fire `fix_build` — turns the manual one-shot into the real "watch my PR and fix it" loop. No cloud webhook.
11. **Markdown/code rendering + streamed conversational replies + steer-mid-run.** Bubbles render raw text,
    Talk/Ask replies don't stream, and there's no way to inject guidance into a live loop. The interaction-polish
    items that most separate the feel from claude.ai/code.

*Ranked below the top 11 (large effort, high ceiling):* remote MCP-over-HTTP + custom slash commands +
SKILL.md skills (the Extensibility story), image input (Claude-only), and the scheduled-routines subsystem.

## 5. Intentional non-goals (parity here is not the target)

These assume a managed cloud VM or an org control plane an unrooted single-user Android app can't host.
Not shipping them is correct:

- **Bash / arbitrary shell + multi-language runtimes (Node/Ruby/Go/Rust) + Docker + databases + long-running
  services + setup scripts + filesystem snapshots.** No toolchains, container runtime, or process-spawning
  surface on-device. The app compensates by reimplementing grep/list/git in pure Python and delegating real
  builds to GitHub Actions.
- **Network egress policy / security proxy / vCPU-RAM-disk ceilings.** Properties of Anthropic's managed VM;
  on-device the app runs under Android's own sandbox.
- **Cloud-terminal features:** `--cloud`, teleport, session sharing, cross-device sync, a `/tasks`
  cross-session dashboard, `/web-setup`, and session-URL trailers presuppose a cloud session backend + a
  desktop/CLI counterpart. (A cheap *local* run-id provenance trailer is still worth adding.)
- **API-triggered `/fire` endpoint.** A phone behind carrier NAT can't host a stable public endpoint.
- **GitHub App + webhook auto-fix, GitHub Enterprise, org-managed memory/MDM, model-allowlist enforcement,
  Bedrock/Vertex backends, Agent SDK / CLI sideload, hosted Artifacts.** All assume an enterprise/gateway/
  hosting control plane. The local web preview (`localrun.py`) is the on-device analog of Artifacts.
- **Vision / image input while DeepSeek drives.** DeepSeek's models are text-only, so multimodal read is
  structurally Claude-only — an unavoidable asymmetry given the "DeepSeek as first-class model" goal. Handle
  by provider-gating the tool, not by treating it as achievable parity.
