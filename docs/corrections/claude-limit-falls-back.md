# A Claude run that ends at a used-up plan limit fails with the service's 429 and the limit's reset as Retry-After, so a fallback policy moves on to its next model

The error used to carry only Claude Code's text ("You've hit your 5-hour
limit"), which the fallback policy did not read as a rate limit, so a policy
whose first Claude login was used up gave no answer (#756, #1092).

Enforced by:
- `__tests__/chat/claudeFlowStandIn.test.ts`
- `__tests__/model/claudeCodeStandIn.test.ts`
- `claudeTerminalError` in `src/backend/services/model/adapters/claudeSubscriptionAdapter.ts`
