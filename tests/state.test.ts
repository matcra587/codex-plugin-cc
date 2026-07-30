import { fs, os, path } from "../plugins/codex/scripts/lib/platform.ts";
import { test } from "bun:test";
import { assert } from "./assertions.ts";

import type { JobRecord } from "../plugins/codex/scripts/lib/domain.ts";
import { makeTempDir } from "./helpers.ts";
import {
  ensureStateDir,
  listJobs,
  loadState,
  resolveJobFile,
  resolveJobLogFile,
  resolveStateDir,
  resolveStateFile,
  saveState
} from "../plugins/codex/scripts/lib/state.ts";

const ROOT = path.resolve(path.dirname(Bun.fileURLToPath(import.meta.url)), "..");
const STATE_WRITER_FIXTURE = path.join(ROOT, "tests", "state-writer-fixture.ts");

test("resolveStateDir uses a user-private fallback outside the shared temp directory", () => {
  const workspace = makeTempDir();
  const userHome = makeTempDir();
  const previousPluginDataDir = process.env.CLAUDE_PLUGIN_DATA;
  const previousXdgStateHome = process.env.XDG_STATE_HOME;
  const previousHome = process.env.HOME;
  delete process.env.CLAUDE_PLUGIN_DATA;
  delete process.env.XDG_STATE_HOME;
  process.env.HOME = userHome;

  try {
    const stateDir = resolveStateDir(workspace);

    assert.equal(stateDir.startsWith(path.join(userHome, ".local", "state", "codex-plugin-cc")), true);
    assert.equal(stateDir.startsWith(path.join(os.tmpdir(), "codex-companion")), false);
    assert.match(path.basename(stateDir), /.+-[a-f0-9]{16}$/);
  } finally {
    if (previousPluginDataDir == null) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previousPluginDataDir;
    }
    if (previousXdgStateHome == null) {
      delete process.env.XDG_STATE_HOME;
    } else {
      process.env.XDG_STATE_HOME = previousXdgStateHome;
    }
    if (previousHome == null) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
  }
});

test("ensureStateDir creates private workspace and job directories", async () => {
  const workspace = makeTempDir();
  const pluginDataDir = makeTempDir();
  const previousPluginDataDir = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = pluginDataDir;

  try {
    ensureStateDir(workspace);

    const stateMode = (await Bun.file(resolveStateDir(workspace)).stat()).mode & 0o777;
    const jobsMode = (await Bun.file(path.dirname(resolveJobFile(workspace, "job"))).stat()).mode & 0o777;
    assert.equal(stateMode, 0o700);
    assert.equal(jobsMode, 0o700);
  } finally {
    if (previousPluginDataDir == null) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previousPluginDataDir;
    }
  }
});

