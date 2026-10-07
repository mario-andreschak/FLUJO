# Read-only MCP reference workflows

This equipment supplies reproducible task-oriented onboarding and technical
operator checks for #577/#572. It contains **synthetic public data**, not an actual
inbox, project or website. It has no filesystem, shell, browser, provider, network
or write operation. It does not enroll anyone. An AI operator can run technical
checks; that does not establish independent adoption, novice usability or benefit.
The original [timed first-run card](tasks.md) remains unchanged.

## Connect once

Use a disposable FLUJO profile on the exact candidate selected by the release
owner. Record its source SHA, artifact identity, runtime, dependency lock, platform
and the actual install/start result. A failed or unsupported installed candidate
remains a failure; these scripts cannot qualify it. Record the fixture checkout's
separate full source SHA and lockfile identity. The scripts are source-side test
equipment and are not included in the app's npm distribution.

The fixture checkout needs its own complete lockfile dependency installation and
the candidate's supported Node runtime. In **Connected Apps → Connect App**, use
stdio with the absolute Node executable as command and one separate argument:

```text
C:/absolute/fixture-checkout/scripts/product-fit-pilot/reference-server.mjs
```

Do not embed shell commands or quotes inside argument entries. The server opens
no HTTP port. Stdout carries only MCP JSON-RPC; stderr reports its synthetic
process UUID and definition/data digest. It exposes three tools with read-only
annotations and strict enum parameters. Annotations describe this fixture; they
do not replace FLUJO's actual grants or isolation contract.

Inspect the tools and resource `fixture://product-fit/reference-receipt`. The
initial `toolCalls` must be zero. Discovery and resource inspection must leave
that count unchanged. Choose an already authorized model connection, actually
test it, and bind only the relevant reference tool to an ordinary Easy agent.
No paid call or external account action is authorized by this document itself.

## Three task cards

Each successful tool response contains a fresh `receiptPhrase`, the process
`runId`, definition digest, sequence and a `value` object. The phrase changes on
every call. Ask the agent to return JSON and include the phrases of the results
it actually used. A remembered answer without a matching fresh receipt fails the
mechanical check. A caller could construct the same JSON; retain the real model
trace separately rather than treating the phrase as proof of model origin.

| Card | Tool and required selections | Prompt / expected response shape |
| --- | --- | --- |
| Inbox triage | `product_fit_inbox`, `queue: weekly` | Read the weekly inbox through the connected tool. Select only open items marked urgent. Return sorted `ids` and `receiptPhrases`. Do not infer unseen items. |
| Project consistency | `product_fit_document`, `document: overview` and `document: deployment` | Read both project documents. Compare `minimumNodeMajor`, `port` and `storage`. Return only differing fields as `differences` with `field`, `overview`, `deployment`, sorted by field, plus both `receiptPhrases`. Do not repair a document. |
| Page comparison | `product_fit_page`, `page: catalog` and `page: status` | Read both captured pages. Select only IDs that are listed in the catalog and available in status. Return sorted `ids` and both `receiptPhrases`. These are captured synthetic pages; no live website is tested. |

The deliberate document inconsistency is fixture content, not a claim about
FLUJO's supported runtime. The cards exercise filtering, cross-source diagnosis
and corroboration. Their answers and all underlying data are public test content.

## Check the observed answer

For each attempt, retain the actual model reply and completed MCP trace privately.
Copy the tool's `structuredContent` or parse its JSON text response into
`toolResults`. Capture the receipt resource from the same process after the calls.
Insert the actual reply's JSON object into `answer`. Do not supply a corrected
answer when the model fails or omits a phrase. Preserve earlier failed attempts
and extra calls; the resource keeps cumulative counters.

This is an **empty packet template**, which fails until populated from an actual
attempt. It is not a passing observation:

```json
{
  "schemaVersion": 1,
  "workflow": "inbox-triage",
  "fixtureReceipt": null,
  "toolResults": [],
  "answer": { "ids": [], "receiptPhrases": [] }
}
```

Use `document-check` with `differences` instead of `ids`, or `page-compare` with
`ids`, for the other cards. Supply one result for each required selection; do not
duplicate a document/page to stand in for its missing counterpart. If reads were
repeated, include the exact results used by the answer and retain the complete
call receipt. Capture promptly: only the latest 64 calls are retained, with an
explicit dropped count. A dropped witness cannot pass, and this resource is not
a durable audit log.

