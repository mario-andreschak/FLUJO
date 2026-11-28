# A burst of chat requests waits its turn (`src/utils/capacityWaitQueue.ts`); none is refused because others arrived together

Issue #757 measured 300 parallel chat requests that waited minutes before
FLUJO's first model call, and nobody reran that test after the fixes. The
`Chat burst load test` job of `verify-full.yml` now reruns it on a fresh
production build: 300 streamed, 300 plain, 50 plain and 300 sent while FLUJO
is still starting. A run fails when any request is lost or refused, or when
FLUJO's first model call is slow (`PASS_RULES` in
`scripts/chat-burst-load-test.mjs`).

Enforced by:
- `__tests__/chat/parallelChatBurst.test.ts`
- `assertChatBurstLoadJob` in `scripts/workflow-contract.mjs`
- `scripts/workflow-contract.test.mjs`
