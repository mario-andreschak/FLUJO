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
and disabled restart suppression, and a new sibling receiving the original
snapshot. Shutdown ACK and observed OS exit are separate observations. A live
child prevents recursive fixture cleanup. The 420-second deadline belongs only
to this new natural-clock scenario; existing deadlines are unchanged.

Qualification prerequisites: exact frozen Source and matching built Bash
artifacts, isolated private credential storage, no competing CPU qualification,
and the repo's supported Node runtime. No tests/build/typecheck have been run
for this candidate. Loader source transpilation is not installed-build proof.
Any real startup/reinstallation/consent failure must be preserved and fixed;
do not substitute readiness, MCP, scheduler, flow, storage or occurrence mocks.

Still outside this fixture: copying locally enrolled rows to a sibling without
private provenance; corrupt/changed-generation/retired/stop controls under the
full bootstrap; interrupted live descendants; watchdog owned cancellation and
OS-exit uncertainty; the original fifteen-minute coordinator reproduction.
These remain separate #553 acceptance gaps. Package-runner review commitments
also remain separate from actual protected resolver/launch enforcement.
