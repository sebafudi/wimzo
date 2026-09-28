# Pi worker

Status: design specification. Implementation and verification status are documented in README.md.

## Purpose and access

Pi is a configurable coding harness for bounded requirements, planning, implementation and verification runs. The initial desired provider is the owner's logged-in Codex subscription through Pi's supported openai-codex route. Other configured providers can be added later without changing the project's saved intent or history.

The selected provider must be authenticated, permitted for this project and supported by the installed Pi version. Model discovery reports actual selectable IDs and supported thinking levels. A missing model or login blocks the run visibly; it does not trigger a paid fallback or credential conversion.

## Working tools and context

An implementation worker has source reading, search, editing, file writing, shell and test tools within the approved isolated workspace. Relevant repository instructions and project tools are included deliberately. Task-scoped Wimzo tools provide context lookup, checkpoints, progress and result reporting. Tool calls retain cancellation and execution bounds.

A read-only investigation uses a narrower tool set. Write access is enabled only when containment has been verified for the actual launch route. Switching providers preserves checkpoints and exact task constraints, with the new provider checked against project policy.

## Acceptance examples

- A permitted subscription-backed run edits and tests a fixture repository and reports its candidate through Wimzo.
- The worker can recover its task context after a fresh session without reading unrelated projects.
- A missing model, disallowed provider or unverified write boundary produces a visible blocked reason without starting inference.
