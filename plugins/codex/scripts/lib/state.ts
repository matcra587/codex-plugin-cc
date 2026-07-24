import { fs, os, path } from "./platform.ts";

import { isJobRecord, type CompanionConfig, type CompanionState, type JobPatch, type JobRecord } from "./domain.ts";
import { isRecord } from "./validation.ts";
import { resolveWorkspaceRoot } from "./workspace.ts";

const STATE_VERSION = 1;
const PLUGIN_DATA_ENV = "CLAUDE_PLUGIN_DATA";
const XDG_STATE_HOME_ENV = "XDG_STATE_HOME";
const FALLBACK_STATE_DIR_NAME = "codex-plugin-cc";
const STATE_FILE_NAME = "state.json";
const JOBS_DIR_NAME = "jobs";
const MAX_JOBS = 50;
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const SAFE_JOB_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

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

  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    if (!isRecord(parsed)) {
      return defaultState();
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
  } catch {
    return defaultState();
  }
}

function pruneJobs(jobs: readonly JobRecord[]): JobRecord[] {
  return [...jobs]
    .sort((left, right) => String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? "")))
    .slice(0, MAX_JOBS);
}

function removeFileIfExists(filePath: string | null | undefined): void {
  if (filePath && fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
}

export function saveState(cwd: string, state: CompanionState): CompanionState {
  const previousJobs = loadState(cwd).jobs;
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

  fs.writeFileSync(resolveStateFile(cwd), `${JSON.stringify(nextState, null, 2)}\n`, {
    encoding: "utf8",
    mode: PRIVATE_FILE_MODE
  });
  return nextState;
}

export function updateState(cwd: string, mutate: (state: CompanionState) => void): CompanionState {
  const state = loadState(cwd);
  mutate(state);
  return saveState(cwd, state);
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
  return loadState(cwd).jobs;
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
  fs.writeFileSync(jobFile, `${JSON.stringify(payload, null, 2)}\n`, {
    encoding: "utf8",
    mode: PRIVATE_FILE_MODE
  });
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
