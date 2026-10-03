# Feature-surface acceptance fixture

This synthetic MCP server supports the candidate checks for #517 (form drafts
resetting during refresh), #526 (128-tool discovery) and #572 (first MCP agent).
It echoes arguments; it never fetches URLs, opens a browser, runs a command,
reads workspace files, calls a model or connects to a provider. Its schemas are
shaped like URL/options and element/ref tools, but it is neither Firecrawl nor
Playwright. Passing this fixture does not resolve a provider-specific report.

## Run and connect

Use Node 22+ and this checkout's installed lockfile dependencies. Run the small
protocol check independently of the full FLUJO build:

```powershell
node --test scripts/feature-surface-acceptance/fixture-server.test.mjs
node scripts/feature-surface-acceptance/fixture-server.mjs --transport=http --port=9317
```

The HTTP process binds **127.0.0.1 only**. Its one startup line on stderr contains
the URL, an ephemeral control token and definition SHA-256. Use the printed URL
if `--port=0` chooses a free port. Connect a disposable candidate profile using
Streamable HTTP at `http://127.0.0.1:9317/mcp`. Legacy SSE at `/sse` is available
to verify FLUJO's advertised compatibility; the SDK deprecates that transport.
For stdio use the absolute Node executable as the command and separate args:

```text
C:/absolute/checkout/scripts/feature-surface-acceptance/fixture-server.mjs
--transport=stdio
```

Do not add quotes inside individual argument-array entries. Stdio stdout is
reserved for JSON-RPC. Plain stdio starts no HTTP listener. To control failed or
delayed refreshes while FLUJO owns the stdio child, add `--control-port=9317` (or
`--control-port=0`). This starts the same guarded loopback service sharing that
child's state. Its startup line and ephemeral token appear on the child's stderr;
use that service's `/control` and `/receipt` endpoints. Stop only the fixture
process you started. The fixture scripts are source-side test equipment and
are not added to the npm release's `files` list.

`GET /receipt` and MCP resource `fixture://feature-surface/receipt` expose the
run identity, definition digest, list and call counters, and the latest 64 call
receipts. Receipts contain tool names, acceptance flags and argument digests,
not raw arguments. A call counter counts dispatched calls including rejected
arguments; `acceptedCalls` counts valid echoes. Counters start at zero for each
process. Test results echo raw arguments, so use only synthetic values.

## Candidate identity and recorded evidence

Run the UI steps against the coordinator's combined candidate containing #585
and #589 plus its required security/lifecycle dependencies. Retain the exact
source SHA, build command and exit status, package/installer/container digest,
installed runtime version, dependency lock hash, OS, browser, viewport, language,
profile identity and fixture definition/run identity. A source checkout, an
in-memory SDK test, an installer that fetches unpatched `main`, or a successful
build is not an installed-candidate UI pass. Use the agreed #564 ledger format;
this checklist does not replace that evidence profile.

For each step retain observed result, relevant logs/receipt and screenshot or
recording. Record failures and blocked cases explicitly. Browser checks,
assistive-technology checks and human trials remain separate from these Node
protocol tests. Never copy the ephemeral control token into a shared receipt.

## Discovery, drafts and explicit execution

1. Connect the fixture, open **Inspect & test**, and open the tool selector.
   Find all 128 unique tools in order and select both `fixture_tool_001` and
   `fixture_tool_128`. Exercise keyboard navigation to the last tool. Check the
   first/last schema against the server response and keep the zero-call receipt
   before pressing **Test**. Repeat over stdio, Streamable HTTP and legacy SSE.
2. On tool 001, enter a synthetic URL and nested options such as
   `{"formats":["markdown"],"nested":{"marker":"draft-517"}}`. On tool 128,
   enter element/ref, an array, a nested object, enum and false boolean. Test
   each explicitly; verify the exact echo and one counter increment per Test.
   Discovery, opening the form, opening the App and prompt/resource inspection
   must not increment the call counter.
3. Edit the form after a successful Test. Include unfinished JSON such as
   `{"nested":` or `["Shift",`. Use **Refresh tools** in normal, delay and
   fail-second-page modes below. Verify text, selection, focus, scroll position,
   previous result and the App's visible **Mount** identity remain while the
   same server refreshes. Confirm the pending/error/stale status is visible and
   accessible. Repair the draft and Test; compare the actual echo with edits.
4. Repeat the failed refresh with cyclic pagination. No partial 32/64-tool list
   should replace the previously complete 128-tool list. Return to normal and
   refresh successfully. An explicit successful empty mode must clear the
   selector; cached tools must not masquerade as a successful empty response.
5. Save a second fixture server entry with a different server name. Switch to
   it with the same tool name: the first server's draft/result/App must clear.
   Switching away and back has a different identity from same-server refresh.
   Repeat the actual Firecrawl/Playwright report on the candidate separately
   if those provider configurations are available; keep its outcome distinct.

The App at `ui://feature-surface/receipt` displays a fresh mount UUID, initializes
with the host and shows tool-result notifications. It makes no tool requests and
loads no external assets. Verify its real iframe initialization and retained
mount identity in a browser; returning its HTML over MCP does not prove those.

Control the **fixture** using the token printed at startup (PowerShell):

```powershell
$fixtureUrl = 'http://127.0.0.1:9317'
$fixtureToken = 'paste-ephemeral-startup-token'
$fixtureHeaders = @{ 'x-fixture-control' = $fixtureToken }
Invoke-RestMethod "$fixtureUrl/control" -Method Post -Headers $fixtureHeaders -ContentType 'application/json' -Body '{"mode":"delay","delayMs":10000}'
Invoke-RestMethod "$fixtureUrl/control" -Method Post -Headers $fixtureHeaders -ContentType 'application/json' -Body '{"mode":"fail-second-page"}'
Invoke-RestMethod "$fixtureUrl/control" -Method Post -Headers $fixtureHeaders -ContentType 'application/json' -Body '{"mode":"cycle"}'
Invoke-RestMethod "$fixtureUrl/control" -Method Post -Headers $fixtureHeaders -ContentType 'application/json' -Body '{"mode":"empty"}'
Invoke-RestMethod "$fixtureUrl/control" -Method Post -Headers $fixtureHeaders -ContentType 'application/json' -Body '{"mode":"normal"}'
Invoke-RestMethod "$fixtureUrl/receipt"
```

Controls accept only JSON up to 64 KiB, known modes and delay 0..30000 ms. Host
and Origin guards restrict the local HTTP fixture; these checks do not qualify
FLUJO authentication, authorization, process isolation or resource budgets.

## First MCP agent and the remaining feature matrix

Follow the #589 guide from a disposable fresh profile: save a model, actually
test its answer, connect/save the fixture and explicitly test tool 128, then
create an Easy agent with that tested model and only the chosen tool. Try it
with a synthetic receipt task. Verify an actual tool result and assistant
answer; a saved entry, connection badge or echoed form is not agent completion.
A model double can check routing but cannot count as a real-provider or human
task pass. Measure the meaningful first-use pilot with Product fit's #577 tasks
and approved human protocol, independently of this synthetic task.

Retain Expert graph editing, debugger, HITL approvals, automations, MCP Apps,
proxy and OpenAI-compatible API access from the agreed feature matrix. Check
desktop and 360 px layouts, 200% zoom, keyboard and screen reader, all seven
languages, install/restart and retained upgrade configuration on the installed
candidate. Record real provider/tool journeys and existing-user regressions.
These steps need additional equipment/participants and are not asserted by the
fixture. External reassessment must evaluate the full #563/#564 profile before
Feature surface can be accepted at A-.
