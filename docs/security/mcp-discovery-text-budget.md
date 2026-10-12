# MCP discovery text budget

The two curated Awesome MCP README responses are read as streaming UTF-8
prefixes. Discovery retains at most 2,000,000 UTF-16 code units per list, matching
the previous `Response.text().slice(0, 2_000_000)` prefix. UTF-8 decoding preserves
BOM handling, replacement of malformed or incomplete sequences, and a prefix
boundary that splits a surrogate pair. Incoming chunks are decoded in pieces of
at most 64 KiB; the reader never calls `response.text()`.

Once the prefix is full, the reader requests no more chunks, starts cancellation
of the unused tail, and releases its lock. Cancellation rejection is handled;
its completion is not awaited, so an indefinitely pending cancellation cannot
hold a useful prefix. EOF releases the reader without cancelling. Read or abort
failure starts cancellation and releases the reader before propagating the
failure to the existing per-list best-effort discovery handler. A null body is
empty text. Content-Length does not control admission.

This intentionally stops depending on tail EOF or tail failures after a complete
prefix. Short responses, the two fixed URLs, the 12-second fetch signal, Markdown
matching, snippet/result caps, recommendation ranking and source metadata retain
their existing behavior. Owner, local-request, workspace, unlocked-provider and
opaque execution-authority gates remain unchanged. Reviewed installation approval,
credential-field checks, OAuth issuer admission and public runtime directory
identity remain unchanged.

The defect requires an admitted research request and an oversized response from
one of the fixed upstreams. Arbitrary caller-controlled fetch URLs and actual
process exhaustion have not been established. This bounds application text
consumption and decoded output, not total process memory: the transport may have
already allocated a large chunk or buffered/decompressed data. Runtime handling
of a pending underlying cancellation also remains a transport concern. Other
JSON discovery responses are outside this correction.

Captured alert 143 classifies incomplete multi-character sanitization at the
Markdown snippet replacement. This adjacent body-consumption correction does
not alter that replacement, prove an HTML injection context, prevent prompt
injection, or claim a native finding is fixed or dismissed.

Offline regression coverage includes prefix limits, finite/endless bodies,
large-chunk segmented decoding, UTF-8 boundaries, metadata-independent budgets,
reader cleanup, cancellation failures and actual research with fetch, model,
Registry and OAuth services mocked. Existing install, ranking and route suites
remain whole. Authored coverage is not evidence of execution; qualification is
performed separately on the frozen Source leaf.
