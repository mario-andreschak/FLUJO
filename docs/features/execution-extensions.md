# Optional trusted execution adapter

The default build uses no execution adapter. An integration may select a server-owned module at build time with `FLUJO_EXECUTION_ADAPTER_MODULE`, an absolute path to a module exporting `configuredExecutionAdapter`. Webpack replaces the default module in both the proxy and application bundles. A requested module that is absent fails startup; flow fields and HTTP metadata cannot select an adapter.

The adapter admits requests into the existing workspace route and normal completion service. It may pin a reusable graph, authenticate a conversation owner, bound admission, and mint an opaque runtime context. The context has WeakMap provenance and is nonenumerable on conversation state. JSON snapshots retain only an ownership marker. A later turn must acquire fresh authority before loading, recovering, or resuming protected state.

Process and Static nodes, model adapters, MCP dispatch, conversation writes, and summary writes check that authority. Final MCP arguments are normalized before the trusted metadata callback signs them; private request metadata is kept outside model-visible arguments and durable tool transcripts. Revocation is checked after asynchronous tools and before publication or durable mutation. Ordinary calls retain their previous argument shapes and behavior.

An adapter defines its own identity mapping, graph policy, allowed tools, conversation controls, and sanitized projections. The generic core does not infer identity from customer selectors or implement a domain-specific policy. Integrations must also enforce authority independently at their MCP boundary.

## Optional restricted Codex calls

A private adapter may provide a trusted `RestrictedCodexProfile` containing the exact native CLI version and SHA-256, an absolute tested model catalog path and SHA-256, and optionally an absolute tested executable path. The current restriction implementation admits only verified CLI `0.153.3` with `gpt-6-sol` or `gpt-6-luna`. The chosen model must exist in the pinned compatible catalog; unknown-model fallback and remote catalog refresh cannot supply private model metadata. Enrollment requires inventory, forced native-tool denial, approved MCP success, inherited-configuration denial, and foreign-resource probes on that exact platform and configuration. A read-only filesystem sandbox alone is insufficient evidence.

Private calls use subscription authentication, a fresh isolated home, restrictive environment and config, no shared model catalog, and no session reuse. API credentials, local tool executors, interactive approvals, and unverified profiles are rejected. Other model adapters retain their own existing behavior; Claude subscription calls cannot carry this private context.

Authentication refresh from an isolated child is currently discarded when its home is cleaned up. Sustained or concurrent real-model runs require separate validation of subscription token refresh and capacity. Mock provider load tests establish admission and isolation behavior, not paid-model throughput.
