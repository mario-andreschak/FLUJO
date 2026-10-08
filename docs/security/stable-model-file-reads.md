# Stable model catalog and credential reads

This source correction addresses the pathname/content-read races reported in
CodeQL alerts [184](https://github.com/mario-andreschak/FLUJO/security/code-scanning/184)
and [179](https://github.com/mario-andreschak/FLUJO/security/code-scanning/179).
It also applies the same bounded read primitive to Codex host configuration,
the FLUJO credential-source marker, and the host/worker authentication snapshots
used for synchronization and transfer. Fresh integrated scanning must confirm
the resulting finding disposition; no dismissal or rule weakening is included.

`readStableFile` opens one resolved file descriptor with `O_NOFOLLOW` where the
platform supplies it, validates a regular file and its size, loops through short
reads, reads at most the admitted size plus one byte, and closes in `finally`.
Before accepting the bytes it compares descriptor and pathname identities:
device, inode, size, modification/change timestamps, mode, owner/group and link
count. Identities use exact bigint values and nanosecond timestamps, avoiding
Windows file-ID rounding beyond JavaScript's safe integer range. It verifies
the requested and resolved names again, rejecting replacement,
retargeting, growth, truncation or identity drift. This provides an accepted
snapshot; it does not freeze the source after the descriptor closes.

Limits remain 16 MiB for the pinned restricted catalog, 8 MiB for passive model
hints, and 1 MiB for Codex authentication/configuration. The small FLUJO source
marker is limited to 4 KiB. Symlink compatibility remains explicit only for
operator-owned host `config.toml`; pinned catalogs, model hints, markers and
authentication files reject leaf symlinks. Host configurations with keyring or
auto stores still fail their existing authority check. Missing versus unreadable
host configuration remains distinct. Errors are projected into existing fixed
reason codes/messages or empty hint results, without exposing file contents.

The restricted profile's admitted CLI versions (0.153.3 and 0.157.1), approved
models, exact binary/catalog digests, native tool fences, read-only/no-network
thread settings and credential-before-runtime ordering remain unchanged. This
patch does not admit CLI 0.158, alter ordinary provider behavior, or establish a
native CLI attestation. CLI execution still uses its separately checked canonical
pathname; an OS-level atomic executable launch/attestation mechanism is outside
this read-only metadata correction.

Focused tests exercise short reads, each identity field, requested/resolved target
replacement, size drift, read failure cleanup and explicit symlink policy.
Existing source suites preserve host/worker credential selection and catalog
policy behavior. Additional call-site regressions reject catalog descriptor drift
before CLI/credential access and discard unstable model hints using real owned
filesystem fixtures. Source tests do not establish installed-release behavior,
other-platform filesystem behavior, live authentication, independent acceptance,
or a completed Security grade. Full graph type/build and scan qualification stay
with the release coordinator.

At base `d6ffb0b29ec7abaf3c8e57d85aa35bb36e29019b`, the final focused run
passed 87 tests across six suites on Windows with Node 22.13.1 and locked Next
16.3.8 dependencies. The helper and its unit tests passed a scoped TypeScript
check with installed Next ambient declarations. Changed-file ESLint and diff
checks passed. Full caller-graph type/build verification remains pending.
The first added catalog-drift regression failed because its numeric inode
increment rounded to the same Windows file ID. A local stat probe confirmed an
unsafe integer ID (`15762598705936816 + 1` was unchanged). The implementation
now uses bigint identities, and the controlled test replaces the observed
identity with zero rather than a floating-point increment. An initial scoped
check also caught bigint test literals under the repository's older compilation
target; fixtures now use `BigInt(...)` without changing the target. These failed
qualification runs are retained alongside the passing final run.
