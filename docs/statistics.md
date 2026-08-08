# Execution statistics

FLUJO records local, metadata-only execution statistics for the experimental statistics feature. The event contract is versioned in `src/shared/types/statistics.ts`, and every event is rebuilt from an explicit allowlist before it can be persisted. Readers ignore malformed records and unknown schema versions.

## Storage and lifecycle

Events are appended as one JSON object per line beneath `db/statistics/`, partitioned by UTC day as `YYYY-MM-DD.jsonl`. Appends are serialized independently per partition so concurrent runs retain their event order without blocking other days. Recording is best-effort: serialization, append, recovery, and retention failures never reject or change a flow execution.

Partitions older than 90 days are pruned asynchronously after a successful append. Retention cleanup is isolated from the write result and may be retried by a later append.

Each event adds a small, bounded number of optional fields (correlation ids, revision fingerprints, byte counts, a cache outcome, and phase durations). Every field is a scalar or a fixed-key record, so partition growth stays proportional to the number of runs, attempts, tool calls, and subflow calls rather than to payload size. If a workload produces unacceptable partition growth, reduce dimension cardinality at the producer; payload capture is never an option.

## Safe event contract

Schema version 1 supports:

- `run.started`, `run.paused`, and `run.finished`
- `node.visit`
- `model.attempt`
- `tool.invocation`
- `subflow.invocation`
- `scheduler.fire` with `fired` or `queued` admission outcomes
- `scheduler.skip` with a classified skip reason

Records contain only allowlisted IDs, display names, sources, outcomes, durations, numeric usage, and permitted correlation IDs. Optional metadata is omitted when unavailable rather than inferred.

### Schema compatibility and replay

All fields added after the first release are OPTIONAL additions to schema version 1:

- correlation: `invocationId`, `attemptId`, `parentRunId`, `parentNodeId`, `childRunId`;
- revision: `revisions.flowRevisionId`, `revisions.promptRevisionId`, `revisions.nodeConfigRevisionId`, `revisions.toolDefinitionRevisionId`;
- payload metadata: `payload.requestBytes`, `payload.responseBytes`, `payload.requestChars`, `payload.responseChars`, `payload.requestCategory`, `payload.responseCategory`;
- cache: `cacheOutcome`;
- timing: `phases.<phase>`.

Older version-1 records therefore replay unchanged, and records that carry the new fields are readable by any version-1 reader. Unknown schema versions are still rejected outright. A future change whose meaning is incompatible with version 1 must raise the schema version and add an explicit normalizer rather than redefining an existing field.

Correlation and revision identifiers are bounded to 128 characters and a conservative character set; numeric metadata is finite, non-negative, and capped by `STATISTICS_MAX_METRIC_VALUE`. Content types are normalized to the fixed categories `json`, `text`, `image`, `audio`, `video`, `binary`, `multipart`, `empty`, and `unknown`; raw MIME strings are never persisted.

### Exclusions

Prompts, messages, completions, tool schemas, tool arguments/results, trigger context, URLs, raw provider errors, API keys, encrypted credentials, and decrypted secrets are never part of the statistics schema. The statistics service logs only bounded diagnostics such as event type, partition day, and invalid-record count; it does not log the rejected record or runtime payload.

Payload metadata describes SIZE and SHAPE only. A request of 812 bytes categorized as `json` is recorded; its content is not read into the event, not hashed into the event, and not retained anywhere.

Credential grouping uses an installation-local HMAC key stored beside the statistics data. Only a fixed-format opaque fingerprint is included in events and aggregate filters; neither the credential nor the HMAC key is serialized into event records or logs.

### Revision fingerprints

A revision identifies a saved configuration, not a run. Where an immutable saved id exists it is used directly. Otherwise `statisticsRevisionId()` derives an opaque `rev_…` fingerprint with the same installation-local HMAC key used for credential fingerprints, so a fingerprint cannot be reversed to its configuration and cannot be correlated across installations. The fingerprinted material (flow graph, prompt/template configuration, node configuration, tool definition) is never persisted.

## Counting semantics

