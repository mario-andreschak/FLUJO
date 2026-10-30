/**
 * Issue #1319 — live conversation-log persistence must not depend on resolving
 * the FlowExecutor module at runtime.
 *
 * In the production webpack bundle a lazy `require('@/backend/execution/flow/
 * FlowExecutor')` resolved to a module object WITHOUT `FlowExecutor`. The bus
 * tap's persistence check threw, was swallowed (warn level, hidden by default),
 * and every live event — streamed Agent SDK messages, tool calls, usage — was
 * silently dropped. Only the end-of-turn snapshot persisted anything, so a
 * cancelled turn lost everything and switching conversations hid the running
 * turn. This suite reproduces that module shape and pins the fix.
 */
import { promises as fs, readFileSync, readdirSync } from 'fs';
import os from 'os';
import path from 'path';

// Exactly what the production bundle handed the lazy require: no export.
jest.mock('@/backend/execution/flow/FlowExecutor', () => ({}));

const CONVERSATION = 'c1319000-0000-4000-8000-000000000001';

describe('conversation log live tap without a resolvable FlowExecutor module', () => {
  let dir: string;
  let restore: string | undefined;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'flujo-1319-'));
    const log = await import('@/backend/execution/flow/conversationLog');
    restore = log._setConversationLogDirForTests(dir);
  });

  afterEach(async () => {
    const { getConversationStates } = await import('@/backend/execution/flow/conversationStateRegistry');
    getConversationStates().delete(CONVERSATION);
    const log = await import('@/backend/execution/flow/conversationLog');
    if (restore !== undefined) log._setConversationLogDirForTests(restore);
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('persists live bus events (incl. mid-turn messages and usage) as they are emitted', async () => {
    const { getConversationStates } = await import('@/backend/execution/flow/conversationStateRegistry');
    const { executionEventBus } = await import('@/backend/execution/flow/engine/ExecutionEventBus');
    const log = await import('@/backend/execution/flow/conversationLog');
    getConversationStates().set(CONVERSATION, { conversationId: CONVERSATION, messages: [], flowId: 'f' } as never);

    executionEventBus.emit(CONVERSATION, { type: 'run:start', flowId: 'f' } as never);
    executionEventBus.emit(CONVERSATION, { type: 'message', message: {
      id: 'assistant-tool-call', role: 'assistant', content: '', timestamp: 1,
      tool_calls: [{ id: 't1', type: 'function', function: { name: 'bash__run', arguments: '{}' } }],
    } } as never);
    executionEventBus.emit(CONVERSATION, { type: 'message', message: {
      id: 'tool-result', role: 'tool', tool_call_id: 't1', content: 'ok', timestamp: 2,
    } } as never);
    executionEventBus.emit(CONVERSATION, { type: 'usage', usage: { promptTokens: 3, completionTokens: 4, totalTokens: 7 } } as never);

    // No end-of-turn materialization happens here: this is what a cancelled
    // turn leaves behind. It must already be durable.
    await log.flushConversationLog(CONVERSATION);
    const events = await log.readConversationLog(CONVERSATION);
    expect(events?.map(event => event.type)).toEqual(['run:start', 'message', 'message', 'usage']);
    expect(log.projectMessages(events ?? []).map(message => message.id)).toEqual(['assistant-tool-call', 'tool-result']);
  });

  it('folds streamed Agent SDK transcript messages into the live in-memory state', async () => {
    const { getConversationStates } = await import('@/backend/execution/flow/conversationStateRegistry');
    const { ModelHandler } = await import('@/backend/execution/flow/handlers/ModelHandler');
    const state = { conversationId: CONVERSATION, messages: [] as unknown[], flowId: 'f' };
    getConversationStates().set(CONVERSATION, state as never);

    const persist = (ModelHandler as unknown as {
      persistStreamedMessage(conversationId: string, message: unknown): void;
    }).persistStreamedMessage;
    persist(CONVERSATION, { id: 'stream-1', role: 'assistant', content: 'working', timestamp: 1 });
    persist(CONVERSATION, { id: 'stream-1', role: 'assistant', content: 'working on it', timestamp: 1 });

    expect(state.messages).toEqual([{ id: 'stream-1', role: 'assistant', content: 'working on it', timestamp: 1 }]);
  });

  it('sees live cancellation from the model handler', async () => {
    const { getConversationStates } = await import('@/backend/execution/flow/conversationStateRegistry');
    const { ModelHandler } = await import('@/backend/execution/flow/handlers/ModelHandler');
    getConversationStates().set(CONVERSATION, { conversationId: CONVERSATION, messages: [], isCancelled: true } as never);
    const cancelled = (ModelHandler as unknown as {
      isConversationCancelled(conversationId: string): boolean;
    }).isConversationCancelled(CONVERSATION);
    expect(cancelled).toBe(true);
  });
});

describe('no lazy runtime require of FlowExecutor in application source', () => {
  it('keeps live state consumers on the static registry', () => {
    const root = path.join(process.cwd(), 'src');
    const offenders: string[] = [];
    const walk = (directory: string) => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const file = path.join(directory, entry.name);
        if (entry.isDirectory()) walk(file);
        else if (entry.isFile() && /\.tsx?$/.test(entry.name)) {
          const source = readFileSync(file, 'utf8');
          // Neither require() nor a dynamic import() may be used just to reach
          // live conversation state; the registry is dependency-free.
          if (/require\(\s*['"][^'"]*\/FlowExecutor['"]\s*\)/.test(source)
            || (/import\(\s*['"][^'"]*\/FlowExecutor['"]\s*\)/.test(source) && /FlowExecutor\.conversationStates/.test(source))) {
            offenders.push(path.relative(root, file));
          }
        }
      }
    };
    walk(root);
    // The operations snapshot route is an HTTP entrypoint outside the cycle.
    expect(offenders.filter(file => !file.replace(/\\/g, '/').endsWith('app/api/operations/status/route.ts'))).toEqual([]);
  });
});
