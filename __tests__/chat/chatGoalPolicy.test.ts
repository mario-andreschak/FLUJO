/**
 * What a chat goal does after a turn (#1225): the agent's verdict line, turns
 * that do nothing, failures with their waits, Stop, and the person's message.
 */
import {
  GOAL_RETRY_BASE_MS,
  GOAL_RETRY_MAX_MS,
  beginChatGoalTurn,
  canStartChatGoalTurn,
  chatGoalTurnText,
  chatTurnOutcome,
  parseGoalVerdict,
  reviewChatTurn,
  settleChatGoal,
  type ChatTurnReview,
} from '@/backend/services/chatGoals/chatGoalPolicy';
import type { SharedState } from '@/backend/execution/flow/types';
import type { FlujoChatMessage } from '@/shared/types/chat';
import { CHAT_GOAL_FAILED_ROUNDS, CHAT_GOAL_QUIET_ROUNDS, type ChatGoal } from '@/shared/types/chatGoal';

const NOW = 1_000_000;

const goal = (overrides: Partial<ChatGoal> = {}): ChatGoal => ({
  id: 'goal_1', conversationId: 'c1', text: 'Make the tests pass', state: 'active', createdAt: 1, updatedAt: 1,
  rounds: 1, quietRounds: 0, failedRounds: 0, ...overrides,
});

const review = (overrides: Partial<ChatTurnReview> = {}): ChatTurnReview => ({
  lastMessageId: 'm9', personWrote: false, goalTurnSeen: true, pendingTurnLanded: true, usedTools: false, ...overrides,
});

const message = (id: string, role: FlujoChatMessage['role'], content: string, extra: Partial<FlujoChatMessage> = {}) =>
  ({ id, role, content, timestamp: 1, ...extra } as FlujoChatMessage);

describe('the goal turn the agent receives', () => {
  it('names the round and the goal, and says how to report the verdict', () => {
    const first = chatGoalTurnText(goal(), 1);
    expect(first).toMatch(/^Goal \(round 1\): Make the tests pass/);
    expect(first).toContain('end your reply with the line GOAL ACHIEVED');
    expect(first).toContain('GOAL BLOCKED:');
    expect(first).not.toContain('took no action');
    expect(chatGoalTurnText(goal({ quietRounds: 1 }), 3)).toMatch(/^Goal \(round 3\):[\s\S]*Your last reply took no action\./);
  });
});

describe('the verdict line', () => {
  it.each([
    ['All green.\nGOAL ACHIEVED', { kind: 'achieved' }],
    ['All green.\n**GOAL ACHIEVED**', { kind: 'achieved' }],
    ['Done\n\ngoal achieved.', { kind: 'achieved' }],
    ['> GOAL BLOCKED: I need the API key', { kind: 'blocked', detail: 'I need the API key' }],
    ['GOAL BLOCKED — the server is down', { kind: 'blocked', detail: 'the server is down' }],
    ['GOAL BLOCKED', { kind: 'blocked' }],
    ['GOAL BLOCKED: wait\nfixed it\nGOAL ACHIEVED', { kind: 'achieved' }],
  ])('reads %j', (reply, verdict) => {
    expect(parseGoalVerdict(reply).verdict).toEqual(verdict);
  });

  it('ignores the words inside ordinary sentences', () => {
    expect(parseGoalVerdict('I will say GOAL ACHIEVED once the tests pass.').verdict).toBeUndefined();
    expect(parseGoalVerdict('Is the goal achieved? Not yet.').verdict).toBeUndefined();
  });

  it('returns the reply without the verdict line', () => {
    expect(parseGoalVerdict('Fixed the build.\nGOAL ACHIEVED').rest.trim()).toBe('Fixed the build.');
  });
});

