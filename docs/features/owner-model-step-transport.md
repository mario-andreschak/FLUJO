# Owner model-step transport (source-only v2 contract)

An owner-bound `Model` stores an `ownerCredentialBinding` (`ownerId` and
`credentialId`) and an empty `ApiKey`. The binding names a credential held by the
execution owner; it is neither a credential nor permission to send a request.
FLUJO currently supports this source contract only through the OpenAI-compatible
Chat Completions route. A bound model needs a branded execution context from the
trusted adapter, and `issueModelStep` must mint a fresh private child for **each
logical model call**. A child is consumed before owner I/O and cannot be reused
after a denial, failure, or uncertain outcome. Tool loops and later Process
turns need new children and new owner budget decisions.

At the OpenAI SDK's final `fetch` seam, FLUJO checks the resolved recipient,
method, JSON body, and headers, then passes their snapshot and digests to
`dispatchModelRequest`. The SDK's construction-only bearer placeholder is
removed: the owner receives the SDK-final request **without Authorization**.
The bound credential never enters the FLUJO model record or its provider fetch.
For this path, the owner callback must supply the credential and perform the
physical send; FLUJO does not open the provider socket. The callback returns a
`Response` to the SDK for ordinary response parsing, including streaming.

Before sending, the owner must authenticate the original task and graph, the
fresh child and original lease, current OFF state, bound model and exact
recipient, effective headers and body, selected account and credential, and
the budget for this **specific step**. It must durably claim that step with a
cross-worker compare-and-swap before any physical send. A claim or SDK intent
marker alone is not a provider receipt. A lost response or ambiguous send stays
unknown until reconciled; it must not become an automatic retry or a free new
step. For a stream, the owner must account for the full response lifecycle,
including completion, abort, disconnect, and provider-side failure, rather
than treating the initial HTTP response as completed inference. The owner also
needs to serialize physical sends with revocation and budget decisions if it
claims an immediate OFF guarantee.

Bound models fail closed at saved-model consumers without a model-step context,
including direct completions, connection probes, embeddings, authoring,
sampling, scheduling, and transcription. Fallback policies are rejected for
bound models and protected Flow calls. Protected Subflow and Behavior child
runs are currently rejected because they do not receive owner-issued child
authority; a contextless child may not silently use ordinary transport. These
guards are admission checks, not a substitute for the owner's broker and
original-task accounting.

The generic `configuredExecutionAdapter` is **undefined**. There is no
configured FACTORY credential broker, durable claim and physical sender, or
qualified TEE path in this repository. FACTORY integration, paid inference,
and production use remain **HOLD**. The earlier v1 single-attempt contract in
[`authenticated-model-attempts.md`](../performance/authenticated-model-attempts.md)
is separate: it limits retries and calls an owner claim hook, but FLUJO still
holds the local API key and sends the request itself. It must not be reported as
owner-sent transport or as evidence that the v2 adoption gates have passed.
