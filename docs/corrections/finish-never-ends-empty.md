# A hand-off to Finish never ends a run with an empty reply: FLUJO takes answer text from the hand-off call, else asks the step once more without its tools, else replies in words that the model gave no answer (`flujo_no_answer`)

A model can hand off to Finish after reasoning only (#1419). The reply was
`content: ""` while the reasoning tokens were counted, which looked exactly
like a lost answer. The rule sits in the shared hand-off path of the run loop,
so every provider behaves the same. The extra request happens once per
hand-off and asks for the answer as plain text.

Enforced by:
- `__tests__/chat/finishWithoutAnswer.test.ts` (real chat route, an OpenAI-compatible stand-in, and the installed Agent SDK with its bundled Claude Code against a stand-in model service)
- `__tests__/flow/finishAnswer.test.ts`
- `__tests__/frontend/components/ChatCutOffNotice.test.tsx`
- `lacksFinishAnswer` in `src/backend/execution/flow/finishAnswer.ts`
