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

Before issuing sandbox credentials, FLUJO re-reads the exact resource through the App-authorized MCP path and requires an exact URI plus the stable MCP App HTML MIME type. It then computes the `{app}` label with SHA-256 over the active workspace, configured server name, and exact resource URI. App metadata and caller-provided origin hints cannot select or merge browser origins. Each access token is scoped to that derived hostname.

On localhost, FLUJO automatically uses `<app>.localhost:4201`. On a plain-HTTP LAN, it automatically reuses the hostname or IP that opened the dashboard on port `4201`; the outer proxy origin is shared, while its URL and HMAC token remain scoped to the verified App identity. No DNS lookup or environment variable is required.

For a configured wildcard HTTPS endpoint, **the reverse proxy must preserve the original `Host` header when forwarding requests to the sandbox listener.** The listener extracts the effective key from that header and rejects a token minted for any other hostname.

The proxy must also support WebSocket upgrades on this wildcard route. This is
needed when an App has registered a private sidecar runtime as described below.

### Private sidecar runtime broker

Some local stdio MCP servers own a real browser runtime on loopback. The
`mcp-vscode` server, for example, keeps OpenVSCode and its gateway on
`127.0.0.1`; a visitor's browser cannot connect to that address when FLUJO runs
on another machine. FLUJO can carry selected gateway paths through the existing
per-App sandbox origin without publishing the child's loopback port.

This broker is a FLUJO host/deployment extension, not an MCP protocol message.
The App remains specification-compliant: its resource declares the resulting
HTTPS origin in `_meta.ui.csp.frameDomains` (and any required connection/resource
domains) in the normal way.

For each managed stdio connection with MCP Apps enabled, FLUJO injects two
process-only variables:

```text
FLUJO_MCP_APP_RUNTIME_REGISTER_URL=http://127.0.0.1:4201/_flujo/runtime/register
FLUJO_MCP_APP_RUNTIME_REGISTER_TOKEN=<single-use 256-bit bearer>
```

They are host-owned and override persisted server environment values. A
throwaway **Test connection** process does not receive them. A participating
server follows this version-1 contract before it exposes a public URL:

1. Start its HTTP/WebSocket gateway on an explicit `127.0.0.1:<port>` origin.
2. Answer `GET /.well-known/flujo/mcp-app-runtime`. FLUJO supplies a random
   `X-Flujo-Runtime-Challenge`; the response is `204` with
   `X-Flujo-Runtime-Proof` equal to base64url
   `HMAC-SHA256(registerToken, "flujo-mcp-app-runtime-proof-v1:" + challenge)`.
3. `POST` the registration URL with `Authorization: Bearer <registerToken>` and
   JSON like:

```json
{
  "version": 1,
  "resourceUri": "ui://mcp-vscode/workbench.html",
  "targetOrigin": "http://127.0.0.1:54321",
  "routes": [
    {
      "path": "/ide/AbCdEf0123456789AbCdEf0123456789",
      "match": "prefix",
      "httpMethods": ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
      "websocket": true
    },
    {
      "path": "/stream",
      "match": "exact",
      "websocket": true
    }
  ]
}
```

4. Use the `201` response's `publicOrigin`/`publicBaseUrl` when building the MCP
   App resource and session payload:

```json
{
  "version": 1,
  "originKey": "app<60 lowercase hex characters>",
  "publicOrigin": "https://app….sandbox.example.com",
  "publicBaseUrl": "https://app….sandbox.example.com/"
}
```

Registration succeeds only for an explicit loopback HTTP origin that passes the
nonce proof. Paths must be absolute, normalized, non-reserved, and individually
declare their HTTP methods and/or WebSocket permission. Matching is exact or on
a path-segment boundary; query strings are forwarded but never participate in
authorization. The bearer is deleted immediately after the first successful
registration. The route is revoked when that MCP connection closes, errors,
restarts, is disabled, or is deleted, so a later process reusing the loopback
port cannot inherit it.

For mcp-vscode, the intended public manifest is only its unguessable
`/ide/<192-bit-base64url>/` prefix (HTTP plus WebSocket) and, when configured,
the exact `/stream` WebSocket. `/bridge`, `/mcp`, `/app`, `/session.json`, and
`/healthz` remain private. The server must remove both registration variables
from the environment inherited by OpenVSCode and stop serving the proof endpoint
after registration succeeds.

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
