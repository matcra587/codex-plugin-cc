// Modified from openai/codex-plugin-cc by Matt Craven in 2026.
// See NOTICE for attribution and plugins/codex/CHANGELOG.md for changes.

import { test } from "bun:test";
import { chmodSync } from "node:fs";
import { fs, path } from "../plugins/codex/scripts/lib/platform.ts";
import { assert } from "./assertions.ts";
import { makeTempDir } from "./helpers.ts";

// The port tested for a directory by opening it, which needs the read bit.
// Walking through a directory only needs execute, so an ancestor with execute
// but no read read as absent and recursive mkdir failed on a directory it
// should have passed straight through. 0o311 is the discriminating mode: 0o711
// still grants the owner read, so only a mode that withholds it diverges.
test("recursive mkdir walks through an ancestor it may traverse but not read", () => {
  const root = makeTempDir();
  const ancestor = path.join(root, "no-read");
  fs.mkdirSync(ancestor);
  const leaf = path.join(ancestor, "nested", "deep");
  chmodSync(ancestor, 0o311);

  try {
    fs.mkdirSync(leaf, { recursive: true });
    assert.equal(fs.existsSync(leaf), true, "the leaf should have been created");
  } finally {
    chmodSync(ancestor, 0o700);
  }
});

test("a directory that cannot be read still reports as a directory", () => {
  const root = makeTempDir();
  const target = path.join(root, "no-read");
  fs.mkdirSync(target);
  chmodSync(target, 0o311);

  try {
    assert.equal(fs.statSync(target).isDirectory(), true, "execute-only directories are still directories");
  } finally {
    chmodSync(target, 0o700);
  }
});
