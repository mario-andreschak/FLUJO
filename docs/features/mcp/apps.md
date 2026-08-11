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

Localhost and plain-HTTP Local Network installs work without sandbox configuration. For a hosted HTTPS deployment, choose **Settings → Network access → Public** and optionally configure a wildcard sandbox hostname as described below. See [Network exposure](../../../README.md#network-exposure).

### Per-app sandbox origins

Every App gets a stable browser origin derived from its workspace and verified resource identity. On a local install, Apps use `http://<originKey>.localhost:4201`; all of those hostnames resolve to one loopback listener, but the browser keeps their storage partitions separate. FLUJO does not recycle ports into another App's origin and does not fall back to a shared origin.

A hosted HTTPS deployment can set `FLUJO_MCP_APP_SANDBOX_PUBLIC_URL` to an HTTP(S) URL whose hostname contains the literal placeholder `{app}` as one complete DNS label, for example:

```
FLUJO_MCP_APP_SANDBOX_PUBLIC_URL=https://{app}.sandbox.example.com/sandbox.html
```

Alternatively, a hosted deployment that cannot provision wildcard DNS and a
wildcard certificate can set the same variable to a single shared sandbox
origin **without** `{app}`, for example:

```
FLUJO_MCP_APP_SANDBOX_PUBLIC_URL=https://sandbox.example.com
```

All Apps then share that one TLS-terminated outer proxy origin (one DNS
record, one certificate). The verified App key travels in the authenticated
sandbox URL — exactly like the automatic plain-HTTP LAN fallback — and every
access token remains scoped to that key. Untrusted App HTML still renders in
the nested sandboxed View on an opaque origin; only the browser storage
partition of the trusted outer proxy is shared. Prefer the `{app}` template
when you can provision it. The shared origin must differ from the origin the
FLUJO dashboard itself is browsed on.

Before issuing sandbox credentials, FLUJO re-reads the exact resource through the App-authorized MCP path and requires an exact URI plus the stable MCP App HTML MIME type. It then computes the `{app}` label with SHA-256 over the active workspace, configured server name, and exact resource URI. App metadata and caller-provided origin hints cannot select or merge browser origins. Each access token is scoped to that derived hostname.

On localhost, FLUJO automatically uses `<app>.localhost:4201`. On a plain-HTTP LAN, it automatically reuses the hostname or IP that opened the dashboard on port `4201`; the outer proxy origin is shared, while its URL and HMAC token remain scoped to the verified App identity. No DNS lookup or environment variable is required.

For a configured wildcard HTTPS endpoint, **the reverse proxy must preserve the original `Host` header when forwarding requests to the sandbox listener.** The listener extracts the effective key from that header and rejects a token minted for any other hostname.

## Lifecycle and display modes

FLUJO implements the MCP Apps initialization handshake, tool input/result/cancellation delivery, App-originated operations, host-context updates, and resource teardown. Messages received after replacement or unmount are ignored, listeners are removed, and pending work is cancelled.

The host and App negotiate display modes. FLUJO supports:

- `inline`, the default Chat timeline view;
- `fullscreen`, using the Chat canvas;
- `pip`, using the same canvas surface as a focused floating-style view.

A transition occurs only when both host and App declared the mode. If a requested mode is unavailable, FLUJO returns the current mode, as required by the stable specification. Only one App can own the canvas at a time, and closing it returns the App to inline rendering.

## Compatibility and limits

- Only raw HTML resources with MIME type `text/html;profile=mcp-app` are supported. External URL content types, multiple views per result, View-to-View communication, and other future-specification features are not advertised.
- A resource's host-specific `_meta.ui.domain` hint is not used to select or derive a browser origin. Origin identity is always host-owned and workspace-scoped.
- Partial streaming tool input is optional in the stable specification and is not advertised as a guarantee. Complete tool input is always delivered before a result.
- Browser downloads are a FLUJO host extension, not a message defined by the stable `2026-01-26` specification. They are handled only through the host bridge with bounded content, a sanitized filename, and a host-created download action.
- Browser/platform constraints can prevent a requested display transition. In that case the current supported mode is returned and the App remains usable.
