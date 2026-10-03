# Execution and MCP ownership contracts

Issue [#571](https://github.com/mario-andreschak/FLUJO/issues/571), part of
[#563](https://github.com/mario-andreschak/FLUJO/issues/563). Source baseline:
`3511ba49514fe8cf525f5a22c16c3806bf3886ba` (October 3, 2026).
This is a map of existing responsibilities and a contract for incremental
changes. It does not establish installed-release acceptance or award a grade.

## Where to change a behavior

Paths below are relative to the repository root. A module owns the indicated
responsibility; its callers must use that boundary rather than duplicate its
state or enforcement. The topic owner is the integration owner for epic #563,
not a claim that an additional human maintainer has accepted responsibility.

| Responsibility | Existing entry point and state owner | Contract to preserve | Integration owner |
| --- | --- | --- | --- |
| Run lifecycle | `src/backend/execution/flow/runFlow.ts`; `FlowExecutor.ts` holds live `conversationStates` | `runFlow` acquires the workspace/conversation execution lock, validates loaded/input state, registers cancellation, and drives graph steps. Preserve explicit invocation source, terminal/paused distinction, and run-owned cleanup. | Maturity for behavior; Code health for sequenced extraction |
| Conversation serialization | `conversationExecutionLock.ts` | One process-global, workspace-keyed queue; async-local reentry must not deadlock. A failed predecessor does not poison later runs. | Maturity |
| Execution authority | `executionAuthority.ts`; `src/backend/execution/extensions/` | Assert the current fence before effects; durable mutations use `commitFlowDurableMutation` and the authority's atomic commit capability. Authority failures escape best-effort catches. Loading a snapshot never reconstructs a runtime capability. | Security/Production consume original authority; Code health preserves interfaces |
| Cancellation | `cancellationCoordinator.ts`, `cancellation.ts`, `toolCancelRegistry.ts` | Admission-barrier check and run registration are atomic in one event-loop step. Cancellation aborts active work and respects ancestry/tombstones; release each registration. | Maturity; Production owns worker recovery |
| Approval and debugger pause | `toolApprovalRegistry.ts`, `resumeAfterApproval.ts`, `runFlow.ts` | A pause keeps the live state owned. Resume applies the decision to the pending call before continuing; do not dispatch an unapproved tool while extracting code. | Maturity; Security owns permission changes |
| Subflows | `nodes/SubflowNode.ts`, `subflowCommunication.ts`, `subflowRecovery.ts`, `handlers/subflowToolInvocation.ts` | Parent/child and lane identities include logical-run lineage. Queued messages are consumed at safe boundaries. Ephemeral children do not become durable sidebar conversations. Unknown external tool effects are not automatically replayed. | Maturity; Production owns restart policy |
| Conversation persistence | `persistConversationState.ts`, `conversationLog.ts`, `loadConversationState.ts`, `recoveryCheckpoint.ts` | Canonical log, snapshot and checkpoint are distinct. Reject unsafe IDs, deleted and ephemeral snapshots; strip trace/runtime capabilities; retain authority checks. Recovery reconciliation cannot grant permission to repeat uncertain effects. | Maturity; Security owns privacy/crypto |
| Conversation cache | `conversationStateCache.ts` around `FlowExecutor.conversationStates` | Keep one live-state registry. Only persistently terminal, unowned entries may be evicted; persistence failure must retain the state. | Maturity (#569) |
| Provider dispatch | `handlers/ModelHandler.ts`; `src/backend/services/model/adapters/` | The handler assembles input and selects the adapter; the adapter owns the actual SDK boundary. An intended turn is not an observed SDK dispatch. Preserve approval/authority/abort checks and each actual attempt marker. | Maturity; external streams own SDK/history consumers |
| Dispatch archive | `modelTurnArchive.ts` invoked by SDK callbacks in `ModelHandler.ts` | When archiving is enabled, persist the SDK request before emitting `model:dispatch`; update its outcome before `model:dispatch-result`. Preserve exact dispatch ID/ordinal and canonical versus wire context. Ordinary archive I/O failures may warn and continue; authority failures must propagate. | Maturity (#569) |
| Execution events | `engine/ExecutionEventBus.ts` and `src/shared/types/execution/events.ts` | Event sequence allocation/log append and UI delivery are separate responsibilities. UI retention changes cannot remove canonical history or synthesize provider dispatches. | Maturity; history/Brain consumers own their adapters |
| Debugger consumer state | `src/shared/types/execution/debuggerState.ts` and backend `SharedState` | The backend extends the shared UI view for type compatibility. Opaque snapshots still render; this type contract does not project/redact payloads or expose runtime capabilities as named fields. | Code health owns contract; Maturity owns producer/event behavior; Features owns UI consumers |
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

Run `node scripts/check-import-boundaries.cjs` to check every TS/TSX/JS/JSX file
under those three layers. The checker resolves imports with the repository's
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
small PRs. Removing the backend layout dependency requires moving the complete
pure geometry dependency cluster, not hiding it behind another frontend import.

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

On a disposable checkout, independently locate the unattended classification
and explain why API runs are interactive. Change a fixture, run its regression,
and show the failing then passing behavior. Separately locate `beginConnect` /
`beginTeardown`, explain workspace and generation ownership, and modify a
reconnection fixture so that a stale close cannot remove the new client. Record
the human reviewer, revision, commands, observation and review. An AI-generated
guide or passing CI does not satisfy #571's second-human acceptance; Community
owns arranging/recording that exercise through #576.

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
