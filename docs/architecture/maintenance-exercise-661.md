# Maintenance exercise on the split execution and MCP code (#661)

On November 28, 2026 a maintainer who did not write the #571 split did six
maintenance tasks using only the
[architecture guide](./execution-module-boundaries.md) and the code. The point
was to find out whether the guide leads a newcomer to the right code and
whether the tests catch the mistakes a newcomer makes. The owner decided that
nobody does this exercise by hand, so the maintainer was an AI agent; this is
not a record of a person doing it.

- Base: `wip-cleanup` at `143161fb`. Windows 10, Node 22.23.4, npm 10.9.9.
- Every task ran on its own throwaway branch, which was deleted afterwards.
  Only the fixes listed below were kept.
- Before starting: the guide's path check passed, and the three focused test
  files passed (42 tests) with no import-boundary problems.
- The guide's own seed list is part of the guide, so the maintainer had read it.
  To test the tests and not just the seeds, the maintainer also planted faults
  of its own.
- Times are wall-clock minutes for an agent and only show which tasks were
  harder; a person needs longer.

## The tasks

### A. A program's run carries on by itself (#661, task 1)

- **Opened:** the guide, `src/shared/types/execution/invocation.ts`,
  `src/backend/execution/flow/runStateSetup.ts`, `runFlow.ts` (only where it
  calls them), `unattendedDriveForward.ts`,
  `src/app/v1/chat/completions/chatCompletionService.ts`, and the tests.
- **Guide right:** every file and line of the path check, the module map row
  for `runStateSetup.ts`, and the test names it quotes.
- **Guide wrong:** the bug report spoke of runs "started through the API", but
  FLUJO's own HTTP chat API passes `chat` (or `internal` on a worker). No route
  passes `api`. Ruling out a missing route cost time.
- **Tests:** both guide seeds failed tests (3 and 2 failures). A fault of the
  maintainer's own, taking attendance from the conversation's first source
  instead of this run's source, passed all three focused test files; only
  `__tests__/chat/runFlow.test.ts`, which the exercise did not run, caught it.
- **Time:** about 7 minutes.

### B. A late close from a replaced MCP connection (#661, task 2)

- **Opened:** the guide, `src/backend/services/mcp/index.ts` (`onclose`,
  `onerror`, `deregisterClient`), `lifecycleCoordinator.ts`, `mcpLeasePool.ts`,
  `serviceRegistries.ts`, `connectionScheduling.ts`, and
  `__tests__/mcp/mcpRestartLoop.test.ts`.
- **Guide right:** where the close handler is, the "is this still the current
  transport" check, FLUJO's own closes removing the transport first, and
  workspace plus name as a server's identity.
- **Guide wrong:** it said old callbacks use the generation number to see they
  are out of date. They compare the transport instead. There are two counters,
  neither used by the callbacks: one makes tool names planned against a
  replaced client stale, the other makes leases and shutdown receipts stale.
  The guide also did not mention that `onerror` has the same check, or what
  keeps a callback in its workspace.
