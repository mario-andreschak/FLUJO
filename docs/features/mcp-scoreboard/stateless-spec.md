# Scoreboard row: Stateless spec

Row on [Is MCP good yet?](https://ismcpgoodyet.com/): "Protocol revision
2026-07-28. No initialize handshake, no session id. Each request carries version
and capabilities." Clients rated **Yes** negotiate 2026-07-28 **by default** and
fall back to the classic handshake for older servers. A client that negotiates
only over HTTP, or only after an opt-in, is rated **Partial**.

FLUJO status (November 27, 2026, branch `wip-cleanup`, epic
[#1448](https://github.com/mario-andreschak/FLUJO/issues/1448)): **Yes**, on
every standard transport, as a client and as a server. Not in a release yet.

Spec sources: [2026-07-28 release post](https://blog.modelcontextprotocol.io/posts/2026-07-28/),
[versioning and compatibility](https://modelcontextprotocol.io/specification/2026-07-28/basic/lifecycle),
[stdio](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/stdio),
[Streamable HTTP](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http),
[server/discover](https://modelcontextprotocol.io/specification/2026-07-28/server/discover).
SDKs: `@modelcontextprotocol/client`, `server`, `core` 2.4.0.

## FLUJO as a client

| Criterion | Status | Source | Test |
| --- | --- | --- | --- |
| Negotiates 2026-07-28 always, no switch | Yes | `createNewBetaClient` in [betaClient.ts](../../../src/backend/services/mcp/betaClient.ts) | `proxyModernServing.test.ts` |
| A server that only speaks the classic handshake still works | Yes: FLUJO falls back by itself for that server; there is no switch to force it | same file | `proxyModernServing.test.ts` "lets a modern client fall back to the classic server" |
| Streamable HTTP: asks `server/discover`, no session id, version and capabilities in every request's `_meta`, `MCP-Protocol-Version` / `Mcp-Method` / `Mcp-Name` headers | Yes (official SDK `auto` mode) | `createNewBetaClient` in [betaClient.ts](../../../src/backend/services/mcp/betaClient.ts) | `proxyModernServing.test.ts`, `modernTasksDispatch.test.ts`, `conformanceAdapters.test.ts` |
| HTTP: older server answers the probe with an error, client falls back to `initialize` | Yes | SDK `auto` mode | `proxyModernServing.test.ts` "lets a modern client fall back to the classic server" |
| stdio: `server/discover` first, on the server's own process | Yes | [stdioNegotiation.ts](../../../src/backend/services/mcp/stdioNegotiation.ts) | `stdioProtocolNegotiation.test.ts` "speaks 2026-07-28 with a modern server on a single process" |
| stdio: any other reply, or silence for 20 s, means classic; fallback not tied to one error code | Yes (SDK classification) | same | `stdioProtocolNegotiation.test.ts` "falls back to initialize on the same process" |
| stdio: no hidden extra probe process (the SDK's own stdio class probes on a second process that would skip FLUJO's isolation, host checks and process tracking) | Yes | `InPlaceProbeStdioClientTransport` | process counts in `stdioProtocolNegotiation.test.ts`; `isolatedMcpTransport.test.ts`, `trustedHostMcpTransport.test.ts` |
| stdio: an old server that quits when asked is started again at once with the classic handshake, and remembered | Yes; the memory heals: a classic start that fails forgets the server | `noteStdioConnectFailure`, `takeClassicHandshakeRetry`; [index.ts](../../../src/backend/services/mcp/index.ts) `connectServer` | `stdioProtocolNegotiation.test.ts` "restarts a server that quits on server/discover" |
| Test Run uses the same negotiation and shows one result | Yes | `testConnection` in [index.ts](../../../src/backend/services/mcp/index.ts) | `stdioProtocolNegotiation.test.ts` "Test Run gets the same classic restart" |
| Isolated (container) and trusted-host stdio servers | Yes, probed inside their own process | [betaClient.ts](../../../src/backend/services/mcp/betaClient.ts) | `isolatedMcpTransport.test.ts`, `trustedHostMcpTransport.test.ts` |
| SSE (deprecated by 2026-07-28) | Yes, same SDK `auto` mode as HTTP | `createBetaTransport` | covered by the SDK; no separate FLUJO test |
| WebSocket | Not applicable: not an MCP standard transport; keeps the classic handshake | `connectServerInternal` | n/a |

FLUJO's private execution servers (its own internal tool servers) keep the
classic SDK on purpose; they are not user-configured servers.

## FLUJO as a server

| Criterion | Status | Source | Test |
| --- | --- | --- | --- |
| `/mcp-flows` serves 2026-07-28 and older clients on one URL, by default | Yes | [mcp-flows/route.ts](../../../src/app/mcp-flows/route.ts), [flowsTasksServer.ts](../../../src/backend/services/mcp/flowsTasksServer.ts), [mcpEraRouting.ts](../../../src/backend/services/mcp/mcpEraRouting.ts) | `flowsTasksRouteClassification.test.ts`, `flowsTasksServer.test.ts` |
| Modern clients get ordinary tools without owner sign-in on a localhost install (same admission as older clients); Tasks need the owner bearer | Yes | `resolveModernOwner` in flowsTasksServer.ts | `flowsTasksServer.test.ts` "serves ordinary modern tools without owner sign-in" |
| Unknown method: HTTP 404 with `-32601` | Yes (was HTTP 200 before) | flowsTasksServer.ts | `flowsTasksServer.test.ts` "answers an unknown method with HTTP 404" |
| `/mcp-proxy/<server>` serves both generations: tools, resources, Skills, Apps, progress, error codes | Yes | [mcp-proxy route](../../../src/app/mcp-proxy/[server]/route.ts), [proxyModernServer.ts](../../../src/backend/services/mcp/proxyModernServer.ts) | `proxyModernServing.test.ts` (official 2026-07-28 and 2025 SDK clients) |
| FLUJO serves MCP over stdio | Not applicable: FLUJO's own MCP endpoints are HTTP only | — | — |

### Official conformance tool

`@modelcontextprotocol/conformance` 0.2.0-alpha.12 (MIT; the only line with
2026-07-28 scenarios), server mode, run on November 27 against the real route
handlers served on a local port, with fixture flows and downstream tools:

| Scenario | `/mcp-flows` | `/mcp-proxy/<server>` |
| --- | --- | --- |
| `server-stateless` | 26/28 | 26/28 |
| `http-header-validation` | 14/14 | 14/14 |
| `dns-rebinding-protection` | 2/2 | 2/2 |
| `caching` | not run | 3/4, the miss is `prompts/list`, which the proxy does not offer |

The two `server-stateless` misses need the suite's own diagnostic tool
`test_missing_capability`; FLUJO has no such tool, and the suite marks one of the
two "not testable". Before the 404 fix, `/mcp-flows` also failed
`sep-2575-http-server-method-not-found-404`.

Re-run against any running FLUJO:

```
npm run conformance:mcp -- --url http://localhost:4200/mcp-flows
npm run conformance:mcp -- --url http://localhost:4200/mcp-proxy/<exposed server>
```

## Still open

- Installed-app and release checks (Windows, Linux) are release pre-flight.
- Conformance **client** mode needs a FLUJO command-line client that the tool
  can start with a server URL; none exists, so the client side is covered by
  the Jest tests above, which use the official SDK clients and servers.
- Browser check of the Settings switch wording is part of the end-of-day run.
