# Flujo Architecture

FLUJO is a single-user Next.js App Router application. The React frontend calls workspace-aware HTTP handlers; backend services manage models, MCP connections, flow execution, schedules, and persistence. Local MCP servers run in child processes. Persistent state lives under the selected workspace's data directory.

## System Architecture

The request proxy enforces Host/Origin exposure rules for internal API surfaces. Protocol-public endpoints have explicit exceptions; these are not user authentication. An explicitly configured owner policy adds scoped API bearers, with independent checks at the proxy and workspace route boundary. Anonymous localhost behavior remains the default when no policy is selected. Worker deployments use a separate bearer boundary. Handlers validate inputs and enter workspace context before accessing state. See the [owner access source contract](../security/owner-access-v1.md) for protocol exceptions, missing browser/session lifecycle and remaining coverage/release gates.

## Backend Architecture

Backend modules live under `src/backend`. Flow execution runs through nodes and emits conversation events; model adapters translate provider requests, and MCP services own connection lifecycle and tool calls. File-backed storage uses atomic writes. AsyncLocalStorage carries the selected workspace so concurrent requests resolve their own paths and caches. See [workspaces](../features/workspaces.md), [MCP lifecycle](../features/mcp-lifecycle-hardening.md), and [API reference](../api-reference/README.md).

## Frontend Architecture

Routes live under `src/app`; reusable components, hooks, services, contexts, and localization live under `src/frontend`. Client services manage HTTP/streaming requests; components should surface loading, failed, and successful states distinctly. Shared contracts live under `src/shared`.

## Integration Architecture

Cloud model adapters send selected context to configured providers. MCP integrations may execute local code or call remote services. Tool approvals mediate requested actions, while process/network permissions remain the host operator's responsibility. See [Connected Apps](../features/mcp/overview.md) and [project status](../project-status.md) for supported and experimental scope.

The [MCP isolation source primitive](../security/mcp-isolation-v1-evidence.md)
is not yet wired into the application's transport. Its controlled Docker probe
does not establish isolation of currently connected MCP servers, installation
scripts or an installed FLUJO artifact. Shared ownership/sharing and authenticated
browser operation remain separate acceptance work.

## Decision Records

- [Execution and MCP ownership contracts](./execution-module-boundaries.md):
  Existing lifecycle/authority/persistence/dispatch owners, import direction,
  exact legacy dependencies, and behavior-preserving extraction gates (#571).
- [Persona run context contract](./persona-run-contract.md):
  Attributed instruction/snapshot decisions, caller ownership and ordered
  source-regression traces for incremental execution simplification (#571).
- [Single-gate tool approval proposal](./tool-approval-single-gate-proposal.md):
  Proposed conversation-scoped approval contract, workflow evidence, state and API
  requirements, verification matrix, and required stakeholder sign-off for issue #469.
- [Memory ranking and near-duplicate defaults](./memory-ranking-dedup-decision.md):
  The accepted reinforce-in-place strategy, 90-day recency half-life, 0.82
  trigram-Jaccard threshold, rollback switch, and privacy-gated tuning rules
  for issue #467.
- [Enduring-agent foundation contracts](./enduring-agent-foundation-contracts.md):
  Phase 0 domain ownership, immutable revision, Persona lease/fencing, memory
  trust, Flow tool-authority, compatibility, workspace, privacy, and threat-model
  contracts for issue #415.
- [Persona runtime retention policy](./persona-runtime-retention.md):
  Final mailbox, activity, dispatch, and lease-history windows and rank caps,
  compaction/deletion boundaries, and default-off rollout contract for issue #479.
- [FlowSpec node-type inclusion policy](./flowspec-node-inclusion-policy.md): which
  ReactFlow node types belong in the FlowSpec authoring contract, why, and the
  checklist for classifying future node types (issue #380).
- [Static node re-entry semantics](./static-node-reentry-semantics.md): the
  append-by-default and per-run `injectOnce` contract (issue #381).
