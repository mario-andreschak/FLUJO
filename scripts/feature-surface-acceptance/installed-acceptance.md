# Installed Feature surface acceptance packet for #563 / #572 / #517 / #526

This is the queued procedure for an AI technical operator on a qualified combined
release. Every row starts **unobserved**. Preparation, collected test cases,
synthetic receipts and passing source checks do not complete installed, provider,
human or external assessment requirements. Preserve the full #564 contract and
all advertised profiles. Security owns credentials, owner pairing and isolation;
the coordinator allocates the runtime/browser slot and selects the candidate.

## Admission: bind the actual candidate before running it

Retain the immutable release/package/image/installer digest, full source commit
and tree, lockfile/build inputs, build and publication receipts, the installed
bytes and version, OS/architecture, profile, startup epoch and owned process ID.
Verify the source-to-artifact-to-install correspondence with the release owner's
receipts. A checkout next to `.next/BUILD_ID`, an operator-supplied source SHA or
the observer's candidate-receipt SHA is only a declaration until independently
bound. Do not borrow another run's task UUID, process or runtime receipt. If the
producer emits no task identity, record it as unavailable rather than inventing
one. Retain the receipt's raw bytes and SHA-256 in the acceptance packet.

The combined candidate needs the product connection labels from #714, the
browser descriptor/nonblocking-read changes from #672/#680, the #693 first-use
equipment and #729 client with the separate observer content-binding successor,
plus the release owners' security and
lifecycle corrections. Check their actual presence on the selected source;
listing PR numbers does not prove inclusion. Source CI must be terminal and
qualified. Successful CodeQL execution does not accept an open finding or a
proposed false-positive disposition. Preserve failures, skips and exclusions.

