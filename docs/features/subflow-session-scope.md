# Resumable Subflow Sessions (Session Scope)

## Overview

A Subflow node can be visited more than once inside a single parent run — a retry loop
that re-invokes a "produce" child after a "validate" step reports a failure is the
canonical example. Legacy nodes with no saved `sessionScope` start the child flow from
zero on every visit. Newly created and generated Subflow nodes default to `per-key`, so
calling Process nodes can reuse a named child conversation. For flows that repeat
expensive work (long tool chains, large media generation, multi-step research), this
avoids re-doing the whole job when only a small correction is needed.

Session scope lets a Subflow node **resume the same child conversation** across repeat
visits inside one parent run, so the second (and later) visit can say "here is what to
fix" instead of re-stating the entire task from scratch.

**This feature is experimental and off by default.** Enable it in
**Settings → Experimental features → "Resume subflow child conversations across
visits"**.

## Enabling the feature

The toggle is a **global switch** (`experimental.subflowSessions`, off by default). It
does not by itself change any flow's behaviour — a Subflow node must *also* be
configured with a resumable `sessionScope` (`per-run` or `per-key`; see below) before resumption happens.
Turning the toggle off at any time instantly restores today's default behaviour (a fresh
child conversation on every visit), even for nodes that have a resumable scope configured.

## Session scope options

| `sessionScope` | Behaviour | Status |
|---|---|---|
| `per-visit` (legacy/absent fallback) | Every handoff/queue visit starts a brand-new child run with no memory of any prior visit. | Available |
| `per-run` | All visits to this Subflow node within one parent run share **one** child conversation; the second and later visits resume it. | Available (behind the `experimental.subflowSessions` flag) |
| `per-key` | One conversation per `sessionKey`. An incoming Process handoff may choose the key; reusing it sends the new task as a follow-up turn to that finished child conversation. Different keys remain independent. | Available (behind the `experimental.subflowSessions` flag) |

## Session input mode

A resumable node may use `sessionInputMode: "resume"` (the default) to append the
new task to the full prior child transcript, or `sessionInputMode: "summary"` to
compact completed visits before appending it. Summary mode operates only on an already
valid child transcript; the incoming task is never included in the summarized slice.
If summarization fails or returns empty output, the original history is retained and
execution continues in resume mode.

An optional positive integer `sessionTurnCap` bounds retained logical turns for each
resolved session identity. A logical turn begins with one top-level child task and
includes its assistant/tool exchange. Before a new task, at most `cap - 1` completed
turns are retained, so `cap: 1` keeps metadata plus only the incoming task and its
response. System messages and synthetic summary markers do not count. Tool calls and
their results are never split.

## Configuring a node

In the Subflow properties modal, use **Child conversation memory**. New Subflow nodes
start on **One per session key**; existing nodes with no saved scope keep their historical
fresh-per-visit behavior.

- **Fresh every visit** stores no `sessionScope` property.
- **One per parent run** stores `sessionScope: "per-run"`.
- **One per session key** stores `sessionScope: "per-key"`. Leave the fixed-key field
  blank when the calling Process should choose `sessionKey` on each handoff.

The equivalent JSON for the per-run mode is:

```json
{
  "type": "subflow",
  "properties": {
    "subflowId": "your-child-flow-id",
    "sessionScope": "per-run"
  }
}
```

For example, summarized per-run memory retaining at most four turns is:

```json
{
  "type": "subflow",
  "properties": {
    "subflowId": "your-child-flow-id",
    "sessionScope": "per-run",
    "sessionInputMode": "summary",
    "sessionTurnCap": 4
  }
}
```

Session preparation is serialized per effective identity. Per-key templates are
resolved from caller, run, and lane context before locking; equal effective keys reuse
one child while different keys remain isolated. If a registered child conversation is
missing or its transcript is corrupt, FLUJO initializes a fresh replacement and swaps
only that registry entry after initialization succeeds.

Combined with the experimental flag being enabled, every visit to this node within the
same parent run will now resume the same child conversation.

For caller-addressed child chats, configure `"sessionScope": "per-key"` and leave
`sessionKey` absent. With the experiment enabled, an incoming Process node then receives
this additional handoff-tool argument:

