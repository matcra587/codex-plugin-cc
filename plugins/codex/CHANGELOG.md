<!--
  Modified from openai/codex-plugin-cc by Matt Craven in 2026.
  See NOTICE for attribution and plugins/codex/CHANGELOG.md for changes.
-->

# Changelog

## 2.0.1

### Fixed

- The stop-time review gate no longer blocks the turn repeatedly. It ignored
  `stop_hook_active`, so every forced retry ran another review and blocked
  again. A review that timed out or errored is never `ok`, so the gate held the
  turn until Claude Code hit its consecutive-block cap and overrode the hook —
  worst in exactly the cases the gate was least useful. It now reviews once and
  yields on the retry.
- Review and adversarial review persist their Codex thread instead of running
  it ephemerally. A foreground review whose output was lost left nothing behind:
  no thread to resume, no stored result. Both paths now leave a recoverable
  thread named `Codex Companion Review: …`.

  Reviews therefore appear in `codex resume` and in Codex's thread history,
  where previously they did not. The name is deliberately distinct from the
  task prefix, so a review can never be picked up by `task --resume-last`.

## 2.0.0

First release of this fork of [openai/codex-plugin-cc](https://github.com/openai/codex-plugin-cc),
maintained independently of upstream. The version jumps to 2.0.0 rather than restarting at 1.0.0
so it stays ahead of the 1.0.6 it forked from.

### Breaking

- **Bun is now required, and there is no Node.js fallback.** The runtime, the tooling and the test
  suite all target Bun 1.3.14 or later. This is a deliberate divergence from upstream: the plugin
  uses `Bun.spawn`, `Bun.listen`/`Bun.connect` for the broker's unix sockets, and `bun:ffi` for
  `flock`-based state locking, none of which have drop-in Node equivalents.
- The marketplace is now `openai-codex-bun`, so install with
  `/plugin marketplace add matcra587/codex-plugin-cc` followed by
  `/plugin install codex@openai-codex-bun`.
- Linux or macOS only.

### Changed

- Migrated the Node.js runtime and tooling to Bun.
- Migrated the runtime modules from JavaScript to TypeScript and adopted the TypeScript 7 native
  compiler, with strict null, error and protocol-shape checks.
- Hooks now run through a preflight wrapper that reports a missing or outdated Bun with an
  actionable message instead of a bare `bun: command not found`, and use the hook reference's exec
  form so plugin paths need no shell quoting.
- Adopted Biome for formatting and linting, configured to match the existing source style.
- Pinned versions are tracked by Clover, including a 72h cooldown matching `bunfig.toml`'s
  `minimumReleaseAge` so a proposed bump is always one `bun install` can resolve.
- CI runs on pushes to `main` as well as pull requests, and verifies that the manifest versions
  agree.

## 1.0.0

- Initial version of the Codex plugin for Claude Code
