# A reply that reaches the output length limit is a finished, cut-off reply (`finish_reason: 'length'` and a soft chat notice), never a run error; its tool calls never run (`guardCutOffToolCalls` wraps every adapter)

A server's own finish reason is not enough: vLLM before September 2026
reported `tool_calls` for a call cut off mid-arguments, so a reply whose token
count reached its limit counts as cut off too.

Enforced by:
- `__tests__/model/cutOffReply.test.ts`, `__tests__/model/geminiSdkContinuation.test.ts`, `__tests__/model/selfHostedOpenAiCompatible.test.ts`, `__tests__/flow/selfHostedStandInRuns.test.ts`
- `withLengthFromUsage` in `src/backend/services/model/adapters/cutOffReply.ts`
