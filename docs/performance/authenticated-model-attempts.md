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

This bounds one logical call to at most one physical SDK transport attempt. A
new Process/tool-loop turn or a new authorized call needs its own original owner
budget/identity handling. The policy does not make a whole multi-turn Flow a
single inference, stop an already completed remote side effect, refund spend or
prove OFF propagation at an original live endpoint.

A lost response remains an unknown remote outcome requiring reconciliation.
Provider errors propagate; absence of a response is not proof that inference was
not executed. A durable SDK intent marker can also precede an authority failure
that blocks network dispatch; the marker alone is not a physical HTTP receipt.

## Source verification and adoption

`__tests__/executionExtensions/singlePhysicalAttempt.test.ts` uses the real
installed OpenAI SDK with default client retries and an unpaid loopback HTTP
server. Physical POST counts are independent of the SDK observer. It exercises
HTTP503, lost responses after POST arrival, HTTP307/308 redirects, stream startup failures, cache-option
rejection, forged/copied authority, policy replacement/revocation and owner
cancellation. ModelHandler tests retain the ordinary seven-attempt empty-stop
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
