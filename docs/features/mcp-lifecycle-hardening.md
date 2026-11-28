# MCP / Bash runtime lifecycle hardening (issue #413)

FLUJO's runtime used to grow monotonically: MCP servers were forked at startup and
never closed, their descendants outlived them, Bash sessions outlived the run that
started them, and every conversation a process ever touched stayed in memory. This
document describes the primitives that bound each of those.

## 1. Process-wide MCP lifecycle coordinator

`src/backend/services/mcp/lifecycleCoordinator.ts` owns one global registry of
runtime records keyed by workspace + server name (a server name is only unique
within a workspace, #406). A record carries state (`cold` / `starting` / `warm` /
`stopping` / `error`), generation, config fingerprint, the shared connect and
teardown promises, retry/failure counters, lease and pin counts, and timestamps.

Two chokepoints:

- `beginConnect(server, attempt)` — folds concurrent callers onto ONE attempt and
  awaits any pending teardown first. This replaces `MCPService.inFlightConnects`
  as the authority: that map was *instance*-local, so two Next.js module
  instances could each believe they were the only connector and fork two child
  trees for one config.
- `beginTeardown(server, reason, close)` — one idempotent, awaitable teardown used
  for handshake failure, fatal transport error, reconnect replacement,
  disable/delete and shutdown. Overlapping "close it" requests fold onto the same
  promise instead of racing into a double close.

`isStaleGeneration(server, generation)` lets a captured callback or lease detect
that it belongs to a superseded runtime.

## 2. Descendant-aware, verified teardown

`killProcessTreeAndWait()` (`src/utils/process/killProcessTree.ts`) is the awaitable
counterpart of `killProcessTree()`: tree kill (`taskkill /T /F` on Windows,
negative-pid `SIGTERM` on POSIX), wait, `SIGKILL` on POSIX, wait, then report
`{ exited, forced, durationMs, pid }`.

`safelyCloseClient()` keeps the graceful path first (close stdin, wait), then
escalates through the tree killer instead of `child.kill()`. Most stdio servers
run behind a shell / `npx` wrapper, so signalling only the immediate child left
the real server and anything it spawned running as orphans. The function now
returns a `SafeCloseResult` so teardown is verifiable rather than assumed.

`MCPService.disconnectAll(reason)` tears down every live connection, clearing retry
timers first so a pending retry cannot re-fork a server mid-shutdown.
`shutdownBackendServices()` in `src/backend/init.ts` runs it for every workspace and
is armed on `SIGINT`/`SIGTERM`/`SIGHUP` (POSIX) with a 20s cap before force exit.

