# Hot-clone workspace snapshot control plane

FLUJO exposes a small local control plane for the `flujo-cloud` proof of concept.
It captures one selected workspace while FLUJO remains online, then makes the
archive available for an external bridge to encrypt, transfer, restore, and run.

This repository does not provision cloud resources or expose a remote worker
protocol. Fly lifecycle, encrypted transport, private tunnelling, remote
`/v1/chat/completions` forwarding, and teardown belong in the separate
`flujo-cloud` bridge.

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

Responses use `Cache-Control: no-store`. Download re-hashes the staged archive
before returning bytes.

## Snapshot contents and coherence

The archive contains `.workspace.json` when present, all
`WORKSPACE_SUBTREES`, and `snapshot-manifest.json`. The manifest records the
workspace layout version, generation, member paths, sizes, and SHA-256 hashes.

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
