# Execution and MCP ownership contracts

Issue [#571](https://github.com/mario-andreschak/FLUJO/issues/571), part of
[#563](https://github.com/mario-andreschak/FLUJO/issues/563). Source baseline:
`3511ba49514fe8cf525f5a22c16c3806bf3886ba` (October 3, 2026).
This is a map of existing responsibilities and a contract for incremental
changes. It does not establish installed-release acceptance or award a grade.

Every file and test named on this page was checked against the code again on
November 25, 2026 ([#661](https://github.com/mario-andreschak/FLUJO/issues/661)).
The splitting work in #571 will move code out of `runFlow.ts`, `ModelHandler.ts`
and the MCP service `index.ts` after that check, so re-run the
[path check](#before-you-start) before relying on a file name here.

## Where to change a behavior

Paths starting with `src/` are relative to the repository root. Shorter paths
are relative to `src/backend/execution/flow/`, except in the two MCP rows, where
they are relative to `src/backend/services/mcp/`. A module owns the indicated
responsibility; its callers must use that boundary rather than duplicate its
state or enforcement. The topic owner is the integration owner for epic #563,
not a claim that an additional human maintainer has accepted responsibility.

| Responsibility | Existing entry point and state owner | Contract to preserve | Integration owner |
| --- | --- | --- | --- |
| Run lifecycle | `src/backend/execution/flow/runFlow.ts`; `runAdmission.ts` reserves run capacity; the live state map lives in `conversationStateRegistry.ts` and `FlowExecutor.conversationStates` reads it | `runFlow` claims run admission, acquires the workspace/conversation execution lock, validates loaded/input state, registers cancellation, and drives graph steps. Preserve explicit invocation source, terminal/paused distinction, and run-owned cleanup. | Maturity for behavior; Code health for sequenced extraction |
| Persona instruction/snapshot decisions | `personaRunContract.ts`, called by `runFlow.ts`; [contract](./persona-run-contract.md) | Keep the attribution triple, root/hash binding and same-Activity comparison at their existing caller sites. Schema parsing, context cloning, top-level admission, live authority and all operation ordering remain in `runFlow`. | Code health for extraction; Maturity/Security own behavioral enforcement |
| Conversation serialization | `conversationExecutionLock.ts` | One process-global, workspace-keyed queue; async-local reentry must not deadlock. A failed predecessor does not poison later runs. | Maturity |
| Execution authority | `executionAuthority.ts`; `src/backend/execution/extensions/` | Assert the current fence before effects; durable mutations use `commitFlowDurableMutation` and the authority's atomic commit capability. Authority failures escape best-effort catches. Loading a snapshot never reconstructs a runtime capability. | Security/Production consume original authority; Code health preserves interfaces |
| Cancellation | `cancellationCoordinator.ts`, `cancellation.ts`, `toolCancelRegistry.ts` | Admission-barrier check and run registration are atomic in one event-loop step. Cancellation aborts active work and respects ancestry/tombstones; release each registration. | Maturity; Production owns worker recovery |
| Approval and debugger pause | `toolApprovalRegistry.ts`, `resumeAfterApproval.ts`, `runFlow.ts` | A pause keeps the live state owned. Resume applies the decision to the pending call before continuing; do not dispatch an unapproved tool while extracting code. | Maturity; Security owns permission changes |
| Subflows | `nodes/SubflowNode.ts`, `subflowCommunication.ts`, `subflowRecovery.ts`, `handlers/subflowToolInvocation.ts`, `handlers/subflowDetachedInvocation.ts` | Parent/child and lane identities include logical-run lineage. Queued messages are consumed at safe boundaries. Ephemeral children do not become durable sidebar conversations. Unknown external tool effects are not automatically replayed. | Maturity; Production owns restart policy |
| Conversation persistence | `persistConversationState.ts`, `conversationPublication.ts`, `conversationLog.ts`, `loadConversationState.ts`, `recoveryCheckpoint.ts` | Canonical log, snapshot and checkpoint are distinct. Snapshot and log writes for one conversation go through `conversationPublication.ts` in order; a write whose outcome is uncertain leaves a fence that the next complete write clears, and the fence never blocks later writes. Reject unsafe IDs, deleted and ephemeral snapshots; strip trace/runtime capabilities; retain authority checks. Recovery reconciliation cannot grant permission to repeat uncertain effects. | Maturity; Security owns privacy/crypto |
| Conversation cache | `conversationStateCache.ts` around the map in `conversationStateRegistry.ts` | Keep one live-state registry. Only persistently terminal, unowned entries may be evicted; persistence failure must retain the state. | Maturity (#569) |
| Provider dispatch | `handlers/ModelHandler.ts`; `src/backend/services/model/adapters/` | The handler assembles input and selects the adapter; the adapter owns the actual SDK boundary. An intended turn is not an observed SDK dispatch. Preserve approval/authority/abort checks and each actual attempt marker. | Maturity; external streams own SDK/history consumers |
| Dispatch archive | `modelTurnArchive.ts` invoked by SDK callbacks in `handlers/ModelHandler.ts` | When archiving is enabled, persist the SDK request before emitting `model:dispatch`; update its outcome before `model:dispatch-result`. Preserve exact dispatch ID/ordinal and canonical versus wire context. Ordinary archive I/O failures may warn and continue; authority failures must propagate. | Maturity (#569) |
| Execution events | `engine/ExecutionEventBus.ts` and `src/shared/types/execution/events.ts` | Event sequence allocation/log append and UI delivery are separate responsibilities. UI retention changes cannot remove canonical history or synthesize provider dispatches. | Maturity; history/Brain consumers own their adapters |
| MCP connection ownership | `src/backend/services/mcp/index.ts` and `lifecycleCoordinator.ts` | Client/transport maps are process-global and workspace-scoped. The coordinator owns connect/teardown promises, generation and demand bookkeeping; it does not duplicate the clients. Old transport callbacks must not remove a replacement client. | Security owns isolation; Production owns #547 receipts |
| MCP demand/teardown | `mcpLeasePool.ts`, `connection.ts`, `ownerScope.ts` | Fold concurrent connect/teardown; keep leases/pins live until release. Await graceful close and verified descendant teardown. Server name alone is not an identity across workspaces. Derive Bash owner scope from the run. | Production for shutdown/recovery; Security for execution capabilities |

The process-global maps exist because Next.js can load multiple module graphs in
one process. Replacing them with module-local registries changes behavior even
when an ordinary unit test uses only one instance. See the
[MCP lifecycle guide](../features/mcp-lifecycle-hardening.md) and
[execution extensions contract](../features/execution-extensions.md).

## Import direction

`src/shared` owns contracts usable by both environments. It cannot import
`src/backend` or `src/frontend`. Backend cannot import frontend, and frontend
cannot import backend, including type-only dependencies. Cross-environment data
belongs in a shared DTO; it must not carry a runtime authority, secret, process,
or storage handle. `src/app` remains the composition/HTTP boundary, where server
and client imports depend on the route's role.

Run `node scripts/check-import-boundaries.cjs` to check every `.ts`, `.tsx`,
`.js`, `.jsx`, `.mts`, `.cts`, `.mjs` and `.cjs` file under those three layers.
Changing a module's extension does not exempt it from the dependency rules.
The checker resolves imports with the repository's
TypeScript configuration and inspects static imports, re-exports, import types,
literal dynamic imports and literal `require` calls. Comments and strings that
merely mention a path are not dependencies. New crossings fail. Each existing
exception in `scripts/import-boundary-debt.json` identifies an exact importer,
target and declaration with a removal reason; removed or changed exceptions
also fail so that stale allowances cannot silently survive. Adding an exception
requires an architecture review, not an automatic baseline refresh.

This direct-layer check is a maintainability guard, not a security sandbox or a
complete client-bundle reachability proof. It does not follow transitive imports
through `src/utils`, check packages outside `src`, or resolve computed runtime
module names. Continue using framework/build checks and security reviews. The
installed Next.js `use-client` and Server/Client Components guides explain that
`use client` includes its imports in the client graph; `server-only` provides a
separate build-time guard. Do not use a type-only exception as permission to
import runtime backend code.

## First extraction: invocation source

Before this change, `src/backend/execution/flow/types.ts` owns both runtime
execution state and the invocation-source enum/helpers, and
`src/frontend/components/Chat/conversationOrigin.ts` imports the source type
from that backend file.

After this change, `src/shared/types/execution/invocation.ts` owns only the eight
source values, validation, and interactive/unattended classification. It has
no imports or side effects. The backend file imports and re-exports the same
symbols, retaining every existing caller's interface; the sidebar imports the
shared type directly. The extraction changes no source values, validation,
defaulting, drive-forward decisions, event order, state registry, or dispatch.
Debugger snapshots and package DTOs remain named architectural debt for later
small PRs.

## Shared graph geometry

`src/shared/utils/flowLayout/` owns the existing auto layout, tidy layout and
geometry algorithms. They operate only on graph data and coordinates; no
provider, MCP, storage, workspace or React runtime belongs in this cluster.
React Flow's `Edge` and the canonical shared `FlowNode` are type-only imports.
Frontend `Canvas/utils` paths retain compatibility re-exports of the same
functions and fallback objects. Model-to-agent creation imports the shared
algorithm directly, and `FlowConverter` consumes the existing shared graph DTO.
The frontend presentation `Flow` interface stays a subset; its node and node-type
definitions use the shared contract rather than duplicate structural interfaces.

The extraction changes imports/ownership, not algorithm bodies or defaults.
Before/after standalone traces compare six frozen graphs in both modes,
including empty/single no-ops, branching attachments, measured-height cycles,
orphans and already-separated nodes. A child process permits only the three
compiled geometry modules; adding a runtime import is a failing negative control.
Frontend compatibility and backend creation regressions verify the consumer
boundaries, including idempotent retry and failed validation/persistence.

The baseline tidy algorithm leaves overlaps in the coincident-satellite and
orphan fixtures. Those observations stay explicit in the trace; this extraction
does not fix them. Full auto layout resolves these fixtures. The historical
blanket no-overlap smoke assertion failed before extraction and is retained
in the source evidence. Single child-process timing/RSS samples describe only
this fixture and are not an agreed performance budget or product resource claim.

Use the existing ordinary-run, unattended drive-forward and origin-display
regressions with the new invocation contract tests. Before extracting any of the
other seams, retain ordered traces at its actual boundary, including failure and
pause paths. The following existing suites are starting points, not claims that
they cover every required installed scenario:

| Boundary | Existing regression suites under `__tests__` |
| --- | --- |
| Ordinary/ephemeral run and unattended classification | `chat/runFlow.test.ts`, `flow/unattendedDriveForward.test.ts` |
| Debug/approval pause and decision | `chat/debuggerFrames.test.ts`, `flow/toolApprovalSingleGate.test.ts` |
| Caps/error classification | `flow/gracefulCapLanding.test.ts`, `flow/errorDetailPropagation.test.ts` |
| Authority/durable mutation | `flow/executionAuthority.test.ts`, `flow/kvAuthorityFencing.test.ts` |
| Subflow lineage/recovery | `flow/subflowCommunication.test.ts`, `flow/SubflowNode.recovery.test.ts` |
| Cancellation/interrupted recovery | `flow/cancellationCoordinator.test.ts`, `flow/recoveryCheckpoint.test.ts` |
| Actual dispatch/archive | `flow/modelTurnArchive.test.ts`, `model/completionCancellation.test.ts`, `model/codexAdapter.test.ts` |
| MCP multiple-instance/connect/teardown | `mcp/crossInstancePoisonedClient.test.ts`, `mcp/mcpConnectionLifecycle.test.ts` |

## A second maintainer's exercise

**Status on November 25, 2026: not done.** It needs two people; an agent or a
CI run cannot do it. It is tracked in
[#661](https://github.com/mario-andreschak/FLUJO/issues/661). A passed exercise
ticks the #571 item "a second human contributor can locate and change one
execution behavior and one MCP lifecycle behavior using the architecture guide"
and counts as one entry in the people record of #576.

**Do it after #571 lands.** #571 splits `runFlow.ts`, `ModelHandler.ts` and the
MCP service `index.ts` into smaller files. Before that, the exercise tests a map
that is about to change. Either way, start with the path check below.

### Who does what

- **Operator** (Mario, as nominated in #661): finds, explains and fixes two
  small planted faults in production code. Does not read the
  [seeds](#seeds-for-the-observer) or the git history of the seed commits.
- **Observer:** a person, not an AI agent. Plants the faults, watches (in the
  room or on a video call), writes down every hint and judges the result. Write
  down who they are and how they know the operator or the project.
- Nobody else writes or suggests the fix. Reading this page and searching the
  code is allowed. Asking an AI assistant for the fix counts as a hint.

### Time box: 2 hours

| Step | Time box |
| --- | --- |
| Path check, setup and baseline | 30 minutes (the install alone takes 4 to 8 minutes) |
| Task A: execution | 40 minutes |
| Task B: MCP | 40 minutes |
| Write-up | 10 minutes |

When a task reaches its time box, stop, write down how far you got and move on.
An unfinished task is recorded as unfinished.

### Before you start

In a fresh clone (full history, see the
[contributor guide](../contributing/README.md#1-get-your-own-copy)), switch to
the exact commit you will use and check that the code is still where this page
says (PowerShell or any shell):

```sh
git ls-files --error-unmatch src/shared/types/execution/invocation.ts src/backend/execution/flow/runFlow.ts src/backend/services/mcp/index.ts src/backend/services/mcp/lifecycleCoordinator.ts __tests__/flow/invocationSource.test.ts __tests__/flow/unattendedDriveForward.test.ts __tests__/mcp/mcpRestartLoop.test.ts scripts/check-import-boundaries.cjs
git grep -n "isUnattendedFlowInvocation(input.source)" -- src
git grep -n "transport.onclose = bindToCurrentWorkspace" -- src/backend/services/mcp
```

The first command must list all eight files without an error. The other two
must each print one line. If a line points to a different file than below, use
that file in the tasks. If a command finds nothing, the code has moved: fix this
page in a small pull request first, then start.

### Step 1: set up and record the baseline

1. Install as in the contributor guide, steps
   [2](../contributing/README.md#2-install) and
   [3](../contributing/README.md#3-check-that-it-works): `npm ci --include=dev`,
   `npm run build:mcp`, `npm run test:dependencies`.
2. Write down: the commit (`git rev-parse HEAD`), `node --version`,
   `npm --version`, the operating system, the start time and any setup trouble.
3. In the same PowerShell window, create a results folder outside the clone and
   the check you will run after every change:

   ```powershell
   $out = (New-Item -ItemType Directory -Force ..\exercise-661).FullName
   function Invoke-ExerciseCheck([string]$Name) {
     git rev-parse HEAD | Tee-Object "$out\$Name.log"
     node scripts/run-local-jest.cjs --selectProjects node --runInBand --runTestsByPath __tests__/flow/invocationSource.test.ts __tests__/flow/unattendedDriveForward.test.ts __tests__/mcp/mcpRestartLoop.test.ts --json "--outputFile=$out\$Name.json" 2>&1 | Tee-Object -Append "$out\$Name.log"
     "tests exit code: $LASTEXITCODE" | Tee-Object -Append "$out\$Name.log"
     node scripts/check-import-boundaries.cjs 2>&1 | Tee-Object -Append "$out\$Name.log"
     "import check exit code: $LASTEXITCODE" | Tee-Object -Append "$out\$Name.log"
     Get-Content "$out\$Name.json" | ConvertFrom-Json | Select-Object numPassedTests, numFailedTests, numPendingTests, numTodoTests | Tee-Object -Append "$out\$Name.log"
   }
   ```

   On Linux or macOS, run the same two `node` commands and save their output
   with `| tee`.
4. Run `Invoke-ExerciseCheck baseline`. Both exit codes must be 0, and
   `numFailedTests`, `numPendingTests` and `numTodoTests` must be 0. If not,
   the base is broken: stop, record it and open an issue.

The commit printed at the top of each log identifies the exact files, so no
separate file hashes are needed.

### Step 2: task A, execution

Observer, out of the operator's sight:

1. `git switch -c task-a`, then make one small change to production code (not
   under `__tests__`) that makes a run started through the API count as
   unattended. Use a [seed](#seeds-for-the-observer) or write your own of the
   same size. A remote observer can send it as a patch file that the operator
   applies with `git apply` without opening it.
2. `git commit -am "task A"`, then `git diff HEAD~1 > "$out\seed-a.diff"` and
   `Invoke-ExerciseCheck seed-a`. At least one test must fail. If all pass, the
   seed is too weak; pick another.

Operator, with the clock running:

3. The bug report: "A flow started through the API carries on by itself after
   the model answers in plain text, as if nobody were watching. Chat runs behave
   correctly." Start from `src/shared/types/execution/invocation.ts` and the
   place in `runFlow.ts` that uses it.
4. Explain out loud what you found ([what the observer listens for](#what-the-observer-listens-for)).
5. Fix production code only: do not change, skip or delete tests, and do not
   bring the old file back with `git checkout` or `git restore`. Then
   `git commit -am "fix A"`, `git diff HEAD~1 > "$out\repair-a.diff"` and
   `Invoke-ExerciseCheck repair-a`. Both exit codes must be 0.

### Step 3: task B, MCP

Observer: `git switch -c task-b <base commit>` (start from the clean base, not
from task A), plant a fault that makes a late close event from an old connection
drop the working connection, then `git commit -am "task B"`,
`git diff HEAD~1 > "$out\seed-b.diff"` and `Invoke-ExerciseCheck seed-b`. At
least one test must fail.

Operator: the bug report is "After FLUJO replaces an MCP server's connection
(for example after a settings change), the old server process exits a little
later. FLUJO then drops the working connection and starts yet another one."
Start from `transport.onclose` in `src/backend/services/mcp/index.ts` and from
`lifecycleCoordinator.ts`. Explain out loud, fix production code only, then
`git commit -am "fix B"`, `git diff HEAD~1 > "$out\repair-b.diff"` and
`Invoke-ExerciseCheck repair-b`. Both exit codes must be 0.

These tests replace the real MCP connection and the clock with test doubles.
They do not watch a real server process shut down.

### What the observer listens for

Task A:

- `isUnattendedFlowInvocation` treats only `chat` and `api` as attended; the
  other six sources (`schedule`, `trigger`, `subflow`, `mcp`, `internal`,
  `meeting`) run unattended.
- `runFlow` keeps the conversation's first `source`, but works out `unattended`
  fresh for every run from that run's own source.
- The old `unattended` flag in a flow's file decides nothing, because a flow
  cannot know who started this run. The tests "does NOT drive forward for
  attended api runs" and "ignores legacy unattended:false for a scheduled run"
  check this.
- What unattended changes: when the model ends a turn without handing off, the
  run is pushed on to the single next step instead of stopping.
- Why the fix leaves the other seven sources as they were.

Task B:

- Each server has one current connection in `activeTransports`, shared by every
  copy of the module and kept per workspace. A close event acts only when it
  comes from that current connection.
- FLUJO's own closes (disconnect, reconnect, settings change) remove the
  connection first (`deregisterClient`), so their close events are ignored and
  do not reconnect.
- An unexpected close of the current connection removes the client and
  schedules a retry, if the server is still enabled.
- `beginConnect` and `beginTeardown` in `lifecycleCoordinator.ts` merge
  parallel calls into one and wait for each other. The generation number goes
  up with each new connection, so old callbacks can tell they are out of date.
  Workspace plus server name identify a server; the name alone does not.
- Why the fix keeps both the retry after an unexpected close and the "no
  retry" after an intentional disconnect.

### How the result is judged

- **Passed:** in both tasks the operator found the fault, explained the points
  above in their own words and fixed production code. The repair check shows
  both exit codes 0 and no failed, skipped or todo tests. No hint named the
  line or the fix. Small nudges ("look at the close handler again") are allowed
  and recorded.
- **Partly passed:** only one task passed, a hint named the line or the fix, or
  a task was finished after its time box.
- **Not passed:** a test was changed, skipped or deleted; the fix only brought
  back the original file; somebody other than the operator wrote the fix; or
  neither task was finished.

Only "Passed" ticks the #571 item. The other results are still posted, as they
are.

### What to post on #661

The observer posts one comment:

```text
Exercise #661, date:
Operator:            Observer:            How the observer knows the operator or project:
Base commit:         OS / Node / npm:     Start / end:          Setup trouble:
Task A: seed commit:      failing tests (seed-a.log):
        fix commit:       exit codes (repair-a.log):      minutes:      hints:
        operator's explanation, short:
Task B: seed commit:      failing tests (seed-b.log):
        fix commit:       exit codes (repair-b.log):      minutes:      hints:
        operator's explanation, short:
Observer's review of the two fixes:
Result: Passed / Partly passed / Not passed, because:
```

Attach the four `.diff` files and the five `.log` files from the results folder.
The diffs are the change to review; no pull request is needed. Then add one
line for the operator to the [people record](../contributing/maintainership.md#evidence-record)
in #576 and link the comment from #571. Delete the clone and the results folder
once the comment is posted.

### Seeds for the observer

Operator: skip this part.

Task A, pick one:

1. In `src/shared/types/execution/invocation.ts`, make
   `isUnattendedFlowInvocation` return `source !== 'chat'`. Aimed at the `api`
   cases in `invocationSource.test.ts` and `unattendedDriveForward.test.ts`.
2. In `runFlow.ts`, change
   `sharedState.unattended = isUnattendedFlowInvocation(input.source);` to
   `sharedState.unattended = input.source !== 'chat';`. Aimed at the `api`
   cases in `unattendedDriveForward.test.ts` only: the shared helper still looks
   right, so the operator has to follow it to its caller.

Task B, pick one:

1. In `transport.onclose` in `src/backend/services/mcp/index.ts`, change the
   check `this.activeTransports.get(config.name) !== transport` to
   `!this.activeTransports.has(config.name)`. Aimed at "ignores a late close
   event from a replaced (zombie) transport"; an intentional disconnect still
   behaves.
2. In the same handler, move `this.deregisterClient(config.name);` above that
   check. Aimed at the zombie test and at "still schedules a reconnect for an
   unexpected close of the live transport".

These seeds were worked out by reading the tests on November 25, 2026, not by
running them; the seed check in steps 2 and 3 confirms them on the day. After
#571 the lines may sit in another file; change the same decision wherever it
now lives.

## Size inventory and evidence limits

At the baseline, tracked `src` files total 14,678,319 bytes (1,263 files), tracked
`docs/images` total 11,260,925 bytes (19 files), and tracked `public` totals 82,757
bytes (11 files). These are file bytes from `git ls-files` and filesystem lengths,
not line counts or a package-size measurement.

On October 3, npm registry metadata for `flujo-ai@3.46.2` reports 1,694 files and
44,183,071 unpacked bytes, with integrity
`sha512-QIX1FBKDQvIZBGI6TVx7rHBHlO/FyobSTgop+RhaYwvtBiq4hqbZNqf7ytQYcjExBScZ5fn6Art4sJeZMs3lqQ==`.
This is a registry report (`npm view flujo-ai@3.46.2 dist --json`), not a locally
downloaded or installed-artifact assertion, and no source/release equivalence is
inferred from the version number.

`git count-objects -v` on the shared object store reported `size: 31074` and
`size-pack: 143026` KiB. That includes historical/other-branch objects and can
change during parallel work; it is not the size of the current source or shipped
app. No Git-history rewrite or asset deletion is proposed from these numbers.

This PR's source checks must be recorded against its exact commit separately
from full Windows/Linux builds, packed process smoke, installed UI acceptance,
performance comparison, second-human evidence, and independent reassessment.
Those outstanding gates keep the complete #571/#563 outcome open. Engineering
owns adding dedicated boundary-check invocation to verification workflows;
the regression suite already discovers the boundary test without runner edits.

## Shared package API contracts

`src/shared/types/package/build.ts`, `install.ts`, and `registry.ts` own the
package selection/build results, install inspection/progress/results, and
public registry browse results. They export types only. Their dependencies are
the existing shared manifest and install-origin types; importing a DTO does
not import an installer, storage, registry transport, authentication, or MCP
process code. Build and install entity-type names retain their different
meanings in separate modules.

Backend services retain type reexports for existing consumers. The package
wizard, read-only graph preview and frontend fetch service import the shared
definitions directly. The extraction preserves all 25 declaration bodies and
the emitted JavaScript of the six affected services/components. Install consent,
secret handling, disabled planned executions, deterministic identifiers and
partial-result ordering remain backend responsibilities and are unchanged.

Use package build/install, secret-derivation, Persona protection, registry
transport and wizard/preview regressions when changing this seam. Type checking
and the import guard verify consumer compatibility and direct layer boundaries;
these checks do not establish packaged-release acceptance or authorize effects.