Cleanup of a sandbox and its authority never blocks the event loop (#1423). When a
server stops by itself, the MCP SDK reports it synchronously, so its cleanup
(container removal, control folder, bundled workload token files) starts in the
background and its token is refused at once. A new launch of the same server
waits for that cleanup (up to 30 seconds for the token files, then it goes on,
because the old token is already refused) and retries one that failed, so a
failure heals on the next launch. `shutdownBackendServices()` finishes every
cleanup still running, and retries failed ones, before the process exits.

If FLUJO itself crashes, no cleanup can run, and the stopped container keeps the
server's name. The next start of that server removes such a stopped leftover and
its control folder (the container carries the folder name in the
`co.flujo.mcp-control` label). It removes without `--force`, so Docker refuses a
container that is still running, and a live owner's sandbox is never touched.
A start refused because another container holds the name removes its own control
folder. `__tests__/mcp/sandboxShutdownPaths.test.ts` drives normal exit, Ctrl+C,
a crashed server, a crashed FLUJO process and a restart through these paths with
real processes.

### Stdio runtime-home isolation is opt-in

Ordinary stdio MCP servers use the host home and configured environment by default.
Each server can opt into a private per-workspace home under
`userdata/mcp-runtime/` with its own Runtime home setting. Isolation redirects conventional home, configuration,
cache and temporary-directory variables, so it can prevent an MCP server from
discovering credentials and tools stored in the host profile. It can also make a
server appear newly installed or signed out, which is why it is not the default.

The server's own Runtime home setting decides: isolated or host home. There is
no process-wide switch and no workspace-wide switch. A workspace that used the
old workspace-wide switch gets `isolated` written into its stdio servers the
first time it is used.

Changing a server's setting takes effect when that stdio server is
next connected. The bundled Bash server is deliberately exempt: it remains
attached to the live host account because it is FLUJO's host-terminal boundary.

### Coordinated sibling change

The separate `mcp-vscode-mcpapp` repository owns its own CLI/runtime teardown
(`shutdownOnce(reason)` in `src/cli.ts`, awaitable OpenVSCode teardown,
tree-aware termination in `src/core/process.ts` and `src/core/terminal.ts`). It is
not a FLUJO submodule, so it ships as a separate change; FLUJO owns the client
boundary and the end-to-end assertions.

## 3. Run-owned Bash sessions

`src/backend/services/mcp/ownerScope.ts` derives ONE canonical owner key per run:
`run:<runId>`, falling back to `conversation:<conversationId>` only where no
distinct run id exists. It is used by `ModelHandler`, the Codex adapter and the
Claude subscription adapter, which previously disagreed (two passed no owner at
all), so a single run's sessions could land under three different owners and none
of them were releasable.

In the Bash server (`mcp-servers/bash/src/tools.ts`):

- `releaseOwnerScope(scope)` atomically removes and tree-kills every
  **non-detached** background and PTY session of a scope. It is exposed as the
  `release_owner` tool (scope is host-derived from `_meta.flujo.ownerScope`, never
  a tool argument, so a caller can only release its own sessions) and FLUJO calls
  it from the run's terminal path.
- `detached: true` (alias `persistAfterRun`) is the explicit opt-in for surviving
  a run. Cancelling `wait` still does not kill a session — that documented rule is
  unchanged.
- Caps: the existing per-owner limit, plus a **host-wide** live cap across
  background and PTY sessions (`FLUJO_BASH_MAX_LIVE_SESSIONS`, default 50). A
  per-owner cap alone could not bound a machine running many concurrent flows.
- Expiry: idle timeout (`FLUJO_BASH_SESSION_IDLE_MS`, default 1h) and an absolute
  lifetime ceiling (`FLUJO_BASH_SESSION_MAX_LIFETIME_MS`, default 12h), enforced by
  an unref'd 60s sweep. Detached sessions are exempt from idle expiry but NOT from
  the lifetime ceiling.
- The server entrypoint now shuts down on stdin `end`/`close` and MCP session
  close as well as signals. stdio EOF is the convention a host uses to ask for
  shutdown, and a host that then dies never sends a signal at all — without an EOF
  path the Bash server outlived its own host.

## 4. Lease-based lazy MCP pool

`src/backend/services/mcp/mcpLeasePool.ts` replaces "connect everything at
startup" with acquire-on-use:

- `acquireLease(backend, server)` connects a cold server on demand and returns a
  lease whose `release()` is idempotent (always call it in `finally`).
  `withLease()` wraps that shape.
- `lease.isStale()` reports a config-generation replacement, so a holder can never
  keep using a client that is being torn down.
- `pinServer(server, pin)` / `unpinServer` model demand that outlives one call:
  subscriptions/triggers, MCP App sessions, remote tasks, always-on config.
- `sweepIdleServers()` closes warm servers idle for more than 10 minutes (fixed)
  and `enforceWarmCapacity()` evicts the LRU **idle** server past the warm-server
  limit. The limit scales with memory: one server per 2 GiB, between 2 and 16.
  Neither ever warms a cold server, and neither considers a leased or pinned
  record.

`MCPService.callTool()` holds a lease for the whole call, so an in-flight tool call
can never have its server closed underneath it. `startEnabledServers()` supports
lazy start (**Settings > Tool server startup** only), which discovers configuration without warming anything except always-on
servers. It defaults **off**: eager startup may only be retired once every consumer
acquires a lease before use. Always-on is set per server on the same settings page.

## 5. Bounded conversation state

`src/backend/execution/flow/conversationStateCache.ts` keeps
`FlowExecutor.conversationStates` as the single live registry (dozens of call sites
read it directly) and adds the bookkeeping around it:

- A conversation becomes evictable only via `markTerminal()`, which **persists
  first**. If persistence fails the entry stays non-evictable, so a storage fault
  can never trade bounded memory for a lost transcript.
- Running / awaiting-approval / paused-debug / recovery-owned states are never
  candidates, and every eviction re-validates the live state first.
- Bounds: TTL (30 min), entry count (200) and an approximate byte budget
  (64 MiB), with LRU eviction among terminal entries only. These are fixed
  defaults; only tests can change them.
- `coalesceLoad()` collapses concurrent durable loads of one conversation id, so
  several control routes missing at the same instant perform one storage read, log
  replay and dangling-tool repair rather than N racing ones.

Eviction is invisible to callers: `loadConversationState()` transparently reloads
from the durable snapshot (log replay, recovery reconciliation, tool repair, cache
adoption).

## 6. Diagnostics

All three subsystems expose bounded, payload-free snapshots:

- `mcpService.getLifecycleReport()` — runtime states, generations, lease/pin
  counts, idle duration, connect/handshake failures, forced kills, teardown
  latency, plus pool counters and limits.
- `bashSessionDiagnostics()` — sessions by owner/type/state/detached, with age and
  idle time. Never includes command output.
- `getConversationCacheDiagnostics()` — entries, estimated bytes, hits, misses,
  evictions, reloads, coalesced loads, persist failures.

None of these record process output or provider payloads, and all retention is
bounded by the caps above.
