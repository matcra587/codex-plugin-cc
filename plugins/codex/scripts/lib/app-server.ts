import type {
  AppServerMethod,
  AppServerNotification,
  AppServerNotificationHandler,
  AppServerRequestParams,
  AppServerResponse,
  ClientInfo,
  CodexAppServerClientOptions,
  InitializeCapabilities
} from "./app-server-protocol";

import { parseBrokerEndpoint } from "./broker-endpoint.ts";
import { ensureBrokerSession, loadBrokerSession } from "./broker-lifecycle.ts";
import { isJsonRpcMessage, type JsonRpcMessage } from "./json-rpc.ts";
import { fs } from "./platform.ts";

class ProtocolError extends Error {
  data?: unknown;
  rpcCode?: number;

  constructor(message: string) {
    super(message);
    this.name = "ProtocolError";
  }
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
  method: AppServerMethod;
}

const PLUGIN_MANIFEST_URL = new URL("../../.claude-plugin/plugin.json", import.meta.url);
const pluginManifest: unknown = JSON.parse(fs.readFileSync(PLUGIN_MANIFEST_URL, "utf8"));
const pluginVersion =
  pluginManifest !== null &&
  typeof pluginManifest === "object" &&
  "version" in pluginManifest &&
  typeof pluginManifest.version === "string"
    ? pluginManifest.version
    : "0.0.0";

export const BROKER_ENDPOINT_ENV = "CODEX_COMPANION_APP_SERVER_ENDPOINT";
export const BROKER_BUSY_RPC_CODE = -32001;

const DEFAULT_CLIENT_INFO: ClientInfo = {
  title: "Codex Plugin",
  name: "Claude Code",
  version: pluginVersion
};

const DEFAULT_CAPABILITIES: InitializeCapabilities = {
  experimentalApi: false,
  requestAttestation: false,
  optOutNotificationMethods: [
    "item/agentMessage/delta",
    "item/reasoning/summaryTextDelta",
    "item/reasoning/summaryPartAdded",
    "item/reasoning/textDelta"
  ]
};

function buildJsonRpcError(code: number, message: string, data?: unknown) {
  return data === undefined ? { code, message } : { code, message, data };
}

function createProtocolError(message: string, data?: { code?: number } & Record<string, unknown>): ProtocolError {
  const error = new ProtocolError(message);
  error.data = data;
  if (data?.code !== undefined) {
    error.rpcCode = data.code;
  }
  return error;
}

async function consumeStream(stream: ReadableStream<Uint8Array>, onChunk: (chunk: string) => void): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      const tail = decoder.decode();
      if (tail) {
        onChunk(tail);
      }
      return;
    }
    onChunk(decoder.decode(value, { stream: true }));
  }
}

class AppServerClientBase {
  closed = false;
  readonly cwd: string;
  readonly options: CodexAppServerClientOptions;
  readonly pending = new Map<number, PendingRequest>();
  nextId = 1;
  stderr = "";
  exitError: unknown = null;
  notificationHandler: AppServerNotificationHandler | null = null;
  lineBuffer = "";
  transport: "unknown" | "direct" | "broker" = "unknown";
  readonly exitPromise: Promise<void>;
  resolveExit!: () => void;
  exitResolved = false;

  constructor(cwd: string, options: CodexAppServerClientOptions = {}) {
    this.cwd = cwd;
    this.options = options;

    this.exitPromise = new Promise((resolve) => {
      this.resolveExit = resolve;
    });
  }

  setNotificationHandler(handler: AppServerNotificationHandler | null) {
    this.notificationHandler = handler;
  }

  request<M extends AppServerMethod>(method: M, params: AppServerRequestParams<M>): Promise<AppServerResponse<M>> {
    if (this.closed) {
      throw new Error("codex app-server client is closed.");
    }

    const id = this.nextId;
    this.nextId += 1;

    return new Promise<AppServerResponse<M>>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, method });
      this.sendMessage({ id, method, params });
    });
  }

  notify(method: string, params: unknown = {}) {
    if (this.closed) {
      return;
    }
    this.sendMessage({ method, params });
  }

  isClosed() {
    return this.closed;
  }

  markClosed() {
    this.closed = true;
  }

  handleChunk(chunk: string) {
    this.lineBuffer += chunk;
    let newlineIndex = this.lineBuffer.indexOf("\n");
    while (newlineIndex !== -1) {
      const line = this.lineBuffer.slice(0, newlineIndex);
      this.lineBuffer = this.lineBuffer.slice(newlineIndex + 1);
      this.handleLine(line);
      newlineIndex = this.lineBuffer.indexOf("\n");
    }
  }

  handleLine(line: string) {
    if (!line.trim()) {
      return;
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
      this.handleExit(createProtocolError(`Failed to parse codex app-server JSONL: ${detail}`, { line }));
      return;
    }

    if (message.id !== undefined && message.method) {
      this.handleServerRequest(message);
      return;
    }

    if (typeof message.id === "number") {
      const pending = this.pending.get(message.id);
      if (!pending) {
        return;
      }
      this.pending.delete(message.id);

      if (message.error) {
        pending.reject(
          createProtocolError(message.error.message ?? `codex app-server ${pending.method} failed.`, message.error)
        );
      } else {
        pending.resolve(message.result ?? {});
      }
      return;
    }

    if (message.method && this.notificationHandler) {
      // Codex generates static notification types but not runtime schemas. The
      // JSON-RPC envelope is validated above; Codex remains authoritative for
      // method-specific payload validation.
      this.notificationHandler(message as AppServerNotification);
    }
  }

  handleServerRequest(message: JsonRpcMessage) {
    this.sendMessage({
      id: message.id,
      error: buildJsonRpcError(-32601, `Unsupported server request: ${message.method}`)
    });
  }

  handleExit(error?: unknown) {
    if (this.exitResolved) {
      return;
    }

    this.exitResolved = true;
    this.exitError = error ?? null;

    for (const pending of this.pending.values()) {
      pending.reject(this.exitError ?? new Error("codex app-server connection closed."));
    }
    this.pending.clear();
    this.resolveExit();
  }

  sendMessage(_message: unknown): void {
    throw new Error("sendMessage must be implemented by subclasses.");
  }
}

