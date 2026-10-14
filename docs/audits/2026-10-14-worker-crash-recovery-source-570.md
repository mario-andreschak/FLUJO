# Source worker crash recovery acceptance for #570

The existing [operations acceptance issue #570](https://github.com/mario-andreschak/FLUJO/issues/570)
now has a reproducible source-built worker drill using the scheduler recovery
contracts from #553. It exercises actual encrypted worker bootstrap, HTTP routes,
cron, Flow engine and loopback provider dispatch. It uses the existing recovery
exercise and original direct-child lifecycle helpers.

## Observed result

The [frozen receipt](evidence/worker-crash-recovery-570-2026-10-14/receipt.json)
records nine observations across four actual worker processes on Windows / Node
22.23.3. Application source is `2a7ab53c0f21e8a4452440e5c560b8dab0ab36c2`;
build `Rw7dmmzNBuXLBUQCfpYn9` binds 1,868 source inputs and 1,539 emitted
Next/five-MCP files. The equipment is hashed separately. The complete live drill
took 90.377 seconds.

| Case | Actual observation |
| --- | --- |
| Bootstrap and access | Each process restored or preserved the same private encrypted snapshot and became worker-ready. Anonymous worker, operations and snapshot-info requests returned 401. The configured MCP process census stayed empty. |
| Copied and local suppression | Copied enabled and newly created unenrolled schedules made zero provider calls during the 11-second observation. The copied sibling remained unarmed through all restarts and reconciliations. |
| Enrollment and restart | An explicitly enrolled local schedule completed its original tick. After abrupt process exit and 11 seconds offline, the same worker admitted exactly one completed catch-up, followed by a distinct ordinary completed cron tick. The original completed run remained completed. |
| Counted effects | Three successful provider requests matched three completed engine runs. The provider independently appended four durable journal rows: those three responses and one held, uncertain dispatch. Unique sequence count and actual journal bytes were checked before private cleanup. |
| Interrupted work | A held provider request was entered before the second crash. Its signed private admission remained byte-identical after restart; the schedule reported `unresolved-admission` and stayed unarmed. Two reconciliations and a stale-generation enrollment attempt added zero replacement dispatches. |
| Stale authority | The third abrupt restart changed only the worker epoch to 2. The same admission reported `worker-authority-changed`, remained byte-identical, and admitted no replacement work. |
| Process and cleanup | Three original direct children reported SIGKILL exit and stdio closure. The last process reported graceful exit 143 and stdio closure. Provider close completion was observed separately. Both actual private fixture roots were verified absent after cleanup. |

The held provider request remains an uncertain external dispatch. Its fixture
journal row proves receipt, not successful fulfillment. Recovery never clears
that admission or retries its effect. Engine completion, arming, cooperative
cancellation and process exit remain distinct observations. The direct-child
receipts do not qualify detached descendants or an isolated container.

## Failure controls and reproduction

The [failure-control receipt](evidence/worker-crash-recovery-570-2026-10-14/failure-controls.json)
records an actual injected error after the first worker became ready. That runner
returned exit 1, observed its graceful child exit/stdio and provider close, then
verified private-root removal. A separate occupied-log negative refused before
issuing credentials or allocating a fixture, preserved the existing log and
created no passing report. The requested fault label alone is not the witness.

From a pinned source checkout with its exact lock installed, use new absolute
report paths:

```sh
node scripts/operations-acceptance/build-evidence.mjs --report <absolute-build.json>
node scripts/operations-acceptance/worker-recovery.mjs --report <absolute-worker.json> --build-evidence <absolute-build.json>
```

For the witnessed cleanup control, use a different fresh report and append
`--fail-at first-ready`; expect runner exit 1, `outcome: failed`, the injected
error text, observed child/provider closure and `cleanupVerified: true`.
An occupied `<report>.log` must refuse before fixture allocation and stay intact.
All task cleanup/deletions must run through flujo-bash under the project rules.

The runner admits literal loopback only, isolates data/homes/temp and inherits
only system environment variables. It preserves the same snapshot, key, control
token, worker identity and persistent data between generations. It reuses the
30-minute whole budget, five-generation cap, 240-second worker readiness window,
45-second scenario waits, 11-second suppression/offline windows and bounded
original-child shutdown clocks. Output is capped per generation and overall.
A started listener requires an observed close; uncertain ownership retains the
private root and makes acceptance fail. Logs are reserved before private setup
and written before publishing a passing receipt.

## Local qualification and remaining criteria

All 50 focused worker provenance/scheduler/enrollment/process-boundary regressions
passed (23.094s), as did 40 recovery-equipment cases (3.172s). Source/five-MCP
TypeScript (67.687s), source lint (103.949s), final equipment lint/syntax and the
inspected non-container application/five-MCP build (324.709s) passed. Independent
read-only implementation and receipt review cleared the final equipment. Times
are individual measurements; checks overlapped. Source/build inputs stayed
unchanged while the separately hashed equipment was reviewed.

This drill uses an empty MCP configuration and a synthetic loopback model.
Bundled MCP preparation and generation-bound stdio shutdown retain their separate
#547/operations evidence. Paused, disabled, retired, stopped and corrupt-provenance
refusal use the focused existing contracts; this live profile establishes the
copied/local/crash/interrupted-admission/epoch observations above.

Issue #570 remains open for integrated disk-full, interrupted migration and
snapshot disaster recovery, the five-hour SDK elapsed timeout, the non-author
install/diagnose/backup/upgrade/restore exercise, and exact supported release
profiles. Source snapshot bootstrap is distinct from that disaster-recovery
matrix. Full/remote/container/installed/release checks remain release pre-flight
under the global pause. No workflow or paid provider call was made for this batch.
