---
name: codex-prompting
description: Internal, model-neutral guidance for composing effective Codex prompts for coding, review, diagnosis, and research tasks
user-invocable: false
---

# Codex Prompting

Use this skill only when `codex:codex-rescue` needs to tighten a request before forwarding it to Codex.

Prefer a lean, outcome-oriented prompt. Preserve the user's intent and supplied values. Add only context or constraints that change execution quality; do not turn a clear request into a large prompt template.

Core rules:

- State the outcome, relevant context, hard constraints, success criteria, and required output.
- State each instruction once. Remove repeated process, style, and approval language.
- Define authority compactly: diagnosis, explanation, review, and planning stay read-only; explicit change, build, or fix requests authorise scoped local edits and validation.
- Require confirmation for destructive work, external writes, or material scope expansion.
- Name the checks that prove completion when correctness matters.
- Ground findings in inspected code, commands, logs, or primary sources. Label inferences.
- Keep model and reasoning selection outside the natural-language task prompt.
- Do not compensate for a weak task contract by raising reasoning effort.

Prompt shape:

1. Outcome: the concrete end state.
2. Context: only repository, failure, or dependency facts needed for the task.
3. Boundaries: scope, permissions, preservation rules, and stopping conditions.
4. Verification: the relevant tests, build, type checks, or evidence.
5. Output: only fields or detail the caller needs.

Use plain prose by default. Use labelled or XML blocks only when they make a long or machine-consumed contract clearer.

Task routing:

- Use built-in `review` or `adversarial-review` for local git-change reviews.
- Use `task` when the task is diagnosis, planning, research, or implementation.
- Use `task --resume-last` for a follow-up in the same Codex thread. Send the delta instead of repeating settled context.

Bounded delegation:

- Keep one lead agent for tightly coupled work.
- For a broad audit or exploration with independent surfaces, allow bounded parallel lanes with non-overlapping ownership and a clear synthesis step.
- The lead agent must reproduce or verify accepted child-agent findings against the repository or source evidence before reporting them.
- Do not delegate tiny tasks, create duplicate lanes, or use parallelism when coordination costs more than it saves.

Before forwarding:

1. Keep the user's requested outcome and concrete values intact.
2. Add a missing success criterion, authority boundary, or verification rule only when it matters.
3. Remove duplicated instructions and generic encouragement.
4. Check that the prompt does not authorise more work than the user requested.

Reusable blocks live in [references/prompt-blocks.md](references/prompt-blocks.md).
Compact task recipes live in [references/codex-prompt-recipes.md](references/codex-prompt-recipes.md).
Common failure modes live in [references/codex-prompt-antipatterns.md](references/codex-prompt-antipatterns.md).
