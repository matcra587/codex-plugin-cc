<!--
  Modified from openai/codex-plugin-cc by Matt Craven in 2026.
  See NOTICE for attribution and plugins/codex/CHANGELOG.md for changes.
-->

# Changelog

## 2.1.0

### Added

- Brokers reap themselves once genuinely idle. A broker deliberately outlives
  the command that spawned it so the next one reuses a warm app-server, but
  nothing reaped it when its session went away without a SessionEnd hook — a
  crash, a closed terminal, a suspended machine. It and its Codex child then
  stayed up for as long as the machine did. Measured while developing this:
  58 orphaned brokers, 61 Codex children, about 5.2GB resident.

  Reaping needs sustained inactivity, not a disconnect. Clients connect per
  operation and disconnect straight after, so a live session between commands
  has no sockets either. A broker is only a candidate when it has no sockets,
  no active request and no streaming turn, and has seen no activity for the
  whole window — so a broker serving another session is never reaped.

  Thirty minutes by default. `CODEX_COMPANION_BROKER_IDLE_MS` overrides it and
  `0` disables it.

### Fixed

- Shutdown stops accepting connections before tearing down the Codex child.
  Closing the client first left the endpoint answering `initialize` for as long
  as the child took to exit, so a command could attach to a dying broker and
  then fail with an error it does not retry.
- Teardown finishes even if removing the socket or pid file fails, rather than
  aborting and leaving the child running.

## 2.0.3

### Fixed

- `status`, `result` and `cancel` no longer fail on text containing a dash.
  2.0.2 made an unrecognised option a hard error, but those commands receive
  whatever the user typed, so pasting a previous review into `/codex:result`
  aborted on its `---` rule. Only the commands whose trailing text is a prompt
  reject unknown options now, which is where a stray flag used to dispatch a
  real Codex turn. The others treat it as text again, and every command still
  answers `--help`.
- Status table cells escape backslashes before pipes. Escaping only the pipe
  left an input `\|` as `\\|`, which renders as a literal backslash followed by
  a live pipe and breaks out of the cell, so job summaries could inject table
  structure into `/codex:status`. Reported by CodeQL as
  `js/incomplete-sanitization`. Cells also collapse a lone carriage return,
  which CommonMark treats as a line ending too.
- `--help` buried in pasted text no longer replaces a job result with the usage
  screen. `status`, `result` and `cancel` parse options anywhere in their
  input, so they now recognise `--help` only as the leading token. Commands
  ending in free text stop parsing options at the first word of the prompt, so
  `--help` there remains a real request.
- `cancel ''` no longer reads an empty job reference and falls through to the
  latest job.

### Changed

- Documented that flags must precede the prompt text, in the README and in the
  rescue subagent's instructions. Option parsing stops at the first word of the
  prompt — that is what lets a request mention a flag by name — so a flag after
  it is sent to Codex as text rather than acted on.

## 2.0.2

### Fixed

- Prompt text is no longer mangled. Slash commands hand the whole of
  `$ARGUMENTS` over as a single argument, which was then re-split in full:
  quotes and backslashes were stripped, and prose such as
  `fix the --model handling` was read as a real option, hijacking model
  selection and swallowing the following word. Only the leading run of
  recognised options is parsed now; from the first word that is not one, the
  prompt reaches Codex exactly as typed.
- An unrecognised option is now a clean error instead of prompt text. Because
  unknown flags were treated as positionals, `task --help` dispatched a real
  Codex thread rather than printing usage. Every command answers `--help`, and
  an unknown option exits non-zero with an explanation.

Commands taking an identifier, such as `cancel <job-id> --json`, keep accepting
options after the positional. The change applies to the commands whose trailing
text is a prompt. Write `--` before prompt text that legitimately begins with a
dash.

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
