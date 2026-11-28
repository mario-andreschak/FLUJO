# Anthropic's signed summary goes back first and byte for byte, or as plain text; it is never edited, and its failures fall back to FLUJO's own summary without a restart

Anthropic's on-demand compaction (beta `compact-2026-09-04`) refuses a block
whose signature or content changed, one that is not first, and any field the
API did not return. FLUJO keeps the block field for field with its summary,
puts FLUJO's exact records after it, sends the same summary as text when an
endpoint refuses the block, and uses its own summarizer when no signed summary
comes back.

Enforced by:
- `placeCompactionBlock` in `src/backend/services/model/adapters/anthropicCompaction.ts`
- `__tests__/model/anthropicNativeCompaction.test.ts` (installed SDK, stand-in server with the documented compaction rules)
- `__tests__/model/anthropicNativeCompactionFlow.test.ts`
