---
description: Show the stored final output for a finished Codex job in this repository
argument-hint: '[job-id]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" result "$ARGUMENTS"`

Present the full command output to the user. Do not summarize or condense it. Preserve all details including:
- Job ID and status
- The complete result payload, including verdict, summary, findings, details, artifacts, and next steps
- File paths and line numbers exactly as reported
- Any error messages or parse errors
- Follow-up commands such as `/codex:status <id>` and `/codex:review`

If the `node` command fails with `MODULE_NOT_FOUND` on a path containing an old plugin version (e.g. `...\codex\1.0.6\...`), the plugin was updated while this session was running — tell the user to restart the Claude Code session. Do not retry with a guessed or corrected path.
