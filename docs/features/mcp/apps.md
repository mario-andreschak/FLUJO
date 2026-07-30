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

App HTML is untrusted. FLUJO serves it through a separately configured sandbox origin, applies a restrictive Content Security Policy, and embeds it in a script-only sandbox. The host validates relay messages and does not grant forms, top-level navigation, popups, or same-origin access to the App frame.

Declared CSP origins are normalized and constrained to supported HTTP(S) origins. Missing or malformed declarations keep restrictive defaults: no undeclared network connections, nested frames, objects, or base URIs are enabled. Camera, microphone, geolocation, and clipboard-write permissions are granted only when both declared by the resource and allowed by FLUJO's host policy; the effective grant is reported to the App in host capabilities.

External links are limited to safe HTTP(S) URLs. App-originated tool calls and resource reads pass through host authorization. App-provided model context is treated as untrusted, validated, size-bounded, and applied to later turns using last-write-wins semantics.

For hosted HTTPS deployment, the sandbox must use a different HTTPS origin from FLUJO. Configure `FLUJO_MCP_APP_SANDBOX_PUBLIC_URL` and the exact embedding-origin allowlist in `FLUJO_MCP_APP_HOST_ORIGINS`; see [MCP Apps behind HTTPS](../../../README.md#mcp-apps-behind-https).

## Lifecycle and display modes

FLUJO implements the MCP Apps initialization handshake, tool input/result/cancellation delivery, App-originated operations, host-context updates, and resource teardown. Messages received after replacement or unmount are ignored, listeners are removed, and pending work is cancelled.

The host and App negotiate display modes. FLUJO supports:

- `inline`, the default Chat timeline view;
- `fullscreen`, using the Chat canvas;
- `pip`, using the same canvas surface as a focused floating-style view.

A transition occurs only when both host and App declared the mode. If a requested mode is unavailable, FLUJO returns the current mode, as required by the stable specification. Only one App can own the canvas at a time, and closing it returns the App to inline rendering.

## Compatibility and limits

- Only raw HTML resources with MIME type `text/html;profile=mcp-app` are supported. External URL content types, multiple views per result, View-to-View communication, and other future-specification features are not advertised.
- A resource's host-specific `_meta.ui.domain` hint is not used to select arbitrary origins. Operators configure one trusted sandbox origin for the deployment.
- Partial streaming tool input is optional in the stable specification and is not advertised as a guarantee. Complete tool input is always delivered before a result.
- Browser downloads are a FLUJO host extension, not a message defined by the stable `2026-01-26` specification. They are handled only through the host bridge with bounded content, a sanitized filename, and a host-created download action.
- Browser/platform constraints can prevent a requested display transition. In that case the current supported mode is returned and the App remains usable.
