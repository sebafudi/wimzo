# Orchestrator and product workflow

Status: design specification. Implementation and verification status are documented in README.md.

## Chat-first completion

The owner can discover and select a project,
discuss requirements, accept a concrete change, start or reprioritize work,
report a problem, inspect status and evidence, pause or cancel work, review a
candidate, decide release, inspect automations, and improve Wimzo through
chat.

## Needs you inbox

Decision-needed, failure, completion and meaningful
change events become durable inbox items. If a client cannot receive an
unsolicited update, the item appears on the next interaction or reconnection.

## Exact approvals

An approval is bound to the exact proposed
requirement revision or candidate result, its scope, and the relevant revision
of current state. A later or different proposal needs a new review.

## Honest notifications

The product distinguishes delivered,
undelivered and pending notifications. A disconnected client does not imply
that cancellation or another control reached the service.

## Product guide

The main conversation understands product intent,
requirements and delivery state. Technical workers inspect code and investigate
technical questions when requested. The guide receives their relevant findings
without routinely loading implementation details into the product conversation.

## Conversation continuity

Codex app is an initial supported chat
client. Other compatible clients can access the same project context and
operations. Project focus, decisions, open questions and handoffs survive
finite sessions and client changes. Unavailable client capabilities are explicit.

## Requirement lifecycle

A requirement revision is Draft, Accepted,
Superseded or Retired. A direct edit becomes a candidate revision. The owner
reviews the before/after content, affected features and scope before acceptance.

## Review record

Acceptance records the actor, exact diff, feature references, specification revision and source change. Proposed changes are never
auto-accepted by a worker, monitor or outside commit.

## Work authorization

Accepting a specification change does not
authorize unrelated work. A work approval makes only its bounded scope eligible
for scheduling. One explicit approval may accept both a displayed specification
amendment and its associated work scope. Routine subtasks and repairs within
that scope do not require repeated approval; material scope changes do.

## Outside commits

A newly pushed or externally created commit is
inspected for observable behavior, affected requirements and evidence. Matching
behavior updates evidence. A functional change produces a before/after
proposal. Existing accepted PRDs remain authoritative until the owner accepts
an amendment.

## Ambiguity and conflicts

A report or source may be classified as a
bug, environment issue, duplicate, unreproduced report, gap or change request.
Behavior that violates an accepted rule is a defect. Missing intended behavior
is a requirements gap. Changing behavior that already matches its rule is a
requirements change. Conflicting rules are a specification conflict.
Contradictory sources show their scope and evidence and require an accepted
resolution. Unknowns remain visible instead of being inferred into rules.

## Work journeys

A feature request follows: draft behavior and
criteria, owner approval, Approved queue, execution, verification, result
review, and a release decision. A confirmed implementation defect preserves the
requirement while adding repair and regression evidence.

## Work states

The product visibly distinguishes Needs approval,
Approved, Running, Verifying, Needs result review and Accepted. Paused,
Blocked, Failed, Canceled and Superseded are explicit side states. Merge and
deployment are separate release records.

## Delivery dimensions

Feature maps separately show intended,
implemented, verified, accepted and released state, including the relevant
specification and deployed version. An unfinished requirement never appears as
implemented merely because it is accepted.


## From conversation to delivery

Chat saves each idea under its selected project before work starts. A message may create several related ideas. An explicit request to keep something for the future leaves it in the future backlog. Other ideas become eligible for a requirements worker automatically, subject to project policy, capacity and the configured bounded preparation budget. Unknown project selection is resolved before dispatch.

The requirements worker reads the current PRDs and prepares the smallest coherent before/after amendment. It may investigate the code but does not implement behavior or accept its own proposal. The resulting review appears in the owner's inbox and Board with its affected features, acceptance criteria, proposed execution scope and suggested worker setup. Existing approval gates for product behavior remain in force.

Request changes saves the owner's note against the exact revision and queues a requirements revision run. The owner can edit the proposed harness, model and thinking level independently for planning and implementation. Accepting the displayed PRD and its associated bounded work makes that work eligible for scheduling. A duplicate event or repeated click cannot create another logical job.

The normal flow is a separate planning run followed by bounded implementation runs. The plan is a technical handoff and does not require another routine approval if it fits the accepted scope. Material changes to scope or product behavior return for review. The checkbox **Implement directly** skips a separate planning run; the implementation worker must still plan before editing. One worker need not own the whole feature.

Verification runs after implementation. The owner reviews the combined feature result and its exact candidate, with readable changes and evidence. Accept, request changes and resume operate on this feature-level result even when many worker runs contributed. Result acceptance, local activation and source publication remain separate actions.

## Bugs and behavior changes

A bug is an observed failure to meet accepted behavior. Repair it against the existing PRD and attach regression evidence. A request to change intended behavior produces a PRD amendment. The board labels the two clearly; neither classification silently rewrites the other. Missing rules and uncertain reports remain visible for clarification.

## Related features

- [Projects and access](projects/PRD.md)
- [Context and worker runs](context-and-runs/PRD.md)
- [Automation](automation/PRD.md)
- [Recovery](recovery/PRD.md)
- [Run changelogs](run-changelogs/PRD.md)
