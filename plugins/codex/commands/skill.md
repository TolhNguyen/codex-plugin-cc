---
description: List skills and, only when explicitly asked, activate a skill so routing and worker context can use it
argument-hint: '<list|activate> [args...]'
allowed-tools: Bash(node:*), AskUserQuestion
---

Raw slash-command arguments:
`$ARGUMENTS`

Core constraint:
- This command is a thin forwarder to `orchestration-cli.mjs skill <subcommand>`. It never edits
  `.ai-company/**` by hand.
- `skill activate` changes real, governed state — it walks a skill from `draft` forward through
  `evaluating`/`approved` to `active` (the status `assertSkillsActive` requires before routing or
  a worker can use it). It must never run without the user explicitly asking for it in this turn.
- Do not infer approval from tone, from a previous message, or from the user seeming satisfied
  with a skill list or report. Only an explicit request to activate a named skill counts.

Subcommand -> CLI mapping (forward `$ARGUMENTS` after the leading verb):
- `list [--status <s>] [--json]` ->
  `node "${CLAUDE_PLUGIN_ROOT}/scripts/orchestration-cli.mjs" skill list ...`
- `activate <skillId> --approved-by <role> [--json]` ->
  `node "${CLAUDE_PLUGIN_ROOT}/scripts/orchestration-cli.mjs" skill activate ...`

Always return the CLI's stdout verbatim to the user first, then add your own summary/questions
afterward — never paraphrase or summarize instead of showing the real output.

If the user asks to activate a skill:
- Require `--approved-by <role>` to also be present in the arguments.
- If `--approved-by` is missing, use `AskUserQuestion` to ask the user for their role or name
  before doing anything else. Do not guess, default, or fabricate a value for `--approved-by`.
- Once `--approved-by` is present, run the `skill activate` command above.

Troubleshooting:
- If a `node` command above fails with `MODULE_NOT_FOUND` on a path containing an old plugin
  version (e.g. `...\codex\1.0.6\...`), the plugin was updated while this Claude Code session was
  running. Do not retry with a guessed or corrected path — tell the user to restart the session so
  commands resolve to the new version.
- For any other unexpected failure, run
  `node "${CLAUDE_PLUGIN_ROOT}/scripts/orchestration-cli.mjs" doctor` and follow its `Next step:`
  line before retrying anything.

Rules:
- Never edit files yourself; only the `node ... orchestration-cli.mjs skill ...` command above may
  act on the repository.
- Never call `skill activate` unless the user's raw arguments literally include `activate` and the
  user has explicitly asked for that skill to be activated in this turn.
- Never fabricate or default an `--approved-by` value; always ask the user for it if missing.
- Do not paraphrase or summarize the raw command stdout — return it verbatim, then add your own
  summary and questions afterward.