- **Logical run:** counted once per `runId`, even when provider retries produce multiple `model.attempt` events or a paused run later resumes. A run that started but never reached a terminal or paused record is counted in `runsIncomplete` and is excluded from successes and failures.
- **Provider attempt:** every attempt is counted. Retries of one logical model call share an `invocationId` and each carry their own `attemptId`; a repeated `attemptId` is treated as a duplicate observation and dropped.
- **Tool invocation:** one logical invocation per `invocationId`. When both `ModelHandler` and a self-orchestrating adapter observe the same call, the duplicate is dropped instead of double counted.
- **Subflow call:** parent-side metadata recorded under the PARENT `runId`. The child reports its own lifecycle under its own `runId`, so a subflow call never inflates logical-run totals. `cancelled`, `timeout`, and `incomplete` outcomes are counted in `subflowIncomplete` and are neither successes nor failures.
- **Scheduler admission:** `scheduler.fire` remains event-level metadata and does not inflate logical-run totals. `scheduler.skip` is the canonical source for scheduler skip counts.

## Timing boundaries

Durations are measured with a monotonic clock. Phases record REAL measured boundaries only; an unavailable boundary is omitted instead of estimated.

| Phase | Meaning |
| --- | --- |
| `queue` | Time spent waiting before work started. |
| `approval` | Time spent awaiting an approval decision. |
| `provider` | One provider/network call, inclusive of transport. |
| `tool` | One tool invocation from dispatch to result. |
| `narration` | Narration work where the adapter exposes a boundary. |
| `engine` | Engine overhead where a boundary is measurable. |
| `subflowWait` | Parent-side wait before a child subflow starts. |
| `subflowExecution` | Child subflow execution observed by the parent. |

Phases may OVERLAP (a `tool` phase can contain a nested `subflowExecution` phase), so aggregates report each phase independently and phases must never be summed into a single wall-clock total.

## Cache semantics

`cacheOutcome` is explicit, not derived from cached-token totals:

- `hit`, `miss`, and `write` each count one cache REQUEST and form the hit-rate denominator;
- `mixed` counts one request and contributes to both hits and writes;
- `unknown` and `unsupported` are counted in `cache.unknown` and are excluded from the denominator, so a provider that cannot report cache behaviour never looks like a 0% hit rate.

Cached and cache-write token totals remain available separately under `usage`.

## Aggregation

The aggregate API reads only the selected UTC partitions, deduplicates by event id, and groups events by logical `runId`. Run-level filters apply to the run; model, provider, credential, node, tool, subflow, cache, and content filters include a run when at least one matching contribution exists, and only matching contributions supply the corresponding metrics.

Aggregates report counts, failure counts, duration metrics (count/total/average/p50/p95), token usage, cache totals with an explicit denominator, tool request/response size metrics, classified failure counts, normalized content-category counts, and phase timings, both overall and per UTC day. Rankings are produced for flows, planned executions, models, providers, credentials, nodes, tools, subflows, and revisions.

Ranking order is user-selectable (`sort` and `direction`) and always deterministic: the requested metric first, then the identifier as a stable tiebreak. Every dimension is capped at `STATISTICS_MAX_RANKING_ROWS` rows and the capped dimensions are reported in `truncatedDimensions`. Ranges are limited to 90 days, filters to 50 values per dimension, and aggregate responses are cached for five minutes with a partition-freshness check on both sides of the read.

## API views

`GET /api/statistics` keeps the local-request guard, the encryption-lock guard, generic error bodies, and `Cache-Control: private, no-store` for every view.

- `view=aggregate` (default): aggregates, daily buckets, and rankings.
- `view=detail`: a bounded, cursor-paginated page of metadata-only rows for `kind=runs|tools|subflows`. Pages default to 50 rows and are capped at 200; the candidate scan is capped at 5,000 rows. Rows contain only allowlisted metadata — identifiers, outcomes, error classes, durations, byte counts, categories, and cache outcomes.
- `view=compare`: exactly two cohorts, each selected by revision id and/or its own date range, evaluated under the same dimension filters. The response returns each cohort's sample size and summary plus absolute and relative deltas for run count, run failure rate, run duration P95, tokens, tool calls, tool failure rate, provider failure rate, cache hit rate, and subflow failure rate.

Comparisons are OBSERVATIONAL: cohorts can differ in traffic, provider, retry, and source mix. Sample sizes are always returned, a cohort below `STATISTICS_MIN_COMPARISON_SAMPLES` runs is flagged, differing cohort ranges are flagged, and a percentage delta is `null` when the baseline value is zero.
