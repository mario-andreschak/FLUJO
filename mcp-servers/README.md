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

The default `FLUJO_BROWSER_MODE=sandbox` gives every session a new incognito context inside a lazily launched, shared managed Chromium process. Downloads are rejected, and service workers are blocked unless `FLUJO_BROWSER_ALLOW_SERVICE_WORKERS=1` is set. `FLUJO_BROWSER_MODE=trusted` instead launches installed Chrome headed by default through `launchPersistentContext`, using a dedicated profile under `<FLUJO_DATA_DIR>/browser-profile/trusted` (or `FLUJO_BROWSER_PROFILE_DIR`). Trusted session tabs share cookies and storage, service workers default to allowed, and `browser_close` closes only the tab while retaining profile state. FLUJO never attaches to or mutates the user's ordinary Chrome profile.

The full `chromium` channel is preferred over the reduced headless shell in sandbox mode so compositing, animation, and video decode behave like a real browser. Trusted mode prefers the installed `chrome` channel and falls back to the managed full Chromium build when Chrome is unavailable. Locale and timezone default to the host and can be pinned coherently. Each screenshot remains in the MCP payload and is also written to a bounded per-session `viewport.png` or `full-page.png`; the tool result always reports that artifact's absolute host path. Patchright's temporary/download root lives under an isolated OS temp directory that is removed at shutdown. Sessions are bounded, expire when idle, close on cancellation, and can be explicitly discarded with `browser_close`.

