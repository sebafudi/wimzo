# Wimzo product map

Status: design specification. Implementation and verification status are documented in README.md.

Wimzo is a personal local product workspace. Conversation turns project ideas into reviewed product requirements, bounded worker runs and verified software. The local machine is the current execution environment. Remote workers and external publishing remain separate choices.

## Feature map

| Area | Product description |
| --- | --- |
| [Orchestrator](orchestrator/PRD.md) | Ideas, requirements review, planning, implementation and result review |
| [Projects](orchestrator/projects/PRD.md) | Canonical project knowledge and provider/model access |
| [Context and runs](orchestrator/context-and-runs/PRD.md) | Focused 150K context target, work splitting and durable handoffs |
| [Automation](orchestrator/automation/PRD.md) | Deterministic scheduling, watches and reusable tools |
| [Recovery](orchestrator/recovery/PRD.md) | Safe updates, restarts and evidence |
| [Run changelogs](orchestrator/run-changelogs/PRD.md) | What changed and what is available now |
| [Workers](workers/PRD.md) | Shared coding tools, context, permissions and outcomes |
| [Pi](workers/pi/PRD.md) | Configurable worker using supported subscription access |
| [Codex](workers/codex/PRD.md) | Official local Codex SDK worker |
| [Claude](workers/claude/PRD.md) | Claude Agent SDK worker when supported access is available |
| [Models](workers/models/PRD.md) | Editable capability descriptions and Jev recommendations |
| [Web application](web-app/PRD.md) | Optional view of the same chat-accessible product |
| [Requirements](web-app/requirements/PRD.md) | Markdown, feature tree, history, comparison and provenance |
| [Board](web-app/board/PRD.md) | Automatic delivery state and owner inbox |

## Product principles

Chat is a complete interface. Each project owns its canonical feature PRDs. PRDs describe intended behavior and never become accepted merely because code exists. Bugs are violations of that behavior; change requests amend it. Worker completion, verification, owner acceptance, activation and publication remain distinguishable.

Every workflow preserves history, exact approvals and recovery state. Clear feature descriptions replace visible ticket identifiers. Review records explain where a rule came from, while the rule itself lives in its feature PRD.

TypeSafe Jev is the only paid inference API currently authorized. Coding workers use supported subscription access. Project policy can further restrict providers and models. No runtime silently changes authentication or billing route.

## Reading status

This reorganized set carries forward the earlier product contract and proposes the September 21 workflow additions. Review history determines acceptance, not status text copied into older files. The current implementation and verified limitations are tracked separately in delivery records. New SDK adapters, automatic requirements preparation, run decomposition, editable model policy, a graphical map and passage-level blame are proposed behavior until implemented and verified.
