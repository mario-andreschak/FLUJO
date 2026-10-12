# Subscription allowance

Models, fallback policies, Flow agents and Personas share the same expandable
allowance display. The Models overview shows subscription accounts only, with
readable percentages, shared model counts and a visible refresh action. Local
inference and API billing never acquire subscription meters. Models using the same subscription share a segment; selecting
another model does not create another allowance balance. Policy details preserve
the configured primary/fallback order, and Persona details include the Core and
active Behavior model references, including captured dependency snapshots.

A segment shows the most constrained known account window. Expand it to see
models sharing that account, each provider window, its reset time and when it was
observed. Separate accounts are alternatives, not percentages to add or average.
An unknown window prevents a complete numeric summary; known window values remain
visible in the details. Provider quota aliases are displayed as account windows
when their applicability to a specific model is not established.

## Provider support

- Claude subscriptions keep FLUJO's setup-token authentication. Existing runs
  observe the experimental Agent SDK usage capability, skipping transcript
  scanning and waiting at most 500ms. An account check initializes an idle owned
  SDK process with an input stream that never yields a prompt, with no tools,
  hooks, MCP servers or persisted conversation. If the SDK environment-token
  lane supplies no plan reading, the check reads the same OAuth usage endpoint
  as the installed official CLI with the selected setup-token. Both paths are
  usage reads, not inference. A denied reading remains explicit; there is no
  switch to a personal local login. HTTP 429 preserves the provider's Retry-After
  deadline, disables the affected account's check and blocks backend retries.
  The endpoint and SDK capability are experimental; failed or malformed data
  never imply a balance. Claude's own usage page remains available as a link.
- Codex subscriptions: explicit Refresh uses a short-lived owned app-server to
  read the file-backed login and ChatGPT rate-limit windows. It never starts a
  thread or turn, runs tools, redeems credits, or changes login. API-key-only
  configurations do not expose subscription allowance. Account changes invalidate
  the previous observation. Runtime preparation is drained if it cannot cancel;
  an expired request cannot subsequently start a child, and owned shutdown is
  drained before returning.
- API providers and gateways use API billing; local inference has no subscription
  balance. Request/token rate limits, accumulated cost and context capacity are
  different metrics. Hosted Ollama endpoints are API connections, not local
  inference. These connections can appear as ordered policy dependencies in
  expanded details, but never as subscription account segments.

Observations are held in a bounded process-local cache and expire after five
minutes. A reset time also invalidates that window: FLUJO does not assume a reset
restores 100%. Restarting FLUJO starts with unknown observations. Credentials,
account identifiers and native diagnostics are not included in the response.

Visible subscription displays check missing or expired readings and share one
workspace snapshot. A single cached GET observer runs every 30 seconds while
those displays are visible, and on focus, so observations recorded during runs
reach the UI. Unknown values, partial readings, denied usage access and provider
throttling remain different states. Provider failures are independent: a failed
Claude read does not discard a valid Codex reading. Reset and observation times
use relative labels, with localized absolute times available on hover.

## Local API

### Experimental read-only JavaScript helper and CLI

The shipped `scripts/subscription-allowance.mjs` exports `readSubscriptionAllowance`
and also runs as a standalone command. This is an experimental helper, not a stable
JavaScript SDK. It performs one cached `GET /api/model/allowance`, never a refresh,
provider request, or native CLI startup.

```sh
node scripts/subscription-allowance.mjs --base-url http://127.0.0.1:4200 --workspace default-workspace
```

```js
import { readSubscriptionAllowance } from './scripts/subscription-allowance.mjs';
const allowance = await readSubscriptionAllowance({
  baseUrl: 'http://127.0.0.1:4200', workspace: 'default-workspace',
  token: process.env.FLUJO_OWNER_API_TOKEN,
});
```

Only exact loopback hosts (`localhost`, `127.0.0.1`, `[::1]`) are accepted.
When an owner policy requires authentication, set `FLUJO_OWNER_API_TOKEN` in the
CLI environment; tokens are not accepted as command-line arguments. The helper
accepts an optional abort signal and a 10-second default timeout (CLI override:
`--timeout-ms`). Responses are streamed within a 1 MiB limit and projected onto
known allowance metadata; redirects and raw HTTP diagnostics are refused.
Unknown, stale, and elapsed-reset values remain unknown. The printed snapshot
does not create a new subscription balance or establish per-model quota scope.

### Endpoint behavior

`GET /api/model/allowance` returns cached model observations and Flow/Persona model
reference maps. It performs no CLI startup or provider request.

`POST /api/model/allowance` checks configured subscription telemetry and returns
the same projection. An optional JSON body `{ "modelIds": ["connection-id"] }`
limits collection to the selected connections or policies; omission preserves
the full workspace check. Selection is bounded to 512 nonempty model IDs of at
most 128 characters each. Overlapping refreshes share one collection per account
within a workspace, and collection concurrency is bounded. Both methods retain local-owner, workspace and
encryption guards, refuse restricted execution transports, and set
`Cache-Control: private, no-store`. The workspace query/header conventions are
the same as other FLUJO routes.

Offline tests cover normalization, expiry, account deduplication, immutable Flow
dependencies, policy ordering, workspace switching, lock guards, credential-safe
responses, quota-only child messages, cancellation and child cleanup. Synthetic
UI fixture screenshots demonstrate rendering; they do not establish a real
subscription's balance or an end-to-end provider qualification.
