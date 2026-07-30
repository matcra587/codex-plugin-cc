import { fs, os, path } from "./platform.ts";
import { createBrokerEndpoint, parseBrokerEndpoint } from "./broker-endpoint.ts";
import { ensureStateDir, resolveStateDir } from "./state.ts";
import { isRecord } from "./validation.ts";

export const PID_FILE_ENV = "CODEX_COMPANION_APP_SERVER_PID_FILE";
export const LOG_FILE_ENV = "CODEX_COMPANION_APP_SERVER_LOG_FILE";
const BROKER_STATE_FILE = "broker.json";
const BROKER_SESSION_PREFIX = "cxc-";
const PRIVATE_FILE_MODE = 0o600;
export const EXISTING_BROKER_PROBE_TIMEOUT_MS = 1000;

export interface BrokerSession {
  endpoint: string;
  pidFile?: string | null;
  logFile?: string | null;
  sessionDir?: string | null;
  pid?: number | null;
}

function isBrokerSession(value: unknown): value is Required<BrokerSession> {
  if (!isRecord(value)) {
    return false;
  }
  if (
    typeof value.endpoint !== "string" ||
    typeof value.pidFile !== "string" ||
    typeof value.logFile !== "string" ||
    typeof value.sessionDir !== "string" ||
    typeof value.pid !== "number" ||
    !Number.isSafeInteger(value.pid) ||
    value.pid <= 1
  ) {
    return false;
  }

  const sessionDir = path.resolve(value.sessionDir);
  const relativeSessionDir = path.relative(path.resolve(os.tmpdir()), sessionDir);
  if (
    !relativeSessionDir ||
    relativeSessionDir === ".." ||
    relativeSessionDir.startsWith(`..${path.sep}`) ||
    relativeSessionDir.includes(path.sep) ||
    !path.basename(sessionDir).startsWith(BROKER_SESSION_PREFIX)
  ) {
    return false;
  }

  let endpointPath: string;
  try {
    endpointPath = path.resolve(parseBrokerEndpoint(value.endpoint).path);
  } catch {
    return false;
  }

  return (
    endpointPath === path.join(sessionDir, "broker.sock") &&
    path.resolve(value.pidFile) === path.join(sessionDir, "broker.pid") &&
    path.resolve(value.logFile) === path.join(sessionDir, "broker.log")
  );
}

interface EnsureBrokerSessionOptions {
  createBrokerEndpoint?: (sessionDir: string) => string;
  env?: Record<string, string | undefined> | undefined;
  existingProbeTimeoutMs?: number;
  killProcess?: ((pid: number) => void) | null;
  scriptPath?: string;
  timeoutMs?: number;
  waitForBrokerEndpoint?: typeof waitForBrokerEndpoint;
}

interface TeardownBrokerSessionOptions {
  endpoint?: string | null;
  pidFile?: string | null;
  logFile?: string | null;
  sessionDir?: string | null;
  pid?: number | null;
  killProcess?: ((pid: number) => void) | null;
}

export function createBrokerSessionDir(prefix = BROKER_SESSION_PREFIX) {
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
  const launched = Bun.spawnSync(
    [
      process.execPath,
      scriptPath,
      "launch",
      "--endpoint",
      endpoint,
      "--cwd",
      cwd,
      "--pid-file",
      pidFile,
      "--log-file",
      logFile
    ],
    {
      cwd,
      env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe"
    }
  );
  const detail = launched.stderr.toString().trim();
  if (launched.exitCode !== 0) {
    throw new Error(`Unable to launch the shared Codex broker${detail ? `: ${detail}` : "."}`);
  }
  const pid = Number(launched.stdout.toString().trim());
  if (!Number.isSafeInteger(pid) || pid <= 1) {
    throw new Error("Broker launcher did not return a valid process id.");
  }
  return { pid };
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
  if (!isBrokerSession(session)) {
    throw new Error("Refusing to persist an unsafe broker session.");
  }
  ensureStateDir(cwd);
  fs.writeFileSync(resolveBrokerStateFile(cwd), `${JSON.stringify(session, null, 2)}\n`, {
    encoding: "utf8",
    mode: PRIVATE_FILE_MODE
  });
}

export function clearBrokerSession(cwd: string) {
  const stateFile = resolveBrokerStateFile(cwd);
  if (fs.existsSync(stateFile)) {
    fs.unlinkSync(stateFile);
  }
}

async function isBrokerEndpointReady(
  endpoint: string | null | undefined,
  waitForEndpoint: typeof waitForBrokerEndpoint,
  timeoutMs: number
) {
  if (!endpoint) {
    return false;
  }
  try {
    return await waitForEndpoint(endpoint, timeoutMs);
  } catch {
    return false;
  }
}

export async function ensureBrokerSession(cwd: string, options: EnsureBrokerSessionOptions = {}) {
  const waitForEndpoint = options.waitForBrokerEndpoint ?? waitForBrokerEndpoint;
  const existing = loadBrokerSession(cwd);
  if (
    existing &&
    (await isBrokerEndpointReady(
      existing.endpoint,
      waitForEndpoint,
      options.existingProbeTimeoutMs ?? EXISTING_BROKER_PROBE_TIMEOUT_MS
    ))
  ) {
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
  const scriptPath = options.scriptPath ?? Bun.fileURLToPath(new URL("../app-server-broker.ts", import.meta.url));

  const child = spawnBrokerProcess({
    scriptPath,
    cwd,
    endpoint,
    pidFile,
    logFile,
    env: options.env ?? process.env
  });

  const ready = await waitForEndpoint(endpoint, options.timeoutMs ?? 2000);
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
