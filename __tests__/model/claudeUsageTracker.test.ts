import { ClaudeUsageTracker } from '@/backend/services/model/adapters/claudeUsageTracker';
import { mapSdkUsage, type SdkUsage } from '@/backend/services/model/adapters/claudeUsage';

function request(tracker: ClaudeUsageTracker, id: string, usage: SdkUsage, parent: string | null = null) {
  const message = { id, model: 'claude-test', usage: { ...usage, output_tokens: 999 } };
  tracker.observe({ type: 'stream_event', parent_tool_use_id: parent, event: { type: 'message_start', message } });
  // One SDK assistant frame per content block: all repeat the same usage.
  tracker.observe({ type: 'assistant', parent_tool_use_id: parent, message });
  tracker.observe({ type: 'assistant', parent_tool_use_id: parent, message });
  tracker.observe({ type: 'stream_event', parent_tool_use_id: parent, event: {
    type: 'message_delta', usage: { output_tokens: usage.output_tokens },
  } });
  tracker.observe({ type: 'stream_event', parent_tool_use_id: parent, event: { type: 'message_stop' } });
  tracker.observe({ type: 'assistant', parent_tool_use_id: parent, message });
}

describe('Claude Agent SDK usage scope', () => {
  it('deduplicates blocks, ignores placeholder output, and keeps only the last request for context', () => {
    const tracker = new ClaudeUsageTracker();
    request(tracker, 'first', { input_tokens: 100, cache_read_input_tokens: 900, output_tokens: 40 });
    request(tracker, 'second', { input_tokens: 200, cache_creation_input_tokens: 100, output_tokens: 60 });
    expect(mapSdkUsage(tracker.getUsage())).toEqual({
      promptTokens: 1300, completionTokens: 100, totalTokens: 1400, cacheReadTokens: 900, cacheWriteTokens: 100,
    });
    expect(tracker.getContextUsage(200000)).toEqual({
      promptTokens: 300, completionTokens: 60, totalTokens: 360,
      contextWindow: 200000, contextWindowSource: 'configured',
    });
  });

  it('replaces cumulative modelUsage snapshots and takes the runtime limit for the root model', () => {
    const tracker = new ClaudeUsageTracker();
    request(tracker, 'root', { input_tokens: 100, output_tokens: 20 });
    request(tracker, 'child', { input_tokens: 500, output_tokens: 70 }, 'tool-child');
    const report = (inputTokens: number) => tracker.observe({ type: 'result',
      usage: { input_tokens: 100, output_tokens: 20 },
      modelUsage: {
        'claude-test': { inputTokens, outputTokens: 20, cacheReadInputTokens: 900, contextWindow: 200000 },
        'child-model': { inputTokens: 500, outputTokens: 70, contextWindow: 1000000 },
      },
    });
    report(100);
    report(200);
    expect(mapSdkUsage(tracker.getUsage())).toMatchObject({ promptTokens: 1600, completionTokens: 90 });
    expect(tracker.getContextUsage(1000000)).toEqual({
      promptTokens: 100, completionTokens: 20, totalTokens: 120,
      contextWindow: 200000, contextWindowSource: 'runtime',
    });
    expect(new ClaudeUsageTracker().getUsage()).toBeUndefined();
  });

  it('adds per-turn legacy results and observed child usage without counting previous turns twice', () => {
    const tracker = new ClaudeUsageTracker();
    request(tracker, 'first', { input_tokens: 10, output_tokens: 2 });
    request(tracker, 'child', { input_tokens: 20, output_tokens: 3 }, 'child');
    tracker.observe({ type: 'result', usage: { input_tokens: 10, output_tokens: 2 } });
    request(tracker, 'second', { input_tokens: 30, output_tokens: 4 });
    tracker.observe({ type: 'result', usage: { input_tokens: 30, output_tokens: 4 } });
    expect(mapSdkUsage(tracker.getUsage())).toMatchObject({ promptTokens: 60, completionTokens: 9 });
    request(tracker, 'handoff', { input_tokens: 40, output_tokens: 5 });
    tracker.observe({ type: 'result' }); // Missing telemetry must not reset the checkpoint.
    expect(mapSdkUsage(tracker.getUsage())).toMatchObject({ promptTokens: 100, completionTokens: 14 });
  });

  it('does not pretend run totals or subagent input are the root context', () => {
    const tracker = new ClaudeUsageTracker();
    request(tracker, 'child', { input_tokens: 100, output_tokens: 20 }, 'child');
    tracker.observe({ type: 'result', usage: { input_tokens: 5000000, output_tokens: 9000 } });
    expect(tracker.getContextUsage(1000000)).toBeNull();
  });

  it('reports input alone when the last request has no exact output count', () => {
    const tracker = new ClaudeUsageTracker();
    tracker.observe({ type: 'assistant', message: {
      id: 'first', usage: { input_tokens: 10, cache_read_input_tokens: 200, output_tokens: 999 },
    } });
    expect(tracker.getContextUsage()).toEqual({ promptTokens: 210 });
  });
});
