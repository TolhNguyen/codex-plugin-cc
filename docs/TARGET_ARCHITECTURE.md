# Target Architecture — Hierarchical Agent Runtime

Status: Phase 2 design. Extends the existing plugin (see `CURRENT_ARCHITECTURE.md`); nothing here
replaces current Codex behavior.

## 1. Three tiers mapped onto what already exists

| Tier | Runs as | Runtime mechanism |
|---|---|---|
| **Executive** (Claude) | the current Claude Code session itself | slash commands + rendered reports; approves via command flags / AskUserQuestion. No Anthropic API calls. |
| **Manager** (Codex) | Codex turns via existing `runAppServerTurn` | `outputSchema`-constrained structured output for plans, task specs, reviews, proposal decisions |
| **Worker** (cheap model) | new `OpenAICompatibleRuntime` (HTTP `fetch`, zero deps) | bounded tool loop with path-guarded file tools |

A **campaign** is the unit of work: brief → analysis → topology → skills → tasks → review loop →
memory governance → acceptance. All campaign state is file-based JSON under `.ai-company/`.

Key consequence of the existing broker (single active Codex request): **Manager calls are
serialized** by design. The orchestrator never runs two Codex turns concurrently, and never holds
a Codex stream while doing non-Codex work. Worker calls are plain HTTPS and independent of the
broker; MVP still runs one worker at a time for simplicity and budget accounting.

## 2. New source layout (plugin side)

```text
plugins/codex/
├── scripts/
│   ├── orchestration/
│   │   ├── campaign-orchestrator.mjs   # state machine: brief → … → acceptance
│   │   ├── repository-analyzer.mjs     # project profile + capability map
│   │   ├── topology-planner.mjs        # Codex-backed topology proposal
│   │   ├── task-router.mjs             # skills → owner → eligible agents → selection
│   │   ├── review-loop.mjs             # assign → execute → review → rework (bounded)
│   │   └── escalation-policy.mjs       # retry exhaustion / out-of-scope / budget hit
│   ├── agents/
│   │   ├── agent-registry.mjs          # CRUD over .ai-company/agents/*.json
│   │   └── permission-guard.mjs        # path allowlist checks for worker tools
│   ├── skills/
│   │   └── skill-registry.mjs          # CRUD + lifecycle over .ai-company/skills/**
│   ├── memory/
│   │   ├── memory-store.mjs            # versioned approved memory, namespaced
│   │   └── proposal-store.mjs          # proposals + audit log + manager decisions
│   └── runtimes/
│       ├── runtime-base.mjs            # AgentRuntime contract + shared result schema
│       ├── codex-runtime.mjs           # thin wrapper over runAppServerTurn (manager)
│       └── openai-compatible-runtime.mjs  # chat/completions + tool loop (workers)
├── commands/
│   ├── bootstrap-agents.md             # /codex:bootstrap-agents
│   └── campaign.md                     # /codex:campaign (MVP: run + status + approve)
├── prompts/orchestration/              # manager/worker prompt templates ({{VARS}})
└── schemas/orchestration/              # JSON Schemas (§5)
```

Deferred from the spec's proposed tree until a real use case exists (rule: no abstraction without
a use case): `agent-loader/agent-factory` (registry suffices), `skill-loader/compiler/evaluator`
as separate modules (folded into skill-registry + review-loop for MVP), `memory-review.mjs`
(folded into proposal-store), `deepseek-runtime.mjs` (DeepSeek **is** OpenAI-compatible; a named
provider preset is enough), extra commands (`agents.md`, `skills.md`, `memory.md`,
`proposals.md` — subcommands of `/codex:campaign` and the companion CLI first).

## 3. Per-project data layout (`.ai-company/`, committed or gitignored per user choice)

```text
.ai-company/
├── project-profile.json         # analyzer output
├── topology-proposal.json       # planner output + approval record
├── runtimes.json                # provider presets: { id, baseUrlEnv, apiKeyEnv, model, pricing }
├── agents/<agent-id>.json
├── skills/<tier>/<skill-id>.json      # tier ∈ core|technical|project|domain
├── memory/
│   ├── agents/<agent-id>/memory.json  # versioned entries
│   ├── shared/memory.json
│   ├── domains/<domain>/memory.json
│   └── proposals/<proposal-id>.json   # incl. rejected (audit)
├── campaigns/<campaign-id>/
│   ├── campaign.json            # brief, budget, status, approvals
│   ├── tasks/<task-id>.json     # spec + routing + attempts[] (result + review per attempt)
│   └── audit.log                # append-only event log (one JSON per line)
└── executions/<execution-id>.json     # raw runtime transcripts (worker tool loop)
```

