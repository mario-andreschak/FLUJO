This is an UNRUN Source acceptance candidate for #553, not a qualification receipt.

`workerRecoveryBootstrapBoundary.test.ts` starts separate OS children with the
production startup graph. Its seed uses actual encrypted workspace storage,
FlowSpec compilation/persistence, a copied Bash package, and the real encrypted
snapshot exporter. Workers restore/unlock that archive, obtain an actual
protected owner approval for Bash, then call `ensureBackendInitialized`.
Only the application can publish readiness. The scheduler creates and enrolls
the local plan through its production APIs. A real Static Bash tool call starts
a harmless OS process that appends to an owned effect journal. The test waits
for actual terminal run publication as well as the effect before stopping.

The intended assertions cover copied suppression, ordinary local one-minute
schedule recovery after a naturally missed minute, repeated `start`, paused
and disabled restart suppression, and a new sibling receiving an actual export
containing the locally enrolled row without installation-private provenance.
Additional real-bootstrap cases check corrupt signatures, changed generation,
retirement and explicit enrollment withdrawal across a natural minute.
Shutdown ACK, observed OS exit, child close, and drained stdout/stderr are
separate observations. Spawn/protocol errors have immediate owned observers.
Backend shutdown and private owner cleanup are attempted independently and
aggregate failures; cleanup failure withholds the successful ACK. An unresolved
child exit/close/drain prevents recursive fixture cleanup. The 420-second deadline belongs only
to this new natural-clock scenario; existing deadlines are unchanged.

Qualification prerequisites: exact frozen Source and matching built Bash
artifacts, isolated private credential storage, no competing CPU qualification,
and the repo's supported Node runtime. No tests/build/typecheck have been run
for this candidate. Loader source transpilation is not installed-build proof.
Any real startup/reinstallation/consent failure must be preserved and fixed;
do not substitute readiness, MCP, scheduler, flow, storage or occurrence mocks.

Still outside this fixture: interrupted live descendants; watchdog owned
cancellation and OS-exit uncertainty; the original fifteen-minute coordinator
reproduction. Child close/stdio drain alone does not prove Bash descendants
have exited. That requires actual descendant ownership/exit evidence in the
separate watchdog acceptance fixture, not a simulated ACK or readiness flag.
These remain separate #553 acceptance gaps. Package-runner review commitments
also remain separate from actual protected resolver/launch enforcement.

Source timing proposal: the final disabled original and exported sibling run
concurrently in separate data directories, with separate owner equipment and
snapshot-control tokens. Both readiness/recovery reasons and both independent
journals (original two, sibling one) are checked before and after one shared
natural minute. Their stop/exit/close/stdio-drain observations are attempted
independently and aggregated. Earlier missed-minute recovery and paused restart
boundaries, all suppression assertions, and 420/75-second deadlines remain.
This proposal is unqualified and does not change the currently frozen live run.

# Failure diagnostics (Source only)

Backend bootstrap additionally emits scoped enter/ready/failed categories for
the actual awaited layout, snapshot imports/restore/unlock, storage/encryption,
worker auth/reinstallation, MCP start/config/status and scheduler startup steps.
The observer caps output at 128 events, catches synchronous and asynchronous
diagnostic failures, supplies no readiness or effect authority, and changes no
timeout or operation. These subphases remain unrun and do not establish the
cause of an earlier bootstrap timeout.

MCP reinstall subphases distinguish actual transfer-config loading, existing
runtime lookup, bundled authority verification, runtime digest/config rebind,
optional preparation/provisioning, config save, preparation marker and actual
connection. The existing plan validation, provenance checks, preparation branches
and real handshake remain intact. Categories carry no server names or paths;
this Source instrumentation supplies neither installation nor execution authority.

The unchanged 75-second effect wait requests at most three actual scheduler
list/lastRun observations, with each diagnostic wait capped at 500 milliseconds
inside the original deadline. Output contains only fixed categories: arming,
running, local-recovery reason/pending state, last-run status/terminal presence,
and bounded trigger/Static MCP failure classifications. It emits no raw error,
tool arguments, result, credentials, paths or run identifiers. Unavailable
diagnostics do not replace the primary missing-effect failure. These observations
do not identify an active engine's internal stage or prove a causal diagnosis.
