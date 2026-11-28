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

**Localhost behind your own signed-in front door.** Some setups keep FLUJO in
Localhost mode on a server and put their own sign-in gateway on the same
machine in front of it. App views then need the gateway's addresses. Set these
three together where FLUJO is started (environment or `.env` file):

```
FLUJO_EXPOSURE_MODE=localhost
FLUJO_MCP_APP_SANDBOX_PUBLIC_URL=https://sandbox.example.com/sandbox.html
FLUJO_MCP_APP_HOST_ORIGINS=https://flujo.example.com
```

What the gateway does with each request:

- It forwards dashboard requests to FLUJO with FLUJO's own address as `Host`
  and, when the browser sent one, as `Origin` (for example
  `http://127.0.0.1:4200`). Localhost mode refuses changes from any other
  origin.
- It sends `X-Forwarded-Host` and `X-Forwarded-Proto` (the address the browser
  used) only with the dashboard's request to `/api/mcp/app-sandbox`. Other
  requests carry no forwarding headers, because FLUJO's local-only controls
  refuse requests that came through a proxy.
- It forwards the sandbox address to port `4201` with the browser's `Referer`.
- It keeps its own sign-in cookie to itself, and marks it `HttpOnly`: when the
  sandbox uses another port of the dashboard's host name, the browser sends
  that host's cookies to the sandbox too.

FLUJO then hands out the sandbox address only to requests that come through
the gateway. A browser on the machine itself keeps using
`<app>.localhost:4201`, and the listed origins are added to, not swapped for,
the local ones. Localhost chosen only on the Settings page ignores these two
variables, so values left over from an older hosted setup stay switched off.
At startup FLUJO writes one line starting with `[FLUJO] MCP Apps sandbox` to
its output, saying which values it uses or ignores and why; a wrong value is
ignored and app views keep the local address.

`npm run journey:front-door` checks this whole setup after `npm run build`: it
starts a throwaway FLUJO this way behind a local HTTPS gateway with a sign-in
(`scripts/front-door/proxy.mjs`), signs in with a browser, and checks that an
app view shows in a chat. CI runs it in the `First-use journey` job.

See [MCP Apps host support](../../docs/features/mcp/apps.md) for protocol behavior,
security guarantees, display modes, compatibility limits, and the versioned
compliance matrix.

[Back to installation](install.md) · [Start here](README.md)
