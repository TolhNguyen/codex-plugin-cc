# Campaign Runbook — running the full flow without inverting the economics

This runbook exists because of one observed failure mode, seen in a real campaign: the
hierarchical runtime was built so a cheap worker model (DeepSeek) absorbs the bulk of the work,
yet the run ended up costing MORE than doing everything in the expensive tier. This document is
the recipe for running campaigns so that does not happen, for both the human operator and the
Executive agent driving the CLI.

## 1. Why cost inversion happens

Delegation only saves money when:

```
value of work moved to the cheap tier  >  supervision cost + retry cost + redo cost
```

The observed anti-pattern (the "TikTok campaign" case):

1. A convention-heavy, 6-file task was handed to a worker whose envelope is mechanical,
   spec-complete tasks — it failed every attempt (tool-call limit, result-schema guessing).
2. Every failure escalated PAST the manager to the Executive (the most expensive tier), which
   then read raw logs, re-diagnosed, re-authored the task, and finally re-implemented the work
   itself. The campaign paid for the worker's failures AND the Executive's redo.
3. Nobody could see the bleed, because cost was tracked per campaign, not per task.

Every guardrail below maps to one of those three causes.

## 2. Tier responsibilities (who is allowed to spend what)

| Tier | Runtime | Cost profile | Does | Must NOT do |
|---|---|---|---|---|
| Executive | Claude session | most expensive, long-lived context | approve campaigns, approve topology, decide on triaged escalations, accept results | read raw execution logs, author tasks by hand, re-implement failed worker tasks by default |
| Manager | Codex (subscription) | flat-rate — effectively free per call | review worker results, triage escalations, decide memory proposals | write code directly |
| Worker | DeepSeek / OpenAI-compatible | cheap per-token | execute small, spec-complete tasks inside its sandbox | explore the repo at large, design, run infra-heavy verification |

The single most important rule: **friction is absorbed at the manager tier.** If the Executive
finds itself reading a worker transcript, the flow is being used wrong — the compact escalation
report plus the manager's triage decision (`.ai-company/campaigns/<id>/escalations/<taskId>.json`)
is what the Executive is supposed to read.

## 3. Preflight (user checklist)

1. `node plugins/codex/scripts/orchestration-cli.mjs doctor` — checks registries, schemas, Codex.
2. Worker API key must be visible to THIS process tree: set `DEEPSEEK_API_KEY` before launching
   the Claude session, or pass it inline per run. Setting it in a different PowerShell window
   does nothing for an already-running session.
3. Codex CLI authenticated (the manager tier is not optional — without it every failure lands
   on the Executive again).
4. Know your budget: campaign defaults are `maxManagerCalls: 60`, `maxWorkerCalls: 150`,
   `maxAttemptsPerTask: 3`, `maxCampaignDurationMinutes: 360`. Override at `campaign create` if
   the run should be tighter.

## 4. Task authoring rules (the part that decides the economics)

A task is worker-shaped when ALL of these hold:

1. **Small blast radius** — 1–3 `affectedPaths` (the lint hard-rejects above 6).
2. **Spec-complete** — the `goal` names exact files, exact exports, exact conventions. If the
   worker must infer a codebase convention, the task is not worker-shaped yet.
3. **Context pre-stuffed** — every reference file the worker needs is listed in `contextFiles`
   (injected into the prompt for free; exploration burns tool calls).
4. **Cheap verification** — `verificationCommands` is a scoped test/build command that runs in
   seconds. Never docker/testcontainers/full-solution builds; the lint flags these.
5. **Mechanical** — tests, boilerplate, fixtures, doc stubs, repetitive migrations. Design work,
   cross-cutting refactors, and OAuth-flow-shaped features belong to the manager/Executive.

The task-size lint (`task-lint.mjs`) enforces the mechanical half of this automatically at
`campaign run-task` time, BEFORE any budget is spent:

| Code | Severity | Meaning |
|---|---|---|
| `TOO_MANY_PATHS` | error | more writable paths than one worker slice should have |
| `NO_VERIFICATION` | error | worker cannot self-verify; review would be blind |
| `TOOL_BUDGET_TOO_LOW` | error | estimated minimum tool calls exceeds the agent's `maxToolCalls` |
| `HEAVY_VERIFICATION` | warning | docker/testcontainers/kubectl in verification |
| `NO_CONTEXT_FILES` | warning | worker will burn tool calls exploring |

`--no-lint` bypasses enforcement for deliberate experiments; warnings are audited either way.

## 5. The full flow

```
create -> approve -> (per task) run-task -> [approved]            -> next task
                                        -> [rejected_by_lint]     -> fix the task doc, re-run
                                        -> [escalated + triage]   -> Executive picks: retry_with_fixes / shrink / split / reassign / handle_directly
                                        -> [halted]               -> campaign paused on budget; decide to resume or stop
review-proposals -> accept
```

Commands (all under `node plugins/codex/scripts/orchestration-cli.mjs`):

1. `bootstrap` — analyze repo, propose topology (first time only).
2. `campaign create --brief "..." --criteria "..." [--json]`
3. `campaign approve <campaignId> --approved-by <role>`
4. `campaign plan-to-tasks <campaignId> --plan-file <plan.md> [--run] [--out <dir>]` — decompose a
   written plan into tier-classified task drafts (§4 authoring done for you by the manager tier).
