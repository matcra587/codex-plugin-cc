import { test } from "bun:test";
import { assert } from "./assertions.ts";

import { terminateProcessTree } from "../plugins/codex/scripts/lib/process.ts";

test("terminateProcessTree signals the Unix process group", () => {
  let captured: { pid: number; signal: string } | null = null;
  const outcome = terminateProcessTree(1234, {
    killImpl(pid, signal) {
      captured = { pid, signal };
    }
  });

  assert.deepEqual(captured, { pid: -1234, signal: "SIGTERM" });
  assert.equal(outcome.delivered, true);
  assert.equal(outcome.method, "process-group");
});

test("terminateProcessTree treats a missing Unix process group as stopped", () => {
  const outcome = terminateProcessTree(1234, {
    killImpl() {
      throw Object.assign(new Error("missing"), { code: "ESRCH" });
    }
  });

  assert.equal(outcome.attempted, true);
  assert.equal(outcome.delivered, false);
  assert.equal(outcome.method, "process-group");
});
