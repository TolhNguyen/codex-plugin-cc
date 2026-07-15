# Current Architecture — `codex-plugin-cc`

Status: Phase 1 survey for the hierarchical agent runtime effort (`feat/hierarchical-agent-runtime`).
Everything in this document describes the plugin as it exists today, before any orchestration work.

## 1. What the plugin is

A Claude Code plugin (marketplace root + one plugin at `plugins/codex/`) that lets Claude delegate
work to a locally installed Codex CLI. It has **zero runtime npm dependencies** — everything is
Node stdlib (`node:*`) ESM (`.mjs`), Node >= 18.18, and must work on Windows (named pipes,
`terminateProcessTree`) as well as POSIX.

```text
plugins/codex/
├── commands/        # Claude Code slash commands (markdown prompts)
├── agents/          # codex-rescue subagent (thin forwarder)
├── skills/          # 3 internal skills (runtime contract, result handling, prompting)
├── hooks/hooks.json # SessionStart / SessionEnd / Stop hooks
├── prompts/         # templates interpolated by prompts.mjs ({{VARS}})
├── schemas/         # review-output.schema.json (structured output contract)
└── scripts/
    ├── codex-companion.mjs      # CLI entry point (all subcommands)
    ├── app-server-broker.mjs    # shared Codex app-server broker process
    ├── session-lifecycle-hook.mjs
    ├── stop-review-gate-hook.mjs
    └── lib/                     # all reusable logic (see §4)
```

## 2. Entry points and control flow

Slash commands are markdown prompts that instruct Claude to run one Bash call:

```text
/codex:<cmd> → commands/<cmd>.md → node scripts/codex-companion.mjs <subcommand> "$ARGUMENTS"
```

`codex-companion.mjs` subcommands: `setup`, `review`, `adversarial-review`, `task`, `transfer`,
`task-worker` (internal), `status`, `result`, `task-resume-candidate` (internal), `cancel`.

`/codex:rescue` is special: it routes through the `codex:codex-rescue` **subagent** (Agent tool),
which is contractually a thin forwarder — exactly one Bash call to `task`, output returned verbatim.

## 3. Job flow (background execution model)

State lives per workspace under `$CLAUDE_PLUGIN_DATA/state/<basename>-<sha256[:16]>/`
(fallback `os.tmpdir()/codex-companion`), resolved by `state.mjs`:

- `state.json` — `{ version, config: { stopReviewGate }, jobs: [...] }`, pruned to **50 jobs**
  (older job `.json`/`.log` files are deleted on prune).
- `jobs/<job-id>.json` — full job record incl. `result` payload and `rendered` text.
- `jobs/<job-id>.log` — timestamped progress lines + log blocks (`Final output`, etc.).
- `broker.json` — active broker session (endpoint, pid, pidFile, logFile, sessionDir).

Job lifecycle (`tracked-jobs.mjs` / `job-control.mjs`):

```text
created → queued (background only) → running → completed | failed | cancelled
```

- Foreground: `runForegroundCommand` → `runTrackedJob(job, runner)` in-process.
- Background: `enqueueBackgroundTask` writes the full request into the job file, then spawns a
  **detached** `codex-companion.mjs task-worker --job-id <id>` process (`stdio: ignore`, `unref`).
  The worker re-reads the stored request and runs the same `runTrackedJob` path.
- Progress: `createProgressReporter` fans out each event to stderr, the log file, and
  `createJobProgressUpdater` (patches `phase`/`threadId`/`turnId` into state + job file).
- Session scoping: `CODEX_COMPANION_SESSION_ID` (set via SessionStart hook → `CLAUDE_ENV_FILE`)
  is stamped onto job records; `status`/`result`/`cancel` default-filter to the current session.
- Cancel: `turn/interrupt` RPC (best effort) + `terminateProcessTree(pid)` + state update.
- SessionEnd hook kills still-running session jobs and tears the broker down.

## 4. Codex runtime layer

`lib/codex.mjs` is the only module that talks Codex semantics; `lib/app-server.mjs` is transport.

- Protocol: JSON-RPC-ish JSONL. Requests (`thread/start`, `thread/resume`, `turn/start`,
  `review/start`, `turn/interrupt`, `account/read`, `config/read`, `thread/list`,
  `externalAgentConfig/import`) + server notifications (`thread/started`, `turn/started`,
  `item/started`, `item/completed`, `turn/completed`, `error`).
- `captureTurn` builds a `TurnCaptureState`: buffers notifications until the turn id is known,
  tracks subagent threads (`collabAgentToolCall`), captures agent messages, review text,
  reasoning summaries, `fileChanges`, `commandExecutions`, and infers completion when the main
  turn's final answer is seen and subagent work drains (250 ms timer).
- `runAppServerTurn(cwd, { prompt, model, effort, sandbox, outputSchema, resumeThreadId,
  persistThread, threadName, onProgress })` → `{ status, threadId, turnId, finalMessage,
  reasoningSummary, fileChanges, touchedFiles, commandExecutions, stderr, error }`.
  **`outputSchema` gives schema-constrained structured output** — already used by
  adversarial-review with `schemas/review-output.schema.json` + `parseStructuredOutput`.
- Sandboxing: `sandbox: "read-only" | "workspace-write"`, `approvalPolicy: "never"`. Tasks are
  read-only unless `--write`.
