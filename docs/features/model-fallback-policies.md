# Model fallback policies

When a model reaches a usage limit or its provider is unavailable, a fallback policy tries another saved model in the order you choose. Configure the policy once and select it in the normal model picker for a Process, agent, or AI operation. Each member uses its own saved provider, adapter, credentials, temperature, reasoning settings and output-token limit. Explicit caller token/temperature overrides take precedence.

## UI

Open **AI Setup → Create fallback policy**. Enter a display name and a stable API alias such as `production`. Add at least two saved models. The first is primary; the remainder are backups. The arrow buttons change the order. Select the failure conditions that should try a backup, then save. Policies appear alongside models with a **Fallback policy** badge and member count. Edit and delete them using the existing card actions. A referenced model cannot be deleted until it is removed from its policies.

Policies contain no API keys. Members must exist in the same workspace. Chains contain 2–8 unique models; nested policies are rejected. Workspace snapshots carry policies in `db/models.json` with the ordinary model records.

## API

Create and update policies through the existing `POST /api/model` and `PUT /api/model/{id}` endpoints. List/delete them through the same model CRUD API. Normal authentication, encryption-unlock and workspace selection apply.

```json
{
  "id": "production-policy",
  "name": "policy/production",
  "displayName": "Resilient production",
  "ApiKey": "",
  "fallbackPolicy": {
    "modelIds": ["saved-primary-id", "saved-backup-id"],
    "triggers": ["rate_limit", "unavailable", "timeout"],
    "cooldownSeconds": 60
  }
}
```

`GET /v1/models` advertises `policy/production`. Invoke it with any OpenAI-compatible client pointed at FLUJO:

```json
{
  "model": "policy/production",
  "messages": [{ "role": "user", "content": "Hello" }]
}
```

Successful responses include the provider model actually used in `model`, plus a credential-free `flujo_routing` receipt:

```json
{
  "policyId": "production-policy",
  "selectedModelId": "saved-backup-id",
  "attempts": [
    { "modelId": "saved-primary-id", "outcome": "failed", "reason": "rate_limit" },
    { "modelId": "saved-backup-id", "outcome": "completed" }
  ]
}
```

The receipt is also included in the direct endpoint's emulated SSE chunks. When all eligible members fail or are cooling down, the endpoint returns HTTP 503 with `fallback_exhausted` and a receipt. Direct API completions keep client-owned tool execution: subscription agents with client tool definitions are skipped. Process execution retains FLUJO's existing tool loop, approval gates and execution fences. Its provider statistics and model-turn inspector attribute dispatches to the actual member.

## Failure boundaries

- Limits: HTTP 429 and explicit rate/session/usage/quota exhaustion signatures.
- Unavailability: HTTP 5xx, provider overload and recognized connection/DNS failures.
- Timeouts: HTTP 408/504 and recognized transport timeout errors. Policies use each adapter's existing timeout; they do not impose a new wall-clock timeout.
- Cancellation, execution-authority loss, budget denial, authentication errors, context errors and malformed requests remain terminal.
- Fallback stops after any streamed output, transcript message, tool dispatch/progress/approval activity, local tool execution, or consumed steering input. It never restarts a whole flow or replays tool effects.
- Known incompatible tools/image/audio input cause a member to be skipped; canonical input is preserved. Unknown capabilities remain eligible and provider validation errors stay terminal.
- Native Claude/Codex sessions are not resumed through policies, preventing one member from inheriting another member's private session state.

Cooldowns are scoped to the workspace and policy within the running server. They expire automatically and invalidate when policy/member configuration changes. `Retry-After` can extend the configured cooldown, bounded to one hour. Restarting the server clears cooldowns. This is a local availability optimization, not a distributed quota ledger or spending authorization. Every Process member rechecks the execution dispatch hook before calling its provider. Existing SDK transport retry behavior remains in effect; the Process handler does not restart a policy through its outer session-limit retry loop.

Weighted routing, latency optimization, nested policies and package-registry export/import of policies are outside this feature. Package schema validation rejects unsupported policy exports; full workspace snapshots preserve them.

## Research and design

[Requesty routing](https://www.requesty.ai/product/routing) demonstrates named aliases with ordered failover on provider limits/outages. Its [policy overview](https://www.requesty.ai/blog/routing-policies-for-agents) describes editing the strategy without changing callers. [OpenRouter's fallback documentation](https://openrouter.ai/docs/guides/routing/model-fallbacks) provides ordered candidates and reports the selected model.

FLUJO implements this at its existing `getCompletionAdapter` seam rather than adding a gateway dependency. The deliberately narrower retry boundary preserves the execution engine's no-output/no-side-effect replay contract. Policies share model storage and pickers, keeping credentials, API usage and workspace snapshots within established FLUJO behavior.

See [UI screenshots and HTTP acceptance evidence](../evidence/model-fallback-policies/README.md).
