# MCP launch fingerprints and owner-approval digests compare a server config only as it is launched (secrets decrypted, globals filled in), through `launchForm()` in `src/backend/services/mcp/launchForm.ts`, never the saved encrypted text

An approval made before #1337 covered the saved text; the first check after updating moves it to the launch form once (`upgradeStoredFormApproval` in `src/backend/services/security/storedFormApprovalUpgrade.ts`), so the owner does not approve again.

Enforced by:
- `__tests__/mcp/launchFormCallers.test.ts`, `__tests__/mcp/secretEnvLaunchApproval.test.ts`
- `__tests__/mcp/secretEnvApprovalPath.test.ts`
