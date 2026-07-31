# Execution statistics

FLUJO records local, metadata-only execution statistics for the experimental statistics feature. The event contract is versioned in `src/shared/types/statistics.ts`, and every event is rebuilt from an explicit allowlist before it can be persisted. Readers ignore malformed records and unknown schema versions.

## Storage and lifecycle

Events are appended as one JSON object per line beneath `db/statistics/`, partitioned by UTC day as `YYYY-MM-DD.jsonl`. Appends are serialized independently per partition so concurrent runs retain their event order without blocking other days. Recording is best-effort: serialization, append, recovery, and retention failures never reject or change a flow execution.

Partitions older than 90 days are pruned asynchronously after a successful append. Retention cleanup is isolated from the write result and may be retried by a later append.

## Safe event contract

Schema version 1 supports:

- `run.started`, `run.paused`, and `run.finished`
- `node.visit`
- `model.attempt`
- `tool.invocation`
- `scheduler.fire` with `fired` or `queued` admission outcomes
- `scheduler.skip` with a classified skip reason

Records contain only allowlisted IDs, display names, sources, outcomes, durations, numeric usage, and permitted correlation IDs. Optional metadata is omitted when unavailable rather than inferred.

Prompts, messages, completions, tool schemas, tool arguments/results, trigger context, URLs, raw provider errors, API keys, encrypted credentials, and decrypted secrets are never part of the statistics schema. The statistics service logs only bounded diagnostics such as event type, partition day, and invalid-record count; it does not log the rejected record or runtime payload.

Credential grouping uses an installation-local HMAC key stored beside the statistics data. Only a fixed-format opaque fingerprint is included in events and aggregate filters; neither the credential nor the HMAC key is serialized into event records or logs.

## Aggregation

The aggregate API reads selected UTC partitions and counts a logical run once by `runId`, even when provider retries produce multiple `model.attempt` events or a paused run later resumes. Scheduler fire/queue admission remains event-level metadata and does not inflate logical-run totals. `scheduler.skip` is the canonical source for scheduler skip counts.
