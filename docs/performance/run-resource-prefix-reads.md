# Bounded run-resource prefix reads

`readRunResourceBounded` now bounds the file-read allocation as well as its
returned text. Previously it called `fs.readFile`, hashed the complete buffer,
decoded all text, and only then sliced the output. A 25-character fetch of a
32 MiB stored resource therefore materialized 32 MiB before truncation.

The reader opens one descriptor, checks that it is a regular file, and uses one
reusable buffer of at most **64 KiB**. UTF-8 decoding retains only the requested
prefix, with the existing **50,000-character default and 200,000-character
maximum**. A NaN request uses the default; infinities and nonpositive
numeric limits retain the existing upper/lower clamp. Decoding respects UTF-8
chunk boundaries, invalid-byte replacement, and the original UTF-16 `slice`
semantics, including a limit that cuts a surrogate pair.

Without an expected digest, a text read stops once one additional character
proves truncation. Binary summaries check that the payload exists and is a regular
file but do not load it. With an expected SHA-256, the reader streams **all bytes
of the opened snapshot** into the hash while retaining the same bounded prefix.
It never treats a prefix digest as the actual digest of the complete file.
Returned verification and durable `readBy`/verification lineage keep their existing
shape. Canonical payloads, media and resource identities are unchanged.

The descriptor binds the initial size and actual bytes even if a pathname is
replaced. Reads have explicit offsets and stop at the initial size, so concurrent
growth cannot extend a verification indefinitely. A short EOF or a changed
size/mtime during full verification fails the read; no verification lineage is
written for that result. All success and failure branches close the descriptor.
The existing ID/path policy is preserved. This does not certify atomic reads of
arbitrary in-place rewrites whose size and timestamps are deliberately restored.

Source fixtures exercise real 32 MiB sparse files with misleading small index
metadata. The prefix path reads at most one 64 KiB chunk; the verification path
reads the complete file with no buffer above 64 KiB. They also cover missing
binary payloads, UTF-8 boundaries/fragmented reads, empty/exact-limit/truncated
text, mismatched complete hashes, pathname replacement, growth/truncation and
descriptor cleanup. A whole-file baseline and a prefix-only hash are behavioral
negative controls; their raw failures must be retained with the final checks.

This is a bound per read, not a whole-process limit. Concurrent reads, index and
lineage retention, unbounded ordinary `readRunResource`, lazy media hydration,
active model/canonical/wire clones, archive queues and SDK allocations still
need admission, accounting and runtime evidence under #569. Full verification
still performs I/O proportional to the file size. The proposed 24-hour runtime
envelope, original #520 workload, deployed/manual use and independent A- acceptance
remain separate gates. The eight-file original-provider source receipt is not
modified by this slice.
