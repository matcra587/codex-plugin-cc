import { test } from "bun:test";

import {
  loadBrokerSession,
  saveBrokerSession
} from "../plugins/codex/scripts/lib/broker-lifecycle.ts";
import { fs, path } from "../plugins/codex/scripts/lib/platform.ts";
import { resolveStateDir } from "../plugins/codex/scripts/lib/state.ts";
import { assert } from "./assertions.ts";
import { makeTempDir } from "./helpers.ts";

function writeBrokerState(workspace: string, value: unknown): void {
  const stateDir = resolveStateDir(workspace);
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, "broker.json"), `${JSON.stringify(value)}\n`, "utf8");
}

test("loadBrokerSession returns a validated persisted session", () => {
  const workspace = makeTempDir();
  const session = {
    endpoint: "unix:/tmp/codex-broker.sock",
    pidFile: "/tmp/codex-broker.pid",
    logFile: "/tmp/codex-broker.log",
    sessionDir: "/tmp/codex-broker",
    pid: 1234
  };

  saveBrokerSession(workspace, session);

  assert.deepEqual(loadBrokerSession(workspace), session);
});

test("loadBrokerSession rejects malformed persisted sessions", () => {
  const workspace = makeTempDir();

  writeBrokerState(workspace, { endpoint: 42 });
  assert.equal(loadBrokerSession(workspace), null);

  writeBrokerState(workspace, { endpoint: "unix:/tmp/codex-broker.sock", pid: "1234" });
  assert.equal(loadBrokerSession(workspace), null);
});