class SpawnedCodexAppServerClient extends AppServerClientBase {
  proc: Bun.PipedSubprocess | null = null;

  constructor(cwd: string, options: CodexAppServerClientOptions = {}) {
    super(cwd, options);
    this.transport = "direct";
  }

  async initialize() {
    const proc = Bun.spawn(["codex", "app-server"], {
      cwd: this.cwd,
      env: this.options.env ?? process.env,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe"
    });
    this.proc = proc;

    void consumeStream(proc.stdout, (chunk) => {
      this.handleChunk(chunk);
    }).catch((error) => {
      this.handleExit(error);
    });
    void consumeStream(proc.stderr, (chunk) => {
      this.stderr += chunk;
    }).catch((error) => {
      this.handleExit(error);
    });

    void proc.exited.then((code: number) => {
      const stderr = this.stderr.trim();
      const detail =
        code === 0
          ? null
          : createProtocolError(
              `codex app-server exited unexpectedly (${proc.signalCode ? `signal ${proc.signalCode}` : `exit ${code}`}).${stderr ? `\n${stderr}` : ""}`
            );
      this.handleExit(detail);
    });

    await this.request("initialize", {
      clientInfo: this.options.clientInfo ?? DEFAULT_CLIENT_INFO,
      capabilities: this.options.capabilities ?? DEFAULT_CAPABILITIES
    });
    this.notify("initialized", {});
  }

  async close() {
    if (this.isClosed()) {
      await this.exitPromise;
      return;
    }

    this.markClosed();

    if (this.proc && this.proc.exitCode === null) {
      this.proc.stdin.end();
      setTimeout(() => {
        if (this.proc && this.proc.exitCode === null) {
          this.proc.kill("SIGTERM");
        }
      }, 50).unref?.();
    }

    await this.exitPromise;
  }

  override sendMessage(message: unknown) {
    const line = `${JSON.stringify(message)}\n`;
    const stdin = this.proc?.stdin;
    if (!stdin) {
      throw new Error("codex app-server stdin is not available.");
    }
    stdin.write(line);
    stdin.flush();
  }
}

class BrokerCodexAppServerClient extends AppServerClientBase {
  readonly endpoint: string;
  socket: Bun.Socket<AppServerClientBase> | null = null;

  constructor(cwd: string, options: CodexAppServerClientOptions & { brokerEndpoint: string }) {
    super(cwd, options);
    this.transport = "broker";
    this.endpoint = options.brokerEndpoint;
  }

  async initialize() {
    const target = parseBrokerEndpoint(this.endpoint);
    const client = this;
    const decoder = new TextDecoder();
    this.socket = await new Promise<Bun.Socket<AppServerClientBase>>((resolve, reject) => {
      Bun.connect<AppServerClientBase>({
        unix: target.path,
        data: client,
        socket: {
          open(socket) {
            resolve(socket);
          },
          data(_socket, chunk) {
            client.handleChunk(decoder.decode(chunk, { stream: true }));
          },
          error(_socket, error) {
            if (!client.exitResolved) {
              reject(error);
            }
            client.handleExit(error);
          },
          close() {
            client.handleExit(client.exitError);
          }
        }
      }).catch((error) => {
        reject(error);
        client.handleExit(error);
      });
    });

    await this.request("initialize", {
      clientInfo: this.options.clientInfo ?? DEFAULT_CLIENT_INFO,
      capabilities: this.options.capabilities ?? DEFAULT_CAPABILITIES
    });
    this.notify("initialized", {});
  }

  async close() {
    if (this.isClosed()) {
      await this.exitPromise;
      return;
    }

    this.markClosed();
    if (this.socket) {
      this.socket.end();
    }
    await this.exitPromise;
  }

  override sendMessage(message: unknown) {
    const line = `${JSON.stringify(message)}\n`;
    const socket = this.socket;
    if (!socket) {
      throw new Error("codex app-server broker connection is not connected.");
    }
    socket.write(line);
  }
}

// The factory that picks between the broker-backed and spawned clients.
// Callers depend on the `CodexAppServerClient.connect` name, including two
// `Awaited<ReturnType<typeof CodexAppServerClient.connect>>` type aliases.
// biome-ignore lint/complexity/noStaticOnlyClass: named factory, see above
export class CodexAppServerClient {
  static async connect(cwd: string, options: CodexAppServerClientOptions = {}) {
    let brokerEndpoint: string | null = null;
    if (!options.disableBroker) {
      brokerEndpoint =
        options.brokerEndpoint ?? options.env?.[BROKER_ENDPOINT_ENV] ?? process.env[BROKER_ENDPOINT_ENV] ?? null;
      if (!brokerEndpoint && options.reuseExistingBroker) {
        brokerEndpoint = loadBrokerSession(cwd)?.endpoint ?? null;
      }
      if (!brokerEndpoint && !options.reuseExistingBroker) {
        const brokerSession = await ensureBrokerSession(cwd, { env: options.env });
        brokerEndpoint = brokerSession?.endpoint ?? null;
      }
    }
    const client = brokerEndpoint
      ? new BrokerCodexAppServerClient(cwd, { ...options, brokerEndpoint })
      : new SpawnedCodexAppServerClient(cwd, options);
    await client.initialize();
    return client;
  }
}