- Threads: task threads persist (`ephemeral: false`) and are named
  `"Codex Companion Task: <excerpt>"` so `--resume-last` can find them via job state or
  `thread/list` search.

## 5. Broker and concurrency constraints (critical)

`app-server-broker.mjs` is a detached per-workspace process that owns **one** spawned
`codex app-server` and listens on a Unix socket (POSIX) or named pipe (Windows), endpoint format
`unix:<path>` / `pipe:\\.\pipe\<name>` (`broker-endpoint.mjs`).

Semantics that any new orchestration layer must respect:

- **One active request at a time.** A second client gets JSON-RPC error `-32001`
  (`BROKER_BUSY_RPC_CODE`, "Shared Codex broker is busy.").
- **One active stream at a time.** Streaming methods (`turn/start`, `review/start`,
  `thread/compact/start`) hold the stream slot until `turn/completed` for a tracked thread id.
- Exception: `turn/interrupt` from another socket is allowed while a stream is active (this is
  how `cancel` works cross-process).
- Notifications route to the active request/stream socket only.
- Clients (`CodexAppServerClient.connect`) prefer the broker (env `
  CODEX_COMPANION_APP_SERVER_ENDPOINT` or `broker.json`), auto-start it if absent, and
  `withAppServer` **falls back to a direct spawned `codex app-server`** when the broker is busy
  (`-32001`) or unreachable (`ENOENT`/`ECONNREFUSED`).
- Lifecycle: `ensureBrokerSession` health-checks the recorded endpoint, respawns and rewrites
  `broker.json` if dead; SessionEnd sends `broker/shutdown` then hard-teardown.

Net effect: Codex calls are effectively serialized per workspace, with a safety valve that spawns
extra app-server processes under contention. Parallel Codex usage is possible but not free.

## 6. Hooks

- `SessionStart` (5 s budget): exports `CODEX_COMPANION_SESSION_ID`,
  `CODEX_COMPANION_TRANSCRIPT_PATH`, `CLAUDE_PLUGIN_DATA` into `CLAUDE_ENV_FILE`.
- `SessionEnd` (5 s): broker shutdown + kill session jobs + state cleanup.
- `Stop` (900 s): optional review gate (`config.stopReviewGate`). Runs a foreground
  `task` with the stop-review prompt; first line `ALLOW:`/`BLOCK:` decides whether to block the
  stop. Hook budgets mean **orchestration work must never run inside hooks** — long work belongs
  in tracked background jobs.

## 7. Tests and CI

- `node --test tests/*.test.mjs`; no test framework deps.
- `tests/fake-codex-fixture.mjs` (658 lines) fakes the entire `codex` binary + app-server JSONL
  protocol; `helpers.mjs` prepends it to `PATH`. `runtime.test.mjs` (2259 lines) covers turn
  capture, broker behavior, resume, cancel, transfer end-to-end against the fake.
- CI (`pull-request-ci.yml`): Node 22, `npm ci`, install real Codex CLI, `npm test`,
  `npm run build` (tsc type-check of JSDoc types against generated app-server TS types).
- Versioning: plugin version must be bumped with `scripts/bump-version.mjs` (checked in tests).

## 8. Reusable components for the orchestration layer

| Component | Reuse as |
|---|---|
| `state.mjs` dir-resolution pattern | template for `.ai-company/` per-project stores (but campaign data lives in-repo, not in plugin data, per spec) |
| `tracked-jobs.mjs` + `job-control.mjs` | execution records for worker runs; background campaign steps |
| detached `task-worker` pattern | background campaign orchestrator process |
| `runAppServerTurn` + `outputSchema` + `parseStructuredOutput` | **Manager (Codex) runtime**: structured plans, reviews, proposal decisions |
| `review-output.schema.json` pattern | all new output contracts (task result, review decision, proposals) |
| `args.mjs`, `prompts.mjs`, `fs.mjs`, `render.mjs` | new subcommands, prompt templates, rendering |
| fake-codex fixture + helpers | same approach: add a fake OpenAI-compatible HTTP fixture for worker runtime tests |
| commands/*.md + `${CLAUDE_PLUGIN_ROOT}` pattern | `/codex:bootstrap-agents`, `/codex:campaign`, etc. |
| session hooks env plumbing | campaign/session correlation |

## 9. Constraints the new layer must not break

1. Zero npm runtime dependencies; Node >= 18.18 (global `fetch` available for HTTP runtimes).
2. Windows + POSIX support for every new path/process feature.
3. Broker single-slot semantics (§5): Manager calls must be serialized or tolerate `-32001`
   fallback; never hold the stream slot across long non-Codex work.
4. Job state is pruned at 50 entries — campaign/agent/skill/memory artifacts must live in
   `.ai-company/`, not in plugin job state.
5. Hooks have hard time budgets (5 s / 900 s) — no orchestration inside hooks.
6. Existing behavior is locked by `runtime.test.mjs` + `commands.test.mjs`; changes to current
   flows require test updates, additions must not regress them.
7. Codex writes are gated by `sandbox: workspace-write`; the orchestration layer must impose its
   own path-level permissions for non-Codex workers (they run outside Codex's sandbox).
8. Secrets (API keys for cheap models) must come from env / user config, never be written into
   `.ai-company/` or job files.
