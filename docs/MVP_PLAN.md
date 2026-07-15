# MVP Plan — Hierarchical Agent Runtime

Branch: `feat/hierarchical-agent-runtime`. No merge to `main` until the MVP runs end-to-end
(acceptance criteria below). Companion docs: `CURRENT_ARCHITECTURE.md`, `TARGET_ARCHITECTURE.md`.

## 1. MVP scope

In: 1 Executive (Claude session) · 1 Manager (Codex) · 1 cheap worker model (OpenAI-compatible,
DeepSeek preset) · repository analyzer · topology proposal · 1 persistent worker
(`test-and-verification-worker`) · 1 shared technical skill + 1 project skill · bounded review
loop · memory proposal flow · budget limits · audit logs · tests for every new module.

Out (explicitly deferred): vector DB, self-editing prompts/skills/memory, multi-manager,
worker parallelism, broker pools, auto-merge, auto agent creation, model-graded-only evals,
`agents.md`/`skills.md`/`memory.md`/`proposals.md` commands, DeepSeekRuntime class, agent
factory/loader modules.

## 2. Topology + first skill for this repo (proposal to validate in bootstrap)

Repo is small (~4.3k LOC of scripts) with high cohesion around the Codex runtime — creating the
spec §15 roster of five persistent agents would violate spec §5. Proposal:
**workflow-oriented**, one persistent agent now, the rest as temporary role templates:

- `test-and-verification-worker-01` (persistent) — primary `tests/**`, secondary read
  `plugins/codex/scripts/**`; write limited to `tests/**`. First real task class: extend test
  coverage for new orchestration modules — cheap to verify (`npm test`).
- Temporary role templates (created on demand, closed after task): `broker-concurrency
  -investigator`, `docs-worker`.
- First skills: `technical/node-test-authoring@1.0.0` (shared; grounded in `node --test`,
  no-deps rule, fixture pattern) and `project/codex-plugin-test-conventions@1.0.0` (grounded in
  `package.json#scripts.test`, `tests/helpers.mjs`, `tests/fake-codex-fixture.mjs` usage,
  naming `*.test.mjs`). Core skills (`task-execution`, `scope-control`, `structured-reporting`,
  `self-verification`, `escalation-protocol`) ship as static plugin content in
  `plugins/codex/skills-orchestration/core/` and are copied into `.ai-company/` at bootstrap.

## 3. Commit-by-commit plan

Phase 3 — bootstrap foundation
1. `feat: add orchestration schemas and project profile` — `schemas/orchestration/*.schema.json`
   (project-profile, agent, skill, task, task-result, review-decision, memory-proposal,
   campaign) + `lib`-level JSON-schema validator (small hand-rolled subset: type/required/enum) +
   tests.
2. `feat: add repository analyzer` — deterministic profile builder + tests (fixture repo dirs).
3. `feat: add agent and skill registries` — CRUD + lifecycle transitions + approval records +
   permission-guard (glob → path check, symlink-safe) + tests.
4. `feat: add topology planner and bootstrap command` — Codex-backed proposal (outputSchema),
   `/codex:bootstrap-agents` command md + `bootstrap` subcommand in a new
   `orchestration-cli.mjs` (keeps `codex-companion.mjs` untouched) + tests with fake-codex.

Phase 4 — worker runtime
5. `feat: add runtime base and codex manager runtime` — RuntimeResult contract, CodexRuntime
   wrapper + tests.
6. `feat: add openai-compatible worker runtime` — chat/completions tool loop, timeouts,
   cancellation, usage accounting, provider presets (`runtimes.json`), fake OpenAI-compatible
   HTTP fixture (node:http) + tests (incl. permission-guard denials, tool-call limits).

Phase 5 — review loop
7. `feat: add task router and managed review loop` — routing (skills → owner → eligible →
   selected), bounded attempts, structured manager review, escalation policy, result
   persistence, audit log + tests (worker faked, manager faked).

Phase 6 — memory governance
8. `feat: add memory proposal workflow` — proposal store, manager decisions, versioned memory
   store, namespace injection, audit for rejections + tests.

Phase 7 — campaign + validation
9. `feat: add campaign orchestrator and campaign command` — budget counters, campaign state
   machine, `/codex:campaign` (`run`, `status`, `approve-topology`, `accept`) + tests.
