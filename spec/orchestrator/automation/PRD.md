# Automation and reusable tools

Status: design specification. Implementation and verification status are documented in README.md.

## Repeatable automation

Scripts and monitors execute established
procedures with structured results. They do not require model polling. Repeated
unchanged observations produce no model invocation. Actionable changes queue at
most one logical follow-up despite duplicate delivery or restart.
Expired or canceled watches stop observing and dispatching work.

## Automation honesty

Watches show health, last successful observation,
next check, recent events, retry status and pause/cancel controls. Network or
authentication failure is monitor health state, not a false product failure.

## Reusable capabilities

Established procedures can be saved, discovered
and reused as executable tools with clear inputs, outcomes, access needs and
side effects. The owner and workers can find existing capabilities before
creating another. Detailed logs remain available without filling every chat.

## Learning from repetition

Workers may suggest a reusable script or
brief skill at normal work checkpoints when a procedure proves useful. Verify
the executable steps before relying on them. Changes to Wimzo's workflow
follow its requirements review process. No additional model runs on a timer
solely to search for automation ideas.
