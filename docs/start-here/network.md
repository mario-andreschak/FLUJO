# Network access

Use **Settings → Network access** to choose one deployment posture:

- **Localhost** (default) — only this computer; both listeners bind loopback.
- **Local Network** — listen on all interfaces and accept private LAN addresses
  and this machine's hostnames.
- **Public** — accept any hostname. This setting controls exposure, not owner
  authentication or user isolation; use it only behind authenticating HTTPS
  controls. Public/shared release acceptance remains open.

The one setting controls the UI, API, OpenAI/MCP endpoints, Host/Origin guard,
and MCP Apps sandbox binding together. Restart FLUJO after changing it.

The [owner access source contract](../../docs/security/owner-access-v1.md) describes
an opt-in native API bearer policy. It retains anonymous localhost behavior when
no policy is selected, has no browser login flow yet, and needs installed-client
and independent security acceptance. Keep existing browser-dependent installs on
their current profile until a compatible login/migration path is accepted.

MCP Apps require no additional configuration on localhost or a plain-HTTP Local
Network install. FLUJO discovers the browser-visible host automatically and uses
port `4201` for the sandbox. Hosted HTTPS deployments can optionally configure
`FLUJO_MCP_APP_SANDBOX_PUBLIC_URL` with `{app}` as one complete hostname label,
for example `https://{app}.sandbox.example.com/sandbox.html`, and proxy those
wildcard hostnames to FLUJO's plain HTTP port `4201`. Without wildcard
DNS/TLS, set the same variable to a single shared sandbox origin instead
(for example `https://sandbox.example.com`); the App key then travels in the
authenticated sandbox URL. Preserve the browser's
`Host` and `Referer` headers through the proxy. Docker Compose publishes both
listener ports to host loopback by default; change those mappings when other LAN
devices or a reverse proxy need to reach them.

See [MCP Apps host support](../../docs/features/mcp/apps.md) for protocol behavior,
security guarantees, display modes, compatibility limits, and the versioned
compliance matrix.

[Back to installation](install.md) · [Start here](README.md)
