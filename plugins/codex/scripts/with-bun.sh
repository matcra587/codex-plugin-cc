#!/bin/sh
# Preflight wrapper for this plugin's Bun entrypoints.
#
# The hooks run automatically and with no user context, so without this a
# missing or outdated Bun surfaces as a bare "bun: command not found" (or an
# arbitrary runtime error from a Bun too old to have the APIs the plugin
# uses). Neither says what is wrong or how to fix it.
#
# Usage: with-bun.sh <script.ts> [args...]

set -eu

# Keep in step with the "engines.bun" floor in package.json.
REQUIRED_BUN_VERSION="1.3.14"

if ! command -v bun >/dev/null 2>&1; then
  cat >&2 <<MESSAGE
codex-plugin-cc requires Bun ${REQUIRED_BUN_VERSION} or later, but "bun" is not on PATH.

Install it, then start a new Claude Code session:

  curl -fsSL https://bun.sh/install | bash

Other install methods: https://bun.sh/docs/installation
MESSAGE
  exit 1
fi

# Strip build metadata and prerelease suffixes: "1.3.14+abc" / "1.3.14-canary".
current_bun_version=$(bun --version 2>/dev/null | head -n1 | tr -d '[:space:]' | cut -d'+' -f1 | cut -d'-' -f1)

# Compare dotted numeric versions field by field. `sort -V` is avoided because
# it is not dependably available on macOS.
if ! printf '%s\n' "${current_bun_version}" | awk -F. -v required="${REQUIRED_BUN_VERSION}" '
  BEGIN { split(required, want, ".") }
  {
    for (i = 1; i <= 3; i++) {
      have_field = $i + 0
      want_field = want[i] + 0
      if (have_field > want_field) exit 0
      if (have_field < want_field) exit 1
    }
    exit 0
  }
'; then
  cat >&2 <<MESSAGE
codex-plugin-cc requires Bun ${REQUIRED_BUN_VERSION} or later, but found ${current_bun_version}.

Upgrade it, then start a new Claude Code session:

  bun upgrade
MESSAGE
  exit 1
fi

exec bun "$@"
