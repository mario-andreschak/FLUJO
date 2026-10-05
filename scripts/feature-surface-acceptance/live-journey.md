# Live first-use observation for #572

These tools observe an actual owner-provisioned FLUJO candidate and reuse its
UI-saved MCP connection. They complement the #517/#526 browser reports and the
four UI connection cases in #693. They do not install or start FLUJO, create a
profile, seed a model/flow/server, copy credentials, approve tools, or substitute
a model double. Security retains credential transfer, owner pairing and profile
isolation. The source is prepared; execution and installed acceptance are pending.

The observer successor requires a candidate whose generic MCP tool-result
producer emits `resultContentBinding` with `serialization: "utf8-string-v1"`,
the SHA-256 and byte count of the exact full tool-message string **after**
capture/bounding rewrites. The execution event's `result` can be a 500-character
display preview; its preview hash cannot establish the full result's identity.
The model-turn projection independently hashes its actual `genericWire` tool
message string. Both full bindings and the call ID must match. Every selected
call needs one unambiguous runtime result and one matching result in a successful
later dispatch; one correct call cannot cover another wrong result.

Product fit's preserved pure-source counterexample showed that frozen #729
accepted unrelated archived content under the same call ID. That is a classifier
gap, not evidence of an actual model incident. This successor corrects that join
and changes the observation schema to version 2. Old candidates without the
producer field remain incomplete. Non-string wire representations and content
changed by compaction/redaction remain incomplete; the observer neither repairs
them nor assumes semantic equivalence. A content match establishes the exact
runtime/archive string binding, not provider identity or semantic consumption.

## Owner preparation and UI actions

1. Select the combined candidate with the required Security/Production fixes,
   #714 connection labels and #672/#680 browser reads. Retain its source/tree,
   build inputs, immutable installed bytes, startup/cleanup and profile receipts.
   Pass the actual candidate receipt SHA-256 below. The observers retain that
   reference as a declaration; they do not verify the source/artifact binding.
2. Allocate one coordinated runtime/browser slot. The owner provisions an
   isolated loopback profile with an approved genuine model and the separately
   owned feature fixture. Record provider identity, authorization and budgets
   outside these tools. Their model archive observations do not authenticate a
   provider, enforce a spending budget or prove a human user completed a task.
3. Through the first-use UI, actually test the model; connect, test, save, reload
   and inspect the fixture connection. Run the #693 connection steps and repeat
   #517's actual public Firecrawl form and #526's full discovery/retention cases
   on these installed bytes. Keep those reports separate from the synthetic echo.
4. Create an ordinary guided agent through the UI with the tested model and only
   the fixture tool. Create a fresh Chat conversation before its first dispatch.
   Select tool approval and the debugger through their UI controls. Record the
   exact conversation ID, flow ID, configured model ID and runtime tool name.
   The runtime tool name can be namespaced; the fixture tool name is
   `fixture_tool_128`. Retain screenshots/actions showing those choices.
5. Attach the observer before sending the task. It rejects a conversation with
   prior model dispatches or assistant/tool messages. After the attached message,
   use the UI to ask the agent to call the selected tool with synthetic values,
   inspect and approve its pending call, pause/inspect the debugger and continue
   until a useful assistant answer. The observer never performs those actions.

```powershell
node scripts/feature-surface-acceptance/observe-live-journey.mjs --base-url=http://127.0.0.1:PORT --workspace=WORKSPACE --conversation=CONVERSATION_ID --flow-id=FLOW_ID --model-id=MODEL_ID --tool-name=RUNTIME_TOOL_NAME --fixture-tool-name=fixture_tool_128 --fixture-url=http://127.0.0.1:FIXTURE_PORT --candidate-receipt-sha256=SHA256 --output-dir=C:/absolute/new-observer-directory --duration-seconds=900
```

The observer uses the existing execution SSE and model-turn archive endpoints.
It correlates actual call IDs and argument hashes with accepted fixture receipts,
requires a successful later model dispatch whose archived input contains that
same full serialized tool result, and observes subsequent assistant text and a completed top-level
run. Missing approval/debugger boundaries, errors, capped runs, uncorrelated
calls and truncated streams remain incomplete. Partial event projections and
failure receipts are retained. Model text, raw arguments/results, prompts and
SDK request objects are excluded from retained projections.

