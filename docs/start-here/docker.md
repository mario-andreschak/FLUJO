# Run FLUJO with Docker

With Git and Docker installed, obtain the repository and start FLUJO from its directory:

```bash
git clone https://github.com/mario-andreschak/FLUJO.git
cd FLUJO
docker compose up --build
```

If you already have a checkout, run the Compose command from that directory. It needs this repository's configuration and build files.

Then open http://localhost:4200.

> Use `--build` (not a bare `docker compose up`). The default compose file
> **builds the image locally** from this repo. A plain `docker compose up`
> only builds when no image exists yet — after you update the code it silently
> reuses the previously built image and runs the *old* version. `--build`
> rebuilds when the source changed and is a fast no-op when it hasn't.

- **Your data persists** in `flujo-workspaces` (the workspace namespace and all
  non-default workspace data), plus the existing `flujo-db` and
  `flujo-mcp-servers` volumes mounted inside `default-workspace`. Reusing those
  two established volume names makes an upgrade retain existing flows, models,
  encrypted keys, chats, MCP configs, and installed server clones while every
  newly created workspace also survives `docker compose down` / `up`.
- **Updating**: use `git pull --ff-only` followed by `docker compose up --build` instead of the
  in-app updater. FLUJO detects it is running in a container and shows this in
  the update settings. (`docker compose pull` only helps if you switched the
  service to a published `image:` — the default builds locally.)
- **Private/corporate CA** for HTTPS MCP servers: mount your CA file and set
  `FLUJO_EXTRA_CA_CERTS` to its path (see the commented `environment:` block in
  `docker-compose.yml`).
- **Claude Subscription** in-container: generate a token on your host with
  `claude setup-token` and pass it as `CLAUDE_CODE_OAUTH_TOKEN`.
- **fileWatch triggers**: bind-mount the host folder you want to watch into the
  container (see the commented volume example in `docker-compose.yml`).
- **MCP Apps**: Compose also publishes the shared sandbox listener on port
  `4201`, loopback-only. Each App is loaded through its own
  `http://<originKey>.localhost:4201` browser origin. Keep both port mappings
  when using interactive MCP Apps.

> ⚠️ **Security:** the default local profile has no owner login, and its git API
> runs commands with the server's permissions. Ports bind to **localhost only**
> by default. Deliberate exposure requires your own authenticating reverse proxy
> and review of the [security policy](../../SECURITY.md). The opt-in source bearer
> profile has no browser login yet and does not qualify public/shared hosting.

[Back to installation](install.md) · [Start here](README.md)
