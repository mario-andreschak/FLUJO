# Copying into another workspace takes only listed fields; a new model, MCP server or flow field fails the type check until it is sorted as copy, scrub or drop, so no new secret field can travel

Enforced by:
- `satisfies Record<keyof …>` field lists in `src/backend/services/sharedItems/teamCopy.ts`
- `__tests__/sharedItems/teamCopy.test.ts`
