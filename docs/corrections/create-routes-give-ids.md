# A create route never stores a record without an id: a missing id gets a fresh one from `newRecordId` (`src/shared/recordId.ts`), and a model already stored without one gets an id on its next load

Enforced by:
- `__tests__/architecture/createRouteIds.test.ts` (lists every create route)
- `__tests__/api/modelCreateId.test.ts`
