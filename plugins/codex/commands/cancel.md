---
description: Cancel an active background Codex job in this repository
argument-hint: '[job-id]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" cancel "$ARGUMENTS"`

If the `node` command fails with `MODULE_NOT_FOUND` on a path containing an old plugin version (e.g. `...\codex\1.0.6\...`), the plugin was updated while this session was running — tell the user to restart the Claude Code session. Do not retry with a guessed or corrected path.
