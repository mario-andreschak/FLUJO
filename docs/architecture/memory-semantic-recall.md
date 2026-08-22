# Semantic memory recall

Issue [#471](https://github.com/mario-andreschak/FLUJO/issues/471) integrates the
Phase B hybrid ranking path.

Semantic recall is workspace-scoped and opt-in. Existing workspaces retain
lexical-only recall because `semanticRecallEnabled` defaults to `false`.
`semanticEmbeddingModelId` identifies a stored FLUJO model; that model supplies
the adapter, provider model name, endpoint, and credentials. The configured
embedding dimensions default to 1536.

When a valid memory sidecar is available, relevance is:

```text
0.6 * normalised lexical relevance + 0.4 * clamped cosine similarity
```

The blended relevance is multiplied by the existing length, trust, and recency
factors before the core bonus is added. A non-lexical candidate must have cosine
similarity at or above 0.75. Missing or stale sidecars, model or dimension
mismatches, malformed vectors, unsupported adapters, and provider failures are
treated as unavailable. Unavailable candidates use the unchanged lexical-only
score with effective weights 1.0/0.0.

The kernel embeds a non-empty query once and loads the Persona sidecar once.
Empty queries retain the indexed metadata path and never call an embedding
provider. Process-local diagnostics contain only fallback reasons, aggregate
candidate counts, and stage timings; they never contain query text, memory
content, IDs, vectors, credentials, or workspace identifiers.

The deterministic golden set is
`__tests__/fixtures/memory-ranking/golden-semantic-v1.json`. It records lexical
and hybrid recall@K and mean reciprocal rank without live provider calls.

Run the opt-in 50k benchmark with:

```sh
npm run benchmark:memory-semantic
```

The benchmark reports p50/p95 for item loading, Persona-wide sidecar loading,
cosine/filter/ranking, and the combined warm local data path. It uses a fixed
local query vector, explicitly excludes provider network latency, and records
that assumption in its output. Production diagnostics measure query-embedding
latency separately. Benchmark results and machine details must be captured by
the designated testing wave before the 150 ms acceptance criterion is claimed.
