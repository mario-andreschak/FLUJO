# Short-lived file errors are waited out only through `src/utils/transientFileRetry.ts`, never by a hand-written retry loop

Antivirus, the indexer or a reader holding a file open makes Windows refuse a
read (`EBUSY`) or a rename over the file (`EPERM`) for a moment. Hand-written
copies of the retry drifted apart: some missed codes, none could be cancelled
or traced, and the private approval check, the owner sign-in file, storage
reads and the approval writer's rename had no retry at all, so an installed
FLUJO could refuse a resource listing (#1050). Use `retryTransientFileOperation`
with a `label`, or `replaceFileWithRetry` for a rename; pass `beforeAttempt` or
`isTransient` for extra checks.

Enforced by:
- `flujo/no-hand-rolled-file-retry`
- `__tests__/utils/transientFileRetry.test.ts`
- `__tests__/utils/fileRetryCallers.test.ts`
- `scripts/smoke-file-locks.test.mjs`

Verified by:
- `npm run smoke:mcp-artifacts` (on Windows it lists resources while holding real exclusive and reader locks on the owner, approval and server-config files)
