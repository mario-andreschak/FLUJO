# Portable cloud workers and workspace snapshots

FLUJO exposes a small local control plane for the `flujo-cloud` proof of concept.
It captures one selected workspace while FLUJO remains online, then makes the
archive available for an external bridge to encrypt, transfer, restore, and run.

FLUJO owns capture, verified restore, credential setup, dependency installation,
and execution through its existing `/v1/chat/completions` and ExecutionEngine.
Fly lifecycle, encrypted transport, private tunnelling, call forwarding, and
teardown belong in the separate `flujo-cloud` bridge. No cloud SDK is added here.

## Enable the control plane

Set a high-entropy token before starting FLUJO:

```text
FLUJO_SNAPSHOT_CONTROL_TOKEN=<random secret>
```

The endpoints require both:

- a strict loopback request while FLUJO is in localhost exposure mode; and
- `Authorization: Bearer <token>`.

The token is never returned by an endpoint or stored in an archive. Snapshot
archives are staged in an owner-only temporary directory and removed by
`finalize`, `abort`, expiry, or a failed integrity check.

Optional limits:

- `FLUJO_SNAPSHOT_SESSION_TTL_MS` defaults to 15 minutes and is capped at one hour.
- `FLUJO_SNAPSHOT_MAX_FILE_BYTES` defaults to 256 MiB per file.
- `FLUJO_SNAPSHOT_MAX_BYTES` defaults to 1 GiB of uncompressed workspace data.
- `FLUJO_SNAPSHOT_CAPTURE_TIMEOUT_MS` bounds the managed write pause to 30 seconds
  by default, at most 60 seconds, including draining current writers. Cancellation
  releases the pause immediately; it does not wait for filesystem I/O to finish.

A limit or unsafe filesystem entry fails the snapshot closed.

## API

Every request accepts the normal `?workspace=<name>` selector or
`x-flujo-workspace` header.

1. `GET /api/snapshot/info` reports capability and the active session.
2. `POST /api/snapshot/begin` starts capture and returns `202` with a session ID.
3. `GET /api/snapshot/status?sessionId=<id>` is polled until `state` is `ready`.
4. `GET /api/snapshot/download?sessionId=<id>` returns the ZIP. Verify the
   `X-Flujo-Snapshot-Sha256` header before restore.
5. `POST /api/snapshot/finalize?sessionId=<id>` removes a successfully transferred archive.
6. `POST /api/snapshot/abort?sessionId=<id>` abandons the operation and removes staged data.

`begin` optionally accepts `{"flowIds":["exact-flow-id"]}`. The existing package
resolver follows static subflows, model bindings and MCP references. The captured
MCP configuration disables unrelated servers; source settings stay unchanged.
Required missing/disabled dependencies and dynamic subflow selection fail clearly.
Without this selection, all configured servers are considered. This is dependency
selection, not a data-export filter: other workspace records are still preserved.

Responses use `Cache-Control: no-store`. Download re-hashes the staged archive
before returning bytes.

## Snapshot contents and coherence

The version-2 archive preserves FLUJO's JSON/sharded records and JSONL conversation
logs, including model/flow/MCP names and IDs, credentials, and conversations. The
manifest records the FLUJO version, layout, generation, member sizes/hashes,
portable MCP installation recipes, and required authentication mode. Restore
requires the same FLUJO version and layout, plus an independently supplied archive
SHA-256. Use an immutable image digest built from the corresponding FLUJO code.

MCP installations, `node_modules`, Python virtual environments, browser profiles,
and `userdata/mcp-runtime` are omitted and reconstructed where supported. Codex's
`db/codex-runtime` is omitted except for a selected ChatGPT authentication cache
and its workspace ownership marker. Its SQLite databases/WAL files are not copied;
FLUJO conversation history survives, and the Codex adapter's existing missing-thread
fallback starts a new provider thread from that history. Other SQLite databases in
user data fail capture because arbitrary live SQLite copying is not coherent.

The generation boundary covers registered FLUJO-managed writers:

- JSON and sharded storage writes;
- append-only conversation logs;
- run-resource payload/index changes and derived hard links; and
- Git-backed snapshot-store mutations.

New managed writes wait while the current generation's bytes are captured.
Reads continue normally. Compression and archive persistence happen after the
boundary is released.

External roots named by `.workspace.json` are not traversed or copied. Direct
filesystem changes made by programs outside FLUJO are unsupported; unsafe,
symbolic-linked, disappearing, or changing entries fail the capture instead of being
silently omitted. The remote workspace is a fork at this snapshot point; ongoing
or bidirectional synchronization is out of scope.

## Reusing packages

The regular shareable package format intentionally removes secrets, remaps entity
IDs, and adopts same-name MCP installations. Applying it after copying a workspace
would preserve stale executable paths and would not preserve conversation identity.

The worker uses the same package origin mapping and the extracted prepare-only
GitHub/Registry installers, then updates each existing MCP configuration in place.
Bundled MCP servers resolve from the worker image. GitHub Node servers are rebuilt
from the exact clean installed commit. Registry and explicit `npx`/`uvx` commands
keep their package arguments; the worker regenerates host launcher/cwd/root paths.
Remote servers retain transport, headers, environment, OAuth metadata and tool
settings from the private workspace DB. All enabled servers must connect before
worker readiness is reported.

