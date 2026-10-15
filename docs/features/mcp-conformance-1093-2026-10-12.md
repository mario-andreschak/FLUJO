# MCP conformance adapter qualification — October 12, 2026

Scope: existing [#1093](https://github.com/mario-andreschak/FLUJO/issues/1093) and
[#1050](https://github.com/mario-andreschak/FLUJO/issues/1050). Base faaf86c54cc1bec42d8b614f886e7c4a6a6b242b,
FLUJO 3.46.3, Windows x64, Node 22.23.3, SDK 1.32.1 / split SDK 2.3.1,
Tasks 0.2.2 / Apps 2.0.3. No dependency or protocol-wire upgrade is part of this batch.
Local command results and exact candidate revision are recorded in the delivery PR
and lane08 handover. Source/fixture evidence is distinct from release qualification.

## Adapter repairs

| Finding | Corrected source behavior | Focused evidence |
| --- | --- | --- |
| AUTH-1/2 | Bind discovery/expected issuer to the nonce; compare `iss` exactly before errors or exchange; require it when RFC9207 support is advertised. Pin original discovery during exchange. Preserve OIDC extra metadata before SDK parsing. | GET/POST mismatch, missing/optional/exact issuer and zero exchange assertions; retained issuer-bound credential regressions. |
| AUTH-3 | DCR includes native application type for loopback callbacks, web for hosted callbacks. Existing encrypted credentials and issuer binding remain. | Provider metadata and issuer-bound SDK discovery/refresh fixtures. Genuine provider exchange remains release pre-flight. |
| SAMPLE-1 | Minimum of requested/policy/model token caps; length completion maps to `maxTokens`. Refuse CLI/fallback models that cannot enforce an output-token bound. | Adapter request capture at 16/32 tokens and stricter 8-token policy; refusal before key/provider use. Eight actual built-app OpenRouter Free Responses cases now verify live bounds and stop reasons through legacy and modern MCP; see the sampling receipt below. |
| ARGS-1 | Preserve explicit null, omit undefined object members, reject non-JSON/accessor/cyclic/sparse-array data without guessed defaults. | Nested/null/prototype-sensitive key fixtures. |
| ERR-1 | Preserve SDK1/split-SDK/extension JSON-RPC code/data. Recognize local request timers separately; keep operational `isError` results. | Equivalent errors, proxy error propagation and timeout regressions. |
| TASK-1 | Bounded initial MRTR to immediate result or task, exact opaque state, fresh IDs, attended input, cancellation and no ambiguous retry. | Actual split-SDK negotiation and native Node ESM coexistence; input-to-immediate/task and abort fixtures. |
| TASK-2/3 | Schema parameter headers with safe encoding; JSON output validation on immediate/completed/restarted task results. | Header option capture, scalar/array/object schema cases, terminal bookkeeping/restart and existing generation regressions. Real localhost strict reference HTTP now confirms required method/name and encoded parameter framing; missing/mismatched headers reject 400/-32020 before effects. |
| LIST-1 | Complete resources/templates/prompts catalogs across opaque/empty pages; repeated cursors/page cap fail. Explicit proxy catalog cursors return one page with continuation. | Catalog and transparent proxy fixtures; existing complete tool discovery retained. |
| EVENTS-1 | Split-SDK catalog options open acknowledged modern listen streams and invalidate caches. URI-specific resource listens deduplicate and retire with their generation. | Filter/deduplication/late acknowledgment/retirement fixtures, plus actual production localhost HTTP acceptance in both SDK generations. The subscription receipt below records cache invalidation, correlated updates, reconnect and teardown. Hosted/multi-process profiles are not inferred. |
| CANCEL-1 | Ordinary route/proxy carries abort and correlated progress. SDK/raw dispatch has a total deadline independent of progress resets. | Route/proxy signal assertions and existing SDK timeout checks. Downstream real effects cease only to the extent the provider supports cancellation. |

## Supported deployment boundaries

| Surface | Protocol/transport | Extensions and qualification boundary |
| --- | --- | --- |
| Default SDK1 client | Legacy stdio, SSE, Streamable HTTP, application WebSocket | Retained legacy negotiation; full catalogs, trust policies and optional Apps/Skills. Not a 2026-07-28 claim. |
| Protocol-beta split client | HTTP auto discovery with specified legacy fallback; stdio deliberately legacy | Modern remote Tasks are separately gated; roots/sampling deprecated but retained; Skills and Apps only per-server opt-in. Modern-only stdio is deliberately unsupported until process-owned lifecycle qualification. |
| Bundled standalone servers | Existing SDK1/process-owned profiles | This batch changes no native Source, package runner, consent or execution authority. Lane04/#905 owns that integration. Installed artifacts require release proof. |
| Flows ingress | Legacy synchronous route; strict modern HTTP when protocol-beta or Tasks serving is enabled | Modern routing headers are mandatory. Core serving does not require optional Tasks. Explicit owner bearer/workspace admission and per-task policy remain. |
| Per-server proxy | Legacy sessionless HTTP | Tools/resources/templates/Apps/Skills forwarding, complete default inventories and explicit catalog cursors. No advertised modern/Tasks serving; no blanket modern conformance. |
| Skills | Final SEP-2640 transport shapes under local opt-in, both client generations | Direct URI retrieval, SHA256/frontmatter verification, 512 files/16MiB, scoped consent retained. Dynamic skills and unsupported URI shapes remain explicit host restrictions. Nested supporting files do not inherit activation authority. |
| Apps | 2026-01-26 wire on Apps 2.0.3 | Outer separate-origin iframe has `allow-scripts allow-same-origin`; inner permissions/CSP remain consented. The SDK version alone does not qualify the integrated browser journey; candidate browser acceptance remains release pre-flight. |

## Remaining release acceptance

#1093 remains open for identified candidate/provider/browser/installed acceptance.
Real OAuth, Apps browser
origin/CSP/consent/teardown and installed Windows/Linux profiles belong to release
pre-flight under the current pause. Existing #404 evidence stays credited only for
unchanged inputs; changed adapter inputs require applicable requalification. CIMD is
recommended optional interoperability work, not a mandatory core closure gate.

#1050 remains open. Its preserved first private-set read refusal has no causal
phase/role/errno/cancellation record. Later aborted executable inspection does not
establish the first cause. The genuinely protected Windows installed pass on 63e5a47e
and merged #1056 diagnostics remain valid historical evidence, without claiming a
causal repair. Do not repeat that expensive install without a release candidate/new
relevant failure. The next refusal needs the existing opt-in redacted diagnostics;
never weaken privacy, consent, source-change refusal or deadlines.

Normative references: [authorization](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization),
[sampling](https://modelcontextprotocol.io/specification/2026-07-28/client/sampling),
[MRTR](https://modelcontextprotocol.io/specification/2026-07-28/basic/patterns/mrtr),
[subscriptions](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/docs/specification/2026-07-28/basic/patterns/subscriptions.mdx),
[Final Skills](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/b0a66b133ddfaf193a70b526a31bc2aa7172f28a/seps/2640-skills-extension.md).


## Qualified local candidate

Local typecheck/lint and the inspected non-container application build passed after
integrating main faaf86c5. Build identity: `6UU1lU3ueuYbe0h55mQCH`. 18 focused
suites/203 checks passed; affected roots/error serialization and transparent SDK1
cursor/cache checks were rerun and passed (68 and 40 checks respectively).

The actual owned production app completed first workspace setup, connected an actual
SDK1 HTTP reference server, returned complete resources/templates/prompts across an
empty middle page, and preserved null ownerId/message. A continuously progressing
request returned 408 at its total deadline; ordinary and proxy HTTP disconnection
propagated cancellation. Reference server recorded 3 starts, 3 cancellations and 0
completed effects. Separate split-SDK 2.3.1 HTTP negotiation/framing verified correct
method/name/encoded parameter headers, explicit null, array schema validation and
missing/mismatched header rejection with no additional effects. These localhost
reference results are source runtime proof, not installed/provider/browser certification.

Sanitized [built-app receipt](../audits/evidence/mcp-conformance-1093-2026-10-12/built-app.json)
and [HTTP wire receipt](../audits/evidence/mcp-conformance-1093-2026-10-12/http-wire.json)
retain the checked assertions without credentials or fixture paths.

## Built-app Tasks recovery — October 14, 2026

The existing production Tasks smoke now verifies live owner-credential revocation
while an authored Flow is waiting on a loopback provider request and a second task
is waiting on confirmation. The production private-policy writer revokes the
credential atomically. The active request closes, both records fail with
`TASK_AUTH_REVOKED`, both execution leases settle, and private payloads are removed.
Get, update, cancel and new tool calls return HTTP 401. The remaining valid
credential cannot retrieve either task. No confirmation or work is replayed.

The first attempt stopped at the private-file guard: the smoke issuer's policy
file inherited Windows ACLs rather than carrying explicit file protection. The
fixture now issues its policy through the existing private atomic JSON writer;
focused source/compiled-issuer regressions verify private read and revocation.
The failed attempt is retained in the receipt and has no acceptance credit.

The same actual built application also verifies completed encrypted results after
process restart, `TASK_INTERRUPTED` without replay, duplicate confirmation inputs,
decline without generation, cancellation, workspace/credential isolation, and
legacy/disabled-feature behavior. Its sanitized machine receipt is emitted only
after application closure and verified deletion of the owned runtime/authority
directories. See the [exact-tree qualification and sanitized protocol statuses](../audits/evidence/mcp-tasks-recovery-1093-2026-10-14.json).

This advances the local Tasks portion of #1093 using a private loopback model
fixture and zero external provider calls. Genuine provider/OAuth behavior, deployed
subscription correlation, Apps browser behavior and installed Windows/Linux
qualification remain release pre-flight; this source-tree result does not replace
those profiles. Existing unchanged focused regression evidence remains credited.

## Live sampling token bounds — October 14, 2026

The existing sampling implementation is now qualified against genuine OpenRouter
Free inference through the current Responses adapter. The production application
was built from unchanged application inputs at `ed5e573f`; only reusable acceptance
equipment and evidence were added. Both the SDK1 sessionful HTTP reference server
and the split-SDK modern HTTP/MRTR reference server request text sampling through
FLUJO's saved, explicitly enabled server policies.

For each generation, request, policy and saved-model caps independently constrain
generation to 32, 24 and 16 tokens. The relay verifies the actual outbound
`max_output_tokens`; provider-reported output tokens fit each cap. Responses
`incomplete/max_output_tokens` becomes MCP `maxTokens`. A separate short answer
completes naturally and becomes `endTurn`. All eight cases pass. Two HTTP429
responses recover through ordinary retries of `openrouter/free`; ten requests
produce eight successful generations, with no model fallback and reported cost
zero for every successful generation.

The real credential is read from one existing encrypted account using canonical
read-only format functions, held in relay memory, and sent only to the exact
OpenRouter HTTPS endpoint with redirects refused. FLUJO saves only a synthetic
relay credential in a fresh private workspace. The owned application exits and
its private workspace/authority directory is removed before success is emitted.

Four initial equipment attempts wrongly expected Chat Completions, while the
current OpenRouter profile resolves that saved adapter to Responses. The relay
refused them before any external call; all four have zero acceptance credit and
verified private-profile cleanup. The corrected equipment uses the actual
Responses route. No production behavior was changed to satisfy the smoke.

The [sanitized exact-tree receipt](../audits/evidence/mcp-sampling-1093-2026-10-14.json)
records all caps, statuses, provider usage, retry counts, local checks and the
failed equipment attempts. The non-container application build took 329.275s;
the final script lint plus live runtime took 89.521s, measured separately. Prior
focused regressions remain valid for unchanged application inputs. This completes
the missing live sampling token/stop check for this profile. It does not qualify
other providers, sampling with tools, genuine OAuth, deployed subscriptions,
Apps browser behavior or installed artifacts. #1093 remains open for the existing
uncompleted acceptance listed above. No full/remote CI, container/image build,
installed/packed or release suite was run.

## Production HTTP subscription lifecycle — October 14, 2026

EVENTS-1 now passes on an isolated production localhost application connected to
actual SDK1 sessionful HTTP and split-SDK modern HTTP reference servers. Four
authored Flow executions read a bound MCP resource through the real engine. The
only model is a synthetic loopback fixture; there are zero external provider calls.

Both generations deliver catalog changes and subscribed resource contents, then
retire their streams when the server is disabled. Re-enabling a server delivers
one catalog version change, with current tools, prompts, resources and templates.
The modern reference advertises a 60-second private cache: repeated reads prove
the catalogs and resource contents are cached before notifications evict them.
Two reads reuse one URI listen stream; its acknowledgment is first and echoes the
requested filter. Unwatched URIs are excluded. An injected retired URI subscription
ID cannot advance the replacement generation's catalog version. The final modern
bus, modern streams and legacy SSE streams all have zero remaining listeners.

The read-only IPC observer runs only in the smoke child and its private acceptance
workspace; no HTTP inspection route or product behavior is added. Application
closure and private profile removal precede the success receipt. The reusable
command is `node scripts/smoke-mcp-subscriptions.mjs --production`, after the normal
non-container application build, executed through flujo-bash MCP for cleanup.

The [exact-tree receipt and sanitized protocol traces](../audits/evidence/mcp-subscriptions-1093-2026-10-14.json)
record SDK/runtime versions, filters, acknowledgments, cache assertions and local
validation. This qualifies the source production localhost profile, using reference
servers, for the existing subscription requirement. Hosted/multi-process deployments
are outside this qualification. #1093 remains open for its existing OAuth, Apps
browser and installed release requirements. No full or
remote CI, packed/installed suite, container build or release workflow was run.


## October 15 Apps browser qualification and safe-link repair

APP-1 now has browser evidence for the **source production localhost Tool Tester** profile with the local CSP exception below: SDK1 sessionful HTTP at 1440px and split-SDK modern HTTP at 390px, using Apps 2.0.3, Next 16.4.1, React 19.3.1 and Edge 155.0.4283.45. The actual View waits for initialization, receives input before its result, calls the same-server app-visible tool and reads its resource. Model-only and foreign-server calls stop before effects. A 403 retires the View; ordinary Test tool retry opens a fresh one. A 404 stays recoverable. Separate server identities receive distinct sandbox origins and cannot read the host DOM.

The browser exposed a real safe-link defect: the destination opened with a null opener, but FLUJO returned isError:true because noopener intentionally returns a null WindowProxy. The handler now acknowledges the validated dispatch without misclassifying that null result; URL checks and noopener/noreferrer remain. Both generations verify the opened destination and null opener, reject javascript: links, and verify the downloaded filename and exact contents. Browser popup-blocker detection cannot be inferred from a null handle.

Declared connections work; undeclared-host connection/frame attempts are blocked before their healthy listener receives a request. The existing loopback policy deliberately normalizes declared ports to a hostname-wide grant. The acceptance probe uses localhost as the undeclared hostname while only 127.0.0.1 is granted; exact-port isolation is not claimed. Reserved readiness injection cannot replace the live bridge. Revocation blocks calls before effects, gracefully retires the View, and re-enabling/remounting creates a fresh bridge. Closing with real pending tool work aborts it in both SDK generations; no wait remains. The host fits the recorded phone viewport. No permissive sandbox setting was enabled.

[Exact-tree receipt and sanitized browser/protocol observations](../audits/evidence/mcp-apps-browser-1093-2026-10-15.json) bind tested tree 8016eaa3da344b9c230f6f994b9cdf28bd5e2fd6, local typecheck/lint/non-container build, 37 focused frame checks, original failing safe-link proof and successful browser/profile cleanup. Zero external provider calls were made. Earlier equipment failures are retained without acceptance credit.

This advances APP-1 for the measured profile, not full conformance or #1093 closure. The stable specification defines CSP entries as origins and forbids loosening. Automatic fixed-port-to-wildcard expansion remains unfinished implementation work under #1093; its repair must preserve the existing ephemeral-port restart regression. Genuine OAuth, hosted/installed Windows/Linux identities and release-level combined qualification also remain open. Chat/canvas-specific embedding, optional per-resource click policy, permissive settings and independent human accessibility are not inferred. No full/remote CI, packed/installed suite, container/image build or release workflow ran.


## October 15 exact-port enforcement and restart recovery

The later #1093 repair supersedes the loopback widening exception described in the
previous entry. Fixed ports remain exact in initialized capabilities, the sandbox
response header and the inner policy. Port wildcards survive only when a resource
explicitly declares them. The existing localhost/network gate, public restrictions,
scheme validation and injection protection remain covered.

**Reload app** provides recovery when an ephemeral runtime moves to a new port.
It completes bounded teardown, cancels pending work, re-reads the current resource
and endpoint, and creates a fresh proxy/View under the same App origin. It never
reruns the opening tool. Loading disables duplicate reloads; a failed read retires
the old View, shows an error, and permits retry. The localized control has a 44px
minimum height; the inline header wraps on narrow screens.

[Exact-tree evidence](../audits/evidence/mcp-apps-exact-ports-1093-2026-10-15.json) binds the
source and equipment tree, application/dependency hashes and build ID. Nine new
port assertions failed on base 9c1e8d22; the repaired focused batch passes all
117 checks in five suites. Local typecheck/lint and the inspected non-container
five-MCP/Next application build pass (322.020s). The actual production
Tool Tester passes SDK1 sessionful HTTP at 1440px and SDK2 modern HTTP at 390px:
two real runtime listener restarts each, declared fetch/frame/image access,
same-host undeclared/retired-port refusal before listener effects, initialized
policy parity, fresh View identity, unchanged sandbox origin, pending cancellation,
no tool rerun, and failed-read retry. Previous initialization/tool visibility,
resource/link/download, revocation and teardown checks remain in the browser run.
Script lint plus browser runtime measured 32.978s; app,
browser, reference listeners and private profiles close before success. There
were zero external provider calls.

This qualifies the measured source profile. Genuine OAuth and separate hosted/
installed Windows/Linux and combined release qualification remain open; #1093 is
not closed. No full/remote CI, container/image build, installed/packed suite or
release workflow ran. Prior unchanged Skills/Tasks/sampling/subscription evidence
retains its scope.
