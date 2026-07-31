import { fs, os, path } from "../plugins/codex/scripts/lib/platform.ts";

interface RunOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
  input?: string | null;
  shell?: false;
}

export interface RunResult {
  status: number;
  signal: string | null;
  stdout: string;
  stderr: string;
  error: unknown;
}

export function makeTempDir(prefix = "codex-plugin-test-"): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function writeExecutable(filePath: string, source: string): void {
  fs.writeFileSync(filePath, source, { encoding: "utf8", mode: 0o755 });
}

export function run(command: string, args: string[], options: RunOptions = {}): RunResult {
  try {
    const result = Bun.spawnSync([command, ...args], {
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      env: options.env ?? process.env,
      stdin: options.input == null ? undefined : new TextEncoder().encode(options.input),
      stdout: "pipe",
      stderr: "pipe"
    });
    return {
      status: result.exitCode,
      signal: result.signalCode ?? null,
      stdout: result.stdout.toString(),
      stderr: result.stderr.toString(),
      error: null
    };
  } catch (error) {
    return {
      status: 0,
      signal: null,
      stdout: "",
      stderr: "",
      error
    };
  }
}

// An orphan does not always reparent to PID 1. Any ancestor can claim
// PR_SET_CHILD_SUBREAPER, and WSL2's /init does exactly that, so a detached
// broker there lands on the Relay process rather than on init. Measure where
// this system actually sends an orphan instead of assuming.
let cachedReaperPid: number | null = null;
export function detectOrphanReaperPid(): number {
  if (cachedReaperPid !== null) {
    return cachedReaperPid;
  }
  // The shell exits the moment it has backgrounded the sleep, orphaning it.
  const spawned = run("sh", ["-c", "sleep 5 & echo $!"]);
  const orphanPid = Number(spawned.stdout.trim());
  if (!Number.isInteger(orphanPid) || orphanPid <= 0) {
    throw new Error(`Unable to spawn an orphan to probe the reaper: ${spawned.stderr}`);
  }
  try {
    // The shell has already been waited on, so the kernel reparented the sleep
    // before spawnSync returned; one read is enough.
    const parent = Number(run("ps", ["-o", "ppid=", "-p", String(orphanPid)]).stdout.trim());
    if (!Number.isInteger(parent) || parent <= 0) {
      throw new Error(`Unable to read the orphan's new parent (pid ${orphanPid}).`);
    }
    cachedReaperPid = parent;
    return parent;
  } finally {
    try {
      process.kill(orphanPid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
}

export function initGitRepo(cwd: string): void {
  run("git", ["init", "-b", "main"], { cwd });
  run("git", ["config", "user.name", "Codex Plugin Tests"], { cwd });
  run("git", ["config", "user.email", "tests@example.com"], { cwd });
  run("git", ["config", "commit.gpgsign", "false"], { cwd });
  run("git", ["config", "tag.gpgsign", "false"], { cwd });
}
