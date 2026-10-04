# Production scorecard: filesystem findings

This is source remediation and review evidence for PR #611. It does not dismiss
alerts, change query configuration, or establish the A- production acceptance.
The starting analysis is JavaScript/TypeScript analysis `1887239452`, merge
commit `d29fbd24355c741bbc5b9064d990fe03fbb2b993`. Its SARIF was read directly
from GitHub. The implementation starts from integration source
`a9a974a10c543dafdcc5683f57b3c747514ee5a4`; these are different pins.

| Alert | Original location | Change / review disposition |
| --- | --- | --- |
| [186](https://github.com/mario-andreschak/FLUJO/security/code-scanning/186) | `scheduler/workerLocalRecovery.ts:139` | Preserve the checked inode, signed generation, epoch, snapshot digest, and enrollment rules. Read from an admitted descriptor, with a size-based allocation bounded by the existing 8192-byte limit. Repeat private-parent containment checks. |
| [188](https://github.com/mario-andreschak/FLUJO/security/code-scanning/188) | `workspace/snapshotArchive.ts:131` | Preserve workspace metadata containment and inode checks. Bound allocation before reading and reject file/parent replacement or growth before adding metadata to the archive. |
| [189](https://github.com/mario-andreschak/FLUJO/security/code-scanning/189) | `workspace/snapshotRestore.ts:228` | Read bootstrap credentials through the verified descriptor, retain the 4096-byte and POSIX owner-only limits, and recheck every parent within the workspace. The v1/v2 key parser remains authoritative. |
| [190](https://github.com/mario-andreschak/FLUJO/security/code-scanning/190) | `workspace/snapshotRestore.ts:256` | Read the archive from its admitted descriptor within the existing archive limit. Reject hard links and changes during reading. SHA-256, encrypted envelope, member/manifest integrity, staging, and publication checks remain in place. |
| [191](https://github.com/mario-andreschak/FLUJO/security/code-scanning/191) | `workspace/snapshotRestore.ts:322` | Read restart markers from the descriptor admitted against the checked inode, with the existing 4096-byte limit and workspace-parent rechecks. A matching marker still requires credential validation. |
| [192](https://github.com/mario-andreschak/FLUJO/security/code-scanning/192) | `utils/storage/backend.ts:582` | Replace pathname shard reads with descriptor reads, preserving collection/Persona/record identity parsing and directory rechecks. Related single-record reads use the same descriptor checks. No new product record-size quota is imposed. Allocation cannot grow past the admitted file size plus one byte. |
| [163](https://github.com/mario-andreschak/FLUJO/security/code-scanning/163) | `snapshot/snapshotLock.ts:90` | Create a private random candidate directory and exclusive 0600 owner file before publishing the complete directory. Use UUID generations and the canonical process-birth identity. Serialize publication and retirement through the existing workspace runtime lock and revalidate the observed generation under its ownership fence. Missing/partial ownership is busy. Cleanup moves the admitted generation to a unique tombstone and removes only known files; it never recursively removes an uncertain pathname. |
| [155](https://github.com/mario-andreschak/FLUJO/security/code-scanning/155) | `fixtures/personaProcess.cjs:51` | Replace the predictable machine-wide executable cache with a private parent-allocated cache per test run. Preserve sharing among the run's children. Validate cached file descriptors, reject links and changes, and publish freshly compiled output through random exclusive 0600 temporary files. Unsafe cache entries are misses. |
| [254](https://github.com/mario-andreschak/FLUJO/security/code-scanning/254) | `utils/storage/backend.ts:149`, data argument | Candidate intentional persistence / false positive; independent review is pending. The exact SARIF flow is explained below. Atomic-write hardening is useful independently and is not evidence that this dataflow concern disappeared. |

## Exact dataflow for alert 254

The SARIF starts at `packageRegistryClient.ts:88` (`fetch`), through
`response.text()` and parsed registry-response JSON. Its four displayed flows
carry signup/login confirmation `email`, refresh `publisherHandle`, OAuth
`isConfirmed`, and computed `expiresAt` values into `registry/index.ts` account
persistence. `persist` calls
`saveItem(StorageKey.REGISTRY_ACCOUNT, account)`; `saveItem` computes the path
from that fixed storage enum in the current workspace and serializes the account
with `JSON.stringify` before passing it as **contents**, not a path, to the
atomic writer. Remote `path`/`filePath` fields are not selected into the account.

The regression sends traversal-shaped text and script-like text as the remote
email and adds remote path fields. The account remains JSON at the fixed account
key; remote path fields are absent and no alternate destination is created.
This service-level test does not establish HTTP authentication or registry
response-schema completeness. Those remain their owners' boundaries. A scanner
refresh that loses the result because the sink moved to `FileHandle.writeFile`
would not itself resolve the review disposition.

## Evidence and limits

Focused tests exercise actual temporary files, controlled inode replacement,
growth after admission, hard links, junction/symlink parents, exclusive-write
collisions, Windows rename retries, stale/successor generation separation, and
the production readers' refusal paths. A Windows source-loaded process test
starts two owned fixture children, observes the contender waiting, kills and
awaits the first child, and observes takeover and subsequent release. It uses
the real canonical runtime lock/process identity implementation. It is not an
installed-package, Linux, paid-model, operator, or descendant-exit acceptance.

The small lock tests mock process identity/transition ownership to control the
interleaving; they do not independently prove the canonical lock implementation.
The private-cache tests use a synthetic compiler; the process check loads the
real fixture and compiler. Full integration typecheck/build and a fresh scan of
the assembled candidate are coordinator checks. No result here grants a grade
or supports public/shared-user deployment.

At the retained PR #648 source slice, nine focused filesystem suites pass 104 assertions with
one POSIX-only case skipped on Windows. The cache fixture passes four assertions
with one POSIX-only case skipped. The selected real process test passes; its
seven unrelated tests were not selected. Scoped lint passes for the 17 touched
TypeScript files. Removing only the caller-checked descriptor identity guard
causes seven boundary assertions across five suites to fail (exit 1); the helper
is then restored byte-for-byte. The retained evidence records raw results and
source/log digests, separately from any future integration scan.

## Exact filesystem identity follow-up

Numeric `Stats` can collapse distinct filesystem identities or timestamps to
the same JavaScript number. Admission snapshots, descriptor/path rechecks,
archive traversal, private compiled-code caching, atomic publication and owned
cleanup now use `BigIntStats`. They compare device/inode IDs and nanosecond
timestamps directly. Callers pass exact snapshots to `readPlainFile`; converting
those snapshots to numbers would undo that protection.

Only bounded buffer sizes, serialized permission bits and legacy display/index
metadata are converted to numbers. Those values do not authorize a file read,
publication or deletion. Snapshot lease publication binds its initial private
directory and opened owner file before rename, checks the published generation,
and preserves an unowned candidate on failed cleanup. Release also binds the
original admitted directory, even when a replacement has identical owner bytes.

The follow-up passes 121 assertions across ten scoped filesystem suites, with
one POSIX-only case skipped on Windows; the cache passes eight, with one POSIX
skip. Coercing only identity comparisons to `Number` makes twelve assertions in
four filesystem suites and four cache assertions fail. All five mutated files
are then restored byte-for-byte. The selected real Windows two-child lease test
also passes after owned process death and takeover; seven other process tests
are not selected. It uses source-loaded fixtures, not an installed distribution.
A small check against real Node/Jest types and
the ES2017 target passes for the reader and two test files; it stubs the snapshot
implementation import and is not a full application typecheck.

PR #648's recorded build/typecheck failures remain part of the evidence. PR #657
separately fixes the absent-owner guard and overloaded read-spy type contract;
its hosted typecheck passes at `7a405701626b294bd2158f38a1f595da717172dd`.
Its Linux production-build job passes, while the Windows job fails installed
startup readiness after migration reports `Snapshot storage is temporarily busy`.
That prerequisite does not qualify this later bigint source. Fresh combined
typecheck/build/scanning, independent review and the acceptance gates above
remain required.

## Closed owner-record admission

[Microsoft's file-time contract](https://learn.microsoft.com/en-us/windows/win32/sysinfo/file-times)
guarantees finalized write timestamps after the writable handles close. A
snapshot candidate previously carried its still-open writer's timestamps into
a later read. The candidate now binds the closed pathname snapshot to the exact
descriptor device/inode, mode, UID/GID and single-link ownership, and checks its
size against the authored bytes. Only then can the closed timestamps become the
reader's expected snapshot. Exact descriptor/path/timestamp checks remain in
`readPlainFile`; the candidate's bytes and published digest must also match the
original owner record, with the transition fence rechecked before rename.

Admission errors carry only a bounded predicate name such as `expected:ctimeNs`
or `descriptor-path:ino`. They include no path, filesystem identity value,
owner bytes or credential. This makes a refusal diagnosable without weakening
it or accepting a new pathname snapshot on its own.

The delayed-close timestamp test is a controlled platform-contract fault case.
Six native local Windows samples showed no metadata drift and did not reproduce
the hosted failure. The recorded hosted `a6273e32` failure is
`SNAPSHOT_STORE_BUSY`; the later `85644435` and current `6390bc01` failures are
`PlainFileReadError/UNSAFE_FILE`. A strict-environment local installed run of
`6390bc01` passes, on a different Windows version. None of these observations
proves the cause of the hosted mismatch or qualifies this later source. The
next exact compiled Windows run must retain the predicate and its result.

These paths operate in an owner-private data-root/OS profile with cooperating
FLUJO writers. Descriptor checks and canonical fences are not an OS sandbox:
Node does not provide portable descriptor-relative rename/unlink. A hostile
process with the same filesystem privileges remains outside that profile.
Windows chmod does not verify NTFS ACL isolation. POSIX-only permission/leaf-link
cases must run on Linux before being accepted there.

Snapshot-store transitions are coordinated in the selected workspace, matching
the normal workspace snapshot root. Cross-workspace migration requires the
existing quiesced migration boundary; this change does not establish arbitrary
shared-root multi-user locking. Mixed-version live writers are unsupported.
Malformed/partial legacy locks, interrupted retirement claims, and unexpected
tombstone entries remain fail-closed for operator investigation. Candidate or
tombstone debris is not proof that an owner exited. Do not delete it while a
writer may still be active.

The helper preserves PR #622's protection against growth of worker recovery
files after stat. If integration also applies #622, reconcile its read-loop hunk
with this shared descriptor reader; do not restore `readFile()` allocation.
