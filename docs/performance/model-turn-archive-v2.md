# Model-turn archive v2: bounded outcome writes

This is the first allocation slice for [#569](https://github.com/mario-andreschak/FLUJO/issues/569),
related to [#520](https://github.com/mario-andreschak/FLUJO/issues/520). It removes
full-transcript inflation, parsing, stringification and compression from outcomes
of **new** SDK dispatches. It does not establish a whole-process memory bound.
The source baseline is `3511ba49514fe8cf525f5a22c16c3806bf3886ba` (3.46.2).

## Disk and reader contract

Within `db/model-turns/<conversationId>/`:

| File | Contract |
| --- | --- |
| `<dispatchId>.v2.json.gz` | Immutable snapshot with `version: 2`, `entry.archiveVersion: 2`, and embedded `entry.outcome: running`. Canonical history, wire parameters, media references, attempt ordinal and dispatch ID remain fixed. |
| `<dispatchId>.outcome.json` | Optional terminal outcome, written atomically after completion/error/cancellation. Maximum 1,024 UTF-8 bytes. |
| `media/<sha256>` | Content-addressed media, unchanged by outcome updates. |
| `<dispatchId>.json.gz` | Historical v1 snapshot, still readable and updatable with the original full-rewrite behavior. |

The outcome record has exactly five keys:

```json
{
  "version": 1,
  "archiveVersion": 2,
  "conversationId": "conversation-id",
  "dispatchId": "dispatch-id",
  "outcome": "completed"
}
```

Terminal outcomes are `completed`, `error`, or `cancelled`. The reader binds both
IDs before applying the outcome to its newly read snapshot. A missing record
retains `running`, including after an interrupted process or a failed outcome
write. It never infers completion from a conversation or Activity status.
Invalid/oversized records produce an error. Reads allocate at most 1,025 bytes
for the outcome payload, including the extra byte used to detect overflow.
The outcome mutation does not read the compressed dispatch or any media file.
Workspace capture admission and execution-authority fences still surround the
whole mutation. Failed atomic writes remove their temporary file and preserve
the last committed outcome; the dispatch itself remains unchanged.

`readModelTurnSnapshot` overlays outcomes for existing API/inspector consumers.
The timeline still gets one marker per observed SDK invocation; retries are not
collapsed. SDK-internal HTTP retries remain inside that invocation, as before.
No change is made to canonical history, run-cache eviction or active, paused,
approval and recovery ownership.

## Ordinary dispatch write contention

Ordinary model dispatches may wait for an archive writer instead of failing a
burst immediately. The process-wide limits remain four active writers and
512 MiB of reserved archive payloads. At most 512 writes wait, for at most
30 seconds; their retained payload estimates count against the same byte limit
before any archive cloning. Queued writes receive permits in FIFO order.

Cancellation removes a waiting write and prevents its preparation callback and
provider dispatch. Payload estimates and cancellation are checked again after
waiting and immediately before materialization. Overflow, timeout or byte
pressure returns the existing `MODEL_TURN_ARCHIVE_MEMORY_BUSY` refusal.
An uncertain descriptor close keeps its writer and byte reservation quarantined.
Already admitted local-media I/O keeps the reservation until its handle closes,
even if its outer callback settles early. A settled scope cannot start further
media reads or allocate another read buffer.

Journalled native, execution-authority, extension and Persona dispatches retain their
existing immediate-refusal behavior. The queue does not bypass workspace
capture or durable ownership fences, and it does not change canonical history.
Local workspace writer registrations coalesce in batches of at most eight under
one physical capture-admission lease. Each writer still owns a separate lock;
mutation bodies start only after that lease releases, and capture still drains
all active writers. This reduces repeated registration overhead without making
mutation bodies run serially. The synthetic local reproduction does not establish
the original production deployment's latency or resolve every #757 finding.

## Consumer compatibility and recovery

Readers must support archive v2 before accepting v2-producing application data.
The distinct filename prevents a v1-only reader from silently presenting a
terminal v2 dispatch as a v1 running snapshot. Older applications cannot inspect
new v2 archives. Do not roll back a writer/reader independently or claim mixed
versions are supported. Existing v1 archives do not need a migration, and their
outcome-update allocation cost is not improved by this slice.

Persona recovery retains both snapshot and outcome bytes in the existing
checksummed manifest. Preflight validates version/filename/entry agreement,
the outcome size and both IDs, rejects orphan outcome records and duplicate v1/v2
dispatch IDs, and keeps incomplete dispatches running. Existing v1 archives and
recovery ZIPs remain supported by the new reader. The recovery ZIP container
version stays 1; its model-turn member contract now accepts archive versions 1/2.

The Persona endurance collector supports both formats. V2 terminal evidence
includes `sourceFileSha256` for immutable dispatch bytes and
`sourceOutcomeSha256` for terminal metadata. The endurance validator requires
the latter for a v2 terminal result. Interrupted v2 dispatches retain the
original running marker; the existing joined crash-execution verifier is still
required for any qualifying interrupted live epoch. The collector/evidence
tests do not execute a live endurance run.

FACTORY/O/Brain/Observatory adapters reading model-turn disk data must consume
this contract with an exact application pin. No original request identity,
budget/OFF policy, provider-entry permission, recovery authority or cleanup fact
is changed or inferred by an archive outcome.

## Focused validation

Use disposable test roots; Jest's setup creates its own independent data root.
No real provider, private workspace or account configuration is needed.

```powershell
node scripts/run-local-jest.cjs --selectProjects node --runInBand --testMatch "**/__tests__/**/*.test.{ts,tsx}" --runTestsByPath __tests__/flow/modelTurnArchive.test.ts __tests__/flow/modelTurnArchiveAdapter.test.ts __tests__/enduringAgents/personaRecoveryCapture.test.ts __tests__/enduringAgents/personaRecoveryRestore.test.ts __tests__/enduringAgents/personaRecoveryZip.test.ts __tests__/enduringAgents/behaviorCallPins.test.ts __tests__/flow/gracefulCapLanding.test.ts __tests__/model/transientRetry.test.ts
node --test scripts/persona-goal-acceptance/model-turn-archive.test.mjs scripts/persona-goal-acceptance/endurance-evidence.test.mjs
```

The explicit Jest glob avoids the Windows `<rootDir>` expansion problem in
managed paths containing `.codex`; `--runTestsByPath` still limits selection to
the named suites. This is a local invocation workaround, not a runner repair.

The large fixture uses 5,600,000 canonical characters, 2,000,000 wire characters,
and 1 MiB of SDK media across three distinct dispatches. Assertions verify no
compressed-transcript reads during outcomes, byte-identical dispatch files,
complete canonical/wire content and media, bounded metadata and distinct
attempt/outcome identities. The character sizing is not a tokenizer measurement.
Real loopback OpenAI SDK tests cover a provider 400 followed by resume, a 503
custom retry, and a 400 cache-key rejection followed by negotiation. SDK-internal
retries are disabled in this fixture to join one HTTP request to each observed
SDK invocation. A separate deterministic suspended stream checks that no early
completion is manufactured. Capture/deletion/authority regressions and recovery
ZIP restore check their real persistence boundaries. A fresh Node process checks
the standalone evidence reader; it does not run a deployed application.

## Remaining acceptance

- Runtime admission, byte/concurrency/queue budgets, media hydration, event
  retention, and initial archive/inspection allocations still need independent
  bounds and repeated workload measurements. This slice sets a 1 KiB **outcome**
  limit, not a process heap/RSS cap.
- Repeated large-context batches under a declared process/container budget,
  retained heap/RSS/external memory, meaningful allocation samples and the
  original production/provider confirmation remain open under #569/#520.
- Windows/Linux default-heap production builds, installed-artifact/operator
  acceptance and selected-release process checks are separate from source tests.
  Build memory does not establish runtime memory acceptance.
- Persona append p95 <150 ms, peak RSS <=768 MiB and RSS growth <=256 MiB remain
  unchanged. Historical failing soaks and later revision-bound passes remain
  evidence for their own revisions. A new archive contract requires fresh
  selected-release evidence; a simulated 28-day run is not 28 elapsed days.
- #515 still needs canonical deployed `ap-*` workflow exports, prompt/template
  sources, route/node definitions and deployed revision. No speculative workflow
  fix is included here.
- #505 keeps real elapsed-time/public-world autonomy acceptance open; #435 keeps
  locale rendering, screen-reader/200% zoom, wider operational UX and independent
  human review open; #418 remains dependent on #435. No checklist or issue state
  is closed by these source checks. The A- judgment remains an independent
  reassessment under #564/#578.
