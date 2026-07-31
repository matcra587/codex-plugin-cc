import { test } from "bun:test";
import { chmodSync } from "node:fs";
import { IDLE_TIMEOUT_ENV, resolveIdleTimeoutMs } from "../plugins/codex/scripts/app-server-broker.ts";
import { createBrokerEndpoint } from "../plugins/codex/scripts/lib/broker-endpoint.ts";
import {
  createBrokerSessionDir,
  EXISTING_BROKER_PROBE_TIMEOUT_MS,
  ensureBrokerSession,
  loadBrokerSession,
  saveBrokerSession,
  waitForBrokerEndpoint
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

function spawnBroker(idleMs: string, behavior = "review-ok") {
  const sessionDir = createBrokerSessionDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, behavior);
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
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    child.exited,
    new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), ms);
    })
    // Clear the pending timer so a fast exit does not hold the runner open.
  ]).finally(() => clearTimeout(timer));
}

// Waits for a condition rather than sleeping a fixed time, so the slower CI
// runners do not fail on timing alone.
async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) {
      return true;
    }
    await Bun.sleep(50);
  }
  return false;
}

function brokerChildren(pid: number): Promise<string[]> {
  return Bun.$`pgrep -P ${pid} || true`.text().then((out) => out.trim().split(/\s+/).filter(Boolean));
}

// The reported leak is a broker whose session vanished without a SessionEnd
// hook: nothing reaped it, so it and its Codex child stayed up indefinitely.
test("an idle broker reaps itself and removes its pid file", async () => {
  const { child, pidFile } = spawnBroker("300");
  // Under the control test's survival window, so the pair discriminates.
  const outcome = await exitWithin(child, 2_000);
  // A failing reap must not leave a broker behind, in the suite about leaks.
  if (outcome === "timeout") {
    child.kill();
  }
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
  // A longer window than the other reaping tests: the broker has to come up and
  // be used several times, and reaping it during startup would prove nothing.
  const { child, endpoint } = spawnBroker("1500");
  await waitForBrokerEndpoint(endpoint, 10_000);
  const socketPath = endpoint.replace(/^unix:/, "");

  // Resolves true only on a real response, so a run of failed connections
  // cannot be mistaken for activity keeping the broker alive.
  const useOnce = () =>
    new Promise<boolean>((resolve) => {
      Bun.connect({
        unix: socketPath,
        socket: {
          open(socket) {
            // initialize is answered by the broker itself, so a response proves
            // the round trip without depending on the fixture's method coverage.
            socket.write(
              `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { clientInfo: { name: "t", version: "1" } } })}\n`
            );
          },
          data(socket) {
            // Resolve before ending: socket.end() fires close synchronously,
            // and close resolving false would otherwise win the race.
            resolve(true);
            socket.end();
          },
          error: () => resolve(false),
          close: () => resolve(false)
        }
      }).catch(() => resolve(false));
    });

  // Five operations spaced inside the window, spanning several times its length.
  let served = 0;
  for (let index = 0; index < 5; index += 1) {
    await Bun.sleep(300);
    if (child.exitCode !== null) {
      break;
    }
    if (await useOnce()) {
      served += 1;
    }
  }

  const stillRunning = child.exitCode === null;
  child.kill();
  assert.equal(served, 5, "every operation should have been answered");
  assert.equal(stillRunning, true, "steady use must keep the broker alive");
});

function connectLines(socketPath: string) {
  let onLine: (line: string) => void = () => {};
  let buffer = "";
  const ready = new Promise<Bun.Socket<undefined>>((resolve, reject) => {
    Bun.connect({
      unix: socketPath,
      socket: {
        open: (socket) => resolve(socket as Bun.Socket<undefined>),
        data: (_socket, chunk) => {
          buffer += new TextDecoder().decode(chunk);
          let index = buffer.indexOf("\n");
          while (index !== -1) {
            const line = buffer.slice(0, index);
            buffer = buffer.slice(index + 1);
            index = buffer.indexOf("\n");
            if (line.trim()) {
              onLine(line);
            }
          }
        },
        error: (_socket, error) => reject(error)
      }
    }).catch(reject);
  });
  return { ready, setHandler: (fn: (line: string) => void) => (onLine = fn) };
}

// The inverse hazard to reaping: a broker is shared between sessions, so it must
// never be reaped while it is streaming a turn for one of them.
test("a broker streaming a turn is not reaped mid-turn", async () => {
  const { child, endpoint } = spawnBroker("500", "interruptible-slow-task");
  await waitForBrokerEndpoint(endpoint, 5_000);
  const client = connectLines(endpoint.replace(/^unix:/, ""));
  const socket = await client.ready;
  let turnStarted = false;
  client.setHandler((line) => {
    if (line.includes('"turn/started"')) {
      turnStarted = true;
    }
  });
  socket.write(
    `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { clientInfo: { name: "t", version: "1" } } })}\n`
  );
  await Bun.sleep(100);
  socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "thread/start", params: { cwd: "/tmp" } })}\n`);
  await Bun.sleep(100);
  socket.write(
    `${JSON.stringify({ jsonrpc: "2.0", id: 3, method: "turn/start", params: { threadId: "thr_1", input: [{ type: "text", text: "go" }] } })}\n`
  );

  // Confirm a turn is genuinely streaming first: asserting survival without one
  // would pass even if turn/start had failed outright.
  const streaming = await waitFor(() => turnStarted, 5_000);
  // The fixture's turn runs for 5s; the idle window is 500ms.
  await Bun.sleep(2000);
  const survived = child.exitCode === null;
  socket.end();
  child.kill();
  assert.equal(streaming, true, "the fixture should have started a turn");
  assert.equal(survived, true, "a broker must not be reaped while streaming a turn");
});

// Regression guards on the two shutdown paths that predate reaping.
test("broker/shutdown still works with reaping enabled", async () => {
  const { child, endpoint } = spawnBroker("600000");
  try {
    assert.equal(await waitForBrokerEndpoint(endpoint, 10_000), true, "the broker should come up");
    const client = connectLines(endpoint.replace(/^unix:/, ""));
    const socket = await client.ready;
    socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "broker/shutdown", params: {} })}\n`);
    const outcome = await exitWithin(child, 3_000);
    assert.equal(outcome, 0, "an explicit shutdown must still stop a reaping-enabled broker");
  } finally {
    // Its idle window is ten minutes, so a failure here would otherwise leave a
    // broker and its Codex child running for that long.
    child.kill();
  }
});

