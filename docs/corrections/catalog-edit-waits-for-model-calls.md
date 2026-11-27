# Model calls that follow each other share one model catalog registration, and a catalog edit waits a bounded time for running calls instead of being refused at once

Enforced by:
- `__tests__/workspace/modelCatalogAdmission.test.ts`
- `retireIdleModelCatalogReader` in `src/backend/services/enduringAgents/runtimeLock.ts`

Verified by:
- `__tests__/enduringAgents/modelCatalogLeaseLifetime.test.ts` (run with `node scripts/run-local-jest.cjs`)
