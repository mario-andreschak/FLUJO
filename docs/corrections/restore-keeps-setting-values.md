# Restoring a backup never replaces a stored setting value: backups carry setting names only, so a restore keeps the values already there

Ordinary backups write every setting as an empty secret placeholder
(`ordinaryBackupData` in `src/backend/services/workspace/backupExport.ts`).
Writing that placeholder back over the store wiped every setting value on
restore; `mergeRestoredVariables` keeps them.

Enforced by:
- `__tests__/settings/backupRestoreRoutes.test.ts`

Verified by:
- `scripts/packaged-acceptance.mjs` (the backup and restore checks on every shipped form)
