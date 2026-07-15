---
description: Analyze this repository and propose an agent topology, then (only with explicit approval) register it
argument-hint: '[--approve --approved-by <role>] [--profile-only] [--json]'
allowed-tools: Bash(node:*), AskUserQuestion
---

Raw slash-command arguments:
`$ARGUMENTS`

Core constraint:
- This command never edits files itself and never activates anything on its own.
- Activation (registering agents/skills) only ever happens through the explicit approve flow
  below, and only when the user's arguments literally contain `--approve`.
- Do not infer approval from tone, from a previous message, or from the user seeming satisfied
  with the proposal. Only the literal `--approve` flag counts.

If the raw arguments do NOT include `--approve`:
- Run:
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/orchestration-cli.mjs" bootstrap "$ARGUMENTS"
```
- Return the command stdout verbatim to the user first.
- Then, in your own words, summarize the proposal: topology type, each proposed agent (id, type,
  primary ownership, write permissions, skills), the proposed skill drafts, overlaps, and risks.
- Explicitly ask the user whether to approve this topology. Do not approve automatically and do
  not assume approval just because the proposal looks reasonable.
- If the user wants to approve, ask for the role/name to record as the approver (`--approved-by`)
  if they have not already given one, then rerun this command with
  `--approve --approved-by <role>` (or offer to run it yourself once they confirm the role).

If the raw arguments DO include `--approve`:
- Require `--approved-by <role>` to also be present in the arguments.
- If `--approved-by` is missing, use `AskUserQuestion` to ask the user for their role or name
  before doing anything else. Do not guess, default, or fabricate a value for `--approved-by`.
- Once `--approved-by` is present, run:
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/orchestration-cli.mjs" approve-topology "$ARGUMENTS"
```
- Return the command stdout verbatim to the user.

Rules:
- Never edit files yourself; only the two `node` commands above may act on the repository.
- Never call `approve-topology` unless the user's raw arguments literally include `--approve`.
- Never fabricate or default an `--approved-by` value; always ask the user for it if missing.
- Do not paraphrase or summarize the raw command stdout — return it verbatim, then add your own
  summary and questions afterward.
