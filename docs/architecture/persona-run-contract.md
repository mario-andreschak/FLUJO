# Persona context and Behavior snapshot contract

`src/backend/execution/flow/personaRunContract.ts` owns the three existing
decisions that bind Persona instructions to an attributed Behavior run:

| Function | Decision |
| --- | --- |
| `assertInstructionContextAttribution` | Require the same Persona, Activity and Behavior revision triple. |
| `assertBehaviorSnapshotMatchesInstructionContext` | Require the declared root Flow and its immutable content hash, using the existing canonical/legacy hash compatibility in `behaviorRevisions.ts`. |
| `instructionContextsEqual` | Compare the existing selected identity, revision, Role and instruction fields when resuming the same Activity. |

The functions accept caller-validated data and retain their original bodies,
signatures and error messages. `runFlow` still parses the schemas, confines
instruction contexts to top-level runs, supplies runtime authority, clones and
installs the context, and controls recovery, graph steps, events, persistence
and cancellation. The contract module performs no I/O and grants no capability.
Equality retains its existing field selection; this extraction adds no broader
metadata validation or runtime freezing.

The complete bodies of both `runFlow` and `runFlowUnlocked` are unchanged by the
move. The extracted declarations also match the committed archive-allocation
slice `1a4d907b` and coordinator integration source `50113b6e`, allowing this
narrow extraction to be reviewed separately from those behavioral changes.

`__tests__/chat/runFlow.test.ts` now observes authority calls, durable snapshot
writes, graph steps and emitted events for a fresh pinned run and a cold resume.
It also checks that foreign input attribution and corrupted persisted
attribution reject before events, execution or writes. The real `runFlow`,
snapshot-hash validation and persistence chokepoint execute; the graph engine
and storage primitives are controlled fixtures. Provider and MCP calls are not
live observations. Before/after records retain all four ordered traces.

A guard-bypass negative control temporarily replaces only the attribution
assertion with a no-op. The foreign-input test then fails because execution
finishes instead of rejecting; the original source is restored byte-for-byte.
This qualifies the fixture's sensitivity to the decision being preserved.

For maintenance, start with the three named decisions and their caller sites.
Change an attribution or snapshot fixture, verify rejection before effects, and
run the ordinary/ephemeral, approval/debugger, cap, subflow, cancellation,
recovery, archive and authority suites listed in
[execution ownership](./execution-module-boundaries.md). A second human must
independently perform and review the execution and MCP exercises for #571;
these AI-authored fixtures supply source evidence only. Integrated CI, identified
installed release, agreed performance comparison and independent reassessment
remain separate acceptance gates.
