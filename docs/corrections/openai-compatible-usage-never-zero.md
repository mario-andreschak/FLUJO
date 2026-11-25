# Every OpenAI-compatible server is asked for token counts and read in its own spelling (`readOpenAiCompatibleUsage`); a call without counts shows "not reported", never 0

Enforced by:
- `__tests__/model/selfHostedOpenAiCompatible.test.ts`, `__tests__/flow/selfHostedServerRuns.test.ts`