```powershell
node scripts/product-fit-pilot/reference-check.mjs C:/private/reference-packet.json
```

Exit 0 means consistent fixture results/answer; exit 1 means wrong answer or
phrases; exit 2 means malformed, missing, stale or mismatched evidence. Input is
limited to 32 KiB. Unknown fields are rejected. Failures withhold submitted values
and file paths. The report includes the input and checker/data SHA-256 digests.
Call digests use recursively sorted object keys and preserve array order; they
describe JSON values, not raw transport bytes. The input checksum binds the
actual captured packet bytes separately.

The checker matches each selected tool result and phrase to the same run's call
digest, checks the current fixture definition and compares the declared answer.
Its scope is **synthetic result consistency**. It does not authenticate the
receipt producer, contact the model, establish the installed FLUJO identity, or
verify a human observation. Those claims remain explicitly false in its output.
Retain the actual operator run/source/artifact/model trace beside this report.

## Inspect control and reuse boundaries

Use the same configured server and record before/after resource receipts:

1. **Approval:** request a read with approval enabled. While waiting, counts must
   remain unchanged. Approve and confirm one accepted call and its fresh phrase.
   Repeat with Reject: no call may reach the fixture. Keep the actual decision
   and timing trace; a fixture counter alone cannot establish approval behavior.
2. **Debugger:** pause before a read, inspect the node, step/resume and compare
   counters and reply. Try a practice-only unsupported selection, retain its
   error, then correct it without losing the agent configuration. A dispatched
   invalid call increases `toolCalls`/`rejectedCalls`, not `acceptedCalls`.
3. **Reuse:** connect an authorized external MCP client through FLUJO's proxy to
   this same saved server. Use the current scoped auth/transport contract in the
   candidate [API guide](../../api-reference/README.md). Perform discovery and an
   actual call. Compare the same process `runId` and increasing call sequence
   across Talk and the external client; a second direct fixture process does not
   prove connection reuse. Never expose the listener or publish access tokens.

These are actionable operator steps, not assertions that the candidate passes.
Feature surface owns frontend/browser acceptance; Security owns the proxy grants;
release owners own artifact binding. Record failed and blocked boundaries with
their exact candidate rather than replacing them with these protocol tests.

## Keep practice separate from adoption

Any entry in the [pilot reporter](evidence-format.md) for these cards must use
`purpose: practice-fixture`. It cannot fill a recurring workflow/benefit target.
For real opt-in work, adapt a task shape to an actual recurring problem and freeze
that private protocol before measurement. Record actual successes, failures,
interventions, practical benefit and missing weeks under the agreed pilot. No
fixture count is a consenting person, elapsed week or external grade.

## Source checks

```powershell
node --test scripts/product-fit-pilot/reference.test.mjs scripts/product-fit-pilot/reference-server.test.mjs
node scripts/run-local-jest.cjs --selectProjects node --runInBand --runTestsByPath __tests__/productFit/referenceWorkflows.test.ts
```

The data/checker suite is dependency-free. The protocol suite uses this checkout's
installed real MCP SDK over in-memory and owned stdio transports. Its answers are
test-authored, not model responses. Normal Jest discovery runs both through a
small serial subprocess guard, rejecting zero assertions, skips and failures.
Coordinate local checks with the shared validation slot. No source test qualifies
an installed release, live provider, control/proxy journey or human pilot.
# Current-app synthetic rehearsal

Set `FEATURE_BROWSER_APP_DIR` to a compiled FLUJO checkout, then run `node scripts/product-fit-pilot/reference-journey.mjs`. The runner starts an owned app in an anonymous loopback profile, disables default connections, configures the local stdio fixture with an existing disposable working directory, discovers its tools, and invokes five reads through the current workspace-scoped tester API. It checks all three task packets against fresh receipts from the same fixture process and retains packets, report and app logs in the printed temporary directory. Shutdown is awaited even on failure.

Answers are test-authored. This rehearsal does not dispatch a model, prove human UI completion, exercise approval/debugger/proxy flows, or establish installed-artifact acceptance or recurring benefit.

Validation on the current compiled 3.46.3 app: all three tasks passed, discovery made zero tool calls, and the receipt ended with five accepted calls and no rejections. The 35 native checks and Jest bridge passed using an explicitly linked dependency graph with an identical package lock. The guarded local-dependency runner requires its own physical install; that runner was not claimed here.
