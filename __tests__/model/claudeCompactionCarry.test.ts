/**
 * #1091: Claude Code compacts its own session when the window fills, and that
 * summary is written by the model alone. Its SessionStart hook (source
 * "compact") puts FLUJO's exact records back in: standing user instructions
 * word for word and exact receipts of calls that already ran.
 */
import type OpenAI from 'openai';
import { claudeCompactionCarryHook, logClaudeCompaction } from '@/backend/services/model/adapters/claudeCompactionCarry';

jest.mock('@/utils/logger', () => {
  const log = { verbose: jest.fn(), debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() };
  return { createLogger: () => log };
});
const mockLog = jest.requireMock<{ createLogger: () => { info: jest.Mock } }>('@/utils/logger').createLogger();

const signal = new AbortController().signal;
const wire: OpenAI.ChatCompletionMessageParam[] = [
  { role: 'user', content: 'Do not email the customer until I say so.' },
  { role: 'assistant', content: '', tool_calls: [{ id: 'call-7', type: 'function', function: { name: 'refund', arguments: '{"order":"pedido-ñ-001"}' } }] },
  { role: 'tool', tool_call_id: 'call-7', content: 'refunded' },
  { role: 'user', content: 'What is the status?' },
];

describe('the carry after Claude Code compacts its own session', () => {
  it('adds FLUJO records only when the session was compacted', async () => {
    const onIncomplete = jest.fn();
    const hook = claudeCompactionCarryHook(() => wire, onIncomplete);
    for (const source of ['startup', 'resume', 'clear'] as const) {
      await expect(hook({ hook_event_name: 'SessionStart', source } as never, undefined, { signal })).resolves.toEqual({});
    }
    const output = await hook({ hook_event_name: 'SessionStart', source: 'compact' } as never, undefined, { signal }) as {
      hookSpecificOutput: { hookEventName: string; additionalContext: string };
    };
    expect(output.hookSpecificOutput.hookEventName).toBe('SessionStart');
    const carry = output.hookSpecificOutput.additionalContext;
    expect(carry).toContain('Do not email the customer until I say so.');
    expect(carry).not.toContain('What is the status?');
    expect(carry).toContain('"call_id":"call-7"');
    expect(carry).toContain('"arguments":"{\\"order\\":\\"pedido-ñ-001\\"}"');
    expect(onIncomplete).not.toHaveBeenCalled();
  });

  it('reads the conversation as it is when the compaction happens, the run\'s own new turns included', async () => {
    const live: OpenAI.ChatCompletionMessageParam[] = [{ role: 'user', content: 'Hello.' }];
    const hook = claudeCompactionCarryHook(() => live, jest.fn());
    await expect(hook({ hook_event_name: 'SessionStart', source: 'compact' } as never, undefined, { signal })).resolves.toEqual({});
    live.push({ role: 'user', content: 'Never touch the production database.' });
    await expect(hook({ hook_event_name: 'SessionStart', source: 'compact' } as never, undefined, { signal }))
      .resolves.toMatchObject({ hookSpecificOutput: { additionalContext: expect.stringContaining('Never touch the production database.') } });
  });

  it('reports a carry that could not hold every record, so the session is rebuilt from FLUJO history next turn', async () => {
    const onIncomplete = jest.fn();
    const crowded: OpenAI.ChatCompletionMessageParam[] = Array.from({ length: 40 }, (_, n) => ({
      role: 'user' as const, content: `Never change record ${n}. ` + 'x'.repeat(2_000),
    }));
    await claudeCompactionCarryHook(() => crowded, onIncomplete)({ hook_event_name: 'SessionStart', source: 'compact' } as never, undefined, { signal });
    expect(onIncomplete).toHaveBeenCalledTimes(1);
  });

  it('logs Claude Code\'s own compaction numbers and ignores other messages', () => {
    logClaudeCompaction({ type: 'system', subtype: 'init' });
    expect(mockLog.info).not.toHaveBeenCalled();
    logClaudeCompaction({ type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'auto', pre_tokens: 180_000, post_tokens: 9_000, duration_ms: 4_200 } });
    expect(mockLog.info).toHaveBeenCalledWith(expect.stringContaining('compacted'), { trigger: 'auto', preTokens: 180_000, postTokens: 9_000, durationMs: 4_200 });
  });
});
