# Claude Agent SDK runs keep FLUJO's approval as the only tool gate: default permission mode, no settings files, no allow list, and every tool handler checks FLUJO's decision

Enforced by:
- `__tests__/model/claudeSdkAuthorityArgs.test.ts` (installed SDK, fake Claude Code)
- `__tests__/model/claudeSubscriptionSdkBoundary.test.ts`
