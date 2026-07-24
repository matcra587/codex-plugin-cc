import { upsertJob } from "../plugins/codex/scripts/lib/state.ts";

const [workspace, jobId] = process.argv.slice(2);

if (!workspace || !jobId) {
  throw new Error("Usage: bun tests/state-writer-fixture.ts <workspace> <job-id>");
}

upsertJob(workspace, {
  id: jobId,
  status: "running",
  pid: process.pid
});
