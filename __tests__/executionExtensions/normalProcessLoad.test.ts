/**
 * Real normal completion service + runFlow + PocketFlow/Process nodes + banking
 * admission. Only external provider completion and storage side effects are
 * replaced. This is deterministic provider evidence, never paid-model latency.
 */
import { performance } from 'node:perf_hooks';
import { flowService } from '@/backend/services/flow';
import { modelService } from '@/backend/services/model';
import { getCompletionAdapter, type CompletionInput } from '@/backend/services/model/adapters';
import { FlowExecutor } from '@/backend/execution/flow/FlowExecutor';
import { processChatCompletion } from '@/app/v1/chat/completions/chatCompletionService';
import { parseRequestParameters } from '@/app/v1/chat/completions/requestParser';
import { configuredExecutionAdapter as adapter } from '@/integrations/hackathon-banking/configuredAdapter';
import { applyExecutionRunInput, executionToolRequestMeta, registerExecutionExtension, withExecutionExtensionRoute } from '@/backend/execution/extensions';
import { executionEventBus } from '@/backend/execution/flow/engine/ExecutionEventBus';
import { jwtVerify } from 'jose';
import { bankingFixture } from './bankingFixture';
import type { SharedState } from '@/backend/execution/flow/types';
import { NextRequest } from 'next/server';

const mockStates = new Map<string, SharedState>();
jest.mock('@/utils/logger', () => ({ createLogger: () => ({ debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn(), verbose: jest.fn() }) }));
jest.mock('@/utils/encryption/lockGate', () => ({ assertUnlocked: jest.fn(async () => null) }));
jest.mock('@/backend/services/flow', () => ({ flowService: { getFlow: jest.fn(), getFlowByName: jest.fn(), loadFlows: jest.fn() } }));
jest.mock('@/backend/services/model', () => ({ modelService: { getModel: jest.fn(), resolveAndDecryptApiKey: jest.fn() } }));
jest.mock('@/backend/services/model/adapters', () => ({ getCompletionAdapter: jest.fn() }));
jest.mock('@/utils/storage/backend', () => ({
  ...jest.requireActual('@/utils/storage/backend'),
  loadItem: jest.fn(async (key: string, fallback: unknown) => mockStates.get(key) ?? fallback),
  saveItem: jest.fn(async (key: string, state: SharedState) => { mockStates.set(key, JSON.parse(JSON.stringify(state))); }),
}));
jest.mock('@/backend/execution/flow/conversationLog', () => ({
  ...jest.requireActual('@/backend/execution/flow/conversationLog'),
  recoverMessagesFromLog: jest.fn(async () => false), appendRawForState: jest.fn(async () => undefined),
  appendFromBus: jest.fn(), flushConversationLog: jest.fn(async () => undefined), latestSequence: jest.fn(async () => 0),
}));
jest.mock('@/backend/execution/flow/conversationSummaryStore', () => ({
  ...jest.requireActual('@/backend/execution/flow/conversationSummaryStore'), persistConversationSummary: jest.fn(),
}));
jest.mock('@/backend/services/statistics', () => ({ ...jest.requireActual('@/backend/services/statistics'), recordStatisticsEvent: jest.fn() }));
jest.mock('@/backend/services/workspace/workspaceMutationGate', () => ({ withWorkspaceMutation: async (task: () => Promise<unknown>) => task() }));

