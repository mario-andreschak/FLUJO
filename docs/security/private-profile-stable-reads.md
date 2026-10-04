# Private-profile descriptor reads

When an operator passphrase or credential metadata pathname changes during a
read, the reader must reject the content with its fixed diagnostic. The frozen
PR #632 readers used numeric file identities, millisecond timestamps, and
blocking `open(file, 'r')`. A regular file replaced by a FIFO immediately before
that open could block before the regular-file check.

Both readers now use the exact descriptor helper from PRs #649 and #651. One
descriptor owns bounded short reads, with `O_NOFOLLOW` and `O_NONBLOCK` where
available. Admission, descriptor-before/after, requested name, resolved name,
and final target checks compare bigint device/inode/size, nanosecond mtime/ctime,
mode, uid, gid and link count. The descriptor closes in `finally` on denial.
This accepts a checked snapshot; it does not freeze the file after close.

The helper's optional synchronous policy runs against the opened descriptor and
canonical path before allocating or reading content. The operator reader uses
it to preserve absolute canonical paths outside the complete canonical data
tree, one link, POSIX owner-only permissions and current-uid ownership. Windows
ACL protection remains the operator's responsibility. Fatal UTF-8 decoding,
32–1024 passphrase bytes, one optional terminal newline, rejection of embedded
newlines/NUL and the public default, and the fixed operator diagnostic remain.
The file read limit is 1026 bytes to allow a terminal CRLF.

Credential JSON retains its caller's bounded limit, fatal UTF-8 decoding and
fixed matching-backup diagnostic. Only initial `lstat` absence is a missing
record. Disappearance after that admission is invalid storage, avoiding a race
being treated as fresh configuration. Ordinary metadata retains its existing
regular-file policy; the operator-only ownership restriction is not applied to
all workspace metadata. Exact identity checks bind the admitted metadata.

## Source qualification

The review base is root integration
`6390bc017f87724c3e71f2474b5166e886e68ce8` plus a source-only replay of the
frozen #632 implementation, yielding
`2aead004d035a43bc44ba5f88776626c657fc920`. That replay does not take #615 or
#619. Root can instead apply the original #632 implementation, #668's fixture
commit, and this reader correction after the shared #649/#651 helper. No
qualification from #632 is borrowed for the new descriptor implementation.

Windows Node 22.13.1 with locked Next 16.3.8 passed 126 assertions across ten
focused suites, with eight explicit POSIX skips. Tests cover both actual reader
call sites, short reads, precise identity drift before/after reads, permission
policy before bytes, canonical-path denial, initial versus late absence,
malformed UTF-8/JSON, actual ordinary files and actual regular-file replacement.
Existing Codex authentication/restricted-profile/catalog and model-hint/discovery
regressions also pass. Simulated POSIX uid/mode unit cases are distinct from the
real Linux permission control below. Scoped helper/unit/FIFO and private-profile
TypeScript checks, changed-file ESLint and diff checks pass.

The tracked private-reader fixture also ran against the actual readers and
helper transpiled to CommonJS in an already installed Linux image:
`sha256:fc8cd9deea7389d01d9a70cc83a5d09465c2050f2ae322d67300a9794433edad`.
Node was 22.23.2, UID 65534. The container had denied network, a read-only source
mount/root filesystem, dropped capabilities, no new privileges, 128 MiB memory,
0.5 CPU, 32 PIDs and a bounded tmpfs. No image pull occurred, and the owned
container was confirmed absent after completion. The probe supplied only the
public default-password constant and unused inventory dependency stubs; data
path resolution, filesystem operations, both read functions and the descriptor
helper were the actual source. It did not execute a Next application or crypto
migration. Ordinary files, a real mode-0644 denial and four real regular-file
replacement cases passed.

| FIFO reader | Corrected rejection | Blocking-flag control | Frozen #632 reader |
| --- | ---: | ---: | ---: |
| Operator passphrase | 5.5 ms | 753.4 ms | 756.4 ms |
| Credential JSON | 3.5 ms | 773.3 ms | 763.5 ms |

Every FIFO case rejected with the expected fixed diagnostic, zero content reads
and one closed descriptor. Corrected cases used nonblocking open and did not
reach the 750 ms watchdog. Both deliberate flag controls and actual frozen #632
readers reached it. Linux Jest executes the tracked FIFO/permission cases by
default; this change adds no opt-in container skip or skip allowance.

The qualified source SHA-256 values are:

- `readStableFile.ts`: `c24d845b34b6f3061096cce3bda001b98c8035d727ff9308b707e408f16e067e`
- `privateProfile.ts`: `f12cce6e6512c39b414ab5fb41b016a53245dc52bfa8ff6126d7f38970d183d5`
- `workspaceFiles.ts`: `a3386328ab3c249ba44e8fc95482aa98465747eb10d6505edcd597466de2ac2e`
- tracked fixture: `1b3fb2bec0b103315940d68398a9360c0f03d8b903f96075924d0ca792167542`

These are source receipts. Aggregate application type/build/CI, fresh scanner
review, installed-artifact behavior, human acceptance and independent Security
reassessment remain with the coordinator. No alert dismissal, dependency/pin
change or completed Security grade is claimed.
