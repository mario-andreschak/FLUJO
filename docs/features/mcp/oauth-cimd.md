# MCP sign-in with Client ID Metadata Documents

FLUJO prefers Client ID Metadata Documents (CIMD) when an authorization server
advertises `client_id_metadata_document_supported: true`. The SDK uses the
document's HTTPS URL as the OAuth `client_id`, without a registration request or
client secret. PKCE, issuer binding, encrypted credential storage, and single-use
workspace state remain in effect.

The default document is [FLUJO's client metadata](https://flujo.com.co/oauth/client-metadata.json).
Its source is [`githubpages/oauth/client-metadata.json`](../../../githubpages/oauth/client-metadata.json).
The existing GitHub Pages deployment serves the document on `flujo.com.co`; the
custom domain and GitHub Pages are the same hosting setup. No application backend,
account, paid service, or secret belongs in this document. Its `client_id` must
match the public document URL exactly, including the custom domain.

The default document allows these callbacks:

- `http://localhost:4200/api/oauth/callback`
- `http://127.0.0.1:4200/api/oauth/callback`
- `http://[::1]:4200/api/oauth/callback`

CIMD uses a stable callback across workspaces. The authorization state carries the
workspace identifier and a random 256-bit nonce. The callback selects an existing
workspace, then validates the entire saved state, its workspace, 20-minute lifetime,
and original issuer before consuming it and exchanging the authorization code.
An explicit conflicting workspace is rejected. GET and form POST callbacks work.

## Custom domains and ports

For any callback outside the published list, host a separate JSON document on a
public HTTPS URL (GitHub Pages is suitable) and set this environment variable in
the FLUJO server, then restart it:

```dotenv
FLUJO_OAUTH_CLIENT_METADATA_URL=https://your-domain.example/oauth/client-metadata.json
```

For a hosted installation, the document can contain:

```json
{
  "client_id": "https://your-domain.example/oauth/client-metadata.json",
  "client_name": "My FLUJO",
  "client_uri": "https://your-flujo.example/",
  "redirect_uris": ["https://your-flujo.example/api/oauth/callback"],
  "application_type": "web",
  "grant_types": ["authorization_code", "refresh_token"],
  "response_types": ["code"],
  "token_endpoint_auth_method": "none"
}
```

For a local custom port, use `application_type: "native"` and list the exact local
callback, for example `http://localhost:4300/api/oauth/callback`. Do not include a
`workspace` query parameter or use redirect wildcards. Authorization servers must
be able to fetch the document without authentication. Serve JSON directly with no
redirect, and verify its `client_id` matches the requested URL. Never put a client
secret or tokens in the document.

## Compatibility and recovery

Existing issuer-bound registrations are reused. New connections prefer CIMD;
servers without CIMD can still use DCR as a compatibility fallback. A pre-registered
client remains supported through the OAuth credential fields and the trusted
`oauthIssuer` setting. DCR and pre-registered clients retain their existing
workspace-specific callback URLs. Disconnect/reset a saved registration before
authenticating if you intentionally want to replace it with CIMD.

Discovery and assisted installation recognize CIMD-only endpoints as OAuth sign-in
options and omit Registry-declared static `Authorization` inputs, while retaining
other required headers. For an unsupported local port or hosted address with no
configured document, FLUJO reports the deployment setup needed instead of claiming
that the public default document covers the address.

The [MCP 2026-07-28 client-registration specification](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/client-registration)
deprecates DCR and retains it for compatibility. Release validation should exercise
both SDK generations, CIMD-only and dual-capability servers, DCR fallback, existing
registrations, custom documents, issuer/state/replay failures, and GET/POST callbacks.

## Qualified CIMD maintenance acceptance (2026-10-16)

Exact inputs and results
cover the existing CIMD implementation combined with main's Undici security patches.
All 128 focused checks pass across both SDK generations, discovery/installation,
issuer/state isolation, existing clients and the connection UI. The initial CIMD UI
case had a hardcoded DCR expectation; it now asserts the selected auth mode.

The built application completes controlled OAuth GET and cross-origin form POST
callbacks with actual PKCE verification, issuer and workspace rejection, replay
rejection, encrypted persistence and process restart. A real browser completes
local consent and the resulting MCP page fits 320px and 390px viewports. No model
or third-party OAuth account is invoked. Public metadata publication is verified
separately after protected merge and the Pages deployment; these local results
do not assert installed or broader release acceptance.

To repeat the controlled journey, use an isolated source build with no dotenv
files, keep ports 4200/4201 available, set `CIMD_ACCEPTANCE_RUN_DIR` to a new private
absolute evidence directory, and run `node scripts/mcp-cimd-acceptance.mjs`
through flujo-bash. The harness retains profiles and logs for the task owner to
clean through flujo-bash after observing app exit and closed pipes.
