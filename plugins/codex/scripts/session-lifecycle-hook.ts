#!/usr/bin/env bun

// Modified from openai/codex-plugin-cc by Matt Craven in 2026.
// See NOTICE for attribution and plugins/codex/CHANGELOG.md for changes.

import { BROKER_ENDPOINT_ENV } from "./lib/app-server.ts";
import {
  clearBrokerSession,
  LOG_FILE_ENV,
  loadBrokerSession,
  PID_FILE_ENV,
  sendBrokerShutdown,
  teardownBrokerSession
} from "./lib/broker-lifecycle.ts";
import { TRANSCRIPT_PATH_ENV } from "./lib/claude-session-transfer.ts";
import { fs } from "./lib/platform.ts";
import { terminateProcessTree } from "./lib/process.ts";
import { resolveStateFile, updateState } from "./lib/state.ts";
import { isRecord } from "./lib/validation.ts";
import { resolveWorkspaceRoot } from "./lib/workspace.ts";

export const SESSION_ID_ENV = "CODEX_COMPANION_SESSION_ID";
const PLUGIN_DATA_ENV = "CLAUDE_PLUGIN_DATA";

interface SessionHookInput {
  cwd?: string | undefined;
  hook_event_name?: string | undefined;
  session_id?: string | undefined;
  transcript_path?: string | undefined;
}

function optionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function readHookInput(): SessionHookInput {
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
    hook_event_name: optionalString(parsed, "hook_event_name"),
    session_id: optionalString(parsed, "session_id"),
    transcript_path: optionalString(parsed, "transcript_path")
  };
}

function shellEscape(value: unknown): string {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

function appendEnvVar(name: string, value: unknown): void {
  if (!process.env.CLAUDE_ENV_FILE || value == null || value === "") {
    return;
  }
  fs.appendFileSync(process.env.CLAUDE_ENV_FILE, `export ${name}=${shellEscape(value)}\n`, "utf8");
}

function cleanupSessionJobs(cwd: string | undefined, sessionId: string | undefined): void {
  if (!cwd || !sessionId) {
    return;
  }

  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const stateFile = resolveStateFile(workspaceRoot);
  if (!fs.existsSync(stateFile)) {
    return;
  }

  const runningPids: number[] = [];
  updateState(workspaceRoot, (state) => {
    state.jobs = state.jobs.filter((job) => {
      if (job.sessionId !== sessionId) {
        return true;
      }
      // Claude reuses a conversation's session id when it is reopened, so
      // finished jobs must outlive the session that created them. Dropping
      // them here is what made `/codex:rescue --resume` and the resume
      // candidate lookup report no previous task while the Codex thread was
      // still live. Only work that is still in flight gets torn down.
      if (job.status !== "queued" && job.status !== "running") {
        return true;
      }
      if (job.pid != null) {
        runningPids.push(job.pid);
      }
      return false;
    });
  });

  for (const pid of runningPids) {
    try {
      terminateProcessTree(pid);
    } catch {
      // Ignore teardown failures during session shutdown.
    }
  }
}

function handleSessionStart(input: SessionHookInput): void {
  appendEnvVar(SESSION_ID_ENV, input.session_id);
  appendEnvVar(TRANSCRIPT_PATH_ENV, input.transcript_path);
  appendEnvVar(PLUGIN_DATA_ENV, process.env[PLUGIN_DATA_ENV]);
}

async function handleSessionEnd(input: SessionHookInput): Promise<void> {
  const cwd = input.cwd || process.cwd();
  const brokerSession =
    loadBrokerSession(cwd) ??
    (process.env[BROKER_ENDPOINT_ENV]
      ? {
          endpoint: process.env[BROKER_ENDPOINT_ENV],
          pidFile: process.env[PID_FILE_ENV] ?? null,
          logFile: process.env[LOG_FILE_ENV] ?? null,
          sessionDir: null,
          pid: null
        }
      : null);
  const brokerEndpoint = brokerSession?.endpoint ?? null;
  const pidFile = brokerSession?.pidFile ?? null;
  const logFile = brokerSession?.logFile ?? null;
  const sessionDir = brokerSession?.sessionDir ?? null;
  const pid = brokerSession?.pid ?? null;

  if (brokerEndpoint) {
    await sendBrokerShutdown(brokerEndpoint);
  }

  cleanupSessionJobs(cwd, input.session_id || process.env[SESSION_ID_ENV]);
  teardownBrokerSession({
    endpoint: brokerEndpoint,
    pidFile,
    logFile,
    sessionDir,
    pid,
    killProcess: terminateProcessTree
  });
  clearBrokerSession(cwd);
}

async function main(): Promise<void> {
  const input = readHookInput();
  const eventName = process.argv[2] ?? input.hook_event_name ?? "";

  if (eventName === "SessionStart") {
    handleSessionStart(input);
    return;
  }

  if (eventName === "SessionEnd") {
    await handleSessionEnd(input);
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
