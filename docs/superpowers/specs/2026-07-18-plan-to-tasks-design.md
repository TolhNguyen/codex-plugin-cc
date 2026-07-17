# Design: `campaign plan-to-tasks`

Date: 2026-07-18
Status: approved (brainstorming complete)

## Problem

The three-tier campaign runtime can route work to a cheap worker (DeepSeek), but
turning a written plan (`docs/superpowers/plans/*.md`) into worker-shaped task
files is fully manual: an operator must hand-author each `task.schema.json` JSON.
That is why "execute this plan on the cheap tier" never felt like a real execution
option — the decomposition + tier-classification step was missing. Doing it by
hand is also exactly where the observed **cost inversion** started (the TikTok
campaign): convention-heavy, multi-file tasks were handed to a worker that could
never finish them.

`campaign plan-to-tasks` closes that gap: one manager-tier call reads a plan and
emits **lint-passed, tier-classified** task drafts, so only genuinely
worker-shaped slices become run-ready.

## Command

```
campaign plan-to-tasks <campaignId> --plan-file <plan.md>
    [--run] [--manager-agent <id>] [--out <dir>] [--json]
```

- Requires an existing campaign (`requireCampaign`). `--run` additionally requires
  the campaign to be `running` (approved) and executes run-ready worker drafts
  through `runCampaignTask`, stopping on budget halt — identical guardrails to
  `run-task`.
- Default (no `--run`): decompose and write drafts only. Running stays the
  explicit, separate `run-task` step per draft. This honors the "never auto-spend"
  guardrail; the operator keeps the trigger.

## Approach (chosen: Codex-manager decomposition)

Reuse the `escalation-triage` pattern almost 1:1 — a single schema-validated Codex
manager turn with one repair retry. Tier classification and writing spec-complete
`goal`s require *semantic* understanding of the plan, which is the manager tier's
job (flat-rate, effectively free per call). Rejected alternatives: a deterministic
markdown parser (cannot classify tier or write spec-complete goals; brittle path
guessing — produces exactly the half-baked tasks the runbook warns against) and a
hybrid split-then-refine (more calls, negligible benefit over the single turn).

## Components

New files:

- `plugins/codex/scripts/orchestration/plan-decomposer.mjs` — mirrors
  `escalation-triage.mjs`:
  - `buildPlanDecompositionPrompt(pluginRoot, { planText, projectProfile, campaign, skillCatalog })`
  - `createCodexPlanDecomposer({ rootDir, runtime, managerAgent, pluginRoot })`
    → `decomposeFn(planText, ctx)` returning schema-validated `{ tasks }`, one
    repair retry (copy of `createCodexEscalationTriage`).
  - `runPlanDecomposition(cwd, { campaign, planText, projectProfile, skillCatalog, decomposeFn, guards, audit, now })`
    — orchestrates decompose → per task: assign `taskId`/`campaignId`/`status`/`maxAttempts`
    → `runTaskLint` → classify → write drafts + manifest → audit.
- `plugins/codex/prompts/orchestration/plan-decomposition.md` — prompt template
  (modeled on `escalation-triage.md`).
- `plugins/codex/schemas/orchestration/plan-decomposition.schema.json` — output schema.
- `tests/plan-decomposer.test.mjs` — `node:test` with a fake runtime fixture.

Touched files:

- `plugins/codex/scripts/orchestration-cli.mjs` — add `handleCampaignPlanToTasks`,
  wire into the `campaign` dispatch, add a usage line.
- `plugins/codex/commands/campaign.md` — document the subcommand + `--run` guardrail.
- `docs/CAMPAIGN_RUNBOOK.md` — insert the plan-to-tasks step into §5.

## Data flow

1. Load campaign (must exist). Read plan markdown. Load `project-profile.json` if
   present. Load the active-skill catalog via `listSkills({ status: "active" })`
   (id + purpose + which agents hold each), so the decomposer only assigns real,
   routable skills.
