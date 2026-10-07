# Model-turn snapshot response streaming

The snapshot HTTP route validates and streams JSON over one held archive descriptor.
It no longer constructs a transcript object and serializes a complete response string.
Both passes decode incrementally: the first checks JSON grammar, exact format and
conversation/dispatch identity, and the V2 outcome overlay before headers; the second
emits bounded chunks under client backpressure. No plaintext temporary file is created.

The existing four-slot admission remains held until response EOF, cancellation, or
abort and actual decoder/descriptor cleanup. A fifth read receives the existing 429.
An unread response retains its slot. Close failures receive three immediate attempts,
then eight bounded delayed attempts; the original slot remains quarantined until the
descriptor closes. Diagnostics expose counts without payloads or paths.

Compressed and decoded limits remain 32 MiB and 64 MiB, with the overlay's emitted
size checked before headers. Metadata tokens have a 2 KiB cap. The object-returning
backend reader retains its existing allocation limits; caller object retention and
browser JSON parsing are outside the streamed server response's memory contract.

The held descriptor pins the opened revision across POSIX producer atomic replacement.
Descriptor identity, size, mtime, ctime and link count are checked around each physical
read and each response pull; unlink caused by replacement is accepted for the original
held inode. Final compressed hashes must agree before successful EOF. In-place
mutation produces a stream error, including between paused pulls. Filesystem metadata
and a final hash do not promise atomic isolation from arbitrary external writers that
can spoof metadata; already delivered bytes cannot be recalled after an error.
Windows forbids rename over the open destination in this tested environment; moving
the original aside changes its ctime and fails closed. POSIX detached-inode success
requires execution on POSIX and is not claimed by the Windows qualification.

Qualification uses actual Source in an offline Node child with a 128 MiB heap,
512 MiB supervised RSS ceiling and no explicit GC. Four distinct valid 60 MiB
archives are prepared concurrently, paused for 250 ms, then fully consumed under
backpressure. All response hashes and original persisted archive hashes must match;
successful EOF must release all slots. This is a finite response profile, not a
provider endurance or deployment claim. The HTTP response remains JSON compatible.

The private native archive reader separately opens before pathname checks, validates
the authoritative descriptor before body allocation/read, and rechecks descriptor and
pathname metadata afterward. Its stricter private format and byte limits remain.
