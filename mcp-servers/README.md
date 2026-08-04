# Standalone FLUJO MCP servers

This workspace contains the stdio MCP processes managed by FLUJO:

| Package | Executable | Purpose |
| --- | --- | --- |
| `@mario.andreschak/mcp-flujo` | `flujo-mcp-flujo` | FLUJO application tools and run resources, delegated to the running backend through the localhost control API. |
| `@mario.andreschak/mcp-filesystem` | `flujo-mcp-filesystem` | Confined filesystem tools, MCP Apps HTML resources, and the bounded touched-file resource registry. |
| `@mario.andreschak/mcp-bash` | `flujo-mcp-bash` | Cross-platform foreground/background shell execution plus a PTY-backed MCP Apps terminal with process-tree cleanup. |
| `@mario.andreschak/mcp-browser` | `flujo-mcp-browser` | Isolated server-side Patchright browser automation with an MCP Apps browser view. |

Each package builds to `dist/index.js`, uses `StdioServerTransport`, and reserves stdout for MCP protocol frames. Diagnostics are written to stderr. FLUJO persists portable `npx --no-install <executable>` configurations and resolves them from the runtime-only `FLUJO_APP_ROOT`; no checkout or install path is stored in user data. Connection, restart, roots notifications, and shutdown use the same client lifecycle as external MCP servers.

## Development

From the repository root:

```text
npm install
npm run build:mcp
npm run typecheck:mcp
npm test -- --runInBand __tests__/mcp/stdioServers.test.ts
```

A package can also be launched directly after building:

```text
node mcp-servers/filesystem/dist/index.js
node mcp-servers/bash/dist/index.js
node mcp-servers/browser/dist/index.js
```

`mcp-flujo` is independently executable and uses `FLUJO_BASE_URL` to reach the running FLUJO instance. When the variable is absent it defaults to `http://127.0.0.1:4200`; FLUJO supplies the effective custom-port URL to managed child processes automatically.

## Release synchronization

`flujo-ai`, `@mario.andreschak/mcp-flujo`, `@mario.andreschak/mcp-filesystem`, `@mario.andreschak/mcp-bash`, and `@mario.andreschak/mcp-browser` always share one version. `npm version` runs `scripts/sync-version.mjs`, which updates the package manifests, the exact production dependency pins, and the lockfile. `npm run release` builds and validates all packed binaries, publishes the four MCP packages first, publishes `flujo-ai` last, and only then pushes the release commit/tag. Do not publish one package independently.

`npm run validate:mcp-release` rejects version drift, non-exact root pins, missing executable output, or an npm tarball that omits a required manifest/binary. The Docker publishing workflow runs the same validation before building the image.

## Browser server

The browser server is seeded disabled by default. Enable it in MCP Manager, or set `FLUJO_BROWSER_ENABLED=1` before first startup to seed it enabled. Its shipped record enables MCP Apps so the browser view is immediately available once the server is enabled; disabling the server still blocks both app resource access and tool calls. The browser package's npm `install` lifecycle runs `patchright install chromium`, so normal FLUJO, standalone package, and graphical-installer installations automatically download the version-matched managed browser. The Docker image also installs the required Linux libraries and uses a shared browser cache readable by its unprivileged runtime user. Installations that deliberately suppress npm lifecycle scripts with `--ignore-scripts` must run `npx patchright install chromium` themselves. Patchright supports current Windows, macOS, and Linux platforms covered by its Chromium distribution; failures to launch are returned as a stable `BROWSER_UNAVAILABLE` MCP error.

Every session uses a new incognito context inside a lazily launched, shared Chromium process. Profiles are never taken from a host browser. Downloads are rejected and service workers are blocked. Each screenshot remains in the MCP payload and is also written to a bounded per-session `viewport.png` or `full-page.png`; the tool result always reports that artifact's absolute host path. Patchright's temporary/download root lives under an isolated OS temp directory that is removed at shutdown. Sessions are bounded, expire when idle, close on cancellation, and can be explicitly discarded with `browser_close`.

`sessionId` is optional on every browser tool. When omitted, the server targets the most recently used live session. `browser_open` creates a new random session only when no live session exists; supplying an explicit id remains the way to select, reuse, or create a particular session.

