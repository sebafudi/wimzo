# Requirements tree, history and changes

Status: design specification. Implementation and verification status are documented in README.md.

## Product structure

Each project's canonical specifications form a real folder tree and a feature map. Wimzo groups workers and their provider-specific features, the orchestrator, and the web application. Feature PRDs explain current or intended behavior in plain language. Documents can number sections starting at 1 locally, but never use ticket numbers as requirement headings.

The tree has expandable folders and descriptive files. A feature map links those same documents and shows relationships and intended, implemented, verified and released state without duplicating the source of truth. No separate decisions folder appears in the product tree. Product choices belong in their relevant PRD; historical review records remain available as provenance.

## Read and compare

Render Markdown for reading and, where possible, show additions and removals in rendered context. Raw Markdown and code diffs remain available. Changed files have M, A or D markers, added and removed line counts, and a subtle matching row tint. Counts and color describe the selected comparison basis honestly.

The right sidebar shows the selected file's complete available history with pagination where needed. Clicking a version shows that exact change from its predecessor. A Compare to control selects another saved version. Historical content and current draft content remain distinguishable; reviewing a draft never mutates an accepted snapshot.

## Review and provenance

Accept changes records the exact displayed revision. Request changes saves the owner's note with the project, feature and reviewed versions so a worker can pick it up. A stale comparison cannot approve different bytes.

A proposed blame mode annotates PRD passages with the change request and accepted revision that introduced or last changed them. It opens that request's rationale and diff. Imported history without reliable attribution is labeled unknown, never inferred from the latest request. Document moves preserve provenance.

## Acceptance examples

- Navigate Workers, Pi and its PRD, then compare two saved versions in the right sidebar.
- Identify additions and removals from colored rows and line counts without opening JSON or ticket details.
- Follow a PRD passage to its originating request, or see that provenance is unavailable.
