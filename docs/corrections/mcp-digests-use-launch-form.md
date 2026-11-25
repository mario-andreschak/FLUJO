# MCP launch fingerprints and owner-approval digests compare a server config only as it is launched (secrets decrypted, globals filled in), through `launchForm()` in `src/backend/services/mcp/launchForm.ts`, never the saved encrypted text

Enforced by:
- `__tests__/mcp/launchFormCallers.test.ts`, `__tests__/mcp/secretEnvLaunchApproval.test.ts`
