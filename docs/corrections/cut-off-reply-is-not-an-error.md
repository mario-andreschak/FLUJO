# A reply that reaches the output length limit is a finished, cut-off reply (`finish_reason: 'length'` and a soft chat notice), never a run error; its tool calls never run (`guardCutOffToolCalls` wraps every adapter)

Enforced by:
- `__tests__/model/cutOffReply.test.ts`, `__tests__/model/geminiSdkContinuation.test.ts`, `__tests__/model/selfHostedOpenAiCompatible.test.ts`
