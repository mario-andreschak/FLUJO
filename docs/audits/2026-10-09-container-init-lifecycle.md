# Local container init lifecycle evidence

Date: 2026-10-09. Related issue: #700. This record qualifies the synthetic
init probe. It does not establish the full official FLUJO image, managed
worker launch or provider/recovery acceptance.

The earlier probe released its descendant after 1.5 seconds, never required
an adoption PPid, and reported configured user without asserting runtime UID.
The revised probe explicitly holds the descendant, observes its original
parent and start identity, then requires live adoption before allowing exit.
It tests non-root execution, detached sessions, actual listener closure,
same-identity zombies, absent proc entries and held graceful shutdown.

## Local image and environment

The host used Node 24.19.0 on Windows and Docker Engine 29.6.1 with Linux
containers. A small init-only image was built from an already local official
Node 24.19.0 Debian Bookworm image, using the same Debian Tini installation
and entrypoint shape as the pending FLUJO Docker change:

```dockerfile
FROM node@sha256:a9f5f7c91a432850b2a8a7797adf5eadb6c733ceed61167806cee7ea7fbc29df
RUN apt-get update && apt-get install -y --no-install-recommends tini && rm -rf /var/lib/apt/lists/*
USER node
ENTRYPOINT ["/usr/bin/tini", "-s", "--"]
CMD ["node"]
```

Debian installed Tini `0.19.0-1+b3`. The resulting local image config ID was
`sha256:9f626271f7896ef056b1418d8150f1162def2953f3f6c8d040f2b316a4d9c27e`.
This image contains no FLUJO application. The probe resolves and uses the
local immutable config ID, with `--pull=never`, no network or host-data
mounts, read-only root, `/tmp` tmpfs and dropped capabilities.

## Actual process results

All three rows passed with runtime UID 1000:

| Command suffix | Live adopter | Result after descendant listener closure and exit |
| --- | --- | --- |
| `--direct-node --expect-zombie` | Node PID 1 | Same start identity remained `Z`, PPid 1 |
| Default image entrypoint | Tini PID 1 | Descendant proc entry absent |
| `--outer-init` | Inner Tini PID 7, under Docker init | Descendant proc entry absent |

Each row also observed the direct parent's zero-exit receipt and absent proc
entry. Detached descendant/control SID and PGID equalled their own PIDs.
The main listener stayed alive after orphan termination. SIGTERM reached the
main process and closed its listener, while independent detached and
shared-group controls retained their live start identities and received no
SIGTERM. The main then
exited with code zero after the explicit shutdown gate. Processes are not
expected to survive exit of the container's PID namespace.

A second local image changed only the entrypoint to `tini --`, omitting
`-s` (config ID
`sha256:d2c59c733849bbdd9da366c637f43a736868aac2a536d00507feed11f1727385`).
Its nested-init row was rejected because Docker's outer init adopted the
descendant instead of the image's inner Tini. Merely observing eventual
reaping by an outer init would therefore not qualify the intended subreaper.
[Tini documents the difference](https://github.com/krallin/tini#subreaping).

A third image enabled process-group forwarding with `tini -s -g --`
(config ID
`sha256:47c7fe68f5012f4459d516ea1d92d97e71377b00cde774e8bc966f190785654e`).
The probe rejected its SIGTERM broadcast because the independent shared-group
control recorded a received signal. The detached control alone would not have
detected that change. [Tini documents immediate-child versus process-group
forwarding](https://github.com/krallin/tini#process-group-killing).

The cleanup fault probe created a real owned container, then injected loss
of the successful Docker creation reply at the host API boundary. The init
probe recovered the full ID through its unique name/ownership label,
verified the immutable image ID and removed that container, preserving the
original injected failure. No owned test containers remained after normal,
negative, rejected-subreaper or lost-reply rows.

```sh
node scripts/test-container-init.mjs IMAGE --direct-node --expect-zombie
node scripts/test-container-init.mjs IMAGE
node scripts/test-container-init.mjs IMAGE --outer-init
node scripts/test-container-init-cleanup.mjs IMAGE
```

## Other validation and limits

Changed-script ESLint, syntax and diff checks passed. The complete selected
workflow/runtime/release/security contract command passed 222 tests with no
skips. An initial run in the new checkout lacked installed `yaml` and
`postcss-selector-parser`; after verifying both package and lockfile hashes
matched the qualified dependency checkpoint, the full selection passed using
those dependencies. No package versions or application modules changed.

This is local fixture evidence, not a registry digest, attestation, deployed
image/source-equivalence claim or full FLUJO shutdown result. Issue #700 must
remain open until an actual built official FLUJO image also passes its
startup, adopted-descendant, managed-worker and graceful-shutdown acceptance.
