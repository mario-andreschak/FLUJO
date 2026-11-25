# A context summary never lets a model alone decide which user corrections or prohibitions survive, and never drops the exact receipt of an action that already ran

Enforced by:
- `requiredInstructionIds` in `src/backend/execution/flow/compaction/standingInstructions.ts`
- `__tests__/model/compactionFidelity.test.ts`
