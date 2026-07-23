export interface CommandOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
  input?: string | null;
  maxBuffer?: number;
  shell?: false;
  stdio?: "pipe" | "ignore" | "inherit";
}

export interface CommandResult {
  command: string;
  args: string[];
  status: number;
  signal: string | null;
  stdout: string;
  stderr: string;
  error: unknown;
}

export function runCommand(command: string, args: string[] = [], options: CommandOptions = {}): CommandResult {
  let result: any;
  try {
    const stdio = options.stdio ?? "pipe";
    result = Bun.spawnSync([command, ...args], {
      cwd: options.cwd,
      env: options.env,
      stdin:
        options.input == null
          ? stdio === "ignore"
            ? "ignore"
            : undefined
          : new TextEncoder().encode(options.input),
      stdout: stdio,
      stderr: stdio
    });
  } catch (error) {
    return {
      command,
      args,
      status: 0,
      signal: null,
      stdout: "",
      stderr: "",
      error
    };
  }

  const stdout = result.stdout?.toString() ?? "";
  const stderr = result.stderr?.toString() ?? "";
  const maxBuffer = options.maxBuffer;
  const exceededBuffer =
    typeof maxBuffer === "number" &&
    Number.isFinite(maxBuffer) &&
    (result.stdout?.byteLength > maxBuffer || result.stderr?.byteLength > maxBuffer);

  return {
    command,
    args,
    status: result.exitCode,
    signal: result.signalCode ?? null,
    stdout,
    stderr,
    error: exceededBuffer
      ? Object.assign(new Error(`Command output exceeded ${maxBuffer} bytes.`), { code: "ENOBUFS" })
      : null
  };
}

export function runCommandChecked(command: string, args: string[] = [], options: CommandOptions = {}): CommandResult {
  const result = runCommand(command, args, options);
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(formatCommandFailure(result));
  }
  return result;
}

function hasErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

export function binaryAvailable(command: string, versionArgs = ["--version"], options: CommandOptions = {}) {
  const result = runCommand(command, versionArgs, options);
  if (hasErrorCode(result.error, "ENOENT")) {
    return { available: false, detail: "not found" };
  }
  if (result.error) {
    return { available: false, detail: result.error instanceof Error ? result.error.message : String(result.error) };
  }
  if (result.status !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.status}`;
    return { available: false, detail };
  }
  return { available: true, detail: result.stdout.trim() || result.stderr.trim() || "ok" };
}

export function terminateProcessTree(
  pid: number,
  options: { killImpl?: (pid: number, signal: string) => void } = {}
) {
  if (!Number.isFinite(pid)) {
    return { attempted: false, delivered: false, method: null };
  }

  const killImpl = options.killImpl ?? process.kill.bind(process);

  try {
    killImpl(-pid, "SIGTERM");
    return { attempted: true, delivered: true, method: "process-group" };
  } catch (error) {
    if (!hasErrorCode(error, "ESRCH")) {
      try {
        killImpl(pid, "SIGTERM");
        return { attempted: true, delivered: true, method: "process" };
      } catch (innerError) {
        if (hasErrorCode(innerError, "ESRCH")) {
          return { attempted: true, delivered: false, method: "process" };
        }
        throw innerError;
      }
    }

    return { attempted: true, delivered: false, method: "process-group" };
  }
}

export function formatCommandFailure(result: CommandResult): string {
  const parts = [`${result.command} ${result.args.join(" ")}`.trim()];
  if (result.signal) {
    parts.push(`signal=${result.signal}`);
  } else {
    parts.push(`exit=${result.status}`);
  }
  const stderr = (result.stderr || "").trim();
  const stdout = (result.stdout || "").trim();
  if (stderr) {
    parts.push(stderr);
  } else if (stdout) {
    parts.push(stdout);
  }
  return parts.join(": ");
}
