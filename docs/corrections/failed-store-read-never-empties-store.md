# A store read that fails never becomes a write of an empty store: retry with `src/utils/transientFileRetry.ts`, then refuse the change

Enforced by:
- `__tests__/scheduler/pendingApprovalsStore.test.ts`
