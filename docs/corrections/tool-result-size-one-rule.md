# Every place that hands a tool result to a model sizes it with `resolveToolResultBound` (`src/shared/toolResultLimit.ts`) and the AI step's own limit, and a shortened result never keeps `structuredContent` (`withBoundedToolText`)

Enforced by:
- `__tests__/architecture/toolResultBoundSingleRule.test.ts`
- `__tests__/model/codexAdapter.test.ts`, `__tests__/model/claudeSubscriptionBuiltinTools.test.ts`
- `__tests__/flow/toolResultLimitRunPaths.test.ts`
