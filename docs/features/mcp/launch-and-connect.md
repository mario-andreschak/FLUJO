# Launch-and-connect MCP servers

*Issue [#392](https://github.com/mario-andreschak/FLUJO/issues/392). Status: the
data model and the registry pipeline are implemented; FLUJO does **not** start
the process yet.*

## The two questions a server config answers

A FLUJO MCP server config answers two independent questions:

| Question | Field |
|---|---|
| *How do we talk to it?* | `transport` — `stdio` \| `sse` \| `streamable` \| `websocket` |
| *Who starts it?* | `launch` — absent (someone else starts it) or an `MCPLaunchSpec` |

Historically these were fused: `stdio` implied "FLUJO spawns it", and
`sse`/`streamable` implied "it is already running somewhere else". The MCP
Registry has a third shape — a package you run locally (`docker run …`,
`npx …`) that speaks **HTTP**, declared as
`Package.transport.type === 'streamable-http'` with a `transport.url` template.

`launch` is therefore modelled as an **optional, orthogonal field** on
`MCPStreamableConfig` and `MCPSSEConfig`, not as a fifth `transport` member.
The codebase carries ~67 `transport === …` discriminant checks across 15+ files;
a new union member would force a review of every one of them, while an optional
field leaves each check's meaning exactly as it was.

```ts
export type MCPLaunchSpec = {
  command: string;                  // docker | npx | uvx | dnx | runtimeHint
  args?: string[];
  env?: Record<string, EnvVarValue>;
  cwd?: string;
  readyTimeoutMs?: number;          // Phase 2: how long to poll serverUrl
};
```

Persistence needs no migration: configs are stored as plain JSON and loaded by
spreading unknown keys through, so `launch` round-trips as-is.

## What happens today

1. **The entry is visible.** `getInstallOptions()` used to drop non-stdio
   packages entirely ("we can't run it, hide it"). It now returns them as
   `manual-launch` options, after every option FLUJO can install by itself.
2. **The command is shown, never executed.** The option carries `runLine` — the
   exact command line — rendered with a copy button in the install-option
   picker. FLUJO does not spawn it.
3. **The URL is resolved and verified.** `resolveTransportUrl()` substitutes the
   registry's `transport.url` template and validates the result.
4. **"Configure as remote"** hands a normal `streamable`/`sse` config, with the
   `launch` spec attached, to the Configure & Test tab. It can be saved. The
   Configure tab shows the launch command read-only with a "start it yourself"
   note.

## URL template resolution

Registry entries template their endpoint against their own declarations:

- `{DEVICESHELF_API_PORT}` binds against **environment-variable names**;
- `{--host}` / `{--port}` bind against **named-argument names**.

Both resolve `value ?? default`. `argumentsToTokens()` flattens named arguments
into a token vector (`['--port', '8088']`) and necessarily loses the name→value
map, so `argumentBindings()` is a **sibling** that preserves it — the token
function is unchanged.

### Loopback-only is a security rule, not a nicety

After substitution the URL is parsed and **any host that is not loopback is
rejected**: only `localhost`, `127.0.0.0/8` and `::1` are accepted, over
`http:`/`https:` only.

A scan of live registry data found publishers templating this field to *public*
endpoints (for example `https://mcp.crawlconsole.com/mcp`) from an npm package.
Without this filter FLUJO would eventually start a local process while pointing
a config the user believes is local at a third-party endpoint. Rejected entries
fall back to the ordinary remote path, which carries the marketplace trust gate.

Resolution failures are surfaced, not swallowed:

| `urlError` | Meaning |
|---|---|
| `missing-url` | the package declares no `transport.url` |
| `unresolved-placeholder` | a `{…}` placeholder had no binding |
| `invalid-url` | not a parseable `http(s)` URL after substitution |
| `non-loopback` | resolved to a host FLUJO refuses to treat as local |

## Where this lives in the ServerModal

The modal is five acquisition sources funnelling into one configure-and-verify
sink:

```
Spotlight ─┐
Marketplace┤
GitHub     ├──► ConfigureTab (Define → Build → Run → save) ──► store
Reference  ┤    (the ONLY place a config is finalised & verified)
Remote    ─┘
```

Launch-and-connect deliberately adds **no seventh tab**. It lands in the sink
and in the config model. Two supporting refactors came with it:

- `useRegistryInstall` + `InstallOptionPicker` — one shared registry install
  pipeline for Spotlight and Marketplace, with their genuine differences
  (`requireTrust`, curated `envDefaults`) kept as explicit options.
- `TabHandoff` — one typed message (`{ to: 'configure' | 'github', … }`) owned
  by `ServerModal`, replacing the ad-hoc `setActiveTab` / `autoTestRun` /
  `onOpenInGitHubTab` prop trio that every tab had to implement.

The sink was renamed `LocalServerTab` → `ConfigureTab` (`ServerSetupTab` member
`'local'` → `'configure'`): it owns `serverUrl`, `HeadersEditor`,
`OAuthCredentialsEditor` and the Roots/Sampling/Elicitation policies for *every*
transport, so "Local" was actively misleading — a user entering a hosted URL in
**Remote** was dropped onto a tab labelled **Local**. Note that
`MCPServerSource = { type: 'local' }` is *not* renamed: that is persisted
install-origin metadata.

## Consumers that must not half-support `launch`

Anything that would silently drop the spec fails loudly instead:

- **Package export** (`buildPackage.ts`) rejects a launch-and-connect server:
  the package format cannot carry a launch command, and exporting an endpoint
  nobody starts would be worse than refusing.
- **Headless registry install** (`registryInstall.ts`) never selects a
  `manual-launch` option and aborts if a built config carries `launch`.
- **The MCP assistant** (`assistedInstall.ts`) excludes these options from its
  candidates — its approve-and-install flow cannot start the process for you.
- **Claude export** (`claudeFormat.ts`) omits `launch` deliberately: it is
  FLUJO-specific lifecycle metadata with no Claude equivalent.

## Deferred: FLUJO owning the process (Phase 2)

Actually spawning the child is a subsystem, not a feature, and is gated on
observed demand (~6 genuine registry entries, ~1.6% of packages). It needs:

1. a launch registry (`Map<serverName, ChildProcess>`) beside the client map;
2. readiness polling of `serverUrl` until `readyTimeoutMs`, streamed through the
   existing NDJSON test-connection channel so a failed `docker run` is a real
   error and not a bare timeout;
3. teardown on disable / delete / **app exit** — the codebase has no
   SIGINT/SIGTERM handlers at all today, so this is new infrastructure;
4. orphan reaping on restart (persist PID / container name, reconcile at start);
5. port-collision detection with a distinguishable error;
6. post-connect liveness: a launched-remote is both "spawned child" and
   "retryable remote", which current reconnect logic assumes are exclusive;
7. a Launch accordion in `ConfigureTab`.
