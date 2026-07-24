import { fs, os, path } from "./platform.ts";

import { isJobRecord, type CompanionConfig, type CompanionState, type JobPatch, type JobRecord } from "./domain.ts";
import { isProcessAlive } from "./process.ts";
import { isRecord } from "./validation.ts";
import { resolveWorkspaceRoot } from "./workspace.ts";

const STATE_VERSION = 1;
const PLUGIN_DATA_ENV = "CLAUDE_PLUGIN_DATA";
const XDG_STATE_HOME_ENV = "XDG_STATE_HOME";
const FALLBACK_STATE_DIR_NAME = "codex-plugin-cc";
const STATE_FILE_NAME = "state.json";
const STATE_LOCK_FILE_NAME = ".state.lock";
const JOBS_DIR_NAME = "jobs";
const MAX_JOBS = 50;
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const SAFE_JOB_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
const LOCK_RETRY_INTERVAL_MS = 10;
const LOCK_TIMEOUT_MS = 5_000;

function nowIso(): string {
  return new Date().toISOString();
}

function defaultState(): CompanionState {
  return {
    version: STATE_VERSION,
    config: {
      stopReviewGate: false
    },
    jobs: []
  };
}

export function resolveStateDir(cwd: string): string {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  let canonicalWorkspaceRoot = workspaceRoot;
  try {
    canonicalWorkspaceRoot = fs.realpathSync.native(workspaceRoot);
  } catch {
    canonicalWorkspaceRoot = workspaceRoot;
  }

  const slugSource = path.basename(workspaceRoot) || "workspace";
  const slug = slugSource.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "workspace";
  const hash = new Bun.CryptoHasher("sha256").update(canonicalWorkspaceRoot).digest("hex").slice(0, 16);
  const pluginDataDir = process.env[PLUGIN_DATA_ENV];
  const xdgStateHome = process.env[XDG_STATE_HOME_ENV];
  const userStateHome = xdgStateHome || path.join(os.homedir(), ".local", "state");
  const stateRoot = pluginDataDir
    ? path.join(pluginDataDir, "state")
    : path.join(userStateHome, FALLBACK_STATE_DIR_NAME);
  return path.join(stateRoot, `${slug}-${hash}`);
}

export function resolveStateFile(cwd: string): string {
  return path.join(resolveStateDir(cwd), STATE_FILE_NAME);
}

export function resolveJobsDir(cwd: string): string {
  return path.join(resolveStateDir(cwd), JOBS_DIR_NAME);
}

