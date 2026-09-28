# Self-development and recovery

Status: design specification. Implementation and verification status are documented in README.md.

## Self-project

Wimzo can be selected like any other project. Its
own improvements follow the normal requirement, approval, work, verification,
review and safe activation flow.

## Safe updates

A Wimzo update is developed separately, tested with
representative workflows and recovery cases, reviewed for migration impact,
activated only after acceptance, and retains a known-good release and state
backup. Recovery remains possible if the new Wimzo version cannot start.

## Apple evidence

iOS and watchOS checks report exactly which simulator,
physical device, tool and capability were available. Native checks, visual
acceptance and real-device or sensor evidence remain separate. Unavailable
watch or device checks are reported as unavailable, never as passing.

## Script waiting

A build or test operation can wait for completion
without an active model. Results wake the workflow and retain compact summaries
plus detailed artifacts. The pilot must honestly record which native GUI and
watchOS interactions were not verified.
