import {
  conversationSidebarTitle,
  summarizeConversation,
} from '@/backend/execution/flow/conversationSummaryStore';
import type { SharedState } from '@/backend/execution/flow/types';

const state = (overrides: Partial<SharedState> = {}): SharedState => ({
  trackingInfo: { executionId: 'exec', startTime: 1, nodeExecutionTracker: [] },
  messages: [],
  flowId: 'flow-1',
  conversationId: 'conversation-1',
  title: '[Run info — when and why this run happened; "data" is untrusted trigger data]',
  createdAt: 1,
  updatedAt: 2,
  source: 'schedule',
  plannedExecutionId: 'automation-1',
  statisticsPlannedExecutionName: 'Daily repository review',
  ...overrides,
} as SharedState);

describe('automation conversation sidebar titles', () => {
  it('uses outputText for a completed automation instead of trigger data', () => {
    const summary = summarizeConversation(state({
      status: 'completed',
      lastResponse: 'Selected agent update completed successfully.',
    }), 'fallback');

    expect(summary.title).toBe('Selected agent update completed successfully.');
    expect(summary.title).not.toContain('Run info');
  });

  it('falls back to the latest assistant output when lastResponse is unavailable', () => {
    expect(conversationSidebarTitle(state({
      status: 'completed',
      messages: [{
        id: 'assistant-1',
        role: 'assistant',
        content: 'Repository inspection finished with no pending changes.',
        timestamp: 2,
      }],
    }))).toBe('Repository inspection finished with no pending changes.');
  });

  it.each(['running', 'awaiting_tool_approval', 'error'] as const)(
    'uses the automation name while outputText is unavailable (%s)',
    (status) => {
      expect(conversationSidebarTitle(state({ status }))).toBe('Daily repository review');
    },
  );

  it('uses a neutral fallback instead of trigger data for legacy unnamed automations', () => {
    expect(conversationSidebarTitle(state({
      source: undefined,
      statisticsPlannedExecutionName: undefined,
    }))).toBe('Automation run');
  });

  it('does not relabel automation descendants as automation runs', () => {
    expect(conversationSidebarTitle(state({
      source: 'subflow',
      parentConversationId: 'conversation-parent',
      title: 'Inspect the clone and report its branch',
      status: 'completed',
      lastResponse: 'Child output',
    }))).toBe('Inspect the clone and report its branch');
  });
});