export function ensureStateDir(cwd: string): void {
  fs.mkdirSync(resolveStateDir(cwd), { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  fs.mkdirSync(resolveJobsDir(cwd), { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
}

function resolveStateLockFile(cwd: string): string {
  return path.join(resolveStateDir(cwd), STATE_LOCK_FILE_NAME);
}

function isSafeJobId(jobId: string): boolean {
  return SAFE_JOB_ID_PATTERN.test(jobId) && jobId !== "." && jobId !== "..";
}

function isPathInside(parent: string, candidate: string): boolean {
  if (!path.isAbsolute(candidate)) {
    return false;
  }
  const relativePath = path.relative(path.resolve(parent), path.resolve(candidate));
  return (
    relativePath.length > 0 &&
    relativePath !== ".." &&
    !relativePath.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relativePath)
  );
}

function isPersistedJobRecord(cwd: string, value: unknown): value is JobRecord {
  if (!isJobRecord(value) || !isSafeJobId(value.id)) {
    return false;
  }
  return value.logFile == null || isPathInside(resolveJobsDir(cwd), value.logFile);
}

export function loadState(cwd: string): CompanionState {
  const stateFile = resolveStateFile(cwd);
  if (!fs.existsSync(stateFile)) {
    return defaultState();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  } catch (cause) {
    throw new Error(`Unable to load persisted state from ${stateFile}.`, { cause });
  }

  if (!isRecord(parsed)) {
    throw new Error(`Unable to load persisted state from ${stateFile}: expected a JSON object.`);
  }
  const parsedConfig = isRecord(parsed.config) ? parsed.config : {};
  const config = {
    ...parsedConfig,
    stopReviewGate:
      typeof parsedConfig.stopReviewGate === "boolean"
        ? parsedConfig.stopReviewGate
        : defaultState().config.stopReviewGate
  } satisfies CompanionConfig;
  return {
    version: typeof parsed.version === "number" ? parsed.version : STATE_VERSION,
    config,
    jobs: Array.isArray(parsed.jobs)
      ? parsed.jobs.filter((job) => isPersistedJobRecord(cwd, job))
      : []
  };
}

function pruneJobs(jobs: readonly JobRecord[]): JobRecord[] {
  return [...jobs]
    .sort((left, right) => String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? "")))
    .slice(0, MAX_JOBS);
}

function removeFileIfExists(filePath: string | null | undefined): void {
  if (!filePath || !fs.existsSync(filePath)) {
    return;
  }
  try {
    fs.unlinkSync(filePath);
  } catch (error) {
    if (fs.existsSync(filePath)) {
      throw error;
    }
  }
}

function writeJsonAtomic(filePath: string, value: unknown): void {
  const temporaryFile = `${filePath}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    fs.writeFileSync(temporaryFile, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf8",
      mode: PRIVATE_FILE_MODE
    });
    fs.renameSync(temporaryFile, filePath);
  } finally {
    removeFileIfExists(temporaryFile);
  }
}

function withStateLock<Result>(cwd: string, action: () => Result): Result {
  ensureStateDir(cwd);
  const lockFile = resolveStateLockFile(cwd);
  const startedAt = Date.now();

  let releaseLock = fs.acquireFileLockSync(lockFile, PRIVATE_FILE_MODE);
  while (releaseLock == null) {
    if (Date.now() - startedAt >= LOCK_TIMEOUT_MS) {
      throw new Error(`Timed out waiting for state lock ${lockFile}.`);
    }
    Bun.sleepSync(LOCK_RETRY_INTERVAL_MS);
    releaseLock = fs.acquireFileLockSync(lockFile, PRIVATE_FILE_MODE);
  }

  try {
    return action();
  } finally {
    releaseLock();
  }
}

function saveStateUnlocked(
  cwd: string,
  state: CompanionState,
  previousJobs: readonly JobRecord[]
): CompanionState {
  ensureStateDir(cwd);
  const nextJobs = pruneJobs((state.jobs ?? []).filter((job) => isPersistedJobRecord(cwd, job)));
  const nextState = {
    version: STATE_VERSION,
    config: {
      ...defaultState().config,
      ...(state.config ?? {})
    },
    jobs: nextJobs
  };

  const retainedIds = new Set(nextJobs.map((job) => job.id));
  for (const job of previousJobs) {
    if (retainedIds.has(job.id)) {
      continue;
    }
    removeJobFile(resolveJobFile(cwd, job.id));
    removeFileIfExists(job.logFile);
  }

  writeJsonAtomic(resolveStateFile(cwd), nextState);
  return nextState;
}

function readTerminalJobFile(cwd: string, job: JobRecord): JobRecord | null {
  const jobFile = resolveJobFile(cwd, job.id);
  if (!fs.existsSync(jobFile)) {
    return null;
  }

  try {
    const storedJob = readJobFile(jobFile);
    const isTerminal =
      storedJob.status === "completed" ||
      storedJob.status === "failed" ||
      storedJob.status === "cancelled";
    return storedJob.id === job.id && isTerminal && isPersistedJobRecord(cwd, storedJob)
      ? storedJob
      : null;
  } catch {
    return null;
  }
}

export function saveState(cwd: string, state: CompanionState): CompanionState {
  return withStateLock(cwd, () =>
    saveStateUnlocked(cwd, state, loadState(cwd).jobs)
  );
}

export function updateState(cwd: string, mutate: (state: CompanionState) => void): CompanionState {
  return withStateLock(cwd, () => {
    const state = loadState(cwd);
    const previousJobs = [...state.jobs];
    mutate(state);
    return saveStateUnlocked(cwd, state, previousJobs);
  });
}

export function generateJobId(prefix = "job"): string {
  const random = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${Date.now().toString(36)}-${random}`;
}

export function upsertJob(cwd: string, jobPatch: JobPatch): CompanionState {
  return updateState(cwd, (state) => {
    const timestamp = nowIso();
    const existingIndex = state.jobs.findIndex((job) => job.id === jobPatch.id);
    if (existingIndex === -1) {
      state.jobs.unshift({
        createdAt: timestamp,
        updatedAt: timestamp,
        ...jobPatch
      });
      return;
    }
    state.jobs[existingIndex] = {
      ...state.jobs[existingIndex],
      ...jobPatch,
      updatedAt: timestamp
    };
  });
}

export function listJobs(cwd: string): JobRecord[] {
  return withStateLock(cwd, () => {
    const state = loadState(cwd);
    const timestamp = nowIso();
    let changed = false;

    for (const job of state.jobs) {
      const isActive = job.status === "queued" || job.status === "running";
      if (!isActive || job.pid == null || isProcessAlive(job.pid)) {
        continue;
      }

      const terminalJob = readTerminalJobFile(cwd, job);
      if (terminalJob) {
        Object.assign(job, terminalJob, { pid: null });
        changed = true;
        continue;
      }

      Object.assign(job, {
        status: "failed",
        phase: "failed",
        pid: null,
        completedAt: timestamp,
        updatedAt: timestamp,
        errorMessage: "Worker process is no longer running."
      } satisfies Partial<JobRecord>);
      const jobFile = resolveJobFile(cwd, job.id);
      if (fs.existsSync(jobFile)) {
        writeJsonAtomic(jobFile, job);
      }
      changed = true;
    }

    return changed ? saveStateUnlocked(cwd, state, state.jobs).jobs : state.jobs;
  });
}

export function setConfig<Key extends keyof CompanionConfig>(
  cwd: string,
  key: Key,
  value: CompanionConfig[Key]
): CompanionState {
  return updateState(cwd, (state) => {
    state.config = {
      ...state.config,
      [key]: value
    };
  });
}

export function getConfig(cwd: string): CompanionConfig {
  return loadState(cwd).config;
}

export function writeJobFile(cwd: string, jobId: string, payload: unknown): string {
  if (!isSafeJobId(jobId)) {
    throw new Error(`Unsafe job id: ${jobId}`);
  }
  ensureStateDir(cwd);
  const jobFile = resolveJobFile(cwd, jobId);
  writeJsonAtomic(jobFile, payload);
  return jobFile;
}

export function readJobFile(jobFile: string): JobRecord {
  const parsed: unknown = JSON.parse(fs.readFileSync(jobFile, "utf8"));
  if (!isJobRecord(parsed)) {
    throw new Error(`Expected ${jobFile} to contain a job record.`);
  }
  return parsed;
}

function removeJobFile(jobFile: string): void {
  if (fs.existsSync(jobFile)) {
    fs.unlinkSync(jobFile);
  }
}

export function resolveJobLogFile(cwd: string, jobId: string): string {
  if (!isSafeJobId(jobId)) {
    throw new Error(`Unsafe job id: ${jobId}`);
  }
  ensureStateDir(cwd);
  return path.join(resolveJobsDir(cwd), `${jobId}.log`);
}

export function resolveJobFile(cwd: string, jobId: string): string {
  if (!isSafeJobId(jobId)) {
    throw new Error(`Unsafe job id: ${jobId}`);
  }
  ensureStateDir(cwd);
  return path.join(resolveJobsDir(cwd), `${jobId}.json`);
}
