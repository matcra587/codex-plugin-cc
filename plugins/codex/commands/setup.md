---
description: Check whether the local Codex CLI is ready and optionally toggle the stop-time review gate
argument-hint: '[--enable-review-gate|--disable-review-gate]'
allowed-tools: Bash(bun:*), AskUserQuestion
---

<!--
  Modified from openai/codex-plugin-cc by Matt Craven in 2026.
  See NOTICE for attribution and plugins/codex/CHANGELOG.md for changes.
-->

Run:

```bash
bun "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.ts" setup --json $ARGUMENTS
```

If the result says Codex is unavailable and Bun is available:
- Use `AskUserQuestion` exactly once to ask whether Claude should install Codex now.
- Put the install option first and suffix it with `(Recommended)`.
- Use these two options:
  - `Install Codex (Recommended)`
  - `Skip for now`
- If the user chooses install, run:

```bash
bun add --global @openai/codex@latest
```

- Then rerun:

```bash
bun "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.ts" setup --json $ARGUMENTS
```

If Codex is already installed or Bun is unavailable:
- Do not ask about installation.

Output rules:
- Present the final setup output to the user.
- If installation was skipped, present the original setup output.
- If Codex is installed but not authenticated, preserve the guidance to run `!codex login`.
