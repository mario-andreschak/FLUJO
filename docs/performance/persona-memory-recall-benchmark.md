# Persona memory recall benchmark

Issues [#459](https://github.com/mario-andreschak/FLUJO/issues/459) and
[#489](https://github.com/mario-andreschak/FLUJO/issues/489) define this
controlled Persona-memory acceptance benchmark for parent epic
[#448](https://github.com/mario-andreschak/FLUJO/issues/448).

## Run the controlled benchmark

```sh
npm run test:memory-recall-benchmark
```

The `persona-memory-recall-benchmark` GitHub Actions workflow runs the same gate
weekly and on manual dispatch. It writes the exact JSON result to
`benchmark-artifacts/persona-memory-recall.json`, validates its schema, fixture,
quality/cache fields, strict p95 result, commit, and workflow run ID against the
controlled invocation, then generates a SHA-256 manifest and retains the
commit/run-named artifact for 30 days.
The upload uses `if: always()` so a report written before a gate failure remains
diagnostic evidence.

The command enables the opt-in suite, selects the Node Jest project, and runs
`memorySemanticRecallPerf.test.ts` serially with `--runInBand`. Set
`FLUJO_BENCHMARK_COMMIT` to the tested commit SHA outside GitHub Actions.
The controlled workflow sets it explicitly to `${{ github.sha }}`, sets
`FLUJO_BENCHMARK_RUN_ID`, and rejects a report whose commit or run ID differs.

This is a controlled-runner performance gate. Ordinary test runs skip the 50,000
item suite so host contention cannot create a flaky wall-clock failure. The
designated testing wave must run the command on the approved runner before
claiming the p95 acceptance criterion or posting results to parent issue #448.

## Deterministic fixture

The benchmark creates exactly 50,000 active Persona memory items with fixed IDs,
timestamps, contents, model identity, eight-dimensional vectors, and
`asOf`. Fixture version `persona-memory-recall-v1` and hash label
`50k-release-branch-deterministic-v1` identify this data. One target vector
represents the paraphrase “How do we ship software?”; all other vectors are
deterministic distractors.

Setup persists the memory collection and Persona-wide embedding sidecar, builds
and validates the production Persona index, and verifies item and embedding
counts before timing. A deterministic provider seam prevents network calls and
API charges while the benchmark still invokes the production
`searchPersonaMemory()` path.

## Timing and cache proof

The query-vector cache is process-local, workspace-scoped, and keyed by provider,
model, dimensions, and NFKC/whitespace/case-normalized query text. It is bounded
to 256 LRU entries with a five-minute TTL, coalesces concurrent misses, and never
places credentials in a key.

The benchmark clears the cache, performs one untimed hybrid recall, and requires
exactly one cache miss and one provider call. It then measures 20 serial calls
and requires all 20 to be cache hits with no additional provider call. Each
interval includes indexed item loading, query-cache lookup, Persona sidecar
loading, cosine scoring, filtering, and ranking. It excludes fixture/index
creation, model/provider setup, cache warm-up, assertions, and JSON output.

Latency statistics use raw `performance.now()` samples and the nearest-rank
percentile definition, `ceil(sampleCount * percentile)`. The report records
sample count, min, max, mean, p50, p95, and p99. The controlled gate requires
warm-cache p95 to be strictly less than 150 ms.

## Ranking quality

The same run evaluates the versioned golden set at
`__tests__/fixtures/memory-ranking/golden-semantic-v1.json`. Lexical-only and
hybrid modes use the same ranking variant and query cases. The stable JSON report
records Recall@K and mean reciprocal rank for each mode plus absolute deltas, and
the suite requires both hybrid metrics to exceed their lexical baselines.

The report also records schema/run identity, start/end timestamps, fixture
identifiers, item and embedding counts, ranking weights, cache statistics, commit identifier, Node
version, operating system, architecture, CPU model, logical CPU count, and an
explicit `controlled-50k-recall-p95` verdict. Preserve the JSON artifact; do not
round it before evaluating or publishing results.

Before #448 closes, attach the successful controlled-workflow URL, artifact URL,
checksum, run ID, reviewer/date, and exact release SHA alongside the successful
runtime-backed soak evidence. Merging the workflow is not acceptance evidence.
