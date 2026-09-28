# Workers

Status: design specification. Implementation and verification status are documented in README.md.

## Runtime independence

The owner can inspect worker availability and
abilities, assign work, start or cancel it, view progress and collect results
across replaceable runtimes. The product preserves task IDs, requirements,
history and evidence when a runtime changes. Continuing from a saved handoff
must not depend on transferring a provider's private session format.

## Eligible access

Prove two real worker runtimes where supported,
eligible access is available without paid inference APIs. Pi is preferred when
eligible. An unavailable runtime remains visibly unavailable and its live
validation remains incomplete. Do not enable spending or unsupported credential
reuse to satisfy the integration target.

## GUI control

Each active GUI task has an identified local session with
exclusive control. Human takeover first stops agent input, then transfers control.
Observing a session does not itself establish device or sensor correctness.


## Shared working contract

A worker is an execution harness plus a permitted provider, model and thinking level, with a specific purpose such as requirements preparation, planning, implementation, design review or verification. Harness, provider and model are separate choices. Availability, recommended suitability and project permission are distinct states.

Workers receive focused project context, relevant repository instructions, exact task scope, source candidate and completion criteria. Coding workers can inspect and edit approved source, run commands and tests, and use declared project tools. They can retrieve relevant context, checkpoint progress, report phase and publish results through task-scoped Wimzo tools. They cannot approve their own PRDs or results, activate a release, modify unrelated projects or obtain owner credentials.

Each adapter reports actual progress, session identity, cancellation acknowledgement, context estimates or measurements and output artifacts. Read-only work remains read-only. Writable execution requires verified workspace containment and preserves the canonical checkout. An unsupported capability is shown as unavailable with a specific reason.

- [Pi](pi/PRD.md)
- [Codex](codex/PRD.md)
- [Claude](claude/PRD.md)
- [Model catalog and recommendations](models/PRD.md)
