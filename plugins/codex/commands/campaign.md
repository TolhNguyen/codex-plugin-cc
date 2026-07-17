---
description: Manage a campaign end-to-end (create, run tasks, review memory proposals, accept) without auto-approving anything
argument-hint: '<create|list|show|run-task|approve|review-proposals|accept> [args...]'
allowed-tools: Bash(node:*), AskUserQuestion
---

Raw slash-command arguments:
`$ARGUMENTS`

Core constraint:
- This command is a thin forwarder to `orchestration-cli.mjs campaign <subcommand>`. It never
  edits `.ai-company/**` by hand and never invents data that subcommand did not return.
- Subcommands map 1:1 to the CLI. Always return the CLI's stdout verbatim to the user first,
  then add your own summary/questions afterward — never paraphrase or summarize instead of
  showing the real output.

Subcommand -> CLI mapping (forward `$ARGUMENTS` after the leading verb):
- `create --brief <text> --criteria <text> [...]` ->
  `node "${CLAUDE_PLUGIN_ROOT}/scripts/orchestration-cli.mjs" campaign create ...`
- `list` -> `... campaign list ...`
- `show <campaignId>` -> `... campaign show ...`
- `run-task <campaignId> --task-file <path.json>` -> `... campaign run-task ...`
- `approve <campaignId> --approved-by <role>` -> `... campaign approve ...`
- `review-proposals <campaignId> --decided-by <role>` -> `... campaign review-proposals ...`
- `accept <campaignId> --accepted-by <role>` -> `... campaign accept ...`

Nothing auto-approves. Never run any of the following on the user's behalf without the user
explicitly asking for it in this turn — always confirm first with `AskUserQuestion` when it
hasn't been asked explicitly:
- `campaign approve` (campaign approval / activation of budgeted execution),
- `campaign accept` (Executive sign-off that closes the campaign),
- `campaign review-proposals` (memory governance decisions).
Do not infer approval/acceptance from tone or from the user seeming satisfied with a report.
Only proceed when the user's literal words request that specific action (e.g. "approve it",
"accept the campaign", "review the proposals"). If a role/name (`--approved-by`,
`--decided-by`, `--accepted-by`) is missing, ask for it with `AskUserQuestion` — never guess,
default, or fabricate one.

Running a task (`run-task`) does not itself require approval to invoke, but only run it when
the user has asked to execute a task against an already-approved (`running`) campaign; if
`campaign show` reports the campaign is not `running` yet, tell the user and ask whether they
want to approve it first rather than running the task anyway.

Budget pauses: if `campaign run-task` reports outcome `halted` (or `campaign show` reports
status `paused`), that means a budget cap was hit. Report this to the user plainly (which cap,
current usage vs. the cap) and ask whether they want to raise limits. Raising limits is not
something this command can do to an existing campaign — it requires either a new
`campaign create` with higher `--max-*` flags, or an explicit, user-directed edit of the
budget fields in `.ai-company/campaigns/<id>/campaign.json` that the user asks for by name.
Never silently continue running a paused campaign, and never edit that file yourself.

Troubleshooting:
- If a `node` command above fails with `MODULE_NOT_FOUND` on a path containing an old plugin
  version (e.g. `...\codex\1.0.6\...`), the plugin was updated while this Claude Code session was
  running. Do not retry with a guessed or corrected path — tell the user to restart the session so
  commands resolve to the new version.
- For any other unexpected failure, run
  `node "${CLAUDE_PLUGIN_ROOT}/scripts/orchestration-cli.mjs" doctor` and follow its `Next step:`
  line before retrying anything.

Rules:
- Never edit files yourself; only the `node ... orchestration-cli.mjs campaign ...` command
  above may act on the repository.
- Never call `approve`, `accept`, or `review-proposals` unless the user's request explicitly
  asks for that action in this turn.
- Never fabricate or default a role/name value for `--approved-by`, `--decided-by`, or
  `--accepted-by`; always ask the user for it if missing.
- Do not paraphrase or summarize the raw command stdout — return it verbatim, then add your own
  summary and questions afterward.
- Do not edit `.ai-company/**` by hand under any circumstance, including to "fix" a paused
  campaign or a rejected proposal.