- **Tests:** both guide seeds failed tests (1 and 4 failures). Two faults of
  the maintainer's own passed every test: the same mistake in `onerror`, and
  dropping the workspace binding of `onclose`. A third ("reconnect even when the
  server was disabled") changed nothing a user sees, because the retry checks
  again before it connects. The test file also held one test twice.
- **Time:** about 5 minutes.

### C. Add a step to a run: a new check before a run starts

- **Opened:** the guide, `runPreflight.ts`, `runFlow.ts` (the call),
  `__tests__/chat/runFlow.test.ts`, `validateFlowForRun.ts`,
  `src/utils/shared/flowValidation.ts`.
- **Tried:** end a fresh run of a flow that has no steps before anything runs.
- **Guide right:** it sent the change to `runPreflight.ts`, and no change to
  `runFlow.ts` was needed.
- **Guide missing:** flow-shape rules live in `flowValidation.ts`, shared with
  the editor, and the rule already existed there ("no Start node"). The new
  block also broke 33 tests whose flows have no steps, so the tests caught it
  loudly.
- **Tests:** a typical slip, running the validation on internal resumes too
  (an approval decision or a debugger step), passed every test.
- **Time:** about 4 minutes.

### D. Change how a tool result is handled

- **Opened:** the guide, `handlers/toolCallProcessing.ts`, the
  `src/backend/services/runResources/` modules it imports,
  `handlers/contextWindowFit.ts`, `toolRepeatGuard.ts`, and the tool tests.
- **Tried:** tell the model "(the tool finished without output)" when an MCP
  tool returns nothing. It type-checked and the 63 related tests passed.
- **Guide right:** `toolCallProcessing.ts` owns it; results stay in call order.
- **Guide missing:** the modules that save large and binary results, split
  out images and audio, and apply the size limit. The ModelHandler table made
  `contextWindowFit.ts` look like the place for large results, but it only acts
  after a provider rejects a request as too long.
- **Tests:** returning results in the order they finished failed 3 tests in
  `__tests__/flow/processToolCallsConcurrency.test.ts`.
- **Time:** about 3 minutes.

### E. Add an MCP server event: show a server's own log messages

- **Opened:** the guide, `serviceEvents.ts`, `mcpLeasePool.ts`, `index.ts`
  (`connectServer`), `resourceNotifications.ts`, `listCache.ts`.
- **Tried:** a handler for the MCP `notifications/message` log message in
  `resourceNotifications.ts`, registered in `connectServer` like the others.
- **Guide missing:** the events row covers events FLUJO asks for (list,
  subscribe, stream, poll), not messages a server sends on its own. Where those
  handlers are registered, and that newer-protocol clients need them in
  `betaClient.ts`, was not written down.
- **Checks:** `npm run check:hotspots` failed: `index.ts` grew from 2,532 to
  2,535 lines. Every handler is registered inside `connectServer`, so any new
  server message makes the big file grow. The check's message did not say what
  to do when the big file has to call the new code.
- **Time:** about 3 minutes.

### F. Fix a bug in connection scheduling

- **Opened:** the guide, `connectionScheduling.ts`, `index.ts` (what a
  successful connection resets), `__tests__/mcp/mcpRestartLoop.test.ts`.
- **Planted:** a successful retry no longer resets the retry count. No test
  failed, because `connectServer` resets it too. With both resets removed, still
  no test failed: "after a successful retry the next close retries quickly
  again" was not tested at all.
- **Guide missing:** how the stop after five failed retries recovers without a
  restart (the next use of the server connects it again).
- **Time:** about 2 minutes.

## What was fixed

| Gap | Fix | What stops it coming back |
| --- | --- | --- |
| Taking attendance from the conversation's first source slipped past the exercise's tests | Two cases in `__tests__/flow/unattendedDriveForward.test.ts`: a scheduled conversation continued from chat, and the reverse | Those tests |
| A stale `onerror` could drop the working connection unnoticed | Two cases in `__tests__/mcp/mcpRestartLoop.test.ts`: an error from a replaced transport is ignored; an error from the live one closes it and reconnects | Those tests |
| A close handler that forgot its workspace went unnoticed | A case in the same file: a close in one workspace reconnects there and leaves the same server name elsewhere alone | That test |
| "A successful retry resets the backoff" was untested | A case in the same file | That test |
| Validating again on internal resumes went unnoticed | `__tests__/flow/runPreflight.test.ts` | That test |
| The same MCP test was in the file twice | Removed the copy | – |
| Generation numbers described wrongly; `onerror` and workspace binding missing | "MCP connection ownership" row in the guide | – |
| Unclear who passes `api` | New guide row "Who started a run, and whether anyone is watching" | – |
| Shape rules sent to the wrong place | New guide row "Pre-run checks"; `runPreflight.ts` row | – |
| Tool result modules not named | New guide row "Tool results"; `contextWindowFit.ts` row | – |
| Where server messages are handled; what to do when a big file must grow | New guide row "MCP server notifications", section "Adding to a big file", and a clearer `npm run check:hotspots` message | `scripts/check-hotspot-sizes.test.mjs` |
| How the five-retry stop recovers | `connectionScheduling.ts` row | – |
| Names the reader could not place (`init.ts`, `workspace.ts`, `install.ts`, `registry.ts`, two test files) | Written as full paths | `npm run check:hotspots` now fails when the guide names a file that does not exist ([rule](../corrections/architecture-guide-names-real-files.md)) |

With these fixes all ten harmful faults planted in this exercise fail a
focused test; before, five did (a sixth only in a test file the exercise
did not run). The guide's exercise section now lists the
seeds with the tests that catch them, so the exercise can be repeated in a few
minutes.

The one boundary that still needs code to move: the block in `connectServer`
(`src/backend/services/mcp/index.ts`) that registers the resource, tool-list,
Claude channel and event-stream handlers on each new client belongs in its own
module, so that a new server message is added there without growing
`index.ts`. Another change on the same bundle was rewriting `index.ts` at the
time, so the move was handed to it.

## Not caused by the exercise

Two test files fail on this Windows machine on the untouched base too:
`__tests__/chat/runFlow.test.ts` ("holds admission until the real terminal
persistence retry settles") and five tests in
`__tests__/mcp/mcpConnectionLifecycle.test.ts` (the Windows check that a file is
private to this account refuses). Every result above compares against those
same failures.
