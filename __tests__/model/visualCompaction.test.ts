import {
  detectVisualArchiveSecret,
  estimateVisualRoutes,
  renderVisualArchivePages,
  resolveVisionInputCapability,
  selectVisualArchiveCandidate,
} from '@/backend/execution/flow/handlers/visualCompaction';
import type OpenAI from 'openai';

const recent = (): OpenAI.ChatCompletionMessageParam[] => Array.from({ length: 6 }, (_, index) => ({
  role: 'user' as const,
  content: `recent-${index}`,
}));

describe('visualCompaction (issue #356)', () => {
  it('selects only a complete old assistant tool-call/result pair', () => {
    const messages: OpenAI.ChatCompletionMessageParam[] = [
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'read_big_log', arguments: '{}' } }],
      },
      { role: 'tool', tool_call_id: 'call-1', content: 'dense-output '.repeat(1_100) },
      ...recent(),
    ];
    const selected = selectVisualArchiveCandidate(messages, true);
    expect(selected.candidate).toMatchObject({ startIndex: 0, endIndex: 2, messageCount: 2, toolResultsOnly: true });
    expect(selected.text).toContain('[tool read_big_log]');
  });

  it('refuses incomplete tool pairs and preserves the recent six-message floor', () => {
    const messages: OpenAI.ChatCompletionMessageParam[] = [
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'missing', type: 'function', function: { name: 'x', arguments: '{}' } }],
      },
      { role: 'user', content: 'x'.repeat(20_000) },
      ...recent(),
    ];
    expect(selectVisualArchiveCandidate(messages, true).candidate).toBeUndefined();
  });

  it('conservatively rejects credential-like content', () => {
    expect(detectVisualArchiveSecret('Authorization: Bearer abcdefghijklmnopqrstuvwxyz')).toBe(true);
    expect(detectVisualArchiveSecret('ordinary public log output')).toBe(false);
  });

  it('renders deterministic PNG bytes and provider-aware estimates', () => {
    const first = renderVisualArchivePages('hello world\n'.repeat(100));
    const second = renderVisualArchivePages('hello world\n'.repeat(100));
    expect(first[0].base64).toBe(second[0].base64);
    expect(Buffer.from(first[0].base64, 'base64').subarray(1, 4).toString('ascii')).toBe('PNG');
    expect(estimateVisualRoutes(50_000, 500, first, 'openai').imageTokens)
      .not.toBe(estimateVisualRoutes(50_000, 500, first, 'anthropic').imageTokens);
  });

  it('uses explicit tri-state capability and keeps unknown safe', () => {
    expect(resolveVisionInputCapability({ adapter: 'openai', visionInputCapability: 'supported' })).toBe('supported');
    expect(resolveVisionInputCapability({ adapter: 'openai' })).toBe('unknown');
    expect(resolveVisionInputCapability({ adapter: 'codex-cli', visionInputCapability: 'supported' })).toBe('unsupported');
  });
});
