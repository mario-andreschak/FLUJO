# Optional trusted execution adapter

The default build uses no execution adapter. An integration may select a server-owned module at build time with `FLUJO_EXECUTION_ADAPTER_MODULE`, an absolute path to a module exporting `configuredExecutionAdapter`. Webpack replaces the default module in both the proxy and application bundles. A requested module that is absent fails startup; flow fields and HTTP metadata cannot select an adapter.

The adapter admits requests into the existing workspace route and normal completion service. It may pin a reusable graph, authenticate a conversation owner, bound admission, and mint an opaque runtime context. The context has WeakMap provenance and is nonenumerable on conversation state. JSON snapshots retain only an ownership marker. A later turn must acquire fresh authority before loading, recovering, or resuming protected state.

Process and Static nodes, model adapters, MCP dispatch, conversation writes, and summary writes check that authority. Final MCP arguments are normalized before the trusted metadata callback signs them; private request metadata is kept outside model-visible arguments and durable tool transcripts. Revocation is checked after asynchronous tools and before publication or durable mutation. Ordinary calls retain their previous argument shapes and behavior.

An adapter defines its own identity mapping, graph policy, allowed tools, conversation controls, and sanitized projections. The generic core does not infer identity from customer selectors or implement a domain-specific policy. Integrations must also enforce authority independently at their MCP boundary.

## Optional restricted Codex calls

A private adapter may provide a trusted `RestrictedCodexProfile` containing the exact native CLI version and SHA-256, an absolute tested model catalog path and SHA-256, and optionally an absolute tested executable path. The current restriction implementation admits only verified CLI `0.153.3` or `0.157.1` with `gpt-6-sol` or `gpt-6-luna`. Adjacent releases are not admitted automatically. The chosen model must exist in the pinned compatible catalog; unknown-model fallback and remote catalog refresh cannot supply private model metadata. Enrollment requires inventory, forced native-tool denial, approved MCP success, inherited-configuration denial, and foreign-resource probes on that exact platform and configuration. A read-only filesystem sandbox alone is insufficient evidence.

CLI `0.157.1` was exercised on Linux x64 and Windows x64 with the same restricted catalog: 42 authenticated HTTPS fallback cases, 42 preferred WebSocket cases, and 14 cases through the production Streamable HTTP MCP bridge on each platform, covering both approved models. The fixtures used synthetic authentication and local model responses, the SDK's security settings and isolated runtime layout, and no extra `--ignore-user-config` guard or MCP tool filter on the HTTP bridge. These checks establish native capability restrictions and bridge dispatch, not real provider completion or customer throughput. Each deployment must still attest its own exact executable and catalog bytes and validate its subscription's model availability.

Private calls use subscription authentication, a fresh isolated home, restrictive environment and config, no shared model catalog, and no session reuse. API credentials, local tool executors, interactive approvals, and unverified profiles are rejected. Other model adapters retain their own existing behavior; Claude subscription calls cannot carry this private context.

Concurrent calls may share an in-flight executable digest and version check only when their expected path, digest, version, and current file identity match. Each caller still checks the executable before and after verification and validates its own catalog and model policy before credential transfer. Completed or rejected verification is discarded; subsequent calls rehash the executable. This reduces repeated reads during an admission burst without retaining a verification cache for mutable files.

Failed native MCP events emit the error-level diagnostic `Codex native MCP tool call failed` with fixed code `codex_native_mcp_tool_failed`, a fixed category (`timeout`, `authentication`, `authorization`, `rate_limit`, `network`, `validation`, or `unknown`), available run/node identifiers, and an exact offered bridge tool label or `unknown`. Native error text, URLs, item identifiers, arguments and results are excluded. Categories recognize error-message patterns and do not establish the underlying cause. These diagnostics add no tool transcript, invocation count or retry. Startup warnings that the SDK exposes only through successful-process stderr remain outside this event diagnostic.

Authentication refresh from an isolated child is currently discarded when its home is cleaned up. Sustained or concurrent real-model runs require separate validation of subscription token refresh and capacity. Mock provider load tests establish admission and isolation behavior, not paid-model throughput.

## Private Original lifecycle reader

`nativeOriginalSourceReader` returns a reader only for a branded, in-process
`NativeOriginalProcessHost`. The reader rereads the saved origin and private
payload through the captured Source authority. Publication also checks the
exact session, current root lineage and admission stage. It cannot authenticate
a Controller Worker or mint a new root from request metadata.

Live acknowledgement retains one opaque handle bound to the accepted Original,
its registered actual child, the facade owner and the host generation. A fresh
positive OS birth observation is required; copied handles, changed owners and
other generations are refused. Process-global weak registries preserve this
provenance across Next server graphs without recovering it after a restart.

Process teardown removes live proof. Terminal reconciliation separately requires
actual exit and pipe close, the matching private host reservation, and the saved
completed invocation with its hold absent and effects resolved. SDK completion
or a process phase alone cannot release an unknown Original.

This is an internal Source capability, not a Worker transport or fleet eligibility
switch. The current host mint remains bound to genuine Persona dispatch. A fleet
integration still needs independently authenticated Worker ownership, a scoped
tool gateway and qualification of its actual deployed image and provider route.

## Worker root Originals

A trusted server adapter can opt into `nativeWorkerRoot`. It must authenticate
the executing Worker and reread its enrolled target, current goal/root run,
budget and OFF gates. Its existing `commit` operation must fence those records
throughout a Source mutation. Request DTOs, Flow properties and caller callbacks
cannot select this reader; it is resolved only through the current opaque
execution context and registered server adapter.

The returned admission binds Worker/goal/fleet IDs, the root conversation and
logical run, workspace, target digest, immutable graph/model digests and lease
epoch. Source checks its own live conversation, root depth, exact context,
process node/model and graph before minting the host. Each current-authority
check rereads the same admission and model/graph. Revocation or a different
target, epoch or model cannot authorize the accepted Original. A native adapter
that opts in but supplies no current root cannot fall back to an ordinary private
Codex call. Adapters without this optional method retain their existing path.

`callModel` acquires this host automatically for an admitted Codex Worker root.
The native broker and Codex adapter accept a private execution context only
when it is the exact context captured by that branded host. Persona hosts cannot
borrow a Worker context. Worker reservations use a distinct V2 `worker-host-ledger`
beneath the private origin directory; existing Persona V1 paths and locks remain
unchanged. Qualification, saved dispatch, actual born process registration,
exit/close and terminal reconciliation use the same Original lifecycle.

This contract does not implement the adapter's Controller authentication or
Worker transport. Root admission cannot relabel a child conversation; child
Original lineage and the deployed gateway/image still require integration.
