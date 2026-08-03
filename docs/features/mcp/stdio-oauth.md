# Third-party OAuth for local stdio MCP servers

FLUJO implements the client side of the experimental `mcp-stdio-oauth` extension.
It lets a local stdio server declare downstream OAuth authorizations (Google,
Microsoft, GitHub, and so on)
without treating those credentials as MCP transport OAuth and without relying
on specially named tools.

Package: `mcp-stdio-oauth`

Extension ID: `co.com.flujo/mcp-stdio-oauth`

Extension version: `0.1`

This is a FLUJO extension, not currently a standard MCP capability. Servers must
negotiate it in the normal MCP capability exchange. FLUJO advertises it only
to configured local stdio servers:

```json
{
  "extensions": {
    "co.com.flujo/mcp-stdio-oauth": {
      "version": "0.1",
      "urlElicitation": true
    }
  },
  "elicitation": {
    "url": {}
  }
}
```

The server advertises the same extension ID and value. FLUJO uses extension
methods only when both peers advertised the exact `0.1` capability and URL
elicitation support. A remote server cannot opt FLUJO into this local-stdio
contract by advertising it unilaterally.

## Readiness method

After capability discovery (the initialize-era handshake or `server/discover`)
and before every tool dispatch, FLUJO may call:

`co.com.flujo/mcp-stdio-oauth/status`

Parameters:

```json
{}
```

Result:

```json
{
  "authorizations": [
    {
      "id": "google-workspace",
      "label": "Google Workspace",
      "state": "authorization_required",
      "blocksUnattendedUse": true,
      "message": "Sign in before Gmail tools can run."
    }
  ]
}
```

`id` is an opaque stable identifier. `state` is extensible; `ready` is the only
universally non-blocking state. If `blocksUnattendedUse` is true and the state is
not `ready`, FLUJO shows the account requirement on the MCP server card and
refuses tool calls with `stdio-oauth-required`. That gate covers
foreground, scheduled, polling, and MCP App calls.
Non-ready entries that set `blocksUnattendedUse: false` remain visible as
optional setup actions on the card, but do not change the server's connected
status or block tool dispatch.

The status method must be read-only. It must never launch a browser, start OAuth,
or require user interaction.

## Start method

Only after the user selects **Authenticate** does FLUJO call:

`co.com.flujo/mcp-stdio-oauth/start`

Parameters:

```json
{
  "authorizationId": "google-workspace"
}
```

The preferred response is URL-mode MCP elicitation from the server:

```json
{
  "method": "elicitation/create",
  "params": {
    "mode": "url",
    "message": "Sign in to Google Workspace",
    "url": "https://accounts.google.com/o/oauth2/v2/auth?..."
  }
}
```

Under MCP `2026-07-28`, FLUJO keeps the SDK's exact stdio transport through
automatic era negotiation and the handshake, then attaches the package's MRTR
adapter in place. This preserves the SDK's disposable sibling probe and legacy
fallback. The adapter receives `input_required`, obtains the trusted URL consent
response, and retries the fully-qualified start method with a new JSON-RPC ID,
`inputResponses`, and the server's exact opaque `requestState`.
Initialize-era connections use the normal `elicitation/create` request channel.
The public extension does not define a parallel raw-URL result.

FLUJO validates the URL, displays its full value and origin, and requires a second
explicit click before returning `accept` to URL elicitation and opening the
browser. The review dialog exposes distinct decline and cancel outcomes. HTTPS
is required, except that HTTP loopback hosts are allowed. URL
elicitation outside an active, user-started extension request is cancelled, so a
background run cannot create UI after the fact.

## Server responsibilities

The local server owns the provider OAuth client, PKCE/state validation, callback
listener, refresh tokens, token persistence, revocation handling, and provider
scopes. FLUJO does not receive Gmail tokens. A typical local server starts a
loopback callback listener during `start`, supplies the provider URL, stores the
tokens after the callback, and then reports `ready` from `status`.

If authorization expires or is revoked, report a non-`ready` blocking state on
the next status request. If revocation is detected during a tool call, return an
MCP error with namespaced data so FLUJO can invalidate its readiness cache and
request fresh status:

```json
{
  "code": -32042,
  "message": "Google Workspace authorization expired",
  "data": {
    "co.com.flujo/mcp-stdio-oauth": {
      "authorizationId": "google-workspace",
      "state": "authorization_required",
      "message": "Sign in to Google Workspace again."
    }
  }
}
```

The exact server-error code may vary; FLUJO uses the package's namespaced error
parser rather than relying on the number.
Tool handlers should still enforce their own credential checks. FLUJO's preflight
is an orchestration safety gate, not a replacement for server-side authorization.

The convention intentionally targets local stdio servers started by FLUJO with
their configured command, arguments, environment, and working directory. It is
third-party OAuth owned by that child process, not OAuth authentication for the
stdio transport. A remote registry entry remains an address/metadata description;
the MCP client does not start or inject process options into a hosted server.
