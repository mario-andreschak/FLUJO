import {
  createChatSlashCommands,
  type ChatSlashActions,
  type ChatSlashContext,
  type ChatSlashServices,
} from '@/frontend/components/Chat/chatSlashCommands';
import { formatNumber, translate, translatePlural } from '@/frontend/i18n/core';
import type { ManualCompactionResponse } from '@/shared/types/contextCompaction';
import type { PersonaWorkItem } from '@/shared/types/enduringAgent';
import type { ChatGoal } from '@/shared/types/chatGoal';

const i18n = {
  t: (key: Parameters<typeof translate>[1], values?: Parameters<typeof translate>[2]) => translate('en', key, values),
  tp: (key: Parameters<typeof translatePlural>[1], count: number, values?: Parameters<typeof translatePlural>[3]) =>
    translatePlural('en', key, count, values),
  formatNumber: (value: number) => formatNumber('en', value),
};

const flowChat: ChatSlashContext = {
  conversationId: 'conv-1',
  title: 'Release notes',
  flowId: 'flow-1',
  agentName: 'Writer',
  readOnly: false,
  messageCount: 12,
  runState: 'idle',
  nextNodeLabel: 'Draft',
  queuedCount: 0,
  requireApproval: true,
  usage: { promptTokens: 5000, completionTokens: 700 },
  contextInfo: { promptTokens: 3200, contextWindow: 128_000, modelDisplayName: 'Test model' },
};

const personaChat: ChatSlashContext = {
  ...flowChat,
  flowId: null,
  agentName: undefined,
  personaId: 'persona_1',
  personaName: 'Ada',
};

const preview = {
  estimatedTokens: 40_000,
  keepTokens: 19_000,
  summarizedMessages: 9,
  keptRecentMessages: 4,
  keptEarlierUserMessages: 3,
  standingInstructions: 1,
  earlierUserMessagesFit: true,
};

function goal(overrides: Partial<PersonaWorkItem> & { state?: NonNullable<PersonaWorkItem['goal']>['state'] }): PersonaWorkItem {
  const { state = 'active', ...rest } = overrides;
  return {
    schemaVersion: 1, id: 'work_1', personaId: 'persona_1', title: 'Goal', status: 'in_progress',
    priority: 'normal', dependencyIds: [], createdAt: 1, updatedAt: 1,
    goal: {
      successCriteria: 'done', continuationIntervalMs: 60_000, maxConsecutiveFailures: 3, maxRoundsPerDay: 10,
      state, rounds: 0, consecutiveFailures: 0, dailyWindowStartedAt: 0, roundsInWindow: 0,
    },
    ...rest,
  } as PersonaWorkItem;
}

function chatGoal(overrides: Partial<ChatGoal> = {}): ChatGoal {
  return {
    id: 'goal_1', conversationId: 'conv-1', text: 'Ship the release notes', state: 'active', createdAt: 1, updatedAt: 1,
    rounds: 0, quietRounds: 0, failedRounds: 0, ...overrides,
  };
}

function setup(context: ChatSlashContext, overrides: Partial<ChatSlashServices> = {}) {
  const actions: jest.Mocked<ChatSlashActions> = {
    startNewConversation: jest.fn(async () => undefined),
    forkConversation: jest.fn(async () => 'copy-1'),
    goalChanged: jest.fn(),
  };
  const services: jest.Mocked<ChatSlashServices> = {
    createGoal: jest.fn(async (_personaId, input) => goal({ id: input.id!, title: input.title })),
    getGoal: jest.fn(async () => { throw new Error('missing'); }),
    listGoals: jest.fn(async () => []),
    requestCompaction: jest.fn(async (): Promise<ManualCompactionResponse> => ({ status: 'requested', running: false, preview })),
    getChatGoal: jest.fn(async () => null),
    setChatGoal: jest.fn(async (_id: string, text: string) => ({ goal: chatGoal({ text }), running: false })),
    updateChatGoal: jest.fn(async (_id: string, action: string) => ({
      goal: chatGoal(action === 'pause' ? { state: 'paused', pause: { reason: 'person', at: 2 } } : {}), running: false,
    })),
    clearChatGoal: jest.fn(async () => chatGoal()),
    newId: jest.fn(() => '1234-abcd'),
    ...overrides,
  } as jest.Mocked<ChatSlashServices>;
  return { host: createChatSlashCommands(context, actions, services, i18n), actions, services };
}

