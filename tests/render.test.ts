// Modified from openai/codex-plugin-cc by Matt Craven in 2026.
// See NOTICE for attribution and plugins/codex/CHANGELOG.md for changes.

import { test } from "bun:test";
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
  assert.equal(row.includes("\\\\\\|"), true, `expected an escaped backslash and pipe, got: ${row}`);
  // Eight columns means eight separators plus the leading and trailing bar.
  assert.equal(row.split(/(?<!\\)\|/).length, 10, `cell count changed: ${row}`);
});
