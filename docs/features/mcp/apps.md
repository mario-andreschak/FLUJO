# MCP Apps host support

FLUJO implements the stable MCP Apps extension revision `2026-01-26` for interactive tool results in Chat. The implementation was audited against the [stable MCP Apps specification](https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/2026-01-26/apps.mdx). The requirement-by-requirement evidence is recorded in the [versioned compliance matrix](./apps-compliance-2026-01-26.md).

## Enabling Apps

MCP Apps support is opt-in for each MCP server. When enabled, FLUJO advertises the `io.modelcontextprotocol/ui` extension and the `text/html;profile=mcp-app` MIME type during initialization. Servers that do not negotiate Apps continue to behave as ordinary MCP servers, and UI-enabled tools must still return useful standard MCP content for text-only fallback.

FLUJO renders only a `ui://` resource predeclared by the tool definition. It reads that exact resource through `resources/read`; a result cannot redirect rendering to another resource. Both nested `_meta.ui.resourceUri` metadata and the deprecated flat `_meta["ui/resourceUri"]` form are accepted for compatibility.

Tool visibility follows `_meta.ui.visibility`:

- omitted visibility defaults to both `model` and `app`;
- app-only tools are excluded from the model's tool list;
- an App can call only tools that include `app` visibility on the same MCP server connection;
- cross-server App tool calls are rejected.

Malformed visibility metadata fails closed.

## Security boundary

App HTML is untrusted. FLUJO serves it through a separate sandbox origin, applies a restrictive Content Security Policy, and embeds it in a script-only sandbox. The host validates relay messages and does not grant forms, top-level navigation, popups, or same-origin access to the App frame.

Declared CSP origins are normalized and constrained to supported HTTP(S) origins. Missing or malformed declarations keep restrictive defaults: no undeclared network connections, nested frames, objects, or base URIs are enabled. Camera, microphone, geolocation, and clipboard-write permissions are granted only when both declared by the resource and allowed by FLUJO's host policy; the effective grant is reported to the App in host capabilities.

External links are limited to safe HTTP(S) URLs. App-originated tool calls and resource reads pass through host authorization. App-provided model context is treated as untrusted, validated, size-bounded, and applied to later turns using last-write-wins semantics.

For hosted HTTPS deployment, choose **Settings → Network access → Public** and expose the sandbox on the same hostname at HTTPS port `4201`, proxied to FLUJO's sandbox listener. FLUJO derives the distinct sandbox origin and embedding origin automatically; see [Network exposure](../../../README.md#network-exposure).

### Per-app sandbox origins on multi-tenant deployments (Mode B)

A single-origin sandbox (Mode A/C above) still shares one origin — and therefore cookies, `localStorage`, and IndexedDB — across every App and, on a multi-tenant host, potentially across tenants. A hosting platform that fronts FLUJO can opt into **per-app** sandbox origins instead by setting `FLUJO_MCP_APP_SANDBOX_PUBLIC_URL` to a URL whose hostname contains the literal placeholder `{app}`, e.g.:

```
FLUJO_MCP_APP_SANDBOX_PUBLIC_URL=https://{app}.sandbox.example.com/sandbox.html
```

FLUJO derives the `{app}` label — the App's `originKey` — from the resource's validated `_meta.ui.domain` hint when present, or otherwise a deterministic hash of the server name and resource URI (see `deriveOriginKey()` in `src/shared/utils/mcpAppOrigin.ts`); the label is always a single DNS-safe, lowercase `[a-z0-9-]` segment. Each App is then served, and its access token scoped, to its own hostname label rather than the shared sandbox origin.

**This requires the reverse proxy in front of FLUJO to preserve the original `Host` header on requests it forwards to the sandbox listener.** The sandbox listener re-derives the effective `originKey` for every request from the incoming `Host` header (matched against the `{app}` template), rather than trusting a static value — this is what makes a token minted for one App rejected on every other App's hostname. A proxy that rewrites or drops the `Host` header (or that terminates TLS for a wildcard `*.sandbox.example.com` cert without forwarding the original label) breaks this isolation back down to the single-origin case. Requests whose `Host` header does not match the configured `{app}` template at all fall back to validating against the shared listener's own default key, so a misrouted/unexpected hostname is rejected rather than silently accepted.

Mode B is opt-in and additive: it has no effect on the desktop/loopback port-pool allocator (Mode A) or on a configured single-origin public URL without `{app}` (Mode C), both of which are unchanged.

## Lifecycle and display modes

FLUJO implements the MCP Apps initialization handshake, tool input/result/cancellation delivery, App-originated operations, host-context updates, and resource teardown. Messages received after replacement or unmount are ignored, listeners are removed, and pending work is cancelled.

The host and App negotiate display modes. FLUJO supports:

- `inline`, the default Chat timeline view;
- `fullscreen`, using the Chat canvas;
- `pip`, using the same canvas surface as a focused floating-style view.

A transition occurs only when both host and App declared the mode. If a requested mode is unavailable, FLUJO returns the current mode, as required by the stable specification. Only one App can own the canvas at a time, and closing it returns the App to inline rendering.

## Compatibility and limits

- Only raw HTML resources with MIME type `text/html;profile=mcp-app` are supported. External URL content types, multiple views per result, View-to-View communication, and other future-specification features are not advertised.
- A resource's host-specific `_meta.ui.domain` hint is not used to select arbitrary origins. On a single-origin deployment (the default), FLUJO derives one trusted sandbox origin from the deployment's network exposure setting; the hint only participates in deriving the `{app}` hostname label when a hosting platform has opted into Mode B per-app sandbox origins (above), and even then it is only ever used as a validated DNS label under the operator's own configured base domain.
- Partial streaming tool input is optional in the stable specification and is not advertised as a guarantee. Complete tool input is always delivered before a result.
- Browser downloads are a FLUJO host extension, not a message defined by the stable `2026-01-26` specification. They are handled only through the host bridge with bounded content, a sanitized filename, and a host-created download action.
- Browser/platform constraints can prevent a requested display transition. In that case the current supported mode is returned and the App remains usable.
