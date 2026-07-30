import { test } from "bun:test";
import { IDLE_TIMEOUT_ENV, resolveIdleTimeoutMs } from "../plugins/codex/scripts/app-server-broker.ts";
import { createBrokerEndpoint } from "../plugins/codex/scripts/lib/broker-endpoint.ts";
import {
  createBrokerSessionDir,
  EXISTING_BROKER_PROBE_TIMEOUT_MS,
  ensureBrokerSession,
  loadBrokerSession,
  saveBrokerSession
} from "../plugins/codex/scripts/lib/broker-lifecycle.ts";
import { fs, path } from "../plugins/codex/scripts/lib/platform.ts";
import { resolveStateDir } from "../plugins/codex/scripts/lib/state.ts";
import { assert } from "./assertions.ts";
import { buildEnv, installFakeCodex } from "./fake-codex-fixture.ts";
import { makeTempDir } from "./helpers.ts";

const BROKER_SCRIPT = path.resolve(
  path.dirname(Bun.fileURLToPath(import.meta.url)),
  "..",
  "plugins/codex/scripts/app-server-broker.ts"
);

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

test("resolveIdleTimeoutMs defaults, disables, and rejects nonsense", () => {
  assert.equal(resolveIdleTimeoutMs(undefined), 30 * 60 * 1000);
  // Unparsable input must fall back rather than silently disable reaping.
  assert.equal(resolveIdleTimeoutMs("not-a-number"), 30 * 60 * 1000);
  // An exported-but-empty variable must not silently disable reaping.
  assert.equal(resolveIdleTimeoutMs(""), 30 * 60 * 1000);
  assert.equal(resolveIdleTimeoutMs("   "), 30 * 60 * 1000);
  assert.equal(resolveIdleTimeoutMs("0"), 0);
  assert.equal(resolveIdleTimeoutMs("-5"), 0);
  assert.equal(resolveIdleTimeoutMs("1500"), 1500);
});

function spawnBroker(idleMs: string) {
  const sessionDir = createBrokerSessionDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  const pidFile = path.join(sessionDir, "broker.pid");
  const endpoint = createBrokerEndpoint(sessionDir);
  const child = Bun.spawn(
    [
      process.execPath,
      BROKER_SCRIPT,
      "serve",
      "--endpoint",
      endpoint,
      "--pid-file",
      pidFile,
      "--log-file",
      path.join(sessionDir, "broker.log")
    ],
    { cwd: makeTempDir(), env: { ...buildEnv(binDir), [IDLE_TIMEOUT_ENV]: idleMs }, stdout: "ignore", stderr: "ignore" }
  );
  return { child, pidFile, endpoint };
}

function exitWithin(child: Bun.Subprocess, ms: number): Promise<number | "timeout"> {
  return Promise.race([child.exited, new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), ms))]);
}

// The reported leak is a broker whose session vanished without a SessionEnd
// hook: nothing reaped it, so it and its Codex child stayed up indefinitely.
test("an idle broker reaps itself and removes its pid file", async () => {
  const { child, pidFile } = spawnBroker("300");
  // Under the control test's survival window, so the pair discriminates.
  const outcome = await exitWithin(child, 2_000);
  assert.equal(outcome, 0, "the idle broker should exit cleanly");
  assert.equal(fs.existsSync(pidFile), false, "shutdown should remove the pid file");
});

// Control: proves the exit above is caused by idleness, not by the fake Codex
// child dying and tripping the existing exitPromise shutdown.
test("a broker with reaping disabled stays up while idle", async () => {
  const { child } = spawnBroker("0");
  // Comfortably longer than the reaping case above takes, and under the
  // runner's per-test timeout.
  const outcome = await exitWithin(child, 2_000);
  child.kill();
  assert.equal(outcome, "timeout", "the broker should still be running with reaping disabled");
});

// The idle check used to sample state on its tick, so an operation that began
// and ended between two ticks was never seen and a broker in steady use reaped
// itself mid-session.
test("a broker in steady use is not reaped", async () => {
  const { child, endpoint } = spawnBroker("600");
  const socketPath = endpoint.replace(/^unix:/, "");

  const useOnce = () =>
    new Promise<void>((resolve) => {
      Bun.connect({
        unix: socketPath,
        socket: {
          open(socket) {
            socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "thread/list", params: { cwd: "/" } })}\n`);
          },
          data(socket) {
            socket.end();
            resolve();
          },
          error: () => resolve(),
          close: () => resolve()
        }
      }).catch(() => resolve());
    });

  // Five operations spaced inside the window, spanning several times its length.
  for (let index = 0; index < 5; index += 1) {
    await Bun.sleep(300);
    if (child.exitCode !== null) {
      break;
    }
    await useOnce();
  }

  const stillRunning = child.exitCode === null;
  child.kill();
  assert.equal(stillRunning, true, "steady use must keep the broker alive");
});
