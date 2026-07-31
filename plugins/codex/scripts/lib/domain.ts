import { isRecord } from "./validation.ts";

export const JOB_STATUSES = ["queued", "running", "completed", "failed", "cancelled"] as const;

export type JobStatus = (typeof JOB_STATUSES)[number];

export const JOB_CLASSES = ["review", "task"] as const;

export type JobClass = (typeof JOB_CLASSES)[number];

export const JOB_KINDS = ["review", "adversarial-review", "task"] as const;

export type JobKind = (typeof JOB_KINDS)[number];

export const REASONING_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"] as const;

export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

const JOB_STATUS_SET: ReadonlySet<string> = new Set(JOB_STATUSES);
const JOB_CLASS_SET: ReadonlySet<string> = new Set(JOB_CLASSES);
const JOB_KIND_SET: ReadonlySet<string> = new Set(JOB_KINDS);
const REASONING_EFFORT_SET: ReadonlySet<string> = new Set(REASONING_EFFORTS);

export interface TaskRequest {
  cwd: string;
  model: string | null;
  effort: ReasoningEffort | null;
  prompt: string;
  write: boolean;
  resumeLast: boolean;
  jobId: string;
}

export interface JobResult {
  rawOutput?: unknown;
  codex?: {
    stdout?: unknown;
  };
  result?: unknown;
  parseError?: unknown;
  [key: string]: unknown;
}

export interface JobRecord {
  id: string;
  status?: JobStatus;
  kind?: JobKind;
  kindLabel?: string;
  title?: string;
  workspaceRoot?: string;
  jobClass?: JobClass;
  /**
   * The stop-time review gate dispatches through `task`, so its job is a task
   * by class. This marks it as the gate's own run so it is not offered as a
   * resume candidate ahead of the user's last rescue.
   */
  stopGate?: boolean;
  summary?: string;
  write?: boolean;
  sessionId?: string;
  phase?: string | null;
  pid?: number | null;
  logFile?: string | null;
  threadId?: string | null;
  turnId?: string | null;
  createdAt?: string;
  updatedAt?: string;
  startedAt?: string;
  completedAt?: string;
  cancelledAt?: string;
  elapsed?: string | null;
  duration?: string | null;
  progressPreview?: string[];
  errorMessage?: string;
  request?: TaskRequest;
  result?: JobResult;
  rendered?: string;
  [key: string]: unknown;
}

export type JobPatch = Pick<JobRecord, "id"> & Partial<Omit<JobRecord, "id">>;

export type TrackedJob = JobRecord & Required<Pick<JobRecord, "id" | "workspaceRoot">>;

export interface CompanionState {
  version: number;
  config: CompanionConfig;
  jobs: JobRecord[];
}

export interface CompanionConfig {
  stopReviewGate: boolean;
  [key: string]: unknown;
}

export interface ProgressEvent {
  message: string;
  phase: string | null;
  threadId: string | null;
  turnId: string | null;
  stderrMessage: string | null;
  logTitle: string | null;
  logBody: string | null;
}

export type ProgressInput =
  | string
  | {
      message?: unknown;
      phase?: unknown;
      threadId?: unknown;
      turnId?: unknown;
      stderrMessage?: unknown;
      logTitle?: unknown;
      logBody?: unknown;
    };

export type ProgressReporter = (event: ProgressInput) => void;

export interface JobExecution<Payload = unknown> {
  exitStatus: number;
  threadId?: string | null;
  turnId?: string | null;
  payload: Payload;
  rendered: string;
  summary: string;
}

export interface EnvironmentOptions {
  env?: Record<string, string | undefined> | undefined;
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

function isOptionalNullableString(value: unknown): boolean {
  return value === undefined || value === null || typeof value === "string";
}

function isOptionalNullableNumber(value: unknown): boolean {
  return value === undefined || value === null || (typeof value === "number" && Number.isFinite(value));
}

function isTaskRequest(value: unknown): value is TaskRequest {
  return (
    isRecord(value) &&
    typeof value.cwd === "string" &&
    (value.model === null || typeof value.model === "string") &&
    (value.effort === null || (typeof value.effort === "string" && REASONING_EFFORT_SET.has(value.effort))) &&
    typeof value.prompt === "string" &&
    typeof value.write === "boolean" &&
    typeof value.resumeLast === "boolean" &&
    typeof value.jobId === "string"
  );
}

export function isJobRecord(value: unknown): value is JobRecord {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    (value.status === undefined || (typeof value.status === "string" && JOB_STATUS_SET.has(value.status))) &&
    (value.kind === undefined || (typeof value.kind === "string" && JOB_KIND_SET.has(value.kind))) &&
    (value.jobClass === undefined || (typeof value.jobClass === "string" && JOB_CLASS_SET.has(value.jobClass))) &&
    isOptionalString(value.kindLabel) &&
    isOptionalString(value.title) &&
    isOptionalString(value.workspaceRoot) &&
    isOptionalString(value.summary) &&
    (value.write === undefined || typeof value.write === "boolean") &&
    (value.stopGate === undefined || typeof value.stopGate === "boolean") &&
    isOptionalString(value.sessionId) &&
    isOptionalNullableString(value.phase) &&
    isOptionalNullableNumber(value.pid) &&
    isOptionalNullableString(value.logFile) &&
    isOptionalNullableString(value.threadId) &&
    isOptionalNullableString(value.turnId) &&
    isOptionalString(value.createdAt) &&
    isOptionalString(value.updatedAt) &&
    isOptionalString(value.startedAt) &&
    isOptionalString(value.completedAt) &&
    isOptionalString(value.cancelledAt) &&
    isOptionalNullableString(value.elapsed) &&
    isOptionalNullableString(value.duration) &&
    (value.progressPreview === undefined ||
      (Array.isArray(value.progressPreview) &&
        value.progressPreview.every((line: unknown) => typeof line === "string"))) &&
    isOptionalString(value.errorMessage) &&
    (value.request === undefined || isTaskRequest(value.request)) &&
    (value.result === undefined || isRecord(value.result)) &&
    isOptionalString(value.rendered)
  );
}