describe('chat slash commands (#1225)', () => {
  it('offers goals in every chat and compaction only to agent chats, and says why', () => {
    const flow = setup(flowChat).host;
    expect(flow.availability('compact')).toEqual({ available: true });
    expect(flow.availability('goal')).toEqual({ available: true });

    const persona = setup(personaChat).host;
    expect(persona.availability('goal')).toEqual({ available: true });
    expect(persona.availability('compact')).toEqual({
      available: false, reason: expect.stringContaining('looks after its own memory'),
    });

    const empty = setup({ ...flowChat, messageCount: 0 }).host;
    expect(empty.availability('compact').available).toBe(false);
    expect(empty.availability('fork').available).toBe(false);

    const archived = setup({ ...personaChat, readOnly: true }).host;
    expect(archived.availability('goal')).toEqual({ available: false, reason: 'This chat is read-only.' });
    expect(archived.availability('new').available).toBe(false);

    const none = setup({ ...flowChat, conversationId: null }).host;
    expect(none.availability('status').available).toBe(false);
    expect(none.availability('goal')).toEqual({ available: false, reason: 'Open or start a chat first.' });
    expect(none.availability('help').available).toBe(true);
    expect(none.availability('new').available).toBe(true);
  });

  it('/goal <text> creates an ongoing Persona goal through the Persona API, the same shape as the Persona page', async () => {
    const { host, services } = setup(personaChat);
    const notice = await host.run('goal', 'Keep the docs in sync with every release');
    expect(services.createGoal).toHaveBeenCalledWith('persona_1', {
      id: 'work_1234abcd',
      title: 'Keep the docs in sync with every release',
      priority: 'normal',
      dependencyIds: [],
      goal: {
        successCriteria: 'Keep the docs in sync with every release',
        completionPolicy: 'success_criteria',
        continuationIntervalMs: 60_000,
      },
    });
    expect(notice).toMatchObject({ tone: 'success', title: 'New goal: Keep the docs in sync with every release' });
  });

  it('/goal recovers a goal that was saved although its answer was lost', async () => {
    const lost = Object.assign(new Error('socket hang up'), { status: 502 });
    const { host, services } = setup(personaChat, {
      createGoal: jest.fn(async () => { throw lost; }),
      getGoal: jest.fn(async (_personaId: string, id: string) => goal({ id, title: 'Saved anyway' })),
    });
    const notice = await host.run('goal', 'Saved anyway');
    expect(services.getGoal).toHaveBeenCalledWith('persona_1', 'work_1234abcd');
    expect(notice?.tone).toBe('success');

    const rejected = Object.assign(new Error('Invalid goal'), { status: 400 });
    const refusal = setup(personaChat, { createGoal: jest.fn(async () => { throw rejected; }) });
    expect(await refusal.host.run('goal', 'x')).toMatchObject({ tone: 'error', lines: ['It did not work: Invalid goal'] });
    expect(refusal.services.getGoal).not.toHaveBeenCalled();
  });

  it('/goal alone lists the open goals with their state', async () => {
    const { host } = setup(personaChat, {
      listGoals: jest.fn(async () => [
        goal({ id: 'a', title: 'Old', updatedAt: 1, state: 'paused' }),
        goal({ id: 'b', title: 'Done', updatedAt: 3, state: 'completed' }),
        goal({ id: 'c', title: 'New', updatedAt: 2 }),
        { ...goal({ id: 'd', title: 'Plain task' }), goal: undefined },
      ]),
    });
    const notice = await host.run('goal', '');
    expect(notice?.title).toBe('Goals of this Persona');
    expect(notice?.lines?.slice(0, 2)).toEqual(['New (Ongoing goal)', 'Old (Goal paused)']);
  });

  it('/compact asks the server and confirms what is summarized and what stays', async () => {
    const { host, services } = setup(flowChat);
    const notice = await host.run('compact', '');
    expect(services.requestCompaction).toHaveBeenCalledWith('conv-1');
    expect(notice).toEqual({
      tone: 'success',
      title: 'Summary requested',
      lines: [
        "The AI's next reply uses a summary of older messages.",
        '9 older AI and tool messages are summarized.',
        'The 4 most recent messages stay word for word.',
        'Your 3 earlier messages stay word for word.',
        'Your saved chat stays complete. Only what is sent to the AI gets shorter.',
      ],
    });
  });

  it('/compact names only the guaranteed rules when earlier messages are too long to all stay', async () => {
    const { host } = setup(flowChat, {
      requestCompaction: jest.fn(async (): Promise<ManualCompactionResponse> => ({
        status: 'requested', running: true, preview: { ...preview, earlierUserMessagesFit: false, standingInstructions: 2 },
      })),
    });
    const lines = (await host.run('compact', ''))?.lines ?? [];
    expect(lines[0]).toBe('The reply in progress switches to the summary at its next step.');
    expect(lines).toContain('2 earlier messages of yours with rules or corrections stay word for word.');
    expect(lines.some(line => line.startsWith('Your 3 earlier'))).toBe(false);
  });

  it('/compact explains when there is nothing to summarize and when a Persona owns the chat', async () => {
    const nothing = setup(flowChat, {
      requestCompaction: jest.fn(async (): Promise<ManualCompactionResponse> => ({
        status: 'requested', running: false, preview: { ...preview, summarizedMessages: 0, estimatedTokens: 1200 },
      })),
    });
    expect(await nothing.host.run('compact', '')).toMatchObject({ tone: 'info', title: 'Nothing to summarize yet' });

    const owned = Object.assign(new Error('A Persona manages the memory'), { status: 409, body: { reason: 'persona_owned' } });
    const persona = setup(flowChat, { requestCompaction: jest.fn(async () => { throw owned; }) });
    expect((await persona.host.run('compact', ''))?.lines?.[0]).toContain('looks after its own memory');
  });

  it('/new and /fork use the existing New and Split features', async () => {
    const { host, actions } = setup(flowChat);
    expect(await host.run('new', '')).toBeNull();
    expect(actions.startNewConversation).toHaveBeenCalledTimes(1);

    const forked = await host.run('fork', '');
    expect(actions.forkConversation).toHaveBeenCalledTimes(1);
    expect(forked).toMatchObject({ tone: 'success', conversationId: 'copy-1' });
    expect(forked?.lines?.[0]).toContain('“Release notes”');
  });

  it('/context and /status read the meter and run state already on screen', async () => {
    const { host } = setup({ ...flowChat, runState: 'approval', queuedCount: 2 });
    expect((await host.run('context', ''))?.lines).toEqual([
      'Last request: 3,200 of 128,000 tokens (3%)',
      'AI: Test model',
      'Whole chat so far: 5,000 tokens in, 700 tokens out',
      'Type /compact to summarize older messages.',
    ]);
    expect((await host.run('status', ''))?.lines).toEqual([
      'Now: waiting for your approval',
      'Agent: Writer',
      'Next step: Draft',
      '12 messages in this chat',
      '2 messages wait to be sent',
      'Tools ask for your approval before they run.',
    ]);
  });

  it('/help lists only the commands that work in this chat', async () => {
    const lines = (await setup(flowChat).host.run('help', ''))?.lines ?? [];
    expect(lines.some(line => line.startsWith('/compact — '))).toBe(true);
    expect(lines.some(line => line.startsWith('/goal <what to achieve> — '))).toBe(true);
    expect(lines.at(-1)).toContain('//goal');
    const personaLines = (await setup(personaChat).host.run('help', ''))?.lines ?? [];
    expect(personaLines.some(line => line.startsWith('/compact'))).toBe(false);
  });

  it('answers an unavailable command with its reason instead of running it', async () => {
    const { host, services } = setup({ ...flowChat, conversationId: null });
    expect(await host.run('goal', 'anything')).toMatchObject({ tone: 'warning', title: '/goal' });
    expect(services.createGoal).not.toHaveBeenCalled();
    expect(services.setChatGoal).not.toHaveBeenCalled();
  });

  describe('/goal in a chat with an agent', () => {
    it('sets the chat goal, says the agent starts now, and refreshes the goal bar', async () => {
      const { host, services, actions } = setup(flowChat);
      const notice = await host.run('goal', 'Ship the release notes');
      expect(services.setChatGoal).toHaveBeenCalledWith('conv-1', 'Ship the release notes');
      expect(services.createGoal).not.toHaveBeenCalled();
      expect(actions.goalChanged).toHaveBeenCalledTimes(1);
      expect(notice).toEqual({
        tone: 'success',
        title: 'Goal set: Ship the release notes',
        lines: [
          'The agent starts now and keeps going until it says the goal is met.',
          'Type /goal to see how it goes, /goal pause to hold it or /goal clear to drop it.',
        ],
      });
    });

    it('says the agent starts after the reply in progress', async () => {
      const { host } = setup({ ...flowChat, runState: 'running' }, {
        setChatGoal: jest.fn(async () => ({ goal: chatGoal(), running: true })),
      });
      expect((await host.run('goal', 'Ship the release notes'))?.lines?.[0])
        .toBe('The agent starts on it once the current reply is done, and keeps going until it says the goal is met.');
    });

    it('shows the goal, where it stands and what to do next', async () => {
      const none = setup(flowChat);
      expect(await none.host.run('goal', '')).toEqual({
        tone: 'info', title: 'Goal of this chat',
        lines: ['This chat has no goal. Type /goal and what the agent should achieve.'],
      });

      const working = setup(flowChat, {
        getChatGoal: jest.fn(async () => chatGoal({ rounds: 3, lastNote: 'Wrote the summary.' })),
      });
      expect((await working.host.run('goal', ''))?.lines).toEqual([
        'Ship the release notes',
        'Working on it, round 3',
        'Last update: Wrote the summary.',
        'Type /goal pause to hold it or /goal clear to drop it.',
      ]);

      const blocked = setup(flowChat, {
        getChatGoal: jest.fn(async () => chatGoal({ state: 'paused', pause: { reason: 'blocked', detail: 'I need the key', at: 2 } })),
      });
      expect((await blocked.host.run('goal', ''))?.lines?.slice(1)).toEqual([
        'Waiting for you: I need the key',
        'Send a message and the agent goes on.',
      ]);

      const reached = setup(flowChat, { getChatGoal: jest.fn(async () => chatGoal({ state: 'achieved', rounds: 2 })) });
      expect((await reached.host.run('goal', ''))?.lines?.slice(1)).toEqual([
        'Reached',
        'Type /goal and a new goal to start another.',
      ]);
    });

    it('pauses, resumes and clears with words after /goal, including the clear aliases', async () => {
      const { host, services, actions } = setup(flowChat);
      expect(await host.run('goal', 'PAUSE')).toEqual({ tone: 'info', title: '/goal', lines: ['Goal paused. Type /goal resume to go on.'] });
      expect(services.updateChatGoal).toHaveBeenLastCalledWith('conv-1', 'pause');
      expect(await host.run('goal', 'resume')).toEqual({ tone: 'success', title: '/goal', lines: ['Goal resumed. The agent goes on now.'] });
      for (const word of ['clear', 'stop', 'off', 'reset', 'none', 'cancel']) {
        expect(await host.run('goal', word)).toEqual({ tone: 'success', title: 'Goal cleared: Ship the release notes' });
      }
      expect(services.clearChatGoal).toHaveBeenCalledTimes(6);
      expect(services.setChatGoal).not.toHaveBeenCalled();
      expect(actions.goalChanged).toHaveBeenCalledTimes(8);

      const empty = setup(flowChat, { clearChatGoal: jest.fn(async () => null) });
      expect((await empty.host.run('goal', 'clear'))?.lines).toEqual(['This chat has no goal. Type /goal and what the agent should achieve.']);
    });

    it('explains a goal that is too long, a chat that is not saved yet and a chat without a goal', async () => {
      const { host, services } = setup(flowChat);
      expect(await host.run('goal', 'x'.repeat(4_001))).toEqual({
        tone: 'warning', title: '/goal', lines: ['A goal can be at most 4,000 characters long.'],
      });
      expect(services.setChatGoal).not.toHaveBeenCalled();

      const missing = Object.assign(new Error('Conversation not found.'), { status: 404, body: { reason: 'not_found' } });
      const unsaved = setup(flowChat, { setChatGoal: jest.fn(async () => { throw missing; }) });
      expect((await unsaved.host.run('goal', 'Anything'))?.lines)
        .toEqual(['This chat is not saved yet. Send a first message, then set the goal.']);

      const noGoal = Object.assign(new Error('This chat has no goal.'), { status: 404, body: { reason: 'no_goal' } });
      const resume = setup(flowChat, { updateChatGoal: jest.fn(async () => { throw noGoal; }) });
      expect((await resume.host.run('goal', 'resume'))?.title).toBe('Goal of this chat');
    });

    it('never turns a control word into a Persona goal', async () => {
      const { host, services } = setup(personaChat);
      expect((await host.run('goal', 'clear'))?.lines).toEqual(["Pause, change or stop goals on the Persona's page."]);
      expect(services.createGoal).not.toHaveBeenCalled();
      expect(services.clearChatGoal).not.toHaveBeenCalled();
    });
  });
});
