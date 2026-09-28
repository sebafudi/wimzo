# Projects and provider access

Status: design specification. Implementation and verification status are documented in README.md.

## Functional completeness

Each project's PRDs must describe its full
functional contract, sufficient in principle to recreate the intended behavior
without reading existing code. Include relevant journeys, interactions, states,
data meaning, calculations, defaults, validation, history, synchronization,
offline behavior, errors, permissions, accessibility and device behavior.
Reference necessary product designs and assets. Mark gaps explicitly. Keep
implementation choices in separate technical documents.

## Project identity

The owner can register and select a local project,
Wimzo, and other personal projects. Each project has a purpose, requirements,
feature delivery map, work history and unresolved questions.

## Authoritative specifications

Each project owns canonical, versioned
PRDs that define intended behavior. Feature specifications may refine a rule but cannot
silently contradict it. Accepted choices are expressed directly in the relevant PRDs; review history records their provenance.


## Project execution policy

Every project owns an editable allowlist of providers, authentication routes, harnesses and models. The owner can restrict Anthropic to one project while using Codex elsewhere. Effective choices are the intersection of global permitted routes, project policy and currently available runtime capabilities. An empty explicit allowlist permits no workers; it must never mean unrestricted access.

Chat and UI expose the same policy. Changes record the author and revision. Recommendations and approval selectors offer only permitted options. Policy is checked again immediately before each new run, including child runs, resumed work and direct launch calls. Revocation prevents further launches and turns; a running turn checkpoints and stops at the next supported safe boundary, with its actual cancellation state shown.

TypeSafe Jev is the only paid inference API allowed for now. Coding workers use supported existing subscription access. A project allowlist cannot authorize another paid API or silently fall back to one when a subscription is unavailable. Secrets remain on this Mac and are never included in a task, PRD, model description or handoff.

## Canonical product descriptions

Product rules live in the relevant feature PRD. A separate decisions document is not required to interpret behavior. Review provenance and earlier versions remain available through history. Internal identities support traceability without ticket numbers in PRD prose.