test("a broker still exits when its Codex child dies", async () => {
  const { child, endpoint } = spawnBroker("600000");
  try {
    // The broker only starts listening once its app-server handshake resolves, so
    // waiting for the endpoint guarantees the child is past initialize. Killing
    // before that rejects the handshake and the broker exits 1, not 0.
    assert.equal(await waitForBrokerEndpoint(endpoint, 10_000), true, "the broker should come up");
    let kids: string[] = [];
    await waitFor(async () => {
      kids = await brokerChildren(child.pid);
      return kids.length > 0;
    }, 10_000);
    assert.equal(kids.length > 0, true, "the broker should have spawned a Codex child");
    for (const kid of kids) {
      try {
        process.kill(Number(kid), "SIGKILL");
      } catch {
        // Already gone.
      }
    }
    const outcome = await exitWithin(child, 5_000);
    assert.equal(outcome, 0, "the broker must follow its Codex child out");
  } finally {
    // Its idle window is ten minutes, so a failure here would otherwise leave a
    // broker and its Codex child running for that long.
    child.kill();
  }
});

// Teardown removes the socket before closing the app-server client, so a
// throwing unlink would abort shutdown and leave the Codex child running.
// Making the session directory read-only is the only way to force that.
test("teardown completes even when the socket cannot be removed", async () => {
  const { child, endpoint, pidFile } = spawnBroker("400");
  const sessionDir = path.dirname(pidFile);
  try {
    assert.equal(await waitForBrokerEndpoint(endpoint, 10_000), true, "the broker should come up");
    let kids: string[] = [];
    await waitFor(async () => {
      kids = await brokerChildren(child.pid);
      return kids.length > 0;
    }, 10_000);
    assert.equal(kids.length > 0, true, "the broker should have spawned a Codex child");

    // No write permission on the directory means unlink fails with EACCES.
    // The platform fs shim does not expose chmod, so use node:fs here.
    chmodSync(sessionDir, 0o500);

    const outcome = await exitWithin(child, 6_000);
    assert.equal(outcome, 0, "an unlink failure must not stop the broker exiting");
    const survivors = kids.filter((kid) => {
      try {
        process.kill(Number(kid), 0);
        return true;
      } catch {
        return false;
      }
    });
    assert.equal(survivors.length, 0, "the Codex child must still be torn down");
  } finally {
    chmodSync(sessionDir, 0o700);
    child.kill();
  }
});

// Node's net.Socket buffers whatever the kernel will not accept; Bun's socket
// reports a short write and drops the remainder. A reasoning payload big enough
// to fill the send buffer therefore reached the client as a truncated JSONL
// line, which it rejected as unparsable and tore the connection down mid-turn.
test("a payload larger than the socket send buffer arrives intact", async () => {
  const { child, endpoint } = spawnBroker("600000", "huge-agent-message");
  try {
    assert.equal(await waitForBrokerEndpoint(endpoint, 10_000), true, "the broker should come up");
    const client = connectLines(endpoint.replace(/^unix:/, ""));
    const socket = await client.ready;

    let agentMessage: string | null = null;
    let parseFailure: string | null = null;
    client.setHandler((line) => {
      let message: { method?: string; params?: { item?: { type?: string; text?: string } } };
      try {
        message = JSON.parse(line);
      } catch (error) {
        // The symptom the fix targets: a line that ends mid-object.
        parseFailure = `${error instanceof Error ? error.message : String(error)} (${line.length} bytes)`;
        return;
      }
      if (message.method === "item/completed" && message.params?.item?.type === "agentMessage") {
        agentMessage = message.params.item.text ?? "";
      }
    });

    socket.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { clientInfo: { name: "t", version: "1" } } })}\n`
    );
    await Bun.sleep(100);
    socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "thread/start", params: { cwd: "/tmp" } })}\n`);
    await Bun.sleep(100);
    socket.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: 3, method: "turn/start", params: { threadId: "thr_1", input: [{ type: "text", text: "go" }] } })}\n`
    );

    const delivered = await waitFor(() => agentMessage !== null || parseFailure !== null, 15_000);
    socket.end();
    assert.equal(parseFailure, null, `the broker sent an unparsable line: ${parseFailure}`);
    assert.equal(delivered, true, "the oversized agent message never arrived");
    const text: string = agentMessage ?? "";
    assert.equal(text.startsWith("HUGE_START "), true, "the message should start with its marker");
    assert.equal(text.endsWith(" HUGE_END"), true, `the message was truncated at ${text.length} bytes`);
  } finally {
    child.kill();
  }
  // Above the runner's 5s default: without the fix the tail never arrives, and
  // a bare runner timeout hides which assertion would have failed.
}, 20_000);
