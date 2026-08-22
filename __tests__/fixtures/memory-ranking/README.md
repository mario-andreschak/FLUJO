# Memory ranking golden set

`golden-v1.json` is a synthetic, privacy-safe fixture for the memory ranking
A/B evaluator. It must never contain copied workspace or production memory text.

All timestamps are fixed Unix milliseconds. Cases use explicit IDs as their
oracle; snapshots are not the source of truth. A fixture change requires review
of ranking intent, duplicate labels, survivor IDs, and a version bump whenever
existing metric meaning changes.

Metrics are defined as follows:

- Recall hit rate: query cases with at least one relevant ID in top-K, divided
  by all query cases.
- Recall@K: relevant IDs retrieved divided by relevant IDs expected.
- Ranking accuracy: ordering cases whose returned top-N prefix exactly equals
  `expectedOrder`, divided by ordering cases.
- Duplicate merge precision: true positives divided by predicted positives. A
  positive is only true when the duplicate label and any expected survivor both
  match.
- Duplicate recall: true positives divided by golden duplicate cases.

A zero denominator is represented as `null`, with raw numerator and
denominator retained. Ranking uses the production tie-break order: score
descending, `updatedAt` descending, then ID ascending.

The current fixture is lexical-only. Future semantic cases must check in fixed
per-item semantic scores; they must not call a model, embedding service, network,
or workspace storage. Variants are explicit experiment inputs and are not
persisted workspace settings.

Run the baseline:

```sh
npm run test:memory-experiment
npm run test:memory-experiment -- --json=memory-experiment-results.json
```

A strict partial variant file has this shape:

```json
{
  "id": "shorter-recency",
  "ranking": { "recencyHalfLifeDays": 45 },
  "dedup": { "nearDuplicateThreshold": 0.85 }
}
```

Pass one or more files with repeated `--variant=path/to/variant.json`. Unknown
keys, non-finite numbers, unsafe ranges, and duplicate variant IDs are rejected.
Partial values are merged onto the checked-in production defaults, and results
record the complete effective settings.