Secrets never land in `.ai-company/` — `runtimes.json` stores **env var names**, not values.

## 4. Runtime abstraction

```js
// runtime-base.mjs (JSDoc-typed, no classes required by callers)
/**
 * @typedef {{
 *   executionId: string,
 *   status: "completed" | "failed" | "cancelled" | "timeout",
 *   output: string,                    // final structured JSON string (validated by caller)
 *   toolCalls: Array<{ tool: string, args: object, result: string, ok: boolean }>,
 *   usage: { inputTokens: number|null, outputTokens: number|null, calls: number },
 *   error: string | null
 * }} RuntimeResult
 */
class AgentRuntime {
  /** @returns {Promise<RuntimeResult>} */
  async execute(agent, task, context) {}
  async cancel(executionId) {}
  async getStatus(executionId) {}
}
```

- **CodexRuntime** (manager): wraps `runAppServerTurn` with `outputSchema`; maps
  `TurnCaptureState` → `RuntimeResult`. Read-only sandbox; the manager never edits files.
- **OpenAICompatibleRuntime** (worker): `POST {baseUrl}/chat/completions` with `tools`, loops on
  `tool_calls` up to `limits.maxToolCalls`, wall-clock timeout via `AbortController`
  (`limits.maxExecutionMinutes`). DeepSeek is provider preset
  `{ baseUrlEnv: "DEEPSEEK_BASE_URL" (default https://api.deepseek.com), apiKeyEnv:
  "DEEPSEEK_API_KEY", model: "deepseek-chat" }`.

Worker tool surface (the minimum that makes a chat model able to do repo work, all guarded by
`permission-guard.mjs` against the agent's `permissions.read/write` globs, repo-root confined,
symlink-resolved):

| Tool | Guard |
|---|---|
| `read_file`, `list_dir`, `search` | `permissions.read` |
| `write_file` (full content) | `permissions.write` |
| `run_command` | allowlist from task spec (`verificationCommands`) only |
| `submit_result` | terminates loop; payload must match task-result schema |

Workers get **assembled context, not the repo**: task spec + compiled ACTIVE skills + memory
entries for granted namespaces + the specific file contents the manager listed. No repo-wide dumps.

## 5. Data schemas (JSON Schema files in `schemas/orchestration/`)

Abbreviated shapes; the schema files are the source of truth.

- **project-profile**: `{ languages[], frameworks[], commands: { test, build, lint }, structure:
  { dirs[], entryPoints[] }, testLayout, ci, docs[], capabilities: { technical[], domains[],
  crossCutting[] }, generatedAt }`
- **agent**: as spec §18 — `{ id, name, type: persistent|temporary, status, ownership
  { primary[], secondary[], excluded[] }, responsibilities[], skills[ "tier/id@semver" ],
  memory.namespaces[], permissions { read[], write[] }, runtime { provider, model },
  limits { maxAttemptsPerTask, maxExecutionMinutes, maxToolCalls } }`. Identity ≠ model:
  `runtime` is swappable without touching anything else.
- **skill**: `{ id: "tier/name", version, status: draft|evaluating|approved|active|deprecated,
  purpose, useWhen[], dontUseWhen[], requiredInputs[], procedure[], permissionsNeeded,
  verificationSteps[], doneWhen[], escalateWhen[], outputContract, requires[], sources[],
  owner, approvedBy, evaluations[] }`. Workers may only be handed `status: active` skills.
- **task**: `{ taskId, campaignId, title, goal, affectedPaths[], requiredSkills[], owner,
  support[], contextFiles[], verificationCommands[], acceptanceCriteria[], maxAttempts,
  status, attempts[] }`
- **task-result** (worker output contract): `{ taskId, agentId, status:
  completed|needs_review|failed|escalate, summary, changedFiles[], commandsExecuted[],
  verification { passed, details }, risks[], memoryProposals[], skillProposals[] }`
- **review-decision** (manager output contract): `{ taskId, decision:
  approve|rework|split|reassign|escalate, feedback[{ code, description }], nextAttempt,
  maxAttempts }`
