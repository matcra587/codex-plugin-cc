#!/usr/bin/env bun

import { BROKER_BUSY_RPC_CODE, CodexAppServerClient } from "./lib/app-server.ts";
import type { AppServerMethod, AppServerNotification, AppServerRequestParams } from "./lib/app-server-protocol";
import { parseArgs } from "./lib/args.ts";
import { parseBrokerEndpoint } from "./lib/broker-endpoint.ts";
import { isJsonRpcMessage, type JsonRpcMessage } from "./lib/json-rpc.ts";
import { fs, path } from "./lib/platform.ts";
import { SocketWriter } from "./lib/socket-writer.ts";
import { isRecord } from "./lib/validation.ts";

type AppServerClient = Awaited<ReturnType<typeof CodexAppServerClient.connect>>;

const encoder = new TextEncoder();

interface BrokerSocketData {
  buffer: string;
  decoder: TextDecoder;
  queue: Promise<void>;
  writer: SocketWriter;
}

interface ActiveStreamTurn {
  threadId: string;
  turnId: string;
}

const APP_SERVER_METHODS: ReadonlySet<string> = new Set<AppServerMethod>([
  "initialize",
  "account/read",
  "config/read",
  "externalAgentConfig/import",
  "thread/start",
  "thread/resume",
  "thread/name/set",
  "thread/list",
  "thread/compact/start",
  "review/start",
  "turn/start",
  "turn/interrupt"
]);
const STREAMING_METHODS = new Set<AppServerMethod>(["turn/start", "review/start", "thread/compact/start"]);

export const IDLE_TIMEOUT_ENV = "CODEX_COMPANION_BROKER_IDLE_MS";
// A broker outlives the command that spawned it so the next one reuses a warm
// app-server. Nothing reaped it when its session went away without a SessionEnd
// hook — a crash, a closed terminal, a suspended machine — so brokers and their
// Codex children accumulated for as long as the machine stayed up.
//
// Clients connect per operation and disconnect straight after, so an idle
// socket count says nothing about whether a session is still alive. Only
// sustained inactivity does. Thirty minutes is far longer than the gap between
// commands in a working session and far shorter than the lifetime of an orphan.
const DEFAULT_IDLE_TIMEOUT_MS = 30 * 60 * 1000;
const IDLE_CHECK_INTERVAL_MS = 60 * 1000;

export function resolveIdleTimeoutMs(raw: string | undefined): number {
  if (raw === undefined) {
    return DEFAULT_IDLE_TIMEOUT_MS;
  }
  // Number("") and Number(" ") are 0, so an exported-but-empty variable would
  // silently disable reaping — the very leak this exists to stop. Only an
  // explicit number counts.
  if (raw.trim() === "") {
    return DEFAULT_IDLE_TIMEOUT_MS;
  }
  const parsed = Number(raw);
  // 0 or a negative value disables reaping; anything unparsable falls back
  // rather than silently disabling it.
  if (!Number.isFinite(parsed)) {
    return DEFAULT_IDLE_TIMEOUT_MS;
  }
  return parsed <= 0 ? 0 : parsed;
}

function stringProperty(value: unknown, property: string): string | null {
  return isRecord(value) && typeof value[property] === "string" ? value[property] : null;
}

function isAppServerMethod(method: string): method is AppServerMethod {
  return APP_SERVER_METHODS.has(method);
}

function requestAppServer(client: AppServerClient, method: AppServerMethod, params: unknown): Promise<unknown> {
  // The broker only accepts allow-listed methods. Codex app-server remains the
  // runtime authority for each generated method's parameter schema.
  return client.request(method, params as AppServerRequestParams<typeof method>);
}

function buildStreamThreadIds(method: AppServerMethod, params: unknown, result: unknown): Set<string> {
  const threadIds = new Set<string>();
  const requestedThreadId = stringProperty(params, "threadId");
  if (requestedThreadId) {
    threadIds.add(requestedThreadId);
  }
  const reviewThreadId = method === "review/start" ? stringProperty(result, "reviewThreadId") : null;
  if (reviewThreadId) {
    threadIds.add(reviewThreadId);
  }
  return threadIds;
}

function buildActiveStreamTurn(method: AppServerMethod, params: unknown, result: unknown): ActiveStreamTurn | null {
  if (method !== "turn/start" && method !== "review/start") {
    return null;
  }
  const turn = isRecord(result) && isRecord(result.turn) ? result.turn : null;
  const turnId = turn ? stringProperty(turn, "id") : null;
  const threadId =
    method === "review/start" ? stringProperty(result, "reviewThreadId") : stringProperty(params, "threadId");
  return threadId && turnId ? { threadId, turnId } : null;
}

