# Execution ordering at observable boundaries

Issue #571 requires ordered regression traces, including pauses and failures.
`__tests__/flow/executionOrdering.test.ts` observes real `runFlow`, `FlowExecutor`,
`PocketflowEngine`, graph conversion, Start/Process/Subflow nodes, `ModelHandler`,
the OpenAI adapter and installed SDK, MCP service/SDK, and storage chokepoints.
Catalogue lookup and API-key resolution are fixtures. A loopback HTTP endpoint
supplies scripted model responses; the existing stdio MCP fixture serves a real
tool from a separate process. No external account or provider is contacted.

Observers call the original archive and persistence implementations. Before
each checkpoint snapshot, they read the journal from disk without flushing it
and require that exact checkpoint ID to be present. Snapshot observations occur
after the real write returns. HTTP observations occur when the endpoint receives
the SDK request; a model dispatch event alone is not that observation. Tool
results include the child PID and are checked against the actual SDK transport
child. Teardown checks its exit code and the MCP shutdown receipt.

| Profile | Required ordering and absence checks |
| --- | --- |
| Ordinary | Run start; durable checkpoint and snapshot; node execution; request archive and dispatch event; physical HTTP request; outcome archive; completed recovery snapshot; terminal event. One physical request. |
| Debugger | Pause before Start with no request; step Start; step the model once; pause after its durable result; consume the saved action without another request. The preparation snapshot contains no live abort signal. |
| Approval | First model request; approval pause with no tool call; explicit decision; actual stdio tool dispatch/result; next model request; completion. The tool runs once. This exercises the decision function, not the HTTP approval route. |
| Turn cap | Requested calls receive synthetic tool results; the final summary request has no tools; capped recovery precedes the terminal event. No tool is executed. |
| Provider error | One physical HTTP 401; error archive; error event; permanent-failure snapshot; terminal event. No retry is inferred from an invocation marker. |
| Cancellation | Run owner, run owner with independent authority, and authority-only signals each close the open physical HTTP connection. The cancelled archive and nonretryable cancelled recovery precede the terminal event. |
| Cold resume | Discard live conversation state and compiled graph cache after a durable debugger pause. Reload the real stored state and consume the saved action with the same logical run ID, without repeating HTTP. |
| Process restart | In `executionRestartProcess.test.ts`, an actual child commits a debugger pause after its SDK result. Kill that owned child and observe its exit; a fresh child reads the same durable action, completes the same run/attempt, writes completed recovery before its terminal event, and exits cleanly. The parent observes one physical HTTP request across both processes. |
| Subflow | Parent enters Subflow; translated child-start event; real child HTTP request; child commits completion; translated child-done event; parent continuation request; parent terminal event. Child state retains parent lineage. |

The cold-resume case stays in one OS process. The separate process-restart case
observes real process termination and fresh-state recovery at a completed model
turn's durable debugger pause. It uses a source transpile loader, following the
existing Persona fixture's import-only dependency mapping; catalogue/key lookup
and the ordinary authority callback are controlled. It starts no MCP child.
This does not prove worker admission, recovery during an uncertain external
effect, an installed release, every provider adapter, or an external MCP server.
Those need separate observations at the accepted combined revision. The fixture
watchdog is not an agreed performance budget. Human maintenance and independent
scorecard acceptance remain separate.

## Cancellation seam

`runFlow` owns the combined run owner/cancellation-registration signal and keeps
it non-enumerable on live state. `ProcessNode.prep` carries it on a non-enumerable
preparation field; `execCore` combines it with the existing execution-authority
and execution-extension signals before calling the model handler. That handler
owns the in-flight provider cancellation watch. This forwards cancellation and
does not mint or replace execution authority.

The run's terminal cancellation predicate must execute even if a cooperative
SDK abort already returned `ERROR_ACTION`. It marks the stop before recovery
classification, preventing an intentional cancellation from becoming a retryable
provider failure. Existing error payloads and cancellation finalization stay at
their existing interfaces.

Run the focused suite through the dependency guard:

```sh
node scripts/run-local-jest.cjs --selectProjects node --runInBand --runTestsByPath __tests__/flow/executionOrdering.test.ts
node scripts/run-local-jest.cjs --selectProjects node --runInBand --runTestsByPath __tests__/flow/executionRestartProcess.test.ts
```

Retain raw Jest JSON/logs, source and lock identity, complete ordered observer
records, baseline failures, and restored negative controls with any review.
Passing this suite is scoped source evidence, not an A- assessment.
