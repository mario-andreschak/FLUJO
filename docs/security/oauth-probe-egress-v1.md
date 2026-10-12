# OAuth discovery preview egress

This source change addresses the OAuth preview request paths reported in CodeQL
alerts [85](https://github.com/mario-andreschak/FLUJO/security/code-scanning/85),
[138](https://github.com/mario-andreschak/FLUJO/security/code-scanning/138), and
[229](https://github.com/mario-andreschak/FLUJO/security/code-scanning/229) against
the release candidate based on `5e2fca8c703d420d10471850ea0dfb9cea0d962b`.
Alert closure must be verified by a fresh scan of the integrated candidate.
No alert dismissal or scanner policy change is included.

## Automatic preview policy

The optional Remote tab OAuth preview accepts public HTTPS endpoints on port
443. Embedded credentials, query strings, fragments, local names, private and
special address ranges, and redirects are refused. This deliberately conservative
address policy excludes translation/tunnel ranges and some special public
allocations. It is not a general purpose outbound network policy.

For every challenge and metadata request, the server resolves all DNS answers
and checks that they are public. It connects directly to one admitted numeric
address without a second DNS lookup, while setting the original HTTP Host and
TLS server name and verifying the certificate against the original hostname.
Requests use fresh connections, fixed methods and payloads, and no caller
credentials, cookies, proxy or shared connection pool. Advertised resource metadata,
issuer, and registration links receive the same policy check; a request resolves
and checks again immediately before connecting. No client is registered by the
preview.

One five-second deadline bounds the entire discovery sequence. Responses have
16 KiB headers and metadata has a 64 KiB uncompressed body limit. Compressed
metadata is refused. The challenge reads only headers and closes its response,
including a possible SSE stream. Metadata must be valid UTF-8 JSON. A denied or
failed preview returns a fixed negative result, without logging the URL or the
upstream error text. A Bearer challenge remains a hint, not proof of successful
OAuth authentication.

## Local and custom-port configuration

The Remote tab explains the preview limit and provides **Configure manually**.
This carries the original HTTP or HTTPS URL into Configure and waits for the
user's explicit connection test, allowing pre-registered OAuth client details to
be entered first. The existing Connect handoff still reaches normal connection
testing even if the optional preview returns no result.

The normal configured MCP transport remains available for local URLs and custom
ports, including its OAuth provider. Its authenticated connection and SDK OAuth
flow are separate from the automatic preview policy. This patch does not claim
to apply preview restrictions to those configured connections or to validate a
live OAuth provider's behavior.

## Evidence and limits

Focused source tests cover special addresses and URL encodings, mixed/private
DNS answers, aborted resolution, numeric connect/Host/SNI/certificate identity,
no DNS re-resolution, refused redirects, metadata size/compression, private
advertised links, and the shared deadline. UI regressions cover manual local and
custom-port handoffs with no preview or auto-test. A factory regression uses the
installed MCP SDK to confirm the original URLs and manually configured OAuth
providers still reach normal transport construction without network requests.

The first focused run failed on a read-only SWC module spy, an incorrectly shaped
Jest parameter table, and a native Error/Jest realm identity assertion. Those
test harness errors were repaired; the rerun passed. Local source tests and
scoped TypeScript checks do not establish installed release behavior, DNS/TLS
operation on another host, successful live OAuth authentication, alert closure,
human acceptance, or an external security grade. Full integrated CI and a fresh
CodeQL finding gate remain required.

The final focused run passed 68 backend tests across four suites and five UI
tests across two suites on Windows with Node 22.13.1 and the candidate's locked
Next 16.3.8 dependencies. The egress helper/probe and their tests passed a scoped
TypeScript check including the installed Next ambient declarations. All changed
TypeScript/TSX files passed ESLint. The initial guarded test runner refused
mismatched dependencies; `npm ci --include=dev --ignore-scripts --no-audit --no-fund`
restored the candidate's lockfile versions before these focused tests. No package
manifest or lockfile was changed. Full graph type/build work remains with the
integration coordinator.

Policy references: [IANA IPv4 special registry](https://www.iana.org/assignments/iana-ipv4-special-registry),
[IANA IPv6 special registry](https://www.iana.org/assignments/iana-ipv6-special-registry),
[Node 22 HTTPS API](https://github.com/nodejs/node/blob/v22.13.1/doc/api/https.md),
and [Node 22 TLS API](https://github.com/nodejs/node/blob/v22.13.1/doc/api/tls.md).
