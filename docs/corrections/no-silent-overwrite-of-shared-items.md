# A save never silently replaces someone else's newer save of a shared flow, model or MCP server (multi-user mode)

Enforced by:
- `checkBaseRevision` in `src/backend/services/sharedItems/guard.ts`
- `__tests__/sharedItems/twoEditors.test.ts`
