# User-facing run changelogs

Status: design specification. Implementation and verification status are documented in README.md.

## Requirement

**User-facing run changelog.** Every Wimzo-managed run has a durable,
easy-to-read changelog, retrievable through chat by project, task or run. This
includes implementation, investigation, verification and script runs, across
worker runtimes. The owner can understand its outcome without opening code,
technical logs or the dashboard.

The changelog uses concise, plain product language and explains:

- **What changed:** the behavior added, improved or fixed, and why it matters
  to the user.
- **What is possible now:** concrete things the user can now do, with a short
  example when helpful.
- **Availability and limits:** what is usable now, what exists only in a
  candidate or awaits verification, acceptance or activation, and any remaining
  limitation or user action. A completed run never implies a released feature.

Every outcome is covered, including failure, pause, cancellation and runs with
no user-visible change. If nothing became newly available, say so plainly and
summarize what was checked, learned or left unfinished. Do not invent benefits
or treat a test pass as new product functionality.

Save the changelog with progress at meaningful checkpoints and update it when
the run stops. An abrupt interruption preserves the last saved account and
marks incomplete or unknown outcomes. Retries and resumed runs retain their
own entries and links to earlier attempts, without claiming earlier work as
newly completed. Entries survive reconnects, restarts and runtime changes.

Link supporting evidence and detailed logs for optional inspection. Existing
notification and automation rules still apply: storing a changelog does not
require repetitive chat messages or a model invocation for unchanged monitoring.

## Acceptance scenarios

1. After a successful feature or fix run, the owner asks in chat what changed
   and what they can do now. The response explains the practical outcome and
   availability without requiring technical vocabulary or the dashboard.
2. A verified candidate awaiting activation is described as available for
   review or testing, not as already usable in the active product.
3. A verification-only or no-change run explicitly says that no new product
   capability became available and briefly explains its useful outcome.
4. Failed, canceled, paused and abruptly interrupted runs retain an honest
   account of saved progress, limitations and unknowns, even if the worker
   never produced a final response.
5. After reconnect or restart, the owner can retrieve an earlier run's
   changelog. A retry or resumed run preserves the relationship between
   attempts and reports only its own additional progress.
