# Persona record reads during atomic publication

The ordinary Persona goal-dispatch fence checks have retained three actual
failures while cancellation updates overlap polling reads: a627's child-stop
case (`UNSAFE_FILE`), #682/2e20adf5's child-pause case (`UNSAFE_FILE`), and
928ae845's child-pause case (`FILE_CHANGED` at the strict reader's final
descriptor check). The separate 6390 ordinary pass did not prove causal closure.

The strict `readPlainFile` helper correctly refuses an obsolete admitted inode
or a changed snapshot. Its source and tests are unchanged. Persona point reads
now apply an availability policy at their caller: at most **three descriptor
attempts**, without sleeps, broad error catching or returning stale bytes.

Parents are admitted before the first leaf stat. Each attempt and the strict
reader's before/after callbacks verify the original parent directories' exact
device, inode, mode, uid/gid and canonical path. Directory timestamps are not
used for parent identity because legitimate child publications change them.
The initial leaf must be regular, non-symlink and single-link. Only a strict
`UNSAFE_FILE` or `FILE_CHANGED` failure followed by a **different regular,
single-link inode**, with the same exact device, uid/gid and mode, is eligible
for a fresh read. The fresh descriptor goes through all original strict checks.

Deletion, unknown paths, in-place changes, links, nonregular files, changed
owner/mode/device, changed parents and the size-limit predicate still refuse.
If all three attempts race, the error remains visible. This policy verifies
filesystem ownership/identity; it is not proof of a publisher's credentials.
Existing Persona/record parsing and flat/sharded collision guards still run
after the accepted bytes. The returned display metadata describes the fresh
accepted record. Reads do not rewrite history or change execution authority.

Deterministic fixtures publish new cancellation records before open, after
open and after bytes have been read. They retain the exact `FILE_CHANGED`
predicate and the three-attempt limit, plus all unsafe-path controls. Windows
refuses rename-over-open in the held-descriptor fixture; that fixture uses
move-and-publish and does not claim a live one-step Windows atomic overwrite.
Linux qualification exercises the ordinary one-step overwrite. Mode/uid/gid/
device test seams retain real file stats for other fields; actual POSIX
permission/link cases are separate platform evidence.

The original child-stop/pause fence assertions, timing, retries and skip policy
remain unchanged. A local selected-suite pass is source evidence. Fresh combined
hosted CI is required to show the observed failures have closed on the candidate.
Other strict readers, bulk directory scans, installed startup, source release,
elapsed Persona gates, original-provider workload, whole-process memory bounds
and independent A- assessment remain separate acceptance work.
