# Security and trust boundaries

Wimzo is an experimental local tool for one trusted user. Do not expose it to the internet or untrusted users.

The HTTP service is loopback-only and uses bearer credentials. Those credentials, database files, run traces, project snapshots and provider authentication belong outside Git. The health endpoint is unauthenticated and reports service metadata.

Roles, approval records and worktrees are coordination mechanisms. A process running as your OS user can select a CLI role and access local files. Shell-capable agents and approved scripts can execute host commands. Use disposable, sanitized workspaces and verify runtime-specific sandbox behavior before enabling workers. Direct file guards do not establish a complete privacy boundary for shell commands or recursive searches.

Starting the normal service on existing state enables scheduling ticks for previously approved work. Use the synthetic demo for inspection without dispatch. The demo does not call external inference services.

External TypeSafe recommendations are off by default. Enabling WIMZO_ENABLE_EXTERNAL_RECOMMENDATIONS=1 with a key allows transmission of task objectives, scope, acceptance criteria and requirement metadata to TypeSafe. Do not enable it for confidential project content without appropriate authorization. Manual worker selection does not require external recommendations.

There is no automatic global cleanup of other Claude temporary directories in this publication copy.

For a vulnerability, contact the maintainer privately through the LinkedIn profile linked from https://sbfd.me. Do not include credentials or private project content in a public issue.
