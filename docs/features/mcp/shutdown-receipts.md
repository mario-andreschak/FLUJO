# Managed MCP shutdown receipts

This source contract addresses #547. It adds observations to the existing MCP
teardown path; installed-release acceptance remains a separate gate under #570.
It does not authorize worker recovery, schedule enrollment or external effects.

`MCPService.disconnectServer(name)` retains its `success` field and adds
`shutdownReceipt`. Concurrent requests and repeat requests after the same
disconnect return the same receipt. Unknown servers without a recorded teardown
retain the existing not-found response. A disconnect overlapping a connection
waits for that connection before closing its registered generation.
`disconnectAll(reason)` adds `shutdownReceipts`; its legacy `closed`/`failed`
arrays describe connection-disconnect outcomes and do not certify process exit.

Operators can read the latest current-generation receipt at
`GET /api/mcp/servers/{name}/status?workspace={workspace}`. This route retains
its existing workspace, lock and ingress guards. Service diagnostics also include
the receipt. No receipt means no retained observation, not confirmed exit.

The version 1 fields are:

| Field | Meaning |
| --- | --- |
| `runtimeId`, `workspace`, `serverName`, `generation` | Process-local runtime identity and the generation closed. The opaque runtime ID changes when the registry/process is recreated. |
| `observedAt`, `durationMs` | Observation time in UTC and elapsed disconnect time, including waiting for an in-flight connect. |
| `processOwnership` | `owned` when the transport exposes its managed child; `external` for a configured network transport; otherwise `unknown`. |
| `exitOutcome` | `observed_exit` for an observed owned-child exit; `unknown` when exit was not observed; `not_applicable` for an external process. |
| `forced` | Whether termination needed escalation beyond closing stdin. This field alone does not prove exit. |
| `errorClassification` | `none`, `close_failed`, or `exit_unobserved`. Exceptions never become raw receipt text. |

Connection intent and shutdown evidence must be read separately. Saving a disabled
configuration, a `disconnected` status, a `cold` runtime, or a cancellation ACK
cannot qualify process exit. An SDK close error can coexist with `observed_exit`
if the owned child was already observed exiting; investigate the close failure
without erasing the observed fact.

A subsequent accepted connect clears the current receipt, and the coordinator
checks generation before retaining a late teardown result or marking a runtime
cold. A saved old receipt cannot qualify a replacement generation. Receipts are
bounded to one per runtime record and are not persisted across application restart.
They contain no commands, arguments, environment, stderr, credentials or raw errors.
Existing application logs are a separate surface; this contract does not assert
that all historic logs are redacted.

For an unknown outcome, retain the receipt and require a separate process census
or operator investigation before claiming shutdown. An observed child exit does
not certify that every descendant exited, remote cleanup completed, a business
drain finished, or a provider settled billing. Network connection closure provides
no evidence that a remotely owned process stopped.

Disposable source acceptance (Node 22+, checkout-local `npm ci --include=dev`):

```text
node scripts/run-local-jest.cjs --selectProjects node --runInBand --testMatch "**/__tests__/**/*.test.{ts,tsx}" --runTestsByPath __tests__/mcp/lifecycleShutdownReceipts.test.ts __tests__/mcp/shutdownReceiptProcesses.test.ts __tests__/mcp/mcpConnectionLifecycle.test.ts __tests__/mcp/mcpRestApi.test.ts
```

The explicit test glob avoids mixed slash expansion of `<rootDir>` in a Windows
managed checkout below `.codex`. The fixtures use their own disposable Node
processes and verify graceful/forced exits, overlapping requests, close errors,
unresolved exit, generation invalidation, workspace separation, redaction, and
preservation of an unrelated process. Workspace separation here is bookkeeping
coverage, not the two-user authorization acceptance required by #574.

Before claiming support for an identified release, run the same boundaries on
Windows and Linux against that artifact, retain its source/distribution identity,
and perform the authenticated operator status journey. This document supplies no
installed-artifact, independent-operator or independent-scorecard result.
