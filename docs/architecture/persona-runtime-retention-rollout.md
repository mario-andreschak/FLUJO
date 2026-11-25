# Persona runtime retention rollout

Issue #481 controls how the soft cleanup described in
[persona-runtime-retention.md](./persona-runtime-retention.md) reaches real
installations. It does not touch lease-history deletion, which stays separately
gated and off by default.

## Decision (November 2026)

FLUJO now **measures by default and cleans up nothing**. Every hour it works out,
for every Persona, which old records cleanup would shrink and by how much, and
stores the numbers. Real cleanup (`active`) stays an explicit choice.

Why measuring is on: it is proven to write no Persona record (a test compares
every file's time stamp and content before and after a sweep), it never runs on
the path that finishes an Activity, and it produces the evidence the stages
below need.

Why cleanup stays off by default:

1. It has never run on real data. Until #481, a retried request whose mailbox
   item had been cleaned up was refused as "reused with different work". This
   is fixed and tested now, but it shows the active path had no real use.
2. Mailbox cleanup keeps every record and can make small ones bigger: the kept
   fingerprint is longer than a short summary. In the test fixture three
   cleaned-up mailbox items would grow from 1,698 to 1,947 bytes. Real summaries
   may be longer; the measurements will show it.
3. Cleanup permanently removes detail that can still be shown in FLUJO
   (summaries, error text, instructions) for work older than 30 days or beyond
   the newest 200–500 records.
4. In `active` mode the cleanup after each finished Activity re-reads all of
   that Persona's records. The soak harness turns it off for this reason. It
   needs measuring on large histories before it runs everywhere.

## Switches

Retention has three modes: `disabled` (nothing), `shadow` (measure only) and
`active` (clean up).

| Switch | Where | Takes effect |
|---|---|---|
| Workspace setting `persona_runtime_retention_settings` | Generic storage API, see below | Within 5 seconds, no restart |
| `FLUJO_PERSONA_RUNTIME_RETENTION_MODE` | Environment | On restart |
| `FEATURES.ENABLE_PERSONA_RUNTIME_RETENTION` | `src/config/features.ts` | On rebuild; `false` turns everything off |

**Whoever turns it down wins.** The mode is the lower of the setting and the
environment variable (`disabled` < `shadow` < `active`); the default `shadow`
applies only when neither is set. A malformed environment variable or an
unreadable setting means `disabled`. A setting whose content cannot be
understood is rewritten as `disabled`, so it is valid again and is not re-read
every few seconds.

Turn cleanup on, off, or back to the default in the selected workspace:

```powershell
$body = @{ key = 'persona_runtime_retention_settings'; value = @{ mode = 'active' } } | ConvertTo-Json -Depth 3
Invoke-RestMethod -Method Post -Uri http://localhost:4200/api/storage -ContentType 'application/json' -Body $body
```

Use `mode = 'disabled'` to stop retention, or delete the key to go back to the
default:

```powershell
Invoke-RestMethod -Method Delete -Uri 'http://localhost:4200/api/storage?key=persona_runtime_retention_settings'
```

Deployment-only variables (unchanged): `FLUJO_PERSONA_RUNTIME_RETENTION_BASIS_POINTS`
(`0..10000`, default `10000` = every Persona),
`FLUJO_PERSONA_RUNTIME_RETENTION_COHORT_VERSION` and
`FLUJO_PERSONA_RUNTIME_RETENTION_CRITICAL_PERSONA_IDS` (comma-separated Personas
never included). Cohorts are SHA-256 buckets of cohort version, workspace and
Persona id; a Persona is included when its bucket is below the basis points.

## How it stays safe

- Every write needs a grant from `acquirePersonaRuntimeRetentionWriteGrant`
  (`personaRuntimeRetentionControl.ts`). It is issued only in `active` mode, for
  a Persona inside the cohort, to a caller holding that Persona's runtime lock.
  The compactors in `compactRuntime.ts` take the grant as a required argument
  and refuse one that was not issued there.
- Before every single write the grant re-checks the lock, the live mode and the
  cohort. Turning retention off stops a running sweep before its next write.
- The hourly sweep (minute 47) never raises the mode it started with, holds the
  Persona lock while it reads and plans, and runs at most two Personas at once.
- The cleanup after a finished Activity runs only in `active` mode.
- Each record is written atomically. A crash leaves every record either old or
  cleaned up, and the next sweep finishes the rest once; a half-written
  temporary file is ignored.
- A sweep still running after two hours is treated as stuck, and the next
  trigger starts a fresh one instead of waiting for a restart.

## What is measured

Each sweep that runs stores a summary in the workspace item
`persona_runtime_retention_reports`: the newest 168 sweeps (one week) plus
running totals. It holds counts, sizes and timings only, never Persona ids,
payloads, keys, digests or error text. Read it with:

```powershell
Invoke-RestMethod 'http://localhost:4200/api/storage?key=persona_runtime_retention_reports'
```

Per sweep: mode and which switch decided it, cohort and basis points, start
time and duration, Personas examined, selected, skipped and failed, the longest
wait for and hold of a Persona lock, and per collection (mailbox items,
Activities, Flow dispatches, specialist calls): records scanned, candidates,
planned and done writes, failures, writes stopped by the switch, and bytes
before and projected after. `active` sweeps also measure the stored size before
and after. One summary line is also logged (`info`, or `warn` on failures).

Per-Persona storage statistics (`GET /v1/personas/{id}/storage-stats`) report
`retentionMode` and `retentionEnabled` (true only while cleanup is active for
that Persona).

## Evidence

| Gate | Status |
|---|---|
| Measuring writes no Persona record | Proven: `personaRuntimeRetentionSweep.test.ts` |
| Off switch works without restart, mid-run | Proven: same file |
| Crash in the middle of a cleanup run | Proven: records stay valid, next sweep finishes once, kept time stamps unchanged |
| Retry after cleanup is still treated as the same request (AC2) | Fixed and proven; different work under the same key is still refused |
| Audit identity survives cleanup (AC3) | Proven for mailbox items and Activities in the crash test, plus `compactRuntime.test.ts` |
| Measuring never runs after a finished Activity | Proven: `personaDispatcher.test.ts` |
| Real storage savings per collection | Missing: needs a week of `shadow` reports from real installs |
| Lock hold and mailbox latency on large histories | Missing: reports now record lock wait and hold; mailbox scan latency still needs a baseline |
| Active cleanup on real data, 1% then 50% | Missing: Mario's rollout checklist below |

## Rollout on real installations

1. **Measure (now the default).** Leave the default for at least seven days.
   Check the reports: no failed Personas, the longest lock hold stays well under
   one second, and the projected savings per collection. If mailbox items do
   not shrink, mailbox cleanup should be dropped from the policy rather than
   switched on.
2. **Clean up a small cohort.** On one installation set
   `FLUJO_PERSONA_RUNTIME_RETENTION_MODE=active` and
   `FLUJO_PERSONA_RUNTIME_RETENTION_BASIS_POINTS=100` (or, on a single-user
   install where 1% may select nobody, the setting `active` for one test
   workspace). Watch for seven days: zero failed writes, retries still
   coalesced, actual bytes after below before, nothing missing that a user
   needs to see.
3. **Half the Personas.** Basis points `5000`, same cohort version, fourteen
   days, same checks plus no rise in Persona lock waits.
4. **Default decision.** Changing the default mode to `active` is a reviewed
   code change to `PERSONA_RUNTIME_RETENTION_DEFAULT_CONFIG`.

**Rollback** at any stage: set the workspace setting to `disabled` (seconds, no
restart) or the environment variable to `disabled` (restart). Writes stop before
the next record. Cleanup is not undone: removed detail stays removed. Do not
switch on lease-history pruning as part of this rollout.
