# Local official application image acceptance

Date: 2026-10-09. Related issues: #700 and #570. The repository's actual
Dockerfile was built once for Linux/amd64. This extends the earlier
[synthetic init evidence](2026-10-09-container-init-lifecycle.md) with genuine
FLUJO startup, authenticated readiness and Next cleanup observations.

## Retained identities

- Application source: `10617c425c9ca061b6154262ef1f140016167ac4`.
- Package version: `3.46.3`.
- Local image configuration ID:
  `sha256:7b8fc0b3048dc7c84015f15e223f2718616563a66dcbb820a81bcb1a675a4ca6`.
- Host probe source: `bf762dbef8b37ba31762de848f61b50db69b5646`.
- Executed host probe SHA-256:
  `441e6d099d2ba8e2bc397cbc816c3d343c654f28bffbd669daf1b840d56b136f`.
- Owner issuer source SHA-256:
  `1f617e639f05341ba1d5ea17b16dd8b21b74de49d7e41ca8060072cbd3895075`.
- Image's compiled issuer SHA-256:
  `020062c944ff3e1e2e1d4c6e37265a3f0501e6671e5a0796f1bb540954f4ac42`.

Host-only probe and documentation corrections followed the frozen application
build. The application, lockfile, Dockerfile and runtime modules were unchanged
between these revisions. The image revision remains the application source
above; it is not the later host-probe or evidence commit. These are local
identities, not signed registry provenance or a manifest digest.

The host ran Windows, Node 24.19.0 and Docker Engine 29.6.1. Both Docker stages
used the pinned official Node 22.23.3 Bookworm image and passed the existing
exact-binary verification. Debian installed Tini `0.19.0-1+b3`. The actual
production build compiled all five bundled MCP workspaces, passed TypeScript
and generated all 130 Next 16.4 pages. Dockerfile checking reported no warnings.
No additional local application build or dependency version change was made.

## Genuine application rows

Both rows used the same immutable image ID. The actual default entrypoint,
launcher command and image healthcheck remained unchanged. Each row used UID
1000, a fresh private profile, no network, mounts or published ports, dropped
capabilities and no new privileges. Owner policy hashes were seeded before
startup with preserved ownership and private permissions, then compared by UID
1000. The short-lived bearer and USER passphrase were never command arguments
or exported evidence.

| Application row | Image Tini / launcher / Next PIDs | Exec-origin orphan adopter | SIGTERM result |
| --- | --- | --- | --- |
| Default | 1 / 7 / 14 | Image Tini PID 1 | 143, 149 ms, no OOM |
| Docker outer init | 7 / 8 / 15 | Docker init PID 1 | 143, 256 ms, no OOM |

Process receipts verified UID, PPid, SID, PGID and start identity. Both rows
required HTTP 423 before initialization, and a silent healthcheck exit 1 both
before initialization and while initialized USER storage remained locked. Passphrase authentication made
the genuine healthcheck CLI exit 0; missing and wrong owner credentials still
returned silent exit 1. Docker's own health status became healthy.

The independent exec fixture's direct parent exited with a zero-exit receipt
and disappeared. Its live descendant retained its start identity after adoption,
then recorded listener closure and zero exit before its proc entry disappeared.
FLUJO remained healthy throughout, while detached and shared-group controls kept
their identities and received no SIGTERM during the reaping sequence.

Both genuine application shutdowns produced ordered Next
`next:start-server` cleanup-start and cleanup-finished markers, absent before the
signal. Shutdown completed before the launcher's ten-second SIGKILL fallback.
This demonstrates that Next's cleanup handler reached completion, rather than
inferring it from container exit alone. Next catches some cleanup errors
internally; the finished marker does not prove every cleanup operation was
error-free. Namespace termination does not independently measure a host port.

## Init controls on the same image

The inherited init probe overrides the command with its synthetic listener. All
three rows passed against the same actual application image bytes:

| Synthetic command row | Live adopter | Descendant after controlled exit |
| --- | --- | --- |
| Direct Node PID 1, expected-zombie | Node PID 1 | Same-identity `Z` |
| Default Tini | Image Tini PID 1 | Absent proc entry |
| Outer Docker init | Inner image Tini PID 7 | Absent proc entry |

The nested synthetic fixture is a descendant of the inner Tini, so it qualifies
subreaper ancestry. The genuine application's exec fixture starts outside that
tree and correctly adopts namespace PID 1. These are different process origins.
All synthetic rows required UID 1000, direct-parent reaping, closed listener and
independent detached/shared-group controls preserved through held cooperative
shutdown. The synthetic main exited zero after its shutdown gate was released.

The real lost-create-reply fault probe also passed, recovering the exact owned
container through its ownership label, verifying its image/full ID and removing
it. Normal application profiles and all owned test containers were removed
before successful receipts were reported. No foreign container was stopped.

## Review and remaining acceptance

Source syntax, changed-script ESLint, diff checking and ten embedded-program
syntax checks passed. The selected workflow/runtime/release/security, health
and bootstrap checks passed all 245 tests with no skips on supported Node
24.19.0. The initial shell selected unsupported Node 22.13.1; four launcher
checks correctly refused it, then passed unchanged with the supported runtime.

Review corrected an exec-origin ancestry assertion and a live policy truncation
race before the final rows. The first application probe mistook Tini's launcher
argument for the launcher itself. The actual process tree was correct; the
executable selector was fixed and both rows passed on fresh profiles without
rebuilding. That failed container also completed Next cleanup and exit 143,
then was removed; its redacted diagnostic was retained separately before its
private fixture was safely removed.

This is not an authored Flow, provider or managed-worker launch test. Expected
`HOST_CONSENT_REQUIRED` refusals occurred for unapproved bundled MCP host
execution; authenticated HTTP readiness does not imply permission to execute
those tools. Actual worker/provider shutdown and recovery, Compose installation,
registry publication/signatures, OS vulnerability resolution and independent
operator deployment acceptance remain separate work. Issues #700 and #570 stay
open, and the pending default must reach main before an official release uses it.

The local build and full row receipts are retained under
`C:/Users/Moe/.codex/tmp/flujo-official-container-*.log`, with the immutable ID
in `flujo-official-container-image.id` and the redacted first-fixture diagnostic
in `flujo-official-container-fixture-failure.json`. Follow the reproducible
commands in [container distribution verification](../container-distribution-verification.md).
