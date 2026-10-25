# Subflow output admission and durable folding

Subflow child execution and input preparation have separate admission policies.
This gate covers **new output representations**: multimodal fallback text,
aggregate joins and separators, partial-failure summaries, artifact manifests,
framed messages, promoted metadata, UTF-8 captures, and the additional output
representations serialized into a parent checkpoint. Existing child strings,
media, histories, lane identities and dispatch attempts remain intact.

## Frozen policy

| Resource | Limit |
| --- | ---: |
| Derived text, estimated UTF-16 | 64 MiB |
| One invocation's estimated transient output allocation | 128 MiB |
| Concurrent process output reservations | 256 MiB |
| Data traversal | 100,000 values, depth 64 |
| Media references | 4,096 |
| Concurrent promotions | 4 |

These are conservative representation estimates, not OS memory reservations.
The ledger also checks available V8 heap and RSS with outstanding Flow and
preparation reservations. Authenticated operations status exposes numeric
`subflowOutput` active/reserved/refusal counters and policy values, without
conversation IDs or output content. Policy is fixed before qualification;
failed memory profiles must not be addressed by raising the limits.

Descriptor checks reject accessors, proxies, serialization hooks and cycles
without executing them. Admission counts serialized aliases independently and
counts JSON escaping, UTF-8 characters and lone surrogates before allocating
their serialized representation. Separator multiplication is checked before
`join`; media counts/metadata are checked before `flatMap` and promotion.
The actual run-resource writer measures text bytes before quota admission and
creates its UTF-8 buffer only inside the admitted write transaction.

`SUBFLOW_OUTPUT_TOO_LARGE` carries status 413 with instructions to reduce
derived output or the separator. `SUBFLOW_OUTPUT_MEMORY` carries status 503 and
a retry hint. Both preserve the pending durable join and completed children.
They are distinct from `FLOW_RUN_*` pre-execution refusals: providers may
already have completed useful work. Nothing truncates a task or child history.

## Reservation ownership

The lane engine owns the reservation while children and parent result-cache
writes settle, and attaches it privately to the returned result. Graph `post`
retains it through framing, promotion, captures and awaited fold persistence.
Detached tools retain it through terminal task publication. Inline tool calls
retain it through their ModelHandler consumer scope, including native provider
adapter serialization and transcript projection. Failure drains all started
workers before release. Numeric reservations do not appear in durable state.

An external caller of `runSubflowLanes` must consume the result with graph
`post`, or call `releaseSubflowOutput` after consumption. JavaScript objects
retained by arbitrary callers after that boundary are caller-owned; the gate
does not claim to control their lifetime or force garbage collection.

## Fold and effect receipts

Successful parent messages, variable capture, last response, durable
presentation, stable message IDs, and a versioned fold receipt are staged and
published in one parent snapshot. The live transcript is updated only after
the snapshot succeeds or a durable read proves that it committed. A failure
after the snapshot write can be followed by a failed sidebar projection; it
must not cause a duplicate fold. If readback is unavailable, a runtime fence
blocks later error/checkpoint writes until they can reconcile the durable
receipt. Restart reads the actual persisted state.

The active visit remains attached while continuation is pending. Graph
advancement acknowledges the receipt in the same checkpoint as the next node
before that node starts. A restarted completed fold returns its saved action,
including when a stale success or failure arrives. Recovery retains separate
presentation and does not redispatch completed lanes.

Media promotion deduplicates source URIs, preserves requested reference order,
and reuses the promoted parent URI for aggregate and separate messages. The
resource index scopes effect keys by workspace, parent conversation, visit and
source/capture identity. A content/metadata fingerprint makes a reused key with
different data a conflict. Stable payload identities allow a retry to reconcile
a payload written before its index commit. Named captures retain older
immutable effect entries and their bytes after a later visit replaces the
name; they continue to consume resource quota. Receipts are removed when their
run resources are deleted, so they do not provide idempotency beyond that
resource lifecycle.

KV capture is a separate durable effect. A pending intent is checkpointed
before writing. An ambiguous result remains pending and blocks automatic
replay until reconciled; last-write-wins is **not** an exactly-once guarantee.
There is no transaction spanning the conversation snapshot, resource store
and KV store. Resource/capture events are notifications, not durable receipts.

## Limits of this slice

The gate charges added output representations; the existing global conversation
writer still serializes unrelated already-owned parent history as a whole.
That allocation, other global KV/catalogue serialization, logging, provider
allocation and process-external memory are outside this policy. Large child
output can remain safely stored while its requested parent representation is
refused. No bounded-memory claim here replaces the separate full-workload and
endurance qualification.

Focused regressions exercise boundary arithmetic, escape amplification,
pre-allocation refusal, aliased media, ordered four-worker promotion, delayed
sibling drain, unchanged child IDs/attempts/history, zero retry redispatch,
before/after-commit failures, unavailable readback, restored separate folds,
ambiguous KV intents, real capture quota/encoding order, and resource receipt
content conflicts.
