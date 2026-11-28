# Persona history cleanup rollout

Issue #481 decides how the soft cleanup described in
[persona-runtime-retention.md](./persona-runtime-retention.md) reaches real
installations. It does not touch lease-history deletion, which stays separately
gated and off by default.

## Decision (November 2026)

Nobody switches cleanup on or off. Every workspace **measures first**, switches
real cleanup on **by itself** once its own measurements pass fixed rules, and
goes back to measuring **by itself** on any anomaly. There is no setting, no
environment variable and no code flag for it (#1449: no new flags).

Why no off switch: every way cleanup can go wrong that a program can see is an
anomaly that turns it off at once (below), and the things it cannot see do not
need a switch because cleanup never deletes a record and never touches one that
live work still uses. A switch would only be one more thing nobody sets.

Why no separate backup copy: cleanup is soft. It keeps every record with its
identity, state, times, keys and digests, and removes only bulky detail of old,
finished work. A full copy of that detail would cost the space cleanup saves and
would need its own encryption, deletion and privacy handling. Safety comes from
checking every record right before it is rewritten, under the Persona lock.

## How a workspace moves between the two modes

The state lives in the workspace item `persona_runtime_retention_state`. It
survives restarts. The generic storage API cannot read or write it, so it cannot
be used as a back-door switch.

```
            24 clean measuring runs in a row,
            the first one at least 7 days old
 measuring ───────────────────────────────────▶ cleaning up
 (shadow)  ◀─────────────────────────────────── (active)
            any anomaly: back at once, fresh streak
```

The hourly sweep (minute 47) is the only path that writes. Each run measures
every Persona: which old records cleanup would rewrite and how many bytes it
would save. A clean run in measuring mode extends the streak. After 24 clean
runs in a row, with the first at least seven days old, the next run cleans up.

**Anomalies** (each one sends the workspace back to measuring, starts a fresh
streak, and logs one plain line):

| Anomaly | When |
|---|---|
| `referenced` | A record cleanup would rewrite is still used by unfinished work: a running Activity, an unsettled dispatch, a pending delivery, an open maintenance run. |
| `invalid` | The cleaned-up form of a record would not pass its stored schema, or would change an identity field. |
| `error` | A Persona could not be read, or a cleanup write failed. |
| `volume` | A run would rewrite more than twice the most records any clean run since the last anomaly would have, plus 100. |

An anomaly is stored the moment it is found. Every write re-reads the stored
state first, so a running cleanup in any process stops before its next write.
Nothing needs a restart: the next clean week switches cleanup on again.

**Never rewritten**, whatever the mode: a record still in use, a record whose
cleaned-up form is invalid, and a record that would not get smaller (a mailbox
item with a short summary grows, because it gains a fingerprint). In-progress
states are not candidates at all: a coalesced input whose delivery is pending
(it returns to the queue when its target ends) and a dispatch whose projections
are not settled yet.

## How it stays safe

- Writes need a grant from `acquirePersonaRuntimeRetentionWriteGrant`
  (`personaRuntimeRetentionControl.ts`), issued only while the workspace is
  cleaning up and the caller holds the Persona's runtime lock.
  `executeRetentionPlan` in `retention.ts` takes the grant and refuses one that
  was not issued there. Before every write the grant re-checks the workspace,
  the lock and the stored state.
- The first failed write stops the rest of that Persona's run.
- Each record is written atomically. A process killed in the middle of a
  cleanup leaves every record either old or cleaned up, and the stored state
  unchanged; the next run finishes the rest exactly once.
- A briefly locked state file means measuring only for that run, without
  recording anything. A damaged one is rewritten as a fresh measuring state.
- A sweep still running after two hours is treated as stuck, and the next
  trigger starts a fresh one.
- Finishing an Activity no longer runs any cleanup. That path re-read all of a
  Persona's records after every Activity; the hourly sweep does the same work
  once an hour.

## What is recorded

The state holds the mode, the streak and its start, the volume baseline, when
cleanup last switched on, how often it went back, the last anomaly (kind, time,
mode) and a summary of the last run (time, mode, Personas, candidates, records
cleaned up, anomalies). It holds numbers only: no Persona ids, text, keys or
digests. Per-Persona storage statistics (`GET /v1/personas/{id}/storage-stats`)
report `retentionMode` and `retentionEnabled` (true while cleaning up).

## Evidence

| Rule | Test |
|---|---|
| Measuring writes no Persona record | `personaRuntimeRetentionSweep.test.ts` (file times and contents unchanged) |
| Cleanup switches on after a clean measuring week, then cleans up | same file, and the rules in `personaRuntimeRetention.test.ts` |
| Each anomaly sends it back, writes nothing, heals without a restart | same files, one case per anomaly |
| A record in use is never rewritten | same files, and `findPersonaRuntimeRecordsInUse` cases |
| An anomaly stored elsewhere stops a running cleanup before its next write | `personaRuntimeRetentionSweep.test.ts` |
| A real process killed mid-cleanup: state kept, rest finished exactly once | `personaRuntimeRetentionProcess.test.ts` |
| A restart keeps the streak and the mode | same file (three processes in a row) |
| A retry after cleanup is still the same request | `personaRuntimeRetentionSweep.test.ts` |
| Cleanup stays on through a long simulated run with no anomaly | the soak harness fails on any anomaly |
