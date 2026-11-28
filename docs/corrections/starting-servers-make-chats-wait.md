# A chat that arrives while FLUJO or its model server is still starting waits for it instead of getting 503

Issue #757: vLLM answered "503 status code (no body)" while it loaded its model
and the run ended with that error; a request that reached FLUJO before its
startup had begun, or a cloud worker that was still restoring, was refused with
503 at once. Now the model call waits about a minute across its automatic
retries (`planAutomaticRetry` in `src/backend/execution/flow/retryAfter.ts`)
and requests wait up to a minute for FLUJO's own startup
(`src/backend/services/workspace/startupWait.ts`). A restarted FLUJO loads each
route when it is first used instead of all of them at once, so it accepts a
burst's connections sooner. The load test's cold start run sends 300 chats
while both are starting and fails on any refusal.

Enforced by:
- `__tests__/config/nextConfig.test.ts`
- `__tests__/model/providerInterruptionRetry.test.ts`
- `__tests__/workspace/layoutReadiness.test.ts`
- `__tests__/security/workerIngress.test.ts`
- `assertChatBurstLoadJob` in `scripts/workflow-contract.mjs`
- `scripts/workflow-contract.test.mjs`
