# A checkpoint around a tool that may change something is saved before the next step; only safe step boundaries and a successful end of a run may wait for the next full save

"Fewer saves per turn" (#1408) leaves some saves to the next one. A tool's
result that is not on disk when the next step acts on it could make FLUJO run
the tool again after a crash. `commitRecoveryCheckpoint` and
`commitRecoveryTransition` ignore `durability: 'untilNextSave'` for anything
else.

Enforced by:
- `__tests__/flow/lowLatencySaves.test.ts`
- `RecoveryDurability` in `src/backend/execution/flow/recoveryCheckpoint.ts`
