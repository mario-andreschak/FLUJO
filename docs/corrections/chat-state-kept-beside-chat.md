# Each chat keeps its own state (such as its project folder) in a record beside it, never in a shared capped list; deleting a chat deletes every record kept beside it

Enforced by:
- `__tests__/architecture/chatDeletionCleanup.test.ts`
- `__tests__/projects/projectStore.test.ts`, `__tests__/projects/chatProjectMigration.test.ts`