At frozen #729 head `ef8a0c7716dbac5a2e0e7e098b3e10cd7dbe5db2`, Verify
[37181985653](https://github.com/mario-andreschak/FLUJO/actions/runs/37181985653)
failed ordinary tests (8,343 passed, one failed, 11 skipped), Windows installed
startup (`SnapshotStoreBusyError` / readiness timeout), and final verification.
The ordinary failure was `personaGoalDispatchFence.test.ts` with
`PlainFileReadError`. Its checkout merge
`5a190bb8170e08824464dcc31e7b5697a3f96dd9` and source head share tree
`0f39a6a147cfb15c2791b05a45a30f3b8b0d4a6a`. This candidate is not admitted.
The 22 native observer controls passed locally on that source; ordinary Jest
did not discover the `.test.mjs` file. The new Jest bridge is queued for CI and
does not repair either hosted failure.

Use one newly named evidence directory per attempt. Run each declared case once
with retries disabled. Preserve an unsuccessful attempt and its stopping
boundary; a subsequent authorized repaired-candidate attempt has its own identity
and never replaces the original. Stop dependent phases when admission, readiness
or cleanup fails. Do not start competing candidates or terminate peer processes.

## Equipment and the exact collected browser scope

Use a source-side equipment checkout that contains the selected combined
equipment and its complete lockfile dependencies. Point it at the admitted
installed application root; do not build or install during the acceptance slot.
The #693 browser runner rejects dotenv files, creates a fresh anonymous profile,
waits for its own private IPC startup handshake, joins initialization, disables
defaults and records the owned child's exit and drained logs. It starts its own
candidate process, so it cannot attach to an already running owner instance.
Allocate these runs serially. Its receipts explicitly leave source
correspondence unverified; bind each run to the admission packet separately.

```powershell
$env:FEATURE_BROWSER_APP_DIR = 'C:/absolute/admitted-installed/flujo-ai'
$env:FEATURE_BROWSER_SOURCE_SHA = 'FULL_SOURCE_SHA'
node node_modules/@playwright/test/cli.js test --config=playwright.features-first-use.config.mjs
node node_modules/@playwright/test/cli.js test --config=playwright.features.config.mjs
node node_modules/@playwright/test/cli.js test --config=playwright.features-online.config.mjs
```

The source SHA environment variable is a recorded declaration. These commands
require the #693 files; the #729 stack alone does not contain those configs.
Retain each JSON report, attached start/final environments, fixture receipts,
application logs, screenshots/traces, exit status and equipment commit/digests.
Move completed output to its unique evidence directory before another attempt;
the fixed report names must not overwrite an earlier receipt.

| Frozen #693 equipment | Collected cases | What the assertions actually cover | What remains open |
| --- | --- | --- | --- |
| `features-first-use/connect.spec.mjs` | HTTP and SSE, each desktop/360 px: four cases | UI enter/test/save/reload, associated labels, all 128 ordered tools, keyboard last tool, one explicit tool128 echo per case | No genuine model/agent; no stdio first-use; no complete refresh/App retention |
| `features/inspector.spec.mjs` retention test | Desktop/360 px: two cases | HTTP tool001 and tool128 echoes, unfinished JSON blocks Test, normal/delayed/failed/cyclic refresh retains draft/result/DOM/focus/App mount; authoritative empty clears; switch to SSE clears previous state and lists 128 tools | No explicit SSE call or full SSE retention repeat; no stdio browser retention |
| `features/inspector.spec.mjs` language test | Desktop/360 px: two cases | Seven rendered HTTP guide/selector languages with no implicit tool invocation | No linguistic or screen-reader assessment; no seven-language transport retention matrix |
| `features-online/firecrawl.spec.mjs` | Desktop/360 px: two cases | Actual public Firecrawl schema; seeded saved connection; drafts/DOM retained over nine five-second samples and manual refresh; client-side tester POST guard | No UI-created Firecrawl connection, scrape, global upstream call counter, model run or installed pass before actual execution |

The inspector's four cases are not four HTTP/SSE retention cases. The four
first-use cases were collected on the source, with zero executions at that
observation. Earlier source/browser passes stay bound to their historical
candidates. A seeded inspector or Firecrawl connection does not prove UI setup.

## Additional installed transport and Apps observations

On the owner-selected isolated profile, perform the [fixture procedure](README.md)
over **stdio, Streamable HTTP and legacy SSE**, on desktop and 360 px. For stdio,
configure the absolute Node command and separate argument entries through the UI;
add `--control-port=0` only when refresh controls are needed. Use the actual
child's printed loopback endpoint/token privately. The SDK deprecates SSE;
FLUJO's advertised compatibility still needs an actual observation.

For each transport and viewport, retain these boundaries separately:

1. UI connect, actual handshake test, save and reload. Inspect tools, resources
   and prompts; reach all 128 unique ordered tools and the last tool by keyboard.
   Keep the same-run zero-call receipt through discovery, schema/form inspection,
   prompt/resource inspection and opening the App. Record actual prompt/resource
   results; a zero counter alone does not prove their UI worked.
2. Explicitly test tool001 and tool128 with synthetic arguments. Check returned
   values, argument digests and exactly one newly accepted receipt per Test.
   Observe the real App iframe initialize with its mount UUID and receive the
   result notification; fetching its HTML is insufficient.
3. Edit scalar, false boolean, enum, array and nested JSON fields; leave JSON
   unfinished. Verify Test is blocked. Refresh in normal, delay, fail-second-page
   and cycle modes. Retain selection, draft, focus/scroll, previous result and
   the same initialized App mount, complete cached 128-tool menu, and accessible
   pending/error/stale status. Refreshing must add no tool calls. Repair the
   draft, explicitly Test and compare the edited values with the actual result.
4. An authoritative empty response clears the selector. Restore normal; switch
   to a distinct saved server with the same tool names. Verify old draft,
   result and App identity clear. Capture the next server's actual identity.

These rows fill the missing SSE/stdio coverage; they are not inferred from an
HTTP run. Keep actual ABAP (#526) and other provider-specific reports separate
from the synthetic 128-tool fixture. Repeat #517 against the actual public
Firecrawl form, including the unfinished nested draft through the 30-second
refresh interval. A keyless schema observation cannot establish a provider
invocation. Invoke a real provider only within its owner's allocated authority.

## Genuine model, UI-created agent, approval/debugger and reuse

Security provisions the authorized model/profile outside these scripts. The AI
operator uses **AI Setup / Connect AI** to configure and actually test an answer,
then the first-use guide to connect/test/save/reload/inspect the intended MCP
server. Record setup errors and prerequisites. Save an Easy agent through the
UI with that tested model and the selected tool; an API-seeded flow is a separate
observation. Record model/provider/adapter, exact saved server, flow and
conversation identities privately, with approved redacted receipt references.

Follow [live-journey.md](live-journey.md) exactly: attach the #729 observer to a
fresh ordinary conversation before first dispatch, then submit the task through
the UI. Observe a genuine selected-model dispatch, actual MCP call/result,
successful later model dispatch with that result in its archived input, a useful
assistant answer and completed run. Authenticate provider identity through the
owner's actual evidence and check the answer against the task. The observer's
`componentPassed` flag establishes exact full UTF-8 runtime/archive content
bindings and correlations, not semantic correctness or provider identity. The
successor requires the producer's full `resultContentBinding`; preview hashes,
same-ID wrong content, missing/duplicate bindings and unsupported wire content
remain incomplete. A previously qualified release without that producer field
does not validate the unpublished successor. Keep failures/capped runs/partial
streams as incomplete.

For the approved run, inspect the pending tool name, call ID and arguments;
approve through the UI, observe debugger pause at the actual tool boundary,
inspect and resume/step to completion. Retain UI actions, boundary events and
same-run accepted-call deltas. Then make a separately identified rejection
attempt: reject through the UI, verify a denied result, zero new executed calls
and useful continuation. The current observer's successful-run classifier does
not certify rejection. Exercise a harmless practice error, locate its cause and
repair it without losing unrelated configuration; retain the failed attempt.
AI-operated UI evidence does not establish a consenting human's identity or
understanding of the decision.

Run the actual [external MCP client](live-journey.md#actual-external-mcp-client-reuse)
against the same UI-saved HTTP/SSE server and still-running fixture process. It
discovers 128 tools and makes one explicit tool128 echo through FLUJO's proxy,
checking one new accepted receipt. Do not enable exposure, copy credentials or
start a second underlying fixture to fake reuse. This CLI supports the anonymous
loopback component; Security owns authenticated worker/shared adapters. Retain
client version, saved-server identity, proxy/auth contract and real transport
receipts. If the accepted journey uses the OpenAI-compatible endpoint instead,
use the release owner's supported client/auth and retain the saved agent's
actual model/tool/assistant trace. An idle/null observer is not an invocation.

Coordinate Product fit's #727 [reference workflows](https://github.com/mario-andreschak/FLUJO/blob/40b20ec871eae66114b0d8152b748d75b5f06235/docs/pilots/product-fit/reference-workflows.md)
through the coordinator, after those files are present on the selected equipment.
They use a separate stdio server and receipt resource, not the #729 HTTP echo
fixture. Triage, document comparison and captured-page checks need actual model
answers, same-process receipt phrases/digests and the reference checker against
the real private packet. A template, checker pass or synthetic rehearsal does
not establish adoption, weekly benefit or the consenting novice denominator.
Preserve the existing timed Card 1 and separately recorded controls/reuse cards.

## Full completion matrix and independent handoff

Record each original requirement as observed, failed, blocked or unobserved,
with candidate/profile/attempt identity and immutable raw references. Passing
one local component never fills another profile or an omitted feature.

| Original requirement | Required receipt after the procedure above |
| --- | --- |
| Published artifact/install | Source/build/publication/installed-byte correspondence and fresh install/startup/cleanup on every agreed profile |
| Configure/test real model | UI actions, actual tested answer and authenticated provider/model identity |
| Connect/inspect MCP | UI-created test/save/reload plus actual tool/resource/prompt inspection |
| Explicit tool test | Actual outcome and same-run call/argument/result identity |
| Create/run agent | UI-created saved flow, actual selected-model/tool/assistant journey and checked useful answer |
| Approve/debug | UI approval and rejection, real paused-node/tool inspection, step/resume and failure repair with execution deltas |
| External reuse | Actual authorized MCP or OpenAI-compatible client invocation through the same saved connection |
| Complex form #517 | Actual Firecrawl form retention on the admitted bytes; provider invocation stays separate |
| All tools #526 | Complete 128-tool keyboard reachability for each declared transport; actual ABAP evidence stays separate |
| Keyboard/labels/zoom/languages | Installed desktop/360 px, 200% zoom, keyboard, screen reader and linguistic review in all seven supported languages |
| Existing-user upgrade | Owner-selected previous-release profile, retained configurations/forms/history, migration and restart with regressions/failures preserved |
| Advertised feature matrix | Each advertised model adapter; MCP tools/resources/prompts/Apps; graph branches/loops/subflows; HITL/debugger; automations; v1/proxy, and useful prerequisite/error behavior |
| Consenting novice pilot | Accepted enrollment/denominator/timing protocol, actual novice outcomes, provisioning intervals and all interventions/drop-offs; the proposed 8 of 10 in 15 minutes remains unaccepted until agreed |
| Independent full reassessment | Named independent assessment of all nine scorecard dimensions and the complete profile matrix, with accepted evidence and unresolved findings retained |

Retain the original profile matrix: local-owner Windows installer/npm/pinned
source, Linux npm/source/container and macOS npm/source; worker Linux pinned
container/service and Windows pinned native service; shared-public Linux hardened
pinned container/service with authenticated ingress. Anonymous loopback runners
do not qualify worker/shared profiles. Technical execution is delegated to the
AI operator; the human and independent requirements remain open until their
actual agreed evidence exists. This packet requests no user technical testing.

After release owners bind the candidate and each operator records actual results,
reconcile them into the #564 ledger with immutable references. Run the repository
validator on the selected ledger, then its closure mode:

```powershell
node scripts/validate-scorecard.mjs C:/absolute/selected-ledger.json
node scripts/validate-scorecard.mjs C:/absolute/selected-ledger.json --closure
```

A structural pass is not a grade or source attestation. Closure exit 2 means
the structurally valid contract still has blockers; exit 1 means invalid
structure/references/checksums. External acceptance cannot be self-awarded by
this operator. All 14 requirements and all profiles remain open where their
actual receipts are missing.

## Queued source verification

The ordinary Jest bridge for the 34 authored native observer controls is at
`__tests__/featureSurface/liveJourneyObserver.test.ts`, within the node project's
existing discovery glob. It requires the named
positive/negative cases, matching pass/test counts, no failures/skips/cancellations
or todos, and bounded child execution. It passes only a small system-environment
allowlist to the pure suite. Its own execution is queued under the coordinator's
resource allocation; do not describe the earlier native pass as a bridge pass.

```powershell
node scripts/run-local-jest.cjs --selectProjects node --runInBand --runTestsByPath __tests__/featureSurface/liveJourneyObserver.test.ts __tests__/flow/processToolCallsConcurrency.test.ts __tests__/flow/processToolCallsCapture.test.ts
```
