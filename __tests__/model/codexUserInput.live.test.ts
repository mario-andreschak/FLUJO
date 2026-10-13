import path from 'node:path';
import { promises as fs } from 'node:fs';
import { CodexAdapter } from '@/backend/services/model/adapters/codexAdapter';
import { buildQuestionTool, executeQuestionTool } from '@/backend/execution/flow/handlers/runQuestionTool';
import { resolvePendingQuestion, clearPendingQuestions } from '@/backend/services/questionRegistry';

const root = process.env.FLUJO_CODEX_USER_INPUT_ACCEPTANCE_ROOT;
const live = root && process.env.FLUJO_CODEX_USER_INPUT_ACCEPTANCE === '1' ? it : it.skip;
const nativeRequest = jest.fn();
jest.mock('@/backend/services/model/adapters/codexUserInput', () => {
  const actual = jest.requireActual<typeof import('@/backend/services/model/adapters/codexUserInput')>('@/backend/services/model/adapters/codexUserInput');
  return { ...actual, answerCodexUserInput: (...args: Parameters<typeof actual.answerCodexUserInput>) => {
    nativeRequest(); return actual.answerCodexUserInput(...args);
  }, answerCodexAsyncUserInput: (...args: Parameters<typeof actual.answerCodexAsyncUserInput>) => {
    nativeRequest(); return actual.answerCodexAsyncUserInput(...args);
  } };
});
jest.mock('@/utils/workspace', () => ({ ...jest.requireActual('@/utils/workspace'),
  getWorkspaceDataDir: () => process.env.FLUJO_CODEX_USER_INPUT_ACCEPTANCE_ROOT!,
  getCurrentWorkspace: () => 'codex-input-acceptance',
}));
live('answers an actual direct app-server question through the attended flow executor', async () => {
  if (!path.isAbsolute(root!)) throw new Error('Owned absolute acceptance data root required.');
  const question = buildQuestionTool(), conversationId = 'codex-direct-input-acceptance';
  nativeRequest.mockClear();
  let calls = 0, answers = 0;
  const receipt: Record<string, unknown> = { startedAt: new Date().toISOString(), model: 'gpt-6-luna', paidCostUsd: null };
  const previousUpdate = process.env.FLUJO_CODEX_AUTO_UPDATE;
  process.env.FLUJO_CODEX_AUTO_UPDATE = '0';
  try {
    const result = await new CodexAdapter().createCompletion({
      model: { id: 'codex-input-acceptance', name: 'gpt-6-luna', provider: 'openai', adapter: 'codex-cli', ApiKey: '', reasoningEffort: 'medium' },
      apiKey: '', conversationId, nodeId: 'process',
      messages: [{ role: 'system', content: 'For short user questions, use the native request_user_input tool and await the answer.' },
        { role: 'user', content: 'Use request_user_input (the native tool) exactly once to ask which color I want: Blue or Green. Wait for my answer, then reply with exactly the color I chose. Do not use the MCP question tool.' }],
      tools: [{ type: 'function', function: { name: question.name, description: question.description, parameters: question.inputSchema } }],
      localToolExecutors: { question: async args => {
        calls++;
        const outcome = await executeQuestionTool(args, { conversationId,
          emit: event => { if (event.type === 'run:awaiting_question') {
            expect(event.questions).toHaveLength(1);
            const offeredBlue = event.questions[0].options.find(label => /^Blue(?: \(Recommended\))?$/.test(label));
            expect(offeredBlue).toBeDefined();
            expect(resolvePendingQuestion(conversationId, event.questionId, [[offeredBlue!]])).toBe(true); answers++;
          } },
        });
        if (!outcome.success) throw new Error(outcome.error);
        return outcome.data;
      } },
      requestToolApproval: async () => true,
    });
    expect(nativeRequest).toHaveBeenCalledTimes(1);
    expect(calls).toBe(1); expect(answers).toBe(1);
    expect(result.completion.choices[0].message.content?.trim()).toBe('Blue');
    expect(result.completion.usage?.prompt_tokens).toBeGreaterThan(0);
    receipt.outcome = 'passed'; receipt.nativeRequests = nativeRequest.mock.calls.length;
    receipt.executorCalls = calls; receipt.answers = answers; receipt.usage = result.completion.usage;
  } catch (error) {
    receipt.outcome = 'failed'; receipt.errorClass = error instanceof Error ? error.name : 'unknown';
    throw error;
  } finally {
    receipt.nativeRequests = nativeRequest.mock.calls.length;
    receipt.executorCalls = calls; receipt.answers = answers;
    clearPendingQuestions(conversationId);
    if (previousUpdate === undefined) delete process.env.FLUJO_CODEX_AUTO_UPDATE;
    else process.env.FLUJO_CODEX_AUTO_UPDATE = previousUpdate;
    await fs.mkdir(root!, { recursive: true });
    await fs.writeFile(path.join(root!, 'acceptance.json'), JSON.stringify(receipt, null, 2));
  }
}, 180000);
