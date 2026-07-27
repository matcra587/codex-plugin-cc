import { test } from "bun:test";

import {
  createBrokerSessionDir,
  ensureBrokerSession,
  EXISTING_BROKER_PROBE_TIMEOUT_MS,
  loadBrokerSession,
  saveBrokerSession
} from "../plugins/codex/scripts/lib/broker-lifecycle.ts";
import { createBrokerEndpoint } from "../plugins/codex/scripts/lib/broker-endpoint.ts";
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
  const sessionDir = createBrokerSessionDir();
  const session = {
    endpoint: createBrokerEndpoint(sessionDir),
    pidFile: path.join(sessionDir, "broker.pid"),
    logFile: path.join(sessionDir, "broker.log"),
    sessionDir,
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

test("loadBrokerSession rejects paths outside its private session directory", () => {
  const workspace = makeTempDir();
  const sessionDir = createBrokerSessionDir();

  writeBrokerState(workspace, {
    endpoint: createBrokerEndpoint(sessionDir),
    pidFile: path.join(workspace, "keep.pid"),
    logFile: path.join(sessionDir, "broker.log"),
    sessionDir,
    pid: 1234
  });

  assert.equal(loadBrokerSession(workspace), null);

  writeBrokerState(workspace, {
    endpoint: `unix:${path.join(workspace, "attacker.sock")}`,
    pidFile: path.join(sessionDir, "broker.pid"),
    logFile: path.join(sessionDir, "broker.log"),
    sessionDir,
    pid: 1
  });

  assert.equal(loadBrokerSession(workspace), null);
});

test("ensureBrokerSession gives an existing broker a meaningful readiness window", async () => {
  const workspace = makeTempDir();
  const sessionDir = createBrokerSessionDir();
  const session = {
    endpoint: createBrokerEndpoint(sessionDir),
    pidFile: path.join(sessionDir, "broker.pid"),
    logFile: path.join(sessionDir, "broker.log"),
    sessionDir,
    pid: process.pid
  };
  saveBrokerSession(workspace, session);

  let observedTimeout = 0;
  const resolved = await ensureBrokerSession(workspace, {
    waitForBrokerEndpoint: async (_endpoint, timeoutMs) => {
      observedTimeout = timeoutMs ?? 0;
      return true;
    }
  });

  assert.deepEqual(resolved, session);
  assert.equal(observedTimeout, EXISTING_BROKER_PROBE_TIMEOUT_MS);
  assert.equal(observedTimeout >= 1000, true);
});