2. Build Codex runtime + manager agent (fallback `manager-codex`, as `run-task`).
3. One budget-guarded manager call (`beforeManagerCall`) → `{ tasks }`, each task
   carrying `tier` + `tierRationale` + decomposer-populated `requiredSkills`.
4. Per task: assign `taskId` (slug from title, numeric suffix to guarantee
   uniqueness), stamp `campaignId`/`status:"pending"`/`maxAttempts`
   (`campaign.budget.maxAttemptsPerTask`), run `runTaskLint`.
5. Classify into three buckets:
   - `tier=worker` AND lint passes AND every `requiredSkills` ref is routable
     → **run-ready** draft, written to `.ai-company/campaigns/<id>/drafts/<taskId>.json`
     (or `--out` dir).
   - `tier=worker` but lint fails OR a skill is not routable → **needs-attention**
     (written but flagged not run-ready, with the lint codes / skill gap).
   - `tier=manager|executive` → **keep-in-expensive-tier** (listed in the manifest
     only; no run-ready task file).
6. Write `drafts/manifest.json` summarizing every task: tier, lint result, path,
   rationale.
7. If `--run`: execute run-ready worker drafts in order via `runCampaignTask`,
   halting on budget exhaustion. Refuse `--run` if the campaign is not `running`.
8. Emit a human report (or `--json`): drafts written, tiers, and the suggested
   `run-task` command for each run-ready draft.

## Skill auto-assignment (answers "can the agent pick skills itself?")

Workers do **not** self-select skills at runtime — that is deliberate. Skills are
bound deterministically: `task.requiredSkills` → routing requires an agent holding
every ref → `buildWorkerContext` compiles only those `active` skills into the
prompt. A worker cannot reach for a skill mid-run (determinism is the cost-control
guarantee). The "state a requirement, let the AI pick the skill" behavior lives at
the **decompose step**: the Codex manager populates `requiredSkills` per task from
the active-skill catalog it is given. Hard constraint: it may only assign skills
that exist, are `active`, and are held by some agent — otherwise every such task
dies at routing (`No active agent has the required skills`). Tasks whose assigned
skills are not routable are demoted out of the run-ready bucket.

## Output schema (`plan-decomposition.schema.json`)

`{ tasks: [ { title, goal, affectedPaths, contextFiles, verificationCommands,
acceptanceCriteria, requiredSkills, tier, tierRationale } ] }` — `tier` is the enum
`worker | manager | executive`; all listed fields required (arrays may be empty
where noted, e.g. `requiredSkills`, `contextFiles`).

## Error handling / edge cases

- Missing campaign or plan file → clear error.
- Codex unavailable or decompose still invalid after one repair retry → **throw,
  write nothing** (no partial state to preserve, unlike escalation-triage). The
  single manager call is still budget-counted via `beforeManagerCall`.
- Zero worker-tier tasks → valid: write manifest, report "no worker-shaped slices;
  all kept in the expensive tier"; `--run` is a no-op.
- `taskId` collision → numeric suffix guarantees uniqueness.
- `--run` on a non-`running` campaign → refuse with a message. Budget exhaustion
  mid-`--run` → stop, report `halted` (campaign paused), as `run-task` does.

## Testing (`tests/plan-decomposer.test.mjs`)

`node:test` + fake runtime fixture:

1. Schema validation + the repair-retry path when the first output is invalid.
2. Tier routing: `worker`+lint-pass → run-ready at the right path; `worker` with 7
   paths → needs-attention (not run-ready); `manager` → manifest only.
3. Non-routable skill → task demoted out of run-ready even at `tier=worker`.
4. Duplicate title → unique `taskId`.
5. Zero worker-tasks → correct manifest, no drafts.
6. Manifest contains every task with tier + lint + path.
7. (CLI-level) `--run` on a non-running campaign is refused; smoke-test the
   `runCampaignTask` wiring.
