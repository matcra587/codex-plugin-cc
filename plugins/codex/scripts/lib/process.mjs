export function runCommand(command, args = [], options = {}) {
  let result;
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
  const exceededBuffer =
    Number.isFinite(options.maxBuffer) &&
    (result.stdout?.byteLength > options.maxBuffer || result.stderr?.byteLength > options.maxBuffer);

  return {
    command,
    args,
    status: result.exitCode,
    signal: result.signalCode ?? null,
    stdout,
    stderr,
    error: exceededBuffer
      ? Object.assign(new Error(`Command output exceeded ${options.maxBuffer} bytes.`), { code: "ENOBUFS" })
      : null
  };
}

export function runCommandChecked(command, args = [], options = {}) {
  const result = runCommand(command, args, options);
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(formatCommandFailure(result));
  }
  return result;
}

function hasErrorCode(error, code) {
  return error instanceof Error && "code" in error && error.code === code;
}

export function binaryAvailable(command, versionArgs = ["--version"], options = {}) {
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

export function terminateProcessTree(pid, options = {}) {
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

export function formatCommandFailure(result) {
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
