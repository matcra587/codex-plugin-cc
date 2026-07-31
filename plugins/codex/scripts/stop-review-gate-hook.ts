#!/usr/bin/env bun

// Modified from openai/codex-plugin-cc by Matt Craven in 2026.
// See NOTICE for attribution and plugins/codex/CHANGELOG.md for changes.

import { getCodexAvailability } from "./lib/codex.ts";
import type { JobRecord } from "./lib/domain.ts";
import { sortJobsNewestFirst } from "./lib/job-control.ts";
import { fs, path } from "./lib/platform.ts";
import { interpolateTemplate, loadPromptTemplate } from "./lib/prompts.ts";
import { getConfig, listJobs } from "./lib/state.ts";
import { SESSION_ID_ENV } from "./lib/tracked-jobs.ts";
import { isRecord } from "./lib/validation.ts";
import { resolveWorkspaceRoot } from "./lib/workspace.ts";

const STOP_REVIEW_TIMEOUT_MS = 15 * 60 * 1000;
const SCRIPT_DIR = path.dirname(Bun.fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(SCRIPT_DIR, "..");
interface StopHookInput {
  cwd?: string | undefined;
  last_assistant_message?: string | undefined;
  session_id?: string | undefined;
  stop_hook_active?: boolean | undefined;
}

interface StopReviewResult {
  ok: boolean;
  reason: string | null;
}

function optionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function optionalBoolean(record: Record<string, unknown>, key: string): boolean | undefined {
  const value = record[key];
  return typeof value === "boolean" ? value : undefined;
}

function readHookInput(): StopHookInput {
  const raw = fs.readFileSync(0, "utf8").trim();
  if (!raw) {
    return {};
  }
  const parsed: unknown = JSON.parse(raw);
  if (!isRecord(parsed)) {
    return {};
  }
  return {
    cwd: optionalString(parsed, "cwd"),
    last_assistant_message: optionalString(parsed, "last_assistant_message"),
    session_id: optionalString(parsed, "session_id"),
    stop_hook_active: optionalBoolean(parsed, "stop_hook_active")
  };
}

function emitDecision(payload: { decision: "block"; reason: string }): void {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function logNote(message: string | null): void {
  if (!message) {
    return;
  }
  process.stderr.write(`${message}\n`);
}

function filterJobsForCurrentSession(jobs: JobRecord[], input: StopHookInput = {}): JobRecord[] {
  const sessionId = input.session_id || process.env[SESSION_ID_ENV] || null;
  if (!sessionId) {
    return jobs;
  }
  return jobs.filter((job) => job.sessionId === sessionId);
}

function buildStopReviewPrompt(input: StopHookInput = {}): string {
  const lastAssistantMessage = String(input.last_assistant_message ?? "").trim();
  const template = loadPromptTemplate(ROOT_DIR, "stop-review-gate");
  const claudeResponseBlock = lastAssistantMessage
    ? ["Previous Claude response:", lastAssistantMessage].join("\n")
    : "";
  return interpolateTemplate(template, {
    CLAUDE_RESPONSE_BLOCK: claudeResponseBlock
  });
}

function buildSetupNote(cwd: string): string | null {
  const availability = getCodexAvailability(cwd);
  if (availability.available) {
    return null;
  }

  const detail = availability.detail ? ` ${availability.detail}.` : "";
  return `Codex is not set up for the review gate.${detail} Run /codex:setup.`;
}

function parseStopReviewOutput(rawOutput: unknown): StopReviewResult {
  const text = String(rawOutput ?? "").trim();
  if (!text) {
    return {
      ok: false,
      reason:
        "The stop-time Codex review task returned no final output. Run /codex:review --wait manually or bypass the gate."
    };
  }

  const firstLine = text.split(/\r?\n/, 1)[0]?.trim() ?? "";
  if (firstLine.startsWith("ALLOW:")) {
    return { ok: true, reason: null };
  }
  if (firstLine.startsWith("BLOCK:")) {
    const reason = firstLine.slice("BLOCK:".length).trim() || text;
    return {
      ok: false,
      reason: `Codex stop-time review found issues that still need fixes before ending the session: ${reason}`
    };
  }

  return {
    ok: false,
    reason:
      "The stop-time Codex review task returned an unexpected answer. Run /codex:review --wait manually or bypass the gate."
  };
}

function runStopReview(cwd: string, input: StopHookInput = {}): StopReviewResult {
  const scriptPath = path.join(SCRIPT_DIR, "codex-companion.ts");
  const prompt = buildStopReviewPrompt(input);
  const childEnv = {
    ...process.env,
    ...(input.session_id ? { [SESSION_ID_ENV]: input.session_id } : {})
  };
  const result = Bun.spawnSync([process.execPath, scriptPath, "task", "--json", prompt], {
    cwd,
    env: childEnv,
    stdout: "pipe",
    stderr: "pipe",
    timeout: STOP_REVIEW_TIMEOUT_MS
  });

  if (result.signalCode === "SIGTERM" && result.exitCode === null) {
    return {
      ok: false,
      reason:
        "The stop-time Codex review task timed out after 15 minutes. Run /codex:review --wait manually or bypass the gate."
    };
  }

  if (result.exitCode !== 0) {
    // Bun.spawnSync returns Buffers, and an empty Buffer is truthy, so an
    // `||` over the raw values selects an empty stderr and discards the detail
    // on stdout. Node returned strings here, where "" fell through.
    const detail = (result.stderr.toString() || result.stdout.toString()).trim();
    return {
      ok: false,
      reason: detail
        ? `The stop-time Codex review task failed: ${detail}`
        : "The stop-time Codex review task failed. Run /codex:review --wait manually or bypass the gate."
    };
  }

  try {
    const payload: unknown = JSON.parse(result.stdout.toString());
    const rawOutput = payload && typeof payload === "object" && "rawOutput" in payload ? payload.rawOutput : null;
    return parseStopReviewOutput(rawOutput);
  } catch {
    return {
      ok: false,
      reason:
        "The stop-time Codex review task returned invalid JSON. Run /codex:review --wait manually or bypass the gate."
    };
  }
}

function main(): void {
  const input = readHookInput();
  const cwd = input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const config = getConfig(workspaceRoot);

  const jobs = sortJobsNewestFirst(filterJobsForCurrentSession(listJobs(workspaceRoot), input));
  const runningJob = jobs.find((job) => job.status === "queued" || job.status === "running");
  const runningTaskNote = runningJob
    ? `Codex task ${runningJob.id} is still running. Check /codex:status and use /codex:cancel ${runningJob.id} if you want to stop it before ending the session.`
    : null;

  if (!config.stopReviewGate) {
    logNote(runningTaskNote);
    return;
  }

  const setupNote = buildSetupNote(cwd);
  if (setupNote) {
    logNote(setupNote);
    logNote(runningTaskNote);
    return;
  }

  // Claude Code is already continuing because this hook blocked, so the turn
  // it would review is the one it just rejected. Reviewing again would block
  // again, and a review that times out or errors is never "ok", so the turn
  // would be blocked until the consecutive-block cap force-ends it. Gate once
  // and yield on the retry.
  if (input.stop_hook_active) {
    logNote(runningTaskNote);
    return;
  }

  const review = runStopReview(cwd, input);
  if (!review.ok) {
    emitDecision({
      decision: "block",
      reason: runningTaskNote
        ? `${runningTaskNote} ${review.reason ?? "The stop-time review did not pass."}`
        : (review.reason ?? "The stop-time review did not pass.")
    });
    return;
  }

  logNote(runningTaskNote);
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}
