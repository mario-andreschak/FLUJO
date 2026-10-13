# Claude archive admission and isolated close quarantine

This Source-only follow-up starts from frozen
`a852212fbbc63f6e84717d1065c0aa2846040395`. All new controls, compiler,
lint, SDK protocol and subprocess execution are **UNRUN**. No CPU is granted.

The ordinary Claude subscription adapter directly observes `onSdkRequest`,
outside the common `observeSdkRequest` helper. Previously its compatibility
catch swallowed a typed archive memory refusal and called `query` anyway.
The narrow change rethrows `ModelTurnArchiveMemoryError` using the same input
closure and external abort-listener removal as the existing strict native-tool
branch. Existing authority failures still use their original branch; unrelated
optional diagnostic errors still allow dispatch. No provider request has been
started at this failure boundary. Errors in later outcome persistence, other
adapters, earlier SDK/tool preparation and already-started provider attempts
are outside this narrow propagation claim.

`claudeArchiveMemoryBoundary.test.ts` has three whole-suite controls:

- Four actual archive reservations force the real Claude adapter's archive
  callback to reject; no `query`, SDK bridge process or loopback HTTP request
  occurs, and the external cancellation listener is removed.
- With available capacity, the real Claude adapter archives its prompt/options,
  runs an installed Agent SDK protocol exchange and records the completed
  outcome while retaining the original canonical history.
- An unrelated optional diagnostic error still permits that SDK protocol
  exchange and its loopback HTTP request.

The Jest SDK entry point is a forwarding bridge into a separate Node process,
which imports the actual installed `@anthropic-ai/claude-agent-sdk`. Its
documented `spawnClaudeCodeProcess` option starts a synthetic CLI peer using
real subprocess stdio. That peer answers initialization and one user turn by
calling the owned loopback HTTP fixture. These are actual adapter/SDK/protocol/
HTTP/archive boundaries, **not** the production Claude CLI, a paid provider,
native broker original-process ownership, tool-schema execution, authentication,
or default SDK transport/retry qualification. The runtime-home and host MCP
boundaries are isolated fixture mappings. Schema construction is outside these
tools-free controls. Source fidelity and the protocol must still be qualified
in the installed candidate by Q after engineering review.

`archiveWriteQuarantineProcess.test.ts` collects one parent control ordinarily
and one worker control only in its separately spawned Jest environment. The
worker uses actual `archiveModelDispatch`, filesystem open/write/compression
and an actual FileHandle. Its forwarding close fault returns a cached rejected
promise **before** OS close, so the original write-only descriptor remains open.
After the archive task rejects, the worker asserts held bytes/writer/quarantine,
uses `stat` and a positional write to prove the actual descriptor is still
usable, checks physical temp bytes and absence of final rename, then advances
virtual timers to ensure no close retry. It writes a metadata proof and leaves
the descriptor, reservation and temp intact. This is an injected close failure,
not a spontaneous OS close failure.

The parent waits for process exit and stdio closure, checks successful proof,
then independently verifies canonical temporary parent/root identity, prefix,
literal containment and absence of symlinks before deleting its owned fixture.
OS process exit drains the worker's descriptors. Failed/uncertain child exit,
timeout, output overflow, assertion or identity failure preserves the root and
bounded raw stdout/stderr logs. Ordinary Claude fixture cleanup also drains
every child and statistics work before restoring archive/environment selection;
restoration steps run independently and deletion requires resolved ownership.
Both suites are included in the existing serial isolated-suite inventory.

Meaningful negative controls on a disposable candidate only:

1. Restore just the Claude catch's previous optional swallowing. The admission
   control must fail its typed rejection, zero-query/process/HTTP assertions.
2. Release a scoped reservation despite `pendingCloses`, or remove the uncertain
   temp. The isolated worker must fail held admission or physical ownership.
3. Restore delayed close retries. The cached-failure worker must fail its
   one-close assertion after virtual timer advancement.

Keep frozen Source commits unchanged. E reviews Source; Root grants the exact
Q runtime window. All controls and negative controls remain UNRUN until then.
Existing whole `claudeSubscriptionBuiltinTools.test.ts` remains the authority
and native-tool compatibility control; do not substitute line/name discovery
for whole-suite qualification.

The full #520 goal remains open. This follow-up does not close the residual
Zod projection allocation gap, bound all model/library memory, establish the
original fatal production cause, measure heap/RSS/external memory, or qualify
original-shape media and historical large-context endurance. Bounded owned
schema descriptors and actual original-shape/default-heap measurements remain
separate required work, alongside Persona/live stages and independent grading.
