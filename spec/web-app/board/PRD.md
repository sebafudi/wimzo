# Product board and worker proposals

Status: design specification. Implementation and verification status are documented in README.md.

## Product definition and delivery board

Requirements is the project's current product definition. It retains project-owned documents, rendered Markdown, file history, exact comparisons and recorded acceptance. Draft intent and accepted intent remain distinguishable from implemented and released behavior.

A separate Board replaces the Work tab. It shows ideas not yet represented in a PRD, PRDs and proposed changes awaiting review, approved requirements and work waiting for implementation, current work, results awaiting review, completed work and blocked work. Cards use readable titles and show relevant waiting reasons. Technical identities remain available without dominating the view.

## Automatic progress

The board derives placement from saved ideas, specification decisions, work approvals, actual runs and result reviews. Changes from chat, workers and the dashboard appear automatically. Moving a visual card does not invent approval or progress. Planning and implementation labels reflect reported work, not elapsed time. Unlinked change-request notes remain available for future agent pickup.

An idea can be linked to its exact proposed specification and work. Accepting a requirement alone does not imply that implementation is approved or complete. Approved requirements lacking a bounded work proposal remain visibly waiting for that proposal. Blocked, paused and failed work keeps its reason and saved context.

## Reviewable work and worker selection

Before approving a PRD and its associated work, the owner can inspect the exact specification change, objective, scope, acceptance criteria, permissions, execution bounds and proposed worker setup. A clearly labelled combined approval accepts that exact PRD amendment and queues only that displayed work. Existing accepted PRDs can have separate bounded work approvals.

The proposed setup identifies the worker harness, model and thinking level. The owner can change it to another supported setup before approval. The selected setup is recorded with the work and used for execution. Changed specifications, work scope or worker settings invalidate an earlier prepared approval. Unsupported or unavailable setups explain why they cannot run.

## TypeSafe recommendations

External TypeSafe recommendations require explicit local opt-in and a configured key. Enabling them authorizes transmission of task objectives, scope, acceptance criteria and requirement metadata to TypeSafe. Manual selection remains available.

Recommendations use the displayed work description and supported worker options. They do not accept PRDs, authorize work, change permissions or start agents. The server retains the API credential privately. Unchanged recommendations are reused, and ordinary board refreshes do not invoke a model. If Jev is unavailable or finds no suitable option, the owner can still select a supported setup manually.

## Acceptance scenarios

- Save an idea, reconnect, and find it on the same project board.
- Link an idea to a PRD proposal; the board reflects the proposal's current review and delivery state without manual card movement.
- Inspect a PRD diff and bounded scope, change the proposed model and thinking level, and approve once. Only the reviewed version and selected setup are queued.
- Edit the source PRD after opening approval. The stale approval fails without accepting the old proposal or launching work.
- Observe queued, running, verifying and result-review transitions from actual saved work state, including changes made from chat.
- Refresh repeatedly without extra recommendation calls. A provider failure preserves manual selection and does not fabricate a recommendation.
- Review a result or request changes from its board card. The exact result acceptance and durable note behavior remain available.

See [implementation notes](../../../README.md) for execution and verification details.


## Related workflow

The [orchestrator workflow](../../orchestrator/PRD.md) defines automatic idea pickup, revision feedback, planning and result review. Expand a feature card to inspect its bounded worker runs while retaining one feature-level approval and outcome.
