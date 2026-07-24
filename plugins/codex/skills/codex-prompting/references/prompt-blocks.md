# Prompt Blocks

Use these selectively. Plain prose is usually enough.

## Outcome

```text
Outcome: [observable end state].
```

## Scope and authority

```text
Scope: [included paths or systems].
Authority: [read-only, or scoped local edits and validation].
Ask before destructive work, external writes, or material scope expansion.
```

## Preservation

```text
Preserve existing functionality, routes, outputs, and user-visible behaviour
outside the requested change. Do not remove required behaviour to make checks pass.
```

## Verification

```text
Before finishing, run [specific checks] and verify the result against the
request. If a check fails, fix the issue or report the exact blocker.
```

## Grounding

```text
Ground claims in inspected code, command output, logs, or primary sources.
Label inferences and state what would verify them.
```

## Output

```text
Lead with [decision or outcome]. Include [required evidence, caveat, next step].
Omit introductions, repetition, and unrelated background.
```

## Bounded parallel lanes

```text
Use parallel lanes only for independent surfaces. Give each lane non-overlapping
ownership and keep one lead responsible for synthesis. The lead must reproduce
or verify accepted findings before reporting them.
```
