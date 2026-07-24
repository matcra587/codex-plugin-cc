#!/usr/bin/env bun

import { fs, path } from "./lib/platform.ts";

import { parseArgs } from "./lib/args.ts";
import { BROKER_BUSY_RPC_CODE, CodexAppServerClient } from "./lib/app-server.ts";
import { parseBrokerEndpoint } from "./lib/broker-endpoint.ts";
import { isJsonRpcMessage, type JsonRpcMessage } from "./lib/json-rpc.ts";
import { isRecord } from "./lib/validation.ts";
import type {
  AppServerMethod,
  AppServerNotification,
  AppServerRequestParams
} from "./lib/app-server-protocol";

type AppServerClient = Awaited<ReturnType<typeof CodexAppServerClient.connect>>;

interface BrokerSocketData {
  buffer: string;
  decoder: TextDecoder;
  queue: Promise<void>;
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

function stringProperty(value: unknown, property: string): string | null {
  return isRecord(value) && typeof value[property] === "string" ? value[property] : null;
}

function isAppServerMethod(method: string): method is AppServerMethod {
  return APP_SERVER_METHODS.has(method);
}

function requestAppServer(
  client: AppServerClient,
  method: AppServerMethod,
  params: unknown
): Promise<unknown> {
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

function buildJsonRpcError(code: number, message: string, data?: unknown) {
  return data === undefined ? { code, message } : { code, message, data };
}

function send(socket: Bun.Socket<BrokerSocketData>, message: unknown): void {
  try {
    socket.write(`${JSON.stringify(message)}\n`);
  } catch {
    // The peer may have closed between routing and delivery.
  }
}

function isInterruptRequest(message: JsonRpcMessage): boolean {
  return message?.method === "turn/interrupt";
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
  if (subcommand !== "serve") {
    throw new Error("Usage: bun scripts/app-server-broker.ts serve --endpoint <value> [--cwd <path>] [--pid-file <path>]");
  }

  const { options } = parseArgs(argv, {
    valueOptions: ["cwd", "pid-file", "endpoint"]
  });

  if (!options.endpoint) {
    throw new Error("Missing required --endpoint.");
  }

  const cwd = options.cwd ? path.resolve(process.cwd(), options.cwd) : process.cwd();
  const endpoint = String(options.endpoint);
  const listenTarget = parseBrokerEndpoint(endpoint);
  const pidFile = options["pid-file"] ? path.resolve(options["pid-file"]) : null;
  writePidFile(pidFile);

  const appClient = await CodexAppServerClient.connect(cwd, { disableBroker: true });
  let activeRequestSocket: Bun.Socket<BrokerSocketData> | null = null;
  let activeStreamSocket: Bun.Socket<BrokerSocketData> | null = null;
  let activeStreamThreadIds: Set<string> | null = null;
  const sockets = new Set<Bun.Socket<BrokerSocketData>>();

  function clearSocketOwnership(socket: Bun.Socket<BrokerSocketData>): void {
    if (activeRequestSocket === socket) {
      activeRequestSocket = null;
    }
    if (activeStreamSocket === socket) {
      activeStreamSocket = null;
      activeStreamThreadIds = null;
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
        if (activeRequestSocket === target) {
          activeRequestSocket = null;
        }
      }
    }
  }

  async function shutdown(server: Bun.UnixSocketListener<BrokerSocketData>): Promise<void> {
    for (const socket of sockets) {
      socket.end();
    }
    await appClient.close().catch(() => {});
    server.stop(true);
    if (listenTarget.kind === "unix" && fs.existsSync(listenTarget.path)) {
      fs.unlinkSync(listenTarget.path);
    }
    if (pidFile && fs.existsSync(pidFile)) {
      fs.unlinkSync(pidFile);
    }
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
        ((activeRequestSocket && activeRequestSocket !== socket) || (activeStreamSocket && activeStreamSocket !== socket)) &&
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
          const rpcCode = error instanceof Error && "rpcCode" in error ? Number(error.rpcCode) : -32000;
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
          activeStreamSocket = socket;
          activeStreamThreadIds = buildStreamThreadIds(message.method, message.params ?? {}, result);
        }
        if (activeRequestSocket === socket) {
          activeRequestSocket = null;
        }
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        const rpcCode = error instanceof Error && "rpcCode" in error ? Number(error.rpcCode) : -32000;
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
          queue: Promise.resolve()
        };
        sockets.add(socket);
      },
      data(socket, chunk) {
        socket.data.queue = socket.data.queue
          .then(() => handleSocketData(socket, chunk))
          .catch(() => {
            socket.end();
          });
      },
      close(socket) {
        sockets.delete(socket);
        clearSocketOwnership(socket);
      },
      error(socket) {
        sockets.delete(socket);
        clearSocketOwnership(socket);
      }
    }
  });

  process.on("SIGTERM", async () => {
    await shutdown(server);
    process.exit(0);
  });

  process.on("SIGINT", async () => {
    await shutdown(server);
    process.exit(0);
  });
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
