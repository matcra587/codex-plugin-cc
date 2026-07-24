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
      ...(options.env === undefined ? {} : { env: options.env }),
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

export function initGitRepo(cwd: string): void {
  run("git", ["init", "-b", "main"], { cwd });
  run("git", ["config", "user.name", "Codex Plugin Tests"], { cwd });
  run("git", ["config", "user.email", "tests@example.com"], { cwd });
  run("git", ["config", "commit.gpgsign", "false"], { cwd });
  run("git", ["config", "tag.gpgsign", "false"], { cwd });
}
