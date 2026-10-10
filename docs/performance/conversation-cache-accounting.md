# Conversation cache payload accounting

The conversation-state cache keeps active ownership in memory and may remove a
terminal state only after the caller's durable persistence succeeds. Its default
limits remain 200 entries, 64 MiB of estimated payload and 30 minutes of terminal
age, independently per workspace. Count and byte pressure select persisted
terminal entries by least recent access. TTL is enforced on the next sweep;
reads do not extend the terminal-age cutoff. There is no periodic sweep timer.

## Payload estimate

`estimateStateBytes` walks ordinary own data properties, including canonical
messages, base64/data-URL media, tool-call arguments, frozen prompts, variables,
subflow inputs/outputs and debug snapshots. Strings count as two bytes per code
unit plus overhead. Shared objects and binary backing stores count once per
state; a small view counts its full retained backing store. Separate states are
estimated separately, so shared data across states may be counted twice.

The estimator does not stringify a state, copy media, invoke accessors or call
`toJSON`. It excludes runtime authority, abort signals, execution-extension
contexts, MCP client graphs and opaque class instances. Object/array overhead is
an approximation. A graph exceeding 100,000 inspected values saturates at
`Number.MAX_SAFE_INTEGER`, making its uncertainty visible and keeping estimator
work bounded. This is a cache payload estimate, not measured V8 heap, external
memory or RSS, and not a hard process-memory limit.

## Persistence and ownership

Every `noteWrite` refreshes the estimate and revokes a previous persistence
receipt. `markTerminal` captures the current cache entry, registered revision,
state identity, run identity, update timestamp and estimated footprint before
awaiting persistence. A superseded or changed state does not become evictable
when an old persistence call returns. Persistence failure leaves it protected.
Weak identity references in bookkeeping do not keep replaced payloads alive.

Sweeps and diagnostics refresh estimates to detect in-place payload growth.
Changes in footprint, run identity or update time invalidate old eligibility.
Same-size mutations with unchanged identities/timestamps cannot be detected by
an approximate estimate: mutation callers must use `noteWrite` and successfully
persist their current revision before eviction. This API remains bookkeeping
around the existing live registry; it does not intercept every nested mutation.

Running, paused-debug, awaiting-approval, unknown-status and recovery-owned
states remain protected. A terminal status with unresolved pending tool/debug
actions or an unfolded subflow invocation also remains protected. Byte/count
pressure never authorizes discarding that ownership. The cache does not truncate
canonical messages, drop retry markers or clear a live registry to meet a budget.

## Complete conversation-log recovery

Canonical JSONL recovery streams 64 KiB chunks from one opened file instead of
holding the complete UTF-8 text and an array of split lines alongside parsed
events. It reads the file size observed on that handle; later appends belong to
the next read. Existing event order and malformed-tail handling are preserved.

Individual conversation snapshots and full-history reads share four admission
slots across workspaces. Snapshot admission happens before allocating the file
buffer or parsing JSON. Central recovery holds its snapshot reservation through
log recovery, repairs and cache adoption; nested log recovery uses the same slot
and reserves additional bytes. Before reading, each reserves a conservative `16 * fileBytes + 128 KiB` estimate against current
V8 heap headroom, leaving 64 MiB available for other work. Callback-scoped
consumers hold that reservation through transcript projection. This estimate is
not a hard memory guarantee and does not cover collection-wide listing, provider,
external memory or subsequent retained-context allocations. Legacy storage getters
release admission when they return the parsed snapshot; retained caller state is
then outside this temporary-read reservation. Snapshot reads retain the existing
no-follow file identity checks and close the descriptor before recovery writes.

Admission refuses overload without truncating history or evicting live state.
HTTP callers receive `CONVERSATION_LOG_READ_BUSY` (429) or
`CONVERSATION_LOG_READ_MEMORY` (503), with `Retry-After: 5` and private/no-store
caching. Loader failures of these types propagate instead of becoming a false
404. The compatibility `readConversationLog` API releases admission when it
returns its events; callers retaining or projecting events should use
`withConversationLogEvents` to keep the temporary allocation covered. Bulk
conversation deletion uses at most four workers so a large request does not
refuse its own fifth read. A partial result preserves `deleted` and `errors`,
adds `retryableIds` and `retryAfterSeconds: 5` for pressure refusals, and sends
`Retry-After: 5`. Those refused conversations remain untouched.

## Diagnostics

`getConversationCacheDiagnostics()` returns workspace-scoped counters and numeric
sizes, without transcript, media, credentials or conversation identifiers:

| Field | Meaning |
| --- | --- |
| `estimatedBytes` | All registered states' current estimated payload |
| `protectedEntries`, `protectedEstimatedBytes` | State without current terminal persistence eligibility |
| `evictableEntries`, `evictableEstimatedBytes` | Current persisted terminal candidates |
| `overBudgetBytes`, `overEntryLimit` | Remaining pressure, including protected ownership |
| `saturatedEstimateEntries` | Estimates that exceeded the traversal work limit |
| `persistFailures`, `evictions`, `inFlightLoads` | Storage-failure, eviction and reload activity |

Existing fields and environment settings remain available. The function is an
internal diagnostics API; this change adds no public telemetry endpoint.

## Reproduce source checks

Run the focused cache, workspace, capped-run and recovery suites through the
ordinary Node Jest project. For the known managed-Windows path discovery defect,
the existing selector workaround is:

```text
node scripts/run-local-jest.cjs --selectProjects node --runInBand --testMatch "**/__tests__/**/*.test.{ts,tsx}" --runTestsByPath __tests__/flow/conversationStateCache.test.ts __tests__/workspace/runtimeIsolation.test.ts __tests__/flow/gracefulCapLanding.test.ts __tests__/flow/recoveryCheckpoint.test.ts
```

The cache fixtures cover large media/tool/debug/subflow payloads, shared binary
stores, estimator saturation, failed/superseded persistence, registered and
detected unregistered growth, protected states under byte pressure, LRU/TTL,
workspace isolation and coalesced canonical reload. The reload fixture supplies
a deterministic loader; it is not an installed-app storage/restart acceptance.
Replacing the cache implementation with the baseline is a behavioral negative
control for persisted-media eviction and replacement-state persistence races.

## Remaining maturity gates

This change improves cache accounting and eviction safety. Active contexts,
SDK/archive allocations, event/SSE buffers and slow-consumer backpressure,
subflow concurrency/queue admission and whole-process memory still need their
own bounded behavior and measurements. Protected pressure is reported rather
than resolved by unsafe eviction; no active-run admission limit is added here.

Repeated large-context/media/concurrency runs must retain exact source/artifact
pins, thresholds, raw heap/external/RSS samples, cache pressure, dispatch markers,
persist/reload behavior and a failing negative control. Linux and Windows build
qualification is separate from runtime memory acceptance. The original provider
failure, deployed Persona workflows, live elapsed-time gates, installed-release
manual checks and independent A- reassessment remain open under epic #563.