describe('distinct customers use one normal Process graph with bounded admission', () => {
  let fixture: Awaited<ReturnType<typeof bankingFixture>>;
  let restore: () => void;
  beforeEach(async () => {
    mockStates.clear(); FlowExecutor.conversationStates.clear(); jest.clearAllMocks();
    fixture = await bankingFixture(4); restore = registerExecutionExtension(adapter);
    jest.mocked(flowService.getFlow).mockResolvedValue(fixture.graph);
    jest.mocked(flowService.getFlowByName).mockResolvedValue(fixture.graph);
    jest.mocked(flowService.loadFlows).mockResolvedValue([fixture.graph]);
    jest.mocked(modelService.getModel).mockResolvedValue({ id: 'deterministic-model', name: 'Deterministic',
      adapter: 'openai', provider: 'openai', ApiKey: 'fixture-only', temperature: 0 } as never);
    jest.mocked(modelService.resolveAndDecryptApiKey).mockResolvedValue('fixture-only');
  });
  afterEach(async () => { restore(); await fixture.close(); });

  test.each([1, 10, 50, 500])('%i distinct owners preserve response/history/event correlation through real Process execution', async count => {
    let active = 0; let peak = 0; let calls = 0;
    const completed: number[] = [];
    const contextByConversation = new Map<string, number>();
    const provider = jest.fn(async (input: CompletionInput) => {
      active++; peak = Math.max(peak, active); calls++;
      try {
        const user = input.messages.findLast(message => message.role === 'user');
        const slot = Number(String(user?.content).match(/request-(\d+)/)?.[1]);
        expect(Number.isInteger(slot)).toBe(true);
        expect(JSON.stringify(input.messages)).not.toContain('com.flujo.bank/assertion');
        const meta = await executionToolRequestMeta(input.executionExtensionContext!, fixture.policy.bankServerName,
          'list_my_transactions', { limit: 1 });
        const signed = await jwtVerify(String(meta['com.flujo.bank/assertion']), fixture.bank.publicKey,
          { issuer: fixture.policy.bankIssuer, audience: 'banking-mcp' });
        expect(signed.payload.sub).toBe(`owner-${slot}`);
        expect(signed.payload.conversation_id).toBe(input.conversationId);
        await new Promise<void>(resolve => setTimeout(resolve, (3 - slot % 4) * 2));
        completed.push(slot);
        return { completion: { id: `completion-${slot}`, object: 'chat.completion' as const,
          created: 1, model: 'deterministic', usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          choices: [{ index: 0, finish_reason: 'stop' as const, logprobs: null,
            message: { role: 'assistant' as const, content: `result-for-${slot}`, refusal: null } }] } };
      } finally { active--; }
    });
    jest.mocked(getCompletionAdapter).mockReturnValue({ createCompletion: provider });
    const timings: number[] = [];
    const started = performance.now();
    const requests = await Promise.all(Array.from({ length: count }, (_, slot) =>
      fixture.request(`owner-${slot}`, fixture.completion(`request-${slot}`))));
    const responses = await Promise.all(requests.map(async (request, slot) => {
      const begin = performance.now();
      const response = await withExecutionExtensionRoute(request, async admitted => {
        const trusted = applyExecutionRunInput({ source: 'api' });
        contextByConversation.set(trusted.conversationId!, slot);
        const parsed = await parseRequestParameters(admitted as NextRequest);
        const { flujo, requireApproval, flujodebug, conversation_id, ...data } = parsed;
        return processChatCompletion(data, flujo, requireApproval, flujodebug, conversation_id, false, true);
      });
      timings.push(performance.now() - begin);
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.choices[0].message.content).toContain(`result-for-${slot}`);
      expect(contextByConversation.get(body.conversation_id)).toBe(slot);
      return body.conversation_id as string;
    }));
    expect(new Set(responses).size).toBe(count);
    expect(calls).toBe(count);
    expect(peak).toBeLessThanOrEqual(fixture.policy.maxActiveRuns);
    if (count > 1) expect(peak).toBeGreaterThan(1);
    for (const [slot, id] of responses.entries()) {
      const state = mockStates.get(`conversations/${id}`)!;
      expect(state).toBeDefined(); expect(state.executionExtensionOwned).toBe(true);
      expect(state.executionExtensionContext).toBeUndefined();
      const assistant = state.messages.filter(message => message.role === 'assistant');
      expect(assistant.some(message => String(message.content).includes(`result-for-${slot}`))).toBe(true);
      expect(Array.from(JSON.stringify(assistant).matchAll(/result-for-(\d+)/g)).every(match => Number(match[1]) === slot)).toBe(true);
      const events = executionEventBus.getBufferedSince(id, 0);
      expect(events.length).toBeGreaterThan(0);
      expect(events.every(event => event.conversationId === id)).toBe(true);
      expect(Array.from(JSON.stringify(events).matchAll(/result-for-(\d+)/g)).every(match => Number(match[1]) === slot)).toBe(true);
    }
    timings.sort((a, b) => a - b);
    process.stdout.write(JSON.stringify({ scope: 'deterministic-normal-process', distinctOwners: count,
      providerCalls: calls, peakProviderActive: peak, p50Ms: timings[Math.ceil(count * .5) - 1],
      p95Ms: timings[Math.ceil(count * .95) - 1], elapsedMs: performance.now() - started,
      paidModelCalls: 0, staticNodes: 0 }) + '\n');
    expect(completed).toHaveLength(count);
  // Match the 450-second client budget for the approved lease of up to 410 seconds;
  // admission still enforces its own queue and active deadlines under CI load.
  }, 450_000);
});
