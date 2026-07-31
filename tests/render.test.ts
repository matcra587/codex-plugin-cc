// Modified from openai/codex-plugin-cc by Matt Craven in 2026.
// See NOTICE for attribution and plugins/codex/CHANGELOG.md for changes.

import { test } from "bun:test";
import { enrichJob } from "../plugins/codex/scripts/lib/job-control.ts";
import { fs, os, path } from "../plugins/codex/scripts/lib/platform.ts";
import { renderReviewResult, renderStatusReport, renderStoredJobResult } from "../plugins/codex/scripts/lib/render.ts";
import { assert } from "./assertions.ts";

test("renderReviewResult degrades gracefully when JSON is missing required review fields", () => {
  const output = renderReviewResult(
    {
      parsed: {
        verdict: "approve",
        summary: "Looks fine."
      },
      rawOutput: JSON.stringify({
        verdict: "approve",
        summary: "Looks fine."
      }),
      parseError: null
    },
    {
      reviewLabel: "Adversarial Review",
      targetLabel: "working tree diff"
    }
  );

  assert.match(output, /Codex returned JSON with an unexpected review shape\./);
  assert.match(output, /Missing array `findings`\./);
  assert.match(output, /Raw final message:/);
});

test("renderStoredJobResult prefers rendered output for structured review jobs", () => {
  const output = renderStoredJobResult(
    {
      id: "review-123",
      status: "completed",
      title: "Codex Adversarial Review",
      jobClass: "review",
      threadId: "thr_123"
    },
    {
      threadId: "thr_123",
      rendered: "# Codex Adversarial Review\n\nTarget: working tree diff\nVerdict: needs-attention\n",
      result: {
        result: {
          verdict: "needs-attention",
          summary: "One issue.",
          findings: [],
          next_steps: []
        },
        rawOutput: '{"verdict":"needs-attention","summary":"One issue.","findings":[],"next_steps":[]}'
      }
    }
  );

  assert.match(output, /^# Codex Adversarial Review/);
  assert.doesNotMatch(output, /^\{/);
  assert.match(output, /Codex session ID: thr_123/);
  assert.match(output, /Resume in Codex: codex resume thr_123/);
});

// CodeQL js/incomplete-sanitization: escaping only the pipe leaves an input
// `\|` as `\\|`, a literal backslash plus a live pipe that breaks the cell.
test("status table cells escape backslashes before pipes", () => {
  const snapshot = {
    sessionRuntime: { label: "direct startup" },
    config: { stopReviewGate: false },
    running: [
      {
        id: "task-1",
        kindLabel: "rescue",
        status: "running",
        phase: null,
        elapsed: "1s",
        threadId: "thr_1",
        summary: "breaks\\| out of the cell"
      }
    ],
    latestFinished: null,
    recent: [],
    needsReview: false
  };
  const rendered = renderStatusReport(snapshot as never);
  const row = rendered.split("\n").find((line) => line.includes("task-1")) ?? "";
  // The summary's `\|` must come out as an escaped backslash plus an escaped
  // pipe, so exactly three backslashes precede the pipe. Two would mean the
  // pipe is live and the cell has been broken open.
  const backslashes = row.match(/breaks(\\+)\| out of the cell/)?.[1] ?? "";
  assert.equal(backslashes.length, 3, `expected three backslashes before the pipe, got: ${row}`);
  // Eight columns means eight separators plus the leading and trailing bar. A
  // pipe only separates when an even-length backslash run precedes it.
  assert.equal(row.split(/(?<!\\)(?:\\\\)*\|/).length, 10, `cell count changed: ${row}`);
});

test("status table cells collapse a lone carriage return", () => {
  const snapshot = {
    sessionRuntime: { label: "direct startup" },
    config: { stopReviewGate: false },
    running: [
      {
        id: "task-cr",
        kindLabel: "rescue",
        status: "running",
        phase: null,
        elapsed: "1s",
        threadId: "thr_1",
        summary: "phase1\rphase2"
      }
    ],
    latestFinished: null,
    recent: [],
    needsReview: false
  };
  const row = renderStatusReport(snapshot as never)
    .split("\n")
    .find((line) => line.includes("task-cr"));
  assert.equal(typeof row === "string" && !/[\r\n]/.test(row), true, `row still splits: ${JSON.stringify(row)}`);
});

// Upstream matched jest and vitest as verification commands; the port dropped
// them, so those projects lost the "verifying" phase in /codex:status.
test("jest and vitest still register as verification commands", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-plugin-phase-"));
  const cases = [
    ["Running command: npx jest --ci", "verifying"],
    ["Running command: vitest run", "verifying"],
    ["Running command: npm test", "verifying"],
    ["Running command: rg TODO", "investigating"]
  ] as const;

  for (const [index, [line, expected]] of cases.entries()) {
    const logFile = path.join(dir, `job-${index}.log`);
    fs.writeFileSync(logFile, `[2026-03-18T15:30:00.000Z] ${line}\n`, "utf8");
    const enriched = enrichJob({ id: `job-${index}`, jobClass: "task", status: "running", logFile } as never);
    assert.equal(enriched.phase, expected, `${line} should read as ${expected}`);
  }
});
