# Claude worker

Status: design specification. Implementation and verification status are documented in README.md.

## Purpose and access

The Claude worker uses Anthropic's official Claude Agent SDK. It supports planning, implementation and verification where supported authentication and the project's provider policy permit execution. Opus for difficult planning and Sonnet for routine implementation are editable initial preferences, not guaranteed capability rankings.

Anthropic paid inference APIs are not authorized now. The worker stays unavailable until a supported authentication route is configured under that policy. Wimzo does not borrow or repackage Claude subscription credentials into an unsupported application route.

## Working behavior

The worker receives the same bounded task, relevant source and PRD context, isolated workspace and scoped Wimzo tools as other coding workers. It can read, search, edit and test within its permissions, report progress, checkpoint, resume and return exact-candidate evidence. Tool and permission handling must be verified before enabling unattended writes.

## Acceptance examples

- Project policy can enable Anthropic for one project while preventing discovery, recommendation and launch as an eligible choice in another.
- An unavailable login or forbidden billing route blocks the task without fallback.
- Once supported access exists, a real fixture run demonstrates coding, task-scoped tool calls, cancellation and recovery before being described as live-ready.
