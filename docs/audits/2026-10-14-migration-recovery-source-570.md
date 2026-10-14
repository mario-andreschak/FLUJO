# Source migration and snapshot recovery acceptance

This partial delivery for [issue 570](https://github.com/mario-andreschak/FLUJO/issues/570)
fixes required filesystem failures being reported as completed workspace layout.
Ordinary file collisions use atomic rename; incompatible entry types and old
migration staging payload remain intact. Changed links receive a synced,
identity-bound remap record before directory moves. Restart can finish remapping
after a partial move or abrupt exit, including a Windows junction whose original
target already moved. Completion-marker replacement preserves its predecessor
on failure. Direct directory moves, bundled MCP ownership, disjoint destination
data and warning-only unsafe legacy roots retain their existing behavior.

The [frozen receipt](evidence/migration-recovery-570-2026-10-14/receipt.json)
records six actual Windows/Node 22.23.3 application processes and observations:

1. Injected ENOSPC after userdata moved keeps the artifacts junction and recovery
   record. Authenticated workspace/cwd requests return 503; the actual silent
   health CLI fails. Payload hashes remain unchanged.
2. Restart against the same root repairs the recorded junction, clears its
   remap record and passes authenticated readiness after normal unlock.
3. An IPC witness follows the actual screenshots directory rename. The parent
   sends SIGKILL to that original child and observes exit and stdio closure.
4. Restart repairs the link despite the legacy source folder being absent,
   retaining its readable payload hash and clearing the remap record.
5. Encrypted snapshot restore writes 4096 actual payload bytes before injected
   ENOSPC. Final worker state is error, health fails, no workspace is published,
   private staging is absent and the encrypted input archive is unchanged.
6. The same archive restarts into a ready encrypted worker. Independently hashed
   restored bytes and input archive match; MCP preparation contains zero servers.

All six original children exited and closed stdio; independent inspection
confirmed private-root removal. A deliberate first-restart assertion failure
retained failure while cleaning both children and the private root. An occupied
log was refused before fixture launch. The initial main-source ENOSPC regression
failed with a resolved readiness promise; the final regression passes.

Application commit `08379443cef399c2099a88450ea781ee0c196487` contains the
qualified Windows checkout inputs: 1,868 source files with aggregate SHA-256
`9d58f9fb3cd33aad978384f7ba93df3fe71b75ce6161c60a402e3d3a123653a9`.
Build `zPn2RO3miJmanjMRHIjZh` binds 1,539 emitted application/five-MCP files with
aggregate `7102c14e95205c07056ad45aa652df8ac32bc52c8eda9facdab4556902a65a94`.
The builder recorded base commit `b7cf9129` before source commit creation; that
base field alone does not identify the modified application. Source/build
aggregates were verified before and after runtime acceptance and joined to the
qualified commit. Equipment has separate unchanged hashes in the receipt.

Local validation passed: 62 focused migration/snapshot cases and five actual
subprocess fault-equipment cases; one POSIX self-parent-link case is skipped on
Windows. Source/app/five-MCP typecheck, source and changed-file/equipment lint,
and the inspected non-container application/five-MCP build passed. Final frozen
types/lint/focused checks took 26.973 seconds; final build took 301.577 seconds;
the live runner took 19.078 seconds with a 17.395-second internal receipt window.
Earlier full source lint and five-MCP types cover unchanged inputs. Independent
source and receipt review cleared this scope. No full/remote/container/release
checks were dispatched.

ENOSPC is injected into actual filesystem calls; the physical host disk was not
exhausted. This proves source migration and encrypted workspace-fork recovery,
with empty MCP preparation. It does not qualify complete installation/authority
disaster restore, installed artifacts, non-author operator installation/diagnosis/
backup/upgrade/restore, native POSIX execution, providers, external effects or
bundled process teardown. Prior schedule/process/provider acceptance remains
separate. Issue 570 stays open for its original remaining operational and exact
supported-release criteria; no fixed five-hour timeout requirement is added.
