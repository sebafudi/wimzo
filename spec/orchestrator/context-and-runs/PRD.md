# Focused context and bounded worker runs

Status: design specification. Implementation and verification status are documented in README.md.

## Context relevance

A response uses the selected project and question
to include the compact base, affected requirements, dependencies, applicable rules,
open conflicts, active work, acceptance criteria and relevant observations.
Cross-project information is included only for relevant, authorized requests
or dependencies. Exact applicable rules and exceptions remain available;
summaries help navigation and do not replace authoritative requirements.

## Context freshness

Every context brief identifies source revisions,
generation time, state watermark and known omissions. Accepted edits, task
transitions and new evidence invalidate affected summaries. Consequential
decisions refresh context first.

## Context inspectability

The owner can inspect included sources,
revisions, inclusion reasons and omitted categories. A context receipt is kept
for later investigation. Drafts, accepted rules, superseded rules,
observations and unknowns are labelled distinctly.

## Bounded task

Each work item carries stable feature references, an
accepted specification revision, objective, acceptance criteria, scope,
permissions, budget, deadline and source candidate. Workers cannot amend
accepted intent.

## Capacity queue

Approved work waits when dependencies, priority,
worker capacity, required tools or resources prevent a start. The owner can
approve several tasks and reprioritize them in chat. Queue waiting requires no
model session and no model-based polling.

## Worker limits

Initially at most two active technical workers run,
including reviewers and nested workers. At most one GUI controller is active
across the local system by default. Monitors and fixed scripts do not consume technical worker slots,
though ordinary CPU and tool limits still apply.

## Ownership

One active writer owns an isolated working copy or overlapping change
area. A worker result contains summary, candidate revision or diff, checks,
artifacts, unresolved questions, reported usage and an exit reason.

## Verification and review

Worker success advances to verification,
never directly to owner acceptance. Evidence names the requirement revision,
candidate, check, environment, time and result. Stale or earlier-candidate
evidence cannot pass a later candidate.

## Pause and cancel

The owner can pause dispatch, request a checkpoint,
cancel a run, or stop new work. The product reports requested and acknowledged
state separately. A task remains recoverable when a client disconnects.

## Recovery

Restart and reconnection replay missed events without
repeating side effects or duplicating jobs. A checkpoint preserves completed
work, evidence, unresolved questions, partial-operation status and next steps.
Save progress at meaningful milestones without depending on a final warning.

## Limit handling

Track context capacity, provider allowance and task
execution limits separately. Use available telemetry or labelled estimates and
show unknown capacity honestly. Warn early and stop starting new work at a
configured threshold, reserving capacity for checkpointing or handoff where
possible. Thresholds are pilot settings, not guaranteed provider notice.
Context compaction may help continuation but does not replenish provider allowance.

## Abrupt limits

When a provider stops abruptly, preserve saved edits,
logs, task mapping, candidate revisions and persisted checks. Transition
to Paused with the reason and resume plan. Resumption rechecks requirements,
outside changes and incomplete side effects and does not replay external work.


## Context budget

Plan features as several coherent runs rather than filling one worker's context. Each run receives its objective, exact applicable PRD sections, relevant source paths, constraints, dependencies, current candidate and acceptance checks. It can retrieve more context when needed. Never preload every project, all history or every available tool definition.

The normal target is at most 150,000 context tokens, including instructions, tool definitions, history, tool results and output allowance. The effective budget is always below the selected model's supported limit. Start a checkpoint or split early enough to leave space for the next tool result and a durable handoff. A proposed starting default is a checkpoint trigger around 120,000 tokens with at least 30,000 reserved tokens. These thresholds are configurable and marked as estimates when exact telemetry is unavailable.

An occasional larger run is allowed when preserving tightly coupled context is useful. Its reason and bound are recorded before proceeding. The proposed default exception cap is 180,000 tokens, still constrained by the model's smaller limit and output reserve. Reaching a model limit is never a reason to reset an unfinished feature or discard work.

## Run decomposition and handoff

A planner decomposes approved feature scope into independently checkable slices with dependencies, file ownership and expected context needs. Only independent slices run concurrently, within the shared worker limit. Overlapping writers are serialized. All slices remain children of one feature request and inherit its approval, permissions and total budget; splitting must not multiply the budget or bypass policy.

Every handoff preserves the current candidate or dirty diff, completed work, exact checks and results, affected PRD revisions, unresolved questions, incomplete side effects and the next bounded action. A fresh worker verifies these references and refreshes changed context before continuing. Provider session history is optional convenience, not the only saved state.

The board can expand a feature into planning, implementation slices and verification runs. Routine successful child runs do not require individual owner result approval. A material deviation or final combined result returns to the owner.
