# Model catalog and recommendations

Status: design specification. Implementation and verification status are documented in README.md.

## Concise, editable model descriptions

The catalog contains actual provider model IDs, supported harnesses, thinking levels, availability and short descriptions of useful work. Descriptions cover common strengths, cost or latency considerations and situations worth escalating. Discovery facts are separate from editable preferences. Unknown capabilities and unverified recommendations are labeled.

The owner can edit descriptions through chat or the UI. AI can propose or apply an explicitly requested edit with an audit trail, but cannot invent availability, change project access or silently rewrite preferences. Recommendations read the current saved catalog dynamically. An edit invalidates only affected cached recommendations.

## Initial preferences

Use the cheapest available model that is likely to complete the bounded work. Start with concise local preferences, subject to the actual installed model catalog:

| Model | Initial preference |
| --- | --- |
| Codex GPT-6 Luna (`gpt-6-luna`) | Fast, affordable default for small edits, extraction, focused checks and read-only verification; lowest cost and latency of the current generation. Escalate to GPT-6 Sol when the change spans several files or the first attempt fails its checks. |
| Codex GPT-6 Sol (`gpt-6-sol`) | Workhorse for routine implementation, maintenance and everyday coding after a clear plan; moderate cost with higher thinking available when needed. Escalate to GPT-6 Astra or Claude Opus 5.5 for unclear requirements, cross-cutting design or repeated failed verification. |
| Codex GPT-6 Astra (`gpt-6-astra`) | Frontier Codex model for the most demanding planning, debugging and complex review; highest Codex cost and latency. Use only when ambiguity or risk justifies it. |
| Codex GPT-5.6 Luna (`gpt-5.6-luna`) | Older fast and efficient model for simple bounded tasks when a GPT-6 model is unavailable. Prefer GPT-6 Luna when both are available. |
| Codex GPT-5.6 Sol (`gpt-5.6-sol`) | Older coding model for complex work; a fallback when GPT-6 Sol is unavailable or pinned by project policy. |
| Codex GPT-5.6 Terra (`gpt-5.6-terra`) | Older balanced model for straightforward implementation and integration; a middle fallback between the 5.6 Luna and Sol roles. |
| Claude Sonnet 5 (`claude-sonnet-5`) | Routine implementation and focused review on the Claude subscription route; balanced cost and latency. Escalate to Claude Opus 5.5 for architecture or judgment-heavy review. |
| Claude Opus 5.5 (`claude-opus-5-5`) | Preferred for difficult planning, architecture and judgment-heavy review where a confident wrong call is expensive; highest Claude cost and slowest responses. Hand bounded implementation back to a cheaper model once the plan is clear. |

Model IDs come from provider metadata; descriptive names are labels, never fabricated executable model IDs. Other discovered models remain available for description without receiving an invented ranking. Preferences are not benchmark claims. Use provider metadata, verified observations and owner edits to improve them over time, retaining their source and update date.

## Recommendations

Jev chooses from exact eligible harness/provider/model/thinking combinations for the current phase. Planning and implementation can use different setups. Compact task context, current capability descriptions and project policy inform selection. Do not send full repository contents, secrets or unrelated project state.

A recommendation never grants permission or expands task scope. The owner can override it before approval. Cache unchanged judgments using the task, phase, catalog revision and policy revision. Ordinary refresh and queue checks make no inference calls. A Jev failure preserves manual selection and does not prevent an otherwise authorized configured worker from running.
