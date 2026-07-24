# Codex Prompt Recipes

Use these as compact starting points for Codex task prompts. Keep only clauses that affect the requested outcome. In `codex:codex-rescue`, diagnosis and research stay read-only; explicit fix requests run write-capable by default.

## Diagnosis

```text
Diagnose why [observed failure] occurs in this repository.

Inspect the relevant code, configuration, logs, and tests. Do not edit files.
Return the root cause, supporting evidence, and the smallest safe next step.
Label any remaining hypothesis and say what would verify it.
```

## Narrow Fix

```text
Implement the smallest safe fix for [problem].

Preserve existing behaviour outside the failing path. Make scoped local edits
and run the relevant tests, build, and type checks. Do not weaken required
behaviour merely to make validation pass.

Return the outcome, changed files, verification evidence, and any residual risk.
```

## Root-Cause Review

```text
Review [target] for material correctness and regression risks. Stay read-only.

Ground every finding in the inspected repository evidence. Check failure,
empty-state, retry, concurrency, and rollback paths where relevant.
Return actionable findings in severity order, then state if none remain.
```

## Research Or Recommendation

```text
Research [decision] and recommend the best option for [goal].

Use primary sources where available. Separate observed facts, inferences, and
open questions. Compare the options against [decision criteria].
Return the recommendation first, then evidence and material trade-offs.
```

## Broad Independent Audit

```text
Audit [scope] for [risk].

If the surfaces are genuinely independent, use a small number of bounded,
non-overlapping parallel lanes. Keep one lead responsible for synthesis.
Reproduce or verify every accepted child-agent finding against the repository
before reporting it. Return only material, actionable findings.
```

## Prompt Repair

```text
Diagnose why this prompt misses [measured requirement].

Base the diagnosis on the prompt and supplied failure examples. Make the
smallest revision that addresses those failures. Preserve working constraints.
Return the failure mode, revised prompt, and why each change is necessary.
```
