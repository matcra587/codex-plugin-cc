# Codex Prompt Anti-Patterns

## Repeating the same rule

State each requirement once. Repeated approval, persistence, or style language adds noise and can distort behaviour.

## Prescribing process instead of outcome

Avoid long step-by-step reasoning instructions when the task only needs a clear end state, constraints, and proof of completion.

## Missing authority boundaries

Do not let a diagnosis prompt imply edits or let a fix prompt stall on safe local work. Say what the request authorises and which actions still need confirmation.

## Vague completion

Replace 'look into this' with the observable result, relevant evidence, and validation that define done.

## Raising effort to repair a weak contract

Add the missing context, success criterion, tool route, or verification loop before selecting a more expensive reasoning effort.

## Unbounded delegation

Do not ask for generic parallelism. Split only independent surfaces, cap the lanes, assign non-overlapping ownership, and require the lead to verify accepted findings.

## Unsupported certainty

Require claims to cite inspected repository or source evidence. Label hypotheses and name the check that would resolve them.

## Template inflation

Do not wrap a short, clear task in every available prompt block. Use labels or XML only where they improve a real contract or parser boundary.
