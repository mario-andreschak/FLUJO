# Live first-use observation for #572

These tools observe an actual owner-provisioned FLUJO candidate and reuse its
UI-saved MCP connection. They complement the #517/#526 browser reports and the
four UI connection cases in #693. They do not install or start FLUJO, create a
profile, seed a model/flow/server, copy credentials, approve tools, or substitute
a model double. Security retains credential transfer, owner pairing and profile
isolation. The source is prepared; execution and installed acceptance are pending.

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
tool result, and observes subsequent assistant text and a completed top-level
run. Missing approval/debugger boundaries, errors, capped runs, uncorrelated
calls and truncated streams remain incomplete. Partial event projections and
failure receipts are retained. Model text, raw arguments/results, prompts and
SDK request objects are excluded from retained projections.

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
```

These are synthetic negative controls for correlation, redaction, SSE framing,
sequence ordering and incomplete/false-positive observations. They do not call a
model, start an app or validate an installed artifact. Runtime and test execution
must follow the coordinator's current resource allocation; no queued command is
a passing result. Keep the full #563/#564 ledger and original profile matrix.
