# Nonblocking metadata descriptor open

This follow-up preserves PR #649's frozen head and fixes the coordinator's
independent review finding: a POSIX pathname replaced by a FIFO could block
`open` before the descriptor's regular-file check. `readStableFile` now includes
the platform's `O_NONBLOCK` flag alongside `O_RDONLY` and `O_NOFOLLOW`. Regular
file reads retain their existing bounded content and exact identity checks.

The tracked POSIX probe creates an owned regular file, replaces it with a FIFO
immediately before the real open, and checks rejection under a 500 ms deadline
with the descriptor closed. Its second control strips `O_NONBLOCK` and reaches
a 750 ms writer watchdog, proving the FIFO can block the predecessor operation
while releasing the pending reader so the test can terminate. Both cases are
explicitly skipped in Windows Jest because native `mkfifo` is unavailable.
No host credential/catalog is read and cleanup is confined to the verified
owned fixture directory.

Local Linux container source qualification of this same fixture, plus Windows
focused tests, is recorded below. It does not qualify an installed FLUJO release,
native Codex behavior, or another machine. Fresh integrated scan/type/build and
independent release acceptance remain pending; no alert dismissal or scanner
weakening is included.

The controlled Linux probe used the already installed immutable image
`sha256:fc8cd9deea7389d01d9a70cc83a5d09465c2050f2ae322d67300a9794433edad`
with Node 22.23.2, denied network, non-root UID, dropped capabilities, read-only
source mount, bounded memory/CPU/PIDs and an owned tmpfs. No image pull occurred.
The corrected operation rejected/closed the FIFO in 9.5 ms without watchdog
release. The predecessor control blocked until its watchdog at 753.2 ms, then
rejected/closed the descriptor. The owned container was removed after completion.

The initial Windows explicit selection observed 87 passing assertions and two
POSIX skips, but the strict runner correctly refused the entirely skipped FIFO
suite. An additional actual ordinary-file regression now exercises that suite
on Windows too, while preserving the two explicit POSIX skips. This records
Windows regular-file behavior separately from Linux FIFO behavior; skips are
not counted as passed assertions.

The final Windows run passed 88 assertions across seven suites with two explicit
POSIX skips. Helper/FIFO/unit scoped TypeScript, changed-file ESLint and diff
checks passed. The Docker inventory check confirmed the owned fixture container
was absent. Full caller-graph type/build and fresh scanner disposition remain
with the coordinator.