- **memory-proposal**: `{ proposalId, agentId, scope, type, content, evidence[], confidence,
  status: pending|approved|edited|rejected|escalated, decidedBy, decidedAt, finalContent }`
- **campaign**: `{ campaignId, brief, acceptanceCriteria[], status, approvals[], budget
  { maxExecutiveCalls, maxManagerCalls, maxWorkerCalls, maxAttemptsPerTask,
  maxCampaignDurationMinutes }, usage { executiveCalls, managerCalls, workerCalls, reworks,
  estimatedCostByProvider{} }, startedAt, endedAt }`

## 6. Control flows

### Bootstrap (`/codex:bootstrap-agents`)

1. `repository-analyzer` (deterministic Node code, no LLM): languages, commands, dir structure,
   test layout, docs, CI → `project-profile.json`.
2. `topology-planner`: one Codex (manager) turn with the profile + topology rules from the spec
   (workflow/domain/layer/hybrid, anti-patterns like utils-agent) → `topology-proposal.json`
   with proposed agents (DRAFT), shared/project skills (DRAFT), overlaps, risks.
3. Report rendered for the Executive. **Nothing is activated automatically.**
4. On approval (`/codex:campaign approve-topology` or bootstrap `--approve`): agents registered,
   skills stay DRAFT until evaluated.

### Skill lifecycle

`DRAFT → EVALUATING → APPROVED → ACTIVE → DEPRECATED`, enforced by skill-registry (illegal
transitions rejected). Evaluation = the review loop run on eval tasks (normal / edge-case /
out-of-scope / escalation-required / failing-verification); manager reviews evidence; Executive
approves activation for the MVP's first skills.

### Review loop (`review-loop.mjs`)

```text
route(task) → worker.execute (attempt N) → validate result schema
  → manager review turn (structured decision)
    approve   → task done, results persisted
    rework    → attempt N+1 with feedback injected (N < maxAttempts)
    split/reassign/escalate → orchestrator handles; escalate surfaces to Executive report
  budget checked before every manager/worker call; exhaustion ⇒ campaign paused with report
```

Hard stops: `maxAttemptsPerTask` (default 3), campaign budget counters, wall-clock campaign
duration. There is no unbounded loop anywhere.

### Memory governance

Workers only ever emit proposals inside `task-result`. `proposal-store` records them
(`pending`). Manager decisions (`APPROVE | EDIT_AND_APPROVE | REJECT | ESCALATE`) are separate
structured Codex turns; only approval writes a new **version** into `memory-store` under the
proposal's namespace. Rejected proposals are kept for audit. Memory is injected into worker
context strictly by the agent's granted namespaces.

## 7. Permissions enforcement points

| Rule | Enforced by |
|---|---|
| worker file access | `permission-guard` inside runtime tool dispatch (only file API workers have) |
| worker commands | task-spec allowlist, exact-match |
| worker cannot edit skills/memory/agents | `.ai-company/**` is always in `permissions.excluded`; guard denies writes |
| worker scope | task `affectedPaths` narrows `permissions.write` for that execution |
| manager cannot change business rules / scope | orchestrator only accepts manager decisions within the review-decision schema; scope changes route to Executive report |
| activation approvals | registry state transitions require an approval record (who/when) |

Enforcement is code (path checks, schema validation, counters) — never prompt-only.

## 8. Decisions (ADR-style, short)

1. **Executive = the Claude session, not an API integration.** Zero new auth, uses the plugin's
   natural surface (commands/reports). Revisit only if unattended campaigns are needed.
2. **Manager = Codex through the existing app-server path with `outputSchema`.** Reuses broker,
   jobs, progress, cancel, tests. No new Codex transport.
3. **One OpenAI-compatible runtime; DeepSeek is a provider preset, not a class.** Adding a
   provider = adding a preset entry (id, env names, model, pricing).
4. **File-based JSON under `.ai-company/` with append-only audit logs.** Matches plugin's
   existing storage style; no databases, no vector stores in MVP.
5. **Worker tool loop is part of the runtime, not the agent.** Agents/skills stay declarative;
   the runtime owns execution mechanics and guards.
6. **Campaign state lives in the repo, not in `$CLAUDE_PLUGIN_DATA`** (which prunes at 50 jobs
   and is machine-local). Long-running executions still get tracked-job entries for
   `/codex:status` visibility.
7. **MVP serializes everything** (one manager turn or one worker execution at a time): budget
   accounting stays trivial and broker contention is avoided by construction.