// A declared-but-unset class field still exists on the instance, so an `in`
// check is always true for ProtocolError and Number(undefined) is NaN, which
// serialises as `"code": null`. The receiving client rejects that as an invalid
// JSON-RPC message, treats the line as unparsable and tears the connection
// down, failing every pending request with a misleading parse error. Upstream
// used `?? -32000`, which this restores.
function toRpcCode(error: unknown): number {
  const code = error instanceof Error ? (error as { rpcCode?: unknown }).rpcCode : undefined;
  return typeof code === "number" && Number.isFinite(code) ? code : -32000;
}

function buildJsonRpcError(code: number, message: string, data?: unknown) {
  return data === undefined ? { code, message } : { code, message, data };
}

function send(socket: Bun.Socket<BrokerSocketData>, message: unknown): void {
  try {
    socket.data.writer.write(socket, encoder.encode(`${JSON.stringify(message)}\n`));
  } catch {
    // The peer may have closed between routing and delivery.
  }
}

function isInterruptRequest(message: JsonRpcMessage): boolean {
  return message?.method === "turn/interrupt";
}

// Teardown must reach the end. A failed unlink — a raced cleanup, a read-only
// directory — used to abort the rest of shutdown, leaving the app-server child
// running and the pid file behind: the leak this file exists to prevent.
function removeQuietly(target: string | null): void {
  if (!target) {
    return;
  }
  try {
    fs.unlinkSync(target);
  } catch {
    // Already gone, or not ours to remove. Either way, keep tearing down.
  }
}

function writePidFile(pidFile: string | null): void {
  if (!pidFile) {
    return;
  }
  fs.mkdirSync(path.dirname(pidFile), { recursive: true });
  fs.writeFileSync(pidFile, `${process.pid}\n`, "utf8");
}

