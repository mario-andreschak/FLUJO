# MCP Apps compliance matrix — 2026-01-26

Audit target: [SEP-1865, stable revision `2026-01-26`](https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/2026-01-26/apps.mdx).

Audited FLUJO revision: `a3612f93dcb83ac3d909698bdeae34c26ee31ef8` on `main`. The protocol host implementation originated in `eb190553a0c4895ecdd0817d15305903a1cf8174`. Commit `fdd591816c3a3a61f892c8597077224dffc6f89e` later added the MCP Apps management dashboard, and `a3612f93dcb83ac3d909698bdeae34c26ee31ef8` changed unattended-mode flow tooling; neither changed the mapped host protocol paths or compliance tests.

Outcomes use these meanings:

- **Compliant** — the applicable stable host requirement is implemented and has automated evidence.
- **Supported (optional)** — behavior is optional in the stable specification and FLUJO implements it.
- **Intentional restriction** — FLUJO safely declines or narrows optional/host-dependent behavior and exposes a deterministic fallback.
- **Not applicable** — the item is deferred by, or absent from, the stable revision and is not advertised as stable MCP Apps support.

| Area and stable requirement | FLUJO behavior and implementation evidence | Automated evidence | Outcome / limitation |
| --- | --- | --- | --- |
| Extension negotiation: advertise `io.modelcontextprotocol/ui` with required MIME types only when Apps is enabled | `src/backend/services/mcp/appsProtocol.ts`; capability construction and reconnect flow in `src/backend/services/mcp/` | `__tests__/mcp/mcpAppsNegotiation.test.ts`, `__tests__/mcp/capabilitiesService.test.ts` | **Compliant.** Per-server opt-in is required; disabled servers retain standard MCP behavior. |
| View protocol revision is `2026-01-26` | `MCP_APPS_PROTOCOL_VERSION` in `appsProtocol.ts`; AppBridge initialization in `src/frontend/components/Chat/McpAppFrame.tsx` | `__tests__/frontend/components/McpAppFrameCompliance.test.ts` | **Compliant.** No draft-only capability is advertised as part of the stable baseline. |
| UI resource URI uses `ui://`; MIME type is exactly `text/html;profile=mcp-app` | Validation and extraction in `src/shared/utils/mcpApps.ts`; resolution in `src/backend/mcpApps/toolUi.ts` | `__tests__/mcp/mcpApps.test.ts`, `__tests__/mcp/filesystemApp.test.ts` | **Compliant.** Other content types fail closed. |
| Resource content is supplied as text or base64 blob and is bounded before rendering | Decode, HTML extraction, and byte limits in `mcpApps.ts` and `McpAppFrame.tsx` | `__tests__/mcp/mcpApps.test.ts`, `McpAppFrameCompliance.test.ts` | **Compliant.** Invalid/oversized content is rejected and Chat keeps the ordinary tool result. |
| Tool links to a predeclared resource through nested metadata; legacy flat key remains compatible | Metadata readers in `mcpApps.ts` and `appsProtocol.ts` | `__tests__/mcp/mcpApps.test.ts` | **Compliant.** Nested `_meta.ui.resourceUri` is authoritative; the deprecated flat key is compatibility-only. |
| Host reads the exact declared resource through `resources/read` | `resolveAdvertisedToolUi` in `src/backend/mcpApps/toolUi.ts`; resource proxy route under `src/app/api/mcp/servers/` | `__tests__/mcp/mcpApps.test.ts`, `__tests__/mcp/proxyForward.test.ts` | **Compliant.** Result-only links and redirects away from the definition's URI are ignored. |
| If Apps is unavailable, the tool remains a normal text/structured-content tool | Opt-in checks in `toolUi.ts`; Chat mounts a frame only for a valid resolved UI | `__tests__/mcp/mcpAppsNegotiation.test.ts`, `__tests__/mcp/mcpApps.test.ts` | **Compliant.** The server remains responsible for meaningful standard MCP content. |
| Visibility defaults to `model` and `app` when omitted | Audience normalization in `appsProtocol.ts` | `__tests__/mcp/toolVisibility.test.ts` | **Compliant.** Malformed declarations fail closed instead of broadening access. |
| App-only tools never enter the model's list | Model-facing filtering in `src/backend/services/mcp/tools.ts` and `appsProtocol.ts` | `__tests__/mcp/toolVisibility.test.ts`, `__tests__/mcp/toolNamespace.test.ts` | **Compliant.** |
| Apps may call only app-visible tools from the same server connection | App-call authorization in `appsProtocol.ts` and `src/backend/services/mcp/index.ts`; tool API route | `__tests__/mcp/mcpAppToolRoute.test.ts`, `__tests__/mcp/toolVisibility.test.ts` | **Compliant.** Cross-server and model-only calls are rejected. |
| Web host uses a different-origin Sandbox proxy | Sandbox listener/proxy in `src/backend/mcpApps/sandboxServer.ts`; bootstrap route `src/app/api/mcp/app-sandbox/route.ts`; frame host in `McpAppFrame.tsx` | `__tests__/mcp/sandboxRelay.test.ts`, `__tests__/mcp/sandboxCsp.test.ts`, `McpAppFrameCompliance.test.ts` | **Compliant security boundary.** Deployment must provide a distinct origin; startup fails closed for invalid production configuration. |
| Sandbox/View iframe is restricted and communication stays under host control | Proxy relay filtering in `sandboxServer.ts`; iframe policy in `McpAppFrame.tsx` | `sandboxRelay.test.ts`, `McpAppFrameCompliance.test.ts` | **Intentional restriction.** FLUJO grants scripts but omits `allow-same-origin`, forms, popups, and top navigation. This is stricter than the stable proxy example and does not broaden App authority. |
| Sandbox readiness/resource readiness and reserved messages are not exposed to the View | Relay lifecycle and reserved-prefix filtering in `sandboxServer.ts` and `McpAppFrame.tsx` | `__tests__/mcp/sandboxRelay.test.ts`, `McpAppFrameCompliance.test.ts` | **Compliant.** Host messages are held until initialization completes. |
| CSP is derived from declared domains with restrictive defaults and no undeclared-domain widening | CSP normalization in `src/shared/utils/mcpApps.ts`; response CSP and `frame-ancestors` in `sandboxServer.ts` | `__tests__/mcp/sandboxCsp.test.ts`, `__tests__/mcp/mcpApps.test.ts`, `McpAppFrameCompliance.test.ts` | **Compliant.** Invalid schemes/origins are discarded; objects and undeclared frames/connections remain blocked. |
| Requested permissions are host-controlled and effective grants are reported | Permission normalization and iframe `allow` construction in `mcpApps.ts`/`McpAppFrame.tsx`; host capabilities from the bridge | `McpAppFrameCompliance.test.ts`, `sandboxCsp.test.ts` | **Compliant.** Camera, microphone, geolocation, and clipboard-write are deny-by-default and require declaration plus host approval. |
| Resource `domain` and `prefersBorder` metadata are host-dependent preferences | Metadata normalization in `mcpApps.ts`; border rendering in Chat | `mcpApps.test.ts`, `McpAppFrameCompliance.test.ts` | **Intentional restriction.** Border preference is honored when safe. Arbitrary resource-selected domains are not; operators configure one deployment sandbox origin. |
| JSON-RPC messages are validated and relayed between the matching frame and host | AppBridge transport in `McpAppFrame.tsx`; proxy validation in `sandboxServer.ts` | `sandboxRelay.test.ts`, `McpAppFrameCompliance.test.ts` | **Compliant.** Malformed, reserved, foreign-origin/source, stale, and late messages are rejected or ignored. |
| `ui/initialize` / `ui/notifications/initialized` handshake and `ping` | AppBridge lifecycle in `McpAppFrame.tsx` | `McpAppFrameCompliance.test.ts`, `sandboxRelay.test.ts` | **Compliant.** Tool data is not sent before initialization. |
| Standard App messages: `tools/call`, `resources/read`, `notifications/message` | Host bridge handlers in `McpAppFrame.tsx`; authenticated MCP routes and service authorization | `mcpAppToolRoute.test.ts`, `toolVisibility.test.ts`, `proxyForward.test.ts`, `McpAppFrameCompliance.test.ts` | **Compliant.** Server operations remain subject to connection and audience authorization. |
| App requests: `ui/open-link`, `ui/message`, `ui/update-model-context` | Safe-link and message handlers in `McpAppFrame.tsx`; bounded context in `src/backend/mcpApps/modelContext.ts` and Chat completion flow | `McpAppFrameCompliance.test.ts`, `__tests__/mcp/mcpAppModelContext.test.ts` | **Compliant.** Unsafe URL schemes and invalid/oversized context are rejected; the latest valid context is used on later turns. |
| Complete tool input is delivered before tool result; cancellation has an explicit reason | Delivery state machine in `McpAppFrame.tsx`; cancellation mapping in `toolUi.ts` | `McpAppFrameCompliance.test.ts`, `__tests__/mcp/callToolTimeout.test.ts`, `__tests__/mcp/staleToolCall.test.ts` | **Compliant.** Partial-input streaming is optional and is not guaranteed. |
| Host and App negotiate `inline`, `fullscreen`, and `pip`; unavailable requests return the current mode | Display-mode guards and canvas handoff in `McpAppFrame.tsx`, `ChatMessages.tsx`, and `DevCanvasDock.tsx` | `McpAppFrameCompliance.test.ts` | **Compliant.** A mode requires declaration by both sides. One visible App owns the canvas; unsupported transitions preserve the current mode. |
| Host reports context changes and reacts to View size changes | Host-context and size handlers in `McpAppFrame.tsx` | `McpAppFrameCompliance.test.ts` | **Supported (optional).** Flexible dimensions are bounded by the Chat/canvas layout. |
| Host sends teardown and removes frame resources/listeners | Teardown request, timeout, abort, and React cleanup in `McpAppFrame.tsx` | `McpAppFrameCompliance.test.ts`, `staleToolCall.test.ts` | **Compliant.** Replacement/unmount suppresses late messages and clears pending work. |
| Host exposes only implemented capabilities and degrades unsupported stable/future behavior safely | Capability construction and request guards in `McpAppFrame.tsx`; opt-in/resource checks in backend services | `mcpAppsNegotiation.test.ts`, `McpAppFrameCompliance.test.ts` | **Compliant.** External URL resources, multiple Views, View-to-View communication, and draft features are not advertised. |
| Downloads | Host-controlled bounded download handler in `McpAppFrame.tsx` | `McpAppFrameCompliance.test.ts` | **Not applicable to the stable revision.** Download is a FLUJO extension, not a `2026-01-26` stable MCP Apps message; content and filenames are sanitized before a host-created action. |

## Verification scope

The focused compliance suite is:

```text
__tests__/mcp/mcpApps.test.ts
__tests__/mcp/mcpAppsNegotiation.test.ts
__tests__/mcp/toolVisibility.test.ts
__tests__/mcp/mcpAppToolRoute.test.ts
__tests__/mcp/mcpAppModelContext.test.ts
__tests__/mcp/sandboxCsp.test.ts
__tests__/mcp/sandboxRelay.test.ts
__tests__/frontend/components/McpAppFrameCompliance.test.ts
```

Broader regression evidence includes the remaining `__tests__/mcp/` suite, strict TypeScript checking, and the production build. Test outcomes belong to the commit/issue record rather than this versioned protocol matrix so the document does not become stale when the test runner or environment changes.
