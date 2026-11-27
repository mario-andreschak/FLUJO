# A plain Claude hand-off ends Claude Code's work too: once the turn that called the hand-off has its tool answers, no further model request is sent (each one counts against a subscription's allowance). Re-check on every Agent SDK upgrade

Stopping the run only in FLUJO's message loop came too late: Claude Code had
already asked the model for another turn, which FLUJO never read but the
subscription still paid for. The adapter answers Claude Code's `PostToolBatch`
hook with `continue: false` after a plain hand-off; spawn hand-offs keep going.

Enforced by:
- `__tests__/model/claudeHandoffModelRequests.test.ts` (installed SDK with its bundled Claude Code, FLUJO's own callbacks and a stand-in model service that counts requests)
- `__tests__/model/claudeWarmProcessAdapter.test.ts`
- `__tests__/model/claudeWarmProcess.test.ts`
