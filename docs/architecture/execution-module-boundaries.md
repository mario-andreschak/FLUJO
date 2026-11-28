# Execution and MCP ownership contracts

Issue [#571](https://github.com/mario-andreschak/FLUJO/issues/571), part of
[#563](https://github.com/mario-andreschak/FLUJO/issues/563). Source baseline:
`3511ba49514fe8cf525f5a22c16c3806bf3886ba` (October 3, 2026).
This is a map of existing responsibilities and a contract for incremental
changes. It does not establish installed-release acceptance or award a grade.

#571 split `runFlow.ts`, `ModelHandler.ts` and the MCP service `index.ts` into
modules with one job each on November 27, 2026 (see
[the module map](#the-three-big-files-and-the-modules-split-out-of-them)). On
November 28 a maintainer who did not write the split used this page for six
maintenance tasks ([report](./maintenance-exercise-661.md)) and the gaps it
found are fixed here. `npm run check:hotspots` fails when a file named on this
page no longer exists.

## Where to change a behavior

Paths starting with `src/` or `__tests__/` are relative to the repository root.
A shorter name is relative to the folder its row names, or else to
`src/backend/execution/flow/` (in the MCP rows, `src/backend/services/mcp/`).
A module owns the indicated
responsibility; its callers must use that boundary rather than duplicate its
state or enforcement. The topic owner is the integration owner for epic #563,
not a claim that an additional human maintainer has accepted responsibility.

| Responsibility | Existing entry point and state owner | Contract to preserve | Integration owner |
| --- | --- | --- | --- |
| Run lifecycle | `src/backend/execution/flow/runFlow.ts` with `runStateLoading.ts`, `runStateSetup.ts`, `runTurnAdmission.ts` and `runPreflight.ts` (start of a run); `runAdmission.ts` reserves run capacity; the live state map lives in `conversationStateRegistry.ts` and `FlowExecutor.conversationStates` reads it | `runFlow` claims run admission, acquires the workspace/conversation execution lock, validates loaded/input state, registers cancellation, and drives graph steps. Preserve explicit invocation source, terminal/paused distinction, and run-owned cleanup. | Maturity for behavior; Code health for sequenced extraction |
| Who started a run, and whether anyone is watching | `src/shared/types/execution/invocation.ts` (the eight sources; only `chat` and `api` are attended), applied to each run by `installRunInputs` in `runStateSetup.ts`; `unattendedDriveForward.ts` acts on it | A conversation keeps the `source` of its first run; `unattended` is worked out again for every run from that run's own source, so a person answering a scheduled run is attended. The `unattended` field once stored in flow files decides nothing. FLUJO's own HTTP chat API (`src/app/v1/chat/completions/chatCompletionService.ts`) passes `chat`, or `internal` when FLUJO runs as a worker; schedules, triggers, MCP tools, subflows and meetings pass their own source. No route passes `api` today; it stays valid for other callers of `runFlow` and for recorded Harness runs. | Maturity |
| Pre-run checks | `runPreflight.ts` for checks that depend on this run: allowed models, the Quick Chat switch, entry conditions, and running the flow validation. Rules about a flow's shape (missing Start step, step without a model, dangling tools) live in `src/utils/shared/flowValidation.ts`, which the editor shows too; `validateFlowForRun.ts` adds the current models and MCP servers | Only a new turn or a new conversation is checked; an internal resume (approval decision, debugger step) carries on a run that already passed. A new shape rule goes into that validation, not into a new block in `runPreflight.ts`: many tests run flows with no steps through a stubbed validator. | Maturity |
| Persona instruction/snapshot decisions | `personaRunContract.ts`, called by `runFlow.ts`; [contract](./persona-run-contract.md) | Keep the attribution triple, root/hash binding and same-Activity comparison at their existing caller sites. Schema parsing, context cloning, top-level admission, live authority and all operation ordering remain in `runFlow`. | Code health for extraction; Maturity/Security own behavioral enforcement |
| Conversation serialization | `conversationExecutionLock.ts` | One process-global, workspace-keyed queue; async-local reentry must not deadlock. A failed predecessor does not poison later runs. | Maturity |
| Execution authority | `executionAuthority.ts`; `src/backend/execution/extensions/` | Assert the current fence before effects; durable mutations use `commitFlowDurableMutation` and the authority's atomic commit capability. Authority failures escape best-effort catches. Loading a snapshot never reconstructs a runtime capability. | Security/Production consume original authority; Code health preserves interfaces |
| Cancellation | `cancellationCoordinator.ts`, `cancellation.ts`, `toolCancelRegistry.ts` | Admission-barrier check and run registration are atomic in one event-loop step. Cancellation aborts active work and respects ancestry/tombstones; release each registration. | Maturity; Production owns worker recovery |
| Approval and debugger pause | `toolApprovalRegistry.ts`, `resumeAfterApproval.ts`, `runFlow.ts` (the pause), `runToolApproval.ts`, `runDebugPause.ts` | A pause keeps the live state owned. Resume applies the decision to the pending call before continuing; do not dispatch an unapproved tool while extracting code. | Maturity; Security owns permission changes |
| Subflows | `nodes/SubflowNode.ts`, `subflowCommunication.ts`, `subflowRecovery.ts`, `handlers/subflowToolInvocation.ts`, `handlers/subflowDetachedInvocation.ts` | Parent/child and lane identities include logical-run lineage. Queued messages are consumed at safe boundaries. Ephemeral children do not become durable sidebar conversations. Unknown external tool effects are not automatically replayed. | Maturity; Production owns restart policy |
| Chat goals (agent chats, #1225) | `src/backend/services/chatGoals/`: `chatGoalStore.ts` (one goal per chat, changed one writer at a time), `chatGoalPolicy.ts` (pure: what a finished turn means for the goal) and `chatGoalRuntime.ts` (starts the next goal turn); the route `src/app/v1/chat/conversations/[conversationId]/goal/route.ts` | The runtime learns that a chat run ended from the flow-run event bus (`runFlowEvents.ts` publishes, the runtime subscribes per workspace), never from an import into `runFlow.ts`. A goal turn starts only under the conversation execution lock, after run admission, through `runFlow` with `resumeAsNewTurn` and the chat's own `requireApproval`, so approvals and Stop work as for a typed message. Every turn is looked at once (`reviewedMessageId`); the minute sweep in `src/backend/init.ts` picks up goals after a restart or a wait. `goalTurn` on a message is display-only and stripped from the wire in `buildNodeContext.ts`. | Maturity |
| Conversation persistence | `persistConversationState.ts`, `conversationPublication.ts`, `conversationLog.ts`, `loadConversationState.ts`, `recoveryCheckpoint.ts` | Canonical log, snapshot and checkpoint are distinct. Snapshot and log writes for one conversation go through `conversationPublication.ts` in order; a write whose outcome is uncertain leaves a fence that the next complete write clears, and the fence never blocks later writes. Reject unsafe IDs, deleted and ephemeral snapshots; strip trace/runtime capabilities; retain authority checks. Recovery reconciliation cannot grant permission to repeat uncertain effects. | Maturity; Security owns privacy/crypto |
| Conversation cache | `conversationStateCache.ts` around the map in `conversationStateRegistry.ts` | Keep one live-state registry. Only persistently terminal, unowned entries may be evicted; persistence failure must retain the state. | Maturity (#569) |
| Provider dispatch | `handlers/ModelHandler.ts` (the attempt and its retries), `handlers/providerWire.ts` (what is sent), `handlers/contextOverflowRetry.ts`; `src/backend/services/model/adapters/` | The handler assembles input and selects the adapter; the adapter owns the actual SDK boundary. An intended turn is not an observed SDK dispatch. Preserve approval/authority/abort checks and each actual attempt marker. | Maturity; external streams own SDK/history consumers |
| Context compaction (#1091) | `handlers/wireCompaction.ts` decides when and records what each summary cost; `handlers/summarizingCompaction.ts` builds it; `src/backend/services/model/adapters/anthropicCompaction.ts` owns Anthropic's native summary request, the signed block and its refusal memory; `src/backend/services/model/adapters/claudeCompactionCarry.ts` puts FLUJO records back after Claude Code's own compaction | Only the wire changes. FLUJO's exact records follow every summary, whoever wrote it. A signed block goes back first and unchanged, or as plain text. Every native failure falls back to FLUJO's own summary in the same pass and heals without a restart. | Maturity |
| Dispatch archive | `modelTurnArchive.ts` invoked by SDK callbacks in `handlers/ModelHandler.ts`; `handlers/nativeOriginalPublication.ts` for native Original sessions | When archiving is enabled, persist the SDK request before emitting `model:dispatch`; update its outcome before `model:dispatch-result`. Preserve exact dispatch ID/ordinal and canonical versus wire context. Ordinary archive I/O failures may warn and continue; authority failures must propagate. | Maturity (#569) |
| Tool results | `handlers/toolCallProcessing.ts` (dispatch, order, `tool:result` event, the tool message); in `src/backend/services/runResources/`: `capture.ts` (binary and large results become run resources), `toolResultMedia.ts` (images and audio go to the model as input), `boundToolResult.ts` and `toolResultBound.ts` (the size limit, #1226); `stepToolResults.ts` (the AI step's own limit, its model's context window and the store that keeps moved results, #1226); `toolRepeatGuard.ts` (success or failure of a call) | Results go back in the order the model asked for them, whatever order they finish in. A failed capture keeps the original result and never breaks the run; authority errors still propagate. Every path (the tool loop, a call a person approved, the agent CLI adapters, the native broker, history reload) gets the step's limit and store as `toolResults`; a run that saves nothing keeps moved results in the nearest saved conversation above it, or in an `unsaved-<run>` store that ends with the run (the hourly sweep removes leftovers). `handlers/contextWindowFit.ts` only shrinks results again when a provider rejects a request as too long. | Maturity |
| Execution events | `engine/ExecutionEventBus.ts` and `src/shared/types/execution/events.ts` | Event sequence allocation/log append and UI delivery are separate responsibilities. UI retention changes cannot remove canonical history or synthesize provider dispatches. | Maturity; history/Brain consumers own their adapters |
| MCP connection ownership | `src/backend/services/mcp/index.ts` (connect, disconnect, the transport's `onclose` and `onerror` callbacks), `serviceRegistries.ts` (the maps), `connectionScheduling.ts` (startup and retries) and `lifecycleCoordinator.ts` | Client/transport maps are process-global and workspace-scoped. The coordinator owns connect/teardown promises, generation and demand bookkeeping; it does not duplicate the clients. Old transport callbacks must not remove a replacement client: `onclose` and `onerror` act only while their transport is still the one in `activeTransports` for their workspace (`bindToCurrentWorkspace` keeps the workspace). FLUJO's own closes remove the transport first, so they never schedule a retry. Two counters go up with each new client and are not the transport check: `clientGenerations` in `serviceRegistries.ts` makes tool names planned against a replaced client stale, and the coordinator's `generation` makes leases (`mcpLeasePool.ts`) and shutdown receipts stale. | Security owns isolation; Production owns #547 receipts |
| MCP server notifications | Registered on each new client in `connectServer` (`index.ts`), before `client.connect`; the handlers live in `resourceNotifications.ts` (resource and tool lists), `inboundEvents.ts` (Claude channel) and `serverEventStream.ts` (event streams); newer-protocol clients get theirs in `betaClient.ts` | A handler that acts on the live connection first checks that the message comes from the current client, as the Claude channel handler does. A new notification handler goes into one of these modules; see [adding to a big file](#adding-to-a-big-file) for the line in `index.ts`. | Maturity |
| MCP demand/teardown | `mcpLeasePool.ts`, `connection.ts`, `ownerScope.ts` | Fold concurrent connect/teardown; keep leases/pins live until release. Await graceful close and verified descendant teardown. Server name alone is not an identity across workspaces. Derive Bash owner scope from the run. | Production for shutdown/recovery; Security for execution capabilities |

The process-global maps exist because Next.js can load multiple module graphs in
one process. Replacing them with module-local registries changes behavior even
when an ordinary unit test uses only one instance. See the
[MCP lifecycle guide](../features/mcp-lifecycle-hardening.md) and
[execution extensions contract](../features/execution-extensions.md).

## The three big files and the modules split out of them

On November 27, 2026 (#571) the three biggest execution and MCP files were
split by responsibility. Code was moved, not rewritten: each move is its own
commit, and the same test suites pass before and after (see
[how it was checked](#how-the-split-was-checked)). Public exports stay where
they were: `runFlow.ts` still exports the run types, `ModelHandler` keeps its
public methods, and `mcpService` keeps every public method as a one-line call
into the module that now owns the code.

| File | Lines before (`wip-cleanup` `de5a1cdf`) | Lines after |
| --- | --- | --- |
| `src/backend/execution/flow/runFlow.ts` | 4,048 | 2,056 |
| `src/backend/execution/flow/handlers/ModelHandler.ts` | 5,279 | 1,700 |
| `src/backend/services/mcp/index.ts` | 4,294 | 2,532 |

What stays in each file is the part that needs all of its state at once:
`runFlow.ts` keeps admission, locking, the step loop, the approval pause
(only runFlow pauses a run, see `docs/corrections/one-tool-approval-gate.md`)
and terminal persistence. `ModelHandler.ts` keeps `callModel` and
`generateCompletion`, which wire the modules below together and own the
provider attempt, its retries and the cancellation watch. The MCP service keeps
connecting, disconnecting, tool listing and tool calls, which share the live
client and transport registries.

### Contracts every split module keeps

- **One job.** Each module's first line says what it is for, in one sentence.
- **No import back.** A split module never imports its big file, not even
  lazily or for a type. What it needs comes in as parameters: the run's current
  state, an emitter, or a small *host* object of service methods. The checks
  below enforce this.
- **Late binding stays late.** `runFlow` replaces its state object after every
  step, so modules read it through a getter (`state()`) or receive it at each
  call. MCP hosts read registries through accessor functions when used, so a
  retry that fires minutes later sees its workspace's current registry.
- **Tests keep their seams.** Modules call service methods through the host,
  so a test that replaces `mcpService.connectServer` (or another public
  method) still sees every internal call.

### runFlow.ts (`src/backend/execution/flow/`)

| Module | Owns | Contract |
| --- | --- | --- |
| `runFlowContract.ts` | Run input and result types | Types only; `runFlow.ts` re-exports them. |
| `runInputValidation.ts` | Checks a request before anything loads | Pure; throws `TypeError` for an invalid source, meeting context, Persona authority or Core App refs. |
| `runStateLoading.ts` | Loading the live or saved conversation; refusing one this run may not continue | Never loads storage for an ephemeral run; Persona-owned or meeting-reserved conversations throw. |
| `runStateSetup.ts` | The state object of the run and this invocation's inputs on it | Sets `unattended` from this run's source every time; keeps the conversation's first `source`. |
| `runStatistics.ts` | `run.started`, `run.paused`, `run.finished` and the flow revision | `run.started` and `run.finished` at most once per logical run; a pause records `run.paused` each time. |
| `runTurnAdmission.ts` | Admitting the request's messages; pinning a new conversation's flow | Returns the error result when no flow resolves; display-only subflow steps never enter the transcript. |
| `runTurnRouting.ts` | The node a turn enters at | A new message goes to the step it names, an errored turn's Retry replays from its entry node. |
| `runPreflight.ts` | Running the flow validation, allowed models, Quick Chat switch, entry conditions | Returns whether a check failed; runFlow then takes its ordinary error path. Only a new turn or a new conversation is validated. Shape rules belong in `src/utils/shared/flowValidation.ts`. |
| `runSteeringDrain.ts` | Folding steering messages into a running flow | Only at a transcript-safe boundary; a failed write re-queues the messages. |
| `runDebugPause.ts` | Debugger boundaries, attach requests, breakpoints, pause events | Receives the current state and emitter at each call. |
| `runToolApproval.ts` | Which calls need a person; the live decision a sub-flow asks for | Never pauses the run itself. |
| `runUsage.ts` | Token usage totals and the usage event | A call without reported usage is counted as not reported. |
| `unattendedDriveForward.ts` | Pushing an unattended run on after a plain-text answer | Unchanged decision rules (#218). |
| `stagedHandoff.ts` | Finding a staged hand-off and its unanswered calls | Pure. |
| `personaActivityState.ts` | Installing a new Persona Activity snapshot | Only when a new Activity rebuilds the prompt prefix. |
| `runFlowEvents.ts` | Announcing finished runs on the flow-run event bus | Fire and forget. |
| `runFlowResult.ts` | Shaping the final error or output | Pure. |
| `stepToolResults.ts` | The tool result size limit of the step whose tools run, and where its moved results are kept (#1226) | Reads the step and its model through cached lookups; any gap uses the workspace setting and a 128K-token window. Releasing a finished run's own store never throws. |

### ModelHandler.ts (`src/backend/execution/flow/handlers/`)

| Module | Owns | Contract |
| --- | --- | --- |
| `modelCompletionContract.ts` | The options of one provider completion (`GenerateCompletionOptions`) | Types only; modules that receive `generateCompletion` use it. |
| `providerWire.ts` | Building what one completion sends | Changes only the wire, never the canonical conversation; returns an error Result when the request cannot fit. |
| `wireCompaction.ts` | Summarizing compaction of old history on the wire, native or FLUJO's own, and the measurement of each summary | Receives `generateCompletion` and the cancellation check as parameters. |
| `contextOverflowRetry.ts` | One smaller retry wire after a context-length rejection | Undefined when nothing can shrink; the caller then keeps the provider error. |
| `contextWindowFit.ts` | Input budget (including a size a provider refused, for an hour), token estimate, saving every tool result and long arguments before a smaller retry so finished call groups can leave as exact receipts, `read_resource` arming | Reads and writes only run resources. The first size limit on a tool result is in `src/backend/services/runResources/boundToolResult.ts`. |
| `providerErrorShape.ts` | Provider error bodies and thrown errors as one readable error | Authority errors are rethrown, never shaped. |
| `providerAttemptStatistics.ts` | `model.attempt` statistics per provider attempt | Never affects the provider call. |
| `nativeOriginalPublication.ts` | Publishing the native Original session of an archived dispatch | Any mismatch holds the invocation; reports the session as soon as it exists. |
| `selfOrchestratedToolExecutors.ts` | FLUJO tools an agent SDK runs inside its own loop | Only tools the call offers get an executor. |
| `liveModelProjection.ts` | Live transcript, delta and tool-progress events of a running call | Ordered writes under the run's authority; closed before draining. |
| `modelSteering.ts` | Steering messages for agent SDK adapters | Persist before sending; acknowledge or return to the inbox. |
| `modelTurnResult.ts` | Turning a successful reply into conversation messages | Starts from the complete threaded input; wire-only changes never reach it. |
| `streamedAssistantMessages.ts` | Folding and retracting streamed assistant prose | Retracts only prose of a failed attempt, never tool activity. |
| `modelHandlerSettings.ts` | The settings ModelHandler reads | A failed read uses the documented default. |
| `toolCallProcessing.ts` | One model turn's tool calls: approval, MCP and FLUJO tools, subflows, and what each result becomes | Results in call order; the approval gate before any dispatch. The "Tool results" row above lists the modules it uses. |
| `modelMedia.ts` | Saving model media | Shared by both paths. |

### MCP service index.ts (`src/backend/services/mcp/`)

| Module | Owns | Contract |
| --- | --- | --- |
| `serviceRegistries.ts` | The process-global client, transport, generation and schema-hash maps; `scopedRegistry`; `liveClient`, the live client of a server | Imported first by the service; the default workspace keeps the original maps. `liveClient` removes a closed client and reports it as missing. |
| `connectionScheduling.ts` | Startup sweep and backoff retries after an unexpected close | A retry pings a live client before tearing anything down; needs-user-action failures stop retrying. A disabled or deleted server is checked again when the retry fires. Any successful connection resets the backoff. After five failed retries it stops; the next use of the server connects it again through a lease (`mcpLeasePool.ts`), and the startup sweep does at the next start. |
| `connectionTest.ts` | The "Test Run" probe on a throwaway client | Never registers the client; one classic-handshake retry. |
| `serverStatus.ts` | The status the MCP page shows | A live client is authoritative over stale OAuth hints. |
| `serverConfigSave.ts` | What a config save writes: encrypted secrets, the managed root folder | Masked values keep the stored secret; bindings stay references. |
| `serverConfigUpdate.ts` | Saving, renaming and deleting a config; aligning the live connection | A rename migrates flow references and tears down everything under the old name before connecting the new one. |
| `serviceSkills.ts` | MCP Skills through the service | Loading a skill needs an approval for the exact manifest digest. |
| `serviceEvents.ts` | MCP server events: list, subscribe, stream, poll, Claude channel | Each call takes a lease, and a lease refuses a disabled server; subscribe, stream, poll and channel say "disabled" before trying. Handlers for what servers send are in the "MCP server notifications" row above. |
| `headerAuthScopes.ts` | Static Authorization headers; removing stale inferred OAuth scopes | Removes only the exact legacy marker. |
| `transportInspection.ts` | The innermost transport; stdout lines that are not MCP messages | Pure. |

### Adding to a big file

The ceiling in `scripts/execution-hotspots.json` only goes down, so even a
three-line addition to a big file fails `npm run check:hotspots`. Put the new
behaviour in the module that owns it (the tables above) and keep the call in
the big file to one line. When the big file has to grow anyway, move a nearby
block of the same kind out into its module in the same change, so the file
stays at or under its ceiling. Example: a handler for a new kind of MCP server
notification goes into `resourceNotifications.ts` (or a new module), but it is
registered inside `connectServer` next to the others, and newer-protocol
clients also need it in `betaClient.ts`.

### Checks that hold the split

- `npm run check:hotspots` (`scripts/check-hotspot-sizes.mjs`): each big file
  has a line ceiling in `scripts/execution-hotspots.json` that may only go
  down, every module listed there must be named in this guide, and every file
  this guide names must exist.
- `npm run check:boundaries` (`scripts/check-import-boundaries.cjs`) and
  `__tests__/architecture/executionHotspots.test.ts`: nothing a big file
  imports, and no listed split module, may import the big file back. There
  are no exceptions. The last four lazy imports went in the follow-up to #571:
  `subflowRecovery.ts` receives `runFlow` as a parameter to resume a parent
  (from `runStatistics.ts` and the recovery route), workspace deletion lives in
  `src/backend/services/workspace/workspaceDeletion.ts`, which stops the tool
  servers and hands `removeWorkspace` in `src/utils/workspace.ts` the stop
  step, and `tools.ts` and `betaClient.ts` read the live client through
  `liveClient` in `serviceRegistries.ts`, which `mcpService.getClient` also
  uses.
- Rules: `docs/corrections/hotspot-files-only-shrink.md`,
  `docs/corrections/split-modules-never-import-back.md` and
  `docs/corrections/split-modules-are-documented.md`.

### How the split was checked

The same four Jest folders (`__tests__/flow`, `__tests__/model`,
`__tests__/mcp`, `__tests__/chat`, 695 files, 8,835 tests) and
`npm run test:checks` ran on the untouched bundle (`de5a1cdf`) and after the
last move, and their fail lists were compared file by file.

- `npm run test:checks`: 198 of 198 before, 206 of 206 after (the new size and
  back-import check tests).
- Jest before: 38 files with 185 failing tests. After: 44 files with 232, on a
  far busier machine (57 minutes instead of 31). Every test that failed only
  after the split passed when its file ran again on its own, except two files
  that fail the same way on the untouched bundle: `nativeOriginalHost` (real
  child processes; alone, the bundle and the split each lost two different
  tests to timeouts) and `serverTasks` (imports none of the moved code).
  `executionOrdering` then failed exactly the two tests it fails on the bundle.
- The failures on both sides are this Windows machine, not the code: permission
  probes ("not private to this account"), host consent and container tests,
  missing timing headroom, and two bundle failures outside #571
  (`executionOrdering`, `conversationLogLiveTapIndependence`).

Each move was also checked on its own with the TypeScript compiler (including
unused imports in the moved files), ESLint and the tests that exercise it.

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
| MCP close and error callbacks, workspaces, retries | `mcp/mcpRestartLoop.test.ts` |
| Pre-run checks on a new turn versus a resume | `flow/runPreflight.test.ts` |
| Tool result order | `flow/processToolCallsConcurrency.test.ts` |

## The maintenance exercise (#661)

[#661](https://github.com/mario-andreschak/FLUJO/issues/661) asked a second
maintainer, not the author of the split, to find and change one execution
behavior and one MCP behavior using only this page. The owner decided that
nobody does this by hand, so on November 28, 2026 a maintainer who did not
write the split (an AI agent) did it with this page and the code, on throwaway
branches. It ran the two tasks of #661 with the seeds below plus four more
everyday tasks. The [report](./maintenance-exercise-661.md) records each task:
the files opened, what this page got right and wrong, the time, and which
mistakes the tests caught. Everything it found is fixed on this page, in the
tests or in `npm run check:hotspots`.

### Repeat it

Start from a clean checkout of the commit you want to check.

1. Run the focused tests and the import check. All must pass:

   ```sh
   node scripts/run-local-jest.cjs --selectProjects node --runInBand --runTestsByPath __tests__/flow/invocationSource.test.ts __tests__/flow/unattendedDriveForward.test.ts __tests__/flow/runPreflight.test.ts __tests__/mcp/mcpRestartLoop.test.ts
   node scripts/check-import-boundaries.cjs
   ```

2. Make one seed below on a throwaway branch, run the same tests and see at
   least one fail. Then fix it from the bug report alone, without restoring
   the file from git, and run them again.
3. Delete the throwaway branch.

### Bug reports and seeds

Task A, execution. Bug report: "A run started by a program carries on by itself
after the model answers in plain text, as if nobody were watching. Chat runs
behave correctly." Start from the row "Who started a run, and whether anyone
is watching".

| Seed | Caught by |
| --- | --- |
| In `src/shared/types/execution/invocation.ts`, make `isUnattendedFlowInvocation` return `source !== 'chat'` | `__tests__/flow/invocationSource.test.ts` and two `api` cases in `__tests__/flow/unattendedDriveForward.test.ts` |
| In `runStateSetup.ts`, set `sharedState.unattended = input.source !== 'chat'` | the two `api` cases in `__tests__/flow/unattendedDriveForward.test.ts` |
| In `runStateSetup.ts`, work out `unattended` from `sharedState.source` (the conversation's first source) instead of `input.source` | "a schedule conversation continued by a chat run …" and its mirror case in `__tests__/flow/unattendedDriveForward.test.ts` |

Task B, MCP. Bug report: "After FLUJO replaces an MCP server's connection (for
example after a settings change), the old server process exits a little later.
FLUJO then drops the working connection and starts yet another one." Start
from the row "MCP connection ownership".

| Seed | Caught by |
| --- | --- |
| In `transport.onclose` in `src/backend/services/mcp/index.ts`, check `!this.activeTransports.has(config.name)` instead of comparing with `transport` | "ignores a late close event from a replaced (zombie) transport" in `__tests__/mcp/mcpRestartLoop.test.ts` |
| In the same handler, call `this.deregisterClient(config.name)` before that check | the zombie test, "still schedules a reconnect for an unexpected close of the live transport" and the approval test |
| Make the same change in `transport.onerror` | "ignores a late error event from a replaced (zombie) transport" |
| Assign `transport.onclose` without `bindToCurrentWorkspace` | "a close in one workspace reconnects that workspace …" |

What a correct explanation covers: only `chat` and `api` are attended; a
conversation keeps its first source but every run works out `unattended` from
its own source; unattended changes only what happens when a step ends on plain
text. For MCP: a close or error acts only when it comes from the transport
currently registered for that server in that workspace; FLUJO's own closes
remove the transport first and so never reconnect; an unexpected close of the
current transport reconnects if the server is still enabled.

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

`src/shared/types/package/build.ts`, `src/shared/types/package/install.ts`, and `src/shared/types/package/registry.ts` own the
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
