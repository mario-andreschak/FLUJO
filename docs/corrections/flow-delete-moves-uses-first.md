# A flow someone deletes is removed only after every Persona, automation and flow that uses it switched to another flow or let it go; never leave a refusal without a way forward

Enforced by:
- `deleteFlowAndMoveUses` in `src/backend/services/flow/flowDeletion.ts`
- `__tests__/architecture/flowDeleteSingleEntry.test.ts` (its allowed list only shrinks), `__tests__/flow/flowDeleteInUse.test.ts`
