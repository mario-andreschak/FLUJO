# Ordinary restore outcomes — issue #570

Four focused regressions failed against main `f484ea585222542a0012b2aeb954cefc14d21152`: a rejected storage write, mixed successful/failed writes, a rejected Flow save, and malformed/empty archive data all produced misleading success. This batch counts confirmed writes and failed/skipped entries, carries partial-export failure markers through restore, and aborts failed destination inspection before writes. Complete, partial, failed and empty outcomes are documented in the restore API guide.

The form names affected selections, focuses the outcome, keeps the file/options after incomplete or network/non-JSON responses, and permits retry. All seven locales include recovery wording; phone controls have 44px minimum height and filenames wrap. Successful ordinary writes remain saved; restore is not a multi-record transaction, and retry can overwrite them. Missing optional legacy keys remain compatible. Existing owner, unlock, local, workspace, Persona and link checks remain enforced.

## Qualification

- Final application inputs below passed the inspected non-container `npm run build` (application and five MCP builds, 351.84 seconds) and local typecheck (65.24 seconds). The source lint and changed-test/harness lint passed. Later edits affected only the standalone acceptance harness and this record, so the unchanged application results were reused.
- 55 backend/filesystem and 7 rendered frontend cases passed in separate final applicable runs. They cover outcome counts, rejected Flow/conversation/file writes, partial-export round-trip, Persona preflight, link safety and retained-file retry. Intermediate fixture/selector errors were repaired without removing assertions.
- The final built-app run on October 14, 2026 UTC passed eight checks in 15.62 seconds using Node 22.23.3, Edge 155.0.4283.45 and build `RKv8-mIP0Lnphr0i3d7hT`. A fresh private owner/passphrase profile exercised actual HTTP refusal, an actual non-file destination write failure, mixed writes, an empty selection, and failure/retry at English 1120px and Spanish 320px. Both pages retained the upload, focused the failure, fit horizontally and completed the retry after removing the obstruction. No page errors occurred; the owned server exited 143 and its private fixture was removed.
- A deliberate missing-build run exited 1, wrote a failure receipt and removed its private fixture. Independent source review found and verified the harness cleanup repair; no application findings remained.

Receipt-bound SHA-256 inputs (identical in the initial HTTP and final browser runs):

| Input | SHA-256 |
| --- | --- |
| `src/app/api/restore/route.ts` | `a659f2ca2ff74a02adb4d2d283e29ef88728d2b255f2fce9f134c0d8a6396967` |
| `src/backend/services/workspace/backupRestoreFs.ts` | `5d8a3405c001a0858fc7a9143d8ce7f00004bc93a3bcac24024de308d1bcd289` |
| `src/frontend/components/Settings/BackupSettings.tsx` | `82798b50b6e34f10a487d700a283e1840a83fd75bde21c211e8c7e6bc1ef4bf0` |
| `src/frontend/i18n/catalogs/settings.ts` | `68edc70ade01ac36a32b9358e5ec3008140a6fa3b1939bc1bd97a084224e7542` |
| `src/shared/types/backup.ts` | `fa1e9129bc686780017834867d5fb8a2f4ac2e509f0b35cc514552df7cf50664` |

Local receipts and screenshots are retained under `C:/Users/Moe/.codex/tmp/backup-restore-570-20261013`: `validation.json`, `routes-pinned.log`, `frontend-pinned.log`, `focused-pinned.log` (filesystem result), `acceptance-and-lint.json`, `final-harness.json`, `built-app-final/receipt.json`, and `setup-failure/receipt.json`.

## Acceptance limits

The HTTP write failure is a real invalid destination, not a physical disk-full experiment; ENOSPC is covered by focused regression injection. No provider, scheduler restart, migration interruption, independent operator deployment, installed/relocated profile, full suite, remote CI, container build or release acceptance was run. Issue #570 remains open for its integrated operational checklist. No workflow or security gate was changed.
