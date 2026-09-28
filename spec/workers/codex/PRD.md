# Codex worker

Status: design specification. Implementation and verification status are documented in README.md.

## Purpose and access

The Codex worker uses the official local Codex SDK and the owner's supported Codex subscription login. It supports focused planning, implementation and verification, with the selected model and thinking level passed to the actual runtime. It does not fall back to an OpenAI inference API key.

## Working behavior

The worker receives its isolated repository, relevant instructions, source candidate, approved PRD sections and task-scoped Wimzo tools. It streams useful progress and tool outcomes into the saved run. Its sandbox and tool permissions match the approved scope. Existing local sessions can resume when useful, while a fresh session can continue from the durable handoff.

Cancellation, runtime failure, context growth and subscription limits preserve saved work. Completion returns an exact candidate, checks, artifacts, remaining issues and a readable changelog. SDK execution does not imply native desktop or computer-use availability; those capabilities must be separately verified.

## Acceptance examples

- A subscription-authenticated fixture coding run uses the requested model and reasoning level, edits only its workspace and reports evidence.
- A canceled run stops with truthful acknowledgement and can continue from its saved progress.
- A new SDK session resumes a bounded follow-up using the durable handoff without duplicating completed side effects.
