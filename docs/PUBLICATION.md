# Publication scope

This repository is a cleaned public snapshot of Wimzo, an actively developed personal project. It is not the complete private development history.

## Included

- Application source, worker adapters and regression tests.
- Product specifications, labeled as intended behavior rather than proof of completion.
- Portable setup, synthetic demonstration and recovery utilities.
- Local-use documentation, security boundaries and CI configuration.

## Excluded

Private runtime databases, credentials, transcripts, run evidence, backups, worktrees, machine topology, personal environment inventories and unrelated project data are not part of this repository. The original private repository and a local backup retain the earlier history.

## Publication changes

- Replaced machine-specific setup with portable project registration.
- Added a synthetic demo that disables background dispatch.
- Removed automatic deletion of global Claude temporary directories.
- Required explicit opt-in before external worker recommendations.
- Clarified that worktrees and approval roles are not OS security boundaries.
- Updated vulnerable transitive dependency chains through the Pi SDK update.

## Verification

See the Checks workflow and its logs for the current revision. Tests use fixture data and mock provider calls. They do not prove live provider authentication, autonomous agent quality or production readiness. Dependency auditing and source-pattern scanning reduce risk but are not a guarantee that every vulnerability or secret has been detected.

Local release check: Node.js 24.19.0, TypeScript check passed, 288 tests passed with zero failures or skips. Full npm audit reported zero known vulnerabilities. Source pattern scan reported no findings. Synthetic demo and fresh setup were verified locally. Live provider execution was not tested.
