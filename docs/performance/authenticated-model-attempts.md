# Authenticated one-physical-attempt model calls

The FACTORY APP549 handoff identified nested inference replay in FLUJO's
OpenAI-compatible path. `createOpenAIClient` defaults to two SDK retries, while
`withTransientRetry` permits three SDK invocations. Cache-option negotiation and
ModelHandler rate-limit/empty-response recovery can send further requests.
These defaults remain for ordinary interactive calls. The
[official OpenAI retry guidance](https://developers.openai.com/api/docs/guides/rate-limits)
requires accounting for SDK retries when layering application retries.

## Version 1 owner contract

The authenticated execution-extension adapter may implement:

```ts
modelAttemptPolicy(context, modelIdentity) {
  // Original owner verifies its current bound request, model/endpoint,
  // identity/account, original lease, OFF state and original budget reservation.
  // This is a read-only check: FLUJO may query it repeatedly for one call.
  return { version: 1, maxPhysicalAttempts: 1 };
}
```

This hook is resolved only from the current branded
`ExecutionExtensionContext`, through its registered trusted adapter. The model
identity contains `id`, `name`, `adapter`, `provider` and `baseUrl`, without an API
key. Public request metadata, a Model property, a copied policy, a serialized
context or a copied ledger cannot establish this authority. Invalid policies,
replacement adapters, revoked/expired contexts and changed policies fail before
network dispatch.

The hook restricts retries; it never grants inference/spend authority or books a
budget. FACTORY/O retain original request/digest identity, account, lease,
reservation, capture coherency, OFF and outcome reconciliation. An owner must
bind and verify those using its actual original authority before adopting the
hook. Returning a source boolean or querying a copied budget is insufficient.
The hook can run at ModelHandler entry, adapter entry and again after the durable
SDK marker callback, immediately before the SDK request. It must not debit or
reserve on every policy query. Original per-call booking remains owner work.
Once this context observes a valid v1 policy, that restriction is sticky for
the context: a later `undefined` policy is denied before an ordinary client can
be constructed. The owner must mint a fresh context for a different step rather
than changing one context back to ordinary transport during preflight.

The same opt-in path requires `claimModelRequest(context, intent)` in a private
fetch wrapper, after the installed SDK has chosen its actual URL, method,
headers and JSON body and before Undici is called. The adapter detaches the
provider-native body first. The fetch wrapper rejects any URL or body different
from those detached expectations, any method other than POST, an altered bearer
credential, a non-JSON body, redirects and unexpected request or header fields.
Protected client construction bypasses the overridable `createClient`; it uses
an explicit base URL, ignoring `OPENAI_BASE_URL`. An omitted model base URL is
pinned to `https://api.openai.com/v1`. Plain HTTP is allowed only for literal
loopback addresses. `OPENAI_CUSTOM_HEADERS` cannot silently change Authorization
or introduce an unknown routing header.

The owner receives the SDK-final URL, method, model identity, operation,
SHA-256 of the exact UTF-8 JSON body, SHA-256 of the effective Authorization
header and SHA-256 of JSON-encoded, lower-case, name-sorted SDK-final header
pairs. A closed projection also gives SHA-256 or explicit absence for
OpenAI-Organization, OpenAI-Project, HTTP-Referer and X-Title. The owner must
compare the URL, method, body, credential and this routing/account projection
with its original authority, as well as checking lease, OFF state and budget.
The full-header digest can support stricter exact matching when the owner pins
the SDK/runtime's dynamic X-Stainless headers. The digests contain no raw
credential or prompt. A missing or rejected claim prevents Undici dispatch.
FLUJO consumes the branded context before awaiting this callback, so one process
cannot reuse it for a second fetch, even after a failed claim or unknown remote
outcome. The callback must perform the original owner's durable cross-worker
compare-and-swap; FLUJO's in-memory consumption is not a durable claim and does
not prove that the provider received the request.
Unknown callback errors become a fixed denial instead of exposing their message;
trusted execution-extension denials retain their error code.
`configuredExecutionAdapter` is still undefined in generic FLUJO. No FACTORY
issuer or claim implementation is wired by this source change, and ordinary
calls retain their previous request options and retry behavior.

The protected v1 path qualifies the resolved concrete route, using the same
selector as `getCompletionAdapter`: only OpenAI Chat Completions is supported.
Gateway profiles that resolve to Responses and OpenRouter's image/video-only
routes fail before their native sends, including their direct adapter entries.
ProcessNode also checks owner policy before its legacy OpenRouter tool-capability
catalogue lookup, which reloads the saved model, decrypts its credential and
can fetch provider metadata before ModelHandler runs. Branded contexts skip
this optional lookup entirely, since the reloaded model might differ from the
one just checked. A protected, unsupported route denies at that preflight;
execution-extension denials propagate out of ProcessNode.
For an ordinary branded context with unknown tool support, skipping the lookup
can mean one failed tool-bearing call followed by the existing tool-free
fallback. Unbranded ordinary runs keep the catalogue optimization.
Before protected Process preparation renders a prompt or discovers tools, it
rejects MCP nodes bound to any server other than the owner-selected server and
consume-role resource nodes that read an external MCP server. Protected prompt
rendering rejects resource pills before they can connect or read, while
run-scoped resource nodes carry the execution context into their authority
checks. Discovery for an allowed protected server skips node-root updates:
rebinding a node ID could otherwise notify its previously bound foreign server.
Selected MCP Skills are denied because their loader can connect to its server
before checking conversation approval; native resource discovery is skipped.
The admitted MCP/resource bindings are frozen copies of node parameters, and
discovery rechecks the owner and selected server at connection. Direct protected
model dispatch requires the admitted bindings. Protected prompt composition
also leaves mutable cross-run KV references unresolved. Protected handoff
descriptions use local target labels without querying another node's MCP server
status. Protected tool presets are denied before their shared-global,
conversation or file references can be resolved. Protected MCP connections
carry the run context through setup, recheck it and the stored recipient before
the handshake, and close a new client if post-handshake validation fails.
Contextless managed `connectServer` calls and tool inventory for the protected
server are denied. Listing and tool dispatch require a client stamped for the exact
resolved config; dispatch rechecks the owner and recipient before readiness,
tool listing and the final SDK tool call. A changed recipient fails closed
instead of retrying a side-effecting call. These are process-local checks:
in-flight handshakes cannot be undone, and concurrent config/authority changes
need an owner-controlled transport or lease for a physical guarantee. The
separate host `testConnection` probe, Static MCP node roots updates and
separately running host processes still require
process/config isolation for a whole-host confidentiality claim. A mutable
OAuth token stored in the server config can also change the exact fingerprint
during a handshake and make a protected connection fail closed; the owner must
pin an approved credential/recipient identity before adopting that transport.
ModelHandler requires the qualified route again when it constructs the adapter
after asynchronous request preparation; the OpenAI adapter rechecks before its
SDK call. The claim also checks that its registered adapter is still current
after owner I/O and at the local SDK entry. Other exported native adapters do
not constitute a universal direct-call physical fence; protected adoption must
use the qualified ModelHandler route.

A branded context whose owner has never returned `modelAttemptPolicy`
deliberately uses ordinary transport. FACTORY must return v1 or deny every
protected model step.
The direct `/v1/chat/completions` model-service route has no execution context;
FACTORY must fence protected credentials and models at ingress or isolate them
before adoption.

The fetch wrapper snapshots the SDK's final `fetch` Headers and passes those
same cloned headers and body bytes to pinned Undici. Undici can still add Host,
Content-Length or encoding headers and resolve DNS/TLS afterward; the digest is
not a transcript of physical wire bytes. After the owner claim, FLUJO checks
the current registered adapter, owner run state and both cancellation signals
before invoking Undici. If cancellation arrives during the claim, no POST is
started and the consumed claim stays spent/unknown. A lease can still be revoked
after this last check or while transport is running. Continuous physical OFF
requires an owner-controlled outbound proxy or credential revocation, beyond
this process-local pre-fetch gate.

The direct `/v1/chat/completions` model route and other saved-model users can
decrypt ordinary `Model.ApiKey` records without this execution context. Before
protected adoption, FACTORY must isolate protected model catalog entries and
hold their credentials in an owner-controlled broker. That broker must cover
direct model completions, model connection tests, embeddings, fallback members,
flow generation, MCP sampling and other key resolvers. The final-fetch guard
alone cannot protect a key still available to those routes.

## Enforced request behavior

For an attested call through the `openai` Chat Completions adapter:

- SDK request options set `maxRetries: 0`.
- Fetch redirects are rejected so HTTP307/308 cannot resubmit the inference POST.
- The response-body/transport retry wrapper sets `maxAttempts: 1`.
- Cache-key and explicit-cache-control negotiation do not replay the request.
- ModelHandler rate/session-limit and empty-response retries are disabled.
- Restricted contexts already skip reactive context-overflow replay.
- Fallback policies and unqualified native/other adapters are rejected before
  dispatch rather than promising an unverified physical-attempt limit.
- The current owner policy is rechecked after archival; its AbortSignal is
  combined with the ordinary caller signal at the SDK boundary.

This bounds one claimed logical call to at most one local SDK fetch invocation. A
new Process/tool-loop turn or a new authorized call needs its own freshly minted,
coordinator-backed context and original owner budget/identity handling. The
current run-level context is reused across turns, so protected multi-turn Flow
adoption must add that per-step issuer before this opt-in gate can be enabled.
The policy does not make a whole multi-turn Flow a
single inference, stop an already completed remote side effect, refund spend or
prove OFF propagation at an original live endpoint.

A lost response remains an unknown remote outcome requiring reconciliation.
Provider errors propagate; absence of a response is not proof that inference was
not executed. A durable SDK intent marker can also precede an authority failure
or denied claim that blocks network dispatch; the marker alone is not a physical
HTTP receipt.

## Source verification and adoption

`__tests__/executionExtensions/singlePhysicalAttempt.test.ts` uses the real
installed OpenAI SDK with default client retries and an unpaid loopback HTTP
server. Physical POST counts are independent of the SDK observer. It exercises
HTTP503, lost responses after POST arrival, HTTP307/308 redirects, stream startup failures, cache-option
rejection, forged/copied authority, policy replacement/revocation and owner
cancellation, including policy downgrade between ModelHandler preflight and
adapter entry. It also checks the SDK-final URL/body/header claim, subclass
rerouting, ambient URL/header overrides and an owner abort during a pending
claim. ModelHandler tests retain the ordinary seven-attempt empty-stop
behavior while verifying one attempt for restricted empty/rate-limit failures.

The ordinary control intentionally observes two physical requests behind one
SDK invocation marker. The existing SDK observer captures adapter/SDK method
invocations, not every hidden SDK network retry. A comprehensive ordinary-mode
physical-dispatch archive audit remains a separate maturity gate; this contract
does not silently redefine an SDK marker as proof of a physical attempt.

Before deployment, FACTORY must adopt this hook in its authenticated adapter,
bind the actual native APP549 model/endpoint and original per-call budget, and
retain exact backend/adapter/artifact pins. Qualify lost-response uncertainty,
OFF and ownership with the original controller and provider receipts. The
failed R5 Windows metadata receipt and partial native Flow evidence remain
historical failures/partial evidence; a source fixture cannot repair them into
a live qualification pass. No paid inference or original controller mutation is
performed by these tests. Root owns integration order and deployment.

#569 whole-process runtime memory, event retention,
slow-consumer/admission/queue budgets, original #520 provider confirmation,
Persona/live/manual gates and independent A- reassessment remain open.
