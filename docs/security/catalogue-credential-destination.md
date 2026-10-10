# Stored catalogue credential destination

This follow-up to PR #650 addresses a concrete data flow behind CodeQL findings
[215](https://github.com/mario-andreschak/FLUJO/security/code-scanning/215) and
[216](https://github.com/mario-andreschak/FLUJO/security/code-scanning/216).
Catalogue discovery could combine a saved model ID/key with an unsaved request
URL or a different validated provider profile. A masked or absent API key now
reuses the stored key only when the saved provider and effective catalogue
transport match, and the HTTP catalogue base endpoint matches the saved endpoint.
The check precedes credential resolution, cache access and provider dispatch.

HTTP identity includes scheme, hostname, port, path and query. URL parsing
normalizes hostname case and default ports, and one optional trailing slash is
equivalent for the existing catalogue URL builder. Additional slashes remain
distinct. Embedded user/password and fragments are refused for stored-key reuse.
Configured local HTTP/custom-port endpoints still match their saved identity.
Changing between HTTP-compatible completion adapters at the same provider and
endpoint does not change the catalogue destination and remains supported.
Native Gemini reuse requires the saved native provider identity; its SDK uses
the fixed native destination and does not receive the caller's URL as an endpoint.

When an unsaved destination/profile differs, discovery returns an empty list
without resolving or forwarding the saved credential. Existing manual model
name entry remains available. Enter a key explicitly for the new destination,
or save the reviewed destination before reusing its key. Directly supplied keys
and explicit global-variable bindings retain their existing behavior; this is
a guard on implicit stored-model key reuse, not a new authority grant for every
credential/global reference. Broader owner/scope, save/connection, export and
frontend log boundaries remain separate work.

The catalogue service, API adapter and API handler also omit URL/search and raw
upstream/parser error content from their affected diagnostics. This complements
#650's HTTP catalogue logging boundary; it is not an all-logger claim.

Focused source tests prove changed-host/path/scheme/port/query/profile and
credential-bearing/fragment URLs cause no resolver, cache or provider call.
Matching saved, local, native, HTTP-compatible adapter and explicitly supplied
new-key paths remain available. Existing route validation, cache separation and
provider normalization tests run alongside these cases. No live account request
or installed artifact is exercised. Full integrated TypeScript/build and a
fresh CodeQL finding gate remain required; no alert dismissal or scanner policy
change is included.

This changes `src/backend/services/model/index.ts` catalogue handling only.
Any applicable pinned source receipt must reflect the new Git bytes without
altering the prior receipt/consumption generation. Completion attempt/provider
adapter code, native CLI admission and worker/image authority are unchanged.

At frozen #650 base `0361b54ae76df3a1e0b1328509b3f7ee60cee61f`, the final
Windows run passed 70 assertions across six suites with locked Next 16.3.8
dependencies. The endpoint helper/tests passed scoped TypeScript with installed
Next ambient declarations. Changed-file ESLint and diff checks passed. Full
service/route graph type/build qualification remains with the coordinator.