describe('looking at the chat since the last review', () => {
  const messages = [
    message('u1', 'user', 'Hello'),
    message('a1', 'assistant', 'Hi'),
    message('g2', 'user', 'Goal (round 2): …', { goalTurn: { goalId: 'goal_1', round: 2 } }),
    message('a2', 'assistant', '', { tool_calls: [{ id: 't', type: 'function', function: { name: 'ls', arguments: '{}' } }] }),
    message('t2', 'tool', 'files', { tool_call_id: 't' } as Partial<FlujoChatMessage>),
    message('a3', 'assistant', 'Listed the files.\nGOAL ACHIEVED'),
  ];

  it('sees the goal turn, the tool use, the verdict and the agent’s words', () => {
    expect(reviewChatTurn(messages, goal({ reviewedMessageId: 'a1', turn: { messageId: 'g2', round: 2, startedAt: 1 } }))).toEqual({
      lastMessageId: 'a3', personWrote: false, goalTurnSeen: true, pendingTurnLanded: true, usedTools: true,
      verdict: { kind: 'achieved' }, note: 'Listed the files.',
    });
  });

  it('tells the person’s messages from goal turns, agent messages and automation events', () => {
    const others = [
      message('m1', 'user', 'From another agent', { agentMessage: { senderConversationId: 'x', recipientConversationId: 'c1', kind: 'message' } }),
      message('m2', 'user', 'An event', { triggerEvent: { executionId: 'e', serverName: 's', source: 'events' } }),
      message('m3', 'user', 'A sub-step', { depth: 1 }),
    ];
    expect(reviewChatTurn(others, goal()).personWrote).toBe(false);
    expect(reviewChatTurn([...others, message('m4', 'user', 'Use Python', { injected: true })], goal()).personWrote).toBe(true);
  });

  it('notices a goal turn that never reached the chat', () => {
    expect(reviewChatTurn(messages, goal({ reviewedMessageId: 'a3', turn: { messageId: 'lost', round: 3, startedAt: 1 } })).pendingTurnLanded)
      .toBe(false);
  });

  it('looks at the latest turn only when the reviewed message is gone after an edit', () => {
    const result = reviewChatTurn(messages, goal({ reviewedMessageId: 'deleted' }));
    expect(result.goalTurnSeen).toBe(true);
    expect(result.personWrote).toBe(false);
  });
});

describe('how the last turn ended', () => {
  const state = (overrides: Partial<SharedState>) => overrides as SharedState;

  it('waits while a reply runs, waits for approval or the debugger, or was cut off by a restart', () => {
    expect(chatTurnOutcome(state({ status: 'running' }))).toEqual({ kind: 'waiting' });
    expect(chatTurnOutcome(state({ status: 'awaiting_tool_approval' }))).toEqual({ kind: 'waiting' });
    expect(chatTurnOutcome(state({ status: 'paused_debug' }))).toEqual({ kind: 'waiting' });
    expect(chatTurnOutcome(state({ status: 'error', recovery: { classification: 'interrupted' } as SharedState['recovery'] })))
      .toEqual({ kind: 'waiting' });
  });

  it('is done after a finished, capped or brand-new chat', () => {
    expect(chatTurnOutcome(state({ status: 'completed' }))).toEqual({ kind: 'done' });
    expect(chatTurnOutcome(state({ status: 'capped' }))).toEqual({ kind: 'done' });
    expect(chatTurnOutcome(state({}))).toEqual({ kind: 'done' });
  });

  it('knows Stop and failures, and whether a failure can be retried', () => {
    expect(chatTurnOutcome(state({ status: 'error', recovery: { classification: 'cancelled' } as SharedState['recovery'] })))
      .toEqual({ kind: 'stopped' });
    expect(chatTurnOutcome(state({
      status: 'error',
      recovery: { classification: 'retryable_failure', retryAfterAt: NOW + 5_000,
        failure: { category: 'rate_limit', message: 'Too many requests', retryable: true } } as SharedState['recovery'],
    }))).toEqual({ kind: 'failed', retryable: true, message: 'Too many requests', retryAfterAt: NOW + 5_000 });
    expect(chatTurnOutcome(state({ status: 'error', lastResponse: { success: false, error: 'invalid api key', errorDetails: { status: 401 } } })))
      .toMatchObject({ kind: 'failed', retryable: false });
  });
});