```json
{
  "task": "Apply the review notes to section 2",
  "sessionKey": "writer-main"
}
```

The first use of `writer-main` creates a saved child conversation. A later handoff with
the same key appends its `task` as a new user turn, restarts the child flow at its Start
node, and keeps the child's full prior transcript. A different key creates an independent
child conversation. Keys are 1–128 characters. They are opaque display handles: the runtime keeps the
resolved `sessionKey` separate from its encoded, composite `sessionIdentity`, which is
used only for durable correlation.

## Session visibility and filtering

Persisted keyed child conversations project optional `sessionKey` and internal
`sessionIdentity` fields into the v7 conversation-summary sidecar. Historical and
non-session conversations omit both fields and continue to render normally. The chat
conversation tree displays only the resolved `sessionKey`; it never displays the
composite identity.

`GET /v1/chat/conversations` accepts `sessionKey=<key>` for an exact resolved-key
match. The filter is applied before cursor pagination and composes with title/content
search, origin, descendants, limit, and cursor parameters. Keys longer than 128
characters receive a `400` response. Because query parameters may be retained by a
browser or proxy, session keys must not contain secrets.

Live child-job rows display `session: <key> (visit N)`. `N` is the current 1-based
visit: a newly created session starts at visit 1, while a resumed session uses the
number of completed visits plus one. The registry increments its completed count only
when that visit reaches a terminal outcome.

## Worked example

Consider a `Produce ↔ Validate` loop: a Subflow node "Produce" generates an artifact
(e.g. a long video render script), hands off to a "Validate" Process node that checks
the result, and — on failure — hands back to "Produce" for another attempt.

- **First visit:** no prior session exists. A new child conversation is created and the
  full task is sent.
- **Second (and later) visits:** with `sessionScope: 'per-run'` and the experimental flag
  on, the same child conversation is resumed. The child already knows every file path,
  command, and prior decision from its own transcript, so the parent only needs to send
  the QC findings ("scene 3's audio is out of sync") rather than the entire task again.

On one reference flow (`Website_Promo_Video_Producer`), this pattern was **observed** to
eliminate several expensive 900-frame recaptures per retry loop and save roughly
700K prompt tokens across a run. This is a single observed data point on one flow, not a
guarantee for every use case — actual savings depend on how much of the retry work is
genuinely redundant.

## Trade-offs and troubleshooting

- **Context growth:** a resumed child's transcript grows with every visit. There is no
  compaction for subflow sessions yet, so a loop with many retries can approach the
  child model's context limit. Very long-running retry loops are not yet a great fit.
- **Concurrent lanes are NOT isolated under `per-run`:** if a Subflow node is invoked as
  multiple parallel lanes (e.g. a fan-out queue), all lanes under the same `per-run`
  node share **one** conversation and are serialized by the per-conversation execution
  lock. `per-run` scope is intended for a single retry loop. Use distinct `per-key`
  handles for parallel independent work; repeated uses of the same key are serialized.
- **How to spot reuse:** each subflow invocation lane now records `sessionIdentity` (the
  registry key it resolved to) and `resumedVisit` (`true` once a visit reused a prior
  conversation rather than creating a new one). A debug log line —
  `Subflow sessionScope is configured but experimental.subflowSessions is disabled;
  falling back to per-visit` — is emitted once per lane pool when a node is configured
  with a non-`per-visit` scope while the flag is off, so a silent fallback is
  discoverable in the logs.
- **Disabling the flag** at any time instantly restores per-visit behaviour for every
  node, with no migration or data loss (any resumed conversations simply stop being
  reused going forward).

## Limitations

- **N1 — `summary` session input mode is not implemented.** Tracked as #363 Phase 3.
- **N2 — Session keys live only for the current logical parent run.** A later top-level
  user turn starts a new registry; this prevents accidental cross-run memory leakage.
- **N3 — `list_conversations` (MCP) has no session filter yet**, so resumed subflow
  sessions are not distinguishable from ordinary conversations through that tool.
  Tracked as a future phase of #363.
