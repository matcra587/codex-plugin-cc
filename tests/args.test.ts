import { test } from "bun:test";
import { parseArgs, splitLeadingOptions, UnknownOptionError } from "../plugins/codex/scripts/lib/args.ts";
import { assert } from "./assertions.ts";

// Mirrors handleTask, the command whose trailing positional is a free-text
// prompt rather than an identifier.
const TASK = {
  valueOptions: ["model", "effort", "cwd", "prompt-file"],
  booleanOptions: ["json", "write", "resume-last", "resume", "fresh", "background", "help"],
  aliasMap: { m: "model" },
  trailingText: true
} as const;

// Mirrors handleCancel, where the positional is a job id and options may follow.
const CANCEL = {
  valueOptions: ["cwd"],
  booleanOptions: ["json", "help"]
} as const;

function parseRaw(raw: string, config: typeof TASK | typeof CANCEL) {
  return parseArgs(splitLeadingOptions(raw, config), config);
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
