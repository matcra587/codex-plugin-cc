import { test } from "bun:test";
import { fs, path } from "../plugins/codex/scripts/lib/platform.ts";
import { assert } from "./assertions.ts";
import { makeTempDir, run, writeExecutable } from "./helpers.ts";

const ROOT = path.resolve(path.dirname(Bun.fileURLToPath(import.meta.url)), "..");
const WRAPPER = path.join(ROOT, "plugins", "codex", "scripts", "with-bun.sh");

const MARKER = "delegated-to-bun";

// A stub that answers `--version` with the version under test, and otherwise
// prints a marker so the test can tell whether the wrapper handed off.
function fakeBunDir(version: string): string {
  const binDir = makeTempDir("codex-plugin-fakebun-");
  writeExecutable(
    path.join(binDir, "bun"),
    [
      "#!/bin/sh",
      'if [ "$1" = "--version" ]; then',
      `  echo "${version}"`,
      "  exit 0",
      "fi",
      `echo "${MARKER} $*"`,
      ""
    ].join("\n")
  );
  return binDir;
}

function runWrapper(pathValue: string) {
  return run("sh", [WRAPPER, "entrypoint.ts", "an-argument"], {
    env: { PATH: pathValue }
  });
}

test("preflight hands off to bun when the installed version meets the floor", () => {
  for (const version of ["1.3.14", "1.3.15", "1.4.0", "2.0.0", "1.10.0"]) {
    const result = runWrapper(`${fakeBunDir(version)}:/usr/bin:/bin`);
    assert.equal(result.status, 0, `${version}: ${result.stderr}`);
    assert.match(result.stdout, new RegExp(`${MARKER} entrypoint\\.ts an-argument`));
  }
});

// 1.10.0 above and 1.2.99 here are the cases a lexical comparison gets wrong.
test("preflight rejects a bun older than the engines floor", () => {
  for (const version of ["1.3.13", "1.2.99", "0.9.9"]) {
    const result = runWrapper(`${fakeBunDir(version)}:/usr/bin:/bin`);
    assert.equal(result.status, 1, `${version} should have been rejected`);
    assert.match(result.stderr, /requires Bun 1\.3\.14 or later/);
    assert.match(result.stderr, new RegExp(`found ${version.replace(/\./g, "\\.")}`));
  }
});

test("preflight tolerates build metadata and prerelease suffixes", () => {
  for (const version of ["1.3.14+abcdef", "1.3.14-canary.1"]) {
    const result = runWrapper(`${fakeBunDir(version)}:/usr/bin:/bin`);
    assert.equal(result.status, 0, `${version}: ${result.stderr}`);
    assert.match(result.stdout, new RegExp(MARKER));
  }
});

test("preflight explains how to install bun when it is absent", () => {
  const result = runWrapper("/usr/bin:/bin");
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /"bun" is not on PATH/);
  assert.match(result.stderr, /bun\.sh\/install/);
});

// Exec form spawns the wrapper directly with no shell, so the executable bit
// is load-bearing rather than cosmetic.
test("preflight wrapper is executable", async () => {
  // The platform fs shim's statSync only exposes isDirectory, so read the
  // mode through Bun.file as the state tests do.
  const mode = (await Bun.file(WRAPPER).stat()).mode;
  assert.equal((mode & 0o111) !== 0, true, "with-bun.sh must be executable");
});

test("every hook routes through the preflight in exec form", () => {
  const hooks = JSON.parse(fs.readFileSync(path.join(ROOT, "plugins", "codex", "hooks", "hooks.json"), "utf8"));
  const handlers = Object.values(hooks.hooks as Record<string, { hooks: Record<string, unknown>[] }[]>)
    .flat()
    .flatMap((group) => group.hooks);

  assert.equal(handlers.length, 3);
  for (const handler of handlers) {
    assert.match(String(handler.command), /with-bun\.sh$/);
    // args present means exec form: no shell, so no quoting of plugin paths.
    assert.equal(Array.isArray(handler.args), true, "hook must use exec form");
    assert.match(String((handler.args as string[])[0]), /-hook\.ts$/);
  }
});