5. `campaign run-task <campaignId> --task-file <task.json> [--no-lint] [--json]`
6. `campaign show <campaignId>` — status, tasks, pending proposals.
7. `campaign review-proposals <campaignId> --decided-by <role>` — manager decides memory writes.

### 5a. Turning a plan into tasks (`plan-to-tasks`)

Instead of hand-authoring every task JSON to §4, point `plan-to-tasks` at a plan document. One
budget-guarded Codex manager call reads the plan and classifies each unit of work into a tier:

- `worker` + lint-pass + routable skills → a **run-ready** draft written to
  `.ai-company/campaigns/<id>/drafts/<taskId>.json`.
- `worker` but lint-failing or naming an unroutable skill → **needs-attention** (written, flagged).
- `manager` / `executive` → **kept in the expensive tier** (manifest only, never handed to a worker).

Every run is summarized in `drafts/manifest.json`. Default (no `--run`) writes drafts only, so you
review before spending; `--run` then executes the run-ready drafts through the campaign, halting on
budget exhaustion exactly like `run-task`. This is the mechanical embodiment of §4: the manager tier
absorbs the classification so a convention-heavy slice never reaches a cheap worker by accident.

## 6. When a task escalates

The review loop no longer dumps escalations on the Executive. On outcome `escalated`:

1. A compact **escalation report** is built in code (attempts, last error, reviewer feedback,
   tool-call stats — no raw transcripts).
2. The **manager triages it** (one budget-guarded Codex call, schema-validated with one repair
   retry) into an action: `retry_with_fixes`, `shrink`, `split`, `reassign`, `handle_directly` —
   with concrete fixes or replacement task drafts where applicable.
3. Both are persisted at `.ai-company/campaigns/<id>/escalations/<taskId>.json` and the CLI
   prints the action + rationale.

The Executive's job is to approve or override the recommended action — not to re-diagnose.
`handle_directly` is the ONLY path where the expensive tier implements something itself, and the
manager must have said so first.

## 7. Reading the money (per-task spend attribution)

Every `run-task` writes `campaign.usage.taskStats[taskId]`:

```json
{ "outcome": "approved", "attempts": 2, "workerCalls": 9, "managerCalls": 3,
  "reworks": 1, "estimatedCostByProvider": { "deepseek": 0.0041 } }
```

How to read it:

- **cost per APPROVED task** is the number that matters — an escalated task's spend bought
  nothing but information.
- Many attempts + escalation on a task class ⇒ that class is not worker-shaped; stop routing it
  to workers (shrink harder, or keep it at manager/Executive tier).
- Token-count comparisons between tiers are misleading (the Executive's tokens are mostly cached
  input, ~10x cheaper; Codex is flat-rate). Compare `estimatedCostByProvider` deltas and
  attempts, not raw token counts.

## 8. Worker success levers (ranked by observed impact)

1. **Pre-stuffed `contextFiles`** — biggest single lever; discovery is where cheap models drown.
2. **Explicit result contract** — the worker's system prompt now embeds the full
   `submit_result` shape generated from the schema, eliminating the "guessed the shape wrong
   twice" death.
3. **Scoped verification** — a seconds-fast command lets the worker iterate inside one attempt.
4. **Generous-but-bounded limits** — defaults are now `maxToolCalls: 150`,
   `maxExecutionMinutes: 45`; the lint checks the estimate against the agent's limit up front.
5. **Small tasks** — everything above amplifies it; nothing rescues a task that is too big.

## 9. Validation run (2026-07-17, this repo)

Unleashed experiment: `deepseek-chat` worker, `maxToolCalls: 300`, `maxExecutionMinutes: 45`,
NO pre-stuffed context (deliberately), task = "write node:test unit tests for
`plugins/codex/scripts/lib/args.mjs`" (1 affected path, verification
`node --test tests/args.test.mjs`). Campaign `camp-mrorxu1n-p6et`, task `task-unleashed-01`.

Result: **approved on attempt 1**. The worker used **8 of 300 tool calls** (7 HTTP rounds,
63,369 input + 6,416 output tokens ≈ **$0.024**), wrote 45 passing tests, self-verified, and the
Codex manager approved on first review.

What it proves: the binding constraint was never the limits — it is **task shape**. A
spec-complete, single-path, cheaply-verified task succeeds immediately even with zero context
stuffing; the same worker died repeatedly on a 6-file convention-heavy feature task. Raise
limits for headroom, but spend your effort on §4.

## 10. Executive agent checklist (per campaign)

- [ ] Preflight passed (doctor, worker key visible, Codex authenticated).
- [ ] Tasks authored to §4 (or split until they pass lint without `--no-lint`).
- [ ] Escalations handled from the triage file, not from execution records.
- [ ] After each task: check `taskStats` — if a task class keeps escalating, re-route it instead
      of feeding it more attempts.
- [ ] Memory proposals reviewed at campaign end (`review-proposals`), campaign closed
      (`completed`/`failed`), artifacts kept under `.ai-company/campaigns/<id>/`.
