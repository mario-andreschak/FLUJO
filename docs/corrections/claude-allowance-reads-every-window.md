# The Claude allowance reads every plan window Claude Code reports with a run (`unifiedWindows`), near a limit or not, so a setup-token shows real numbers after its first run

Claude Code 2.1.316 sends the five-hour and weekly shares on every rate-limit
event; FLUJO used to keep a number only near a limit and showed "Usage not
exposed" while the numbers were there (#756).

Enforced by:
- `__tests__/model/claudeCodeStandIn.test.ts`
- `__tests__/model/claudeAllowanceFixtures.test.ts`
- `claudeRateLimitSignals` in `src/backend/services/model/allowance/claude.ts`
