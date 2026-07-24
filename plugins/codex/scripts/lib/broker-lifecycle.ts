import { fs, os, path } from "./platform.ts";
import { createBrokerEndpoint, parseBrokerEndpoint } from "./broker-endpoint.ts";
import { resolveStateDir } from "./state.ts";
import { isRecord } from "./validation.ts";

export const PID_FILE_ENV = "CODEX_COMPANION_APP_SERVER_PID_FILE";
export const LOG_FILE_ENV = "CODEX_COMPANION_APP_SERVER_LOG_FILE";
const BROKER_STATE_FILE = "broker.json";

export interface BrokerSession {
  endpoint: string;
  pidFile?: string | null;
  logFile?: string | null;
  sessionDir?: string | null;
  pid?: number | null;
}

function isBrokerSession(value: unknown): value is BrokerSession {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.endpoint === "string" &&
    (value.pidFile === undefined || value.pidFile === null || typeof value.pidFile === "string") &&
    (value.logFile === undefined || value.logFile === null || typeof value.logFile === "string") &&
    (value.sessionDir === undefined || value.sessionDir === null || typeof value.sessionDir === "string") &&
    (value.pid === undefined ||
      value.pid === null ||
      (typeof value.pid === "number" && Number.isFinite(value.pid)))
  );
}

interface EnsureBrokerSessionOptions {
  createBrokerEndpoint?: (sessionDir: string) => string;
  env?: Record<string, string | undefined> | undefined;
  killProcess?: ((pid: number) => void) | null;
  scriptPath?: string;
  timeoutMs?: number;
}

interface TeardownBrokerSessionOptions {
  endpoint?: string | null;
  pidFile?: string | null;
  logFile?: string | null;
  sessionDir?: string | null;
  pid?: number | null;
  killProcess?: ((pid: number) => void) | null;
}

export function createBrokerSessionDir(prefix = "cxc-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export async function waitForBrokerEndpoint(endpoint: string, timeoutMs = 2000) {
  const target = parseBrokerEndpoint(endpoint);
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const ready = await new Promise<boolean>((resolve) => {
      Bun.connect({
        unix: target.path,
        socket: {
          open(socket) {
            socket.end();
            resolve(true);
          },
          data() {},
          error() {
            resolve(false);
          }
        }
      }).catch(() => resolve(false));
    });
    if (ready) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

export async function sendBrokerShutdown(endpoint: string) {
  const target = parseBrokerEndpoint(endpoint);
  const shutdown = new Promise<void>((resolve) => {
    Bun.connect({
      unix: target.path,
      socket: {
        open(socket) {
          socket.write(`${JSON.stringify({ id: 1, method: "broker/shutdown", params: {} })}\n`);
        },
        data(socket) {
          socket.end();
          resolve();
        },
        error() {
          resolve();
        },
        close() {
          resolve();
        }
      }
    }).catch(() => resolve());
  });
  await shutdown;
}

export function spawnBrokerProcess({
  scriptPath,
  cwd,
  endpoint,
  pidFile,
  logFile,
  env = process.env
}: {
  scriptPath: string;
  cwd: string;
  endpoint: string;
  pidFile: string;
  logFile: string;
  env?: Record<string, string | undefined>;
}) {
  const log = Bun.file(logFile);
  const child = Bun.spawn([process.execPath, scriptPath, "serve", "--endpoint", endpoint, "--cwd", cwd, "--pid-file", pidFile], {
    cwd,
    env,
    detached: true,
    stdin: "ignore",
    stdout: log,
    stderr: log
  });
  child.unref();
  return child;
}

function resolveBrokerStateFile(cwd: string) {
  return path.join(resolveStateDir(cwd), BROKER_STATE_FILE);
}

export function loadBrokerSession(cwd: string): BrokerSession | null {
  const stateFile = resolveBrokerStateFile(cwd);
  if (!fs.existsSync(stateFile)) {
    return null;
  }

  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    return isBrokerSession(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function saveBrokerSession(cwd: string, session: BrokerSession) {
  const stateDir = resolveStateDir(cwd);
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(resolveBrokerStateFile(cwd), `${JSON.stringify(session, null, 2)}\n`, "utf8");
}

export function clearBrokerSession(cwd: string) {
  const stateFile = resolveBrokerStateFile(cwd);
  if (fs.existsSync(stateFile)) {
    fs.unlinkSync(stateFile);
  }
}

async function isBrokerEndpointReady(endpoint: string | null | undefined) {
  if (!endpoint) {
    return false;
  }
  try {
    return await waitForBrokerEndpoint(endpoint, 150);
  } catch {
    return false;
  }
}

export async function ensureBrokerSession(cwd: string, options: EnsureBrokerSessionOptions = {}) {
  const existing = loadBrokerSession(cwd);
  if (existing && (await isBrokerEndpointReady(existing.endpoint))) {
    return existing;
  }

  if (existing) {
    teardownBrokerSession({
      endpoint: existing.endpoint ?? null,
      pidFile: existing.pidFile ?? null,
      logFile: existing.logFile ?? null,
      sessionDir: existing.sessionDir ?? null,
      pid: existing.pid ?? null,
      killProcess: options.killProcess ?? null
    });
    clearBrokerSession(cwd);
  }

  const sessionDir = createBrokerSessionDir();
  const endpointFactory = options.createBrokerEndpoint ?? createBrokerEndpoint;
  const endpoint = endpointFactory(sessionDir);
  const pidFile = path.join(sessionDir, "broker.pid");
  const logFile = path.join(sessionDir, "broker.log");
  const scriptPath =
    options.scriptPath ??
    Bun.fileURLToPath(new URL("../app-server-broker.ts", import.meta.url));

  const child = spawnBrokerProcess({
    scriptPath,
    cwd,
    endpoint,
    pidFile,
    logFile,
    env: options.env ?? process.env
  });

  const ready = await waitForBrokerEndpoint(endpoint, options.timeoutMs ?? 2000);
  if (!ready) {
    teardownBrokerSession({
      endpoint,
      pidFile,
      logFile,
      sessionDir,
      pid: child.pid ?? null,
      killProcess: options.killProcess ?? null
    });
    return null;
  }

  const session = {
    endpoint,
    pidFile,
    logFile,
    sessionDir,
    pid: child.pid ?? null
  };
  saveBrokerSession(cwd, session);
  return session;
}

export function teardownBrokerSession({
  endpoint = null,
  pidFile,
  logFile,
  sessionDir = null,
  pid = null,
  killProcess = null
}: TeardownBrokerSessionOptions) {
  if (typeof pid === "number" && Number.isFinite(pid) && killProcess) {
    try {
      killProcess(pid);
    } catch {
      // Ignore missing or already-exited broker processes.
    }
  }

  if (pidFile && fs.existsSync(pidFile)) {
    fs.unlinkSync(pidFile);
  }

  if (logFile && fs.existsSync(logFile)) {
    fs.unlinkSync(logFile);
  }

  if (endpoint) {
    try {
      const target = parseBrokerEndpoint(endpoint);
      if (target.kind === "unix" && fs.existsSync(target.path)) {
        fs.unlinkSync(target.path);
      }
    } catch {
      // Ignore malformed or already-removed broker endpoints during teardown.
    }
  }

  const sessionFile = pidFile || logFile;
  const resolvedSessionDir = sessionDir ?? (sessionFile ? path.dirname(sessionFile) : null);
  if (resolvedSessionDir && fs.existsSync(resolvedSessionDir)) {
    try {
      fs.rmdirSync(resolvedSessionDir);
    } catch {
      // Ignore non-empty or missing directories.
    }
  }
}