Fixture receipts enter either report only after definition/version, UUID, counter
and bounded invocation-window admission. The report retains the fixed fixture
fields and each call's sequence, tool name, argument digest and accepted flag;
unexpected fields are omitted at both levels. Invalid receipt values are refused
before assignment, including on partial/failure paths. Event/archive metadata
requires bounded string identities and typed statuses, roles, pause boundaries
and nonnegative sequence/depth values. Nested metadata objects are refused before
an event callback or archive append. These strings and content/argument hashes
can still identify or correlate a private run; projection does not make reports
safe for public sharing or authenticate their provider or source artifact.

The observer admits at most 16 MiB of serialized retained projections across its
fixture receipts, event rows and model-input rows, in addition to the existing
per-response/SSE bounds. Admission precedes every append; exceeding the budget
leaves the run incomplete and retains already admitted partial observations.
Both report writers cap final JSON at 32 MiB. Output paths remain caller-selected
fresh directories with fixed filenames and exclusive writes; filesystem ACLs,
hostile local races and owner/profile authentication remain separate boundaries.
The external client admits at most the fixture's 128 ordered tool names before
accumulation, and bounds retained pagination cursors. This does not bound the
SDK's parsing of an individual response or establish whole-process memory
acceptance; those remain unqualified by these pure projection controls.

## Actual external MCP client reuse

After the UI run, leave its saved HTTP/SSE connection and owner fixture running
and quiet. The selected proxy must already be available under Security's owner
policy. This client does not enable exposure or alter server configuration.
It reads the saved connection, checks the owned fixture definition, discovers all
128 tools through `/mcp-proxy/<server>`, then makes exactly one explicit call to
tool128 with synthetic arguments. It compares the returned echo and argument
digest with one new accepted receipt, then closes its own client. Failures are
retained without changing configuration or retrying the call.

```powershell
node scripts/feature-surface-acceptance/external-mcp-reuse.mjs --base-url=http://127.0.0.1:PORT --workspace=WORKSPACE --server-name="UI SAVED SERVER NAME" --fixture-url=http://127.0.0.1:FIXTURE_PORT --candidate-receipt-sha256=SHA256 --output-dir=C:/absolute/new-external-directory
```

The CLI entry points target an owner-selected anonymous loopback test profile.
They do not inherit bearer tokens, provider keys or dotenv files. Authenticated
worker/shared profile adapters and credential handling remain with Security;
these local component reports cannot qualify those profiles. Other transports,
provider-specific tools, full advertised features, existing-user upgrades,
seven-language/zoom/assistive-technology review and the agreed novice pilot still
need their actual observations and independent assessment. A component pass
always has `fullFeatureAcceptance: false` and `gradeAwarded: false`.

## Queued verification

```powershell
node --test scripts/feature-surface-acceptance/live-journey-observer.test.mjs
node scripts/run-local-jest.cjs --selectProjects node --runInBand --runTestsByPath __tests__/featureSurface/liveJourneyObserver.test.ts __tests__/flow/processToolCallsConcurrency.test.ts __tests__/flow/processToolCallsCapture.test.ts
```

The authored native suite contains 46 synthetic controls, including same-ID
wrong-content, missing bindings, duplicate matches, byte/serialization mismatch,
long UTF-8 results and identical previews with different tails, plus receipt
allowlisting, nested-metadata refusal and aggregate/final output budgets. The two existing
Jest caller suites additionally check the actual `ModelHandler` event producer
with mocked MCP data, including the captured/rewritten tool-message content.
The frozen #751 native34 and producer/provider-attempt Jest51 receipts and #760's
named equal-byte/different-digest control belong to their exact prior sources.
The privacy successor needs its own serial native result and later combined
ordinary-Jest verification; those earlier receipts do not validate this change.

These are synthetic controls for correlation, redaction, SSE framing,
sequence ordering and incomplete/false-positive observations. They do not call a
model, start an app or validate an installed artifact. Runtime and test execution
must follow the coordinator's current resource allocation; no queued command is
a passing result. Keep the full #563/#564 ledger and original profile matrix.