10. `docs: add agent/skill/memory/runtime/bootstrap docs` — AGENT_MODEL.md, SKILL_MODEL.md,
    MEMORY_GOVERNANCE.md, WORKER_RUNTIME.md, BOOTSTRAP_FLOW.md + `.ai-company/` example config.
11. `chore: run MVP campaign on this repo and record artifacts` — real end-to-end run
    (needs a real API key for the cheap model), recorded topology/skill/task/review/memory/budget
    artifacts under `docs/mvp-validation/` (secrets scrubbed).

Every commit: `npm test` green, no changes to existing plugin behavior without a test.

## 4. Test strategy

- Reuse the repo's pattern: pure `node --test`, fixtures over mocks.
- New `tests/fake-openai-fixture.mjs`: local `node:http` server speaking `chat/completions`
  with scripted tool-call sequences (mirrors `fake-codex-fixture.mjs` philosophy).
- Manager turns in tests run against the existing fake-codex fixture with `outputSchema`
  responses scripted.
- Review-loop tests use injected fake runtimes (no network, no processes) to exercise: happy
  path, rework → success, rework exhaustion → escalate, out-of-scope result rejection,
  permission denial, budget exhaustion mid-campaign.

## 5. Acceptance criteria mapping (spec §25)

| # | Criterion | Where satisfied |
|---|---|---|
| 1 | old Codex features intact | untouched `codex-companion.mjs` + existing tests stay green |
| 2 | repo analysis → project profile | commit 2 |
| 3 | topology from source, not defaults | commit 4 (+ §2 proposal) |
| 4 | shared skill across agents | skill registry `requires`/assignment, commits 3–4 |
| 5 | agent = ownership/responsibility/memory/permissions | agent schema + registry, commits 1, 3 |
| 6 | worker on cheap model | commit 6 |
| 7 | worker gets minimal context | context assembly in review loop, commit 7 |
| 8–9 | rework, bounded loop | commit 7 |
| 10–12 | memory proposals + manager decisions, no direct writes | commit 8 + permission-guard |
| 13 | audit logs | commits 7–9 |
| 14 | budget limits | commit 9 |
| 15 | one real campaign end-to-end | commit 11 |
| 16 | docs + tests for everything new | commits 1–10 |

## 6. Risks

1. **Cheap-model agentic weakness** — DeepSeek-chat may loop badly or emit invalid tool calls.
   Mitigation: strict output contracts, schema validation with one repair retry, low
   `maxToolCalls`, first worker restricted to test-writing tasks verified by `npm test`.
2. **Hidden complexity of the worker tool loop** — it is the real engine of the worker tier.
   Mitigation: minimal tool set, exhaustive fixture tests, hard caps.
3. **Broker contention** — manager turns share the single Codex slot with interactive
   `/codex:review` use. Mitigation: serialize campaign work, tolerate `-32001` direct-spawn
   fallback, document that a running campaign competes with interactive Codex use.
4. **Structured-output drift from Codex** — mitigation: `parseStructuredOutput` + one
   re-prompt, then escalate instead of guessing.
5. **Budget/cost runaway** — mitigation: counters checked before each call, campaign pause
   state, per-attempt caps; pricing table only *estimates* cost.
6. **Windows path/glob pitfalls** in permission-guard — mitigation: `path.resolve` +
   `realpath` + case-insensitive compare on win32, dedicated tests.
7. **Secrets leakage into artifacts** — mitigation: env-name indirection, scrub pass in
   commit 11, no request/response bodies with keys in audit logs.
8. **Scope creep vs. spec's large surface** — mitigation: deferred list (§1) is binding until
   MVP acceptance.

## 7. Assumptions

- Worker access = OpenAI-compatible `POST /chat/completions` with `tools`; `DEEPSEEK_API_KEY`
  (and optional `DEEPSEEK_BASE_URL`) provided by the user via env. No key ⇒ everything except
  commit 11 still works against fixtures.
- Codex CLI installed/authenticated as today; manager model/effort follow the user's Codex
  config defaults.
- Campaigns run in a git repo on one machine; `.ai-company/` committed or ignored per user.
- Executive decisions happen interactively in the Claude session (no unattended approvals).
- Node >= 18.18 provides global `fetch`/`AbortController` (already the plugin's floor).

## 8. Open item for the user

- Provide `DEEPSEEK_API_KEY` (or any OpenAI-compatible endpoint + key + model name) before the
  end-to-end validation run (commit 11). Everything earlier runs on local fixtures.
