# Resumable Subflow Sessions (Session Scope)

## Overview

A Subflow node can be visited more than once inside a single parent run — a retry loop
that re-invokes a "produce" child after a "validate" step reports a failure is the
canonical example. By default every visit starts the child flow from zero: a brand-new
conversation with no memory of the previous attempt. For flows that repeat expensive
work (long tool chains, large media generation, multi-step research), that means every
retry re-does the whole job even when only a small correction is needed.

Session scope lets a Subflow node **resume the same child conversation** across repeat
visits inside one parent run, so the second (and later) visit can say "here is what to
fix" instead of re-stating the entire task from scratch.

**This feature is experimental and off by default.** Enable it in
**Settings → Experimental features → "Resume subflow child conversations across
visits"**.

## Enabling the feature

The toggle is a **global switch** (`experimental.subflowSessions`, off by default). It
does not by itself change any flow's behaviour — a Subflow node must *also* be
configured with a `sessionScope` of `per-run` (see below) before resumption happens.
Turning the toggle off at any time instantly restores today's default behaviour (a fresh
child conversation on every visit), even for nodes that have `sessionScope: 'per-run'`
configured.

## Session scope options

| `sessionScope` | Behaviour | Status |
|---|---|---|
| `per-visit` (default) | Every handoff/queue visit starts a brand-new child run with no memory of any prior visit. | Available |
| `per-run` | All visits to this Subflow node within one parent run share **one** child conversation; the second and later visits resume it. | Available (behind the `experimental.subflowSessions` flag) |
| `per-key` | One conversation per resolved `sessionKey` (e.g. one conversation per scene in a multi-scene flow), rather than one per node. | **Not yet implemented** (#363 Phase 2) |

## Session input mode

A `sessionInputMode` field is reserved on the node's prep result: `resume` (the
behaviour available today — the child sees its own prior transcript, unmodified) and
`summary` (intended to inject a condensed summary of prior visits instead of the full
transcript). **Only `resume` is implemented today; `summary` is not yet wired up and
currently behaves exactly like `resume`.** This will be revisited in a future phase
(#363 Phase 3) rather than documented as an aspiration here.

## Configuring a node

There is currently no properties-modal control for `sessionScope` in the FlowBuilder UI
(`SubflowNodePropertiesModal.tsx`). Setting it is an **interim, hand-edit-the-flow-JSON**
step: add `sessionScope: "per-run"` to the Subflow node's properties in the flow's JSON
definition, e.g.:

```json
{
  "type": "subflow",
  "properties": {
    "subflowId": "your-child-flow-id",
    "sessionScope": "per-run"
  }
}
```

Combined with the experimental flag being enabled, every visit to this node within the
same parent run will now resume the same child conversation.

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
  node share **one** conversation. `per-run` scope is intended for a single retry loop,
  not for parallel fan-out work — `per-key` scope (not yet implemented) is the intended
  answer for that case.
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

- **N1 — No UI to set `sessionScope`.** See "Configuring a node" above; exposing it in
  `SubflowNodePropertiesModal.tsx` is tracked as a stretch item on #391.
- **N2 — `per-key` scope is not implemented.** Tracked as #363 Phase 2.
- **N3 — `summary` session input mode is not implemented.** Tracked as #363 Phase 3.
- **N4 — `list_conversations` (MCP) has no session filter yet**, so resumed subflow
  sessions are not distinguishable from ordinary conversations through that tool.
  Tracked as a future phase of #363.
