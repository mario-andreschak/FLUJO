# Tool approval has one gate: read the setting with `requireApprovalOf` (missing is off), ask only through runFlow's pause or `toolApprovalGate.ts`, and apply answers only at the fixed decision points

The saved setting of a conversation is the only source (#1284): a run whose request says nothing keeps it, a batch reads the latest save (`approvalForBatch`), and an approved call leaves the waiting batch before its tool starts, so no FLUJO version, also one rolled back to, offers it again after a crash.

Enforced by:
- `flujo/single-tool-approval-gate`
- `__tests__/flow/toolApprovalGate.test.ts`, `__tests__/chat/respondApprovalGate.test.ts`
- `__tests__/flow/toolApprovalDuringRun.test.ts`, `__tests__/chat/requireApprovalMetadata.test.ts`, `__tests__/chat/applyApprovalDecision.test.ts`
- `approvalForBatch` in `src/backend/execution/flow/approvalSetting.ts`