test("resolveStateDir uses CLAUDE_PLUGIN_DATA when it is provided", () => {
  const workspace = makeTempDir();
  const pluginDataDir = makeTempDir();
  const previousPluginDataDir = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = pluginDataDir;

  try {
    const stateDir = resolveStateDir(workspace);

    assert.equal(stateDir.startsWith(path.join(pluginDataDir, "state")), true);
    assert.match(path.basename(stateDir), /.+-[a-f0-9]{16}$/);
    assert.match(stateDir, new RegExp(`^${path.join(pluginDataDir, "state").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  } finally {
    if (previousPluginDataDir == null) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previousPluginDataDir;
    }
  }
});

test("saveState prunes dropped job artifacts when indexed jobs exceed the cap", () => {
  const workspace = makeTempDir();
  const stateFile = resolveStateFile(workspace);
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });

  const jobs: JobRecord[] = Array.from({ length: 51 }, (_, index) => {
    const jobId = `job-${index}`;
    const updatedAt = new Date(Date.UTC(2026, 0, 1, 0, index, 0)).toISOString();
    const logFile = resolveJobLogFile(workspace, jobId);
    const jobFile = resolveJobFile(workspace, jobId);
    fs.writeFileSync(logFile, `log ${jobId}\n`, "utf8");
    fs.writeFileSync(jobFile, JSON.stringify({ id: jobId, status: "completed" }, null, 2), "utf8");
    return {
      id: jobId,
      status: "completed",
      logFile,
      updatedAt,
      createdAt: updatedAt
    };
  });

  fs.writeFileSync(
    stateFile,
    `${JSON.stringify(
      {
        version: 1,
        config: { stopReviewGate: false },
        jobs
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  saveState(workspace, {
    version: 1,
    config: { stopReviewGate: false },
    jobs
  });

  const prunedJobFile = resolveJobFile(workspace, "job-0");
  const prunedLogFile = resolveJobLogFile(workspace, "job-0");
  const retainedJobFile = resolveJobFile(workspace, "job-50");
  const retainedLogFile = resolveJobLogFile(workspace, "job-50");
  const jobsDir = path.dirname(prunedJobFile);

  assert.equal(fs.existsSync(retainedJobFile), true);
  assert.equal(fs.existsSync(retainedLogFile), true);
  assert.equal(fs.existsSync(prunedLogFile), false);

  const savedState = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  assert.equal(savedState.jobs.length, 50);
  assert.deepEqual(
    savedState.jobs.map((job: JobRecord) => job.id),
    Array.from({ length: 50 }, (_, index) => `job-${50 - index}`)
  );
  assert.deepEqual(
    fs.readdirSync(jobsDir).sort(),
    Array.from({ length: 50 }, (_, index) => `job-${index + 1}`)
      .flatMap((jobId) => [`${jobId}.json`, `${jobId}.log`])
      .sort()
  );
});

test("loadState drops malformed persisted jobs", () => {
  const workspace = makeTempDir();
  const stateFile = resolveStateFile(workspace);
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.writeFileSync(
    stateFile,
    `${JSON.stringify({
      version: 1,
      config: { stopReviewGate: false },
      jobs: [
        { id: "valid", status: "running", pid: 1234 },
        { id: "invalid-status", status: "unknown" },
        { id: "invalid-pid", status: "running", pid: "1234" }
      ]
    })}\n`,
    "utf8"
  );

  assert.deepEqual(
    loadState(workspace).jobs.map((job) => job.id),
    ["valid"]
  );
});

test("loadState rejects persisted job paths outside the private jobs directory", () => {
  const workspace = makeTempDir();
  const unrelatedFile = path.join(workspace, "keep.txt");
  const stateFile = resolveStateFile(workspace);
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.writeFileSync(unrelatedFile, "keep\n", "utf8");
  fs.writeFileSync(
    stateFile,
    `${JSON.stringify({
      version: 1,
      config: { stopReviewGate: false },
      jobs: [
        {
          id: "poisoned",
          status: "completed",
          logFile: unrelatedFile
        },
        {
          id: "../../keep",
          status: "completed"
        }
      ]
    })}\n`,
    "utf8"
  );

  assert.deepEqual(loadState(workspace).jobs, []);
  saveState(workspace, loadState(workspace));
  assert.equal(fs.existsSync(unrelatedFile), true);
});

test("loadState fails closed when an existing state file is corrupt", () => {
  const workspace = makeTempDir();
  const stateFile = resolveStateFile(workspace);
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.writeFileSync(stateFile, "{", "utf8");

  assert.throws(() => loadState(workspace), /Unable to load persisted state/);
});

test("concurrent state writers retain every job", async () => {
  const workspace = makeTempDir();
  const writers = Array.from({ length: 16 }, (_, index) =>
    Bun.spawn([process.execPath, STATE_WRITER_FIXTURE, workspace, `concurrent-${index}`], {
      env: process.env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe"
    })
  );

  const statuses = await Promise.all(writers.map((writer) => writer.exited));
  assert.deepEqual(
    statuses,
    Array.from({ length: writers.length }, () => 0)
  );
  assert.deepEqual(
    listJobs(workspace)
      .map((job) => job.id)
      .sort(),
    Array.from({ length: writers.length }, (_, index) => `concurrent-${index}`).sort()
  );
});

test("listJobs marks a running job failed when its worker process is gone", () => {
  const workspace = makeTempDir();
  const stateFile = resolveStateFile(workspace);
  const jobFile = resolveJobFile(workspace, "dead-worker");
  const deadPid = 99_999_999;
  const job = {
    id: "dead-worker",
    status: "running",
    pid: deadPid,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:01.000Z"
  };
  fs.writeFileSync(jobFile, `${JSON.stringify(job)}\n`, "utf8");
  fs.writeFileSync(
    stateFile,
    `${JSON.stringify({
      version: 1,
      config: { stopReviewGate: true },
      jobs: [job]
    })}\n`,
    "utf8"
  );

  const [reconciled] = listJobs(workspace);
  assert.equal(reconciled?.status, "failed");
  assert.equal(reconciled?.pid, null);
  assert.match(reconciled?.errorMessage ?? "", /worker process is no longer running/i);

  const storedJob = JSON.parse(fs.readFileSync(jobFile, "utf8"));
  assert.equal(storedJob.status, "failed");
  assert.equal(storedJob.pid, null);
  assert.equal(loadState(workspace).config.stopReviewGate, true);
});

test("listJobs adopts a terminal job file when its worker process is gone", () => {
  const workspace = makeTempDir();
  const stateFile = resolveStateFile(workspace);
  const jobFile = resolveJobFile(workspace, "finished-worker");
  const indexedJob = {
    id: "finished-worker",
    status: "running",
    pid: 99_999_999,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:01.000Z"
  };
  const completedJob = {
    ...indexedJob,
    status: "completed",
    phase: "done",
    pid: null,
    completedAt: "2026-01-01T00:00:02.000Z",
    result: { answer: 42 }
  };
  fs.writeFileSync(jobFile, `${JSON.stringify(completedJob)}\n`, "utf8");
  fs.writeFileSync(
    stateFile,
    `${JSON.stringify({
      version: 1,
      config: { stopReviewGate: false },
      jobs: [indexedJob]
    })}\n`,
    "utf8"
  );

  const [reconciled] = listJobs(workspace);
  assert.equal(reconciled?.status, "completed");
  assert.equal(reconciled?.pid, null);
  assert.deepEqual(reconciled?.result, { answer: 42 });
});

test("listJobs leaves a running job alone while its worker process is alive", () => {
  const workspace = makeTempDir();
  saveState(workspace, {
    version: 1,
    config: { stopReviewGate: false },
    jobs: [
      {
        id: "live-worker",
        status: "running",
        pid: process.pid
      }
    ]
  });

  const [job] = listJobs(workspace);
  assert.equal(job?.status, "running");
  assert.equal(job?.pid, process.pid);
});