Navigation permits only HTTP(S), rejects URL credentials, and blocks localhost/private-network destinations (including DNS resolutions) unless `FLUJO_BROWSER_ALLOW_PRIVATE_HOSTS=1` is explicitly set. Set `FLUJO_BROWSER_ALLOWED_ORIGINS` to a comma-separated exact-origin allowlist for a narrower policy. The MCP App at `ui://browser/view` is self-contained, runs in FLUJO's existing separate-origin sandbox, and calls only the owning browser server's declared tools; browser actions remain server-side. Its screenshot viewport supports direct pointer clicks, scrolling, focused typing, keyboard navigation, back/forward/reload, and fullscreen mode, with selector controls retained as a fallback.

Browser controls:

- `FLUJO_BROWSER_ENABLED=1`: seed the ordinary browser MCP record enabled on first migration; default is disabled.
- `FLUJO_BROWSER_ALLOWED_ORIGINS=https://example.com,https://docs.example.com`: optional exact-origin allowlist.
- `FLUJO_BROWSER_ALLOW_PRIVATE_HOSTS=1`: allow loopback/private/local destinations (off by default).
- `FLUJO_BROWSER_EXECUTABLE_PATH`: use an operator-managed Chromium executable instead of Patchright's managed binary.
- `FLUJO_BROWSER_MAX_SESSIONS`: concurrent isolated contexts, 1–32 (default 4).
- `FLUJO_BROWSER_IDLE_TIMEOUT_MS`: idle cleanup interval, 10 seconds–24 hours (default 10 minutes).
- `FLUJO_BROWSER_MAX_REDIRECTS`: per-navigation document redirect cap, 0–50 (default 10).
- `FLUJO_BROWSER_SCREENSHOT_DIR`: optional screenshot artifact directory; defaults to `<FLUJO_DATA_DIR>/screenshots/browser`.

The exposed contract is deliberately narrow: open, navigate/history/reload, snapshot, selector or coordinate click, focused or selector typing, key press, scroll, persisted PNG screenshot, and close. Apart from its own bounded screenshot artifact directory, it exposes no process execution, arbitrary host filesystem access, cookies, storage dumps, raw profiles, or unrestricted downloads.

The Bash server publishes `ui://bash/terminal` as a self-contained MCP App and
links it from `open_terminal`. The launcher is visible to the model and the app;
the raw PTY read/write/resize/close/list tools use `_meta.ui.visibility: ["app"]`
so they do not clutter model tool context. The terminal uses ConPTY on Windows
and a pseudoterminal on macOS/Linux, renders ANSI/VT output with xterm, accepts
keyboard and pasted input, and negotiates terminal size through app-only tools.
As with a normal terminal, stdout and stderr share the PTY stream.

## Roots and operator policy

The filesystem server reads MCP client roots and treats `FLUJO_FS_ROOTS` as an operator hard ceiling. The bash server uses `FLUJO_BASH_ROOTS`, falling back to `FLUJO_FS_ROOTS`. Client roots may narrow an environment ceiling but cannot widen it. When no ceiling or client roots exist, the standalone server falls back to `FLUJO_DATA_DIR`.

Relevant variables:

- `FLUJO_DATA_DIR`: base for relative paths and the no-roots fallback.
- `FLUJO_FS_ROOTS`: path-delimited filesystem ceiling; also the bash fallback ceiling.
- `FLUJO_BASH_ROOTS`: path-delimited bash working-directory ceiling.
- `FLUJO_ALLOW_PROTECTED_PATHS=1`: operator override disabling the optional protected-path deny layer.
- `FLUJO_PROTECTED_PATHS_ENABLED=1`: resolved by FLUJO from the application setting and supplied to filesystem/bash children.
- `FLUJO_BASH_INHERIT_ENV=1`: explicitly lets bash commands inherit the full FLUJO backend environment. Without it, commands receive only the existing minimal allow-list.
- `FLUJO_MCP_DEBUG=1`: enables package debug diagnostics on stderr.

Filesystem resource reads re-check confinement against current roots. The touched-file registry stores at most 200 descriptors and serves current file content with the existing response-size cap.

## Shutdown and troubleshooting

Closing the MCP client closes the stdio transport. Signal handlers close the server, and the bash package terminates active process trees using Windows `taskkill /T /F` or POSIX process-group `SIGTERM` with `SIGKILL` escalation.

If a built-in server cannot connect:

1. Run `npm run build:mcp` and confirm the package's `dist/index.js` exists.
2. Check the MCP server stderr log; protocol output must never be written to stdout.
3. Confirm configured roots fall within the operator ceiling.
4. For `mcp-flujo`, confirm `FLUJO_BASE_URL` points at the running local FLUJO instance.