async function main(): Promise<void> {
  const [subcommand, ...argv] = process.argv.slice(2);
  if (subcommand !== "launch" && subcommand !== "serve") {
    throw new Error(
      "Usage: bun scripts/app-server-broker.ts <launch|serve> --endpoint <value> [--cwd <path>] [--pid-file <path>] [--log-file <path>]"
    );
  }

  const { options } = parseArgs(argv, {
    valueOptions: ["cwd", "pid-file", "log-file", "endpoint"]
  });

  if (!options.endpoint) {
    throw new Error("Missing required --endpoint.");
  }

  const cwd = options.cwd ? path.resolve(process.cwd(), options.cwd) : process.cwd();
  const endpoint = String(options.endpoint);
  const listenTarget = parseBrokerEndpoint(endpoint);
  const pidFile = options["pid-file"] ? path.resolve(options["pid-file"]) : null;
  const logFile = options["log-file"] ? path.resolve(options["log-file"]) : null;

  if (subcommand === "launch") {
    if (!pidFile || !logFile) {
      throw new Error("Broker launch requires --pid-file and --log-file.");
    }
    const scriptPath = Bun.fileURLToPath(import.meta.url);
    const log = Bun.file(logFile);
    const child = Bun.spawn(
      [process.execPath, scriptPath, "serve", "--endpoint", endpoint, "--cwd", cwd, "--pid-file", pidFile],
      {
        cwd,
        env: process.env,
        detached: true,
        stdin: "ignore",
        stdout: log,
        stderr: log
      }
    );
    child.unref();
    process.stdout.write(`${child.pid}\n`);
    return;
  }

  writePidFile(pidFile);

  const appClient = await CodexAppServerClient.connect(cwd, { disableBroker: true });
  let activeRequestSocket: Bun.Socket<BrokerSocketData> | null = null;
  let activeStreamSocket: Bun.Socket<BrokerSocketData> | null = null;
  let activeStreamThreadIds: Set<string> | null = null;
  let activeStreamTurn: ActiveStreamTurn | null = null;
  let shuttingDown = false;
  let brokerIdleTimer: ReturnType<typeof setInterval> | null = null;
  let lastActivityAt = Date.now();
  const sockets = new Set<Bun.Socket<BrokerSocketData>>();

  // Stamped on every real event rather than inferred on a timer, so an
  // operation that starts and finishes between two ticks still counts.
  function markBrokerActivity(): void {
    lastActivityAt = Date.now();
  }

  async function interruptOwnerlessTurn(turn: ActiveStreamTurn): Promise<void> {
    try {
      await appClient.request("turn/interrupt", turn);
    } catch {
      // The runtime may already have completed or exited.
    }
  }

  function clearSocketOwnership(socket: Bun.Socket<BrokerSocketData>): void {
    if (activeRequestSocket === socket) {
      activeRequestSocket = null;
    }
    if (activeStreamSocket === socket) {
      const ownerlessTurn = activeStreamTurn;
      activeStreamSocket = null;
      activeStreamThreadIds = null;
      activeStreamTurn = null;
      if (ownerlessTurn && !shuttingDown) {
        void interruptOwnerlessTurn(ownerlessTurn);
      }
    }
  }

  function routeNotification(message: AppServerNotification): void {
    const target = activeRequestSocket ?? activeStreamSocket;
    if (!target) {
      return;
    }
    send(target, message);
    if (message.method === "turn/completed" && activeStreamSocket === target) {
      const threadId = stringProperty(message.params, "threadId");
      if (!threadId || !activeStreamThreadIds || activeStreamThreadIds.has(threadId)) {
        activeStreamSocket = null;
        activeStreamThreadIds = null;
        activeStreamTurn = null;
        if (activeRequestSocket === target) {
          activeRequestSocket = null;
        }
      }
    }
  }

  async function shutdown(server: Bun.UnixSocketListener<BrokerSocketData>): Promise<void> {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    if (brokerIdleTimer) {
      clearInterval(brokerIdleTimer);
      brokerIdleTimer = null;
    }
    // Stop listening and remove the socket before tearing the child down.
    // Closing the app-server client first leaves the endpoint accepting and
    // answering `initialize` for as long as the child takes to exit, so a
    // client could connect to a dying broker and then fail its real request
    // with an error the caller does not retry.
    server.stop(true);
    if (listenTarget.kind === "unix") {
      removeQuietly(listenTarget.path);
    }
    for (const socket of sockets) {
      // end() flushes the kernel's buffer, not ours, so anything still queued
      // behind backpressure — including a shutdown ack sent moments ago — would
      // vanish. Offer it once more first. A peer that is still not reading gets
      // a closed socket rather than a truncated line, which is what it would
      // have had anyway.
      try {
        socket.data.writer.flush(socket);
      } catch {
        // The peer is already gone; nothing left to deliver.
      }
      socket.end();
    }
    await appClient.close().catch(() => {});
    removeQuietly(pidFile);
  }

  appClient.setNotificationHandler(routeNotification);

  let server: Bun.UnixSocketListener<BrokerSocketData>;

  async function handleSocketData(socket: Bun.Socket<BrokerSocketData>, chunk: Uint8Array): Promise<void> {
    let buffer = socket.data.buffer + socket.data.decoder.decode(chunk, { stream: true });
    let newlineIndex = buffer.indexOf("\n");
    while (newlineIndex !== -1) {
      const line = buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);
      newlineIndex = buffer.indexOf("\n");

      if (!line.trim()) {
        continue;
      }

      let message: JsonRpcMessage;
      try {
        const parsed: unknown = JSON.parse(line);
        if (!isJsonRpcMessage(parsed)) {
          throw new Error("Expected a valid JSON-RPC message.");
        }
        message = parsed;
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        send(socket, {
          id: null,
          error: buildJsonRpcError(-32700, `Invalid JSON: ${detail}`)
        });
        continue;
      }

      if (message.id !== undefined && message.method === "initialize") {
        send(socket, {
          id: message.id,
          result: {
            userAgent: "codex-companion-broker"
          }
        });
        continue;
      }

      if (message.method === "initialized" && message.id === undefined) {
        continue;
      }

      if (message.id !== undefined && message.method === "broker/shutdown") {
        send(socket, { id: message.id, result: {} });
        await shutdown(server);
        process.exit(0);
      }

      if (message.id === undefined) {
        continue;
      }

      const allowInterruptDuringActiveStream =
        isInterruptRequest(message) && activeStreamSocket && activeStreamSocket !== socket && !activeRequestSocket;

      if (
        ((activeRequestSocket && activeRequestSocket !== socket) ||
          (activeStreamSocket && activeStreamSocket !== socket)) &&
        !allowInterruptDuringActiveStream
      ) {
        send(socket, {
          id: message.id,
          error: buildJsonRpcError(BROKER_BUSY_RPC_CODE, "Shared Codex broker is busy.")
        });
        continue;
      }

      if (allowInterruptDuringActiveStream && message.method && isAppServerMethod(message.method)) {
        try {
          const result = await requestAppServer(appClient, message.method, message.params ?? {});
          send(socket, { id: message.id, result });
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          const rpcCode = toRpcCode(error);
          send(socket, {
            id: message.id,
            error: buildJsonRpcError(rpcCode, detail)
          });
        }
        continue;
      }

      if (!message.method || !isAppServerMethod(message.method)) {
        send(socket, {
          id: message.id,
          error: buildJsonRpcError(-32601, `Unsupported method: ${message.method ?? "<missing>"}`)
        });
        continue;
      }

      const isStreaming = STREAMING_METHODS.has(message.method);
      activeRequestSocket = socket;

      try {
        const result = await requestAppServer(appClient, message.method, message.params ?? {});
        send(socket, { id: message.id, result });
        if (isStreaming) {
          const streamTurn = buildActiveStreamTurn(message.method, message.params ?? {}, result);
          if (sockets.has(socket)) {
            activeStreamSocket = socket;
            activeStreamThreadIds = buildStreamThreadIds(message.method, message.params ?? {}, result);
            activeStreamTurn = streamTurn;
          } else if (streamTurn) {
            void interruptOwnerlessTurn(streamTurn);
          }
        }
        if (activeRequestSocket === socket) {
          activeRequestSocket = null;
        }
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        const rpcCode = toRpcCode(error);
        send(socket, {
          id: message.id,
          error: buildJsonRpcError(rpcCode, detail)
        });
        if (activeRequestSocket === socket) {
          activeRequestSocket = null;
        }
        if (activeStreamSocket === socket && !isStreaming) {
          activeStreamSocket = null;
        }
      }
    }
    socket.data.buffer = buffer;
  }

  server = Bun.listen<BrokerSocketData>({
    unix: listenTarget.path,
    socket: {
      open(socket) {
        socket.data = {
          buffer: "",
          decoder: new TextDecoder(),
          queue: Promise.resolve(),
          writer: new SocketWriter()
        };
        sockets.add(socket);
        markBrokerActivity();
      },
      drain(socket) {
        try {
          socket.data.writer.flush(socket);
        } catch {
          // Same as send(): the peer may have gone away mid-flush. The unwritten
          // tail stays queued, and the close handler discards it with the socket.
        }
      },
      data(socket, chunk) {
        markBrokerActivity();
        socket.data.queue = socket.data.queue
          .then(() => handleSocketData(socket, chunk))
          .catch(() => {
            socket.end();
          });
      },
      close(socket) {
        sockets.delete(socket);
        clearSocketOwnership(socket);
        // The disconnect ends an operation, so the idle window starts here.
        markBrokerActivity();
      },
      error(socket) {
        sockets.delete(socket);
        clearSocketOwnership(socket);
        markBrokerActivity();
      }
    }
  });

  const idleTimeoutMs = resolveIdleTimeoutMs(process.env[IDLE_TIMEOUT_ENV]);
  if (idleTimeoutMs > 0) {
    const isIdle = (): boolean =>
      sockets.size === 0 && activeStreamTurn === null && activeRequestSocket === null && activeStreamSocket === null;

    // Sampling state on the tick is not enough: clients connect per operation
    // and disconnect straight after, so any operation shorter than the interval
    // falls between two ticks and is never observed. A busy broker would then
    // look idle for its whole window and reap itself out from under a live
    // session. markBrokerActivity stamps the real events instead.
    const checkIntervalMs = Math.max(250, Math.min(IDLE_CHECK_INTERVAL_MS, idleTimeoutMs));
    const idleTimer = setInterval(() => {
      if (shuttingDown) {
        return;
      }
      if (!isIdle() || Date.now() - lastActivityAt < idleTimeoutMs) {
        return;
      }
      clearInterval(idleTimer);
      brokerIdleTimer = null;
      void shutdown(server).then(
        () => process.exit(0),
        () => process.exit(0)
      );
    }, checkIntervalMs);
    brokerIdleTimer = idleTimer;
  }

  void appClient.exitPromise.then(() => shutdown(server)).catch(() => shutdown(server));

  process.on("SIGTERM", async () => {
    await shutdown(server);
    process.exit(0);
  });

  process.on("SIGINT", async () => {
    await shutdown(server);
    process.exit(0);
  });
}

// Only run when executed directly, so tests can import the helpers above
// without starting a broker and exiting the test runner.
if (import.meta.main) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
