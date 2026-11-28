# Chat Completions servers other than OpenAI's own get one leading system message and a user turn (`chatTemplateWireFor`), checked against stand-ins for vLLM, llama.cpp, LM Studio and Ollama

Qwen 3.5's chat template refuses a system message that is not first and a
request without a user turn. After issue #1367 moved the system message back
to the front, compaction summaries, compacted turns and runs started without
input still broke those rules.

Enforced by:
- `__tests__/flow/selfHostedStandInRuns.test.ts`, `__tests__/model/chatTemplateWire.test.ts`
- `chatTemplateWireFor` in `src/backend/services/model/adapters/chatTemplateWire.ts`
