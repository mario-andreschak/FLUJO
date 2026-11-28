# A generated summary, FLUJO's or a provider's, never writes a line only the runtime writes (execution receipts, recorded observations, resource locators, the archive pointer)

A summarizer once added its own `## Execution Receipts` block after the five
sections. When the history had no real receipts, the next summary carried that
invented receipt as an exact record, so the agent could believe an action had
run. Such summaries are refused; FLUJO rebuilds these records from the source.

Enforced by:
- `forgesRuntimeRecords` in `src/backend/execution/flow/handlers/summarizingCompaction.ts`
- `__tests__/model/compactionFidelity.test.ts`
