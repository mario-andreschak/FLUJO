# When a model runtime compacts a conversation with its own summary, FLUJO sends its standing user instructions and exact receipts again right after it

Codex's compaction summary is written by the model alone, so the rules for
FLUJO's own compaction (#1091) apply on top of it. If the carry is refused or
does not fit, the runtime's thread is not reused.

Enforced by:
- `nativeCompactionCarry` in `src/backend/execution/flow/compaction/nativeCompactionCarry.ts`
- `__tests__/model/codexStandIn.test.ts`
- `__tests__/model/nativeCompactionCarry.test.ts`
