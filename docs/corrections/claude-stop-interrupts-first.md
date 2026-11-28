# Stopping a running Claude turn asks Claude Code to interrupt before its input is closed, so it never sends one more model request that the subscription pays for and nobody reads

With only an abort, the bundled Claude Code answered the open approval or tool
call itself and asked the model again before it was killed (#1092, measured
with Claude Code 2.1.316).

Enforced by:
- `__tests__/model/claudeCodeStandIn.test.ts`
- `stopClaude` in `src/backend/services/model/adapters/claudeSubscriptionAdapter.ts`
