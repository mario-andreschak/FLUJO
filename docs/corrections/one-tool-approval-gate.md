# Tool approval has one gate: read the setting with `requireApprovalOf` (missing is off), ask only through runFlow's pause or `toolApprovalGate.ts`, and apply answers only at the fixed decision points

Enforced by:
- `flujo/single-tool-approval-gate`
- `__tests__/flow/toolApprovalGate.test.ts`, `__tests__/chat/respondApprovalGate.test.ts`
