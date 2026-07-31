import { test } from "bun:test";
import {
  parseArgs,
  splitLeadingOptions,
  splitRawArgumentString,
  UnknownOptionError
} from "../plugins/codex/scripts/lib/args.ts";
import { assert } from "./assertions.ts";

// Mirrors handleTask, the command whose trailing positional is a free-text
// prompt rather than an identifier.
const TASK = {
  valueOptions: ["model", "effort", "cwd", "prompt-file"],
  booleanOptions: ["json", "write", "resume-last", "resume", "fresh", "background", "help"],
  aliasMap: { m: "model" },
  trailingText: true
} as const;

// Mirrors handleCancel, where the positional is a job id and options may
// follow. help is deliberately absent: parseCommandInput only injects it for
// free-text commands, and recognises it as a leading token otherwise.
const CANCEL = {
  valueOptions: ["cwd"],
  booleanOptions: ["json"],
  trailingText: false
} as const;

// Mirrors normalizeArgv and parseCommandInput: slash commands hand over
// "$ARGUMENTS" as one string, only free-text commands keep their remainder
// verbatim, and identifier commands answer --help only as the first token.
function parseRaw(raw: string, config: typeof TASK | typeof CANCEL) {
  const argv = config.trailingText ? splitLeadingOptions(raw, config) : splitRawArgumentString(raw);
  const parsed = parseArgs(argv, config);
  if (!config.trailingText && (argv[0] === "--help" || argv[0] === "-h")) {
    (parsed.options as Record<string, unknown>).help = true;
  }
  return parsed;
}

test("prose that looks like an option stays in the prompt", () => {
  const { options, positionals } = parseRaw("fix the --model handling in codex.ts", TASK);
  assert.equal(positionals.join(" "), "fix the --model handling in codex.ts");
  assert.equal(options.model, undefined);
});

test("leading options are parsed and the prompt after them is left alone", () => {
  const { options, positionals } = parseRaw("--background investigate the --resume flag bug", TASK);
  assert.equal(options.background, true);
  assert.equal(options.resume, undefined);
  assert.equal(positionals.join(" "), "investigate the --resume flag bug");
});

test("quotes and backslashes survive into the prompt", () => {
  const raw = 'handle the "flaky" test and a back\\slash';
  const { positionals } = parseRaw(raw, TASK);
  assert.equal(positionals.join(" "), raw);
});

test("documented model and effort flags still parse", () => {
  const { options, positionals } = parseRaw(
    "--model gpt-5.6-terra --effort medium investigate the flaky integration test",
    TASK
  );
  assert.equal(options.model, "gpt-5.6-terra");
  assert.equal(options.effort, "medium");
  assert.equal(positionals.join(" "), "investigate the flaky integration test");
});

test("-- ends option parsing so a prompt may start with a dash", () => {
  const { options, positionals } = parseRaw("--background -- --model is the thing to fix", TASK);
  assert.equal(options.background, true);
  assert.equal(options.model, undefined);
  assert.equal(positionals.join(" "), "--model is the thing to fix");
});

test("an unknown option is rejected instead of becoming prompt text", () => {
  assert.throws(() => parseRaw("--nope do the thing", TASK), /Unknown option --nope/);
  try {
    parseRaw("--nope do the thing", TASK);
  } catch (error) {
    assert.equal(error instanceof UnknownOptionError, true);
  }
});

test("--help is an option rather than a prompt", () => {
  const { options, positionals } = parseRaw("--help", TASK);
  assert.equal(options.help, true);
  assert.equal(positionals.length, 0);
});

// Commands taking an identifier keep interspersed parsing: the job id comes
// first and its flags follow.
test("options still follow a job id for identifier commands", () => {
  const { options, positionals } = parseArgs(["task-abc123", "--json"], CANCEL);
  assert.equal(positionals[0], "task-abc123");
  assert.equal(options.json, true);
});

// /codex:result is handed "$ARGUMENTS" verbatim, so a user pasting a previous
// review into it must not hard-fail on a `---` rule or a dash in the prose.
test("pasted prose containing dashes does not fail an identifier command", () => {
  const pasted = [
    "Codex Adversarial Review",
    "",
    "Verdict: needs-attention",
    "---",
    "Note: --model was mentioned"
  ].join("\n");
  const { positionals } = parseRaw(pasted, CANCEL);
  assert.equal(positionals.includes("---"), true);
  assert.equal(positionals.includes("--model"), true);
  assert.equal(positionals[0], "Codex");
});

test("identifier commands still answer --help", () => {
  const { options } = parseRaw("--help", CANCEL);
  assert.equal(options.help, true);
});

// Identifier commands are handed arbitrary pasted text, so --help buried in it
// must not print usage in place of the job result.
test("--help inside pasted prose does not trigger help on identifier commands", () => {
  const { options, positionals } = parseRaw("Verdict: needs-attention. Re-run with --help for usage", CANCEL);
  assert.equal(options.help, undefined);
  assert.equal(positionals[0], "Verdict:");
});

test("a quoted empty string is not treated as a job reference", () => {
  assert.deepEqual(splitRawArgumentString("'' task-123"), ["task-123"]);
});

// Identifier commands take at most one job id but are handed whatever the user
// typed, so a --json or --cwd buried in pasted prose used to change the output
// format or re-root workspace resolution.
const RESULT = {
  valueOptions: ["cwd"],
  booleanOptions: ["json"],
  trailingText: false,
  singlePositional: true
} as const;

test("an identifier command still takes options around its job id", () => {
  for (const raw of ["task-abc --json", "--json task-abc"]) {
    const { options, positionals } = parseRaw(raw, RESULT);
    assert.equal(options.json, true, raw);
    assert.equal(positionals[0], "task-abc", raw);
  }
  const withValue = parseRaw("task-abc --cwd /tmp", RESULT);
  assert.equal(withValue.options.cwd, "/tmp");
});

test("options buried in pasted prose are inert on identifier commands", () => {
  const pasted = [
    "Codex Adversarial Review",
    "",
    "Verdict: needs-attention",
    "Re-run with --json for machine output"
  ].join("\n");
  const { options, positionals } = parseRaw(pasted, RESULT);
  assert.equal(options.json, undefined, "a --json in prose must not flip the output format");
  assert.equal(positionals[0], "Codex", "only the first token is a candidate job reference");
});

test("a --cwd in pasted prose cannot re-root workspace resolution", () => {
  const { options } = parseRaw("Verdict needs attention --cwd /etc please check", RESULT);
  assert.equal(options.cwd, undefined);
});