describe('the goal after a turn', () => {
  it('is reached when the agent says so', () => {
    expect(settleChatGoal(goal({ quietRounds: 2 }), review({ verdict: { kind: 'achieved' } }), { kind: 'done' }, NOW))
      .toMatchObject({ state: 'achieved', achievedAt: NOW, quietRounds: 0, reviewedMessageId: 'm9' });
  });

  it('waits for the person when the agent is blocked', () => {
    expect(settleChatGoal(goal(), review({ verdict: { kind: 'blocked', detail: 'Need a key' } }), { kind: 'done' }, NOW))
      .toMatchObject({ state: 'paused', pause: { reason: 'blocked', detail: 'Need a key', at: NOW } });
  });

  it('pauses after several goal turns in a row that did nothing', () => {
    let current = goal();
    for (let round = 1; round < CHAT_GOAL_QUIET_ROUNDS; round += 1) {
      current = settleChatGoal(current, review(), { kind: 'done' }, NOW);
      expect(current).toMatchObject({ state: 'active', quietRounds: round });
    }
    expect(settleChatGoal(current, review(), { kind: 'done' }, NOW)).toMatchObject({ state: 'paused', pause: { reason: 'no_progress' } });
    expect(settleChatGoal(goal({ quietRounds: 2 }), review({ usedTools: true }), { kind: 'done' }, NOW).quietRounds).toBe(0);
    expect(settleChatGoal(goal({ quietRounds: 2 }), review({ goalTurnSeen: false }), { kind: 'done' }, NOW).quietRounds).toBe(2);
  });

  it('waits longer after each failed turn, honours the provider’s wait, then pauses with the error', () => {
    const failure = { kind: 'failed' as const, retryable: true, message: 'Server overloaded' };
    const first = settleChatGoal(goal(), review(), failure, NOW);
    expect(first).toMatchObject({ state: 'active', failedRounds: 1, retryAt: NOW + GOAL_RETRY_BASE_MS });
    expect(settleChatGoal(first, review(), failure, NOW).retryAt).toBe(NOW + 2 * GOAL_RETRY_BASE_MS);
    expect(settleChatGoal(goal(), review(), { ...failure, retryAfterAt: NOW + 10 * GOAL_RETRY_MAX_MS }, NOW).retryAt)
      .toBe(NOW + 10 * GOAL_RETRY_MAX_MS);
    expect(settleChatGoal(goal({ failedRounds: CHAT_GOAL_FAILED_ROUNDS }), review(), failure, NOW))
      .toMatchObject({ state: 'paused', pause: { reason: 'error', detail: 'Server overloaded' } });
    expect(settleChatGoal(goal(), review(), { ...failure, retryable: false }, NOW).state).toBe('paused');
  });

  it('counts a goal turn that never started as a failed turn', () => {
    expect(settleChatGoal(goal({ turn: { messageId: 'lost', round: 2, startedAt: 1 } }), review({ pendingTurnLanded: false }),
      { kind: 'done' }, NOW)).toMatchObject({ state: 'active', failedRounds: 1, turn: undefined });
  });

  it('pauses on Stop', () => {
    expect(settleChatGoal(goal(), review(), { kind: 'stopped' }, NOW)).toMatchObject({ state: 'paused', pause: { reason: 'stopped' } });
  });

  it('goes on after the person writes, unless the person paused it', () => {
    for (const reason of ['stopped', 'no_progress', 'blocked', 'error'] as const) {
      const paused = goal({ state: 'paused', pause: { reason, at: 1 }, quietRounds: 3, failedRounds: 2 });
      expect(settleChatGoal(paused, review({ personWrote: true, goalTurnSeen: false }), { kind: 'done' }, NOW))
        .toMatchObject({ state: 'active', pause: undefined, quietRounds: 0, failedRounds: 0 });
      expect(settleChatGoal(paused, review({ personWrote: false }), { kind: 'done' }, NOW).state).toBe('paused');
    }
    const byPerson = goal({ state: 'paused', pause: { reason: 'person', at: 1 } });
    expect(settleChatGoal(byPerson, review({ personWrote: true }), { kind: 'done' }, NOW).state).toBe('paused');
  });

  it('starts a turn only when active, idle and past any wait', () => {
    expect(canStartChatGoalTurn(goal(), NOW)).toBe(true);
    expect(canStartChatGoalTurn(goal({ retryAt: NOW + 1 }), NOW)).toBe(false);
    expect(canStartChatGoalTurn(goal({ turn: { messageId: 'm', round: 2, startedAt: 1 } }), NOW)).toBe(false);
    expect(canStartChatGoalTurn(goal({ state: 'paused' }), NOW)).toBe(false);
    expect(beginChatGoalTurn(goal({ rounds: 4, retryAt: NOW - 1 }), 'm5', NOW))
      .toMatchObject({ rounds: 5, turn: { messageId: 'm5', round: 5, startedAt: NOW }, retryAt: undefined });
  });
});
