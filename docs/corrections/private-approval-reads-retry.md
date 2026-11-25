# Private approval reads wait and read again after a short-lived Windows file lock, helper failure or torn read, using `src/utils/transientFileRetry.ts`, before they refuse

Enforced by:
- `__tests__/mcp/privateApprovalRetry.test.ts`