Successful runtime preparation is recorded per server on the worker. Restarting
reconnects prepared runtimes without rerunning Git/Registry installs, so generated
files or an offline package registry do not break an otherwise healthy worker.
Missing runtime files invalidate preparation and cause a rebuild. Failed servers
remain retryable independently.

Custom enabled local executables, local HTTP launch recipes, dirty GitHub checkout
changes, and references to host files outside the copied workspace fail preflight
with an actionable error. Unsupported disabled servers remain disabled. They can
be replaced with a package recipe or hosted MCP endpoint before cloning. An MCP
handshake confirms runtime availability; it cannot prove a third-party service's
stored OAuth token is still accepted for every tool operation. Credentials stored
only in a host keyring or external CLI home need that provider's cloud login/setup.

## Codex subscription credentials

For Codex models with no API key, capture selects the operator's current file-backed
ChatGPT login, even if that model has never run in FLUJO. If FLUJO's child CLI has
refreshed the same login, its newer cache is used. A changed host login selects the
new account; a host logout never falls back to an unmarked stale workspace cache.

The worker marks the imported login as workspace-owned, forces Codex file credential
storage, and preserves CLI refreshes across calls and restarts. Missing cloud
`~/.codex/auth.json` no longer deletes imported auth. Subscription subprocesses do
not inherit `OPENAI_API_KEY`/`CODEX_API_KEY`. API-key models use existing model secrets.

This transfers a login cache, not an independent subscription. OpenAI documents
[file-cache transfer to a trusted headless machine](https://learn.chatgpt.com/docs/auth)
and warns that [concurrent copies can invalidate one another through refresh-token
rotation](https://learn.chatgpt.com/docs/auth/ci-cd-auth). For persistent parallel
workers, sign in separately in each worker's managed `CODEX_HOME`, or use API-key
models. Cache validation at bootstrap does not call OpenAI or prove a token has not
been revoked. Generic Windows/macOS OS-keyring export is not implemented; capture
fails clearly for host `keyring`/`auto` credential storage even if an old
`auth.json` remains. FLUJO uses the unprofiled host configuration; it cannot infer
overrides supplied only to another CLI process.

An unlocked USER-encrypted workspace includes its already-recovered workspace DEK
in an owner-only bootstrap file, so existing FLUJO decryption works unattended on
the worker and after restart. Locked workspaces must be unlocked before capture.
The archive therefore contains sensitive credentials and must be encrypted before
it leaves the local control plane.

## Worker bootstrap

Configure a fresh worker volume before starting the existing FLUJO image:

```text
FLUJO_WORKER_MODE=1
FLUJO_WORKER_SNAPSHOT=/data/workspace.snapshot.enc.json
FLUJO_WORKER_SNAPSHOT_SHA256=<plaintext ZIP SHA-256>
FLUJO_WORKER_SNAPSHOT_KEY=<base64 32-byte AES key>
FLUJO_SNAPSHOT_CONTROL_TOKEN=<worker control secret>
```

The bridge's AES-256-GCM envelope is JSON with `format: "flujo-workspace-encrypted"`,
`version: 1`, and base64 `iv` (12 bytes), `tag` (16 bytes), and `data` fields. If the
key variable is absent, a local plaintext ZIP is accepted for controlled local
bootstrap/testing. Never publish the snapshot, key, or control token in logs.

Restore validates archive paths, aliases, duplicate names, file types, size bounds,
member hashes, version, credentials and layout before publishing the workspace.
Files are owner-only, preserving only the executable bit. Existing workspaces are
never overwritten. A matching restore marker makes process restarts reuse worker
results instead of restoring the original archive again. Host external roots are
cleared. Only the restored workspace is initialized.

Worker mode suppresses scheduler catch-up, Persona dispatch and remote task resume.
It rebuilds the MCP dependencies, verifies connection status, and exposes
`GET /api/worker/status`. States include `restoring`, `locked`, `installing`,
`ready`, and `error`. Worker API/MCP ingress requires the worker bearer token;
execution is rejected until ready. The shipped FLUJO MCP receives this token only
in its child environment for its existing internal HTTP calls.

The cloud bridge should bind a local loopback tunnel to a private worker with no
public service allocation. Invoke existing flows with `/v1/chat/completions`, the
workspace selector and conversation ID. Interactive questions/tool approvals keep
their existing execution-engine policy, with worker requests classified as
unattended internal runs. This does not clone in-flight process memory or resume local
background jobs on the cloud machine.

## Validation

`node scripts/smoke-cloud-worker.mjs` starts isolated real Next instances from a
synthetic encrypted workspace. It verifies bearer protection, restore/readiness,
an actual ExecutionEngine flow using a local mock provider, unattended behavior,
the worker healthcheck, and conversation preservation after process restart. It
does not use a real model account or provision cloud resources.

The focused package tests also start a real rebuilt bundled filesystem MCP over
stdio and write/read a file in the target workspace, verifying the source is
unchanged. A live subscription test should then run the same flow locally and on
the private cloud worker, checking its saved conversation and proof files; this
is what validates the current account and Linux runtime together.
