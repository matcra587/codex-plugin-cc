---
description: Transfer the current Claude Code session into a resumable Codex thread
argument-hint: "[--source <claude-jsonl>]"
disable-model-invocation: true
allowed-tools: Bash(bun:*)
---

<!--
  Modified from openai/codex-plugin-cc by Matt Craven in 2026.
  See NOTICE for attribution and plugins/codex/CHANGELOG.md for changes.
-->

!`bun "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.ts" transfer "$ARGUMENTS"`

Present the command output to the user exactly as returned. Preserve the Codex session ID and the `codex resume <session-id>` command.
