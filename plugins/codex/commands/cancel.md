---
description: Cancel an active background Codex job in this repository
argument-hint: '[job-id]'
disable-model-invocation: true
allowed-tools: Bash(bun:*)
---

<!--
  Modified from openai/codex-plugin-cc by Matt Craven in 2026.
  See NOTICE for attribution and plugins/codex/CHANGELOG.md for changes.
-->

!`bun "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.ts" cancel "$ARGUMENTS"`
