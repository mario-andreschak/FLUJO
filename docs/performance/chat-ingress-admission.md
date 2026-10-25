# Chat request ingress admission

`/v1/chat/completions` reserves process capacity before reading POST bodies or
decoding GET query parameters. Next's transport/proxy ceiling is independent:
this boundary governs application decoding, parsing, and retained request input.
Bytes already received by the HTTP stack are outside this allocation estimate.

| Policy | Hard limit |
| --- | --- |
| POST bytes actually read, regardless of Content-Length | 8 MiB |
| GET raw URL | 8 Mi characters |
| GET query parameters | 128 |
| JSON nesting / lexical values including object keys | 64 / 100,000 |
| Body chunks / body read deadline | 100,000 / 30 seconds |
| Simultaneous input owners | 16 |
| Initial decode/parse reservation | 96 MiB per request |
| Process input reservations | 256 MiB |
| Conservative application RSS admission ceiling | 2 GiB |
| IP rate registry | 4,096 keys, 1 MiB estimated key storage |
| Forwarded-IP header inspected | 1,024 characters |
| Per-IP quota | 6,000 requests per minute |

The initial reservation covers a single 8 MiB byte buffer, UTF-16 decoding,
JSON strings and graph metadata, parser copies, and bounded metadata JSON
parsing. Two maximum reservations can read concurrently. After parsing, the
charge becomes `max(2 * rawBytes, 2 * decodedCharacters) +
2 * decodedCharacters + 192 * lexicalValues + 1 MiB`. This deliberately retains
the source-text charge: a short unescaped field may pin an otherwise mostly
whitespace decoded string while escaped fields need separate backing storage.
No input is truncated. ASCII 2,000,000- and 5,600,000-character histories with
64 KiB binary media encoded as base64 fit. Multiple histories or non-ASCII text
whose UTF-8 encoding exceeds 8 MiB require smaller requests. GET's limit applies
to percent-encoded URL characters, so encoding overhead counts.

A byte lexer checks depth and work before UTF-8 decoding and `JSON.parse`.
The parser remains the JSON syntax authority. Malformed JSON returns a safe
400 without embedding source text; oversize input returns 413; owner or
reservation capacity returns 429; process headroom returns 503. Retryable
responses include `Retry-After: 5` in the existing OpenAI error envelope.
There is no unbounded `request.json()` fallback for incomplete test objects.
Refusal happens before conversation loading, stream-reader admission, or
provider/Flow invocation. Existing running, paused, approval and uncertain-effect
owners are untouched.

The route and service hold separate references to one opaque, single-claim
permit. A streaming Flow's background promise holds another reference through
actual execution settlement and awaited terminal-error persistence. Returning
the Response, failing Response construction, or disconnecting its consumer does
not release a still-running producer. Non-streaming and direct-model requests
remain charged through service settlement and route response construction.
Direct-model SSE currently emulates a completion already received in full; it
does not run an additional SDK producer after returning. Persona submission
validates/clones/persists its Flow input before returning a durable dispatch;
its detached pump error reporter receives only the scalar Persona ID, avoiding
capture of the original request messages after handoff.
the request lease covers that synchronous/durable handoff and response
construction, while subsequent dispatcher reads and `runFlow` use their own
existing admission. The input lease does not claim to bound retained response
bodies, the durable dispatcher catalogue, or later model output.

Run, preparation, output, and ingress reservations use four fixed numeric
process-global observation slots, with no caller-named registry. Each component
keeps its own policy and publishes initial ledger bytes on module load and
every synchronous successful update/release. Allocation checks observe all four
slots. The estimate intentionally overlaps existing retained input and future
copies; it is not an exact heap measurement. Hot reload retains live ledgers.
An older bundle's release closure may leave a conservatively stale observation
until its component republishes; reservations are never reset to manufacture
capacity. Numeric diagnostics contain no IDs, IPs, prompts, or credentials.

The IP registry canonicalizes the first IPv4/IPv6 address, including mapped
IPv4 forms. Malformed or overlong headers share a bounded invalid-address quota.
Every check removes expired entries with at most 4,096 visits. No active entry
is evicted, so a unique-IP flood cannot reset an abusive IP's active quota.
If no expired space exists, new keys receive 429. Idle registry memory remains
bounded even when no request arrives to trigger expiry. Forwarded headers remain
subject to the deployment's existing trust/proxy policy; this is not IP
authentication.

Focused tests exercise actual request streams, reference payload fidelity,
pre-decode refusal, cardinality/depth, slow readers, cancellation, held producers,
response failure, delayed persistence, existing protected owners, safe error
shapes, and a full unique-IP flood. These are allocation/ownership boundary
checks, not evidence of a completed 24-hour endurance run.

The finite predecessor controls are reproducible with:

```text
node scripts/qualification/chat-ingress-controls.cjs ABSOLUTE_NEW_DIRECTORY_OUTSIDE_CHECKOUT
```

They pin the predecessor to `e3fae1217f2644307a002bfc9dcf328cf4c496f7`
and record source/input hashes. Frozen and current parsers receive bounded 9 MiB,
depth-65 and 100,001-value inputs; the frozen parser accepts them while current
admission refuses. The exact frozen IP-map block retains 4,097 unique keys while
the current registry refuses the 4,097th. Unrelated metadata validators are inert
in both arms; the cases contain no metadata or tools. These source controls do
not substitute for full route and producer tests or a deployed HTTP benchmark.
