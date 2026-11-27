# Scoreboard row: MCP Apps

Part of [#1448](https://github.com/mario-andreschak/FLUJO/issues/1448).
Checked on 2026-11-27 against [Is MCP good yet?](https://ismcpgoodyet.com/) and
the [stable MCP Apps spec 2026-01-26](https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/2026-01-26/apps.mdx).

**Assessment: Yes.** A tool result renders its interactive `ui://` view in chat
for every server unless the user turns Apps off for that server.

## What the scoreboard asks

The row reads "A tool result can render interactive UI in the client". Cursor is
rated Yes because Apps render in agent chat. Codex and Grok are Partial because
Apps are off by default or have no renderer ("Partial means opt-in, a subset, or
experimental"). FLUJO was Partial for the same reason: each server needed an
explicit opt-in.

## What changed

- MCP Apps are on unless turned off ("Render interactive apps" on the server
  card). One function decides: `mcpAppsEnabled` in
  `src/shared/utils/mcpClientFeatures.ts`. Servers run under an isolation or
  host-trust policy keep the switch exactly as the person approved it.
- The private sidecar runtime broker (a FLUJO deployment extension, not part of
  MCP Apps) still needs MCP Apps turned on by hand: `mcpAppRuntimeBrokerEnabled`.
- Lint rule `flujo/mcp-feature-defaults` stops code from reading the switch as
  opt-in again.

## Criteria and evidence

The requirement-by-requirement host matrix is
[apps-compliance-2026-01-26.md](../mcp/apps-compliance-2026-01-26.md). Summary:

| Criterion | FLUJO | Proof |
| --- | --- | --- |
| Advertise `io.modelcontextprotocol/ui` with `text/html;profile=mcp-app` | On every v1 and v2 client unless turned off | `connection.ts`, `betaClient.ts`; `__tests__/mcp/mcpAppsNegotiation.test.ts` |
| Not opt-in | On by default | `mcpAppsEnabled`; `mcpAppsNegotiation.test.ts` |
| Render the tool's declared `ui://` resource read with `resources/read` | Chat timeline, full screen and picture-in-picture | `src/backend/mcpApps/toolUi.ts`, `McpAppFrame.tsx`; `__tests__/mcp/mcpApps.test.ts` |
| Visibility (`model`/`app`), same-server app tool calls only | Yes | `__tests__/mcp/toolVisibility.test.ts`, `mcpAppToolRoute.test.ts` |
| Sandbox: separate origin, double iframe, CSP from `_meta.ui.csp`, permissions | Yes, per-App origin | `sandboxServer.ts`; `sandboxCsp.test.ts`, `sandboxRelay.test.ts` |
| Lifecycle: `ui/initialize`, tool input/result/cancelled, teardown, host context, size changes, display modes, `ui/open-link`, `ui/message`, `ui/update-model-context` | Yes | `McpAppFrameCompliance.test.ts`, `mcpAppModelContext.test.ts` |
| Host context: theme, styles, display modes, container size, locale, time zone, platform, user agent, device capabilities, tool info | Yes | `McpAppFrame.tsx` (`hostContext`) |
| Text fallback when Apps are off | Ordinary tool result | `mcpAppsNegotiation.test.ts` |

## Remaining scope

These are optional in the stable spec, or not part of it, and stay as documented
in [apps.md](../mcp/apps.md#compatibility-and-limits):

- partial tool input (`ui/notifications/tool-input-partial`, a MAY) is not sent;
  the complete input always arrives before the result;
- `_meta.ui.domain` is a hint FLUJO does not follow; each App gets a FLUJO-owned
  origin (stricter than the spec asks);
- `safeAreaInsets` is not sent (no notch or toolbar overlaps the chat).
- Browser proof for the end-of-day run: add a server that has an App (for
  example an MCP Apps example server from `modelcontextprotocol/ext-apps`)
  without touching its switch, run its tool in chat, and check the view renders.