Extensions belong only to the dedicated trusted profile. A user can install ordinary extensions manually in its headed Chrome window; FLUJO never reads or copies the personal Chrome profile. `browser_extensions` lists profile-installed extensions, explicitly configured unpacked directories, and active extension targets without returning extension settings. Operators may allowlist unpacked directories with `FLUJO_BROWSER_EXTENSION_DIRS`; every entry must be an absolute directory with a valid manifest. Current Google Chrome/Edge releases removed command-line side-loading, so this explicit unpacked mode requires `FLUJO_BROWSER_CHANNEL=chromium` as documented by [Playwright](https://playwright.dev/docs/chrome-extensions) and [Chrome for Developers](https://developer.chrome.com/blog/extension-news-june-2025#removing-flag).

`sessionId` is optional on every browser tool. When omitted, the server targets the most recently used live session. `browser_open` creates a new random session only when no live session exists; supplying an explicit id remains the way to select, reuse, or create a particular session.

Navigation permits only HTTP(S), rejects URL credentials, and blocks localhost/private-network destinations (including DNS resolutions, memoised for one minute so a media-heavy page does not pay a lookup per subresource) unless `FLUJO_BROWSER_ALLOW_PRIVATE_HOSTS=1` is explicitly set. Set `FLUJO_BROWSER_ALLOWED_ORIGINS` to a comma-separated exact-origin allowlist for a narrower policy. Only top-level documents count against the redirect cap, so embed-heavy pages are not blocked by their tenth iframe.

`browser_diagnostics` reports the configured and actual mode/channel, headless and profile state, locale/timezone, service-worker policy, and the active page's browser fingerprint. Tool errors include a `category` (`policy`, `runtime`, `input`, or `cancelled`), and successful navigations expose destination-site/WAF challenge detection separately from FLUJO's request-policy counters.

### Deterministic capture and recording (#366)

`browser_capture_page`, `browser_capture_region`, and `browser_capture_element_metrics` capture a page, an inline HTML fragment, or a local file deterministically: viewport is fixed, animations/caret are disabled, `document.fonts.ready` is awaited, and an optional `waitFor` (CSS selector or JS predicate, its result is boolean-coerced and never returned) gates the capture. Still captures assert a single stable PNG color type rather than silently emitting mixed formats. `file://`/localhost/private-host sources are refused unless **all** of the following hold: `allowLocal: true` on the call, `FLUJO_BROWSER_ALLOW_LOCAL_CAPTURE=1`, and the resolved realpath is inside the FLUJO data directory or `FLUJO_BROWSER_LOCAL_CAPTURE_ROOTS` — ordinary `browser_open`/`browser_navigate` policy is untouched.

`browser_record_start`/`browser_record_stop`/`browser_record_status` record a dedicated session (drivable with the ordinary browser tools while recording) to WebM via Patchright's `recordVideo`, with an optional WAV audio sidecar from the existing Web Audio tap. If an `ffmpeg` binary is discoverable (`FLUJO_FFMPEG_PATH` or `PATH`) the two are muxed into one file; otherwise both artifacts are returned separately with `muxed: false` — ffmpeg is never downloaded or installed. `FLUJO_BROWSER_RECORD_DIR` and `FLUJO_BROWSER_RECORD_MAX_MS` control where artifacts land and the hard duration cap.

This is deliberately separate from `system_screenshot` (below): browser capture renders *a page*, while `system_screenshot` captures *the host desktop*, including unrelated windows. Use browser capture to verify rendered HTML.

### Live view

The MCP App at `ui://browser/view` is a thin shell that performs the MCP handshake, opens the session, and then frames the browser UI served by a loopback gateway the server starts itself — the same pattern the VS Code MCP App uses to embed OpenVSCode. Because that UI runs on a real HTTP origin instead of inside the host's app sandbox, it is not bound by the app CSP and can behave like an actual browser window: tab strip, omnibox with a security indicator, loading bar, back/forward/reload, and full-screen handoff.

The gateway binds loopback only and requires a per-process bearer token that is templated into the app shell, so the token never reaches the model. It serves:

- `/view` — the browser UI (granted to the app through `_meta.ui.csp.frameDomains`).
- `/stream` — an MJPEG stream fed by CDP `Page.startScreencast`, so video, canvas, and CSS animation render continuously instead of one screenshot per tool call. Focus emulation keeps rendering alive on the headless page.
- `/audio` — chunked PCM tapped out of the page's Web Audio graph and played back by Web Audio in the viewer's browser, the same way a local audio app renders sound. `--mute-audio` only silences Chromium's device sink, so the host machine stays quiet while the samples still arrive. Cross-origin media served without CORS headers taints the graph and stays silent; the picture is unaffected.
- `/events` — page URL/title/loading transitions.
- `/input` — batched pointer, wheel, keyboard, paste, and viewport events, dispatched through a per-session queue so keystrokes cannot interleave.

Browser actions still run server-side, and the model-facing tools are unchanged: when the gateway is unavailable the app falls back to the screenshot flow.

Browser controls:

- `FLUJO_BROWSER_ENABLED=1`: seed the ordinary browser MCP record enabled on first migration; default is disabled.
- `FLUJO_BROWSER_ALLOWED_ORIGINS=https://example.com,https://docs.example.com`: optional exact-origin allowlist.
- `FLUJO_BROWSER_ALLOW_PRIVATE_HOSTS=1`: allow loopback/private/local destinations (off by default).
- `FLUJO_BROWSER_MODE=sandbox|trusted`: isolated managed Chromium (default) or headed installed Chrome with a dedicated persistent profile.
- `FLUJO_BROWSER_EXECUTABLE_PATH`: use an operator-managed Chromium executable instead of Patchright's managed binary.
- `FLUJO_BROWSER_PROFILE_DIR`: trusted-mode profile directory; defaults to `<FLUJO_DATA_DIR>/browser-profile/trusted`.
- `FLUJO_BROWSER_LOCALE`: browser locale and `Accept-Language` identity; defaults to the host locale.
- `FLUJO_BROWSER_TIMEZONE_ID`: browser IANA timezone; defaults to the host timezone.
- `FLUJO_BROWSER_EXTENSION_DIRS`: path-delimiter-separated allowlist of absolute unpacked-extension directories; trusted mode only and requires channel `chromium`.
- `FLUJO_BROWSER_WINDOW_VISIBILITY=visible|offscreen|minimized`: keep trusted Chrome headed while controlling where its real desktop window appears; defaults to `visible`.
- `FLUJO_BROWSER_MAX_SESSIONS`: concurrent isolated contexts, 1–32 (default 4).
- `FLUJO_BROWSER_IDLE_TIMEOUT_MS`: idle cleanup interval, 10 seconds–24 hours (default 10 minutes).
- `FLUJO_BROWSER_MAX_REDIRECTS`: per-navigation document redirect cap, 0–50 (default 10).
- `FLUJO_BROWSER_SCREENSHOT_DIR`: optional screenshot artifact directory; defaults to `<FLUJO_DATA_DIR>/screenshots/browser`.
- `FLUJO_BROWSER_STREAM_ENABLED=0`: disable the live view gateway; the app falls back to screenshots.
- `FLUJO_BROWSER_STREAM_HOST` / `FLUJO_BROWSER_STREAM_PORT`: gateway bind address (default `127.0.0.1`) and port (default ephemeral).
- `FLUJO_BROWSER_STREAM_PUBLIC_ORIGIN`: advertise a different reachable origin when FLUJO runs behind a reverse proxy.
- `FLUJO_BROWSER_STREAM_QUALITY`: JPEG quality of the live stream, 10–95 (default 55).
- `FLUJO_BROWSER_STREAM_MAX_WIDTH` / `FLUJO_BROWSER_STREAM_MAX_HEIGHT`: streamed frame bounds (defaults 1600×1200).
- `FLUJO_BROWSER_STREAM_AUDIO=0`: stop capturing page audio (on by default).
- `FLUJO_BROWSER_VIEWPORT_WIDTH` / `FLUJO_BROWSER_VIEWPORT_HEIGHT`: initial viewport before the app reports its own size (defaults 1280×720).
- `FLUJO_BROWSER_CHANNEL`: browser channel (sandbox default `chromium`; trusted default `chrome`, with managed Chromium fallback).
- `FLUJO_BROWSER_HEADED=1|0`: headed state (sandbox defaults off; trusted defaults on).
- `FLUJO_BROWSER_AUDIO=1`: also let the managed browser play audio on the host's speakers.
- `FLUJO_BROWSER_ALLOW_SERVICE_WORKERS=1|0`: service-worker policy (sandbox defaults blocked; trusted defaults allowed).

The exposed contract is deliberately narrow: open, navigate/history/reload, snapshot, selector or coordinate click, focused or selector typing, key press, scroll, persisted PNG screenshot, and close. Apart from its own bounded screenshot artifact directory, it exposes no process execution, arbitrary host filesystem access, cookies, storage dumps, raw profiles, or unrestricted downloads.

The Bash server publishes `ui://bash/terminal` as a self-contained MCP App and
links it from `open_terminal`. The launcher is visible to the model and the app;
the raw PTY read/write/resize/close/list tools use `_meta.ui.visibility: ["app"]`
so they do not clutter model tool context. The terminal uses ConPTY on Windows
and a pseudoterminal on macOS/Linux, renders ANSI/VT output with xterm, accepts
keyboard and pasted input, and negotiates terminal size through app-only tools.
As with a normal terminal, stdout and stderr share the PTY stream.

Foreground `run` calls stream merged output as MCP progress and send a liveness
heartbeat every ten seconds while they are silent. FLUJO forwards those updates
to the live run indicator and uses them to keep a finite client request timeout
alive. The Bash-side `timeout` defaults to 60 seconds, accepts any positive value
up to a 12-hour ceiling, and accepts `-1` to run until completion, cancellation,
or server shutdown. `wait` has the same timeout contract without killing the
background session when a finite wait expires.

## System screenshot (internal `flujo` server, #366)

`system_screenshot` captures the host desktop — full virtual screen, a specific display, or a pixel region — using OS-native commands only (PowerShell/`System.Drawing` on Windows, `/usr/sbin/screencapture` on macOS, `grim`/`import`/`spectacle`/`gnome-screenshot` probing on Linux). It is unrelated to the browser server: it captures *whatever is on the machine*, including unrelated windows and applications, and is not a way to verify rendered HTML (use the browser server's `browser_capture_page` for that).

It is genuinely a new capability class, so it is **default off** and, when disabled, is not advertised at all rather than returning a policy error — set `FLUJO_SYSTEM_SCREENSHOT_ENABLED=1` to enable it. It also refuses to run when no interactive desktop session is detectable (headless Linux with no `DISPLAY`/`WAYLAND_DISPLAY`; a Windows session with no `SESSIONNAME`). Every OS command is spawned as an argv array — never a shell string — so no caller-supplied value can change what executes; on Windows, per-call parameters (mode, display index, region) flow through environment variables into a single fixed PowerShell script rather than being interpolated into script text.

## Roots and operator policy

The filesystem server reads MCP client roots and treats `FLUJO_FS_ROOTS` as an operator hard ceiling. The bash server uses `FLUJO_BASH_ROOTS`, falling back to `FLUJO_FS_ROOTS`. Client roots may narrow an environment ceiling but cannot widen it. When no ceiling or client roots exist, the standalone server falls back to `FLUJO_DATA_DIR`.

Relevant variables:

- `FLUJO_DATA_DIR`: base for relative paths and the no-roots fallback.
- `FLUJO_FS_ROOTS`: path-delimited filesystem ceiling; also the bash fallback ceiling.
- `FLUJO_BASH_ROOTS`: path-delimited bash working-directory ceiling.
- `FLUJO_ALLOW_PROTECTED_PATHS=1`: operator override disabling the optional protected-path deny layer.
- `FLUJO_PROTECTED_PATHS_ENABLED=1`: resolved by FLUJO from the application setting and supplied to filesystem/bash children.
- `FLUJO_BASH_INHERIT_ENV=1`: explicitly lets bash commands inherit the full FLUJO backend environment. Without it, commands receive only the existing minimal allow-list.
- `FLUJO_BASH_COMMAND_MAX_TIMEOUT_MS`: positive-value ceiling for foreground `run` and `wait` timeouts (default 12 hours); `timeout: -1` explicitly disables their Bash-side timer.
- `FLUJO_MCP_DEBUG=1`: enables package debug diagnostics on stderr.

Filesystem resource reads re-check confinement against current roots. The touched-file registry stores at most 200 descriptors and serves current file content with the existing response-size cap.

## Shutdown and troubleshooting

Closing the MCP client closes the stdio transport. Signal handlers close the server, and the bash package terminates active process trees using Windows `taskkill /T /F` or POSIX process-group `SIGTERM` with `SIGKILL` escalation.

If a built-in server cannot connect:

1. Run `npm run build:mcp` and confirm the package's `dist/index.js` exists.
2. Check the MCP server stderr log; protocol output must never be written to stdout.
3. Confirm configured roots fall within the operator ceiling.
4. For `mcp-flujo`, confirm `FLUJO_BASE_URL` points at the running local FLUJO instance.
