# Web application

Status: design specification. Implementation and verification status are documented in README.md.

## Optional dashboard

The dashboard can show projects, decisions, the
Needs you inbox, approved queue, active work, evidence, releases and
automations. It exposes the same operations as chat and introduces no exclusive
business action.


## Product views

The primary views are Requirements and Board. Requirements explains the product; Board explains proposed and running work. Both use readable feature names, concise status and the same project selection. Technical hashes, ticket numbers, raw JSON and diagnostic logs are secondary details.

A private local access key persists in this tab so refreshing keeps the user signed in. The key is removed from the visible URL, can be forgotten explicitly, and is cleared when rejected. The server still validates every authenticated request.

- [Requirements tree, history and diffs](requirements/PRD.md)
- [Delivery board](board/PRD.md)
